#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || getArg("--port") || 8081);
const HOST = process.env.HOST || getArg("--host") || "0.0.0.0";
const ROOT = path.resolve(__dirname, "..");
const APP_VERSION = "v20260621-compat-core-2";
const FRAME_TIME_MS = 1000 / 60;
const FRAME_TIMER_MS = 16;
const INPUT_GUARD_FRAMES = 1;
const INPUT_JITTER_BUFFER_MS = FRAME_TIME_MS * 2;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
const MIN_START_DELAY_MS = 300;
const START_DELAY_BUFFER_MS = 120;
const MAX_REPORTED_RTT_MS = 500;
const LATENCY_SMOOTHING = 0.25;
const HEARTBEAT_INTERVAL_MS = 5000;
const CLIENT_TIMEOUT_MS = 18000;
const STATE_REQUEST_TIMEOUT_MS = 3000;
const INPUT_HISTORY_FRAMES = 60 * 20;
const ROOM_LEAD_BUFFER_FRAMES = 12;
const MIN_STALL_RESUME_BACKLOG_FRAMES = 4;
const STALL_RESUME_BACKLOG_RATIO = 0.5;
const STALL_GRACE_MS = 250;
const CLIENT_TOKEN_RE = /^[A-Za-z0-9_-]{12,80}$/;
const BUTTON_BITS = {
  A: 1 << 0,
  B: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  UP: 1 << 4,
  DOWN: 1 << 5,
  LEFT: 1 << 6,
  RIGHT: 1 << 7,
};

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".nes": "application/octet-stream",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const rooms = new Map();
const clients = new Set();
let nextClientId = 1;

function clientLogInfo(client) {
  if (!client) return null;
  return {
    ackFrame: Math.max(0, Math.floor(Number(client.ackFrame) || 0)),
    id: client.id,
    ready: Boolean(client.ready),
    role: client.role || 0,
    token: client.token ? client.token.slice(0, 6) : "",
    visible: Boolean(client.visible),
  };
}

function roomLogInfo(room) {
  if (!room) return null;
  return {
    code: room.code,
    clients: room.clients?.size || 0,
    cursor: room.inputFrameCursor || 0,
    latestStateFrame: Math.max(
      0,
      Math.floor(Number(room.latestState?.frame) || 0),
    ),
    paused: Boolean(room.paused),
    resumeAfterState: Boolean(room.resumeAfterState),
    stalled: Boolean(room.stalled),
    started: Boolean(room.started),
  };
}

function logSync(event, detail = {}) {
  const payload = {
    event,
    ts: new Date().toISOString(),
    version: APP_VERSION,
    ...detail,
  };
  try {
    console.log("[fc-sync]", JSON.stringify(payload));
  } catch {
    console.log("[fc-sync]", event);
  }
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 4 }, () =>
      alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join("");
  } while (rooms.has(code));
  return code;
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  let relative = decoded === "/" ? "/fc-online-emulator/" : decoded;
  if (relative.endsWith("/")) relative += "index.html";
  const fullPath = path.resolve(ROOT, `.${relative}`);
  if (!fullPath.startsWith(ROOT)) return null;
  return fullPath;
}

function serveStatic(request, response) {
  const filePath = safePath(new URL(request.url, "http://localhost").pathname);
  if (!filePath) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, body) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(body);
  });
}

function websocketAcceptKey(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function sendFrame(client, payload, opcode = 0x1) {
  if (client.socket.destroyed) return;

  const body = Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(body.length, 6);
  }

  client.socket.write(Buffer.concat([header, body]));
}

function sendJson(client, message) {
  sendFrame(client, JSON.stringify(message));
}

function roomClients(room) {
  const now = Date.now();
  return Array.from(room.clients).map((client) => ({
    id: client.id,
    latencyMs: Math.round(client.latencyMs || 0),
    ackFrame: Math.max(0, Math.floor(Number(client.ackFrame) || 0)),
    lastSeenMs: Math.max(0, now - (client.lastSeenAt || now)),
    online:
      !client.socket.destroyed &&
      now - Math.max(client.lastSeenAt || 0, client.lastPongAt || 0) <=
        CLIENT_TIMEOUT_MS,
    role: client.role,
    ready: client.ready,
    visible: client.visible,
  }));
}

function broadcast(room, message, exceptClient = null) {
  for (const client of room.clients) {
    if (client !== exceptClient) sendJson(client, message);
  }
}

function activePlayers(room) {
  return Array.from(room.clients).filter(
    (client) =>
      client.role > 0 &&
      client.ready &&
      client.visible &&
      !client.socket.destroyed,
  );
}

function roomLeadFrames(room) {
  return Math.max(
    ROOM_LEAD_BUFFER_FRAMES,
    room.inputDelayFrames + ROOM_LEAD_BUFFER_FRAMES,
  );
}

function roomResumeBacklogFrames(room) {
  return Math.max(
    MIN_STALL_RESUME_BACKLOG_FRAMES,
    Math.floor(roomLeadFrames(room) * STALL_RESUME_BACKLOG_RATIO),
  );
}

function minAckFrame(room) {
  const players = activePlayers(room);
  if (players.length < 2) return Infinity;
  return Math.min(
    ...players.map((client) =>
      Math.max(0, Math.floor(Number(client.ackFrame) || 0)),
    ),
  );
}

