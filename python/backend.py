from __future__ import annotations

import base64
import ctypes
import hashlib
import io
import json
import math
import os
import subprocess
import sys
import threading
import time
import traceback
from ctypes import wintypes
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Callable, Iterable

from PIL import Image, ImageDraw, ImageFont

ROOT_DIR = Path(os.environ.get("CODEXHOOK_ROOT", Path(__file__).resolve().parents[1]))
LOG_DIR = Path(os.environ.get("CODEXHOOK_LOG_DIR", ROOT_DIR / "logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / f"{datetime.now():%Y-%m-%d}.backend.log"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

THREAD_TURN_LIST_LIMIT = 1
WATCH_REFRESH_SECONDS = 2.0
WORKER_TICK_SECONDS = 0.2
RENDER_TICK_SECONDS = 0.1
REQUEST_TIMEOUT_SECONDS = 10.0
APP_SERVER_RETRY_SECONDS = 5.0
TOKEN_ACTIVITY_GRACE_SECONDS = 20.0
UNFINISHED_TURN_RUNNING_SECONDS = 6 * 60 * 60
MISSING_THREAD_RETRY_SECONDS = 30.0
TURN_LIST_TIMEOUT_SECONDS = 5.0
TURN_LIST_FAILURE_RESTART_THRESHOLD = 3

EMIT_LOCK = threading.Lock()
BUTTON_IMAGE_CACHE_LOCK = threading.Lock()
BUTTON_IMAGE_CACHE: dict[str, str] = {}
STATUS_SYNC = "同步"
STATUS_IDLE = "空闲"
STATUS_SLEEP = "休眠"
STATUS_ERROR = "错误"
STATUS_WAIT_APPROVAL = "待批"
STATUS_WAIT_INPUT = "输入"
STATUS_RUNNING = "进行中"
STATUS_BUSY = "忙碌"
STATUS_OFFLINE = "离线"
STATUS_MISSING = "丢失"
STATUS_NO_THREAD = "未选择会话"
BUTTON_NO_THREAD = "未选\n会话"
APP_SERVER_UNAVAILABLE = "Codex app-server 不可用"
ACTIVE_STATE_CODES = {"busy", "waiting_approval", "waiting_input"}
TERMINAL_TURN_STATUSES = {
    "aborted",
    "canceled",
    "cancelled",
    "completed",
    "failed",
}
BUTTON_IMAGE_SIZE = 144
BUTTON_IMAGE_CACHE_LIMIT = 256
BUTTON_TITLE_AREA_HEIGHT = 48
BUTTON_PADDING_X = 10
BUTTON_BG = (0, 0, 0)
BUTTON_TITLE_FG = (215, 215, 215)
BUTTON_STATUS_FG = (255, 255, 255)
BUTTON_DIVIDER = (34, 34, 34)
BUTTON_DEFAULT_TITLE = "CodexHook"
RUNNING_ANIMATION_FRAMES = 8
RUNNING_ANIMATION_FRAME_SECONDS = 0.18
RUNNING_TITLE_AREA_HEIGHT = BUTTON_TITLE_AREA_HEIGHT
ANIMATED_STATUS_LABELS = {STATUS_RUNNING, STATUS_BUSY}
IDLE_ANIMATION_FRAMES = 8
IDLE_ANIMATION_FRAME_SECONDS = 0.3
SYNC_ANIMATION_FRAMES = 8
SYNC_ANIMATION_FRAME_SECONDS = 0.18
APPROVAL_ANIMATION_FRAMES = 8
APPROVAL_ANIMATION_FRAME_SECONDS = 0.28
INPUT_ANIMATION_FRAMES = 8
INPUT_ANIMATION_FRAME_SECONDS = 0.32
CODEX_FOCUS_COOLDOWN_SECONDS = 1.0
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SW_RESTORE = 9
SW_SHOWMAXIMIZED = 3


def emit(message: dict[str, Any]) -> None:
    with EMIT_LOCK:
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def log(message: str, **fields: object) -> None:
    suffix = f" {json.dumps(fields, ensure_ascii=False)}" if fields else ""
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {message}{suffix}"

    with LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")

    emit({"type": "log", "message": line})


def normalize_text(value: object) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def preserve_title_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    return value if value != "" else None


def first_line(text: object) -> str | None:
    value = normalize_text(text)
    if not value:
        return None
    return value.splitlines()[0].strip() or None


def shorten(value: object, limit: int) -> str | None:
    text = normalize_text(value)
    if not text:
        return None
    if len(text) <= limit:
        return text
    return text[: max(limit - 1, 1)] + "…"


def safe_thread_id_suffix(thread_id: str | None) -> str:
    if not thread_id:
        return "----"
    return thread_id[-4:]


def secret_digest(value: str | None) -> str:
    if not value:
        return ""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def parse_port(value: str | None, default: int = 22) -> int:
    try:
        port = int(str(value or "").strip())
    except ValueError:
        return default
    if port < 1 or port > 65535:
        return default
    return port


@dataclass(frozen=True)
class ConnectionConfig:
    mode: str = "local"
    ssh_host: str | None = None
    ssh_port: int = 22
    ssh_username: str | None = None
    ssh_auth_type: str = "password"
    ssh_password: str | None = None
    ssh_key_path: str | None = None
    ssh_key_passphrase: str | None = None
    remote_codex_command: str | None = None

    @property
    def client_key(self) -> str:
        if self.mode != "ssh":
            return "local"

        payload = {
            "mode": self.mode,
            "host": self.ssh_host or "",
            "port": self.ssh_port,
            "username": self.ssh_username or "",
            "authType": self.ssh_auth_type,
            "passwordHash": secret_digest(self.ssh_password),
            "keyPath": self.ssh_key_path or "",
            "keyPassphraseHash": secret_digest(self.ssh_key_passphrase),
            "remoteCodexCommand": self.remote_codex_command or "",
        }
        return "ssh:" + hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:24]

    @property
    def source_label(self) -> str:
        if self.mode == "ssh":
            return f"ssh {self.ssh_username or '?'}@{self.ssh_host or '?'}:{self.ssh_port}"
        return "local"

    @property
    def display_name(self) -> str:
        if self.mode == "ssh":
            return f"SSH {self.ssh_username or '?'}@{self.ssh_host or '?'}:{self.ssh_port}"
        return "本机 Codex"


def watch_key_for(connection: ConnectionConfig, thread_id: str | None) -> str | None:
    if not thread_id:
        return None
    return f"{connection.client_key}|thread:{thread_id}"


def process_image_path(pid: int) -> str | None:
    if sys.platform != "win32":
        return None

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None

    try:
        size = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return None
        return buffer.value
    finally:
        kernel32.CloseHandle(handle)


def focus_window(hwnd: int) -> bool:
    if sys.platform != "win32":
        return False

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.IsZoomed.argtypes = [wintypes.HWND]
    user32.IsZoomed.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.AttachThreadInput.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.BringWindowToTop.restype = wintypes.BOOL
    user32.SetFocus.argtypes = [wintypes.HWND]
    user32.SetFocus.restype = wintypes.HWND
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD

    current_thread = kernel32.GetCurrentThreadId()
    target_pid = wintypes.DWORD()
    target_thread = user32.GetWindowThreadProcessId(hwnd, ctypes.byref(target_pid))

    foreground = user32.GetForegroundWindow()
    foreground_pid = wintypes.DWORD()
    foreground_thread = (
        user32.GetWindowThreadProcessId(foreground, ctypes.byref(foreground_pid))
        if foreground
        else 0
    )

    attached: list[int] = []
    for thread_id in {int(target_thread), int(foreground_thread)}:
        if thread_id and thread_id != int(current_thread):
            if user32.AttachThreadInput(current_thread, thread_id, True):
                attached.append(thread_id)

    try:
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, SW_RESTORE)
        elif user32.IsZoomed(hwnd):
            user32.ShowWindow(hwnd, SW_SHOWMAXIMIZED)
        user32.BringWindowToTop(hwnd)
        foreground_ok = bool(user32.SetForegroundWindow(hwnd))
        user32.SetFocus(hwnd)
        return foreground_ok
    finally:
        for thread_id in attached:
            user32.AttachThreadInput(current_thread, thread_id, False)


def focus_codex_window() -> bool:
    if sys.platform != "win32":
        return False

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.EnumWindows.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD

    matches: list[tuple[int, int]] = []

    def window_title(hwnd: int) -> str:
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return ""
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        return buffer.value.strip()

    def is_codex_window(hwnd: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return False

        title = window_title(hwnd)
        pid_ref = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_ref))
        image_path = process_image_path(int(pid_ref.value)) or ""
        image_name = os.path.basename(image_path).lower()
        image_path_lower = image_path.lower()

        if title == "Codex" and image_name == "codex.exe":
            return True

        return image_name == "codex.exe" and "\\openai.codex_" in image_path_lower

    enum_proc_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @enum_proc_type
    def enum_proc(hwnd: int, _lparam: int) -> bool:
        if is_codex_window(hwnd):
            title = window_title(hwnd)
            priority = 0 if title == "Codex" else 1
            matches.append((priority, hwnd))
        return True

    user32.EnumWindows(enum_proc, 0)
    if not matches:
        return False

    matches.sort(key=lambda item: item[0])
    return focus_window(matches[0][1])


