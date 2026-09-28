"use strict";

const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const RoomManager = require("./game/RoomManager");

// ─────────────────────────────────────────────────────────────
//  Configuração
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const PROTOCOL_VERSION = 2;
const SERVER_VERSION = "2.0.0";
const HEARTBEAT_INTERVAL_MS = 30_000;
const ROOM_SWEEP_INTERVAL_MS = 60_000;
const MAX_PACKET_BYTES = 4 * 1024;         // 4KB por mensagem
const RATE_LIMIT_WINDOW_MS = 1_000;        // 1s
const RATE_LIMIT_MAX = 60;                 // 60 pacotes/s
const MAX_NAME_LENGTH = 16;
const MAX_JOIN_ATTEMPTS_PER_MIN = 20;

// ─────────────────────────────────────────────────────────────
//  Estado global
// ─────────────────────────────────────────────────────────────
const rooms = new RoomManager();
const clients = new Map();                 // playerId -> ws
const startedAt = Date.now();

const metrics = {
    connectionsTotal: 0,
    packetsIn: 0,
    packetsOut: 0,
    packetsRejected: 0,
    errors: 0,
};

// ─────────────────────────────────────────────────────────────
//  Logger profissional
// ─────────────────────────────────────────────────────────────
function log(level, msg, extra) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${msg}`;
    if (extra) console.log(line, extra);
    else console.log(line);
}
const logger = {
    info: (m, e) => log("INFO", m, e),
    warn: (m, e) => log("WARN", m, e),
    error: (m, e) => log("ERROR", m, e),
};

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function sanitizeName(raw) {
    if (typeof raw !== "string") return "GuestBoy";
    const clean = raw.replace(/[^\w\s\-_.]/g, "").trim().slice(0, MAX_NAME_LENGTH);
    return clean.length > 0 ? clean : "GuestBoy";
}

function safeNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

// ─────────────────────────────────────────────────────────────
//  Envio / broadcast
// ─────────────────────────────────────────────────────────────
function send(ws, type, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify({ type, data: data || {} }));
        metrics.packetsOut++;
        return true;
    } catch (err) {
        metrics.errors++;
        return false;
    }
}

function broadcast(room, type, data, exceptPlayerId) {
    if (!room) return;
    for (const id of Object.keys(room.players)) {
        if (exceptPlayerId && id === exceptPlayerId) continue;
        const client = clients.get(id);
        if (client) send(client, type, data);
    }
}

function roomState(room) {
    return {
        roomId: room.id,
        phase: room.phase,
        maxPlayers: room.maxPlayers,
        players: room.getPlayers(),
        objectives: room.objectives,
    };
}

function sendRoomState(room) {
    if (!room) return;
    broadcast(room, "ROOM_STATE", roomState(room));
}

// ─────────────────────────────────────────────────────────────
//  Saída de jogador da sala (corrige bug de notificação)
// ─────────────────────────────────────────────────────────────
function removeClientFromRoom(ws, reason) {
    if (!ws || !ws.roomId) return;

    const room = rooms.getRoom(ws.roomId);
    ws.roomId = null;

    if (!room) return;

    const wasInGame = room.phase === "PLAYING";
    const playerName = room.players[ws.playerId]?.name || "Player";

    room.removePlayer(ws.playerId);

    if (Object.keys(room.players).length === 0) {
        rooms.removeRoom(room.id);
        logger.info(`Room ${room.id} closed (empty)`);
        return;
    }

    // Avisa quem ficou que alguém saiu — especialmente no meio da partida
    broadcast(room, "PLAYER_LEFT", {
        playerId: ws.playerId,
        name: playerName,
        reason: reason || "disconnect",
        wasInGame,
    });

    // Se um urso saiu no meio da partida, encerra com vitória dos sobreviventes
    if (wasInGame) {
        const survivorsAlive = Object.values(room.players)
            .filter(p => p.role === "SURVIVOR" && p.alive).length;
        const bearAlive = Object.values(room.players)
            .some(p => p.role === "BEAR" && p.alive);

        if (!bearAlive && survivorsAlive > 0) {
            room.phase = "FINISHED";
            broadcast(room, "GAME_END", {
                winner: "SURVIVOR",
                reason: "BEAR_LEFT",
            });
        }
    }

    sendRoomState(room);
}

// ─────────────────────────────────────────────────────────────
//  Rate limiting (token bucket simples)
// ─────────────────────────────────────────────────────────────
function checkRateLimit(ws) {
    const now = Date.now();
    if (!ws._rateResetAt || now - ws._rateResetAt > RATE_LIMIT_WINDOW_MS) {
        ws._rateResetAt = now;
        ws._rateCount = 0;
    }
    ws._rateCount++;
    return ws._rateCount <= RATE_LIMIT_MAX;
}

// ─────────────────────────────────────────────────────────────
//  HTTP server (status, health, metrics, rooms)
// ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const commonHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-cache",
    };

    if (req.method === "OPTIONS") {
        res.writeHead(204, commonHeaders);
        return res.end();
    }

    const url = req.url.split("?")[0];
    const uptime = Math.floor((Date.now() - startedAt) / 1000);

    if (url === "/health") {
        res.writeHead(200, { ...commonHeaders, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "ok", uptime }));
    }

    if (url === "/metrics") {
        res.writeHead(200, { ...commonHeaders, "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            ...metrics,
            players: clients.size,
            rooms: Object.keys(rooms.rooms || {}).length,
            uptime,
            memoryMB: +(process.memoryUsage().rss / 1048576).toFixed(2),
        }));
    }

    if (url === "/rooms") {
        const list = Object.values(rooms.rooms || {}).map(r => ({
            id: r.id,
            phase: r.phase,
            players: Object.keys(r.players).length,
            maxPlayers: r.maxPlayers,
        }));
        res.writeHead(200, { ...commonHeaders, "Content-Type": "application/json" });
        return res.end(JSON.stringify(list));
    }

    // Rota raiz — status bonito
    res.writeHead(200, { ...commonHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({
        name: "BearStar Server",
        version: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        status: "online",
        websocket: true,
        players: clients.size,
        rooms: Object.keys(rooms.rooms || {}).length,
        uptime,
    }));
});

// ─────────────────────────────────────────────────────────────
//  WebSocket server
// ─────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({
    server,
    maxPayload: MAX_PACKET_BYTES,
    perMessageDeflate: false, // menor latência para jogos
});

wss.on("connection", (ws, req) => {
    const playerId = crypto.randomUUID();
    ws.playerId = playerId;
    ws.roomId = null;
    ws.isAlive = true;
    ws._rateResetAt = Date.now();
    ws._rateCount = 0;

    clients.set(playerId, ws);
    metrics.connectionsTotal++;

    logger.info(`+ connect ${playerId.slice(0, 8)} (total=${clients.size})`);

    send(ws, "CONNECTED", {
        playerId,
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: SERVER_VERSION,
    });

    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (raw, isBinary) => {
        if (isBinary) {
            metrics.packetsRejected++;
            return;
        }

        metrics.packetsIn++;

        if (!checkRateLimit(ws)) {
            metrics.packetsRejected++;
            send(ws, "ERROR", { message: "Rate limit exceeded", code: "RATE_LIMIT" });
            return;
        }

        let packet;
        try {
            packet = JSON.parse(raw.toString());
        } catch {
            metrics.packetsRejected++;
            send(ws, "ERROR", { message: "Invalid JSON", code: "BAD_JSON" });
            return;
        }

        if (!packet || typeof packet !== "object") return;

        const type = typeof packet.type === "string" ? packet.type : null;
        const data = (packet.data && typeof packet.data === "object") ? packet.data : {};

        if (!type) {
            send(ws, "ERROR", { message: "Missing packet type", code: "NO_TYPE" });
            return;
        }

        handlePacket(ws, playerId, type, data);
    });

    ws.on("close", () => {
        removeClientFromRoom(ws, "disconnect");
        clients.delete(playerId);
        logger.info(`- disconnect ${playerId.slice(0, 8)} (total=${clients.size})`);
    });

    ws.on("error", (err) => {
        metrics.errors++;
        logger.warn(`WS error ${playerId.slice(0, 8)}: ${err.message}`);
    });
});

// ─────────────────────────────────────────────────────────────
//  Roteador de pacotes
// ─────────────────────────────────────────────────────────────
function handlePacket(ws, playerId, type, data) {

    // ── Pacotes que NÃO precisam de sala ──────────────────────
    if (type === "PING") {
        return send(ws, "PONG", { time: Date.now(), echo: data.time });
    }

    if (type === "CREATE_ROOM") {
        removeClientFromRoom(ws, "switch_room");
        const room = rooms.createRoom();
        const player = room.addPlayer(playerId, sanitizeName(data.name));
        if (!player) return send(ws, "ERROR", { message: "Could not create room", code: "CREATE_FAIL" });
        ws.roomId = room.id;
        send(ws, "ROOM_CREATED", roomState(room));
        sendRoomState(room);
        logger.info(`Room ${room.id} created by ${playerId.slice(0, 8)}`);
        return;
    }

    if (type === "JOIN_RANDOM") {
        removeClientFromRoom(ws, "switch_room");
        let room = rooms.findAvailableRoom();
        if (!room) room = rooms.createRoom();
        const player = room.addPlayer(playerId, sanitizeName(data.name));
        if (!player) return send(ws, "ERROR", { message: "Room is full", code: "ROOM_FULL" });
        ws.roomId = room.id;
        send(ws, "JOINED_ROOM", roomState(room));
        sendRoomState(room);
        return;
    }

    if (type === "JOIN_ROOM") {
        const roomId = String(data.roomId || "").slice(0, 64);
        const room = rooms.getRoom(roomId);
        if (!room) return send(ws, "ERROR", { message: "Room not found", code: "ROOM_NOT_FOUND" });
        if (room.phase !== "WAITING") {
            return send(ws, "ERROR", { message: "Game already started", code: "GAME_STARTED" });
        }
        removeClientFromRoom(ws, "switch_room");
        const player = room.addPlayer(playerId, sanitizeName(data.name));
        if (!player) return send(ws, "ERROR", { message: "Room is full", code: "ROOM_FULL" });
        ws.roomId = room.id;
        send(ws, "JOINED_ROOM", roomState(room));
        sendRoomState(room);
        return;
    }

    if (type === "LEAVE") {
        removeClientFromRoom(ws, "leave");
        return send(ws, "LEFT_ROOM", {});
    }

    // ── Daqui pra baixo, precisa estar em sala ────────────────
    if (!ws.roomId) {
        return send(ws, "ERROR", { message: "You are not inside a room", code: "NOT_IN_ROOM" });
    }

    const room = rooms.getRoom(ws.roomId);
    if (!room) {
        ws.roomId = null;
        return send(ws, "ERROR", { message: "Room no longer exists", code: "ROOM_GONE" });
    }

    const player = room.getPlayer(playerId);
    if (!player) {
        return send(ws, "ERROR", { message: "Player not found", code: "NO_PLAYER" });
    }

    // ── Lobby ─────────────────────────────────────────────────
    if (type === "READY") {
        player.ready = true;
        return sendRoomState(room);
    }

    if (type === "UNREADY") {
        player.ready = false;
        return sendRoomState(room);
    }

    if (type === "START_GAME") {
        if (room.phase !== "WAITING") {
            return send(ws, "ERROR", { message: "Game already started", code: "GAME_STARTED" });
        }
        const total = Object.keys(room.players).length;
        if (total < 2) {
            return send(ws, "ERROR", { message: "Need at least 2 players", code: "NEED_PLAYERS" });
        }
        const allReady = Object.values(room.players).every(p => p.ready);
        if (!allReady) {
            return send(ws, "ERROR", { message: "Not all players are ready", code: "NOT_READY" });
        }
        if (!room.startGame()) {
            return send(ws, "ERROR", { message: "Could not start game", code: "START_FAIL" });
        }
        // CORREÇÃO: broadcast para TODOS, não só para quem clicou
        room.startedAt = Date.now();
        broadcast(room, "GAME_STARTED", roomState(room));
        sendRoomState(room);
        logger.info(`Game started in room ${room.id} (${total} players)`);
        return;
    }

    // ── Em jogo ───────────────────────────────────────────────
    if (type === "PLAYER_MOVE") {
        if (room.phase !== "PLAYING" || !player.alive) return;

        const x = clamp(safeNumber(data.x, player.x), -5000, 5000);
        const y = clamp(safeNumber(data.y, player.y), -5000, 5000);
        const rotation = clamp(safeNumber(data.rotation, player.rotation), -Math.PI * 4, Math.PI * 4);

        player.move(x, y, rotation);

        // Não envia de volta para o autor (economia de banda)
        broadcast(room, "PLAYER_UPDATE", { player: player.toJSON() }, playerId);
        return;
    }

    if (type === "OBJECTIVE") {
        if (room.phase !== "PLAYING" || player.role !== "SURVIVOR" || !player.alive) return;

        const objectiveId = safeNumber(data.objectiveId, NaN);
        if (!Number.isFinite(objectiveId)) return;

        // Cooldown anti-spam: 500ms por jogador
        const now = Date.now();
        if (now - (player._lastObjectiveAt || 0) < 500) return;
        player._lastObjectiveAt = now;

        const amount = clamp(safeNumber(data.amount, 10), 1, 20);
        const objective = room.objective(objectiveId, amount);
        if (!objective) return;

        broadcast(room, "OBJECTIVE_UPDATE", { objective });
        return;
    }

    if (type === "HIT") {
        if (room.phase !== "PLAYING" || player.role !== "BEAR" || !player.alive) return;

        const targetId = String(data.targetId || "").slice(0, 64);
        const target = room.getPlayer(targetId);
        if (!target || target.role !== "SURVIVOR" || !target.alive) return;

        // Anti-cheat: valida distância (250 unidades máx.)
        const dx = target.x - player.x;
        const dy = target.y - player.y;
        const MAX_HIT_DISTANCE = 250;
        if (dx * dx + dy * dy > MAX_HIT_DISTANCE * MAX_HIT_DISTANCE) {
            send(ws, "ERROR", { message: "Target out of range", code: "OUT_OF_RANGE" });
            return;
        }

        // Cooldown de ataque: 800ms
        const now = Date.now();
        if (now - (player._lastHitAt || 0) < 800) return;
        player._lastHitAt = now;

        target.health = Math.max(0, target.health - 25);
        if (target.health === 0) target.alive = false;

        broadcast(room, "DAMAGE", {
            targetId: target.id,
            health: target.health,
            alive: target.alive,
        });

        const survivors = Object.values(room.players).filter(p => p.role === "SURVIVOR");
        const aliveSurvivors = survivors.filter(p => p.alive);

        if (survivors.length > 0 && aliveSurvivors.length === 0) {
            room.phase = "FINISHED";
            broadcast(room, "GAME_END", {
                winner: "BEAR",
                reason: "ALL_SURVIVORS_ELIMINATED",
                durationMs: room.startedAt ? Date.now() - room.startedAt : 0,
            });
            logger.info(`Game ended in room ${room.id} — winner: BEAR`);
        }
        return;
    }

    send(ws, "ERROR", { message: `Unknown packet: ${type}`, code: "UNKNOWN_TYPE" });
}

// ─────────────────────────────────────────────────────────────
//  Heartbeat (mata conexões zumbis)
// ─────────────────────────────────────────────────────────────
const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            logger.warn(`Terminating zombie socket ${ws.playerId?.slice(0, 8)}`);
            return ws.terminate();
        }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    });
}, HEARTBEAT_INTERVAL_MS);

// ─────────────────────────────────────────────────────────────
//  Varredura de salas inativas
// ─────────────────────────────────────────────────────────────
const sweepTimer = setInterval(() => {
    const all = rooms.rooms || {};
    const now = Date.now();
    for (const id of Object.keys(all)) {
        const room = all[id];
        const empty = Object.keys(room.players).length === 0;
        const stale = room.lastActivityAt && now - room.lastActivityAt > 10 * 60_000;
        if (empty || (stale && room.phase !== "PLAYING")) {
            rooms.removeRoom(id);
            logger.info(`Sweep: removed room ${id} (${empty ? "empty" : "stale"})`);
        }
    }
}, ROOM_SWEEP_INTERVAL_MS);

// ─────────────────────────────────────────────────────────────
//  Graceful shutdown (Render, Docker, etc.)
// ─────────────────────────────────────────────────────────────
function shutdown(signal) {
    logger.info(`${signal} received — shutting down gracefully...`);
    clearInterval(heartbeatTimer);
    clearInterval(sweepTimer);

    for (const ws of wss.clients) {
        send(ws, "SERVER_SHUTDOWN", { reason: "restart" });
        try { ws.close(1001, "Server shutting down"); } catch {}
    }

    wss.close(() => {
        server.close(() => {
            logger.info("Server closed cleanly.");
            process.exit(0);
        });
    });

    setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
    metrics.errors++;
    logger.error("uncaughtException", err);
});
process.on("unhandledRejection", (err) => {
    metrics.errors++;
    logger.error("unhandledRejection", err);
});

// ─────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────
server.on("error", (err) => {
    logger.error("HTTP server error", err);
});

server.listen(PORT, "0.0.0.0", () => {
    logger.info("════════════════════════════════════");
    logger.info(`   🐻 BEARSTAR SERVER v${SERVER_VERSION}`);
    logger.info("════════════════════════════════════");
    logger.info(`Port:        ${PORT}`);
    logger.info(`Protocol:    v${PROTOCOL_VERSION}`);
    logger.info(`HTTP:        ONLINE`);
    logger.info(`WebSocket:   ONLINE`);
    logger.info("════════════════════════════════════");
});
