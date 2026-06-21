const SCREEN_WIDTH = 256;
const SCREEN_HEIGHT = 240;
const APP_VERSION = "v20260621-pad-turbo-1";
const TARGET_FPS = 60;
const FRAME_TIME = 1000 / TARGET_FPS;
const TURBO_INTERVAL_MS = 80;
const AUDIO_BUFFER_SIZE = 4096;
const AUDIO_LATENCY = 1024;
const LATENCY_PROBE_INTERVAL = 1500;
const MAX_ACCEPTED_RTT_MS = 500;
const RESUME_LATENCY_GRACE_MS = 2000;
const SOCKET_STALE_MS = 10000;
const LAST_ROOM_KEY = "fc-online-emulator:last-room";
const DEBUG_SYNC_KEY = "fc-online-emulator:debug";
const WINDOW_TOKEN_PREFIX = "fc-online-emulator-tab:";
const TOKEN_CHANNEL_NAME = "fc-online-emulator:client-token";
const TOKEN_PROBE_WAIT_MS = 80;
const RESUME_STALE_RECONNECT_MS = 3000;
const RESYNC_BACKLOG_FRAMES = 30;
const RESYNC_COOLDOWN_MS = 1000;
const RESYNC_WAIT_MS = 2500;
const RESUME_SYNC_DEBOUNCE_MS = 1200;
const STATE_WAIT_RECONNECT_MS = 10000;
const ONLINE_STEADY_FRAMES_PER_TICK = 1;
const ONLINE_CATCHUP_BACKLOG_FRAMES = 8;
const ONLINE_CATCHUP_FRAMES_PER_TICK = 4;
const AUTHORITATIVE_STATE_INTERVAL_FRAMES = 0;
const STATE_HASH_INTERVAL_FRAMES = TARGET_FPS * 5;
const FRAME_ACK_INTERVAL_FRAMES = 5;

const els = {
  romInput: document.querySelector("#romInput"),
  runButton: document.querySelector("#runButton"),
  resetButton: document.querySelector("#resetButton"),
  muteButton: document.querySelector("#muteButton"),
  saveButton: document.querySelector("#saveButton"),
  loadButton: document.querySelector("#loadButton"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  statusText: document.querySelector("#statusText"),
  fpsText: document.querySelector("#fpsText"),
  gamepadText: document.querySelector("#gamepadText"),
  screen: document.querySelector("#screen"),
  screenWrap: document.querySelector(".screen-wrap"),
  romButtons: document.querySelectorAll(".rom-card"),
  createRoomButton: document.querySelector("#createRoomButton"),
  joinRoomButton: document.querySelector("#joinRoomButton"),
  leaveRoomButton: document.querySelector("#leaveRoomButton"),
  roomInput: document.querySelector("#roomInput"),
  syncBadge: document.querySelector("#syncBadge"),
  syncRoomLabel: document.querySelector("#syncRoomLabel"),
  syncRoleLabel: document.querySelector("#syncRoleLabel"),
  versionLabel: document.querySelector("#versionLabel"),
};
if (els.versionLabel) els.versionLabel.textContent = APP_VERSION;

const ctx = els.screen.getContext("2d", { alpha: false });
ctx.imageSmoothingEnabled = false;

const imageData = ctx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
const frameBuffer8 = new Uint8ClampedArray(imageData.data.buffer);
const frameBuffer32 = new Uint32Array(imageData.data.buffer);

const NesButton = window.jsnes?.Controller;
const BUTTONS = {
  A: NesButton?.BUTTON_A,
  B: NesButton?.BUTTON_B,
  SELECT: NesButton?.BUTTON_SELECT,
  START: NesButton?.BUTTON_START,
  UP: NesButton?.BUTTON_UP,
  DOWN: NesButton?.BUTTON_DOWN,
  LEFT: NesButton?.BUTTON_LEFT,
  RIGHT: NesButton?.BUTTON_RIGHT,
};
const BUTTON_ORDER = ["A", "B", "SELECT", "START", "UP", "DOWN", "LEFT", "RIGHT"];
const BUTTON_MASKS = Object.fromEntries(
  BUTTON_ORDER.map((button, index) => [button, 1 << index]),
);

const KEYBOARD = new Map([
  ["KeyW", [1, "UP"]],
  ["KeyA", [1, "LEFT"]],
  ["KeyS", [1, "DOWN"]],
  ["KeyD", [1, "RIGHT"]],
  ["KeyJ", [1, "B"]],
  ["KeyK", [1, "A"]],
  ["KeyU", [1, "SELECT"]],
  ["KeyI", [1, "START"]],
  ["ArrowUp", [2, "UP"]],
  ["ArrowLeft", [2, "LEFT"]],
  ["ArrowDown", [2, "DOWN"]],
  ["ArrowRight", [2, "RIGHT"]],
  ["KeyN", [2, "B"]],
  ["KeyM", [2, "A"]],
  ["Comma", [2, "SELECT"]],
  ["Period", [2, "START"]],
  ["Numpad8", [2, "UP"]],
  ["Numpad4", [2, "LEFT"]],
  ["Numpad5", [2, "DOWN"]],
  ["Numpad6", [2, "RIGHT"]],
  ["Numpad1", [2, "B"]],
  ["Numpad2", [2, "A"]],
  ["Numpad0", [2, "SELECT"]],
  ["NumpadEnter", [2, "START"]],
]);

let nes = null;
let running = false;
let muted = false;
let rafId = 0;
let lastFrameAt = 0;
let fpsStartedAt = 0;
let framesThisSecond = 0;
let currentRomKey = "";
let audio = null;
let currentRomData = null;
let currentRoomRom = null;

const activeInputs = new Map();
const keySources = new Map();
const turboInputs = new Map();
const gamepadSources = {
  1: new Set(),
  2: new Set(),
};
const localSyncInputs = new Map();
let cachedClientToken = "";
let tokenChannel = null;
const pageInstanceId = makeClientToken();
const sync = {
  clientId: "",
  connected: false,
  frame: 0,
  hasClockSync: false,
  hostId: "",
  inputFrames: new Map(),
  inputDelayMs: 0,
  latencyMs: 0,
  lastMessageAt: 0,
  lastPongAt: 0,
  lastAppliedStateKey: "",
  lastResumeSyncAt: 0,
  lastServerFrame: 0,
  manualLeave: false,
  maxLatencyMs: 0,
  paused: false,
  stalled: false,
  awaitingState: false,
  pendingState: null,
  pendingPings: new Map(),
  peerCount: 0,
  pingTimer: 0,
  readyCount: 0,
  reconnectTimer: 0,
  resyncRequestedAt: 0,
  resumedAt: 0,
  role: 0,
  room: "",
  serverClockOffsetMs: 0,
  stateWaitMandatory: false,
  stateWaitReason: "",
  stateWaitStartedAt: 0,
  socket: null,
  stateAppliedAt: 0,
  lastSnapshotSentAt: 0,
  lastSnapshotSentFrame: -1,
  snapshotFrames: 0,
  lastHashFrame: -1,
  lastAckFrame: -1,
  started: false,
};

function setStatus(text) {
  els.statusText.textContent = text;
}

function syncDebugEnabled() {
  try {
    return (
      new URLSearchParams(window.location.search).get("debug") === "1" ||
      localStorage.getItem(DEBUG_SYNC_KEY) === "1"
    );
  } catch {
    return false;
  }
}

function debugSync(event, detail = {}) {
  if (!syncDebugEnabled()) return;
  const payload = {
    appVersion: APP_VERSION,
    frame: sync.frame,
    localRole: sync.role,
    room: sync.room,
    ...detail,
  };
  try {
    console.debug("[fc-sync]", event, JSON.stringify(payload));
  } catch {
    console.debug("[fc-sync]", event);
  }
}

function makeClientToken() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  window.crypto?.getRandomValues?.(bytes);
  const randomText = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return randomText || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function windowClientToken() {
  const name = String(window.name || "");
  if (!name.startsWith(WINDOW_TOKEN_PREFIX)) return "";

  const token = name.slice(WINDOW_TOKEN_PREFIX.length);
  return /^[A-Za-z0-9_-]{12,80}$/.test(token) ? token : "";
}

function writeWindowClientToken(token) {
  try {
    window.name = `${WINDOW_TOKEN_PREFIX}${token}`;
  } catch {}
}

function openTokenChannel() {
  if (tokenChannel || !("BroadcastChannel" in window)) return tokenChannel;

  try {
    tokenChannel = new BroadcastChannel(TOKEN_CHANNEL_NAME);
    tokenChannel.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.pageId === pageInstanceId) return;
      if (message.type !== "token-probe") return;

      const token = cachedClientToken || windowClientToken();
      if (!token || token !== message.token) return;
      tokenChannel.postMessage({
        type: "token-present",
        pageId: pageInstanceId,
        probeId: message.probeId || "",
        token,
      });
    });
  } catch {
    tokenChannel = null;
  }

  return tokenChannel;
}

