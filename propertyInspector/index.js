let websocket = null;
let inspectorUuid = "";
let registerEvent = "";
let currentContext = "";
let actionUuid = "";

const UI_TEXT = {
  connected: "已连接",
  buttonTitleHint: "留空则使用读出的会话标题；按钮顶部显示标题，底部显示状态",
  buttonTitlePlaceholder: "留空使用读出的会话标题",
  localConnection: "本机 Codex",
  manualThreadHint: "输入 threadId 后监听本机或 SSH 远程 Codex 会话",
  manualThreadPlaceholder: "粘贴 threadId...",
  manualThreadSubmit: "监听",
  monitorWaiting: "等待插件连接...",
  noThreadSelected: "未选择会话",
  projectInspectorConnectionFailed: "属性面板连接失败",
  projectInspectorDisconnected: "属性面板已断开连接",
  refreshInProgress: "正在刷新...",
  readingThreadTitle: "读取中...",
  serverConnecting: "正在连接...",
  serverStarting: "启动中或不可用",
  serverWaitingForThread: "输入 threadId 后启动",
  statusSync: "同步"
};

const EMPTY_SETTINGS = {
  targetProjectKey: "",
  targetProjectName: "",
  targetProjectPath: "",
  targetThreadId: "",
  targetThreadName: "",
  targetThreadPreview: "",
  targetThreadCwd: "",
  buttonTitle: "",
  connectionMode: "local",
  sshHost: "",
  sshPort: "22",
  sshUsername: "",
  sshAuthType: "password",
  sshPassword: "",
  sshKeyPath: "",
  sshKeyPassphrase: "",
  remoteCodexCommand: ""
};

const state = {
  settings: {},
  monitor: null,
  serverOnline: false,
  error: "",
  pluginConnected: false
};

const elements = {
  applyThreadIdButton: null,
  buttonTitleInput: null,
  connectionModeSelect: null,
  manualThreadInput: null,
  refreshButton: null,
  clearButton: null,
  remoteCodexCommandInput: null,
  sshAuthTypeSelect: null,
  sshHostInput: null,
  sshKeyPassphraseInput: null,
  sshKeyPassphraseRow: null,
  sshKeyPathInput: null,
  sshKeyRow: null,
  sshPasswordInput: null,
  sshPasswordRow: null,
  sshPortInput: null,
  sshSettings: null,
  sshUsernameInput: null,
  threadTitle: null,
  monitorState: null,
  monitorMeta: null,
  serverState: null
};

function $(id) {
  return document.getElementById(id);
}

function safeJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function normalizeInput(value) {
  return String(value || "").trim();
}

function normalizePort(value) {
  const text = normalizeInput(value);
  const port = Number.parseInt(text, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "22";
  }
  return String(port);
}

function preserveInput(value) {
  return String(value || "");
}

function settingsWithDefaults(settings = state.settings) {
  return {
    ...EMPTY_SETTINGS,
    ...(settings || {})
  };
}

function shortThreadId(threadId) {
  return threadId ? `#${threadId.slice(-4)}` : "";
}

function translateRuntimeMessage(message) {
  const value = String(message || "").trim();
  if (!value) {
    return "";
  }

  if (value === "Property inspector disconnected") {
    return UI_TEXT.projectInspectorDisconnected;
  }

  if (value === "Property inspector connection failed") {
    return UI_TEXT.projectInspectorConnectionFailed;
  }

  if (value === "app-server unavailable") {
    return "Codex app-server 不可用";
  }

  if (value.startsWith("start failed:")) {
    return `启动失败：${value.slice("start failed:".length).trim()}`;
  }

  if (value.startsWith("initialize failed:")) {
    return `初始化失败：${value.slice("initialize failed:".length).trim()}`;
  }

  if (value.startsWith("timeout waiting for ")) {
    return `请求超时：${value.slice("timeout waiting for ".length).trim()}`;
  }

  return value;
}

function send(payload) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    return;
  }

  websocket.send(JSON.stringify(payload));
}

function getSettings() {
  if (!currentContext) {
    return;
  }

  send({
    event: "getSettings",
    context: currentContext
  });
}

function setSettings(payload) {
  if (!currentContext) {
    return;
  }

  state.settings = { ...payload };

  send({
    event: "setSettings",
    context: currentContext,
    payload
  });
}