def load_button_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if bold:
        candidates = (
            r"C:\Windows\Fonts\msyhbd.ttc",
            r"C:\Windows\Fonts\simhei.ttf",
            r"C:\Windows\Fonts\segoeuib.ttf",
            r"C:\Windows\Fonts\arialbd.ttf",
        )
    else:
        candidates = (
            r"C:\Windows\Fonts\msyh.ttc",
            r"C:\Windows\Fonts\simhei.ttf",
            r"C:\Windows\Fonts\segoeui.ttf",
            r"C:\Windows\Fonts\arial.ttf",
        )

    for candidate in candidates:
        if not Path(candidate).exists():
            continue
        try:
            return ImageFont.truetype(candidate, size=size)
        except Exception:
            continue

    return ImageFont.load_default()


def text_size(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=font)
    width = int(math.ceil(draw.textlength(text, font=font)))
    return (width, box[3] - box[1])


def truncate_to_width(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    max_width: int,
) -> str:
    if text_size(draw, text, font)[0] <= max_width:
        return text

    ellipsis = "…"
    candidate = text
    while candidate:
        candidate = candidate[:-1]
        if text_size(draw, candidate + ellipsis, font)[0] <= max_width:
            return candidate + ellipsis
    return ellipsis


def wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    max_width: int,
    max_lines: int,
) -> list[str]:
    lines: list[str] = []
    for paragraph in str(text or "").splitlines() or [""]:
        current = ""
        for char in paragraph:
            candidate = current + char
            if current and text_size(draw, candidate, font)[0] > max_width:
                lines.append(current)
                current = char
                if len(lines) == max_lines:
                    lines[-1] = truncate_to_width(draw, lines[-1], font, max_width)
                    return lines
            else:
                current = candidate

        if current or not lines:
            lines.append(current)
            if len(lines) == max_lines:
                lines[-1] = truncate_to_width(draw, lines[-1], font, max_width)
                return lines

    return lines[:max_lines]