function setRoomStalled(room, stalled, reason = "slow-peer", detail = {}) {
  if (room.stalled === stalled && room.stalledReason === reason) return;

  const wasStalled = room.stalled;
  const now = Date.now();
  const messageDetail = { ...detail };
  if (!wasStalled && stalled) {
    room.stalledAt = now;
  } else if (wasStalled && !stalled) {
    const stalledMs = Math.max(0, now - (room.stalledAt || now));
    if (stalledMs > 0 && room.started && !room.paused) {
      room.startedAt += stalledMs;
      messageDetail.stalledMs = Math.round(stalledMs);
    }
    room.stalledAt = 0;
  }

  room.stalled = stalled;
  if (!stalled) room.stallPendingAt = 0;
  room.stalledReason = stalled ? reason : "";
  logSync(stalled ? "room-stall" : "room-unstall", {
    detail: messageDetail,
    reason,
    room: roomLogInfo(room),
  });
  broadcast(room, {
    type: stalled ? "stall" : "unstall",
    frame: Math.max(0, room.inputFrameCursor - 1),
    reason,
    ...messageDetail,
  });
  broadcastRoomState(room);
}

function roomClientById(room, id) {
  return Array.from(room.clients).find((client) => client.id === id) || null;
}

function stateProviders(room, requester = null) {
  return Array.from(room.clients)
    .filter(
      (client) =>
        client !== requester &&
        client.role > 0 &&
        client.ready &&
        client.visible &&
        !client.socket.destroyed,
    )
    .sort((a, b) => {
      if (a.role !== b.role) return a.role - b.role;
      if (a.id === room.hostId) return -1;
      if (b.id === room.hostId) return 1;
      return a.id.localeCompare(b.id);
    });
}

function requestRoomState(room, requester = null, reason = "resync") {
  const [provider] = stateProviders(room, requester);
  if (!provider) {
    logSync("state-request-miss", {
      reason,
      requester: clientLogInfo(requester),
      room: roomLogInfo(room),
    });
    return 0;
  }

  sendJson(provider, {
    type: "state-request",
    frame: room.inputFrameCursor,
    reason,
    to: requester?.id || "",
  });
  logSync("state-request", {
    provider: clientLogInfo(provider),
    reason,
    requester: clientLogInfo(requester),
    room: roomLogInfo(room),
  });
  return 1;
}

function rememberInputFrame(room, frame, p1Mask, p2Mask) {
  room.inputHistory.set(frame, [frame, p1Mask || 0, p2Mask || 0]);
  const minFrame = frame - INPUT_HISTORY_FRAMES;
  for (const oldFrame of room.inputHistory.keys()) {
    if (oldFrame >= minFrame) break;
    room.inputHistory.delete(oldFrame);
  }
}

function inputFramesFrom(room, frame) {
  const startFrame = Math.max(0, Math.floor(Number(frame) || 0));
  return Array.from(room.inputHistory.entries())
    .filter(([inputFrame]) => inputFrame >= startFrame)
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value);
}

function cachedStateSnapshot(room, stateMessage = room.latestState) {
  const frame = Math.max(0, Math.floor(Number(stateMessage?.frame) || 0));
  const inputFrames = inputFramesFrom(room, frame);
  const inputHistoryGap =
    room.started &&
    room.inputFrameCursor > frame &&
    (inputFrames.length === 0 || inputFrames[0][0] !== frame);
  return {
    frame,
    inputFrames,
    inputHistoryGap,
    lagFrames: room.started ? Math.max(0, room.inputFrameCursor - frame) : 0,
  };
}

function sendLatestRoomState(client, room, options = {}) {
  if (!room.latestState) {
    logSync("state-send-cache-miss", {
      client: clientLogInfo(client),
      reason: options.reason || "cached",
      room: roomLogInfo(room),
    });
    return false;
  }
  const snapshot = cachedStateSnapshot(room);
  const frame = snapshot.frame;
  const inputFrames = snapshot.inputFrames;
  const inputHistoryGap = snapshot.inputHistoryGap;
  const maxLagFrames = Math.max(
    0,
    Math.floor(Number(options.maxLagFrames) || roomLeadFrames(room)),
  );
  const historyGapBlocked = inputHistoryGap && !options.allowHistoryGap;
  if (
    room.started &&
    options.realign !== false &&
    (historyGapBlocked ||
      (!options.allowStale && snapshot.lagFrames > maxLagFrames))
  ) {
    logSync("state-send-cache-skip-stale", {
      client: clientLogInfo(client),
      frame,
      inputHistoryGap,
      lagFrames: snapshot.lagFrames,
      maxLagFrames,
      reason: options.reason || room.latestState.reason || "cached",
      room: roomLogInfo(room),
      stateSeq: room.latestState.stateSeq || 0,
    });
    return false;
  }
  if (
    options.allowSelf === false &&
    room.latestState.from &&
    room.latestState.from === client.id
  ) {
    logSync("state-send-cache-skip-self", {
      client: clientLogInfo(client),
      frame,
      reason: options.reason || room.latestState.reason || "cached",
      room: roomLogInfo(room),
      stateSeq: room.latestState.stateSeq || 0,
    });
    return false;
  }
  sendJson(client, {
    type: "state",
    authoritative: Boolean(room.latestState.authoritative),
    cached: true,
    frame,
    from: room.latestState.from,
    fromRole: room.latestState.fromRole || 0,
    inputDelayMs: Math.round(room.inputDelayMs),
    inputFrames,
    inputHistoryGap,
    maxLatencyMs: Math.round(room.maxLatencyMs),
    realign: Boolean(options.realign ?? true),
    reason: options.reason || room.latestState.reason || "cached",
    serverFrame: Math.max(0, room.inputFrameCursor - 1),
    state: room.latestState.state,
    stateAgeMs: Math.max(0, Date.now() - (room.latestState.createdAt || Date.now())),
    stateSeq: room.latestState.stateSeq || 0,
  });
  if (inputHistoryGap) {
    requestRoomState(room, client, "history-gap");
  }
  client.ackFrame = Math.max(Math.floor(Number(client.ackFrame) || 0), frame);
  client.ackAt = Date.now();
  logSync("state-send-cache", {
    client: clientLogInfo(client),
    frame,
    inputFrames: inputFrames.length,
    inputHistoryGap,
    reason: options.reason || room.latestState.reason || "cached",
    room: roomLogInfo(room),
    stateAgeMs: Math.max(0, Date.now() - (room.latestState.createdAt || Date.now())),
    stateSeq: room.latestState.stateSeq || 0,
  });
  return true;
}