function clientToken() {
  if (cachedClientToken) return cachedClientToken;

  const existing = windowClientToken();
  if (existing) {
    cachedClientToken = existing;
    openTokenChannel();
    return cachedClientToken;
  }

  cachedClientToken = makeClientToken();
  writeWindowClientToken(cachedClientToken);
  openTokenChannel();
  return cachedClientToken;
}

function rotateClientToken() {
  cachedClientToken = makeClientToken();
  writeWindowClientToken(cachedClientToken);
  debugSync("token-rotated");
  return cachedClientToken;
}

async function ensureUniqueClientToken() {
  const token = clientToken();
  const channel = openTokenChannel();
  if (!channel) return token;

  const probeId = makeClientToken();
  const hasDuplicate = await new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(false);
    }, TOKEN_PROBE_WAIT_MS);

    function cleanup() {
      window.clearTimeout(timer);
      channel.removeEventListener("message", handleMessage);
    }

    function handleMessage(event) {
      const message = event.data || {};
      if (
        message.type === "token-present" &&
        message.pageId !== pageInstanceId &&
        message.probeId === probeId &&
        message.token === token
      ) {
        cleanup();
        resolve(true);
      }
    }

    channel.addEventListener("message", handleMessage);
    channel.postMessage({
      type: "token-probe",
      pageId: pageInstanceId,
      probeId,
      token,
    });
  });

  return hasDuplicate ? rotateClientToken() : token;
}

function formatRomError(error) {
  const message = String(error?.message || error || "");
  const mapperMatch = message.match(/mapper not supported by JSNES:\s*(.+)$/i);

  if (mapperMatch) {
    return `不支持该 ROM 的 Mapper：${mapperMatch[1]}`;
  }

  if (/Not an iNES ROM/i.test(message)) {
    return "不是标准 iNES ROM";
  }

  if (/ROM request failed/i.test(message)) {
    return "ROM 下载失败";
  }

  return "ROM 无法载入";
}

function localSource(source) {
  return /^(key|touch|gamepad):/.test(source);
}

function roleText(role) {
  if (role === 1) return "1P";
  if (role === 2) return "2P";
  return "观战";
}

function normalizeRoomCode(room) {
  return String(room || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);
}

function rememberRoom(room) {
  const code = normalizeRoomCode(room);
  if (!code) return "";

  try {
    localStorage.setItem(LAST_ROOM_KEY, code);
  } catch {}
  els.roomInput.value = code;
  updateRoomUrl(code);
  return code;
}

function forgetRoom() {
  try {
    localStorage.removeItem(LAST_ROOM_KEY);
  } catch {}

  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  window.history.replaceState({}, "", url);
}

function rememberedRoom() {
  const urlRoom = normalizeRoomCode(
    new URLSearchParams(window.location.search).get("room"),
  );
  if (urlRoom) return urlRoom;

  try {
    return normalizeRoomCode(localStorage.getItem(LAST_ROOM_KEY));
  } catch {
    return "";
  }
}

function syncLatencyText() {
  if (!sync.connected || sync.maxLatencyMs <= 0) return "";
  const inputDelayText =
    sync.inputDelayMs > 0 ? ` / 输入 ${Math.round(sync.inputDelayMs)}ms` : "";
  return ` · 最高 ${Math.round(sync.maxLatencyMs)}ms${inputDelayText}`;
}

function updateSyncUi() {
  document.body.classList.toggle("sync-online", sync.connected);
  document.body.classList.toggle("role-p1", sync.connected && sync.role === 1);
  document.body.classList.toggle("role-p2", sync.connected && sync.role === 2);
  const latencyText = syncLatencyText();

  els.syncBadge.textContent = sync.connected ? "同步" : "本机";
  els.syncRoomLabel.textContent = sync.connected
    ? `房间 ${sync.room}`
    : "双手机同步";

  if (!sync.connected) {
    els.syncRoleLabel.textContent = "未进入房间";
  } else if (sync.peerCount < 2) {
    els.syncRoleLabel.textContent = `${roleText(sync.role)} · 等待另一台手机${latencyText}`;
  } else if (sync.stalled) {
    els.syncRoleLabel.textContent = `${roleText(sync.role)} · 等待对方网络${latencyText}`;
  } else if (sync.paused) {
    els.syncRoleLabel.textContent = `${roleText(sync.role)} · 同步暂停${latencyText}`;
  } else if (!sync.started && sync.readyCount > 0) {
    els.syncRoleLabel.textContent = `${roleText(sync.role)} · 等待同步开始${latencyText}`;
  } else {
    els.syncRoleLabel.textContent = `${roleText(sync.role)} · ${sync.peerCount} 台在线${latencyText}`;
  }

  els.createRoomButton.disabled = sync.connected;
  els.joinRoomButton.disabled = sync.connected;
  els.roomInput.disabled = sync.connected;
  els.leaveRoomButton.hidden = !sync.connected;
  if (sync.connected) els.roomInput.value = sync.room;
  updateControls(Boolean(nes));
}

function drawBootScreen() {
  ctx.fillStyle = "#090a0d";
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

  for (let y = 0; y < SCREEN_HEIGHT; y += 8) {
    ctx.fillStyle = y % 16 === 0 ? "#11151d" : "#0c0f15";
    ctx.fillRect(0, y, SCREEN_WIDTH, 8);
  }

  ctx.fillStyle = "#f4f0e8";
  ctx.font = "bold 22px monospace";
  ctx.textAlign = "center";
  ctx.fillText("FC READY", SCREEN_WIDTH / 2, 96);
  ctx.fillStyle = "#4fb9b3";
  ctx.font = "bold 11px monospace";
  ctx.fillText("LOAD .NES ROM", SCREEN_WIDTH / 2, 124);
  ctx.fillStyle = "#d84035";
  ctx.fillRect(81, 146, 94, 5);
}

function renderFrame(frameBuffer) {
  for (let i = 0; i < frameBuffer.length; i += 1) {
    frameBuffer32[i] = 0xff000000 | frameBuffer[i];
  }
  imageData.data.set(frameBuffer8);
  ctx.putImageData(imageData, 0, 0);
}