function sendToPlugin(command, payload = {}) {
  if (!inspectorUuid) {
    return;
  }

  send({
    event: "sendToPlugin",
    context: inspectorUuid,
    action: actionUuid,
    payload: {
      actionContext: currentContext,
      command,
      ...payload
    }
  });
}

function applyPluginPayload(payload) {
  if (!payload || payload.plugin !== "codexhook" || payload.kind !== "inspectorData") {
    return;
  }

  state.serverOnline = Boolean(payload.serverOnline);
  state.error = payload.error || "";
  state.monitor = payload.monitor || null;

  if (payload.selectedSettings && typeof payload.selectedSettings === "object") {
    state.settings = settingsWithDefaults(payload.selectedSettings);
  }
}

function selectedThreadId() {
  return state.settings.targetThreadId || state.monitor?.threadId || "";
}

function threadTitle() {
  const threadId = selectedThreadId();
  if (!threadId) {
    return UI_TEXT.noThreadSelected;
  }

  const title = state.monitor?.threadName || state.settings.targetThreadName;
  if (title) {
    return title;
  }

  if (state.monitor?.state === "missing") {
    return `未找到会话 ${shortThreadId(threadId)}`;
  }

  if (state.monitor?.state === "error") {
    return `标题读取失败 ${shortThreadId(threadId)}`;
  }

  return UI_TEXT.readingThreadTitle;
}

function syncManualThreadInput(threadId) {
  if (!elements.manualThreadInput) {
    return;
  }

  const active = document.activeElement === elements.manualThreadInput;
  const draft = normalizeInput(elements.manualThreadInput.value);

  if (active && draft && draft !== threadId) {
    return;
  }

  if (elements.manualThreadInput.value !== threadId) {
    elements.manualThreadInput.value = threadId;
  }
}

function syncButtonTitleInput(title) {
  if (!elements.buttonTitleInput) {
    return;
  }

  const active = document.activeElement === elements.buttonTitleInput;
  const draft = preserveInput(elements.buttonTitleInput.value);

  if (active && draft !== title) {
    return;
  }

  if (elements.buttonTitleInput.value !== title) {
    elements.buttonTitleInput.value = title;
  }
}

function setInputValue(element, value, preserve = false) {
  if (!element) {
    return;
  }

  const active = document.activeElement === element;
  const current = preserve ? preserveInput(element.value) : normalizeInput(element.value);
  const next = preserve ? preserveInput(value) : normalizeInput(value);

  if (active && current !== next) {
    return;
  }

  if (element.value !== next) {
    element.value = next;
  }
}

function syncRemoteInputs() {
  const settings = settingsWithDefaults();
  const connectionMode = settings.connectionMode === "ssh" ? "ssh" : "local";
  const authType = settings.sshAuthType === "key" ? "key" : "password";
  const sshVisible = connectionMode === "ssh";
  const keyVisible = authType === "key";

  if (elements.connectionModeSelect && elements.connectionModeSelect.value !== connectionMode) {
    elements.connectionModeSelect.value = connectionMode;
  }
  if (elements.sshAuthTypeSelect && elements.sshAuthTypeSelect.value !== authType) {
    elements.sshAuthTypeSelect.value = authType;
  }

  if (elements.sshSettings) {
    elements.sshSettings.hidden = !sshVisible;
  }
  if (elements.sshPasswordRow) {
    elements.sshPasswordRow.hidden = !sshVisible || keyVisible;
  }
  if (elements.sshKeyRow) {
    elements.sshKeyRow.hidden = !sshVisible || !keyVisible;
  }
  if (elements.sshKeyPassphraseRow) {
    elements.sshKeyPassphraseRow.hidden = !sshVisible || !keyVisible;
  }

  setInputValue(elements.sshHostInput, settings.sshHost || "");
  setInputValue(elements.sshPortInput, settings.sshPort || "22");
  setInputValue(elements.sshUsernameInput, settings.sshUsername || "");
  setInputValue(elements.sshPasswordInput, settings.sshPassword || "", true);
  setInputValue(elements.sshKeyPathInput, settings.sshKeyPath || "");
  setInputValue(elements.sshKeyPassphraseInput, settings.sshKeyPassphrase || "", true);
  setInputValue(elements.remoteCodexCommandInput, settings.remoteCodexCommand || "");
}

