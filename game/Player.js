"use strict";

// ─────────────────────────────────────────────────────────────
//  Constantes
// ─────────────────────────────────────────────────────────────
const ROLES = Object.freeze({
    BEAR:     "BEAR",
    SURVIVOR: "SURVIVOR",
});

const DEFAULTS = Object.freeze({
    NAME:          "Player",
    MAX_NAME_LEN:  16,
    MAX_HEALTH:    100,
    MIN_HEALTH:    0,
    HIT_COOLDOWN:  800,    // ms
    OBJ_COOLDOWN:  500,    // ms
    POS_LIMIT:     5000,   // clamp de coordenadas
    ROT_LIMIT:     Math.PI * 4,
});

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function sanitizeName(raw) {
    if (typeof raw !== "string") return DEFAULTS.NAME;
    const clean = raw.replace(/[^\w\s\-_.]/g, "").trim().slice(0, DEFAULTS.MAX_NAME_LEN);
    return clean.length > 0 ? clean : DEFAULTS.NAME;
}

function safeNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

// ─────────────────────────────────────────────────────────────
//  Player
// ─────────────────────────────────────────────────────────────
class Player {

    constructor(id, name) {
        if (!id || typeof id !== "string") {
            throw new Error("Player requires a valid string id");
        }

        this.id = id;
        this.name = sanitizeName(name);

        // Posição/rotação
        this.x = 0;
        this.y = 0;
        this.rotation = 0;

        // Estado de jogo
        this._health = DEFAULTS.MAX_HEALTH;
        this._alive = true;
        this.role = null;          // null até startGame atribuir
        this.ready = false;

        // Timestamps
        this.joinedAt = Date.now();
        this.lastSeenAt = this.joinedAt;

        // Cooldowns internos (server não precisa mais controlar)
        this._lastHitAt = 0;
        this._lastObjectiveAt = 0;
    }

    // ── Health como propriedade sincronizada com alive ────────
    get health() {
        return this._health;
    }

    set health(value) {
        const n = safeNumber(value, this._health);
        this._health = clamp(n, DEFAULTS.MIN_HEALTH, DEFAULTS.MAX_HEALTH);
        if (this._health === 0) this._alive = false;
        else if (this._health > 0) this._alive = true;
    }

    get alive() {
        return this._alive;
    }

    set alive(value) {
        this._alive = Boolean(value);
        if (!this._alive) this._health = DEFAULTS.MIN_HEALTH;
    }

    // ── Movimento ─────────────────────────────────────────────
    move(x, y, rotation) {
        const nx = safeNumber(x, this.x);
        const ny = safeNumber(y, this.y);
        const nr = safeNumber(rotation, this.rotation);

        this.x = clamp(nx, -DEFAULTS.POS_LIMIT, DEFAULTS.POS_LIMIT);
        this.y = clamp(ny, -DEFAULTS.POS_LIMIT, DEFAULTS.POS_LIMIT);
        this.rotation = clamp(nr, -DEFAULTS.ROT_LIMIT, DEFAULTS.ROT_LIMIT);

        this.lastSeenAt = Date.now();
    }

    // ── Dano / cura ───────────────────────────────────────────
    applyDamage(amount) {
        const dmg = safeNumber(amount, 0);
        if (dmg <= 0 || !this._alive) return this._health;
        this.health = this._health - dmg; // setter cuida do clamp + alive
        return this._health;
    }

    heal(amount) {
        const h = safeNumber(amount, 0);
        if (h <= 0) return this._health;
        this.health = this._health + h;
        return this._health;
    }

    kill() {
        this._health = 0;
        this._alive = false;
        return true;
    }

    // ── Cooldowns ─────────────────────────────────────────────
    canHit() {
        return Date.now() - this._lastHitAt >= DEFAULTS.HIT_COOLDOWN;
    }

    markHit() {
        this._lastHitAt = Date.now();
    }

    canObjective() {
        return Date.now() - this._lastObjectiveAt >= DEFAULTS.OBJ_COOLDOWN;
    }

    markObjective() {
        this._lastObjectiveAt = Date.now();
    }

    // ── Reset (revanche) ──────────────────────────────────────
    reset() {
        this.x = 0;
        this.y = 0;
        this.rotation = 0;
        this._health = DEFAULTS.MAX_HEALTH;
        this._alive = true;
        this.role = null;
        this.ready = false;
        this._lastHitAt = 0;
        this._lastObjectiveAt = 0;
        this.lastSeenAt = Date.now();
    }

    // ── Serialização pública (vai pro cliente) ────────────────
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            x: this.x,
            y: this.y,
            rotation: this.rotation,
            health: this._health,
            role: this.role,
            alive: this._alive,
            ready: this.ready,
        };
    }

    // ── Serialização interna (debug/logs) ─────────────────────
    toPrivateJSON() {
        return {
            ...this.toJSON(),
            joinedAt: this.joinedAt,
            lastSeenAt: this.lastSeenAt,
            lastHitAt: this._lastHitAt,
            lastObjectiveAt: this._lastObjectiveAt,
        };
    }
}

// ─────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────
Player.ROLES = ROLES;
Player.DEFAULTS = DEFAULTS;

module.exports = Player;
