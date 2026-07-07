const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");
const SshClient = require("ssh2/lib/client");

const rootDir = path.resolve(__dirname, "..");
const logDir = path.join(rootDir, "logs");
const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.plugin.log`);
const focusScript = path.join(__dirname, "focus-codex-window.ps1");

const THREAD_TURN_LIST_LIMIT = 1;
const WATCH_REFRESH_SECONDS = 2.0;
const WORKER_TICK_SECONDS = 0.2;
const RENDER_TICK_SECONDS = 0.1;
const REQUEST_TIMEOUT_SECONDS = 10.0;
const APP_SERVER_RETRY_SECONDS = 5.0;
const TOKEN_ACTIVITY_GRACE_SECONDS = 20.0;
const UNFINISHED_TURN_RUNNING_SECONDS = 6 * 60 * 60;
const MISSING_THREAD_RETRY_SECONDS = 30.0;
const TURN_LIST_TIMEOUT_SECONDS = 5.0;
const TURN_LIST_FAILURE_RESTART_THRESHOLD = 3;

const STATUS_SYNC = "同步";
const STATUS_IDLE = "空闲";
const STATUS_SLEEP = "休眠";
const STATUS_ERROR = "错误";
const STATUS_WAIT_APPROVAL = "待批";
const STATUS_WAIT_INPUT = "输入";
const STATUS_RUNNING = "进行中";
const STATUS_BUSY = "忙碌";
const STATUS_OFFLINE = "离线";
const STATUS_MISSING = "丢失";
const STATUS_NO_THREAD = "未选择会话";
const APP_SERVER_UNAVAILABLE = "Codex app-server 不可用";
const BUTTON_DEFAULT_TITLE = "CodexHook";
const ACTIVE_STATE_CODES = new Set(["busy", "waiting_approval", "waiting_input"]);
const TERMINAL_TURN_STATUSES = new Set(["aborted", "canceled", "cancelled", "completed", "failed"]);

const BUTTON_IMAGE_SIZE = 144;
const BUTTON_TITLE_AREA_HEIGHT = 48;
const BUTTON_PADDING_X = 10;
const BUTTON_BG = "#000000";
const BUTTON_TITLE_FG = "#d7d7d7";
const BUTTON_STATUS_FG = "#ffffff";
const BUTTON_DIVIDER = "#222222";
const BUTTON_CACHE_LIMIT = 256;
const RUNNING_ANIMATION_FRAMES = 8;
const RUNNING_ANIMATION_FRAME_SECONDS = 0.18;
const IDLE_ANIMATION_FRAMES = 8;
const IDLE_ANIMATION_FRAME_SECONDS = 0.3;
const SYNC_ANIMATION_FRAMES = 8;
const SYNC_ANIMATION_FRAME_SECONDS = 0.18;
const APPROVAL_ANIMATION_FRAMES = 8;
const APPROVAL_ANIMATION_FRAME_SECONDS = 0.28;
const INPUT_ANIMATION_FRAMES = 8;
const INPUT_ANIMATION_FRAME_SECONDS = 0.32;
const CODEX_FOCUS_COOLDOWN_SECONDS = 1.0;
const ANIMATED_STATUS_LABELS = new Set([STATUS_RUNNING, STATUS_BUSY]);

fs.mkdirSync(logDir, { recursive: true });

function stringify(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map(stringify).join(" ")}`;
  fs.appendFileSync(logFile, `${line}\n`, "utf8");
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key || !key.startsWith("-")) {
      continue;
    }

    parsed[key.slice(1)] = value;
  }

  return parsed;
}

function safeJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    log("JSON parse failed", { text, error: error.message });
    return null;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function monotonicSeconds() {
  return performance.now() / 1000;
}

function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const stripped = value.trim();
  return stripped || null;
}

function preserveTitleText(value) {
  if (typeof value !== "string") {
    return null;
  }

  return value === "" ? null : value;
}

function firstLine(text) {
  const value = normalizeText(text);
  if (!value) {
    return null;
  }

  return normalizeText(value.split(/\r?\n/)[0]);
}