function broadcastLatestRoomState(room, options = {}) {
  let sent = 0;
  for (const client of room.clients) {
    if (sendLatestRoomState(client, room, options)) sent += 1;
  }
  return sent;
}

function cacheRoomState(room, stateMessage) {
  room.latestState = {
    ...stateMessage,
    createdAt: Date.now(),
    stateSeq: ++room.latestStateSeq,
  };
  logSync("state-cache", {
    authoritative: Boolean(stateMessage.authoritative),
    frame: room.latestState.frame,
    from: stateMessage.from,
    fromRole: stateMessage.fromRole || 0,
    reason: stateMessage.reason,
    room: roomLogInfo(room),
    stateSeq: room.latestState.stateSeq,
  });
  return room.latestState;
}

function pruneStateHashes(room, frame) {
  const minFrame = Math.max(0, frame - INPUT_HISTORY_FRAMES);
  for (const oldFrame of room.stateHashes.keys()) {
    if (oldFrame >= minFrame) break;
    room.stateHashes.delete(oldFrame);
  }
}

function handleStateHash(client, room, message) {
  if (!room.started || client.role < 1) return;

  const frame = Math.max(0, Math.floor(Number(message.frame) || 0));
  const hash = String(message.hash || "");
  if (!hash || hash.length > 80) return;

  if (!room.stateHashes.has(frame)) {
    room.stateHashes.set(frame, new Map());
  }
  const frameHashes = room.stateHashes.get(frame);
  frameHashes.set(client.role, {
    clientId: client.id,
    hash,
  });
  pruneStateHashes(room, frame);

  const playerOne = frameHashes.get(1);
  const playerTwo = frameHashes.get(2);
  if (!playerOne || !playerTwo || playerOne.hash === playerTwo.hash) return;

  broadcast(room, {
    type: "desync",
    frame,
    hashes: {
      1: playerOne.hash,
      2: playerTwo.hash,
    },
  });
  broadcastLatestRoomState(room, {
    realign: true,
    reason: "hash-mismatch",
  });
  requestRoomState(room, null, "hash-mismatch");
  room.stateHashes.delete(frame);
}

function getRoom(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return null;
  return rooms.get(normalized) || null;
}

function normalizeClientToken(token) {
  const value = String(token || "").trim();
  return CLIENT_TOKEN_RE.test(value) ? value : "";
}