def draw_text_block(
    draw: ImageDraw.ImageDraw,
    text: str,
    box: tuple[int, int, int, int],
    font_size: int,
    min_font_size: int,
    max_lines: int,
    fill: tuple[int, int, int],
    bold: bool = False,
) -> None:
    left, top, right, bottom = box
    width = right - left
    height = bottom - top
    selected_font = load_button_font(min_font_size, bold=bold)
    selected_lines = wrap_text(draw, text, selected_font, width, max_lines)

    for size in range(font_size, min_font_size - 1, -1):
        font = load_button_font(size, bold=bold)
        lines = wrap_text(draw, text, font, width, max_lines)
        line_height = max(text_size(draw, "国", font)[1], size) + 3
        total_height = line_height * len(lines)
        if total_height <= height:
            selected_font = font
            selected_lines = lines
            break

    line_height = max(text_size(draw, "国", selected_font)[1], min_font_size) + 3
    total_height = line_height * len(selected_lines)
    y = top + max((height - total_height) // 2, 0)

    for line in selected_lines:
        line = truncate_to_width(draw, line, selected_font, width)
        line_width, _line_height = text_size(draw, line, selected_font)
        x = left + max((width - line_width) // 2, 0)
        draw.text((x, y), line, font=selected_font, fill=fill)
        y += line_height


def create_animation_canvas(title: str) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", (BUTTON_IMAGE_SIZE, BUTTON_IMAGE_SIZE), BUTTON_BG)
    draw = ImageDraw.Draw(image)
    draw.line(
        (
            BUTTON_PADDING_X,
            BUTTON_TITLE_AREA_HEIGHT,
            BUTTON_IMAGE_SIZE - BUTTON_PADDING_X,
            BUTTON_TITLE_AREA_HEIGHT,
        ),
        fill=BUTTON_DIVIDER,
        width=1,
    )
    draw_text_block(
        draw,
        title or BUTTON_DEFAULT_TITLE,
        (
            BUTTON_PADDING_X,
            4,
            BUTTON_IMAGE_SIZE - BUTTON_PADDING_X,
            BUTTON_TITLE_AREA_HEIGHT - 4,
        ),
        font_size=18,
        min_font_size=10,
        max_lines=2,
        fill=BUTTON_TITLE_FG,
    )
    return image, draw


def image_to_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def draw_running_robot(draw: ImageDraw.ImageDraw, frame: int) -> None:
    bob = int(round(math.sin(frame / RUNNING_ANIMATION_FRAMES * math.tau) * 4))
    cx = BUTTON_IMAGE_SIZE // 2
    cy = 102 + bob
    body = (cx - 26, cy - 22, cx + 26, cy + 22)
    soft = BUTTON_TITLE_FG
    accent = (255, 232, 124)
    blue = (120, 210, 255)

    shadow_width = 32 + int(abs(bob) * 2)
    draw.ellipse((cx - shadow_width, 109, cx + shadow_width, 117), fill=(24, 24, 24))
    draw.line((cx, cy - 23, cx, cy - 34), fill=soft, width=3)
    draw.ellipse((cx - 5, cy - 43, cx + 5, cy - 33), fill=accent if frame % 2 == 0 else soft)
    draw.rounded_rectangle((cx - 36, cy - 10, cx - 27, cy + 10), radius=4, fill=soft)
    draw.rounded_rectangle((cx + 27, cy - 10, cx + 36, cy + 10), radius=4, fill=soft)
    draw.rounded_rectangle(body, radius=13, fill=BUTTON_STATUS_FG)
    draw.rounded_rectangle((cx - 21, cy - 15, cx + 21, cy + 15), radius=10, fill=(12, 12, 12))

    eye_y = cy - 3
    eye_shift = (-2, 0, 2, 1, 0, -1, -2, 0)[frame % RUNNING_ANIMATION_FRAMES]
    draw.ellipse((cx - 14 + eye_shift, eye_y - 5, cx - 5 + eye_shift, eye_y + 4), fill=blue)
    draw.ellipse((cx + 5 + eye_shift, eye_y - 5, cx + 14 + eye_shift, eye_y + 4), fill=blue)
    draw.arc((cx - 10, cy + 3, cx + 10, cy + 16), 20, 160, fill=accent, width=3)


def render_running_button_image(title: str, frame: int) -> str:
    image, draw = create_animation_canvas(title)
    draw_running_robot(draw, frame % RUNNING_ANIMATION_FRAMES)
    return image_to_data_url(image)


def draw_idle_sleep_mark(draw: ImageDraw.ImageDraw, frame: int) -> None:
    big_font = load_button_font(15, bold=True)
    small_font = load_button_font(11, bold=True)
    brightness = (100, 140, 190, 230, 210, 170, 125, 95)[frame % IDLE_ANIMATION_FRAMES]
    big_fill = (brightness, brightness, brightness)
    small_value = max(brightness - 70, 70)
    small_fill = (small_value, small_value, small_value)
    x = 98 + int(math.sin(frame / IDLE_ANIMATION_FRAMES * math.tau) * 2)
    y = 58 - int((frame % IDLE_ANIMATION_FRAMES) * 0.8)
    draw.text((x, y), "Z", font=big_font, fill=big_fill)
    draw.text((x + 15, y - 11), "z", font=small_font, fill=small_fill)


def draw_idle_robot(draw: ImageDraw.ImageDraw, frame: int) -> None:
    bob = int(round(math.sin(frame / IDLE_ANIMATION_FRAMES * math.tau) * 2))
    cx = BUTTON_IMAGE_SIZE // 2
    cy = 102 + bob
    body = (cx - 26, cy - 22, cx + 26, cy + 22)
    soft = BUTTON_TITLE_FG
    accent = (255, 232, 124)
    blue_dim = (92, 170, 210)

    shadow_width = 34 + int(abs(bob))
    draw.ellipse((cx - shadow_width, 124, cx + shadow_width, 131), fill=(22, 22, 22))
    draw.line((cx, cy - 23, cx, cy - 34), fill=soft, width=3)
    bulb_fill = accent if frame % IDLE_ANIMATION_FRAMES in (0, 1, 6, 7) else soft
    draw.ellipse((cx - 5, cy - 43, cx + 5, cy - 33), fill=bulb_fill)
    draw.rounded_rectangle((cx - 36, cy - 10, cx - 27, cy + 10), radius=4, fill=soft)
    draw.rounded_rectangle((cx + 27, cy - 10, cx + 36, cy + 10), radius=4, fill=soft)
    draw.rounded_rectangle(body, radius=13, fill=(245, 245, 245))
    draw.rounded_rectangle((cx - 21, cy - 15, cx + 21, cy + 15), radius=10, fill=(12, 12, 12))

    eye_y = cy - 3
    draw.arc((cx - 15, eye_y - 4, cx - 5, eye_y + 6), 20, 160, fill=blue_dim, width=3)
    draw.arc((cx + 5, eye_y - 4, cx + 15, eye_y + 6), 20, 160, fill=blue_dim, width=3)
    draw.arc((cx - 9, cy + 4, cx + 9, cy + 15), 25, 155, fill=accent, width=2)


def render_idle_button_image(title: str, frame: int) -> str:
    image, draw = create_animation_canvas(title)
    frame = frame % IDLE_ANIMATION_FRAMES
    draw_idle_sleep_mark(draw, frame)
    draw_idle_robot(draw, frame)
    return image_to_data_url(image)

def draw_sync_animation(draw: ImageDraw.ImageDraw, frame: int) -> None:
    frame = frame % SYNC_ANIMATION_FRAMES
    cx = BUTTON_IMAGE_SIZE // 2
    cy = 98
    accent = (120, 210, 255)
    dim = (54, 90, 110)
    soft = BUTTON_STATUS_FG
    radius = 34

    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=dim, width=3)
    draw.ellipse((cx - 22, cy - 22, cx + 22, cy + 22), outline=(38, 62, 74), width=2)

    angle = frame / SYNC_ANIMATION_FRAMES * math.tau
    end_x = cx + int(math.cos(angle) * radius)
    end_y = cy + int(math.sin(angle) * radius)
    draw.line((cx, cy, end_x, end_y), fill=accent, width=4)
    draw.ellipse((end_x - 4, end_y - 4, end_x + 4, end_y + 4), fill=accent)

    pulse_radius = 5 + (frame % 4) * 2
    draw.ellipse(
        (cx - pulse_radius, cy - pulse_radius, cx + pulse_radius, cy + pulse_radius),
        outline=soft,
        width=2,
    )
    draw.ellipse((cx - 3, cy - 3, cx + 3, cy + 3), fill=soft)


def render_sync_button_image(title: str, frame: int) -> str:
    image, draw = create_animation_canvas(title)
    draw_sync_animation(draw, frame)
    return image_to_data_url(image)


def draw_approval_animation(draw: ImageDraw.ImageDraw, frame: int) -> None:
    frame = frame % APPROVAL_ANIMATION_FRAMES
    cx = BUTTON_IMAGE_SIZE // 2
    cy = 102
    soft = BUTTON_TITLE_FG
    white = BUTTON_STATUS_FG
    accent = (255, 232, 124)
    alert = (255, 190, 82) if frame % 2 == 0 else (255, 245, 170)
    bob = -2 if frame in (1, 2, 5, 6) else 0

    body = (cx - 24, cy - 18 + bob, cx + 24, cy + 22 + bob)
    draw.ellipse((cx - 34, 126, cx + 34, 132), fill=(22, 22, 22))
    draw.line((cx, cy - 19 + bob, cx, cy - 29 + bob), fill=soft, width=3)
    draw.ellipse((cx - 5, cy - 38 + bob, cx + 5, cy - 28 + bob), fill=alert)
    draw.rounded_rectangle(body, radius=12, fill=white)
    draw.rounded_rectangle((cx - 19, cy - 12 + bob, cx + 19, cy + 12 + bob), radius=9, fill=(12, 12, 12))
    draw.ellipse((cx - 12, cy - 4 + bob, cx - 5, cy + 3 + bob), fill=(120, 210, 255))
    draw.ellipse((cx + 5, cy - 4 + bob, cx + 12, cy + 3 + bob), fill=(120, 210, 255))
    draw.arc((cx - 8, cy + 4 + bob, cx + 8, cy + 14 + bob), 25, 155, fill=accent, width=2)

    hand_y = cy - 34 + bob - (4 if frame in (1, 2, 3) else 0)
    draw.line((cx + 24, cy - 6 + bob, cx + 39, hand_y), fill=white, width=5)
    draw.ellipse((cx + 34, hand_y - 7, cx + 46, hand_y + 5), fill=white)
    draw.line((cx - 24, cy - 3 + bob, cx - 36, cy + 8 + bob), fill=white, width=5)

    badge_x, badge_y = 43, 66
    draw.ellipse((badge_x - 10, badge_y - 10, badge_x + 10, badge_y + 10), fill=alert)
    ex_font = load_button_font(18, bold=True)
    draw.text((badge_x - 3, badge_y - 13), "!", font=ex_font, fill=(0, 0, 0))


def render_approval_button_image(title: str, frame: int) -> str:
    image, draw = create_animation_canvas(title)
    draw_approval_animation(draw, frame)
    return image_to_data_url(image)


def draw_input_animation(draw: ImageDraw.ImageDraw, frame: int) -> None:
    frame = frame % INPUT_ANIMATION_FRAMES
    cx = BUTTON_IMAGE_SIZE // 2
    cy = 102
    soft = BUTTON_TITLE_FG
    white = BUTTON_STATUS_FG
    accent = (120, 210, 255)
    cursor = BUTTON_STATUS_FG if frame % 2 == 0 else (65, 65, 65)

    body = (cx - 25, cy - 20, cx + 25, cy + 22)
    draw.ellipse((cx - 34, 126, cx + 34, 132), fill=(22, 22, 22))
    draw.line((cx, cy - 21, cx, cy - 32), fill=soft, width=3)
    draw.ellipse((cx - 5, cy - 41, cx + 5, cy - 31), fill=soft)
    draw.rounded_rectangle(body, radius=13, fill=white)
    draw.rounded_rectangle((cx - 20, cy - 14, cx + 20, cy + 14), radius=9, fill=(12, 12, 12))

    eye_shift = -1 if frame in (2, 3) else 1 if frame in (6, 7) else 0
    draw.ellipse((cx - 13 + eye_shift, cy - 5, cx - 5 + eye_shift, cy + 3), fill=accent)
    draw.ellipse((cx + 5 + eye_shift, cy - 5, cx + 13 + eye_shift, cy + 3), fill=accent)
    draw.arc((cx - 8, cy + 4, cx + 8, cy + 14), 25, 155, fill=(255, 232, 124), width=2)

    bubble = (23, 61, 61, 89)
    draw.rounded_rectangle(bubble, radius=8, fill=(28, 28, 28), outline=soft, width=2)
    for dot_index, x in enumerate((33, 42, 51)):
        active = (frame + dot_index * 2) % INPUT_ANIMATION_FRAMES in (0, 1, 2)
        fill = white if active else (88, 88, 88)
        draw.ellipse((x - 2, 74, x + 2, 78), fill=fill)

    draw.rounded_rectangle((88, 64, 121, 88), radius=4, fill=(20, 20, 20), outline=soft, width=2)
    draw.line((114, 68, 114, 84), fill=cursor, width=3)


def render_input_button_image(title: str, frame: int) -> str:
    image, draw = create_animation_canvas(title)
    draw_input_animation(draw, frame)
    return image_to_data_url(image)


def render_button_image_uncached(title: str, status: str, frame: int | None = None) -> str:
    if frame is not None and status in ANIMATED_STATUS_LABELS:
        return render_running_button_image(title, frame)
    if frame is not None and status == STATUS_IDLE:
        return render_idle_button_image(title, frame)
    if frame is not None and status == STATUS_SYNC:
        return render_sync_button_image(title, frame)
    if frame is not None and status == STATUS_WAIT_APPROVAL:
        return render_approval_button_image(title, frame)
    if frame is not None and status == STATUS_WAIT_INPUT:
        return render_input_button_image(title, frame)

    image = Image.new("RGB", (BUTTON_IMAGE_SIZE, BUTTON_IMAGE_SIZE), BUTTON_BG)
    draw = ImageDraw.Draw(image)
    draw.line(
        (
            BUTTON_PADDING_X,
            BUTTON_TITLE_AREA_HEIGHT,
            BUTTON_IMAGE_SIZE - BUTTON_PADDING_X,
            BUTTON_TITLE_AREA_HEIGHT,
        ),
        fill=BUTTON_DIVIDER,
        width=1,
    )

    draw_text_block(
        draw,
        title or BUTTON_DEFAULT_TITLE,
        (
            BUTTON_PADDING_X,
            4,
            BUTTON_IMAGE_SIZE - BUTTON_PADDING_X,
            BUTTON_TITLE_AREA_HEIGHT - 4,
        ),
        font_size=18,
        min_font_size=10,
        max_lines=2,
        fill=BUTTON_TITLE_FG,
    )
    draw_text_block(
        draw,
        status,
        (
            BUTTON_PADDING_X,
            BUTTON_TITLE_AREA_HEIGHT + 4,
            BUTTON_IMAGE_SIZE - BUTTON_PADDING_X,
            BUTTON_IMAGE_SIZE - 6,
        ),
        font_size=40,
        min_font_size=20,
        max_lines=2,
        fill=BUTTON_STATUS_FG,
        bold=True,
    )

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def render_button_image(title: str, status: str, frame: int | None = None) -> str:
    cache_key = json.dumps(
        {"title": title or "", "status": status, "frame": frame},
        ensure_ascii=False,
        sort_keys=True,
    )
    with BUTTON_IMAGE_CACHE_LOCK:
        cached = BUTTON_IMAGE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    image = render_button_image_uncached(title, status, frame)
    with BUTTON_IMAGE_CACHE_LOCK:
        if len(BUTTON_IMAGE_CACHE) >= BUTTON_IMAGE_CACHE_LIMIT:
            BUTTON_IMAGE_CACHE.clear()
        BUTTON_IMAGE_CACHE[cache_key] = image
    return image


def compact_thread(thread: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(thread, dict):
        return None

    return {
        "id": thread.get("id"),
        "name": thread.get("name"),
        "preview": thread.get("preview"),
        "cwd": thread.get("cwd"),
        "status": thread.get("status"),
        "updatedAt": thread.get("updatedAt"),
        "createdAt": thread.get("createdAt"),
        "path": thread.get("path"),
    }


def status_descriptor(status: dict[str, Any] | None) -> tuple[str, str]:
    if not isinstance(status, dict):
        return ("syncing", STATUS_SYNC)

    status_type = status.get("type")

    if status_type == "idle":
        return ("idle", STATUS_IDLE)

    if status_type == "notLoaded":
        return ("not_loaded", STATUS_SLEEP)

    if status_type == "systemError":
        return ("error", STATUS_ERROR)

    if status_type == "active":
        flags = set(status.get("activeFlags") or [])
        if "waitingOnApproval" in flags:
            return ("waiting_approval", STATUS_WAIT_APPROVAL)
        if "waitingOnUserInput" in flags:
            return ("waiting_input", STATUS_WAIT_INPUT)
        return ("busy", STATUS_BUSY)

    return ("syncing", STATUS_SYNC)


def thread_name_from_sources(
    thread_id: str | None,
    thread: dict[str, Any] | None,
    fallback_name: str | None,
    fallback_preview: str | None,
) -> str:
    title = thread_title_from_sources(thread, fallback_name, fallback_preview)
    if title:
        return title
    return f"#{safe_thread_id_suffix(thread_id)}"


def thread_title_from_sources(
    thread: dict[str, Any] | None,
    fallback_name: str | None,
    fallback_preview: str | None,
) -> str | None:
    for candidate in (
        normalize_text((thread or {}).get("name")),
        first_line((thread or {}).get("preview")),
        normalize_text(fallback_name),
        first_line(fallback_preview),
    ):
        if candidate:
            return candidate
    return None


def status_line_for_watch(watch: "ThreadWatch") -> tuple[str, str]:
    if watch.error_kind == "offline":
        return ("offline", STATUS_OFFLINE)
    if watch.error_kind == "missing":
        return ("missing", STATUS_MISSING)
    if watch.error_kind == "error":
        return ("error", STATUS_ERROR)
    if watch.state_code in ACTIVE_STATE_CODES:
        return (watch.state_code, watch.state_label)
    if watch.should_infer_running():
        return ("running", STATUS_RUNNING)
    if watch.state_code:
        return (watch.state_code, watch.state_label)
    return ("syncing", STATUS_SYNC)


def build_button_parts(action: "ActionState", watch: "ThreadWatch | None") -> tuple[str, str]:
    title = preserve_title_text(action.button_title)

    if not action.target_thread_id:
        return (title or BUTTON_DEFAULT_TITLE, "未选择")

    if watch is None:
        thread_name = thread_name_from_sources(
            action.target_thread_id,
            None,
            action.target_thread_name,
            action.target_thread_preview,
        )
        return (title or thread_name, STATUS_SYNC)

    _state_code, status_label = status_line_for_watch(watch)
    thread_name = thread_name_from_sources(
        action.target_thread_id,
        watch.thread,
        action.target_thread_name,
        action.target_thread_preview,
    )
    return (title or thread_name, status_label)


@dataclass
class ActionState:
    context: str
    action: str | None = None
    visible: bool = False
    property_inspector_visible: bool = False
    settings: dict[str, Any] = field(default_factory=dict)
    target_project_key: str | None = None
    target_project_name: str | None = None
    target_project_path: str | None = None
    target_thread_id: str | None = None
    target_thread_name: str | None = None
    target_thread_preview: str | None = None
    target_thread_cwd: str | None = None
    button_title: str | None = None
    connection_mode: str = "local"
    ssh_host: str | None = None
    ssh_port: str = "22"
    ssh_username: str | None = None
    ssh_auth_type: str = "password"
    ssh_password: str | None = None
    ssh_key_path: str | None = None
    ssh_key_passphrase: str | None = None
    remote_codex_command: str | None = None
    last_button_signature: str = ""
    last_property_inspector_payload: str = ""

    def apply_settings(self, settings: dict[str, Any] | None) -> None:
        normalized = dict(settings or {})
        self.settings = normalized
        self.target_project_key = normalize_text(normalized.get("targetProjectKey"))
        self.target_project_name = normalize_text(normalized.get("targetProjectName"))
        self.target_project_path = normalize_text(normalized.get("targetProjectPath"))
        self.target_thread_id = normalize_text(normalized.get("targetThreadId"))
        self.target_thread_name = normalize_text(normalized.get("targetThreadName"))
        self.target_thread_preview = normalize_text(normalized.get("targetThreadPreview"))
        self.target_thread_cwd = normalize_text(normalized.get("targetThreadCwd"))
        self.button_title = preserve_title_text(normalized.get("buttonTitle"))
        self.connection_mode = "ssh" if normalize_text(normalized.get("connectionMode")) == "ssh" else "local"
        self.ssh_host = normalize_text(normalized.get("sshHost"))
        self.ssh_port = normalize_text(normalized.get("sshPort")) or "22"
        self.ssh_username = normalize_text(normalized.get("sshUsername"))
        self.ssh_auth_type = "key" if normalize_text(normalized.get("sshAuthType")) == "key" else "password"
        self.ssh_password = preserve_title_text(normalized.get("sshPassword"))
        self.ssh_key_path = normalize_text(normalized.get("sshKeyPath"))
        self.ssh_key_passphrase = preserve_title_text(normalized.get("sshKeyPassphrase"))
        self.remote_codex_command = normalize_text(normalized.get("remoteCodexCommand"))

    def connection_config(self) -> ConnectionConfig:
        if self.connection_mode != "ssh":
            return ConnectionConfig(mode="local")

        return ConnectionConfig(
            mode="ssh",
            ssh_host=self.ssh_host,
            ssh_port=parse_port(self.ssh_port),
            ssh_username=self.ssh_username,
            ssh_auth_type=self.ssh_auth_type,
            ssh_password=self.ssh_password,
            ssh_key_path=self.ssh_key_path,
            ssh_key_passphrase=self.ssh_key_passphrase,
            remote_codex_command=self.remote_codex_command,
        )

    def watch_key(self) -> str | None:
        return watch_key_for(self.connection_config(), self.target_thread_id)


@dataclass
class ThreadWatch:
    watch_key: str
    thread_id: str
    connection: ConnectionConfig
    contexts: set[str] = field(default_factory=set)
    thread: dict[str, Any] | None = None
    state_code: str = "syncing"
    state_label: str = STATUS_SYNC
    subscribed: bool = False
    app_server_generation: int = 0
    error_kind: str | None = None
    error_message: str | None = None
    last_refresh_at: float = 0.0
    latest_turn_id: str | None = None
    latest_turn_status: str | None = None
    latest_turn_started_at: int | None = None
    latest_turn_completed_at: int | None = None
    last_token_activity_at: float = 0.0
    turn_summary_failures: int = 0
    last_turn_summary_failed_at: float = 0.0
    last_debug_signature: str = ""

    def apply_status(self, status: dict[str, Any] | None) -> None:
        self.error_kind = None
        self.error_message = None
        self.state_code, self.state_label = status_descriptor(status)
        if self.thread is None:
            self.thread = {}
        self.thread["status"] = status

    def set_thread(self, thread: dict[str, Any] | None) -> None:
        compact = compact_thread(thread)
        if compact is not None:
            self.thread = compact
            self.apply_status(compact.get("status"))

    def apply_turn_summary(self, turn: dict[str, Any] | None) -> None:
        if not isinstance(turn, dict):
            return

        self.turn_summary_failures = 0
        self.last_turn_summary_failed_at = 0.0
        self.latest_turn_id = normalize_text(turn.get("id"))
        self.latest_turn_status = normalize_text(turn.get("status"))

        started_at = turn.get("startedAt")
        if isinstance(started_at, (int, float)):
            self.latest_turn_started_at = int(started_at)
        else:
            self.latest_turn_started_at = None

        completed_at = turn.get("completedAt")
        if isinstance(completed_at, (int, float)):
            self.latest_turn_completed_at = int(completed_at)
        else:
            self.latest_turn_completed_at = None

    def clear_turn_summary(self) -> None:
        self.latest_turn_id = None
        self.latest_turn_status = None
        self.latest_turn_started_at = None
        self.latest_turn_completed_at = None
        self.last_token_activity_at = 0.0

    def note_turn_summary_failed(self) -> None:
        self.turn_summary_failures += 1
        self.last_turn_summary_failed_at = time.monotonic()

    def note_turn_summary_success_without_data(self) -> None:
        self.turn_summary_failures = 0
        self.last_turn_summary_failed_at = 0.0
        self.clear_turn_summary()

    def note_turn_started(self, turn_id: object) -> None:
        normalized_turn_id = normalize_text(turn_id)
        if normalized_turn_id:
            self.latest_turn_id = normalized_turn_id
        self.latest_turn_status = "started"
        self.latest_turn_started_at = int(time.time())
        self.latest_turn_completed_at = None

    def note_turn_completed(self, turn_id: object) -> None:
        normalized_turn_id = normalize_text(turn_id)
        if normalized_turn_id and (self.latest_turn_id is None or self.latest_turn_id == normalized_turn_id):
            self.latest_turn_id = normalized_turn_id
        self.latest_turn_status = "completed"
        self.latest_turn_completed_at = int(time.time())

    def note_token_activity(self, turn_id: object) -> None:
        normalized_turn_id = normalize_text(turn_id)
        if normalized_turn_id:
            self.latest_turn_id = normalized_turn_id
        self.last_token_activity_at = time.monotonic()

    def should_infer_running(self) -> bool:
        if self.state_code not in {"idle", "syncing"}:
            return False

        if self.latest_turn_started_at is not None and self.latest_turn_completed_at is not None:
            return False

        now = time.monotonic()
        if self.last_token_activity_at and now - self.last_token_activity_at <= TOKEN_ACTIVITY_GRACE_SECONDS:
            return True

        if (self.latest_turn_status or "").lower() in TERMINAL_TURN_STATUSES:
            return False

        if self.latest_turn_started_at is not None and self.latest_turn_completed_at is None:
            return time.time() - self.latest_turn_started_at <= UNFINISHED_TURN_RUNNING_SECONDS

        return False

    def set_error(self, kind: str, message: str | None = None) -> None:
        self.error_kind = kind
        self.error_message = message
        if kind == "offline":
            self.state_code, self.state_label = ("offline", STATUS_OFFLINE)
        elif kind == "missing":
            self.state_code, self.state_label = ("missing", STATUS_MISSING)
        else:
            self.state_code, self.state_label = ("error", STATUS_ERROR)


@dataclass
class AppServerTransport:
    description: str
    stdout: Iterable[Any] | None
    stderr: Iterable[Any] | None
    write_line: Callable[[str], None]
    is_running: Callable[[], bool]
    stop: Callable[[], None]


class JsonRpcAppServerClient:
    def __init__(self, label: str) -> None:
        self.label = label
        self._transport: AppServerTransport | None = None
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._pending: dict[int, Queue[dict[str, Any]]] = {}
        self._notifications: Queue[dict[str, Any]] = Queue()
        self._next_request_id = 1
        self._generation = 0
        self._last_error: str | None = None
        self._retry_after = 0.0
        self._lifecycle_lock = threading.RLock()

    @property
    def generation(self) -> int:
        return self._generation

    @property
    def last_error(self) -> str | None:
        return self._last_error

    def notification_queue(self) -> Queue[dict[str, Any]]:
        return self._notifications

    def is_running(self) -> bool:
        return self._transport is not None and self._transport.is_running()

    def _open_transport(self) -> AppServerTransport:
        raise NotImplementedError

    def ensure_started(self) -> bool:
        if self.is_running():
            return True

        with self._lifecycle_lock:
            if self.is_running():
                return True

            now = time.monotonic()
            if now < self._retry_after:
                return False

            try:
                transport = self._open_transport()
            except Exception as exc:
                self._last_error = f"start failed: {exc}"
                self._retry_after = now + APP_SERVER_RETRY_SECONDS
                log("Codex app-server start failed", source=self.label, error=str(exc))
                return False

            self._transport = transport
            self._generation += 1
            generation = self._generation
            self._last_error = None
            self._stdout_thread = threading.Thread(
                target=self._read_stdout,
                args=(transport.stdout, generation),
                daemon=True,
            )
            self._stdout_thread.start()
            if transport.stderr is not None:
                self._stderr_thread = threading.Thread(
                    target=self._read_stderr,
                    args=(transport.stderr, generation),
                    daemon=True,
                )
                self._stderr_thread.start()

            try:
                self.call(
                    "initialize",
                    {
                        "clientInfo": {
                            "name": "codexhook-streamdock",
                            "version": "0.2.0",
                        },
                        "capabilities": {"experimentalApi": True},
                    },
                    timeout=REQUEST_TIMEOUT_SECONDS,
                )
                self.notify("initialized")
            except Exception as exc:
                self._last_error = f"initialize failed: {exc}"
                log("Codex app-server initialize failed", source=self.label, error=str(exc))
                self.stop()
                self._retry_after = time.monotonic() + APP_SERVER_RETRY_SECONDS
                return False

            log(
                "Codex app-server ready",
                source=self.label,
                generation=generation,
                transport=transport.description,
            )
            return True

    def stop(self) -> None:
        transport = self._transport
        self._transport = None
        if transport is not None:
            try:
                transport.stop()
            except Exception:
                pass
        with self._pending_lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for response_queue in pending:
            response_queue.put({"error": {"message": "app-server stopped"}})

    def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float = REQUEST_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        if not self.ensure_started():
            raise RuntimeError(self._last_error or APP_SERVER_UNAVAILABLE)

        request_id: int
        response_queue: Queue[dict[str, Any]] = Queue(maxsize=1)
        with self._pending_lock:
            request_id = self._next_request_id
            self._next_request_id += 1
            self._pending[request_id] = response_queue

        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
        }
        if params is not None:
            payload["params"] = params

        try:
            self._send(payload)
        except Exception:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise

        try:
            response = response_queue.get(timeout=timeout)
        except Empty as exc:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise RuntimeError(f"timeout waiting for {method}") from exc

        if "error" in response and response["error"]:
            message = response["error"].get("message") or f"{method} failed"
            raise RuntimeError(message)
        return response.get("result", {})

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        if not self.ensure_started():
            raise RuntimeError(self._last_error or APP_SERVER_UNAVAILABLE)
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._send(payload)

    def _send(self, payload: dict[str, Any]) -> None:
        transport = self._transport
        if transport is None or not transport.is_running():
            raise RuntimeError(APP_SERVER_UNAVAILABLE)
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with self._write_lock:
            transport.write_line(line)

    def _read_stdout(self, stdout: Iterable[Any] | None, generation: int) -> None:
        if stdout is None:
            return

        try:
            for raw_line in stdout:
                line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else str(raw_line)
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    log("Dropped invalid app-server stdout line", source=self.label, line=line)
                    continue

                if isinstance(message, dict) and "id" in message:
                    request_id = message.get("id")
                    with self._pending_lock:
                        response_queue = self._pending.pop(request_id, None)
                    if response_queue is not None:
                        response_queue.put(message)
                    continue

                if isinstance(message, dict) and message.get("method"):
                    self._notifications.put(message)
                    continue

                log("Dropped unknown app-server message", source=self.label, message=message)
        except Exception as exc:
            log("Codex app-server stdout reader failed", source=self.label, generation=generation, error=str(exc))

        self._notifications.put(
            {
                "method": "__app_server_exited__",
                "params": {"generation": generation},
            }
        )

    def _read_stderr(self, stderr: Iterable[Any] | None, generation: int) -> None:
        if stderr is None:
            return

        try:
            for raw_line in stderr:
                line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else str(raw_line)
                line = line.rstrip()
                if line:
                    log("Codex app-server stderr", source=self.label, generation=generation, line=line)
        except Exception as exc:
            log("Codex app-server stderr reader failed", source=self.label, generation=generation, error=str(exc))


class AppServerClient(JsonRpcAppServerClient):
    def __init__(self) -> None:
        super().__init__("local")
        self._process: subprocess.Popen[str] | None = None

    def _open_transport(self) -> AppServerTransport:
        command = ["cmd.exe", "/c", "codex.cmd", "app-server", "--stdio"]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            creationflags=creationflags,
        )
        self._process = process

        def write_line(line: str) -> None:
            if process.stdin is None:
                raise RuntimeError(APP_SERVER_UNAVAILABLE)
            process.stdin.write(line)
            process.stdin.flush()

        def stop() -> None:
            if process.poll() is None:
                process.terminate()

        return AppServerTransport(
            description=f"pid={process.pid}",
            stdout=process.stdout,
            stderr=process.stderr,
            write_line=write_line,
            is_running=lambda: process.poll() is None,
            stop=stop,
        )