function shorten(value, limit) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(limit - 1, 1))}…`;
}

function safeThreadIdSuffix(threadId) {
  return threadId ? threadId.slice(-4) : "----";
}

function secretDigest(value) {
  return value ? sha256(value).slice(0, 16) : "";
}

function parsePort(value, fallback = 22) {
  const port = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fallback;
  }

  return port;
}

function buildRemoteAppServerCommand(remoteCodexCommand) {
  const codexCommand = normalizeText(remoteCodexCommand) || "codex";
  return [
    'for dir in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$dir" ] && PATH="$dir:$PATH"; done',
    'PATH="$HOME/.local/bin:$PATH"',
    "export PATH",
    `exec ${codexCommand} app-server --stdio`
  ].join("; ");
}

class ConnectionConfig {
  constructor(options = {}) {
    this.mode = options.mode === "ssh" ? "ssh" : "local";
    this.sshHost = options.sshHost || null;
    this.sshPort = options.sshPort || 22;
    this.sshUsername = options.sshUsername || null;
    this.sshAuthType = options.sshAuthType === "key" ? "key" : "password";
    this.sshPassword = options.sshPassword ?? null;
    this.sshKeyPath = options.sshKeyPath || null;
    this.sshKeyPassphrase = options.sshKeyPassphrase ?? null;
    this.remoteCodexCommand = options.remoteCodexCommand || null;
  }

  get clientKey() {
    if (this.mode !== "ssh") {
      return "local";
    }

    const payload = {
      authType: this.sshAuthType,
      host: this.sshHost || "",
      keyPassphraseHash: secretDigest(this.sshKeyPassphrase),
      keyPath: this.sshKeyPath || "",
      mode: this.mode,
      passwordHash: secretDigest(this.sshPassword),
      port: this.sshPort,
      remoteCodexCommand: this.remoteCodexCommand || "",
      username: this.sshUsername || ""
    };

    return `ssh:${sha256(stableStringify(payload)).slice(0, 24)}`;
  }

  get sourceLabel() {
    if (this.mode === "ssh") {
      return `ssh ${this.sshUsername || "?"}@${this.sshHost || "?"}:${this.sshPort}`;
    }

    return "local";
  }

  get displayName() {
    if (this.mode === "ssh") {
      return `SSH ${this.sshUsername || "?"}@${this.sshHost || "?"}:${this.sshPort}`;
    }

    return "本机 Codex";
  }
}

function watchKeyFor(connection, threadId) {
  return threadId ? `${connection.clientKey}|thread:${threadId}` : null;
}

class ActionState {
  constructor(context) {
    this.context = context;
    this.action = null;
    this.visible = false;
    this.propertyInspectorVisible = false;
    this.settings = {};
    this.targetProjectKey = null;
    this.targetProjectName = null;
    this.targetProjectPath = null;
    this.targetThreadId = null;
    this.targetThreadName = null;
    this.targetThreadPreview = null;
    this.targetThreadCwd = null;
    this.buttonTitle = null;
    this.connectionMode = "local";
    this.sshHost = null;
    this.sshPort = "22";
    this.sshUsername = null;
    this.sshAuthType = "password";
    this.sshPassword = null;
    this.sshKeyPath = null;
    this.sshKeyPassphrase = null;
    this.remoteCodexCommand = null;
    this.lastButtonSignature = "";
    this.lastPropertyInspectorPayload = "";
  }

  applySettings(settings) {
    const normalized = { ...(settings || {}) };
    this.settings = normalized;
    this.targetProjectKey = normalizeText(normalized.targetProjectKey);
    this.targetProjectName = normalizeText(normalized.targetProjectName);
    this.targetProjectPath = normalizeText(normalized.targetProjectPath);
    this.targetThreadId = normalizeText(normalized.targetThreadId);
    this.targetThreadName = normalizeText(normalized.targetThreadName);
    this.targetThreadPreview = normalizeText(normalized.targetThreadPreview);
    this.targetThreadCwd = normalizeText(normalized.targetThreadCwd);
    this.buttonTitle = preserveTitleText(normalized.buttonTitle);
    this.connectionMode = normalizeText(normalized.connectionMode) === "ssh" ? "ssh" : "local";
    this.sshHost = normalizeText(normalized.sshHost);
    this.sshPort = normalizeText(normalized.sshPort) || "22";
    this.sshUsername = normalizeText(normalized.sshUsername);
    this.sshAuthType = normalizeText(normalized.sshAuthType) === "key" ? "key" : "password";
    this.sshPassword = preserveTitleText(normalized.sshPassword);
    this.sshKeyPath = normalizeText(normalized.sshKeyPath);
    this.sshKeyPassphrase = preserveTitleText(normalized.sshKeyPassphrase);
    this.remoteCodexCommand = normalizeText(normalized.remoteCodexCommand);
  }

  connectionConfig() {
    if (this.connectionMode !== "ssh") {
      return new ConnectionConfig({ mode: "local" });
    }

    return new ConnectionConfig({
      mode: "ssh",
      sshAuthType: this.sshAuthType,
      sshHost: this.sshHost,
      sshKeyPassphrase: this.sshKeyPassphrase,
      sshKeyPath: this.sshKeyPath,
      sshPassword: this.sshPassword,
      sshPort: parsePort(this.sshPort),
      sshUsername: this.sshUsername,
      remoteCodexCommand: this.remoteCodexCommand
    });
  }

  watchKey() {
    return watchKeyFor(this.connectionConfig(), this.targetThreadId);
  }
}

class ThreadWatch {
  constructor(watchKey, threadId, connection, contexts = new Set()) {
    this.watchKey = watchKey;
    this.threadId = threadId;
    this.connection = connection;
    this.contexts = contexts;
    this.thread = null;
    this.stateCode = "syncing";
    this.stateLabel = STATUS_SYNC;
    this.subscribed = false;
    this.appServerGeneration = 0;
    this.errorKind = null;
    this.errorMessage = null;
    this.lastRefreshAt = 0.0;
    this.latestTurnId = null;
    this.latestTurnStatus = null;
    this.latestTurnStartedAt = null;
    this.latestTurnCompletedAt = null;
    this.lastTokenActivityAt = 0.0;
    this.turnSummaryFailures = 0;
    this.lastTurnSummaryFailedAt = 0.0;
    this.lastDebugSignature = "";
  }

  applyStatus(status) {
    this.errorKind = null;
    this.errorMessage = null;
    const [stateCode, stateLabel] = statusDescriptor(status);
    this.stateCode = stateCode;
    this.stateLabel = stateLabel;
    if (!this.thread) {
      this.thread = {};
    }
    this.thread.status = status;
  }

  setThread(thread) {
    const compact = compactThread(thread);
    if (!compact) {
      return;
    }

    this.thread = compact;
    this.applyStatus(compact.status);
  }

  applyTurnSummary(turn) {
    if (!turn || typeof turn !== "object") {
      return;
    }

    this.turnSummaryFailures = 0;
    this.lastTurnSummaryFailedAt = 0.0;
    this.latestTurnId = normalizeText(turn.id);
    this.latestTurnStatus = normalizeText(turn.status);
    this.latestTurnStartedAt = Number.isFinite(turn.startedAt) ? Math.trunc(turn.startedAt) : null;
    this.latestTurnCompletedAt = Number.isFinite(turn.completedAt) ? Math.trunc(turn.completedAt) : null;
  }

  clearTurnSummary() {
    this.latestTurnId = null;
    this.latestTurnStatus = null;
    this.latestTurnStartedAt = null;
    this.latestTurnCompletedAt = null;
    this.lastTokenActivityAt = 0.0;
  }

  noteTurnSummaryFailed() {
    this.turnSummaryFailures += 1;
    this.lastTurnSummaryFailedAt = monotonicSeconds();
  }

  noteTurnSummarySuccessWithoutData() {
    this.turnSummaryFailures = 0;
    this.lastTurnSummaryFailedAt = 0.0;
    this.clearTurnSummary();
  }

  noteTurnStarted(turnId) {
    const normalizedTurnId = normalizeText(turnId);
    if (normalizedTurnId) {
      this.latestTurnId = normalizedTurnId;
    }
    this.latestTurnStatus = "started";
    this.latestTurnStartedAt = epochSeconds();
    this.latestTurnCompletedAt = null;
  }

  noteTurnCompleted(turnId) {
    const normalizedTurnId = normalizeText(turnId);
    if (normalizedTurnId && (!this.latestTurnId || this.latestTurnId === normalizedTurnId)) {
      this.latestTurnId = normalizedTurnId;
    }
    this.latestTurnStatus = "completed";
    this.latestTurnCompletedAt = epochSeconds();
  }

  noteTokenActivity(turnId) {
    const normalizedTurnId = normalizeText(turnId);
    if (normalizedTurnId) {
      this.latestTurnId = normalizedTurnId;
    }
    this.lastTokenActivityAt = monotonicSeconds();
  }

  shouldInferRunning() {
    if (!["idle", "syncing"].includes(this.stateCode)) {
      return false;
    }

    if (this.latestTurnStartedAt !== null && this.latestTurnCompletedAt !== null) {
      return false;
    }

    const now = monotonicSeconds();
    if (this.lastTokenActivityAt && now - this.lastTokenActivityAt <= TOKEN_ACTIVITY_GRACE_SECONDS) {
      return true;
    }

    if (TERMINAL_TURN_STATUSES.has(String(this.latestTurnStatus || "").toLowerCase())) {
      return false;
    }

    if (this.latestTurnStartedAt !== null && this.latestTurnCompletedAt === null) {
      return Date.now() / 1000 - this.latestTurnStartedAt <= UNFINISHED_TURN_RUNNING_SECONDS;
    }

    return false;
  }

  setError(kind, message = null) {
    this.errorKind = kind;
    this.errorMessage = message;
    if (kind === "offline") {
      this.stateCode = "offline";
      this.stateLabel = STATUS_OFFLINE;
    } else if (kind === "missing") {
      this.stateCode = "missing";
      this.stateLabel = STATUS_MISSING;
    } else {
      this.stateCode = "error";
      this.stateLabel = STATUS_ERROR;
    }
  }
}

function compactThread(thread) {
  if (!thread || typeof thread !== "object") {
    return null;
  }

  return {
    id: thread.id,
    name: thread.name,
    preview: thread.preview,
    cwd: thread.cwd,
    status: thread.status,
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
    path: thread.path
  };
}

function statusDescriptor(status) {
  if (!status || typeof status !== "object") {
    return ["syncing", STATUS_SYNC];
  }

  if (status.type === "idle") {
    return ["idle", STATUS_IDLE];
  }

  if (status.type === "notLoaded") {
    return ["not_loaded", STATUS_SLEEP];
  }

  if (status.type === "systemError") {
    return ["error", STATUS_ERROR];
  }

  if (status.type === "active") {
    const flags = new Set(status.activeFlags || []);
    if (flags.has("waitingOnApproval")) {
      return ["waiting_approval", STATUS_WAIT_APPROVAL];
    }
    if (flags.has("waitingOnUserInput")) {
      return ["waiting_input", STATUS_WAIT_INPUT];
    }
    return ["busy", STATUS_BUSY];
  }

  return ["syncing", STATUS_SYNC];
}

function threadTitleFromSources(thread, fallbackName, fallbackPreview) {
  const candidates = [
    normalizeText((thread || {}).name),
    firstLine((thread || {}).preview),
    normalizeText(fallbackName),
    firstLine(fallbackPreview)
  ];

  return candidates.find(Boolean) || null;
}

function threadNameFromSources(threadId, thread, fallbackName, fallbackPreview) {
  return threadTitleFromSources(thread, fallbackName, fallbackPreview) || `#${safeThreadIdSuffix(threadId)}`;
}

function statusLineForWatch(watch) {
  if (watch.errorKind === "offline") {
    return ["offline", STATUS_OFFLINE];
  }
  if (watch.errorKind === "missing") {
    return ["missing", STATUS_MISSING];
  }
  if (watch.errorKind === "error") {
    return ["error", STATUS_ERROR];
  }
  if (ACTIVE_STATE_CODES.has(watch.stateCode)) {
    return [watch.stateCode, watch.stateLabel];
  }
  if (watch.shouldInferRunning()) {
    return ["running", STATUS_RUNNING];
  }
  if (watch.stateCode) {
    return [watch.stateCode, watch.stateLabel];
  }

  return ["syncing", STATUS_SYNC];
}

function buildButtonParts(action, watch) {
  const title = preserveTitleText(action.buttonTitle);

  if (!action.targetThreadId) {
    return [title || BUTTON_DEFAULT_TITLE, "未选择"];
  }

  if (!watch) {
    const threadName = threadNameFromSources(
      action.targetThreadId,
      null,
      action.targetThreadName,
      action.targetThreadPreview
    );
    return [title || threadName, STATUS_SYNC];
  }

  const [, statusLabel] = statusLineForWatch(watch);
  const threadName = threadNameFromSources(
    action.targetThreadId,
    watch.thread,
    action.targetThreadName,
    action.targetThreadPreview
  );
  return [title || threadName, statusLabel];
}