function createRoom() {
  const code = createRoomCode();
  const room = {
    code,
    clients: new Set(),
    currentRom: null,
    emptyTimer: null,
    frameTimer: null,
    hostId: "",
    inputDelayFrames: 2,
    inputDelayMs: INPUT_JITTER_BUFFER_MS,
    inputFrameCursor: 0,
    inputHistory: new Map(),
    inputMasks: { 1: 0, 2: 0 },
    inputSeq: 0,
    lastInputTargetFrames: new Map(),
    latestState: null,
    latestStateSeq: 0,
    maxLatencyMs: 0,
    paused: false,
    pausedAt: 0,
    pendingInputChanges: new Map(),
    resumeAfterState: false,
    resumeStateTimer: null,
    stateHashes: new Map(),
    stallPendingAt: 0,
    stalled: false,
    stalledAt: 0,
    stalledReason: "",
    startedAt: 0,
    started: false,
  };
  rooms.set(code, room);
  return room;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function recomputeRoomTiming(room, updateInputDelay = !room.started) {
  const players = Array.from(room.clients).filter(
    (client) => client.role > 0 && client.visible,
  );
  const maxLatencyMs = Math.max(
    0,
    ...players.map((client) => Number(client.latencyMs || 0)),
  );

  room.maxLatencyMs = maxLatencyMs;
  if (updateInputDelay) {
    room.inputDelayFrames = Math.max(
      2,
      Math.ceil((maxLatencyMs + INPUT_JITTER_BUFFER_MS) / FRAME_TIME_MS),
    );
    room.inputDelayMs = room.inputDelayFrames * FRAME_TIME_MS;
  }
}

function roomStartDelayMs(room) {
  recomputeRoomTiming(room, true);
  return Math.ceil(
    Math.max(MIN_START_DELAY_MS, room.inputDelayMs + START_DELAY_BUFFER_MS),
  );
}

function stopFrameBroadcast(room) {
  if (room.frameTimer) {
    clearInterval(room.frameTimer);
    room.frameTimer = null;
  }
}

function cancelEmptyRoomDelete(room) {
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
}

function scheduleEmptyRoomDelete(room) {
  cancelEmptyRoomDelete(room);
  room.emptyTimer = setTimeout(() => {
    if (room.clients.size === 0) {
      rooms.delete(room.code);
    }
  }, EMPTY_ROOM_TTL_MS);
}

function resetRoomSync(room) {
  stopFrameBroadcast(room);
  clearResumeStateTimer(room);
  room.inputFrameCursor = 0;
  room.inputHistory.clear();
  room.inputMasks = { 1: 0, 2: 0 };
  room.inputSeq = 0;
  room.lastInputTargetFrames.clear();
  room.paused = false;
  room.pausedAt = 0;
  room.pendingInputChanges.clear();
  room.resumeAfterState = false;
  room.stateHashes.clear();
  room.stallPendingAt = 0;
  room.stalled = false;
  room.stalledAt = 0;
  room.stalledReason = "";
  for (const client of room.clients) {
    client.ackFrame = 0;
    client.ackAt = Date.now();
  }
}

function clearResumeStateTimer(room) {
  if (room.resumeStateTimer) {
    clearTimeout(room.resumeStateTimer);
    room.resumeStateTimer = null;
  }
}

function clearClientStateTimer(client) {
  if (client?.stateRequestTimer) {
    clearTimeout(client.stateRequestTimer);
    client.stateRequestTimer = null;
  }
}

function scheduleClientStateFallback(client, room, reason = "resync") {
  clearClientStateTimer(client);
  client.stateRequestTimer = setTimeout(() => {
    client.stateRequestTimer = null;
    if (client.closed || client.room !== room || !client.visible) return;

    const sent = sendLatestRoomState(client, room, {
      allowStale: true,
      reason: `${reason}-fallback`,
      realign: true,
    });
    logSync("state-request-fallback", {
      client: clientLogInfo(client),
      reason,
      room: roomLogInfo(room),
      sent,
    });
    if (!sent) {
      sendJson(client, {
        type: "state-unavailable",
        reason,
      });
    }
  }, STATE_REQUEST_TIMEOUT_MS);
}

function alignRoomToState(room, stateMessage) {
  const frame = Math.max(0, Math.floor(Number(stateMessage?.frame) || 0));
  room.inputFrameCursor = frame;
  room.lastInputTargetFrames.clear();
  room.pendingInputChanges.clear();
  room.inputHistory.clear();
  room.stateHashes.clear();
  room.stallPendingAt = 0;
  room.stalled = false;
  room.stalledAt = 0;
  room.stalledReason = "";
  for (const client of room.clients) {
    client.ackFrame = frame;
    client.ackAt = Date.now();
  }
}

function roomRomFromMessage(message) {
  const label = String(message.label || "ROM");
  if (message.mode === "data" || message.data) {
    const data = String(message.data || "");
    const size = Number(message.size || 0);
    if (!data || size <= 0 || data.length > 12 * 1024 * 1024) {
      return null;
    }
    return {
      data,
      label,
      mode: "data",
      size,
    };
  }

  const url = String(message.url || "");
  if (!url) return null;
  return {
    label,
    mode: "url",
    url,
  };
}

function setRoomRom(room, rom) {
  room.currentRom = rom;
  room.started = false;
  room.startedAt = 0;
  room.latestState = null;
  room.latestStateSeq = 0;
  resetRoomSync(room);
  for (const peer of room.clients) peer.ready = false;
  logSync("room-rom", {
    mode: room.currentRom.mode,
    label: room.currentRom.label,
    room: roomLogInfo(room),
    size: room.currentRom.size || 0,
    url: room.currentRom.url || "",
  });
  broadcast(room, {
    type: "rom",
    ...room.currentRom,
    needsState: false,
    paused: false,
    started: false,
  });
  broadcastRoomState(room);
}

function applyScheduledInputChanges(room, frame) {
  const changes = room.pendingInputChanges.get(frame) || [];
  room.pendingInputChanges.delete(frame);

  changes
    .sort((a, b) => a.seq - b.seq)
    .forEach((change) => {
      const mask = room.inputMasks[change.role] || 0;
      room.inputMasks[change.role] = change.down
        ? mask | change.bit
        : mask & ~change.bit;
    });
}

function broadcastReadyInputFrames(room) {
  if (!room.started || !room.startedAt || room.paused) return;

  const players = activePlayers(room);
  const hasLockstepPeers = players.length >= 2;
  const ackFrame = minAckFrame(room);
  const leadFrames = roomLeadFrames(room);
  const leadMaxFrame = Number.isFinite(ackFrame)
    ? ackFrame + leadFrames
    : Infinity;

  if (hasLockstepPeers) {
    const generatedFrame = Math.max(0, room.inputFrameCursor - 1);
    const backlogFrames = Math.max(0, generatedFrame - ackFrame);
    const resumeBacklogFrames = roomResumeBacklogFrames(room);

    if (room.stalled) {
      if (
        room.inputFrameCursor > leadMaxFrame ||
        backlogFrames > resumeBacklogFrames
      ) {
        return;
      }
      setRoomStalled(room, false, "ready", {
        backlogFrames,
        leadFrames,
        resumeBacklogFrames,
        slowestFrame: ackFrame,
      });
    } else if (room.inputFrameCursor > leadMaxFrame) {
      if (!room.stallPendingAt) {
        room.stallPendingAt = Date.now();
      }
      const pendingMs = Math.max(0, Date.now() - room.stallPendingAt);
      if (pendingMs < STALL_GRACE_MS) {
        return;
      }
      setRoomStalled(room, true, "slow-peer", {
        backlogFrames,
        leadFrames,
        pendingMs,
        resumeBacklogFrames,
        slowestFrame: ackFrame,
      });
      return;
    } else {
      room.stallPendingAt = 0;
    }
  } else if (room.stalled) {
    setRoomStalled(room, false, "ready");
  } else {
    room.stallPendingAt = 0;
  }

  const elapsedFrames = Math.floor((Date.now() - room.startedAt) / FRAME_TIME_MS);
  const timeMaxFrame = elapsedFrames + room.inputDelayFrames;
  const maxFrame = Math.min(timeMaxFrame, leadMaxFrame);
  const frames = [];

  while (room.inputFrameCursor <= maxFrame) {
    const frame = room.inputFrameCursor;
    applyScheduledInputChanges(room, frame);
    const p1Mask = room.inputMasks[1] || 0;
    const p2Mask = room.inputMasks[2] || 0;
    frames.push([frame, p1Mask, p2Mask]);
    rememberInputFrame(room, frame, p1Mask, p2Mask);
    room.inputFrameCursor += 1;
  }

  if (frames.length > 0) {
    broadcast(room, {
      type: "input-frames",
      frames,
      serverFrame: room.inputFrameCursor - 1,
      inputDelayMs: Math.round(room.inputDelayMs),
      maxLatencyMs: Math.round(room.maxLatencyMs),
    });
  }
}

function startFrameBroadcast(room) {
  stopFrameBroadcast(room);
  room.frameTimer = setInterval(() => broadcastReadyInputFrames(room), FRAME_TIMER_MS);
  broadcastReadyInputFrames(room);
}

function pauseRoom(room, reason = "hidden") {
  if (!room.started || room.paused) return;

  room.paused = true;
  room.pausedAt = Date.now();
  room.stalled = false;
  room.stalledAt = 0;
  room.stalledReason = "";
  stopFrameBroadcast(room);
  logSync("room-pause", {
    reason,
    room: roomLogInfo(room),
  });
  broadcast(room, {
    type: "pause",
    reason,
  });
  requestRoomState(room, null, reason);
  broadcastRoomState(room);
}

function resumeRoomIfReady(room) {
  if (!room.started || !room.paused) return;
  if (room.resumeAfterState) return;

  const players = Array.from(room.clients).filter((client) => client.role > 0);
  if (
    players.length < 2 ||
    players.some((client) => !client.visible || !client.ready)
  ) {
    logSync("room-resume-wait", {
      players: players.map(clientLogInfo),
      room: roomLogInfo(room),
    });
    broadcastRoomState(room);
    return;
  }

  const pausedMs = Math.max(0, Date.now() - room.pausedAt);
  room.startedAt += pausedMs;
  room.paused = false;
  room.pausedAt = 0;
  setRoomStalled(room, false, "resume");
  for (const client of activePlayers(room)) {
    client.ackAt = Date.now();
  }
  broadcast(room, {
    type: "resume",
    frame: room.inputFrameCursor,
    serverTime: Date.now(),
  });
  logSync("room-resume", {
    pausedMs,
    players: activePlayers(room).map(clientLogInfo),
    room: roomLogInfo(room),
  });
  startFrameBroadcast(room);
  broadcastRoomState(room);
}

function requestStateBeforeResume(room, requester = null, reason = "resume") {
  const requested = requestRoomState(room, requester, reason);
  if (requested > 0) {
    room.resumeAfterState = true;
    if (requester) {
      scheduleClientStateFallback(requester, room, reason);
    }
    logSync("room-resume-state-wait", {
      reason,
      requester: clientLogInfo(requester),
      room: roomLogInfo(room),
    });
    clearResumeStateTimer(room);
    room.resumeStateTimer = setTimeout(() => {
      room.resumeStateTimer = null;
      if (!room.resumeAfterState) return;

      if (!room.latestState) {
        room.resumeAfterState = false;
        logSync("room-resume-state-timeout-empty", {
          reason,
          requester: clientLogInfo(requester),
          room: roomLogInfo(room),
        });
        broadcastRoomState(room);
        return;
      }

      room.resumeAfterState = false;
      logSync("room-resume-state-timeout-cache", {
        reason,
        requester: clientLogInfo(requester),
        room: roomLogInfo(room),
      });
      resumeRoomIfReady(room);
      broadcastRoomState(room);
    }, STATE_REQUEST_TIMEOUT_MS);
    return true;
  }
  return false;
}

function assignRole(room) {
  const roles = new Set(Array.from(room.clients).map((client) => client.role));
  if (!roles.has(1)) return 1;
  if (!roles.has(2)) return 2;
  return 0;
}

function clearRoleInputs(room, role) {
  if (role < 1) return;

  room.inputMasks[role] = 0;
  for (const key of Array.from(room.lastInputTargetFrames.keys())) {
    if (String(key).startsWith(`${role}:`)) {
      room.lastInputTargetFrames.delete(key);
    }
  }

  for (const [frame, changes] of Array.from(room.pendingInputChanges.entries())) {
    const filtered = changes.filter((change) => change.role !== role);
    if (filtered.length) {
      room.pendingInputChanges.set(frame, filtered);
    } else {
      room.pendingInputChanges.delete(frame);
    }
  }
}

function replaceDuplicateClient(room, client) {
  if (!client.token) return null;

  const duplicate = Array.from(room.clients).find(
    (item) => item !== client && item.token === client.token,
  );
  if (!duplicate) return null;

  const replacement = {
    role: duplicate.role,
    wasHost: room.hostId === duplicate.id,
  };
  logSync("client-replace", {
    duplicate: clientLogInfo(duplicate),
    incoming: clientLogInfo(client),
    replacement,
    room: roomLogInfo(room),
  });

  clearRoleInputs(room, duplicate.role);
  room.clients.delete(duplicate);
  duplicate.room = null;
  duplicate.role = 0;
  duplicate.ready = false;
  duplicate.closed = true;
  clients.delete(duplicate);
  if (!duplicate.socket.destroyed) {
    duplicate.socket.destroy();
  }

  return replacement;
}

function joinRoom(client, room) {
  leaveRoom(client);
  cancelEmptyRoomDelete(room);

  const replacement = replaceDuplicateClient(room, client);
  client.room = room;
  client.role = replacement?.role || assignRole(room);
  client.ready = false;
  client.visible = true;
  room.clients.add(client);
  if (replacement?.wasHost || (!room.hostId && client.role === 1)) {
    room.hostId = client.id;
  }
  logSync("client-join", {
    client: clientLogInfo(client),
    replacement,
    room: roomLogInfo(room),
  });

  sendJson(client, {
    type: "joined",
    id: client.id,
    room: room.code,
    role: client.role,
    hostId: room.hostId,
  });
  broadcastRoomState(room);

  if (room.currentRom) {
    client.needsStateOnReady = room.started || Boolean(room.latestState);
    sendJson(client, {
      type: "rom",
      ...room.currentRom,
      needsState: room.started || room.clients.size > 1 || Boolean(room.latestState),
      paused: room.paused,
      started: room.started,
    });
  }
}

function leaveRoom(client) {
  if (!client.room) return;

  const room = client.room;
  logSync("client-leave", {
    client: clientLogInfo(client),
    room: roomLogInfo(room),
  });
  clearRoleInputs(room, client.role);
  room.clients.delete(client);
  client.room = null;
  client.role = 0;
  client.ready = false;

  if (room.clients.size === 0) {
    room.hostId = "";
    room.paused = Boolean(room.started);
    room.pausedAt = Date.now();
    stopFrameBroadcast(room);
    clearResumeStateTimer(room);
    scheduleEmptyRoomDelete(room);
    return;
  }

  if (room.hostId === client.id) {
    const playerOne = Array.from(room.clients).find((item) => item.role === 1);
    room.hostId = playerOne?.id || Array.from(room.clients)[0].id;
  }
  if (Array.from(room.clients).filter((item) => item.role > 0).length < 2) {
    pauseRoom(room, "left");
  }
  broadcastRoomState(room);
}

function cleanupClient(client) {
  if (client.closed) return;
  client.closed = true;
  clearClientStateTimer(client);
  clients.delete(client);
  leaveRoom(client);
}

function closeClient(client) {
  cleanupClient(client);
  if (!client.socket.destroyed) {
    client.socket.destroy();
  }
}

function heartbeatClients() {
  const now = Date.now();
  for (const client of clients) {
    if (client.socket.destroyed) {
      logSync("client-heartbeat-destroyed", {
        client: clientLogInfo(client),
        room: roomLogInfo(client.room),
      });
      cleanupClient(client);
      continue;
    }

    const lastSeenAt = Math.max(client.lastSeenAt || 0, client.lastPongAt || 0);
    if (now - lastSeenAt > CLIENT_TIMEOUT_MS) {
      logSync("client-heartbeat-timeout", {
        ageMs: now - lastSeenAt,
        client: clientLogInfo(client),
        room: roomLogInfo(client.room),
      });
      closeClient(client);
      continue;
    }

    try {
      sendFrame(client, "", 0x9);
    } catch {
      closeClient(client);
    }
  }
}

function broadcastRoomState(room) {
  recomputeRoomTiming(room);

  const currentRom = room.currentRom
    ? {
        label: room.currentRom.label,
        mode: room.currentRom.mode,
        size: room.currentRom.size || 0,
        url: room.currentRom.url || "",
      }
    : null;

  broadcast(room, {
    type: "room",
    room: room.code,
    hostId: room.hostId,
    clients: roomClients(room),
    currentRom,
    inputDelayMs: Math.round(room.inputDelayMs),
    maxLatencyMs: Math.round(room.maxLatencyMs),
    paused: room.paused,
    stalled: room.stalled,
    stalledReason: room.stalledReason,
    started: room.started,
  });
}

function maybeStartRoom(room) {
  const players = Array.from(room.clients).filter((client) => client.role > 0);
  const readyPlayers = players.filter((client) => client.ready);
  if (!room.currentRom || room.started) return;
  if (players.length < 2 || readyPlayers.length < 2) return;

  const startDelayMs = roomStartDelayMs(room);
  resetRoomSync(room);
  room.started = true;
  room.startedAt = Date.now() + startDelayMs;
  for (const client of activePlayers(room)) {
    client.ackFrame = 0;
    client.ackAt = Date.now();
  }
  logSync("room-start", {
    inputDelayFrames: room.inputDelayFrames,
    inputDelayMs: Math.round(room.inputDelayMs),
    maxLatencyMs: Math.round(room.maxLatencyMs),
    players: activePlayers(room).map(clientLogInfo),
    room: roomLogInfo(room),
    startDelayMs,
  });
  broadcast(room, {
    type: "start",
    delayMs: startDelayMs,
    inputDelayFrames: room.inputDelayFrames,
    inputDelayMs: Math.round(room.inputDelayMs),
    maxLatencyMs: Math.round(room.maxLatencyMs),
    serverTime: Date.now(),
    startAt: room.startedAt,
  });
  startFrameBroadcast(room);
  broadcastRoomState(room);
}

function handleMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    sendJson(client, { type: "error", message: "Bad message" });
    return;
  }

  if (message.type === "create") {
    client.token = normalizeClientToken(message.token) || client.token;
    joinRoom(client, createRoom());
    return;
  }

  if (message.type === "join") {
    client.token = normalizeClientToken(message.token) || client.token;
    const room = getRoom(message.room);
    if (!room) {
      sendJson(client, { type: "error", message: "房间不存在" });
      return;
    }
    joinRoom(client, room);
    return;
  }

  const room = client.room;
  if (!room) {
    sendJson(client, { type: "error", message: "还没有进入房间" });
    return;
  }

  if (message.type === "ping") {
    sendJson(client, {
      type: "pong",
      clientTime: Number(message.clientTime || 0),
      id: message.id || "",
      serverTime: Date.now(),
    });
    return;
  }

  if (message.type === "latency") {
    const rttMs = Number(message.rttMs);
    if (
      !client.visible ||
      !Number.isFinite(rttMs) ||
      rttMs <= 0 ||
      rttMs > MAX_REPORTED_RTT_MS
    ) {
      return;
    }
    client.rttMs = client.rttMs
      ? client.rttMs * (1 - LATENCY_SMOOTHING) + rttMs * LATENCY_SMOOTHING
      : rttMs;
    client.latencyMs = client.rttMs / 2;
    broadcastRoomState(room);
    return;
  }

  if (message.type === "visibility") {
    client.visible = Boolean(message.visible);
    logSync("client-visibility", {
      client: clientLogInfo(client),
      frame: Math.max(0, Math.floor(Number(message.frame) || 0)),
      room: roomLogInfo(room),
      visible: client.visible,
    });
    if (!client.visible) {
      client.rttMs = 0;
      client.latencyMs = 0;
      pauseRoom(room, "hidden");
    } else {
      let sentState = false;
      if (room.started && room.paused) {
        sentState = sendLatestRoomState(client, room, {
          realign: true,
          reason: "resume",
        });
      } else if (room.started) {
        logSync("client-visibility-live", {
          client: clientLogInfo(client),
          room: roomLogInfo(room),
        });
      }
      if (room.started && room.paused) {
        if (!sentState && requestStateBeforeResume(room, client, "resume")) {
          broadcastRoomState(room);
          return;
        }
      }
      resumeRoomIfReady(room);
    }
    broadcastRoomState(room);
    return;
  }

  if (message.type === "resync-request") {
    const reason = String(message.reason || "resync");
    logSync("client-resync-request", {
      client: clientLogInfo(client),
      frame: Math.max(0, Math.floor(Number(message.frame) || 0)),
      reason,
      room: roomLogInfo(room),
      serverFrame: Math.max(0, Math.floor(Number(message.serverFrame) || 0)),
    });
    const sentState = sendLatestRoomState(client, room, {
      allowSelf: false,
      realign: true,
      reason,
    });
    if (!sentState) {
      if (requestRoomState(room, client, reason) > 0) {
        scheduleClientStateFallback(client, room, reason);
      } else {
        const sentFallback = sendLatestRoomState(client, room, {
          allowStale: true,
          reason: `${reason}-fallback`,
          realign: true,
        });
        logSync("state-request-fallback", {
          client: clientLogInfo(client),
          reason,
          room: roomLogInfo(room),
          sent: sentFallback,
        });
        if (!sentFallback) {
          sendJson(client, {
            type: "state-unavailable",
            reason,
          });
        }
      }
    }
    return;
  }

  if (message.type === "adopt-rom") {
    if (client.role < 1 || room.currentRom || room.started) {
      return;
    }

    const rom = roomRomFromMessage(message);
    if (!rom) {
      return;
    }

    setRoomRom(room, rom);
    return;
  }

  if (message.type === "select-rom") {
    if (client.role < 1) {
      sendJson(client, { type: "error", message: "观战不能选择游戏" });
      return;
    }

    logSync("client-select-rom", {
      client: clientLogInfo(client),
      label: String(message.label || "ROM"),
      room: roomLogInfo(room),
      url: String(message.url || ""),
    });
    setRoomRom(room, {
      mode: "url",
      url: String(message.url || ""),
      label: String(message.label || "ROM"),
    });
    return;
  }

  if (message.type === "select-rom-data") {
    if (client.role < 1) {
      sendJson(client, { type: "error", message: "观战不能选择游戏" });
      return;
    }

    const data = String(message.data || "");
    const size = Number(message.size || 0);
    if (!data || size <= 0 || data.length > 12 * 1024 * 1024) {
      sendJson(client, { type: "error", message: "ROM 数据太大或无效" });
      return;
    }

    logSync("client-select-rom-data", {
      client: clientLogInfo(client),
      label: String(message.label || "ROM"),
      room: roomLogInfo(room),
      size,
    });
    setRoomRom(room, {
      data,
      label: String(message.label || "ROM"),
      mode: "data",
      size,
    });
    return;
  }

  if (message.type === "ready") {
    client.ready = true;
    const shouldSendState = Boolean(client.needsStateOnReady || room.started);
    client.needsStateOnReady = false;
    logSync("client-ready", {
      client: clientLogInfo(client),
      room: roomLogInfo(room),
      shouldSendState,
    });
    const sentState =
      shouldSendState &&
      sendLatestRoomState(client, room, {
        realign: room.started,
        reason: room.started ? "join" : "cached",
      });
    broadcastRoomState(room);
    if (room.started && room.paused) {
      if (!sentState && requestStateBeforeResume(room, client, "join")) {
        return;
      }
    }
    if (room.started && !room.paused && !sentState) {
      requestRoomState(room, client, "join");
    }
    resumeRoomIfReady(room);
    maybeStartRoom(room);
    return;
  }

  if (message.type === "input") {
    if (!room.started || !room.startedAt || client.role < 1) return;
    if (room.paused) return;

    const button = String(message.button || "");
    const bit = BUTTON_BITS[button];
    if (!bit) return;

    const receivedAt = Date.now();
    recomputeRoomTiming(room, false);
    const elapsedFrame = Math.max(
      0,
      Math.floor((receivedAt - room.startedAt) / FRAME_TIME_MS),
    );
    const key = `${client.role}:${button}`;
    const lastTargetFrame = room.lastInputTargetFrames.get(key);
    let targetFrame = elapsedFrame + room.inputDelayFrames + INPUT_GUARD_FRAMES;
    if (Number.isFinite(lastTargetFrame) && targetFrame <= lastTargetFrame) {
      targetFrame = lastTargetFrame + 1;
    }
    targetFrame = Math.max(targetFrame, room.inputFrameCursor);
    room.lastInputTargetFrames.set(key, targetFrame);

    if (!room.pendingInputChanges.has(targetFrame)) {
      room.pendingInputChanges.set(targetFrame, []);
    }
    room.pendingInputChanges.get(targetFrame).push({
      bit,
      down: Boolean(message.down),
      role: client.role,
      seq: ++room.inputSeq,
    });

    broadcastReadyInputFrames(room);
    return;
  }

  if (message.type === "frame-ack") {
    if (!room.started || client.role < 1) return;

    const frame = Math.max(0, Math.floor(Number(message.frame) || 0));
    client.ackFrame = Math.max(Math.floor(Number(client.ackFrame) || 0), frame);
    client.ackAt = Date.now();
    if (room.stalled || room.paused || String(message.reason || "") === "state") {
      logSync("client-frame-ack", {
        client: clientLogInfo(client),
        frame,
        reason: String(message.reason || ""),
        room: roomLogInfo(room),
      });
    }
    broadcastReadyInputFrames(room);
    return;
  }

  if (message.type === "state-hash") {
    handleStateHash(client, room, message);
    return;
  }

  if (message.type === "state" && client.role > 0) {
    if (!message.state || typeof message.state !== "object") return;

    const reason = String(message.reason || "resync");
    const targetClient = roomClientById(room, String(message.to || ""));
    logSync("client-state", {
      client: clientLogInfo(client),
      frame: Math.max(0, Math.floor(Number(message.frame) || 0)),
      reason,
      room: roomLogInfo(room),
      target: clientLogInfo(targetClient),
    });
    const realign = Boolean(room.paused || room.resumeAfterState);
    const authoritative = client.role === 1;
    const stateMessage = {
      type: "state",
      authoritative,
      frame: Math.max(0, Math.floor(Number(message.frame) || 0)),
      from: client.id,
      fromRole: client.role,
      realign,
      reason,
      state: message.state,
    };
    if (message.hash) {
      stateMessage.hash = String(message.hash).slice(0, 80);
    }
    cacheRoomState(room, stateMessage);
    if (
      (room.paused || room.resumeAfterState) &&
      client.visible &&
      reason !== "background"
    ) {
      const stateFrame = Math.max(0, Math.floor(Number(stateMessage.frame) || 0));
      const minFreshFrame = Math.max(0, room.inputFrameCursor - roomLeadFrames(room));
      if (stateFrame >= minFreshFrame) {
        alignRoomToState(room, room.latestState);
      } else {
        logSync("state-cache-stale-no-align", {
          client: clientLogInfo(client),
          minFreshFrame,
          reason,
          room: roomLogInfo(room),
          stateFrame,
        });
      }
    }
    if (reason !== "background" && reason !== "checkpoint") {
      const outgoingState = {
        ...room.latestState,
        inputDelayMs: Math.round(room.inputDelayMs),
        inputFrames: inputFramesFrom(room, room.latestState.frame),
        maxLatencyMs: Math.round(room.maxLatencyMs),
        realign: Boolean(realign),
        serverFrame: Math.max(0, room.inputFrameCursor - 1),
      };
      if (targetClient && targetClient !== client && targetClient.room === room) {
        clearClientStateTimer(targetClient);
        sendJson(targetClient, outgoingState);
        logSync("state-send-live-target", {
          frame: outgoingState.frame,
          provider: clientLogInfo(client),
          reason,
          room: roomLogInfo(room),
          target: clientLogInfo(targetClient),
        });
      } else {
        for (const peer of room.clients) {
          if (peer !== client) clearClientStateTimer(peer);
        }
        broadcast(room, outgoingState, client);
        logSync("state-send-live-broadcast", {
          frame: outgoingState.frame,
          provider: clientLogInfo(client),
          reason,
          room: roomLogInfo(room),
        });
      }
    }
    if (room.resumeAfterState) {
      clearResumeStateTimer(room);
      room.resumeAfterState = false;
      resumeRoomIfReady(room);
    } else if (room.paused && reason !== "background") {
      resumeRoomIfReady(room);
    }
    return;
  }
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;

  const first = buffer[0];
  const second = buffer[1];
  const fin = Boolean(first & 0x80);
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) throw new Error("Frame too large");
    length = low;
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    bytes: offset + length,
    fin,
    opcode,
    payload,
  };
}