function render() {
  if (!elements.manualThreadInput) {
    return;
  }

  const threadId = selectedThreadId();
  syncManualThreadInput(threadId);
  syncButtonTitleInput(state.settings.buttonTitle || "");
  syncRemoteInputs();

  if (elements.threadTitle) {
    elements.threadTitle.textContent = threadTitle();
  }

  if (!state.pluginConnected && !currentContext) {
    elements.monitorState.textContent = UI_TEXT.monitorWaiting;
    elements.monitorMeta.textContent = "";
  } else if (!threadId) {
    elements.monitorState.textContent = UI_TEXT.noThreadSelected;
    elements.monitorMeta.textContent = "";
  } else {
    elements.monitorState.textContent = state.monitor?.label || UI_TEXT.statusSync;
    const metaParts = [threadId];
    if (state.settings.connectionMode === "ssh") {
      metaParts.push(`SSH ${state.settings.sshUsername || "?"}@${state.settings.sshHost || "?"}:${state.settings.sshPort || "22"}`);
    }
    if (state.monitor?.cwd) {
      metaParts.push(state.monitor.cwd);
    }
    elements.monitorMeta.textContent = metaParts.join(" | ");
  }

  if (state.error) {
    elements.serverState.textContent = translateRuntimeMessage(state.error);
  } else if (state.serverOnline) {
    elements.serverState.textContent = UI_TEXT.connected;
  } else if (!state.pluginConnected && !currentContext) {
    elements.serverState.textContent = UI_TEXT.serverConnecting;
  } else if (!threadId) {
    elements.serverState.textContent = UI_TEXT.serverWaitingForThread;
  } else {
    elements.serverState.textContent = UI_TEXT.serverStarting;
  }
}

function applyManualThreadId(rawThreadId) {
  const threadId = normalizeInput(rawThreadId);

  if (!threadId) {
    clearSelection();
    return;
  }

  const settings = {
    ...settingsWithDefaults(),
    targetProjectKey: "",
    targetProjectName: "",
    targetProjectPath: "",
    targetThreadId: threadId,
    targetThreadName: "",
    targetThreadPreview: "",
    targetThreadCwd: ""
  };

  setSettings(settings);
  sendToPlugin("select_thread", { settings });
  render();
}

function clearSelection() {
  const settings = {
    ...settingsWithDefaults(),
    targetProjectKey: "",
    targetProjectName: "",
    targetProjectPath: "",
    targetThreadId: "",
    targetThreadName: "",
    targetThreadPreview: "",
    targetThreadCwd: ""
  };
  setSettings(settings);
  sendToPlugin("clear_thread", { settings });
  render();
}

function applyButtonTitle(rawTitle) {
  const settings = {
    ...settingsWithDefaults(),
    buttonTitle: preserveInput(rawTitle)
  };
  setSettings(settings);
  sendToPlugin("update_settings", { settings });
  render();
}

function readRemoteSettingsFromInputs() {
  const connectionMode = elements.connectionModeSelect?.value === "ssh" ? "ssh" : "local";
  const authType = elements.sshAuthTypeSelect?.value === "key" ? "key" : "password";

  return {
    connectionMode,
    sshHost: normalizeInput(elements.sshHostInput?.value),
    sshPort: normalizePort(elements.sshPortInput?.value),
    sshUsername: normalizeInput(elements.sshUsernameInput?.value),
    sshAuthType: authType,
    sshPassword: preserveInput(elements.sshPasswordInput?.value),
    sshKeyPath: normalizeInput(elements.sshKeyPathInput?.value),
    sshKeyPassphrase: preserveInput(elements.sshKeyPassphraseInput?.value),
    remoteCodexCommand: normalizeInput(elements.remoteCodexCommandInput?.value)
  };
}

function applyRemoteSettings() {
  const settings = {
    ...settingsWithDefaults(),
    ...readRemoteSettingsFromInputs()
  };
  setSettings(settings);
  sendToPlugin("update_settings", { settings });
  render();
}