function createAudio(sampleRate = 44100) {
  if (audio || !("AudioContext" in window || "webkitAudioContext" in window)) {
    return audio;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass({ sampleRate });
  const left = new Float32Array(AUDIO_BUFFER_SIZE);
  const right = new Float32Array(AUDIO_BUFFER_SIZE);
  let writeCursor = 0;
  let readCursor = 0;
  let buffered = 0;

  const node = context.createScriptProcessor(AUDIO_LATENCY, 0, 2);
  node.onaudioprocess = (event) => {
    const outputLeft = event.outputBuffer.getChannelData(0);
    const outputRight = event.outputBuffer.getChannelData(1);

    for (let i = 0; i < outputLeft.length; i += 1) {
      if (muted || buffered === 0) {
        outputLeft[i] = 0;
        outputRight[i] = 0;
        continue;
      }

      outputLeft[i] = left[readCursor];
      outputRight[i] = right[readCursor];
      readCursor = (readCursor + 1) % AUDIO_BUFFER_SIZE;
      buffered -= 1;
    }
  };
  node.connect(context.destination);

  audio = {
    context,
    push(leftSample, rightSample) {
      if (muted || buffered >= AUDIO_BUFFER_SIZE - 1) {
        return;
      }

      left[writeCursor] = leftSample;
      right[writeCursor] = rightSample;
      writeCursor = (writeCursor + 1) % AUDIO_BUFFER_SIZE;
      buffered += 1;
    },
    reset() {
      writeCursor = 0;
      readCursor = 0;
      buffered = 0;
    },
  };

  return audio;
}

async function resumeAudio() {
  if (!audio) {
    createAudio();
  }

  if (audio?.context.state === "suspended") {
    await audio.context.resume();
  }
}

function makeNes() {
  const audioDevice = createAudio();
  return new window.jsnes.NES({
    onFrame: renderFrame,
    onAudioSample: (left, right) => audioDevice?.push(left, right),
    sampleRate: audioDevice?.context.sampleRate || 44100,
  });
}

function bufferToBinaryString(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(index, index + chunkSize),
    );
  }

  return binary;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(index, index + chunkSize),
    );
  }

  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function hashString(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function captureSyncState() {
  if (!nes) return null;
  const state = nes.toJSON();
  state.romData = null;
  return state;
}

function hashSyncState(state) {
  return hashString(JSON.stringify(state));
}

function getInputKey(player, button) {
  return `${player}:${button}`;
}

function getInputSet(player, button) {
  const key = getInputKey(player, button);
  if (!activeInputs.has(key)) {
    activeInputs.set(key, new Set());
  }
  return activeInputs.get(key);
}

function getLocalSyncInputSet(player, button) {
  const key = getInputKey(player, button);
  if (!localSyncInputs.has(key)) {
    localSyncInputs.set(key, new Set());
  }
  return localSyncInputs.get(key);
}

function syncButtonVisual(player, button, isPressed, visualTarget = null) {
  if (visualTarget) {
    visualTarget.classList.toggle("is-pressed", isPressed);
    return;
  }

  document
    .querySelectorAll(`.pad[data-player="${player}"] [data-button="${button}"]`)
    .forEach((padButton) => {
      padButton.classList.toggle("is-pressed", isPressed);
    });
}

function handleLocalSyncInput(player, button, isDown, source, options = {}) {
  const inputSet = getLocalSyncInputSet(player, button);
  const wasActive = inputSet.size > 0;

  if (isDown) {
    inputSet.add(source);
  } else {
    inputSet.delete(source);
  }

  const isActive = inputSet.size > 0;
  if (!options.suppressVisual && options.visualTarget) {
    syncButtonVisual(player, button, isDown, options.visualTarget);
  }
  if (wasActive === isActive) {
    return;
  }

  if (!options.suppressVisual && !options.visualTarget) {
    syncButtonVisual(player, button, isActive);
  }
  sendSync({ type: "input", button, down: isActive });
  requestResyncIfNeeded();
}

function releaseLocalSyncInputs() {
  stopAllTurboButtons();
  for (const [inputKey, sources] of localSyncInputs.entries()) {
    const [player, button] = inputKey.split(":");
    const wasActive = sources.size > 0;
    sources.clear();
    syncButtonVisual(player, button, false);
    if (wasActive && sync.connected && Number(player) === sync.role) {
      sendSync({ type: "input", button, down: false });
    }
  }
}

function setButton(player, button, isDown, source, options = {}) {
  if (sync.connected && localSource(source)) {
    if (sync.role > 0 && player === sync.role) {
      handleLocalSyncInput(player, button, isDown, source, options);
    }
    return;
  }

  const inputSet = getInputSet(player, button);
  const wasActive = inputSet.size > 0;

  if (isDown) {
    inputSet.add(source);
  } else {
    inputSet.delete(source);
  }

  const isActive = inputSet.size > 0;
  if (!options.suppressVisual && options.visualTarget) {
    syncButtonVisual(player, button, isDown, options.visualTarget);
  }
  if (wasActive === isActive) {
    return;
  }

  if (!options.suppressVisual && !options.visualTarget) {
    syncButtonVisual(player, button, isActive);
  }

  if (!nes || BUTTONS[button] === undefined) {
    return;
  }

  if (isActive) {
    nes.buttonDown(player, BUTTONS[button]);
  } else {
    nes.buttonUp(player, BUTTONS[button]);
  }

  if (
    sync.connected &&
    !options.remote &&
    localSource(source) &&
    player === sync.role
  ) {
    sendSync({ type: "input", button, down: isActive });
  }
}

function getTurboKey(player, button, source) {
  return `${player}:${button}:${source}`;
}

function startTurboButton(player, button, source, visualTarget) {
  const key = getTurboKey(player, button, source);
  if (turboInputs.has(key)) {
    return;
  }

  const entry = {
    button,
    down: false,
    intervalId: 0,
    player,
    source,
    visualTarget,
  };
  turboInputs.set(key, entry);
  visualTarget?.classList.add("is-pressed");

  const pulse = () => {
    if (!turboInputs.has(key)) {
      return;
    }
    entry.down = !entry.down;
    setButton(player, button, entry.down, source, { suppressVisual: true });
  };

  pulse();
  entry.intervalId = window.setInterval(pulse, TURBO_INTERVAL_MS);
}

function stopTurboEntry(key) {
  const entry = turboInputs.get(key);
  if (!entry) {
    return;
  }

  window.clearInterval(entry.intervalId);
  turboInputs.delete(key);
  if (entry.down) {
    setButton(entry.player, entry.button, false, entry.source, {
      suppressVisual: true,
    });
  }
  entry.visualTarget?.classList.remove("is-pressed");
}

function stopTurboButton(player, button, source) {
  stopTurboEntry(getTurboKey(player, button, source));
}

function stopAllTurboButtons() {
  Array.from(turboInputs.keys()).forEach(stopTurboEntry);
}

function releaseAllInputs() {
  stopAllTurboButtons();
  for (const [inputKey, sources] of activeInputs.entries()) {
    const [player, button] = inputKey.split(":");
    sources.clear();
    syncButtonVisual(player, button, false);
    if (nes && BUTTONS[button] !== undefined) {
      nes.buttonUp(Number(player), BUTTONS[button]);
    }
  }
  releaseLocalSyncInputs();
  keySources.clear();
  gamepadSources[1].clear();
  gamepadSources[2].clear();
}

function updateControls(hasRom) {
  const online = sync.connected;
  els.runButton.disabled = !hasRom || online;
  els.resetButton.disabled = !hasRom || online;
  els.saveButton.disabled = !hasRom || online;
  els.loadButton.disabled =
    !hasRom || online || !localStorage.getItem(currentRomKey);
  els.runButton.textContent = running ? "Ⅱ" : "▶";
}

function startEmulation(status = "运行中") {
  if (!nes || running) {
    return;
  }

  running = true;
  lastFrameAt = performance.now() - FRAME_TIME;
  fpsStartedAt = performance.now();
  framesThisSecond = 0;
  updateControls(true);
  setStatus(status);
  void resumeAudio();
  rafId = requestAnimationFrame(tick);
}

function stopEmulation(status = "已暂停") {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  updateControls(Boolean(nes));
  if (nes) {
    setStatus(status);
  }
}

function tick(now) {
  if (!running || !nes) {
    return;
  }

  pollGamepads();

  if (sync.connected && sync.started) {
    tickOnline();
    updateFps(now);
    return;
  }

  if (now - lastFrameAt > 250) {
    lastFrameAt = now - FRAME_TIME;
  }

  let catchupFrames = 0;
  while (now - lastFrameAt >= FRAME_TIME && catchupFrames < 3) {
    stepNesFrame();
    lastFrameAt += FRAME_TIME;
    catchupFrames += 1;
  }

  updateFps(now);
  rafId = requestAnimationFrame(tick);
}

function updateFps(now) {
  if (now - fpsStartedAt >= 1000) {
    const fps = Math.round((framesThisSecond * 1000) / (now - fpsStartedAt));
    els.fpsText.textContent = `${fps} fps`;
    framesThisSecond = 0;
    fpsStartedAt = now;
  }
}

function setRomKey(file) {
  const safeName = file.name.replace(/[^\w.-]+/g, "_");
  currentRomKey = `fc-online-emulator:state:${safeName}:${file.size}`;
}

function setRomKeyFromLabel(label, size) {
  const safeName = label.replace(/[^\w.-]+/g, "_");
  currentRomKey = `fc-online-emulator:state:${safeName}:${size}`;
}

function setLibraryBusy(isBusy) {
  els.romButtons.forEach((button) => {
    button.disabled = isBusy;
  });
}

function fetchRomBuffer(url) {
  if (window.fetch) {
    return fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`ROM request failed: ${response.status}`);
      }
      return response.arrayBuffer();
    });
  }

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", url);
    request.responseType = "arraybuffer";
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.response);
      } else {
        reject(new Error(`ROM request failed: ${request.status}`));
      }
    };
    request.onerror = () => reject(new Error("ROM request failed"));
    request.send();
  });
}

async function loadRomBuffer(buffer, label, options = {}) {
  const { autoStart = true, status = label } = options;
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length < 16 ||
    bytes[0] !== 0x4e ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x53 ||
    bytes[3] !== 0x1a
  ) {
    throw new Error("Not an iNES ROM");
  }

  const romData = bufferToBinaryString(buffer);
  currentRomData = romData;
  audio?.reset();
  nes = makeNes();
  nes.loadROM(romData);
  document.body.classList.add("has-game");
  updateControls(true);
  setStatus(status);
  if (autoStart) {
    startEmulation();
  }
}

function rememberCurrentRomFromBuffer(buffer, label) {
  currentRoomRom = {
    data: arrayBufferToBase64(buffer),
    label,
    mode: "data",
    size: buffer.byteLength,
  };
}

function rememberCurrentRomFromUrl(url, label) {
  currentRoomRom = {
    label,
    mode: "url",
    url,
  };
}

function offerCurrentRomToRoom() {
  if (!sync.connected || sync.role < 1 || !currentRoomRom) return;
  sendSync({
    type: "adopt-rom",
    ...currentRoomRom,
  });
}

async function loadRomFile(file) {
  if (sync.connected) {
    selectRoomRomFile(file);
    return;
  }

  if (!window.jsnes) {
    setStatus("jsnes 未载入");
    return;
  }

  stopEmulation("载入中");
  releaseAllInputs();
  setRomKey(file);
  setStatus("读取 ROM");

  try {
    void resumeAudio();
    const buffer = await file.arrayBuffer();
    await loadRomBuffer(buffer, file.name);
    rememberCurrentRomFromBuffer(buffer, file.name);
  } catch (error) {
    console.error(error);
    nes = null;
    currentRoomRom = null;
    updateControls(false);
    document.body.classList.remove("has-game");
    drawBootScreen();
    setStatus(formatRomError(error));
  }
}