class JsonRpcAppServerClient {
  constructor(label) {
    this.label = label;
    this.transport = null;
    this.pending = new Map();
    this.notifications = [];
    this.nextRequestId = 1;
    this.generation = 0;
    this.lastError = null;
    this.retryAfter = 0.0;
    this.starting = null;
  }

  isRunning() {
    return Boolean(this.transport && this.transport.isRunning());
  }

  async ensureStarted() {
    if (this.isRunning()) {
      return true;
    }

    if (this.starting) {
      return this.starting;
    }

    const now = monotonicSeconds();
    if (now < this.retryAfter) {
      return false;
    }

    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async start() {
    let transport;
    try {
      transport = await this.openTransport();
    } catch (error) {
      this.lastError = `start failed: ${error.message || error}`;
      this.retryAfter = monotonicSeconds() + APP_SERVER_RETRY_SECONDS;
      log("Codex app-server start failed", { source: this.label, error: String(error.message || error) });
      return false;
    }

    this.transport = transport;
    this.generation += 1;
    const generation = this.generation;
    this.lastError = null;
    this.bindTransportReaders(transport, generation);

    try {
      await this.call(
        "initialize",
        {
          clientInfo: {
            name: "codexhook-streamdock",
            version: "0.2.0"
          },
          capabilities: { experimentalApi: true }
        },
        REQUEST_TIMEOUT_SECONDS,
        false
      );
      this.notify("initialized", null, false);
    } catch (error) {
      this.lastError = `initialize failed: ${error.message || error}`;
      log("Codex app-server initialize failed", { source: this.label, error: String(error.message || error) });
      this.stop();
      this.retryAfter = monotonicSeconds() + APP_SERVER_RETRY_SECONDS;
      return false;
    }

    log("Codex app-server ready", {
      source: this.label,
      generation,
      transport: transport.description
    });
    return true;
  }

  async openTransport() {
    throw new Error("not implemented");
  }

  bindTransportReaders(transport, generation) {
    const stdoutReader = readline.createInterface({ input: transport.stdout });
    stdoutReader.on("line", (line) => this.handleStdoutLine(line, generation));
    stdoutReader.on("close", () => this.handleTransportExit(generation));

    if (transport.stderr) {
      const stderrReader = readline.createInterface({ input: transport.stderr });
      stderrReader.on("line", (line) => {
        if (line) {
          log("Codex app-server stderr", { source: this.label, generation, line });
        }
      });
    }
  }

  handleStdoutLine(rawLine, _generation) {
    const line = String(rawLine || "").trim();
    if (!line) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (_error) {
      log("Dropped invalid app-server stdout line", { source: this.label, line });
      return;
    }

    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
      return;
    }

    if (message && message.method) {
      this.notifications.push(message);
      return;
    }

    log("Dropped unknown app-server message", { source: this.label, message });
  }

  handleTransportExit(generation) {
    if (generation !== this.generation) {
      return;
    }

    this.notifications.push({
      method: "__app_server_exited__",
      params: { generation }
    });

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ error: { message: "app-server stopped" } });
    }
    this.pending.clear();
  }

  async call(method, params = null, timeoutSeconds = REQUEST_TIMEOUT_SECONDS, ensure = true) {
    if (ensure && !(await this.ensureStarted())) {
      throw new Error(this.lastError || APP_SERVER_UNAVAILABLE);
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      method
    };
    if (params !== null && params !== undefined) {
      payload.params = params;
    }

    const responsePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ error: { message: `timeout waiting for ${method}` } });
      }, timeoutSeconds * 1000);
      this.pending.set(requestId, { method, resolve, timer });
    });

    try {
      this.send(payload);
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
      }
      throw error;
    }

    const response = await responsePromise;
    if (response.error) {
      throw new Error(response.error.message || `${method} failed`);
    }

    return response.result || {};
  }

  notify(method, params = null, ensure = true) {
    if (ensure && !this.isRunning()) {
      throw new Error(this.lastError || APP_SERVER_UNAVAILABLE);
    }

    const payload = {
      jsonrpc: "2.0",
      method
    };
    if (params !== null && params !== undefined) {
      payload.params = params;
    }

    this.send(payload);
  }

  send(payload) {
    const transport = this.transport;
    if (!transport || !transport.isRunning()) {
      throw new Error(APP_SERVER_UNAVAILABLE);
    }

    transport.writeLine(`${JSON.stringify(payload)}\n`);
  }

  stop() {
    const transport = this.transport;
    this.transport = null;

    if (transport) {
      try {
        transport.stop();
      } catch (_error) {
        // Best effort shutdown.
      }
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ error: { message: "app-server stopped" } });
    }
    this.pending.clear();
  }
}

class LocalAppServerClient extends JsonRpcAppServerClient {
  constructor() {
    super("local");
  }

  async openTransport() {
    const child = spawn("cmd.exe", ["/c", "codex.cmd", "app-server", "--stdio"], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("codex app-server spawn timeout"));
        }
      }, 3000);

      child.once("spawn", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
    });

    return {
      description: `pid=${child.pid}`,
      stdout: child.stdout,
      stderr: child.stderr,
      writeLine(line) {
        if (!child.stdin || child.stdin.destroyed) {
          throw new Error(APP_SERVER_UNAVAILABLE);
        }
        child.stdin.write(line, "utf8");
      },
      isRunning() {
        return child.exitCode === null && !child.killed;
      },
      stop() {
        if (child.exitCode === null && !child.killed) {
          child.kill();
        }
      }
    };
  }
}

class SshAppServerClient extends JsonRpcAppServerClient {
  constructor(connection) {
    super(connection.sourceLabel);
    this.connection = connection;
  }

  async openTransport() {
    const connection = this.connection;
    if (!connection.sshHost) {
      throw new Error("SSH 配置不完整：需要主机");
    }
    if (!connection.sshUsername) {
      throw new Error("SSH 配置不完整：需要用户名");
    }
    if (connection.sshAuthType === "key" && !connection.sshKeyPath) {
      throw new Error("SSH 配置不完整：需要私钥路径");
    }
    if (connection.sshAuthType !== "key" && connection.sshPassword === null) {
      throw new Error("SSH 配置不完整：需要密码");
    }

    const client = new SshClient();
    const connectOptions = {
      host: connection.sshHost,
      port: connection.sshPort,
      username: connection.sshUsername,
      readyTimeout: REQUEST_TIMEOUT_SECONDS * 1000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3
    };

    if (connection.sshAuthType === "key") {
      connectOptions.privateKey = fs.readFileSync(connection.sshKeyPath);
      if (connection.sshKeyPassphrase) {
        connectOptions.passphrase = connection.sshKeyPassphrase;
      }
    } else {
      connectOptions.password = connection.sshPassword || "";
    }

    await new Promise((resolve, reject) => {
      client.once("ready", resolve);
      client.once("error", reject);
      client.connect(connectOptions);
    });

    const command = buildRemoteAppServerCommand(connection.remoteCodexCommand);
    const channel = await new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
      });
    });

    let closed = false;
    channel.once("close", () => {
      closed = true;
      client.end();
    });
    client.once("close", () => {
      closed = true;
    });

    return {
      description: connection.sourceLabel,
      stdout: channel,
      stderr: channel.stderr,
      writeLine(line) {
        if (closed || channel.destroyed) {
          throw new Error(APP_SERVER_UNAVAILABLE);
        }
        channel.write(line, "utf8");
      },
      isRunning() {
        return !closed && !channel.destroyed;
      },
      stop() {
        closed = true;
        try {
          channel.close();
        } catch (_error) {
          // Best effort shutdown.
        }
        client.end();
      }
    };
  }
}

const buttonImageCache = new Map();

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function charWeight(char) {
  if (char === " ") {
    return 0.45;
  }

  return char.charCodeAt(0) > 255 ? 1.0 : 0.58;
}

function textWeight(text) {
  return Array.from(String(text || "")).reduce((sum, char) => sum + charWeight(char), 0);
}

function truncateApprox(text, maxUnits) {
  const chars = Array.from(String(text || ""));
  if (textWeight(chars.join("")) <= maxUnits) {
    return chars.join("");
  }

  let out = "";
  for (const char of chars) {
    if (textWeight(`${out}${char}…`) > maxUnits) {
      return `${out}…`;
    }
    out += char;
  }

  return out || "…";
}

