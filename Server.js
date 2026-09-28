const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const RoomManager = require("./game/RoomManager");

const PORT = process.env.PORT || 3000;

const rooms = new RoomManager();

const server = http.createServer(function(req, res) {

    res.writeHead(200, {
        "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
        name: "BearStar Server",
        status: "online"
    }));
});

const wss = new WebSocket.Server({
    server: server
});

const clients = {};

function send(ws, type, data) {

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    ws.send(JSON.stringify({
        type: type,
        data: data || {}
    }));
}

function broadcast(room, type, data) {

    const ids = Object.keys(room.players);

    for (var i = 0; i < ids.length; i++) {

        const id = ids[i];
        const client = clients[id];

        if (client) {
            send(client, type, data);
        }
    }
}

function roomState(room) {

    return {
        roomId: room.id,
        phase: room.phase,
        players: room.getPlayers(),
        objectives: room.objectives
    };
}

wss.on("connection", function(ws) {

    const id = crypto.randomUUID();

    clients[id] = ws;

    ws.playerId = id;
    ws.roomId = null;

    send(ws, "CONNECTED", {
        playerId: id
    });

    ws.on("message", function(message) {

        let packet;

        try {
            packet = JSON.parse(message.toString());
        } catch (e) {
            return;
        }

        if (!packet.type) {
            return;
        }

        const data = packet.data || {};

        if (packet.type === "CREATE_ROOM") {

            const room = rooms.createRoom();

            const player = room.addPlayer(
                id,
                data.name || "Player"
            );

            ws.roomId = room.id;

            send(ws, "ROOM_CREATED", roomState(room));

            broadcast(room, "ROOM_STATE", roomState(room));

            return;
        }

        if (packet.type === "JOIN_RANDOM") {

            const room = rooms.findAvailableRoom();

            const player = room.addPlayer(
                id,
                data.name || "Player"
            );

            if (!player) {
                send(ws, "ERROR", {
                    message: "Room full"
                });
                return;
            }

            ws.roomId = room.id;

            send(ws, "JOINED_ROOM", roomState(room));

            broadcast(room, "ROOM_STATE", roomState(room));

            return;
        }

        if (packet.type === "JOIN_ROOM") {

            const room = rooms.getRoom(
                String(data.roomId)
            );

            if (!room) {

                send(ws, "ERROR", {
                    message: "Room not found"
                });

                return;
            }

            const player = room.addPlayer(
                id,
                data.name || "Player"
            );

            if (!player) {

                send(ws, "ERROR", {
                    message: "Room full"
                });

                return;
            }

            ws.roomId = room.id;

            send(ws, "JOINED_ROOM", roomState(room));

            broadcast(room, "ROOM_STATE", roomState(room));

            return;
        }

        const room = rooms.getRoom(ws.roomId);

        if (!room) {
            return;
        }

        const player = room.getPlayer(id);

        if (!player) {
            return;
        }

        if (packet.type === "READY") {

            player.ready = true;

            broadcast(
                room,
                "ROOM_STATE",
                roomState(room)
            );

            return;
        }

        if (packet.type === "START_GAME") {

            const started = room.startGame();

            if (!started) {

                send(ws, "ERROR", {
                    message: "Need at least 2 players"
                });

                return;
            }

            broadcast(
                room,
                "GAME_STARTED",
                roomState(room)
            );

            return;
        }

        if (packet.type === "PLAYER_MOVE") {

            if (room.phase !== "PLAYING") {
                return;
            }

            player.move(
                data.x,
                data.y,
                data.rotation
            );

            broadcast(
                room,
                "PLAYER_UPDATE",
                {
                    player: player.toJSON()
                }
            );

            return;
        }

        if (packet.type === "OBJECTIVE") {

            if (room.phase !== "PLAYING") {
                return;
            }

            if (player.role !== "SURVIVOR") {
                return;
            }

            const objective = room.objective(
                Number(data.objectiveId),
                Number(data.amount || 10)
            );

            if (objective) {

                broadcast(
                    room,
                    "OBJECTIVE_UPDATE",
                    {
                        objective: objective
                    }
                );
            }

            return;
        }

        if (packet.type === "HIT") {

            if (room.phase !== "PLAYING") {
                return;
            }

            if (player.role !== "BEAR") {
                return;
            }

            const target = room.getPlayer(
                String(data.targetId)
            );

            if (!target) {
                return;
            }

            if (target.role !== "SURVIVOR") {
                return;
            }

            target.health -= 25;

            if (target.health <= 0) {

                target.health = 0;
                target.alive = false;
            }

            broadcast(
                room,
                "DAMAGE",
                {
                    targetId: target.id,
                    health: target.health,
                    alive: target.alive
                }
            );

            return;
        }
    });

    ws.on("close", function() {

        const room = rooms.getRoom(ws.roomId);

        if (room) {

            room.removePlayer(id);

            broadcast(
                room,
                "ROOM_STATE",
                roomState(room)
            );

            if (Object.keys(room.players).length === 0) {
                rooms.removeRoom(room.id);
            }
        }

        delete clients[id];
    });
});

server.listen(PORT, function() {

    console.log(
        "BearStar server running on port " + PORT
    );
});
