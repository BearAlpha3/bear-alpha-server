const GameRoom = require("./GameRoom");

class RoomManager {

    constructor() {
        this.rooms = {};
        this.nextRoom = 1000;
    }

    createRoom() {

        const id =
            String(this.nextRoom++);

        const room =
            new GameRoom(id);

        this.rooms[id] = room;

        return room;
    }

    getRoom(id) {
        return this.rooms[id];
    }

    removeRoom(id) {
        delete this.rooms[id];
    }

    findAvailableRoom() {

        const ids =
            Object.keys(this.rooms);

        for (
            let i = 0;
            i < ids.length;
            i++
        ) {

            const room =
                this.rooms[ids[i]];

            if (
                room.phase === "WAITING" &&
                Object.keys(room.players).length <
                room.maxPlayers
            ) {
                return room;
            }
        }

        return this.createRoom();
    }
}

module.exports = RoomManager;