function wrapApprox(text, fontSize, maxWidth, maxLines) {
  const maxUnits = Math.max(maxWidth / Math.max(fontSize, 1), 1);
  const lines = [];
  const paragraphs = String(text || "").split(/\r?\n/);

  for (const paragraph of paragraphs.length ? paragraphs : [""]) {
    let current = "";
    for (const char of Array.from(paragraph)) {
      const candidate = `${current}${char}`;
      if (current && textWeight(candidate) > maxUnits) {
        lines.push(current);
        current = char;
        if (lines.length === maxLines) {
          lines[lines.length - 1] = truncateApprox(lines[lines.length - 1], maxUnits);
          return lines;
        }
      } else {
        current = candidate;
      }
    }

    if (current || lines.length === 0) {
      lines.push(current);
      if (lines.length === maxLines) {
        lines[lines.length - 1] = truncateApprox(lines[lines.length - 1], maxUnits);
        return lines;
      }
    }
  }

  return lines.slice(0, maxLines);
}

function textBlockSvg(text, box, options) {
  const [left, top, right, bottom] = box;
  const width = right - left;
  const height = bottom - top;
  const maxLines = options.maxLines || 1;
  let selectedSize = options.minFontSize || options.fontSize;
  let selectedLines = wrapApprox(text, selectedSize, width, maxLines);

  for (let size = options.fontSize; size >= (options.minFontSize || options.fontSize); size -= 1) {
    const lines = wrapApprox(text, size, width, maxLines);
    const lineHeight = Math.max(size, Math.ceil(size * 1.05)) + 3;
    if (lineHeight * lines.length <= height) {
      selectedSize = size;
      selectedLines = lines;
      break;
    }
  }

  const lineHeight = Math.max(selectedSize, Math.ceil(selectedSize * 1.05)) + 3;
  const totalHeight = lineHeight * selectedLines.length;
  let y = top + Math.max((height - totalHeight) / 2, 0) + selectedSize;
  const x = left + width / 2;
  const weight = options.bold ? "700" : "500";

  return selectedLines
    .map((line) => {
      const escaped = escapeXml(line);
      const node = `<text x="${x}" y="${y}" text-anchor="middle" xml:space="preserve" fill="${options.fill}" font-family="Microsoft YaHei, SimHei, Segoe UI, Arial, sans-serif" font-size="${selectedSize}" font-weight="${weight}">${escaped}</text>`;
      y += lineHeight;
      return node;
    })
    .join("");
}

function baseSvg(title, bodySvg) {
  const titleSvg = textBlockSvg(
    title || BUTTON_DEFAULT_TITLE,
    [BUTTON_PADDING_X, 4, BUTTON_IMAGE_SIZE - BUTTON_PADDING_X, BUTTON_TITLE_AREA_HEIGHT - 4],
    {
      fontSize: 18,
      minFontSize: 10,
      maxLines: 2,
      fill: BUTTON_TITLE_FG
    }
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BUTTON_IMAGE_SIZE}" height="${BUTTON_IMAGE_SIZE}" viewBox="0 0 ${BUTTON_IMAGE_SIZE} ${BUTTON_IMAGE_SIZE}">`,
    `<rect width="${BUTTON_IMAGE_SIZE}" height="${BUTTON_IMAGE_SIZE}" fill="${BUTTON_BG}"/>`,
    `<line x1="${BUTTON_PADDING_X}" y1="${BUTTON_TITLE_AREA_HEIGHT}" x2="${BUTTON_IMAGE_SIZE - BUTTON_PADDING_X}" y2="${BUTTON_TITLE_AREA_HEIGHT}" stroke="${BUTTON_DIVIDER}" stroke-width="1"/>`,
    titleSvg,
    bodySvg,
    "</svg>"
  ].join("");
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function robotSvg(frame, variant = "running") {
  const frames = variant === "idle" ? IDLE_ANIMATION_FRAMES : RUNNING_ANIMATION_FRAMES;
  const bobScale = variant === "idle" ? 2 : 4;
  const bob = Math.round(Math.sin((frame / frames) * Math.PI * 2) * bobScale);
  const cx = 72;
  const cy = 102 + bob;
  const soft = BUTTON_TITLE_FG;
  const accent = "#ffe87c";
  const blue = variant === "idle" ? "#5caad2" : "#78d2ff";
  const bodyFill = variant === "idle" ? "#f5f5f5" : "#ffffff";
  const shadowY = variant === "idle" ? 128 : 113;
  const shadowWidth = variant === "idle" ? 34 + Math.abs(bob) : 32 + Math.abs(bob) * 2;
  const bulbFill = variant === "running"
    ? (frame % 2 === 0 ? accent : soft)
    : ([0, 1, 6, 7].includes(frame % IDLE_ANIMATION_FRAMES) ? accent : soft);
  const eyeShift = variant === "running" ? [-2, 0, 2, 1, 0, -1, -2, 0][frame % RUNNING_ANIMATION_FRAMES] : 0;
  const eyes = variant === "idle"
    ? `<path d="M57 ${cy - 3} Q62 ${cy + 5} 67 ${cy - 3}" fill="none" stroke="${blue}" stroke-width="3" stroke-linecap="round"/><path d="M77 ${cy - 3} Q82 ${cy + 5} 87 ${cy - 3}" fill="none" stroke="${blue}" stroke-width="3" stroke-linecap="round"/>`
    : `<circle cx="${58 + eyeShift}" cy="${cy - 2}" r="4.5" fill="${blue}"/><circle cx="${86 + eyeShift}" cy="${cy - 2}" r="4.5" fill="${blue}"/>`;

  return [
    `<ellipse cx="${cx}" cy="${shadowY}" rx="${shadowWidth}" ry="4" fill="#181818"/>`,
    `<line x1="${cx}" y1="${cy - 23}" x2="${cx}" y2="${cy - 34}" stroke="${soft}" stroke-width="3" stroke-linecap="round"/>`,
    `<circle cx="${cx}" cy="${cy - 38}" r="5" fill="${bulbFill}"/>`,
    `<rect x="${cx - 36}" y="${cy - 10}" width="9" height="20" rx="4" fill="${soft}"/>`,
    `<rect x="${cx + 27}" y="${cy - 10}" width="9" height="20" rx="4" fill="${soft}"/>`,
    `<rect x="${cx - 26}" y="${cy - 22}" width="52" height="44" rx="13" fill="${bodyFill}"/>`,
    `<rect x="${cx - 21}" y="${cy - 15}" width="42" height="30" rx="10" fill="#0c0c0c"/>`,
    eyes,
    `<path d="M62 ${cy + 9} Q72 ${cy + 18} 82 ${cy + 9}" fill="none" stroke="${accent}" stroke-width="${variant === "idle" ? 2 : 3}" stroke-linecap="round"/>`
  ].join("");
}

function renderRunningButtonImage(title, frame) {
  return svgDataUrl(baseSvg(title, robotSvg(frame % RUNNING_ANIMATION_FRAMES, "running")));
}

function renderIdleButtonImage(title, frame) {
  const current = frame % IDLE_ANIMATION_FRAMES;
  const brightness = [100, 140, 190, 230, 210, 170, 125, 95][current];
  const x = 98 + Math.round(Math.sin((current / IDLE_ANIMATION_FRAMES) * Math.PI * 2) * 2);
  const y = 58 - Math.round(current * 0.8);
  const zSvg = [
    `<text x="${x}" y="${y + 14}" fill="rgb(${brightness},${brightness},${brightness})" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700">Z</text>`,
    `<text x="${x + 15}" y="${y + 1}" fill="rgb(${Math.max(brightness - 70, 70)},${Math.max(brightness - 70, 70)},${Math.max(brightness - 70, 70)})" font-family="Segoe UI, Arial, sans-serif" font-size="11" font-weight="700">z</text>`
  ].join("");
  return svgDataUrl(baseSvg(title, `${zSvg}${robotSvg(current, "idle")}`));
}