def build_remote_app_server_command(remote_codex_command: str | None) -> str:
    codex_command = normalize_text(remote_codex_command) or "codex"
    return (
        'for dir in "$HOME"/.nvm/versions/node/*/bin; do '
        '[ -d "$dir" ] && PATH="$dir:$PATH"; '
        "done; "
        'PATH="$HOME/.local/bin:$PATH"; '
        "export PATH; "
        f"exec {codex_command} app-server --stdio"
    )


class SshAppServerClient(JsonRpcAppServerClient):
    def __init__(self, connection: ConnectionConfig) -> None:
        super().__init__(connection.source_label)
        self.connection = connection

    def _open_transport(self) -> AppServerTransport:
        if not self.connection.ssh_host:
            raise RuntimeError("SSH 配置不完整：需要主机")
        if not self.connection.ssh_username:
            raise RuntimeError("SSH 配置不完整：需要用户名")
        if self.connection.ssh_auth_type == "key" and not self.connection.ssh_key_path:
            raise RuntimeError("SSH 配置不完整：需要私钥路径")
        if self.connection.ssh_auth_type != "key" and self.connection.ssh_password is None:
            raise RuntimeError("SSH 配置不完整：需要密码")

        try:
            import paramiko
        except ImportError as exc:
            raise RuntimeError("py312 环境缺少 paramiko，无法使用 SSH 监听") from exc

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        connect_kwargs: dict[str, Any] = {
            "hostname": self.connection.ssh_host,
            "port": self.connection.ssh_port,
            "username": self.connection.ssh_username,
            "timeout": REQUEST_TIMEOUT_SECONDS,
            "banner_timeout": REQUEST_TIMEOUT_SECONDS,
            "auth_timeout": REQUEST_TIMEOUT_SECONDS,
            "look_for_keys": False,
            "allow_agent": False,
        }

        if self.connection.ssh_auth_type == "key":
            connect_kwargs["key_filename"] = self.connection.ssh_key_path
            if self.connection.ssh_key_passphrase:
                connect_kwargs["passphrase"] = self.connection.ssh_key_passphrase
        else:
            connect_kwargs["password"] = self.connection.ssh_password or ""

        try:
            client.connect(**connect_kwargs)
            ssh_transport = client.get_transport()
            if ssh_transport is None:
                raise RuntimeError("SSH transport 未建立")
            ssh_transport.set_keepalive(30)
            channel = ssh_transport.open_session()
            channel.set_combine_stderr(False)
            channel.exec_command(build_remote_app_server_command(self.connection.remote_codex_command))
            stdout = channel.makefile("rb", -1)
            stderr = channel.makefile_stderr("rb", -1)
        except Exception:
            client.close()
            raise

        def write_line(line: str) -> None:
            if channel.closed or channel.exit_status_ready():
                raise RuntimeError(APP_SERVER_UNAVAILABLE)
            channel.sendall(line.encode("utf-8"))

        def is_running() -> bool:
            return not channel.closed and not channel.exit_status_ready()

        def stop() -> None:
            try:
                channel.close()
            finally:
                client.close()

        return AppServerTransport(
            description=self.connection.source_label,
            stdout=stdout,
            stderr=stderr,
            write_line=write_line,
            is_running=is_running,
            stop=stop,
        )


