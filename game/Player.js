class Player {

    constructor(id, name) {
        this.id = id;
        this.name = name || "Player";
        this.x = 0;
        this.y = 0;
        this.rotation = 0;
        this.health = 100;
        this.role = "SURVIVOR";
        this.ready = false;
        this.alive = true;
    }

    move(x, y, rotation) {
        this.x = Number(x) || 0;
        this.y = Number(y) || 0;
        this.rotation = Number(rotation) || 0;
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            x: this.x,
            y: this.y,
            rotation: this.rotation,
            health: this.health,
            role: this.role,
            alive: this.alive,
            ready: this.ready
        };
    }
}

module.exports = Player;