function renderSyncButtonImage(title, frame) {
  const current = frame % SYNC_ANIMATION_FRAMES;
  const angle = (current / SYNC_ANIMATION_FRAMES) * Math.PI * 2;
  const cx = 72;
  const cy = 98;
  const radius = 34;
  const endX = cx + Math.round(Math.cos(angle) * radius);
  const endY = cy + Math.round(Math.sin(angle) * radius);
  const pulseRadius = 5 + (current % 4) * 2;
  const body = [
    `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#365a6e" stroke-width="3"/>`,
    `<circle cx="${cx}" cy="${cy}" r="22" fill="none" stroke="#263e4a" stroke-width="2"/>`,
    `<line x1="${cx}" y1="${cy}" x2="${endX}" y2="${endY}" stroke="#78d2ff" stroke-width="4" stroke-linecap="round"/>`,
    `<circle cx="${endX}" cy="${endY}" r="4" fill="#78d2ff"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${pulseRadius}" fill="none" stroke="${BUTTON_STATUS_FG}" stroke-width="2"/>`,
    `<circle cx="${cx}" cy="${cy}" r="3" fill="${BUTTON_STATUS_FG}"/>`
  ].join("");
  return svgDataUrl(baseSvg(title, body));
}

function renderApprovalButtonImage(title, frame) {
  const current = frame % APPROVAL_ANIMATION_FRAMES;
  const cx = 72;
  const cy = 102 + ([1, 2, 5, 6].includes(current) ? -2 : 0);
  const alert = current % 2 === 0 ? "#ffbe52" : "#fff5aa";
  const handY = cy - 34 - ([1, 2, 3].includes(current) ? 4 : 0);
  const body = [
    `<ellipse cx="${cx}" cy="129" rx="34" ry="4" fill="#161616"/>`,
    `<line x1="${cx}" y1="${cy - 19}" x2="${cx}" y2="${cy - 29}" stroke="${BUTTON_TITLE_FG}" stroke-width="3" stroke-linecap="round"/>`,
    `<circle cx="${cx}" cy="${cy - 33}" r="5" fill="${alert}"/>`,
    `<rect x="${cx - 24}" y="${cy - 18}" width="48" height="40" rx="12" fill="${BUTTON_STATUS_FG}"/>`,
    `<rect x="${cx - 19}" y="${cy - 12}" width="38" height="24" rx="9" fill="#0c0c0c"/>`,
    `<circle cx="${cx - 8}" cy="${cy}" r="4" fill="#78d2ff"/><circle cx="${cx + 8}" cy="${cy}" r="4" fill="#78d2ff"/>`,
    `<path d="M64 ${cy + 9} Q72 ${cy + 16} 80 ${cy + 9}" fill="none" stroke="#ffe87c" stroke-width="2" stroke-linecap="round"/>`,
    `<path d="M96 ${cy - 6} L111 ${handY}" stroke="${BUTTON_STATUS_FG}" stroke-width="5" stroke-linecap="round"/>`,
    `<circle cx="112" cy="${handY - 1}" r="7" fill="${BUTTON_STATUS_FG}"/>`,
    `<path d="M48 ${cy - 3} L36 ${cy + 8}" stroke="${BUTTON_STATUS_FG}" stroke-width="5" stroke-linecap="round"/>`,
    `<circle cx="43" cy="66" r="10" fill="${alert}"/>`,
    `<text x="43" y="72" text-anchor="middle" fill="#000000" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700">!</text>`
  ].join("");
  return svgDataUrl(baseSvg(title, body));
}

function renderInputButtonImage(title, frame) {
  const current = frame % INPUT_ANIMATION_FRAMES;
  const cx = 72;
  const cy = 102;
  const cursor = current % 2 === 0 ? BUTTON_STATUS_FG : "#414141";
  const eyeShift = [2, 3].includes(current) ? -1 : [6, 7].includes(current) ? 1 : 0;
  const dots = [33, 42, 51].map((x, index) => {
    const active = [0, 1, 2].includes((current + index * 2) % INPUT_ANIMATION_FRAMES);
    return `<circle cx="${x}" cy="76" r="2.5" fill="${active ? BUTTON_STATUS_FG : "#585858"}"/>`;
  }).join("");
  const body = [
    `<ellipse cx="${cx}" cy="129" rx="34" ry="4" fill="#161616"/>`,
    `<line x1="${cx}" y1="${cy - 21}" x2="${cx}" y2="${cy - 32}" stroke="${BUTTON_TITLE_FG}" stroke-width="3" stroke-linecap="round"/>`,
    `<circle cx="${cx}" cy="${cy - 36}" r="5" fill="${BUTTON_TITLE_FG}"/>`,
    `<rect x="${cx - 25}" y="${cy - 20}" width="50" height="42" rx="13" fill="${BUTTON_STATUS_FG}"/>`,
    `<rect x="${cx - 20}" y="${cy - 14}" width="40" height="28" rx="9" fill="#0c0c0c"/>`,
    `<circle cx="${cx - 9 + eyeShift}" cy="${cy - 1}" r="4" fill="#78d2ff"/><circle cx="${cx + 9 + eyeShift}" cy="${cy - 1}" r="4" fill="#78d2ff"/>`,
    `<path d="M64 ${cy + 9} Q72 ${cy + 16} 80 ${cy + 9}" fill="none" stroke="#ffe87c" stroke-width="2" stroke-linecap="round"/>`,
    `<rect x="23" y="61" width="38" height="28" rx="8" fill="#1c1c1c" stroke="${BUTTON_TITLE_FG}" stroke-width="2"/>`,
    dots,
    `<rect x="88" y="64" width="33" height="24" rx="4" fill="#141414" stroke="${BUTTON_TITLE_FG}" stroke-width="2"/>`,
    `<line x1="114" y1="68" x2="114" y2="84" stroke="${cursor}" stroke-width="3" stroke-linecap="round"/>`
  ].join("");
  return svgDataUrl(baseSvg(title, body));
}

function renderStaticButtonImage(title, status) {
  const statusSvg = textBlockSvg(
    status,
    [BUTTON_PADDING_X, BUTTON_TITLE_AREA_HEIGHT + 4, BUTTON_IMAGE_SIZE - BUTTON_PADDING_X, BUTTON_IMAGE_SIZE - 6],
    {
      fontSize: 40,
      minFontSize: 20,
      maxLines: 2,
      fill: BUTTON_STATUS_FG,
      bold: true
    }
  );
  return svgDataUrl(baseSvg(title, statusSvg));
}

function renderButtonImage(title, status, frame = null) {
  const cacheKey = stableStringify({ frame, status, title: title || "" });
  if (buttonImageCache.has(cacheKey)) {
    return buttonImageCache.get(cacheKey);
  }

  let image;
  if (frame !== null && ANIMATED_STATUS_LABELS.has(status)) {
    image = renderRunningButtonImage(title, frame);
  } else if (frame !== null && status === STATUS_IDLE) {
    image = renderIdleButtonImage(title, frame);
  } else if (frame !== null && status === STATUS_SYNC) {
    image = renderSyncButtonImage(title, frame);
  } else if (frame !== null && status === STATUS_WAIT_APPROVAL) {
    image = renderApprovalButtonImage(title, frame);
  } else if (frame !== null && status === STATUS_WAIT_INPUT) {
    image = renderInputButtonImage(title, frame);
  } else {
    image = renderStaticButtonImage(title, status);
  }

  if (buttonImageCache.size >= BUTTON_CACHE_LIMIT) {
    buttonImageCache.clear();
  }
  buttonImageCache.set(cacheKey, image);
  return image;
}

class BackendRuntime {
  constructor(sendToStreamDock) {
    this.sendToStreamDock = sendToStreamDock;
    this.actions = new Map();
    this.watches = new Map();
    this.clients = new Map();
    this.pendingPiUpdates = new Set();
    this.lastCodexFocusAt = 0.0;
    this.workerBusy = false;
    this.stopped = false;
    this.workerTimer = setInterval(() => this.workerLoop(), WORKER_TICK_SECONDS * 1000);
    this.renderTimer = setInterval(() => this.renderAll(), RENDER_TICK_SECONDS * 1000);
  }

  shutdown() {
    this.stopped = true;
    clearInterval(this.workerTimer);
    clearInterval(this.renderTimer);
    for (const client of this.clients.values()) {
      client.stop();
    }
    this.clients.clear();
  }

  clientForConnection(connection) {
    const clientKey = connection.clientKey;
    const existing = this.clients.get(clientKey);
    if (existing) {
      return existing;
    }

    const client = connection.mode === "ssh"
      ? new SshAppServerClient(connection)
      : new LocalAppServerClient();
    this.clients.set(clientKey, client);
    return client;
  }

  watchForState(state) {
    const watchKey = state.watchKey();
    return watchKey ? this.watches.get(watchKey) || null : null;
  }

