const Player = require("./Player");

class GameRoom {

    constructor(id) {
        this.id = id;
        this.players = {};
        this.phase = "WAITING";
        this.maxPlayers = 8;
        this.objectives = [
            {
                id: 1,
                progress: 0,
                complete: false
            },
            {
                id: 2,
                progress: 0,
                complete: false
            },
            {
                id: 3,
                progress: 0,
                complete: false
            }
        ];
    }

    addPlayer(id, name) {

        if (Object.keys(this.players).length >= this.maxPlayers) {
            return null;
        }

        const player = new Player(id, name);

        this.players[id] = player;

        return player;
    }

    removePlayer(id) {
        delete this.players[id];
    }

    getPlayer(id) {
        return this.players[id];
    }

    getPlayers() {
        return Object.values(this.players).map(function(player) {
            return player.toJSON();
        });
    }

    startGame() {

        const list = Object.values(this.players);

        if (list.length < 2) {
            return false;
        }

        this.phase = "PLAYING";

        var bearIndex = Math.floor(Math.random() * list.length);

        for (var i = 0; i < list.length; i++) {

            if (i === bearIndex) {
                list[i].role = "BEAR";
                list[i].x = 0;
                list[i].y = 0;
            } else {
                list[i].role = "SURVIVOR";
                list[i].x = (i * 100) + 100;
                list[i].y = 100;
            }
        }

        return true;
    }

    objective(id, amount) {

        for (var i = 0; i < this.objectives.length; i++) {

            if (this.objectives[i].id === id) {

                this.objectives[i].progress += amount;

                if (this.objectives[i].progress >= 100) {
                    this.objectives[i].progress = 100;
                    this.objectives[i].complete = true;
                }

                return this.objectives[i];
            }
        }

        return null;
    }

    toJSON() {

        return {
            id: this.id,
            phase: this.phase,
            players: this.getPlayers(),
            objectives: this.objectives
        };
    }
}

module.exports = GameRoom;
