"use strict";

const GameRoom = require("./GameRoom");
const crypto = require("crypto");

// ─────────────────────────────────────────────────────────────
//  Constantes
// ─────────────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
    MAX_ROOMS:          500,
    EMPTY_TTL_MS:       5 * 60_000,   // sala vazia some em 5 min
    STALE_TTL_MS:       10 * 60_000,  // sala parada (fora de jogo) some em 10 min
    DEFAULT_MAX_PLAYERS: 8,
});

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function generateRoomId() {
    // Ex: B-4F2A1C  (timestamp curto + 3 bytes random)
    const ts = Date.now().toString(36).slice(-4).toUpperCase();
    const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
    return `B-${ts}${rand}`;
}

// ─────────────────────────────────────────────────────────────
//  RoomManager
// ─────────────────────────────────────────────────────────────
class RoomManager {

    constructor(options = {}) {
        this.rooms = Object.create(null);   // sem prototype pollution
        this.maxRooms = Number.isFinite(options.maxRooms)
            ? Math.max(1, options.maxRooms)
            : DEFAULTS.MAX_ROOMS;
        this.defaultMaxPlayers = Number.isFinite(options.defaultMaxPlayers)
            ? options.defaultMaxPlayers
            : DEFAULTS.DEFAULT_MAX_PLAYERS;

        this.createdTotal = 0;
        this.removedTotal = 0;

        // Logger opcional — usa console por padrão
        this.logger = options.logger || {
            info:  (m) => console.log(`[RoomManager] ${m}`),
            warn:  (m) => console.warn(`[RoomManager] ${m}`),
        };
    }

    // ── Criação ───────────────────────────────────────────────
    createRoom(options = {}) {
        if (this.roomCount() >= this.maxRooms) {
            this.logger.warn(`Room limit reached (${this.maxRooms}); refusing to create`);
            return null;
        }

        // Gera ID único (retry se colidir)
        let id;
        let attempts = 0;
        do {
            id = generateRoomId();
            attempts++;
        } while (this.rooms[id] && attempts < 10);

        if (this.rooms[id]) {
            this.logger.warn(`Could not generate unique room id after ${attempts} attempts`);
            return null;
        }

        const room = new GameRoom(id, {
            maxPlayers: options.maxPlayers || this.defaultMaxPlayers,
            objectives: options.objectives,
        });

        this.rooms[id] = room;
        this.createdTotal++;

        return room;
    }

    // ── Busca ─────────────────────────────────────────────────
    getRoom(id) {
        if (!id || typeof id !== "string") return null;
        return this.rooms[id] || null;
    }

    hasRoom(id) {
        return this.getRoom(id) !== null;
    }

    getAllRooms() {
        return Object.values(this.rooms);
    }

    roomCount() {
        return Object.keys(this.rooms).length;
    }

    isEmpty() {
        return this.roomCount() === 0;
    }

    playerCount() {
        let total = 0;
        for (const room of this.getAllRooms()) {
            total += Object.keys(room.players).length;
        }
        return total;
    }

    // Busca genérica com predicado
    findRoom(predicate) {
        if (typeof predicate !== "function") return null;
        for (const room of this.getAllRooms()) {
            if (predicate(room)) return room;
        }
        return null;
    }

    // ── Busca de sala disponível (SEM criar) ──────────────────
    findAvailableRoom() {
        return this.findRoom((room) =>
            room.phase === "WAITING" &&
            Object.keys(room.players).length < room.maxPlayers
        );
    }

    // ── Busca-ou-cria (efeito colateral explícito no nome) ────
    getOrCreateRoom(options = {}) {
        return this.findAvailableRoom() || this.createRoom(options);
    }

    // ── Remoção ───────────────────────────────────────────────
    removeRoom(id) {
        if (!id || !this.rooms[id]) return false;
        delete this.rooms[id];
        this.removedTotal++;
        return true;
    }

    clearAllRooms() {
        const n = this.roomCount();
        this.rooms = Object.create(null);
        this.removedTotal += n;
        return n;
    }

    // ── Varredura de salas inativas ───────────────────────────
    sweep(options = {}) {
        const emptyTtl = options.emptyTtl ?? DEFAULTS.EMPTY_TTL_MS;
        const staleTtl = options.staleTtl ?? DEFAULTS.STALE_TTL_MS;
        const now = Date.now();

        let removed = 0;
        for (const id of Object.keys(this.rooms)) {
            const room = this.rooms[id];
            const playerCount = Object.keys(room.players).length;
            const lastActivity = room.lastActivityAt || room.createdAt || now;

            // Sala vazia além do TTL
            if (playerCount === 0 && now - lastActivity > emptyTtl) {
                this.removeRoom(id);
                this.logger.info(`Sweep: removed empty room ${id}`);
                removed++;
                continue;
            }

            // Sala parada (fora de partida) além do TTL
            if (
                room.phase !== "PLAYING" &&
                now - lastActivity > staleTtl
            ) {
                this.removeRoom(id);
                this.logger.info(`Sweep: removed stale room ${id} (phase=${room.phase})`);
                removed++;
            }
        }
        return removed;
    }

    // ── Estatísticas ──────────────────────────────────────────
    getStats() {
        const rooms = this.getAllRooms();
        const byPhase = { WAITING: 0, PLAYING: 0, FINISHED: 0 };

        for (const r of rooms) {
            if (byPhase[r.phase] !== undefined) byPhase[r.phase]++;
        }

        return {
            total: rooms.length,
            maxRooms: this.maxRooms,
            byPhase,
            totalPlayers: this.playerCount(),
            createdTotal: this.createdTotal,
            removedTotal: this.removedTotal,
        };
    }
}

// ─────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────
RoomManager.DEFAULTS = DEFAULTS;

module.exports = RoomManager;
