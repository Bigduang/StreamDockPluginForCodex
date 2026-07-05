const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

const rootDir = path.resolve(__dirname, "..");
const logDir = path.join(rootDir, "logs");
const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.plugin.log`);
const defaultPython = process.platform === "win32" ? "python" : "python3";

fs.mkdirSync(logDir, { recursive: true });

function stringify(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map(stringify).join(" ")}`;
  fs.appendFileSync(logFile, `${line}\n`);
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

const args = parseArgs(process.argv.slice(2));
const port = args.port;
const pluginUUID = args.pluginUUID;
const registerEvent = args.registerEvent;
const info = safeJson(args.info);
const pythonExe = process.env.CODEXHOOK_PYTHON || defaultPython;
const backendPath = path.join(rootDir, "python", "backend.py");

if (!port || !pluginUUID || !registerEvent) {
  log("Missing Stream Dock launch arguments", process.argv);
  process.exit(1);
}

let backend = null;
let backendReady = false;
const backendQueue = [];

function queueBackendMessage(message) {
  const line = `${JSON.stringify(message)}\n`;

  if (!backend || !backend.stdin || !backend.stdin.writable || !backendReady) {
    backendQueue.push(line);
    return;
  }

  backend.stdin.write(line);
}

function flushBackendQueue() {
  if (!backend || !backend.stdin || !backend.stdin.writable || !backendReady) {
    return;
  }

  while (backendQueue.length > 0) {
    backend.stdin.write(backendQueue.shift());
  }
}

const socket = new WebSocket(`ws://127.0.0.1:${port}`);

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

function handleBackendLine(line) {
  if (!line.trim()) {
    return;
  }

  const message = safeJson(line);

  if (!message || !message.type) {
    log("Dropped backend line", line);
    return;
  }

  switch (message.type) {
    case "log":
      log("[backend]", message.message || "");
      break;
    case "set_title":
      sendToStreamDock({
        event: "setTitle",
        context: message.context,
        payload: {
          title: message.title || "",
          target: message.target ?? 0
        }
      });
      break;
    case "set_image":
      sendToStreamDock({
        event: "setImage",
        context: message.context,
        payload: {
          image: message.image || "",
          target: message.target ?? 0
        }
      });
      sendToStreamDock({
        event: "setTitle",
        context: message.context,
        payload: {
          title: "",
          target: message.target ?? 0
        }
      });
      break;
    case "show_ok":
      sendToStreamDock({
        event: "showOk",
        context: message.context
      });
      break;
    case "show_alert":
      sendToStreamDock({
        event: "showAlert",
        context: message.context
      });
      break;
    case "send":
      if (message.payload) {
        sendToStreamDock(message.payload);
      }
      break;
    default:
      log("Unknown backend message", message);
      break;
  }
}

function startBackend() {
  if (!fs.existsSync(pythonExe)) {
    log("Python executable not found", pythonExe);
  }

  backend = spawn(pythonExe, ["-u", backendPath], {
    cwd: rootDir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      CODEXHOOK_ROOT: rootDir,
      CODEXHOOK_LOG_DIR: logDir
    }
  });

  const stdoutReader = readline.createInterface({ input: backend.stdout });
  const stderrReader = readline.createInterface({ input: backend.stderr });

  stdoutReader.on("line", handleBackendLine);
  stderrReader.on("line", (line) => log("[py]", line));

  backend.on("spawn", () => {
    backendReady = true;
    log("Python backend spawned", { pid: backend.pid, pythonExe, backendPath });
    queueBackendMessage({
      type: "init",
      pluginUUID,
      registerEvent,
      info
    });
    flushBackendQueue();
  });

  backend.on("error", (error) => {
    log("Python backend spawn failed", error.message);
  });

  backend.on("exit", (code, signal) => {
    backendReady = false;
    log("Python backend exited", { code, signal });
  });
}

function shutdown() {
  log("Shutting down CodexHook plugin");

  if (backend && !backend.killed) {
    backend.kill();
  }

  try {
    socket.close();
  } catch (error) {
    log("Socket close failed", error.message);
  }

  setTimeout(() => process.exit(0), 250).unref();
}

startBackend();

socket.on("open", () => {
  log("Connected to Stream Dock websocket", { port, pluginUUID, registerEvent });
  sendToStreamDock({ event: registerEvent, uuid: pluginUUID });
});

socket.on("message", (data) => {
  const text = data.toString();
  const payload = safeJson(text);

  if (!payload) {
    return;
  }

  queueBackendMessage({
    type: "event",
    payload
  });
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
