"use strict";

const Player = require("./Player");

// ─────────────────────────────────────────────────────────────
//  Constantes — evita strings mágicas espalhadas
// ─────────────────────────────────────────────────────────────
const PHASES = Object.freeze({
    WAITING:  "WAITING",
    PLAYING:  "PLAYING",
    FINISHED: "FINISHED",
});

const ROLES = Object.freeze({
    BEAR:      "BEAR",
    SURVIVOR:  "SURVIVOR",
});

const WINNERS = Object.freeze({
    BEAR:      "BEAR",
    SURVIVOR:  "SURVIVOR",
    NONE:      "NONE",
});

const OBJECTIVE_TARGET = 100;
const SPAWN = Object.freeze({
    BEAR:      { x: 500, y: 500 },
    SURVIVOR_RADIUS: 200,
    SURVIVOR_CENTER: { x: 500, y: 500 },
});

const DEFAULT_OBJECTIVES = Object.freeze([
    { id: 1, name: "Generator",  target: OBJECTIVE_TARGET },
    { id: 2, name: "Radio",      target: OBJECTIVE_TARGET },
    { id: 3, name: "Escape Car", target: OBJECTIVE_TARGET },
]);

// ─────────────────────────────────────────────────────────────
//  GameRoom
// ─────────────────────────────────────────────────────────────
class GameRoom {

    constructor(id, options = {}) {
        if (!id || typeof id !== "string") {
            throw new Error("GameRoom requires a valid id");
        }

        this.id = id;
        this.players = Object.create(null);  // sem prototype pollution
        this.phase = PHASES.WAITING;
        this.maxPlayers = Number.isFinite(options.maxPlayers)
            ? Math.max(2, Math.min(16, options.maxPlayers))
            : 8;

        this.objectives = (options.objectives || DEFAULT_OBJECTIVES).map((o) => ({
            id: o.id,
            name: o.name || `Objective ${o.id}`,
            progress: 0,
            target: o.target || OBJECTIVE_TARGET,
            complete: false,
        }));

        this.createdAt = Date.now();
        this.startedAt = null;
        this.finishedAt = null;
        this.lastActivityAt = this.createdAt;

        this._winner = null;
        this._endReason = null;
    }

    // ── Helpers privados ──────────────────────────────────────
    _touch() {
        this.lastActivityAt = Date.now();
    }

    _playerList() {
        return Object.values(this.players);
    }

    // ── Gerenciamento de jogadores ────────────────────────────
    addPlayer(id, name) {
        if (!id || typeof id !== "string") return null;

        if (this.phase !== PHASES.WAITING) {
            return null; // não aceita entrar em jogo rolando
        }

        if (this.players[id]) {
            // ID duplicado — devolve o jogador existente ao invés de sobrescrever
            return this.players[id];
        }

        if (this._playerList().length >= this.maxPlayers) {
            return null;
        }

        let player;
        try {
            player = new Player(id, name);
        } catch {
            return null;
        }

        this.players[id] = player;
        this._touch();
        return player;
    }

    removePlayer(id) {
        if (!id || !this.players[id]) return false;

        delete this.players[id];
        this._touch();

        // Se um urso saiu durante o jogo, sobreviventes vencem
        if (this.phase === PHASES.PLAYING) {
            const bearGone = !this.getBear();
            const survivorsAlive = this.getAliveSurvivors().length;
            if (bearGone && survivorsAlive > 0) {
                this._finish(WINNERS.SURVIVOR, "BEAR_LEFT");
            }
        }

        return true;
    }

    getPlayer(id) {
        if (!id) return null;
        return this.players[id] || null;
    }

    getPlayers() {
        return this._playerList().map((p) => p.toJSON());
    }

    isEmpty() {
        return this._playerList().length === 0;
    }

    playerCount() {
        return this._playerList().length;
    }

    // ── Filtros por papel/estado ──────────────────────────────
    getBear() {
        return this._playerList().find((p) => p.role === ROLES.BEAR) || null;
    }

    getSurvivors() {
        return this._playerList().filter((p) => p.role === ROLES.SURVIVOR);
    }

    getAlivePlayers() {
        return this._playerList().filter((p) => p.alive);
    }

    getAliveSurvivors() {
        return this.getSurvivors().filter((p) => p.alive);
    }

    aliveCount() {
        return this.getAlivePlayers().length;
    }

    // ── Validação de início ───────────────────────────────────
    canStart() {
        if (this.phase !== PHASES.WAITING) {
            return { ok: false, reason: "ALREADY_STARTED" };
        }
        const list = this._playerList();
        if (list.length < 2) {
            return { ok: false, reason: "NEED_AT_LEAST_2_PLAYERS" };
        }
        const notReady = list.filter((p) => !p.ready);
        if (notReady.length > 0) {
            return { ok: false, reason: "NOT_ALL_READY" };
        }
        return { ok: true, reason: null };
    }