  handleInit(pluginUUID, registerEvent, info) {
    log("CodexHook Node backend ready", {
      node: process.version,
      pluginUUID,
      registerEvent,
      language: info?.application?.language || null,
      root: rootDir
    });
  }

  handleStreamDockEvent(payload) {
    const event = payload.event;
    const context = normalizeText(payload.context);
    const action = normalizeText(payload.action);
    const eventPayload = payload.payload;

    if (event === "willAppear" && context) {
      const state = this.actions.get(context) || new ActionState(context);
      state.visible = true;
      state.action = action || state.action;
      state.applySettings(this.extractSettings(payload));
      this.actions.set(context, state);
      this.pendingPiUpdates.add(context);
      this.renderContext(context);
      return;
    }

    if ((event === "willDisappear" || event === "deleteAction") && context) {
      this.actions.delete(context);
      this.pendingPiUpdates.delete(context);
      return;
    }

    if (event === "didReceiveSettings" && context) {
      const state = this.actions.get(context) || new ActionState(context);
      state.action = action || state.action;
      state.applySettings(this.extractSettings(payload));
      this.actions.set(context, state);
      this.pendingPiUpdates.add(context);
      this.renderContext(context);
      return;
    }

    if (event === "propertyInspectorDidAppear" && context) {
      const state = this.actions.get(context) || new ActionState(context);
      state.action = action || state.action;
      state.propertyInspectorVisible = true;
      state.lastPropertyInspectorPayload = "";
      state.applySettings(this.extractSettings(payload));
      this.actions.set(context, state);
      this.pendingPiUpdates.add(context);
      return;
    }

    if (event === "propertyInspectorDidDisappear" && context) {
      const state = this.actions.get(context);
      if (state) {
        state.propertyInspectorVisible = false;
        state.lastPropertyInspectorPayload = "";
      }
      this.pendingPiUpdates.delete(context);
      return;
    }

    if (event === "sendToPlugin" && context && eventPayload && typeof eventPayload === "object") {
      const targetContext = normalizeText(eventPayload.actionContext) || context;
      this.handlePropertyInspectorMessage(targetContext, eventPayload, action);
      return;
    }

    if (event === "keyDown" && context) {
      this.focusCodexWindow();
      return;
    }

    if (event === "keyUp" && context) {
      this.focusCodexWindow();
      const state = this.actions.get(context);
      if (state && state.targetThreadId) {
        const watch = this.watchForState(state);
        if (watch) {
          watch.lastRefreshAt = 0.0;
        }
        this.pendingPiUpdates.add(context);
      }
      return;
    }

    if (["didReceiveGlobalSettings", "titleParametersDidChange"].includes(event)) {
      return;
    }

    log("Unhandled Stream Dock event", { event, context, action });
  }

  extractSettings(payload) {
    const data = payload.payload;
    if (data && typeof data === "object" && data.settings && typeof data.settings === "object") {
      return data.settings;
    }
    return {};
  }

  handlePropertyInspectorMessage(context, payload, action) {
    const command = normalizeText(payload.command);
    const state = this.actions.get(context) || new ActionState(context);
    state.action = action || state.action;
    this.actions.set(context, state);

    if (["select_thread", "update_settings"].includes(command)) {
      if (payload.settings && typeof payload.settings === "object") {
        state.applySettings(payload.settings);
      }
      this.pendingPiUpdates.add(context);
    } else if (command === "clear_thread") {
      if (payload.settings && typeof payload.settings === "object") {
        state.applySettings(payload.settings);
      } else {
        state.applySettings({
          buttonTitle: "",
          connectionMode: "local",
          remoteCodexCommand: "",
          sshAuthType: "password",
          sshHost: "",
          sshKeyPassphrase: "",
          sshKeyPath: "",
          sshPassword: "",
          sshPort: "22",
          sshUsername: "",
          targetProjectKey: "",
          targetProjectName: "",
          targetProjectPath: "",
          targetThreadCwd: "",
          targetThreadId: "",
          targetThreadName: "",
          targetThreadPreview: ""
        });
      }
      this.pendingPiUpdates.add(context);
    } else if (["pi_ready", "refresh_thread", "refresh_threads"].includes(command)) {
      state.lastPropertyInspectorPayload = "";
      if (["refresh_thread", "refresh_threads"].includes(command) && state.targetThreadId) {
        const watch = this.watchForState(state);
        if (watch) {
          watch.lastRefreshAt = 0.0;
        }
      }
      this.pendingPiUpdates.add(context);
    } else {
      this.pendingPiUpdates.add(context);
    }

    this.renderContext(context);
  }