class BackendRuntime:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._actions: dict[str, ActionState] = {}
        self._watches: dict[str, ThreadWatch] = {}
        self._clients: dict[str, JsonRpcAppServerClient] = {}
        self._pending_pi_updates: set[str] = set()
        self._last_codex_focus_at = 0.0
        self._worker = threading.Thread(target=self._worker_loop, daemon=True)
        self._render_worker = threading.Thread(target=self._render_loop, daemon=True)
        self._worker.start()
        self._render_worker.start()

    def shutdown(self) -> None:
        self._stop_event.set()
        with self._lock:
            clients = list(self._clients.values())
            self._clients.clear()
        for client in clients:
            client.stop()
        self._worker.join(timeout=1.0)
        self._render_worker.join(timeout=1.0)

    def _client_for_connection(self, connection: ConnectionConfig) -> JsonRpcAppServerClient:
        client_key = connection.client_key
        with self._lock:
            client = self._clients.get(client_key)
            if client is not None:
                return client

            client = SshAppServerClient(connection) if connection.mode == "ssh" else AppServerClient()
            self._clients[client_key] = client
            return client

    def _watch_for_state(self, state: ActionState) -> ThreadWatch | None:
        watch_key = state.watch_key()
        if not watch_key:
            return None
        return self._watches.get(watch_key)

    def handle_message(self, message: dict[str, Any]) -> None:
        message_type = message.get("type")

        if message_type == "init":
            log(
                "CodexHook backend ready",
                python=sys.executable,
                root=str(ROOT_DIR),
            )
            return

        if message_type == "event":
            payload = message.get("payload", {})
            if isinstance(payload, dict):
                self._handle_streamdock_event(payload)
            else:
                log("Dropped invalid Stream Dock payload", payload_type=type(payload).__name__)
            return

        log("Unknown backend envelope", envelope=message_type)

    def _handle_streamdock_event(self, payload: dict[str, Any]) -> None:
        event = payload.get("event")
        context = normalize_text(payload.get("context"))
        action = normalize_text(payload.get("action"))
        event_payload = payload.get("payload")

        if event == "willAppear" and context:
            with self._lock:
                state = self._actions.get(context) or ActionState(context=context)
                state.visible = True
                state.action = action or state.action
                state.apply_settings(self._extract_settings(payload))
                self._actions[context] = state
                self._pending_pi_updates.add(context)
            self._render_context(context)
            return

        if event == "willDisappear" and context:
            with self._lock:
                self._actions.pop(context, None)
                self._pending_pi_updates.discard(context)
            return

        if event == "deleteAction" and context:
            with self._lock:
                self._actions.pop(context, None)
                self._pending_pi_updates.discard(context)
            return

        if event == "didReceiveSettings" and context:
            with self._lock:
                state = self._actions.get(context) or ActionState(context=context)
                state.action = action or state.action
                state.apply_settings(self._extract_settings(payload))
                self._actions[context] = state
                self._pending_pi_updates.add(context)
            self._render_context(context)
            return

        if event == "propertyInspectorDidAppear" and context:
            with self._lock:
                state = self._actions.get(context) or ActionState(context=context)
                state.action = action or state.action
                state.property_inspector_visible = True
                state.last_property_inspector_payload = ""
                state.apply_settings(self._extract_settings(payload))
                self._actions[context] = state
                self._pending_pi_updates.add(context)
            return

        if event == "propertyInspectorDidDisappear" and context:
            with self._lock:
                state = self._actions.get(context)
                if state:
                    state.property_inspector_visible = False
                    state.last_property_inspector_payload = ""
                self._pending_pi_updates.discard(context)
            return

        if event == "sendToPlugin" and context and isinstance(event_payload, dict):
            target_context = normalize_text(event_payload.get("actionContext")) or context
            self._handle_property_inspector_message(target_context, event_payload, action)
            return

        if event == "keyDown" and context:
            self._focus_codex_window()
            return

        if event == "keyUp" and context:
            self._focus_codex_window()
            with self._lock:
                state = self._actions.get(context)
                if state and state.target_thread_id:
                    watch = self._watch_for_state(state)
                    if watch:
                        watch.last_refresh_at = 0.0
                    self._pending_pi_updates.add(context)
            return

        if event in {"didReceiveGlobalSettings", "titleParametersDidChange"}:
            return

        log("Unhandled Stream Dock event", event=event, context=context, action=action)

    def _focus_codex_window(self) -> None:
        now = time.monotonic()
        if now - self._last_codex_focus_at < CODEX_FOCUS_COOLDOWN_SECONDS:
            return

        self._last_codex_focus_at = now
        try:
            if not focus_codex_window():
                log("Codex window focus failed")
        except Exception as exc:
            log("Codex window focus error", error=str(exc))

    def _handle_property_inspector_message(
        self,
        context: str,
        payload: dict[str, Any],
        action: str | None,
    ) -> None:
        command = normalize_text(payload.get("command"))
        state = None

        with self._lock:
            state = self._actions.get(context) or ActionState(context=context)
            state.action = action or state.action
            self._actions[context] = state

            if command == "select_thread":
                settings = payload.get("settings")
                if isinstance(settings, dict):
                    state.apply_settings(settings)
                self._pending_pi_updates.add(context)
            elif command == "update_settings":
                settings = payload.get("settings")
                if isinstance(settings, dict):
                    state.apply_settings(settings)
                self._pending_pi_updates.add(context)
            elif command == "clear_thread":
                settings = payload.get("settings")
                if isinstance(settings, dict):
                    state.apply_settings(settings)
                else:
                    state.apply_settings(
                        {
                            "targetProjectKey": "",
                            "targetProjectName": "",
                            "targetProjectPath": "",
                            "targetThreadId": "",
                            "targetThreadName": "",
                            "targetThreadPreview": "",
                            "targetThreadCwd": "",
                            "buttonTitle": "",
                            "connectionMode": "local",
                            "sshHost": "",
                            "sshPort": "22",
                            "sshUsername": "",
                            "sshAuthType": "password",
                            "sshPassword": "",
                            "sshKeyPath": "",
                            "sshKeyPassphrase": "",
                            "remoteCodexCommand": "",
                        }
                    )
                self._pending_pi_updates.add(context)
            elif command in {"pi_ready", "refresh_thread", "refresh_threads"}:
                state.last_property_inspector_payload = ""
                if command in {"refresh_thread", "refresh_threads"} and state.target_thread_id:
                    watch = self._watch_for_state(state)
                    if watch:
                        watch.last_refresh_at = 0.0
                self._pending_pi_updates.add(context)
            else:
                self._pending_pi_updates.add(context)

        self._render_context(context)

    def _extract_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        data = payload.get("payload")
        if isinstance(data, dict):
            settings = data.get("settings")
            if isinstance(settings, dict):
                return settings
        return {}

    def _worker_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._drain_notifications()
                self._reconcile_watches()
                self._refresh_watches()
                self._flush_property_inspector_updates()
            except Exception as exc:  # pragma: no cover - defensive runtime logging
                log(
                    "Worker loop error",
                    error=str(exc),
                    traceback=traceback.format_exc(),
                )

            self._stop_event.wait(WORKER_TICK_SECONDS)

    def _render_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._render_all()
            except Exception as exc:  # pragma: no cover - defensive runtime logging
                log(
                    "Render loop error",
                    error=str(exc),
                    traceback=traceback.format_exc(),
                )

            self._stop_event.wait(RENDER_TICK_SECONDS)

    def _log_watch_state_change(
        self,
        watch: ThreadWatch,
        source: str,
        extra: dict[str, Any] | None = None,
    ) -> None:
        raw_status = watch.thread.get("status") if isinstance(watch.thread, dict) else None
        raw_status_type = raw_status.get("type") if isinstance(raw_status, dict) else None
        active_flags = raw_status.get("activeFlags") if isinstance(raw_status, dict) else None
        state_code, state_label = status_line_for_watch(watch)
        payload: dict[str, Any] = {
            "source": source,
            "connection": watch.connection.source_label,
            "state": state_code,
            "label": state_label,
            "raw_status_type": raw_status_type,
            "active_flags": active_flags,
            "subscribed": watch.subscribed,
            "error_kind": watch.error_kind,
            "error": shorten(watch.error_message, 160),
            "latest_turn_status": watch.latest_turn_status,
            "latest_turn_id": watch.latest_turn_id,
            "latest_turn_started_at": watch.latest_turn_started_at,
            "latest_turn_completed_at": watch.latest_turn_completed_at,
        }
        if extra:
            payload.update(extra)

        signature = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        if signature == watch.last_debug_signature:
            return
        watch.last_debug_signature = signature
        log("Watch state changed", thread_id=watch.thread_id, **payload)

    def _drain_notifications(self) -> None:
        with self._lock:
            clients = list(self._clients.items())

        for client_key, client in clients:
            notification_queue = client.notification_queue()
            while True:
                try:
                    message = notification_queue.get_nowait()
                except Empty:
                    break

                method = message.get("method")
                params = message.get("params", {})

                if method == "__app_server_exited__":
                    generation = params.get("generation")
                    if generation != client.generation:
                        continue
                    with self._lock:
                        for watch in self._watches.values():
                            if watch.connection.client_key != client_key:
                                continue
                            watch.subscribed = False
                            watch.app_server_generation = 0
                            watch.set_error("offline", client.last_error or "app-server exited")
                            self._log_watch_state_change(watch, "__app_server_exited__")
                            for context in watch.contexts:
                                self._pending_pi_updates.add(context)
                    log("Codex app-server exited", source=client.label)
                    continue

                if method == "thread/status/changed":
                    thread_id = normalize_text(params.get("threadId"))
                    if not thread_id:
                        continue
                    with self._lock:
                        watch = self._watches.get(f"{client_key}|thread:{thread_id}")
                        if watch:
                            watch.subscribed = True
                            watch.app_server_generation = client.generation
                            watch.apply_status(params.get("status"))
                            watch.last_refresh_at = time.monotonic()
                            self._log_watch_state_change(watch, method)
                            for context in watch.contexts:
                                self._pending_pi_updates.add(context)
                    continue

                if method == "thread/tokenUsage/updated":
                    thread_id = normalize_text(params.get("threadId"))
                    if not thread_id:
                        continue
                    with self._lock:
                        watch = self._watches.get(f"{client_key}|thread:{thread_id}")
                        if watch:
                            watch.note_token_activity(params.get("turnId"))
                            self._log_watch_state_change(watch, method)
                            for context in watch.contexts:
                                self._pending_pi_updates.add(context)
                    continue

                if method in {"turn/started", "turn/completed"}:
                    thread_id = normalize_text(params.get("threadId"))
                    if not thread_id:
                        continue
                    with self._lock:
                        watch = self._watches.get(f"{client_key}|thread:{thread_id}")
                        if watch:
                            if method == "turn/started":
                                watch.note_turn_started(params.get("turnId"))
                            else:
                                watch.note_turn_completed(params.get("turnId"))
                            watch.last_refresh_at = 0.0
                            self._log_watch_state_change(watch, method)
                            for context in watch.contexts:
                                self._pending_pi_updates.add(context)
                    continue

                if method == "thread/name/updated":
                    thread_id = normalize_text(params.get("threadId"))
                    if not thread_id:
                        continue
                    with self._lock:
                        watch = self._watches.get(f"{client_key}|thread:{thread_id}")
                        if watch and watch.thread is not None:
                            watch.thread["name"] = params.get("name")
                            for context in watch.contexts:
                                self._pending_pi_updates.add(context)
                    continue

                if method in {"thread/deleted", "thread/closed"}:
                    thread_id = normalize_text(params.get("threadId"))
                    if not thread_id:
                        continue
                    with self._lock:
                        watch = self._watches.get(f"{client_key}|thread:{thread_id}")
                        if watch:
                            watch.subscribed = False
                            watch.set_error("missing", method)
                            watch.last_refresh_at = time.monotonic()
                            self._log_watch_state_change(watch, method)
                            for context in watch.contexts:
                                self._pending_pi_updates.add(context)
                    continue

    def _reconcile_watches(self) -> None:
        with self._lock:
            desired_contexts: dict[str, set[str]] = {}
            desired_meta: dict[str, tuple[str, ConnectionConfig]] = {}
            for context, state in self._actions.items():
                if not state.target_thread_id:
                    continue
                connection = state.connection_config()
                watch_key = watch_key_for(connection, state.target_thread_id)
                if not watch_key:
                    continue
                desired_contexts.setdefault(watch_key, set()).add(context)
                desired_meta[watch_key] = (state.target_thread_id, connection)

            current_ids = set(self._watches)
            desired_ids = set(desired_contexts)
            to_remove = current_ids - desired_ids
            to_add = desired_ids - current_ids
            to_keep = current_ids & desired_ids

            for watch_key in to_keep:
                self._watches[watch_key].contexts = desired_contexts[watch_key]
                _thread_id, connection = desired_meta[watch_key]
                self._watches[watch_key].connection = connection

            for watch_key in to_add:
                thread_id, connection = desired_meta[watch_key]
                self._watches[watch_key] = ThreadWatch(
                    watch_key=watch_key,
                    thread_id=thread_id,
                    connection=connection,
                    contexts=desired_contexts[watch_key],
                )

            removed_watches = [
                self._watches.pop(watch_key)
                for watch_key in to_remove
                if watch_key in self._watches
            ]

        for watch in removed_watches:
            self._unsubscribe_watch(watch)

        with self._lock:
            active_client_keys = {watch.connection.client_key for watch in self._watches.values()}
            unused_client_keys = set(self._clients) - active_client_keys
            unused_clients = [
                self._clients.pop(client_key)
                for client_key in unused_client_keys
                if client_key in self._clients
            ]

        for client in unused_clients:
            client.stop()

    def _unsubscribe_watch(self, watch: ThreadWatch) -> None:
        client = self._clients.get(watch.connection.client_key)
        if client is None or not client.is_running():
            return
        try:
            client.call("thread/unsubscribe", {"threadId": watch.thread_id}, timeout=5.0)
        except Exception as exc:
            log(
                "Thread unsubscribe failed",
                thread_id=watch.thread_id,
                connection=watch.connection.source_label,
                error=str(exc),
            )

    def _refresh_watches(self) -> None:
        with self._lock:
            grouped: dict[str, tuple[ConnectionConfig, list[str]]] = {}
            for watch_key, watch in self._watches.items():
                client_key = watch.connection.client_key
                if client_key not in grouped:
                    grouped[client_key] = (watch.connection, [])
                grouped[client_key][1].append(watch_key)

        if not grouped:
            return

        now = time.monotonic()

        for _client_key, (connection, watch_keys) in grouped.items():
            client = self._client_for_connection(connection)
            if not client.ensure_started():
                with self._lock:
                    for watch_key in watch_keys:
                        watch = self._watches.get(watch_key)
                        if watch:
                            watch.subscribed = False
                            watch.set_error("offline", client.last_error or APP_SERVER_UNAVAILABLE)
                            self._log_watch_state_change(watch, "app-server")
                            for context in watch.contexts:
                                self._pending_pi_updates.add(context)
                continue

            generation = client.generation

            for watch_key in watch_keys:
                with self._lock:
                    watch = self._watches.get(watch_key)
                    if watch is None:
                        continue
                    if watch.error_kind == "missing":
                        needs_resume = now - watch.last_refresh_at >= MISSING_THREAD_RETRY_SECONDS
                    elif watch.error_kind in {"error", "offline"}:
                        needs_resume = now - watch.last_refresh_at >= APP_SERVER_RETRY_SECONDS
                    else:
                        needs_resume = (
                            not watch.subscribed
                            or watch.app_server_generation != generation
                        )
                    needs_read = watch.subscribed and now - watch.last_refresh_at >= WATCH_REFRESH_SECONDS

                if needs_resume:
                    self._resume_watch(watch_key, client, generation)
                    continue

                if needs_read:
                    self._read_watch(watch_key, client)

    def _resume_watch(
        self,
        watch_key: str,
        client: JsonRpcAppServerClient,
        generation: int,
    ) -> None:
        with self._lock:
            watch = self._watches.get(watch_key)
            if watch is None:
                return
            thread_id = watch.thread_id
            connection = watch.connection

        should_restart_client = False
        try:
            result = client.call("thread/resume", {"threadId": thread_id})
            thread = compact_thread(result.get("thread"))
            latest_turn, turn_fetch_failed = self._fetch_latest_turn(client, thread_id, connection)
        except Exception as exc:
            message = str(exc)
            kind = "missing" if "no rollout found" in message else "error"
            with self._lock:
                watch = self._watches.get(watch_key)
                if watch:
                    watch.subscribed = False
                    watch.app_server_generation = generation
                    watch.last_refresh_at = time.monotonic()
                    watch.set_error(kind, message)
                    self._log_watch_state_change(watch, "thread/resume")
                    for context in watch.contexts:
                        self._pending_pi_updates.add(context)
            log(
                "Thread resume failed",
                thread_id=thread_id,
                connection=connection.source_label,
                error=message,
            )
            return

        with self._lock:
            watch = self._watches.get(watch_key)
            if watch:
                watch.subscribed = True
                watch.app_server_generation = generation
                watch.last_refresh_at = time.monotonic()
                watch.set_thread(thread)
                self._apply_turn_fetch_result(watch, latest_turn, turn_fetch_failed)
                self._log_watch_state_change(watch, "thread/resume")
                for context in watch.contexts:
                    self._pending_pi_updates.add(context)
                should_restart_client = self._should_restart_stale_active_client(watch)

        if should_restart_client:
            self._restart_client(connection, "turn summary timeouts while active", thread_id)

    def _read_watch(self, watch_key: str, client: JsonRpcAppServerClient) -> None:
        with self._lock:
            watch = self._watches.get(watch_key)
            if watch is None:
                return
            thread_id = watch.thread_id
            connection = watch.connection

        should_restart_client = False
        try:
            result = client.call("thread/read", {"threadId": thread_id})
            thread = compact_thread(result.get("thread"))
            latest_turn, turn_fetch_failed = self._fetch_latest_turn(client, thread_id, connection)
        except Exception as exc:
            message = str(exc)
            kind = "missing" if "thread not loaded" in message or "no rollout found" in message else "error"
            with self._lock:
                watch = self._watches.get(watch_key)
                if watch:
                    watch.subscribed = False
                    watch.last_refresh_at = time.monotonic()
                    watch.set_error(kind, message)
                    self._log_watch_state_change(watch, "thread/read")
                    for context in watch.contexts:
                        self._pending_pi_updates.add(context)
            log(
                "Thread read failed",
                thread_id=thread_id,
                connection=connection.source_label,
                error=message,
            )
            return

        with self._lock:
            watch = self._watches.get(watch_key)
            if watch:
                watch.last_refresh_at = time.monotonic()
                watch.set_thread(thread)
                self._apply_turn_fetch_result(watch, latest_turn, turn_fetch_failed)
                self._log_watch_state_change(watch, "thread/read")
                for context in watch.contexts:
                    self._pending_pi_updates.add(context)
                should_restart_client = self._should_restart_stale_active_client(watch)

        if should_restart_client:
            self._restart_client(connection, "turn summary timeouts while active", thread_id)

    def _fetch_latest_turn(
        self,
        client: JsonRpcAppServerClient,
        thread_id: str,
        connection: ConnectionConfig,
    ) -> tuple[dict[str, Any] | None, bool]:
        try:
            result = client.call(
                "thread/turns/list",
                {"threadId": thread_id, "limit": THREAD_TURN_LIST_LIMIT},
                timeout=TURN_LIST_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            log(
                "Thread turns list failed",
                thread_id=thread_id,
                connection=connection.source_label,
                error=str(exc),
            )
            return (None, True)

        turns = result.get("data") or []
        if not turns or not isinstance(turns[0], dict):
            return (None, False)
        return (turns[0], False)

    def _apply_turn_fetch_result(
        self,
        watch: ThreadWatch,
        latest_turn: dict[str, Any] | None,
        failed: bool,
    ) -> None:
        if latest_turn is not None:
            watch.apply_turn_summary(latest_turn)
            return

        if failed:
            watch.note_turn_summary_failed()
            if watch.state_code not in ACTIVE_STATE_CODES:
                watch.clear_turn_summary()
            return

        watch.note_turn_summary_success_without_data()

    def _should_restart_stale_active_client(self, watch: ThreadWatch) -> bool:
        if watch.connection.mode != "ssh":
            return False
        if watch.turn_summary_failures < TURN_LIST_FAILURE_RESTART_THRESHOLD:
            return False
        return watch.state_code in ACTIVE_STATE_CODES

    def _restart_client(
        self,
        connection: ConnectionConfig,
        reason: str,
        thread_id: str | None = None,
    ) -> None:
        client_key = connection.client_key
        with self._lock:
            client = self._clients.pop(client_key, None)
            affected_watches = [
                watch
                for watch in self._watches.values()
                if watch.connection.client_key == client_key
            ]
            for watch in affected_watches:
                watch.subscribed = False
                watch.app_server_generation = 0
                watch.last_refresh_at = 0.0
                watch.turn_summary_failures = 0
                watch.last_turn_summary_failed_at = 0.0
                for context in watch.contexts:
                    self._pending_pi_updates.add(context)

        if client is not None:
            client.stop()

        log(
            "Codex app-server client restarted",
            connection=connection.source_label,
            thread_id=thread_id,
            reason=reason,
        )

    def _flush_property_inspector_updates(self) -> None:
        with self._lock:
            contexts = [
                context
                for context in self._pending_pi_updates
                if context in self._actions and self._actions[context].property_inspector_visible
            ]
            self._pending_pi_updates.clear()

        if not contexts:
            return

        for context in contexts:
            payload = self._build_property_inspector_payload(context)
            if payload is None:
                continue
            self._send_to_property_inspector(context, payload)

    def _build_property_inspector_payload(self, context: str) -> dict[str, Any] | None:
        with self._lock:
            state = self._actions.get(context)
            if state is None:
                return None

            connection = state.connection_config()
            client = self._clients.get(connection.client_key)
            watch = self._watch_for_state(state)
            monitor_state = "no_thread"
            monitor_label = STATUS_NO_THREAD
            thread_name = None
            thread_id = state.target_thread_id
            thread_cwd = state.target_thread_cwd
            server_online = bool(client and client.is_running())
            server_error = client.last_error if client and not client.is_running() else None

            if watch is not None:
                monitor_state, monitor_label = status_line_for_watch(watch)
                thread_name = thread_title_from_sources(
                    watch.thread,
                    state.target_thread_name,
                    state.target_thread_preview,
                )
                thread_cwd = normalize_text((watch.thread or {}).get("cwd")) or thread_cwd
            elif state.target_thread_id:
                monitor_state, monitor_label = ("syncing", STATUS_SYNC)
                thread_name = thread_title_from_sources(
                    None,
                    state.target_thread_name,
                    state.target_thread_preview,
                )
            selected_id = state.target_thread_id

            return {
                "plugin": "codexhook",
                "kind": "inspectorData",
                "serverOnline": server_online,
                "error": server_error,
                "selectedSettings": state.settings,
                "monitor": {
                    "threadId": selected_id,
                    "threadName": thread_name,
                    "state": monitor_state,
                    "label": monitor_label,
                    "cwd": thread_cwd,
                    "connection": connection.display_name,
                },
            }

    def _render_all(self) -> None:
        with self._lock:
            contexts = list(self._actions)
        for context in contexts:
            self._render_context(context)

    def _render_context(self, context: str) -> None:
        with self._lock:
            state = self._actions.get(context)
            if state is None or not state.visible:
                return
            watch = self._watch_for_state(state)
            title, status = build_button_parts(state, watch)
            frame = None
            if status in ANIMATED_STATUS_LABELS:
                frame = int(time.monotonic() / RUNNING_ANIMATION_FRAME_SECONDS) % RUNNING_ANIMATION_FRAMES
            elif status == STATUS_IDLE:
                frame = int(time.monotonic() / IDLE_ANIMATION_FRAME_SECONDS) % IDLE_ANIMATION_FRAMES
            elif status == STATUS_SYNC:
                frame = int(time.monotonic() / SYNC_ANIMATION_FRAME_SECONDS) % SYNC_ANIMATION_FRAMES
            elif status == STATUS_WAIT_APPROVAL:
                frame = int(time.monotonic() / APPROVAL_ANIMATION_FRAME_SECONDS) % APPROVAL_ANIMATION_FRAMES
            elif status == STATUS_WAIT_INPUT:
                frame = int(time.monotonic() / INPUT_ANIMATION_FRAME_SECONDS) % INPUT_ANIMATION_FRAMES
            signature = json.dumps(
                {"title": title, "status": status, "frame": frame},
                ensure_ascii=False,
                sort_keys=True,
            )
            if signature == state.last_button_signature:
                return
            state.last_button_signature = signature

        emit(
            {
                "type": "set_image",
                "context": context,
                "image": render_button_image(title, status, frame),
            }
        )

    def _send_to_property_inspector(self, context: str, payload: dict[str, Any]) -> None:
        with self._lock:
            state = self._actions.get(context) or ActionState(context=context)
            action = state.action

            serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
            if serialized == state.last_property_inspector_payload:
                return

            state.last_property_inspector_payload = serialized

        emit(
            {
                "type": "send",
                "payload": {
                    "event": "sendToPropertyInspector",
                    "context": context,
                    "action": action,
                    "payload": payload,
                },
            }
        )


def main() -> int:
    runtime = BackendRuntime()
    log("Python backend boot", python=sys.executable)

    try:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
                if not isinstance(message, dict):
                    log("Dropped non-object message", value=line)
                    continue
                runtime.handle_message(message)
            except Exception as exc:  # pragma: no cover - defensive runtime logging
                log(
                    "Backend error",
                    error=str(exc),
                    traceback=traceback.format_exc(),
                )
    finally:
        runtime.shutdown()

    log("Python backend stdin closed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