    // ── Início de partida ─────────────────────────────────────
    startGame() {
        const check = this.canStart();
        if (!check.ok) return false;

        const list = this._playerList();
        this.phase = PHASES.PLAYING;
        this.startedAt = Date.now();
        this.finishedAt = null;
        this._winner = null;
        this._endReason = null;

        // Sorteia o urso
        const bearIndex = Math.floor(Math.random() * list.length);

        // Spawn dos sobreviventes em círculo ao redor do centro
        const survivors = list.filter((_, i) => i !== bearIndex);
        const survivorCount = survivors.length;
        const angleStep = (Math.PI * 2) / Math.max(1, survivorCount);

        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            p.ready = false; // consome o ready
            p.alive = true;
            p.health = 100;

            if (i === bearIndex) {
                p.role = ROLES.BEAR;
                p.x = SPAWN.BEAR.x;
                p.y = SPAWN.BEAR.y;
                p.rotation = 0;
            } else {
                p.role = ROLES.SURVIVOR;
                const angle = angleStep * survivors.indexOf(p);
                p.x = SPAWN.SURVIVOR_CENTER.x + Math.cos(angle) * SPAWN.SURVIVOR_RADIUS;
                p.y = SPAWN.SURVIVOR_CENTER.y + Math.sin(angle) * SPAWN.SURVIVOR_RADIUS;
                p.rotation = angle + Math.PI; // olhando pro centro
            }
        }

        this._touch();
        return true;
    }

    // ── Progresso de objetivo ─────────────────────────────────
    objective(id, amount) {
        if (this.phase !== PHASES.PLAYING) return null;

        const numericId = Number(id);
        const numericAmount = Number(amount);
        if (!Number.isFinite(numericId) || !Number.isFinite(numericAmount)) return null;
        if (numericAmount <= 0) return null;

        const obj = this.objectives.find((o) => o.id === numericId);
        if (!obj) return null;
        if (obj.complete) return obj;

        obj.progress = Math.min(obj.target, obj.progress + numericAmount);
        if (obj.progress >= obj.target) {
            obj.complete = true;
        }

        this._touch();

        // Todos os objetivos completos? Sobreviventes vencem
        if (this.objectives.every((o) => o.complete)) {
            this._finish(WINNERS.SURVIVOR, "ALL_OBJECTIVES_COMPLETE");
        }

        return obj;
    }

    // ── Dano ──────────────────────────────────────────────────
    applyDamage(targetId, amount) {
        if (this.phase !== PHASES.PLAYING) return null;

        const target = this.getPlayer(targetId);
        if (!target || !target.alive) return null;

        const dmg = Math.max(0, Number(amount) || 0);
        target.health = Math.max(0, target.health - dmg);
        if (target.health === 0) target.alive = false;

        this._touch();
        return target;
    }

    // ── Condição de vitória ───────────────────────────────────
    checkWinCondition() {
        if (this.phase !== PHASES.PLAYING) {
            return this._winner ? { winner: this._winner, reason: this._endReason } : null;
        }

        const bear = this.getBear();
        const bearAlive = bear && bear.alive;
        const survivorsAlive = this.getAliveSurvivors().length;

        if (!bearAlive && survivorsAlive > 0) {
            return this._finish(WINNERS.SURVIVOR, "BEAR_ELIMINATED");
        }
        if (bearAlive && survivorsAlive === 0) {
            return this._finish(WINNERS.BEAR, "ALL_SURVIVORS_ELIMINATED");
        }
        if (!bearAlive && survivorsAlive === 0) {
            return this._finish(WINNERS.NONE, "MUTUAL_DESTRUCTION");
        }
        return null;
    }

    _finish(winner, reason) {
        this.phase = PHASES.FINISHED;
        this.finishedAt = Date.now();
        this._winner = winner;
        this._endReason = reason;
        this._touch();
        return { winner, reason };
    }

    // ── Reset para revanche ───────────────────────────────────
    resetForNewGame() {
        for (const p of this._playerList()) {
            p.role = null;
            p.ready = false;
            p.alive = true;
            p.health = 100;
            p.x = 0;
            p.y = 0;
            p.rotation = 0;
        }
        for (const o of this.objectives) {
            o.progress = 0;
            o.complete = false;
        }
        this.phase = PHASES.WAITING;
        this.startedAt = null;
        this.finishedAt = null;
        this._winner = null;
        this._endReason = null;
        this._touch();
    }

    // ── Snapshot completo (debug/logs) ────────────────────────
    getSnapshot() {
        return {
            id: this.id,
            phase: this.phase,
            playerCount: this.playerCount(),
            maxPlayers: this.maxPlayers,
            alivePlayers: this.aliveCount(),
            aliveSurvivors: this.getAliveSurvivors().length,
            bearAlive: !!this.getBear()?.alive,
            objectives: this.objectives.map((o) => ({ ...o })),
            winner: this._winner,
            endReason: this._endReason,
            createdAt: this.createdAt,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            lastActivityAt: this.lastActivityAt,
        };
    }
}

// ─────────────────────────────────────────────────────────────
//  Exports (com constantes anexadas pra facilitar imports)
// ─────────────────────────────────────────────────────────────
GameRoom.PHASES = PHASES;
GameRoom.ROLES = ROLES;
GameRoom.WINNERS = WINNERS;

module.exports = GameRoom;