  focusCodexWindow() {
    const now = monotonicSeconds();
    if (now - this.lastCodexFocusAt < CODEX_FOCUS_COOLDOWN_SECONDS) {
      return;
    }

    this.lastCodexFocusAt = now;
    if (process.platform !== "win32" || !fs.existsSync(focusScript)) {
      log("Codex window focus unavailable", { platform: process.platform, focusScript });
      return;
    }

    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      focusScript
    ], {
      cwd: rootDir,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });

    child.stderr.on("data", (chunk) => {
      const line = String(chunk || "").trim();
      if (line) {
        log("Codex window focus stderr", line);
      }
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        log("Codex window focus failed", { code });
      }
    });
    child.on("error", (error) => {
      log("Codex window focus error", error.message);
    });
  }

  async workerLoop() {
    if (this.stopped || this.workerBusy) {
      return;
    }

    this.workerBusy = true;
    try {
      this.drainNotifications();
      this.reconcileWatches();
      await this.refreshWatches();
      this.flushPropertyInspectorUpdates();
    } catch (error) {
      log("Worker loop error", {
        error: error.message || String(error),
        stack: error.stack || null
      });
    } finally {
      this.workerBusy = false;
    }
  }

  logWatchStateChange(watch, source, extra = null) {
    const rawStatus = watch.thread && typeof watch.thread === "object" ? watch.thread.status : null;
    const [stateCode, stateLabel] = statusLineForWatch(watch);
    const payload = {
      source,
      connection: watch.connection.sourceLabel,
      state: stateCode,
      label: stateLabel,
      raw_status_type: rawStatus && rawStatus.type,
      active_flags: rawStatus && rawStatus.activeFlags,
      subscribed: watch.subscribed,
      error_kind: watch.errorKind,
      error: shorten(watch.errorMessage, 160),
      latest_turn_status: watch.latestTurnStatus,
      latest_turn_id: watch.latestTurnId,
      latest_turn_started_at: watch.latestTurnStartedAt,
      latest_turn_completed_at: watch.latestTurnCompletedAt,
      ...(extra || {})
    };
    const signature = stableStringify(payload);
    if (signature === watch.lastDebugSignature) {
      return;
    }

    watch.lastDebugSignature = signature;
    log("Watch state changed", { thread_id: watch.threadId, ...payload });
  }

  drainNotifications() {
    for (const [clientKey, client] of this.clients.entries()) {
      while (client.notifications.length > 0) {
        const message = client.notifications.shift();
        const method = message.method;
        const params = message.params || {};

        if (method === "__app_server_exited__") {
          if (params.generation !== client.generation) {
            continue;
          }
          for (const watch of this.watches.values()) {
            if (watch.connection.clientKey !== clientKey) {
              continue;
            }
            watch.subscribed = false;
            watch.appServerGeneration = 0;
            watch.setError("offline", client.lastError || "app-server exited");
            this.logWatchStateChange(watch, "__app_server_exited__");
            for (const context of watch.contexts) {
              this.pendingPiUpdates.add(context);
            }
          }
          log("Codex app-server exited", { source: client.label });
          continue;
        }

        if (method === "thread/status/changed") {
          const threadId = normalizeText(params.threadId);
          if (!threadId) {
            continue;
          }
          const watch = this.watches.get(`${clientKey}|thread:${threadId}`);
          if (watch) {
            watch.subscribed = true;
            watch.appServerGeneration = client.generation;
            watch.applyStatus(params.status);
            watch.lastRefreshAt = monotonicSeconds();
            this.logWatchStateChange(watch, method);
            for (const context of watch.contexts) {
              this.pendingPiUpdates.add(context);
            }
          }
          continue;
        }

        if (method === "thread/tokenUsage/updated") {
          const threadId = normalizeText(params.threadId);
          if (!threadId) {
            continue;
          }
          const watch = this.watches.get(`${clientKey}|thread:${threadId}`);
          if (watch) {
            watch.noteTokenActivity(params.turnId);
            this.logWatchStateChange(watch, method);
            for (const context of watch.contexts) {
              this.pendingPiUpdates.add(context);
            }
          }
          continue;
        }

        if (["turn/started", "turn/completed"].includes(method)) {
          const threadId = normalizeText(params.threadId);
          if (!threadId) {
            continue;
          }
          const watch = this.watches.get(`${clientKey}|thread:${threadId}`);
          if (watch) {
            if (method === "turn/started") {
              watch.noteTurnStarted(params.turnId);
            } else {
              watch.noteTurnCompleted(params.turnId);
            }
            watch.lastRefreshAt = 0.0;
            this.logWatchStateChange(watch, method);
            for (const context of watch.contexts) {
              this.pendingPiUpdates.add(context);
            }
          }
          continue;
        }

        if (method === "thread/name/updated") {
          const threadId = normalizeText(params.threadId);
          if (!threadId) {
            continue;
          }
          const watch = this.watches.get(`${clientKey}|thread:${threadId}`);
          if (watch && watch.thread) {
            watch.thread.name = params.name;
            for (const context of watch.contexts) {
              this.pendingPiUpdates.add(context);
            }
          }
          continue;
        }

        if (["thread/deleted", "thread/closed"].includes(method)) {
          const threadId = normalizeText(params.threadId);
          if (!threadId) {
            continue;
          }
          const watch = this.watches.get(`${clientKey}|thread:${threadId}`);
          if (watch) {
            watch.subscribed = false;
            watch.setError("missing", method);
            watch.lastRefreshAt = monotonicSeconds();
            this.logWatchStateChange(watch, method);
            for (const context of watch.contexts) {
              this.pendingPiUpdates.add(context);
            }
          }
        }
      }
    }
  }

  reconcileWatches() {
    const desiredContexts = new Map();
    const desiredMeta = new Map();

    for (const [context, state] of this.actions.entries()) {
      if (!state.targetThreadId) {
        continue;
      }
      const connection = state.connectionConfig();
      const watchKey = watchKeyFor(connection, state.targetThreadId);
      if (!watchKey) {
        continue;
      }
      if (!desiredContexts.has(watchKey)) {
        desiredContexts.set(watchKey, new Set());
      }
      desiredContexts.get(watchKey).add(context);
      desiredMeta.set(watchKey, { threadId: state.targetThreadId, connection });
    }

    for (const watchKey of Array.from(this.watches.keys())) {
      if (!desiredContexts.has(watchKey)) {
        const watch = this.watches.get(watchKey);
        this.watches.delete(watchKey);
        this.unsubscribeWatch(watch);
      }
    }

    for (const [watchKey, contexts] of desiredContexts.entries()) {
      const meta = desiredMeta.get(watchKey);
      const watch = this.watches.get(watchKey);
      if (watch) {
        watch.contexts = contexts;
        watch.connection = meta.connection;
      } else {
        this.watches.set(watchKey, new ThreadWatch(watchKey, meta.threadId, meta.connection, contexts));
      }
    }

    const activeClientKeys = new Set(Array.from(this.watches.values()).map((watch) => watch.connection.clientKey));
    for (const [clientKey, client] of Array.from(this.clients.entries())) {
      if (!activeClientKeys.has(clientKey)) {
        this.clients.delete(clientKey);
        client.stop();
      }
    }
  }

  async unsubscribeWatch(watch) {
    if (!watch) {
      return;
    }
    const client = this.clients.get(watch.connection.clientKey);
    if (!client || !client.isRunning()) {
      return;
    }

    try {
      await client.call("thread/unsubscribe", { threadId: watch.threadId }, 5.0);
    } catch (error) {
      log("Thread unsubscribe failed", {
        thread_id: watch.threadId,
        connection: watch.connection.sourceLabel,
        error: error.message || String(error)
      });
    }
  }

  async refreshWatches() {
    const grouped = new Map();
    for (const [watchKey, watch] of this.watches.entries()) {
      const clientKey = watch.connection.clientKey;
      if (!grouped.has(clientKey)) {
        grouped.set(clientKey, { connection: watch.connection, watchKeys: [] });
      }
      grouped.get(clientKey).watchKeys.push(watchKey);
    }

    if (grouped.size === 0) {
      return;
    }

    const now = monotonicSeconds();
    for (const { connection, watchKeys } of grouped.values()) {
      const client = this.clientForConnection(connection);
      if (!(await client.ensureStarted())) {
        for (const watchKey of watchKeys) {
          const watch = this.watches.get(watchKey);
          if (watch) {
            watch.subscribed = false;
            watch.setError("offline", client.lastError || APP_SERVER_UNAVAILABLE);
            this.logWatchStateChange(watch, "app-server");
            for (const context of watch.contexts) {
              this.pendingPiUpdates.add(context);
            }
          }
        }
        continue;
      }

      const generation = client.generation;
      for (const watchKey of watchKeys) {
        const watch = this.watches.get(watchKey);
        if (!watch) {
          continue;
        }

        let needsResume;
        if (watch.errorKind === "missing") {
          needsResume = now - watch.lastRefreshAt >= MISSING_THREAD_RETRY_SECONDS;
        } else if (["error", "offline"].includes(watch.errorKind)) {
          needsResume = now - watch.lastRefreshAt >= APP_SERVER_RETRY_SECONDS;
        } else {
          needsResume = !watch.subscribed || watch.appServerGeneration !== generation;
        }
        const needsRead = watch.subscribed && now - watch.lastRefreshAt >= WATCH_REFRESH_SECONDS;

        if (needsResume) {
          await this.resumeWatch(watchKey, client, generation);
        } else if (needsRead) {
          await this.readWatch(watchKey, client);
        }
      }
    }
  }

  async resumeWatch(watchKey, client, generation) {
    const watch = this.watches.get(watchKey);
    if (!watch) {
      return;
    }

    const threadId = watch.threadId;
    const connection = watch.connection;
    let thread;
    let latestTurn;
    let turnFetchFailed;

    try {
      const result = await client.call("thread/resume", { threadId });
      thread = compactThread(result.thread);
      [latestTurn, turnFetchFailed] = await this.fetchLatestTurn(client, threadId, connection);
    } catch (error) {
      const message = error.message || String(error);
      const kind = message.includes("no rollout found") ? "missing" : "error";
      const current = this.watches.get(watchKey);
      if (current) {
        current.subscribed = false;
        current.appServerGeneration = generation;
        current.lastRefreshAt = monotonicSeconds();
        current.setError(kind, message);
        this.logWatchStateChange(current, "thread/resume");
        for (const context of current.contexts) {
          this.pendingPiUpdates.add(context);
        }
      }
      log("Thread resume failed", { thread_id: threadId, connection: connection.sourceLabel, error: message });
      return;
    }

    const current = this.watches.get(watchKey);
    if (!current) {
      return;
    }

    current.subscribed = true;
    current.appServerGeneration = generation;
    current.lastRefreshAt = monotonicSeconds();
    current.setThread(thread);
    this.applyTurnFetchResult(current, latestTurn, turnFetchFailed);
    this.logWatchStateChange(current, "thread/resume");
    for (const context of current.contexts) {
      this.pendingPiUpdates.add(context);
    }

    if (this.shouldRestartStaleActiveClient(current)) {
      this.restartClient(connection, "turn summary timeouts while active", threadId);
    }
  }

  async readWatch(watchKey, client) {
    const watch = this.watches.get(watchKey);
    if (!watch) {
      return;
    }

    const threadId = watch.threadId;
    const connection = watch.connection;
    let thread;
    let latestTurn;
    let turnFetchFailed;

    try {
      const result = await client.call("thread/read", { threadId });
      thread = compactThread(result.thread);
      [latestTurn, turnFetchFailed] = await this.fetchLatestTurn(client, threadId, connection);
    } catch (error) {
      const message = error.message || String(error);
      const kind = message.includes("thread not loaded") || message.includes("no rollout found") ? "missing" : "error";
      const current = this.watches.get(watchKey);
      if (current) {
        current.subscribed = false;
        current.lastRefreshAt = monotonicSeconds();
        current.setError(kind, message);
        this.logWatchStateChange(current, "thread/read");
        for (const context of current.contexts) {
          this.pendingPiUpdates.add(context);
        }
      }
      log("Thread read failed", { thread_id: threadId, connection: connection.sourceLabel, error: message });
      return;
    }

    const current = this.watches.get(watchKey);
    if (!current) {
      return;
    }

    current.lastRefreshAt = monotonicSeconds();
    current.setThread(thread);
    this.applyTurnFetchResult(current, latestTurn, turnFetchFailed);
    this.logWatchStateChange(current, "thread/read");
    for (const context of current.contexts) {
      this.pendingPiUpdates.add(context);
    }

    if (this.shouldRestartStaleActiveClient(current)) {
      this.restartClient(connection, "turn summary timeouts while active", threadId);
    }
  }

  async fetchLatestTurn(client, threadId, connection) {
    try {
      const result = await client.call(
        "thread/turns/list",
        { threadId, limit: THREAD_TURN_LIST_LIMIT },
        TURN_LIST_TIMEOUT_SECONDS
      );
      const turns = result.data || [];
      if (!Array.isArray(turns) || !turns[0] || typeof turns[0] !== "object") {
        return [null, false];
      }
      return [turns[0], false];
    } catch (error) {
      log("Thread turns list failed", {
        thread_id: threadId,
        connection: connection.sourceLabel,
        error: error.message || String(error)
      });
      return [null, true];
    }
  }

  applyTurnFetchResult(watch, latestTurn, failed) {
    if (latestTurn) {
      watch.applyTurnSummary(latestTurn);
      return;
    }

    if (failed) {
      watch.noteTurnSummaryFailed();
      if (!ACTIVE_STATE_CODES.has(watch.stateCode)) {
        watch.clearTurnSummary();
      }
      return;
    }

    watch.noteTurnSummarySuccessWithoutData();
  }

  shouldRestartStaleActiveClient(watch) {
    if (watch.connection.mode !== "ssh") {
      return false;
    }
    if (watch.turnSummaryFailures < TURN_LIST_FAILURE_RESTART_THRESHOLD) {
      return false;
    }
    return ACTIVE_STATE_CODES.has(watch.stateCode);
  }

  restartClient(connection, reason, threadId = null) {
    const clientKey = connection.clientKey;
    const client = this.clients.get(clientKey);
    this.clients.delete(clientKey);

    for (const watch of this.watches.values()) {
      if (watch.connection.clientKey !== clientKey) {
        continue;
      }
      watch.subscribed = false;
      watch.appServerGeneration = 0;
      watch.lastRefreshAt = 0.0;
      watch.turnSummaryFailures = 0;
      watch.lastTurnSummaryFailedAt = 0.0;
      for (const context of watch.contexts) {
        this.pendingPiUpdates.add(context);
      }
    }

    if (client) {
      client.stop();
    }

    log("Codex app-server client restarted", {
      connection: connection.sourceLabel,
      thread_id: threadId,
      reason
    });
  }

  flushPropertyInspectorUpdates() {
    const contexts = Array.from(this.pendingPiUpdates)
      .filter((context) => this.actions.has(context) && this.actions.get(context).propertyInspectorVisible);
    this.pendingPiUpdates.clear();

    for (const context of contexts) {
      const payload = this.buildPropertyInspectorPayload(context);
      if (payload) {
        this.sendToPropertyInspector(context, payload);
      }
    }
  }

  buildPropertyInspectorPayload(context) {
    const state = this.actions.get(context);
    if (!state) {
      return null;
    }

    const connection = state.connectionConfig();
    const client = this.clients.get(connection.clientKey);
    const watch = this.watchForState(state);
    let monitorState = "no_thread";
    let monitorLabel = STATUS_NO_THREAD;
    let threadName = null;
    let threadCwd = state.targetThreadCwd;
    const threadId = state.targetThreadId;
    const serverOnline = Boolean(client && client.isRunning());
    const serverError = client && !client.isRunning() ? client.lastError : null;

    if (watch) {
      [monitorState, monitorLabel] = statusLineForWatch(watch);
      threadName = threadTitleFromSources(watch.thread, state.targetThreadName, state.targetThreadPreview);
      threadCwd = normalizeText((watch.thread || {}).cwd) || threadCwd;
    } else if (state.targetThreadId) {
      monitorState = "syncing";
      monitorLabel = STATUS_SYNC;
      threadName = threadTitleFromSources(null, state.targetThreadName, state.targetThreadPreview);
    }

    return {
      plugin: "codexhook",
      kind: "inspectorData",
      serverOnline,
      error: serverError,
      selectedSettings: state.settings,
      monitor: {
        threadId,
        threadName,
        state: monitorState,
        label: monitorLabel,
        cwd: threadCwd,
        connection: connection.displayName
      }
    };
  }

  renderAll() {
    for (const context of this.actions.keys()) {
      this.renderContext(context);
    }
  }

  renderContext(context) {
    const state = this.actions.get(context);
    if (!state || !state.visible) {
      return;
    }

    const watch = this.watchForState(state);
    const [title, status] = buildButtonParts(state, watch);
    let frame = null;
    const now = monotonicSeconds();
    if (ANIMATED_STATUS_LABELS.has(status)) {
      frame = Math.floor(now / RUNNING_ANIMATION_FRAME_SECONDS) % RUNNING_ANIMATION_FRAMES;
    } else if (status === STATUS_IDLE) {
      frame = Math.floor(now / IDLE_ANIMATION_FRAME_SECONDS) % IDLE_ANIMATION_FRAMES;
    } else if (status === STATUS_SYNC) {
      frame = Math.floor(now / SYNC_ANIMATION_FRAME_SECONDS) % SYNC_ANIMATION_FRAMES;
    } else if (status === STATUS_WAIT_APPROVAL) {
      frame = Math.floor(now / APPROVAL_ANIMATION_FRAME_SECONDS) % APPROVAL_ANIMATION_FRAMES;
    } else if (status === STATUS_WAIT_INPUT) {
      frame = Math.floor(now / INPUT_ANIMATION_FRAME_SECONDS) % INPUT_ANIMATION_FRAMES;
    }

    const signature = stableStringify({ title, status, frame });
    if (signature === state.lastButtonSignature) {
      return;
    }
    state.lastButtonSignature = signature;

    this.sendToStreamDock({
      event: "setImage",
      context,
      payload: {
        image: renderButtonImage(title, status, frame),
        target: 0
      }
    });
    this.sendToStreamDock({
      event: "setTitle",
      context,
      payload: {
        title: "",
        target: 0
      }
    });
  }

  sendToPropertyInspector(context, payload) {
    const state = this.actions.get(context) || new ActionState(context);
    const action = state.action;
    const serialized = stableStringify(payload);
    if (serialized === state.lastPropertyInspectorPayload) {
      return;
    }
    state.lastPropertyInspectorPayload = serialized;
    this.actions.set(context, state);

    this.sendToStreamDock({
      event: "sendToPropertyInspector",
      context,
      action,
      payload
    });
  }
}