function handleFrame(client, frame) {
  client.lastSeenAt = Date.now();

  if (frame.opcode === 0x8) {
    client.socket.end();
    return;
  }

  if (frame.opcode === 0x9) {
    sendFrame(client, frame.payload, 0x0a);
    return;
  }

  if (frame.opcode === 0x0a) {
    client.lastPongAt = Date.now();
    return;
  }

  if (frame.opcode === 0x1 || frame.opcode === 0x0) {
    if (frame.opcode === 0x1 && frame.fin) {
      handleMessage(client, frame.payload.toString("utf8"));
      return;
    }

    client.fragments.push(frame.payload);
    if (frame.fin) {
      const payload = Buffer.concat(client.fragments).toString("utf8");
      client.fragments = [];
      handleMessage(client, payload);
    }
  }
}

function attachWebSocket(request, socket) {
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15000);

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
      "",
      "",
    ].join("\r\n"),
  );

  const client = {
    buffer: Buffer.alloc(0),
    closed: false,
    fragments: [],
    id: `c${nextClientId++}`,
    lastPongAt: Date.now(),
    lastSeenAt: Date.now(),
    latencyMs: 0,
    needsStateOnReady: false,
    ready: false,
    role: 0,
    room: null,
    rttMs: 0,
    socket,
    stateRequestTimer: null,
    token: "",
    visible: true,
  };
  clients.add(client);
  logSync("client-connect", {
    client: clientLogInfo(client),
    remote: socket.remoteAddress || "",
  });

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    try {
      for (;;) {
        const frame = readFrame(client.buffer);
        if (!frame) break;
        client.buffer = client.buffer.subarray(frame.bytes);
        handleFrame(client, frame);
      }
    } catch (error) {
      logSync("client-frame-error", {
        client: clientLogInfo(client),
        message: error?.message || "frame-error",
        room: roomLogInfo(client.room),
      });
      socket.destroy();
    }
  });

  socket.on("close", () => {
    logSync("client-socket-close", {
      client: clientLogInfo(client),
      room: roomLogInfo(client.room),
    });
    cleanupClient(client);
  });
  socket.on("error", (error) => {
    logSync("client-socket-error", {
      client: clientLogInfo(client),
      message: error?.message || "socket-error",
      room: roomLogInfo(client.room),
    });
    cleanupClient(client);
  });
}

const server = http.createServer(serveStatic);
const heartbeatTimer = setInterval(heartbeatClients, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();

server.on("upgrade", (request, socket) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/sync") {
    attachWebSocket(request, socket);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FC sync server ${APP_VERSION}: http://${HOST}:${PORT}/fc-online-emulator/`);
});