function wireUi() {
  elements.applyThreadIdButton = $("apply-thread-id-button");
  elements.buttonTitleInput = $("button-title");
  elements.connectionModeSelect = $("connection-mode");
  elements.manualThreadInput = $("manual-thread-id");
  elements.refreshButton = $("refresh-button");
  elements.clearButton = $("clear-button");
  elements.remoteCodexCommandInput = $("remote-codex-command");
  elements.sshAuthTypeSelect = $("ssh-auth-type");
  elements.sshHostInput = $("ssh-host");
  elements.sshKeyPassphraseInput = $("ssh-key-passphrase");
  elements.sshKeyPassphraseRow = $("ssh-key-passphrase-row");
  elements.sshKeyPathInput = $("ssh-key-path");
  elements.sshKeyRow = $("ssh-key-row");
  elements.sshPasswordInput = $("ssh-password");
  elements.sshPasswordRow = $("ssh-password-row");
  elements.sshPortInput = $("ssh-port");
  elements.sshSettings = $("ssh-settings");
  elements.sshUsernameInput = $("ssh-username");
  elements.threadTitle = $("thread-title");
  elements.monitorState = $("monitor-state");
  elements.monitorMeta = $("monitor-meta");
  elements.serverState = $("server-state");

  elements.manualThreadInput.placeholder = UI_TEXT.manualThreadPlaceholder;
  elements.manualThreadInput.setAttribute("aria-label", UI_TEXT.manualThreadHint);
  elements.buttonTitleInput.placeholder = UI_TEXT.buttonTitlePlaceholder;
  elements.buttonTitleInput.setAttribute("aria-label", UI_TEXT.buttonTitleHint);
  elements.applyThreadIdButton.textContent = UI_TEXT.manualThreadSubmit;

  elements.applyThreadIdButton.addEventListener("click", () => {
    applyManualThreadId(elements.manualThreadInput.value);
  });

  elements.manualThreadInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    applyManualThreadId(elements.manualThreadInput.value);
  });

  let titleSaveTimer = null;
  elements.buttonTitleInput.addEventListener("input", () => {
    clearTimeout(titleSaveTimer);
    titleSaveTimer = setTimeout(() => {
      applyButtonTitle(elements.buttonTitleInput.value);
    }, 250);
  });

  elements.buttonTitleInput.addEventListener("change", () => {
    clearTimeout(titleSaveTimer);
    applyButtonTitle(elements.buttonTitleInput.value);
  });

  let remoteSaveTimer = null;
  const scheduleRemoteSave = () => {
    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = setTimeout(applyRemoteSettings, 250);
  };
  const remoteInputs = [
    elements.sshHostInput,
    elements.sshPortInput,
    elements.sshUsernameInput,
    elements.sshPasswordInput,
    elements.sshKeyPathInput,
    elements.sshKeyPassphraseInput,
    elements.remoteCodexCommandInput
  ];

  elements.connectionModeSelect.addEventListener("change", applyRemoteSettings);
  elements.sshAuthTypeSelect.addEventListener("change", applyRemoteSettings);
  for (const input of remoteInputs) {
    input.addEventListener("input", scheduleRemoteSave);
    input.addEventListener("change", () => {
      clearTimeout(remoteSaveTimer);
      applyRemoteSettings();
    });
  }

  elements.refreshButton.addEventListener("click", () => {
    sendToPlugin("refresh_thread");
    elements.serverState.textContent = UI_TEXT.refreshInProgress;
  });

  elements.clearButton.addEventListener("click", () => {
    clearSelection();
  });
}

function handleMessage(raw) {
  const message = safeJson(raw);
  if (!message) {
    return;
  }

  if (message.event === "didReceiveSettings") {
    state.settings = settingsWithDefaults(message.payload?.settings || {});
    render();
    return;
  }

  if (message.event === "sendToPropertyInspector") {
    applyPluginPayload(message.payload);
    render();
  }
}

function connectElgatoStreamDeckSocket(
  inPort,
  inUUID,
  inRegisterEvent,
  _inInfo,
  inActionInfo
) {
  inspectorUuid = inUUID;
  registerEvent = inRegisterEvent;

  const actionInfo = safeJson(inActionInfo) || {};
  currentContext = actionInfo.context || "";
  actionUuid = actionInfo.action || "";
  state.settings = settingsWithDefaults(actionInfo.payload?.settings || {});

  websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);

  websocket.onopen = () => {
    state.pluginConnected = true;
    send({
      event: registerEvent,
      uuid: inspectorUuid
    });

    getSettings();
    sendToPlugin("pi_ready");
    render();
  };

  websocket.onmessage = (event) => {
    handleMessage(event.data);
  };

  websocket.onclose = () => {
    state.pluginConnected = false;
    state.serverOnline = false;
    state.error = "Property inspector disconnected";
    render();
  };

  websocket.onerror = () => {
    state.pluginConnected = false;
    state.serverOnline = false;
    state.error = "Property inspector connection failed";
    render();
  };
}

window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
window.addEventListener("DOMContentLoaded", () => {
  wireUi();
  render();
});