const args = parseArgs(process.argv.slice(2));
const port = args.port;
const pluginUUID = args.pluginUUID;
const registerEvent = args.registerEvent;
const info = safeJson(args.info);

if (!port || !pluginUUID || !registerEvent) {
  log("Missing Stream Dock launch arguments", process.argv);
  process.exit(1);
}

const socket = new WebSocket(`ws://127.0.0.1:${port}`);
let runtime = null;

function sendToStreamDock(payload) {
  if (socket.readyState !== WebSocket.OPEN) {
    log("Stream Dock websocket not ready", payload);
    return;
  }

  socket.send(JSON.stringify(payload), (error) => {
    if (error) {
      log("Stream Dock send failed", error.message);
    }
  });
}

function shutdown() {
  log("Shutting down CodexHook plugin");

  if (runtime) {
    runtime.shutdown();
  }

  try {
    socket.close();
  } catch (error) {
    log("Socket close failed", error.message);
  }

  setTimeout(() => process.exit(0), 250).unref();
}

socket.on("open", () => {
  log("Connected to Stream Dock websocket", {
    port,
    pluginUUID,
    registerEvent,
    node: process.version
  });
  sendToStreamDock({ event: registerEvent, uuid: pluginUUID });
  runtime = new BackendRuntime(sendToStreamDock);
  runtime.handleInit(pluginUUID, registerEvent, info || {});
});

socket.on("message", (data) => {
  const payload = safeJson(data.toString());
  if (!payload || !runtime) {
    return;
  }

  runtime.handleStreamDockEvent(payload);
});

socket.on("close", (code, reason) => {
  log("Stream Dock websocket closed", { code, reason: reason.toString() });
  shutdown();
});

socket.on("error", (error) => {
  log("Stream Dock websocket error", error.message);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