async function loadBundledRom(url, label) {
  if (sync.connected) {
    selectRoomRom(url, label);
    return;
  }

  if (!window.jsnes) {
    setStatus("jsnes 未载入");
    return;
  }

  stopEmulation("载入中");
  releaseAllInputs();
  setStatus("下载 ROM");
  setLibraryBusy(true);

  try {
    void resumeAudio();
    const buffer = await fetchRomBuffer(url);
    setRomKeyFromLabel(label, buffer.byteLength);
    await loadRomBuffer(buffer, label);
    rememberCurrentRomFromUrl(url, label);
  } catch (error) {
    console.error(error);
    nes = null;
    currentRoomRom = null;
    updateControls(false);
    document.body.classList.remove("has-game");
    drawBootScreen();
    setStatus(formatRomError(error));
  } finally {
    setLibraryBusy(false);
  }
}

function syncUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sync`;
}

function sendSync(message) {
  if (!sync.socket || sync.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    sync.socket.send(JSON.stringify(message));
  } catch (error) {
    console.warn(error);
    forceSyncReconnect("send-failed");
  }
}

function clearReconnectTimer() {
  if (sync.reconnectTimer) {
    window.clearTimeout(sync.reconnectTimer);
    sync.reconnectTimer = 0;
  }
}

function scheduleRoomReconnect(room = rememberedRoom()) {
  const code = normalizeRoomCode(room);
  if (!code || sync.connected || sync.manualLeave) return;

  clearReconnectTimer();
  els.roomInput.value = code;
  sync.reconnectTimer = window.setTimeout(() => {
    sync.reconnectTimer = 0;
    if (!sync.connected && !document.hidden && !sync.manualLeave) {
      joinRoom(code, { auto: true });
    }
  }, 800);
}

function forceSyncReconnect(reason = "timeout") {
  if (sync.manualLeave) return;

  const room = normalizeRoomCode(sync.room || rememberedRoom());
  if (!room) return;

  debugSync("force-reconnect", { reason, room });
  const socket = sync.socket;
  try {
    socket?.close();
  } catch (error) {
    console.warn(error);
  }

  resetSyncState(
    reason === "timeout" ? "同步连接超时，准备重连" : "同步已断开，准备重连",
    { keepRoom: room },
  );
  scheduleRoomReconnect(room);
}

function stopLatencyProbe() {
  if (sync.pingTimer) {
    window.clearInterval(sync.pingTimer);
    sync.pingTimer = 0;
  }
  sync.pendingPings.clear();
  sync.latencyMs = 0;
  sync.maxLatencyMs = 0;
  sync.serverClockOffsetMs = 0;
  sync.hasClockSync = false;
}

function beginSyncStateWait(reason = "resync", mandatory = true) {
  const now = performance.now();
  if (!sync.awaitingState) {
    sync.stateWaitStartedAt = now;
  }
  sync.awaitingState = true;
  sync.stateWaitMandatory = mandatory;
  sync.stateWaitReason = reason;
  setStatus("等待最新状态");
  debugSync("state-wait", {
    frame: sync.frame,
    mandatory,
    reason,
  });
}

function clearSyncStateWait() {
  sync.awaitingState = false;
  sync.stateWaitMandatory = false;
  sync.stateWaitReason = "";
  sync.stateWaitStartedAt = 0;
}

function resetSyncFrameState() {
  sync.frame = 0;
  sync.inputFrames.clear();
  sync.lastAppliedStateKey = "";
  sync.lastAckFrame = -1;
  sync.lastServerFrame = 0;
  sync.lastResumeSyncAt = 0;
  clearSyncStateWait();
  sync.resyncRequestedAt = 0;
  sync.lastHashFrame = -1;
}

function makePingId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function inLatencyResumeGrace() {
  return (
    sync.resumedAt > 0 &&
    performance.now() - sync.resumedAt < RESUME_LATENCY_GRACE_MS
  );
}

function markLatencyResume() {
  sync.pendingPings.clear();
  sync.resumedAt = performance.now();
}

function oldestPendingPingAge(now = performance.now()) {
  let oldest = 0;
  for (const sentAt of sync.pendingPings.values()) {
    if (!oldest || sentAt < oldest) oldest = sentAt;
  }
  return oldest ? now - oldest : 0;
}

function sendLatencyPing() {
  if (!sync.connected || !sync.socket || document.hidden) {
    return;
  }

  if (sync.socket.readyState !== WebSocket.OPEN) {
    forceSyncReconnect("timeout");
    return;
  }

  const now = performance.now();
  if (oldestPendingPingAge(now) > SOCKET_STALE_MS) {
    if (sync.lastMessageAt && now - sync.lastMessageAt <= SOCKET_STALE_MS) {
      sync.pendingPings.clear();
    } else {
      forceSyncReconnect("timeout");
    }
    return;
  }

  if (sync.lastMessageAt && now - sync.lastMessageAt > SOCKET_STALE_MS * 2) {
    forceSyncReconnect("timeout");
    return;
  }

  if (sync.pendingPings.size > 8) {
    forceSyncReconnect("timeout");
    return;
  }

  const id = makePingId();
  const clientTime = now;
  sync.pendingPings.set(id, clientTime);
  sendSync({ type: "ping", id, clientTime });
}

function startLatencyProbe() {
  stopLatencyProbe();
  sendLatencyPing();
  sync.pingTimer = window.setInterval(
    sendLatencyPing,
    LATENCY_PROBE_INTERVAL,
  );
}

function handleLatencyPong(message) {
  const id = String(message.id || "");
  const sentAt = sync.pendingPings.get(id);
  if (typeof sentAt !== "number") return;

  sync.pendingPings.delete(id);
  sync.lastPongAt = performance.now();
  if (document.hidden || sync.paused || inLatencyResumeGrace()) {
    return;
  }

  const rttMs = Math.max(0, performance.now() - sentAt);
  if (!Number.isFinite(rttMs) || rttMs <= 0 || rttMs > MAX_ACCEPTED_RTT_MS) {
    return;
  }

  const measuredLatencyMs = rttMs / 2;
  sync.latencyMs = sync.latencyMs
    ? sync.latencyMs * 0.7 + measuredLatencyMs * 0.3
    : measuredLatencyMs;

  const serverTime = Number(message.serverTime);
  if (Number.isFinite(serverTime)) {
    const offsetMs = serverTime + measuredLatencyMs - Date.now();
    sync.serverClockOffsetMs = sync.hasClockSync
      ? sync.serverClockOffsetMs * 0.8 + offsetMs * 0.2
      : offsetMs;
    sync.hasClockSync = true;
  }

  sendSync({ type: "latency", rttMs: Math.round(sync.latencyMs * 2) });
}

function resetSyncState(message = "未进入房间", options = {}) {
  const remembered = options.keepRoom
    ? normalizeRoomCode(options.keepRoom || sync.room || rememberedRoom())
    : "";
  stopLatencyProbe();
  resetSyncFrameState();
  sync.clientId = "";
  sync.connected = false;
  sync.hasClockSync = false;
  sync.hostId = "";
  sync.inputDelayMs = 0;
  sync.lastMessageAt = 0;
  sync.lastPongAt = 0;
  sync.lastAppliedStateKey = "";
  sync.lastResumeSyncAt = 0;
  sync.lastServerFrame = 0;
  sync.latencyMs = 0;
  sync.maxLatencyMs = 0;
  sync.paused = false;
  sync.stalled = false;
  clearSyncStateWait();
  sync.pendingState = null;
  sync.peerCount = 0;
  sync.readyCount = 0;
  sync.role = 0;
  sync.room = options.keepRoom ? remembered : "";
  sync.serverClockOffsetMs = 0;
  sync.socket = null;
  sync.stateAppliedAt = 0;
  sync.lastSnapshotSentAt = 0;
  sync.lastSnapshotSentFrame = -1;
  sync.snapshotFrames = 0;
  sync.lastHashFrame = -1;
  sync.lastAckFrame = -1;
  sync.resyncRequestedAt = 0;
  sync.started = false;
  if (remembered) els.roomInput.value = remembered;
  els.syncRoleLabel.textContent = message;
  updateSyncUi();
}

function connectSyncSocket() {
  if (sync.socket && sync.socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  clearReconnectTimer();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(syncUrl());
    sync.socket = socket;
    let settled = false;

	    socket.addEventListener("open", () => {
	      settled = true;
	      sync.lastMessageAt = performance.now();
	      sync.lastPongAt = sync.lastMessageAt;
	      sync.manualLeave = false;
      debugSync("socket-open");
	      resolve();
	    });

	    socket.addEventListener("message", (event) => {
	      if (socket !== sync.socket) return;
	      handleSyncMessage(event.data);
	    });

	    socket.addEventListener("close", () => {
	      if (socket !== sync.socket) return;
	      const room = sync.room || rememberedRoom();
	      const shouldReconnect = !sync.manualLeave && Boolean(room);
      debugSync("socket-close", { room, shouldReconnect });
      resetSyncState(
        shouldReconnect ? "同步已断开，准备重连" : "同步已断开",
        { keepRoom: shouldReconnect ? room : "" },
      );
      if (shouldReconnect) {
        scheduleRoomReconnect(room);
      }
	    });

	    socket.addEventListener("error", () => {
	      if (socket !== sync.socket) return;
	      if (!settled) reject(new Error("同步服务连接失败"));
	      setStatus("同步服务未启动");
    });
  });
}

async function createRoom() {
  try {
    sync.manualLeave = false;
    setStatus("连接同步服务");
    await connectSyncSocket();
    sendSync({ type: "create", token: await ensureUniqueClientToken() });
  } catch (error) {
    console.error(error);
    setStatus("同步服务未启动");
  }
}

async function joinRoom(roomCode = els.roomInput.value, options = {}) {
  const room = normalizeRoomCode(roomCode);
  if (!room) {
    setStatus("输入房间码");
    return;
  }

  try {
    sync.manualLeave = false;
    els.roomInput.value = room;
    setStatus(options.auto ? "自动回到房间" : "加入房间");
    await connectSyncSocket();
    sendSync({ type: "join", room, token: await ensureUniqueClientToken() });
  } catch (error) {
    console.error(error);
    setStatus("同步服务未启动");
  }
}

function leaveRoom() {
  sync.manualLeave = true;
  clearReconnectTimer();
  forgetRoom();
  sync.socket?.close();
  resetSyncState();
}

function updateRoomUrl(room) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", room);
  window.history.replaceState({}, "", url);
}

function selectRoomRom(url, label) {
  if (!sync.connected) {
    loadBundledRom(url, label);
    return;
  }

  if (sync.role < 1) {
    setStatus("观战不能选择游戏");
    return;
  }

  stopEmulation("通知房间");
  releaseAllInputs();
  rememberCurrentRomFromUrl(url, label);
  sendSync({ type: "select-rom", url, label });
}

async function selectRoomRomFile(file) {
  if (!sync.connected || sync.role < 1) {
    setStatus("进入房间后再同步上传");
    return;
  }

  stopEmulation("同步上传 ROM");
  releaseAllInputs();
  setLibraryBusy(true);

  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (
      bytes.length < 16 ||
      bytes[0] !== 0x4e ||
      bytes[1] !== 0x45 ||
      bytes[2] !== 0x53 ||
      bytes[3] !== 0x1a
    ) {
      throw new Error("Not an iNES ROM");
    }

    rememberCurrentRomFromBuffer(buffer, file.name);
    sendSync({
      type: "select-rom-data",
      data: arrayBufferToBase64(buffer),
      label: file.name,
      size: buffer.byteLength,
    });
  } catch (error) {
    console.error(error);
    currentRoomRom = null;
    setStatus(formatRomError(error));
  } finally {
    setLibraryBusy(false);
  }
}

async function loadRoomRom(message) {
  const label = message.label || "ROM";
  const roomWasStarted = Boolean(message.started);
  const roomWasPaused = Boolean(message.paused);
  const needsState = roomWasStarted || Boolean(message.needsState);
  stopEmulation("同步载入中");
  releaseAllInputs();
  resetSyncFrameState();
  setLibraryBusy(true);
  sync.started = false;
  updateSyncUi();

  try {
    const buffer =
      message.mode === "data" || message.data
        ? base64ToArrayBuffer(message.data)
        : await fetchRomBuffer(message.url);
    setRomKeyFromLabel(`${sync.room}-${label}`, buffer.byteLength);
    await loadRomBuffer(buffer, label, {
      autoStart: false,
      status: "已加载，等待同步开始",
    });
    if (message.mode === "data" || message.data) {
      currentRoomRom = {
        data: message.data,
        label,
        mode: "data",
        size: Number(message.size) || buffer.byteLength,
      };
    } else {
      rememberCurrentRomFromUrl(message.url, label);
    }
    sync.started = roomWasStarted;
    sync.paused = roomWasPaused;
    if (needsState) {
      beginSyncStateWait(roomWasStarted ? "join" : "cached", true);
    }
    updateSyncUi();
    if (sync.pendingState) {
      applySyncState(sync.pendingState);
      sync.pendingState = null;
    }
    sendSync({ type: "ready" });
    if (needsState && sync.awaitingState) {
      requestResyncIfNeeded(true);
    }
  } catch (error) {
    console.error(error);
    currentRoomRom = null;
    setStatus(formatRomError(error));
  } finally {
    setLibraryBusy(false);
  }
}

function startSynchronizedGame(message = {}) {
  const startMessage =
    typeof message === "object" && message !== null
      ? message
      : { delayMs: Number(message) || 1000 };
  const fallbackDelayMs = Number(startMessage.delayMs) || 1000;
  const startAt = Number(startMessage.startAt);
  let delayMs = fallbackDelayMs;

  if (Number.isFinite(Number(startMessage.inputDelayMs))) {
    sync.inputDelayMs = Math.max(0, Number(startMessage.inputDelayMs));
  }

  if (Number.isFinite(Number(startMessage.maxLatencyMs))) {
    sync.maxLatencyMs = Math.max(0, Number(startMessage.maxLatencyMs));
  }

  if (sync.hasClockSync && Number.isFinite(startAt)) {
    delayMs = startAt - (Date.now() + sync.serverClockOffsetMs);
  }

  sync.started = true;
  resetSyncFrameState();
  updateSyncUi();
  setStatus("同步倒计时");
  setTimeout(() => {
    if (!nes || sync.paused || document.hidden) return;
    sync.snapshotFrames = 0;
    startEmulation("同步中");
  }, Math.max(0, delayMs));
}

function storeSyncInputFrame(message) {
  const frame = Math.max(0, Math.floor(Number(message.frame) || 0));
  if (frame < sync.frame) return;
  sync.lastServerFrame = Math.max(sync.lastServerFrame, frame);
  if (Number.isFinite(Number(message.inputDelayMs))) {
    sync.inputDelayMs = Math.max(0, Number(message.inputDelayMs));
  }
  if (Number.isFinite(Number(message.maxLatencyMs))) {
    sync.maxLatencyMs = Math.max(0, Number(message.maxLatencyMs));
  }

  const inputs = message.inputs || {};
  sync.inputFrames.set(frame, {
    1: Number(inputs[1] ?? inputs["1"] ?? 0) & 0xff,
    2: Number(inputs[2] ?? inputs["2"] ?? 0) & 0xff,
  });
  updateSyncUi();
}

function storeSyncInputFrames(message) {
  if (Number.isFinite(Number(message.serverFrame))) {
    sync.lastServerFrame = Math.max(sync.lastServerFrame, Number(message.serverFrame));
  }
  if (Number.isFinite(Number(message.inputDelayMs))) {
    sync.inputDelayMs = Math.max(0, Number(message.inputDelayMs));
  }
  if (Number.isFinite(Number(message.maxLatencyMs))) {
    sync.maxLatencyMs = Math.max(0, Number(message.maxLatencyMs));
  }

  const frames = Array.isArray(message.frames) ? message.frames : [];
  for (const item of frames) {
    if (!Array.isArray(item) || item.length < 3) continue;
    const frame = Math.max(0, Math.floor(Number(item[0]) || 0));
    if (frame < sync.frame) continue;
    sync.lastServerFrame = Math.max(sync.lastServerFrame, frame);
    sync.inputFrames.set(frame, {
      1: Number(item[1] || 0) & 0xff,
      2: Number(item[2] || 0) & 0xff,
    });
  }
  updateSyncUi();
}

function applySyncInputMask(player, mask) {
  for (const button of BUTTON_ORDER) {
    if (BUTTONS[button] === undefined) continue;
    setButton(
      player,
      button,
      Boolean(mask & BUTTON_MASKS[button]),
      `sync-frame:${player}:${button}`,
      { remote: true },
    );
  }
}

function applyNextSyncInputFrame() {
  if (!sync.connected || !sync.started) return true;

  if (waitForSyncState()) return false;

  const inputFrame = sync.inputFrames.get(sync.frame);
  if (!inputFrame) {
    setStatus("等待同步数据");
    return false;
  }

  sync.inputFrames.delete(sync.frame);
  if (els.statusText.textContent === "等待同步数据") {
    setStatus("同步中");
  }
  applySyncInputMask(1, inputFrame[1]);
  applySyncInputMask(2, inputFrame[2]);
  return true;
}

function waitForSyncState() {
  if (!sync.awaitingState) return false;

  const now = performance.now();
  if (
    sync.connected &&
    sync.stateWaitStartedAt > 0 &&
    now - sync.stateWaitStartedAt > STATE_WAIT_RECONNECT_MS
  ) {
    debugSync("state-wait-timeout", {
      frame: sync.frame,
      reason: sync.stateWaitReason,
      waitedMs: Math.round(now - sync.stateWaitStartedAt),
    });
    forceSyncReconnect("state-timeout");
    return true;
  }

  if (
    sync.connected &&
    sync.started &&
    sync.role > 0 &&
    now - sync.resyncRequestedAt > RESYNC_WAIT_MS
  ) {
    sync.resyncRequestedAt = now;
    sendSync({
      type: "resync-request",
      frame: sync.frame,
      reason: sync.stateWaitReason || "state-wait",
      serverFrame: maxBufferedInputFrame(),
    });
  }
  setStatus("等待最新状态");
  return true;
}

function contiguousSyncInputFrames() {
  let count = 0;
  while (sync.inputFrames.has(sync.frame + count)) {
    count += 1;
  }
  return count;
}

function stepNesFrame() {
  nes.frame();
  if (sync.connected && sync.started) {
    sync.frame += 1;
    if (sync.frame % FRAME_ACK_INTERVAL_FRAMES === 0) {
      sendFrameAck("frame");
    }
  }
  maybeSendSyncSnapshot();
  maybeSendSyncHash();
  framesThisSecond += 1;
}

function tickOnline() {
  if (sync.paused || waitForSyncState()) {
    rafId = requestAnimationFrame(tick);
    return;
  }

  const backlog = contiguousSyncInputFrames();
  if (backlog === 0 && maxBufferedInputFrame() > sync.frame) {
    requestResyncIfNeeded(true);
    rafId = requestAnimationFrame(tick);
    return;
  }

  if (backlog > RESYNC_BACKLOG_FRAMES) {
    requestResyncIfNeeded(true, false);
  }

  const maxSteps =
    backlog > ONLINE_CATCHUP_BACKLOG_FRAMES
      ? ONLINE_CATCHUP_FRAMES_PER_TICK
      : ONLINE_STEADY_FRAMES_PER_TICK;
  const steps = Math.min(backlog, maxSteps);

  for (let index = 0; index < steps; index += 1) {
    if (!applyNextSyncInputFrame()) break;
    stepNesFrame();
  }

  if (steps === 0 && sync.stalled) {
    setStatus("等待对方网络");
  } else if (steps === 0) {
    setStatus("等待同步数据");
  } else if (els.statusText.textContent === "等待同步数据") {
    setStatus("同步中");
  } else if (els.statusText.textContent === "等待对方网络") {
    setStatus("同步中");
  }

  rafId = requestAnimationFrame(tick);
}

function maybeSendSyncSnapshot() {
  if (AUTHORITATIVE_STATE_INTERVAL_FRAMES <= 0) {
    return;
  }

  if (
    !sync.connected ||
    sync.role !== 1 ||
    sync.peerCount < 2 ||
    !running ||
    !nes
  ) {
    return;
  }

  sync.snapshotFrames += 1;
  if (sync.snapshotFrames < AUTHORITATIVE_STATE_INTERVAL_FRAMES) return;
  sync.snapshotFrames = 0;

  try {
    const state = captureSyncState();
    const hash = hashSyncState(state);
    debugSync("state-send", {
      frame: sync.frame,
      hash,
      reason: "authoritative",
      role: sync.role,
    });
    sendSync({
      type: "state",
      frame: sync.frame,
      hash,
      reason: "authoritative",
      state,
    });
  } catch (error) {
    console.warn(error);
  }
}

function maybeSendSyncHash() {
  if (
    STATE_HASH_INTERVAL_FRAMES <= 0 ||
    !sync.connected ||
    !sync.started ||
    sync.role < 1 ||
    sync.peerCount < 2 ||
    !running ||
    !nes
  ) {
    return;
  }

  if (
    sync.frame <= 0 ||
    sync.frame % STATE_HASH_INTERVAL_FRAMES !== 0 ||
    sync.lastHashFrame === sync.frame
  ) {
    return;
  }
  sync.lastHashFrame = sync.frame;

  try {
    const state = captureSyncState();
    const hash = hashSyncState(state);
    debugSync("hash-send", {
      frame: sync.frame,
      hash,
      role: sync.role,
    });
    sendSync({
      type: "state-hash",
      frame: sync.frame,
      hash,
    });
  } catch (error) {
    console.warn(error);
  }
}

function pruneSyncInputFrames(frame) {
  for (const inputFrame of Array.from(sync.inputFrames.keys())) {
    if (inputFrame < frame) {
      sync.inputFrames.delete(inputFrame);
    }
  }
}

function applySyncState(message) {
  const fromSelf = Boolean(message?.from && message.from === sync.clientId);
  if (
    fromSelf &&
    !sync.awaitingState &&
    !message.cached &&
    !message.realign
  ) {
    return;
  }

  const state = message?.state;
  const frame = Number(message?.frame);
  if (!sync.connected || !state) {
    return;
  }
  if (!nes) {
    sync.pendingState = message;
    return;
  }
  if (!Number.isFinite(frame)) {
    return;
  }
  const reason = String(message.reason || "");
  const authoritative = Boolean(message.authoritative) || reason === "authoritative";
  const canApplyOlderState = Boolean(message.realign);
  const stateKey = message.stateSeq
    ? `seq:${message.stateSeq}`
    : `frame:${frame}:hash:${message.hash || ""}:reason:${reason}`;
  if (stateKey === sync.lastAppliedStateKey) {
    debugSync("state-skip-duplicate", {
      frame,
      reason,
      stateKey,
    });
    return;
  }

  const mustRealign =
    sync.awaitingState ||
    sync.paused ||
    reason === "hash-mismatch" ||
    reason === "history-gap";
  if (frame < sync.frame && (!canApplyOlderState || !mustRealign)) {
    debugSync("state-skip-stale", {
      authoritative,
      frame,
      localFrame: sync.frame,
      realign: canApplyOlderState,
      reason,
    });
    return;
  }
  if (message.inputHistoryGap) {
    debugSync("state-skip-history-gap", {
      frame,
      localFrame: sync.frame,
      reason,
      serverFrame: message.serverFrame,
    });
    beginSyncStateWait("history-gap", true);
    requestResyncIfNeeded(true, true, "history-gap");
    return;
  }

  try {
    const localFrameBeforeApply = sync.frame;
    state.romData = currentRomData;
    nes.fromJSON(state);
    sync.frame = frame;
    sync.lastAppliedStateKey = stateKey;
    sync.lastServerFrame = Math.max(sync.lastServerFrame, frame);
    clearSyncStateWait();
    sync.pendingState = null;
    pruneSyncInputFrames(frame);
    if (Array.isArray(message.inputFrames) && message.inputFrames.length > 0) {
      storeSyncInputFrames({
        frames: message.inputFrames,
        inputDelayMs: message.inputDelayMs,
        maxLatencyMs: message.maxLatencyMs,
        serverFrame: message.serverFrame,
      });
    }
    if (message.inputHistoryGap) {
      beginSyncStateWait("history-gap", true);
    }
    sendFrameAck("state");
    sync.stateAppliedAt = performance.now();
    debugSync("state-apply", {
      authoritative,
      frame,
      localFrame: localFrameBeforeApply,
      inputFrames: Array.isArray(message.inputFrames)
        ? message.inputFrames.length
        : 0,
      reason,
    });
    setStatus("已同步最新状态");
    if (
      sync.started &&
      !running &&
      !sync.paused &&
      !sync.awaitingState &&
      !document.hidden
    ) {
      startEmulation("同步中");
    }
  } catch (error) {
    console.warn(error);
  }
}

function sendSyncSnapshot(reason = "resync", to = "") {
  if (!sync.connected || sync.role < 1 || !nes) return;

  try {
    const now = performance.now();
    if (
      sync.lastSnapshotSentAt > 0 &&
      now - sync.lastSnapshotSentAt < 1500 &&
      Math.abs(sync.frame - sync.lastSnapshotSentFrame) <= 5
    ) {
      debugSync("state-skip-duplicate", {
        frame: sync.frame,
        lastFrame: sync.lastSnapshotSentFrame,
        reason,
      });
      return;
    }

    const state = captureSyncState();
    const hash = hashSyncState(state);
    debugSync("state-send", {
      frame: sync.frame,
      hash,
      reason,
      role: sync.role,
    });
    sync.lastSnapshotSentAt = now;
    sync.lastSnapshotSentFrame = sync.frame;
    const message = { type: "state", frame: sync.frame, hash, reason, state };
    if (to) message.to = String(to);
    sendSync(message);
  } catch (error) {
    console.warn(error);
  }
}

function maxBufferedInputFrame() {
  let maxFrame = sync.lastServerFrame || sync.frame;
  for (const frame of sync.inputFrames.keys()) {
    if (frame > maxFrame) maxFrame = frame;
  }
  return maxFrame;
}

function sendFrameAck(reason = "") {
  if (!sync.connected || !sync.started || sync.role < 1) return;
  if (sync.frame === sync.lastAckFrame && reason !== "state") return;

  sync.lastAckFrame = sync.frame;
  sendSync({
    type: "frame-ack",
    bufferedFrames: contiguousSyncInputFrames(),
    frame: sync.frame,
    reason,
  });
}

function requestResyncIfNeeded(force = false, waitForState = true, reason = "resync") {
  if (!sync.connected || !sync.started || sync.role < 1) return false;

  const backlogFrames = maxBufferedInputFrame() - sync.frame;
  const now = performance.now();
  if (
    (force || backlogFrames > RESYNC_BACKLOG_FRAMES) &&
    now - sync.resyncRequestedAt > RESYNC_COOLDOWN_MS
  ) {
    if (waitForState) {
      beginSyncStateWait(reason, true);
    }
    sync.resyncRequestedAt = now;
    sendSync({
      type: "resync-request",
      frame: sync.frame,
      reason,
      serverFrame: maxBufferedInputFrame(),
    });
    if (waitForState) {
      setStatus("等待最新状态");
    }
    return true;
  }
  return false;
}

function pauseSynchronizedGame() {
  sync.paused = true;
  sync.stalled = false;
  updateSyncUi();
  if (running) {
    stopEmulation("同步暂停");
  } else {
    setStatus("同步暂停");
  }
}

function resumeSynchronizedGame() {
  sync.paused = false;
  sync.stalled = false;
  updateSyncUi();
  if (sync.role === 1) {
    clearSyncStateWait();
  }
  if (
    sync.role !== 1 &&
    sync.started &&
    (!sync.stateAppliedAt || performance.now() - sync.stateAppliedAt > RESYNC_WAIT_MS)
  ) {
    requestResyncIfNeeded(true);
  }
  if (sync.awaitingState) {
    return;
  }
  if (nes && sync.started && !running && !document.hidden) {
    startEmulation("同步中");
  }
}

function handleSyncMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    console.warn(error);
    return;
  }

  sync.lastMessageAt = performance.now();

  if (message.type === "pong") {
    handleLatencyPong(message);
    return;
  }

  if (message.type === "joined") {
    sync.clientId = message.id;
    sync.connected = true;
    sync.hostId = message.hostId;
    sync.role = Number(message.role);
    sync.room = message.room;
    rememberRoom(sync.room);
    clearReconnectTimer();
    startLatencyProbe();
    offerCurrentRomToRoom();
    updateSyncUi();
    debugSync("joined", {
      id: sync.clientId,
      role: sync.role,
      room: sync.room,
    });
    setStatus(`${roleText(sync.role)} 已进入房间`);
    return;
  }

  if (message.type === "room") {
    sync.hostId = message.hostId;
    sync.inputDelayMs = Math.max(0, Number(message.inputDelayMs) || 0);
    sync.maxLatencyMs = Math.max(0, Number(message.maxLatencyMs) || 0);
    sync.paused = Boolean(message.paused);
    sync.peerCount = Array.isArray(message.clients) ? message.clients.length : 0;
    sync.readyCount = Array.isArray(message.clients)
      ? message.clients.filter((client) => client.ready).length
      : 0;
    sync.stalled = Boolean(message.stalled);
    sync.started = Boolean(message.started);
    updateSyncUi();
    debugSync("room", {
      clients: sync.peerCount,
      maxLatencyMs: sync.maxLatencyMs,
      paused: sync.paused,
      ready: sync.readyCount,
      started: sync.started,
    });
    return;
  }

  if (message.type === "rom") {
    loadRoomRom(message);
    return;
  }

  if (message.type === "start") {
    startSynchronizedGame(message);
    return;
  }

  if (message.type === "pause") {
    pauseSynchronizedGame();
    return;
  }

  if (message.type === "resume") {
    resumeSynchronizedGame();
    return;
  }

  if (message.type === "stall") {
    sync.stalled = true;
    updateSyncUi();
    setStatus("等待对方网络");
    return;
  }

  if (message.type === "unstall") {
    sync.stalled = false;
    updateSyncUi();
    if (els.statusText.textContent === "等待对方网络") {
      setStatus("同步中");
    }
    return;
  }

  if (message.type === "input-frame") {
    storeSyncInputFrame(message);
    return;
  }

  if (message.type === "input-frames") {
    storeSyncInputFrames(message);
    return;
  }

  if (message.type === "state") {
    applySyncState(message);
    return;
  }

  if (message.type === "state-unavailable") {
    debugSync("state-unavailable", {
      reason: message.reason || "resync",
    });
    setStatus("等待对方同步状态");
    return;
  }

  if (message.type === "desync") {
    beginSyncStateWait("hash-mismatch", true);
    requestResyncIfNeeded(true);
    setStatus("检测到不同步，拉取状态");
    return;
  }

  if (message.type === "resync-request") {
    sendSyncSnapshot("resync");
    return;
  }

  if (message.type === "state-request") {
    sendSyncSnapshot(message.reason || "resync", message.to || "");
    return;
  }

  if (message.type === "error") {
    setStatus(message.message || "同步错误");
    if (message.message === "房间不存在") {
      clearReconnectTimer();
      forgetRoom();
      resetSyncState(message.message);
    }
  }
}

function resetGame() {
  if (!nes) {
    return;
  }

  audio?.reset();
  nes.reset();
  setStatus("已重置");
  if (!running) {
    startEmulation();
  }
}

function saveState() {
  if (!nes || !currentRomKey) {
    return;
  }

  try {
    localStorage.setItem(currentRomKey, JSON.stringify(nes.toJSON()));
    setStatus("状态已保存");
    updateControls(true);
  } catch (error) {
    console.error(error);
    setStatus("保存失败");
  }
}

function loadState() {
  if (!nes || !currentRomKey) {
    return;
  }

  const saved = localStorage.getItem(currentRomKey);
  if (!saved) {
    setStatus("没有存档");
    return;
  }

  try {
    audio?.reset();
    nes.fromJSON(JSON.parse(saved));
    setStatus("状态已读取");
    if (!running) {
      startEmulation();
    }
  } catch (error) {
    console.error(error);
    setStatus("读取失败");
  }
}

function setMuted(nextMuted) {
  muted = nextMuted;
  els.muteButton.textContent = muted ? "🔇" : "🔈";
  els.muteButton.title = muted ? "取消静音" : "静音";
  if (!muted) {
    resumeAudio();
  }
}

function isEditableTarget(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || target?.isContentEditable;
}

function bindKeyboard() {
  window.addEventListener("keydown", (event) => {
    if (isEditableTarget(event.target)) {
      return;
    }

    const mapping = KEYBOARD.get(event.code);
    if (!mapping || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    event.preventDefault();
    if (keySources.has(event.code)) {
      return;
    }

    const [player, button] = mapping;
    const source = `key:${event.code}`;
    keySources.set(event.code, { player, button, source });
    setButton(player, button, true, source);
  });

  window.addEventListener("keyup", (event) => {
    if (isEditableTarget(event.target)) {
      return;
    }

    const sourceInfo = keySources.get(event.code);
    if (!sourceInfo) {
      return;
    }

    event.preventDefault();
    setButton(sourceInfo.player, sourceInfo.button, false, sourceInfo.source);
    keySources.delete(event.code);
  });

  window.addEventListener("blur", () => {
    if (sync.connected) {
      releaseLocalSyncInputs();
      keySources.clear();
      gamepadSources[1].clear();
      gamepadSources[2].clear();
    } else {
      releaseAllInputs();
    }
  });
}

function bindVirtualPads() {
  const dpadPointers = new Map();

  const blockPadDefault = (event) => {
    event.preventDefault();
    window.getSelection?.()?.removeAllRanges();
  };
  const blockPadOptions = { capture: true, passive: false };

  const dpadButtonsForPoint = (dpad, event) => {
    const rect = dpad.getBoundingClientRect();
    const halfWidth = Math.max(1, rect.width / 2);
    const halfHeight = Math.max(1, rect.height / 2);
    const x = (event.clientX - rect.left - halfWidth) / halfWidth;
    const y = (event.clientY - rect.top - halfHeight) / halfHeight;
    const deadZone = 0.22;
    const buttons = new Set();

    if (x <= -deadZone) buttons.add("LEFT");
    if (x >= deadZone) buttons.add("RIGHT");
    if (y <= -deadZone) buttons.add("UP");
    if (y >= deadZone) buttons.add("DOWN");
    return buttons;
  };

  const updateDpadPointer = (dpad, event) => {
    const pad = dpad.closest(".pad");
    const player = Number(pad.dataset.player);
    const source = `touch:${event.pointerId}`;
    const key = `${player}:${event.pointerId}`;
    const previous = dpadPointers.get(key) || new Set();
    const next = dpadButtonsForPoint(dpad, event);

    for (const button of previous) {
      if (!next.has(button)) {
        setButton(player, button, false, source);
      }
    }
    for (const button of next) {
      if (!previous.has(button)) {
        setButton(player, button, true, source);
      }
    }

    dpadPointers.set(key, next);
  };

  const releaseDpadPointer = (dpad, event) => {
    const pad = dpad.closest(".pad");
    const player = Number(pad.dataset.player);
    const source = `touch:${event.pointerId}`;
    const key = `${player}:${event.pointerId}`;
    const previous = dpadPointers.get(key);

    if (!previous) return;
    for (const button of previous) {
      setButton(player, button, false, source);
    }
    dpadPointers.delete(key);
  };

  document.querySelectorAll(".controllers, .controllers *").forEach((element) => {
    element.addEventListener("contextmenu", blockPadDefault, blockPadOptions);
    element.addEventListener("dragstart", blockPadDefault, blockPadOptions);
    element.addEventListener("selectstart", blockPadDefault, blockPadOptions);
    element.addEventListener("touchstart", blockPadDefault, blockPadOptions);
    element.addEventListener("touchmove", blockPadDefault, blockPadOptions);
  });

  document.querySelectorAll(".dpad").forEach((dpad) => {
    dpad.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      resumeAudio();
      try {
        dpad.setPointerCapture(event.pointerId);
      } catch {}
      updateDpadPointer(dpad, event);
    });

    dpad.addEventListener("pointermove", (event) => {
      if (!dpadPointers.has(`${Number(dpad.closest(".pad").dataset.player)}:${event.pointerId}`)) {
        return;
      }
      event.preventDefault();
      updateDpadPointer(dpad, event);
    });

    const release = (event) => {
      event.preventDefault();
      releaseDpadPointer(dpad, event);
    };

    dpad.addEventListener("pointerup", release);
    dpad.addEventListener("pointercancel", release);
    dpad.addEventListener("lostpointercapture", release);
  });

  const buttons = Array.from(
    document.querySelectorAll(".pad button[data-button]"),
  ).filter((button) => !button.closest(".dpad"));

  buttons.forEach((button) => {
    const pad = button.closest(".pad");
    const player = Number(pad.dataset.player);
    const nesButton = button.dataset.button;
    const turbo = button.dataset.turbo === "true";
    const sourceForPointer = (pointerId) =>
      `touch:${pointerId}:${player}:${nesButton}:${turbo ? "turbo" : "button"}`;

    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      resumeAudio();
      try {
        button.setPointerCapture(event.pointerId);
      } catch {}
      const source = sourceForPointer(event.pointerId);
      if (turbo) {
        startTurboButton(player, nesButton, source, button);
      } else {
        setButton(player, nesButton, true, source, { visualTarget: button });
      }
    });

    const release = (event) => {
      event.preventDefault();
      const source = sourceForPointer(event.pointerId);
      if (turbo) {
        stopTurboButton(player, nesButton, source);
      } else {
        setButton(player, nesButton, false, source, { visualTarget: button });
      }
    };

    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", (event) => {
      const source = sourceForPointer(event.pointerId);
      if (turbo) {
        stopTurboButton(player, nesButton, source);
      } else {
        setButton(player, nesButton, false, source, { visualTarget: button });
      }
    });
  });
}

function getConnectedGamepads() {
  if (!navigator.getGamepads) {
    return [];
  }

  return Array.from(navigator.getGamepads())
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .slice(0, 2);
}

function desiredButtonsForGamepad(gamepad) {
  const desired = new Set();
  const buttons = gamepad.buttons;
  const axes = gamepad.axes;

  if (buttons[0]?.pressed) desired.add("A");
  if (buttons[1]?.pressed) desired.add("B");
  if (buttons[8]?.pressed) desired.add("SELECT");
  if (buttons[9]?.pressed) desired.add("START");
  if (buttons[12]?.pressed || axes[1] < -0.45) desired.add("UP");
  if (buttons[13]?.pressed || axes[1] > 0.45) desired.add("DOWN");
  if (buttons[14]?.pressed || axes[0] < -0.45) desired.add("LEFT");
  if (buttons[15]?.pressed || axes[0] > 0.45) desired.add("RIGHT");

  return desired;
}

function syncGamepadPlayer(player, gamepad) {
  const sourcePrefix = `gamepad:${player}`;
  const previous = gamepadSources[player];
  const desired = gamepad ? desiredButtonsForGamepad(gamepad) : new Set();

  for (const button of Object.keys(BUTTONS)) {
    const source = `${sourcePrefix}:${button}`;
    const shouldPress = desired.has(button);
    const wasPressed = previous.has(button);

    if (shouldPress === wasPressed) {
      continue;
    }

    if (shouldPress) {
      previous.add(button);
    } else {
      previous.delete(button);
    }
    setButton(player, button, shouldPress, source);
  }
}

function pollGamepads() {
  const pads = getConnectedGamepads();
  syncGamepadPlayer(1, pads[0]);
  syncGamepadPlayer(2, pads[1]);

  if (pads.length === 0) {
    els.gamepadText.textContent = "未连接";
  } else if (pads.length === 1) {
    els.gamepadText.textContent = "1P 已连接";
  } else {
    els.gamepadText.textContent = "1P / 2P 已连接";
  }
}

function bindGamepadEvents() {
  window.addEventListener("gamepadconnected", pollGamepads);
  window.addEventListener("gamepaddisconnected", pollGamepads);
}

function resumeSyncAfterForeground(source = "resume") {
  markLatencyResume();
  debugSync("page-resume", {
    connected: sync.connected,
    lastMessageAgeMs: sync.lastMessageAt
      ? Math.round(performance.now() - sync.lastMessageAt)
      : 0,
    readyState: sync.socket?.readyState,
    room: sync.room || rememberedRoom(),
    source,
  });

  if (!sync.connected) {
    scheduleRoomReconnect();
    return;
  }

  if (!sync.socket || sync.socket.readyState !== WebSocket.OPEN) {
    forceSyncReconnect("timeout");
    return;
  }

  if (
    sync.lastMessageAt &&
    performance.now() - sync.lastMessageAt > RESUME_STALE_RECONNECT_MS
  ) {
    forceSyncReconnect("timeout");
    return;
  }

  const now = performance.now();
  if (now - sync.lastResumeSyncAt < RESUME_SYNC_DEBOUNCE_MS) {
    debugSync("page-resume-skip", {
      sinceMs: Math.round(now - sync.lastResumeSyncAt),
      source,
    });
    window.setTimeout(sendLatencyPing, RESUME_LATENCY_GRACE_MS);
    return;
  }
  sync.lastResumeSyncAt = now;

  sendSync({ type: "visibility", visible: true, frame: sync.frame });
  if (!sync.started) {
    window.setTimeout(sendLatencyPing, RESUME_LATENCY_GRACE_MS);
    return;
  }

  requestResyncIfNeeded(true, true, "resume");
  window.setTimeout(sendLatencyPing, RESUME_LATENCY_GRACE_MS);
  if (!sync.paused && !sync.awaitingState) {
    resumeSynchronizedGame();
  }
}

function handleVisibilityChange() {
  if (!sync.connected) {
    if (!document.hidden) {
      resumeSyncAfterForeground("visibility");
    }
    return;
  }

  if (document.hidden) {
    sync.pendingPings.clear();
    sendSync({ type: "visibility", visible: false, frame: sync.frame });
    if (!sync.started) {
      return;
    }
    releaseLocalSyncInputs();
    keySources.clear();
    gamepadSources[1].clear();
    gamepadSources[2].clear();
    sendSyncSnapshot("background");
    pauseSynchronizedGame();
  } else {
    resumeSyncAfterForeground("visibility");
  }
}

function handlePageResume() {
  if (document.hidden) return;
  resumeSyncAfterForeground("page");
}

function handlePageHide() {
  if (!sync.connected || !sync.started) return;

  sync.pendingPings.clear();
  releaseLocalSyncInputs();
  sendSyncSnapshot("background");
  sendSync({ type: "visibility", visible: false, frame: sync.frame });
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await els.screenWrap.requestFullscreen?.();
  } else {
    await document.exitFullscreen?.();
  }
}

function bindUi() {
	  document.addEventListener("visibilitychange", handleVisibilityChange);
	  window.addEventListener("pageshow", () => {
	    handlePageResume();
	  });
	  window.addEventListener("focus", () => {
	    handlePageResume();
	  });
	  window.addEventListener("pagehide", handlePageHide);

  els.createRoomButton.addEventListener("click", createRoom);
  els.joinRoomButton.addEventListener("click", () => joinRoom());
  els.leaveRoomButton.addEventListener("click", leaveRoom);
  els.roomInput.addEventListener("input", () => {
    els.roomInput.value = els.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  els.roomInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      joinRoom();
    }
  });

  els.romButtons.forEach((button) => {
    button.addEventListener("click", () => {
      loadBundledRom(button.dataset.romUrl, button.dataset.romTitle);
    });
  });

  els.romInput.addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) {
      loadRomFile(file);
    }
  });

  els.runButton.addEventListener("click", () => {
    if (!nes) {
      return;
    }
    if (running) {
      stopEmulation();
    } else {
      startEmulation();
    }
  });

  els.resetButton.addEventListener("click", resetGame);
  els.saveButton.addEventListener("click", saveState);
  els.loadButton.addEventListener("click", loadState);
  els.muteButton.addEventListener("click", () => setMuted(!muted));
  els.fullscreenButton.addEventListener("click", toggleFullscreen);

  document.addEventListener("fullscreenchange", () => {
    els.screenWrap.classList.toggle(
      "is-fullscreen",
      document.fullscreenElement === els.screenWrap,
    );
  });
}

function init() {
  bindUi();
  bindKeyboard();
  bindVirtualPads();
  bindGamepadEvents();
  drawBootScreen();
  updateSyncUi();

  if (!window.jsnes) {
    setStatus("jsnes 未载入");
  }

  const room = rememberedRoom();
  if (room) {
    els.roomInput.value = room;
    joinRoom(room, { auto: true });
  }
}

init();
