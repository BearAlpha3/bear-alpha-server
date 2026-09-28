const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const RoomManager = require("./game/RoomManager");

const PORT = process.env.PORT || 10000;

const rooms = new RoomManager();
const clients = {};

const server = http.createServer(function(req, res) {

    res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
    });

    res.end(JSON.stringify({
        name: "BearStar Server",
        version: "1.0.0",
        status: "online",
        websocket: true,
        rooms: Object.keys(rooms.rooms).length
    }));
});

const wss = new WebSocket.Server({
    server: server
});

function send(ws, type, data) {

    if (!ws) {
        return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
        return;
    }

    try {

        ws.send(JSON.stringify({
            type: type,
            data: data || {}
        }));

    } catch (error) {

        console.log(
            "Send error:",
            error.message
        );
    }
}

function broadcast(room, type, data) {

    if (!room) {
        return;
    }

    const ids =
        Object.keys(room.players);

    for (
        let i = 0;
        i < ids.length;
        i++
    ) {

        const id = ids[i];

        const client =
            clients[id];

        if (client) {

            send(
                client,
                type,
                data
            );
        }
    }
}

function roomState(room) {

    return {
        roomId: room.id,
        phase: room.phase,
        maxPlayers: room.maxPlayers,
        players: room.getPlayers(),
        objectives: room.objectives
    };
}

function removeClientFromRoom(ws) {

    if (!ws.roomId) {
        return;
    }

    const room =
        rooms.getRoom(ws.roomId);

    if (!room) {
        ws.roomId = null;
        return;
    }

    room.removePlayer(
        ws.playerId
    );

    broadcast(
        room,
        "ROOM_STATE",
        roomState(room)
    );

    if (
        Object.keys(room.players).length === 0
    ) {

        rooms.removeRoom(
            room.id
        );

        console.log(
            "Room removed:",
            room.id
        );
    }

    ws.roomId = null;
}

wss.on("connection", function(ws) {

    const playerId =
        crypto.randomUUID();

    ws.playerId =
        playerId;

    ws.roomId =
        null;

    clients[playerId] =
        ws;

    console.log(
        "CONNECTED:",
        playerId
    );

    send(
        ws,
        "CONNECTED",
        {
            playerId: playerId
        }
    );

    ws.on("message", function(message) {

        let packet;

        try {

            packet =
                JSON.parse(
                    message.toString()
                );

        } catch (error) {

            send(
                ws,
                "ERROR",
                {
                    message:
                        "Invalid JSON"
                }
            );

            return;
        }

        if (!packet) {
            return;
        }

        const type =
            packet.type;

        const data =
            packet.data || {};

        if (!type) {

            send(
                ws,
                "ERROR",
                {
                    message:
                        "Missing packet type"
                }
            );

            return;
        }

        /*
         * CREATE ROOM
         */

        if (
            type === "CREATE_ROOM"
        ) {

            removeClientFromRoom(ws);

            const room =
                rooms.createRoom();

            const player =
                room.addPlayer(
                    playerId,
                    data.name ||
                        "Player"
                );

            if (!player) {

                send(
                    ws,
                    "ERROR",
                    {
                        message:
                            "Could not create room"
                    }
                );

                return;
            }

            ws.roomId =
                room.id;

            console.log(
                "ROOM CREATED:",
                room.id
            );

            send(
                ws,
                "ROOM_CREATED",
                roomState(room)
            );

            broadcast(
                room,
                "ROOM_STATE",
                roomState(room)
            );

            return;
        }

        /*
         * JOIN RANDOM
         */

        if (
            type === "JOIN_RANDOM"
        ) {

            removeClientFromRoom(ws);

            const room =
                rooms.findAvailableRoom();

            const player =
                room.addPlayer(
                    playerId,
                    data.name ||
                        "Player"
                );

            if (!player) {

                send(
                    ws,
                    "ERROR",
                    {
                        message:
                            "Room is full"
                    }
                );

                return;
            }

            ws.roomId =
                room.id;

            console.log(
                "PLAYER",
                player.name,
                "JOINED ROOM",
                room.id
            );

            send(
                ws,
                "JOINED_ROOM",
                roomState(room)
            );

            broadcast(
                room,
                "ROOM_STATE",
                roomState(room)
            );

            return;
        }

        /*
         * JOIN ROOM
         */

        if (
            type === "JOIN_ROOM"
        ) {

            const roomId =
                String(
                    data.roomId || ""
                );

            const room =
                rooms.getRoom(
                    roomId
                );

            if (!room) {

                send(
                    ws,
                    "ERROR",
                    {
                        message:
                            "Room not found"
                    }
                );

                return;
            }

            if (
                room.phase !==
                "WAITING"
            ) {

                send(
                    ws,
                    "ERROR",
                    {
                        message:
                            "Game already started"
                    }
                );

                return;
            }

            removeClientFromRoom(ws);

            const player =
                room.addPlayer(
                    playerId,
                    data.name ||
                        "Player"
                );

            if (!player) {

                send(
                    ws,
                    "ERROR",
                    {
                        message:
                            "Room is full"
                    }
                );

                return;
            }

            ws.roomId =
                room.id;

            console.log(
                "PLAYER",
                player.name,
                "JOINED ROOM",
                room.id
            );

            send(
                ws,
                "JOINED_ROOM",
                roomState(room)
            );

            broadcast(
                room,
                "ROOM_STATE",
                roomState(room)
            );

            return;
        }

        /*
         * Everything below requires room
         */

        if (!ws.roomId) {

            send(
                ws,
                "ERROR",
                {
                    message:
                        "You are not inside a room"
                }
            );

            return;
        }

        const room =
            rooms.getRoom(
                ws.roomId
            );

        if (!room) {

            send(
                ws,
                "ERROR",
                {
                    message:
                        "Room no longer exists"
                }
            );

            ws.roomId =
                null;

            return;
        }

        const player =
            room.getPlayer(
                playerId
            );

        if (!player) {

            send(
                ws,
                "ERROR",
                {
                    message:
                        "Player not found"
                }
            );

            return;
        }

        /*
         * READY
         */

        if (
            type === "READY"
        ) {

            player.ready =
                true;

            broadcast(
                room,
                "ROOM_STATE",
                roomState(room)
            );

            return;
        }

        /*
         * UNREADY
         */

        if (
            type === "UNREADY"
        ) {

            player.ready =
                false;

            broadcast(
                room,
                "ROOM_STATE",
                roomState(room)
            );

            return;
        }

        /*
         * START GAME
         */

        if (
            type === "START_GAME"
        ) {

            if (
                room.phase !==
                "WAITING"
            ) {

                send(
                    ws,
                    "ERROR",
                    {
                        message:
                            "Game already started"
                    }
                );

                return;
            }

            const players =
                Object.values(
                    room.players
                );

            if (
                players.length < 2
            ) {

                send(
                    ws,
                    "ERROR",
                    {
                        message:
                            "Need at least 2 players"
                    }
                );

                return;
            }

            const started =
                room.startGame();

            if (!started) {

                send(
                    ws,
                    "ERROR",
                    {
                        message:
                            "Could not start game"
                    }
                );

                return;
            }

            console.log(
                "GAME STARTED:",
                room.id
            );

            broadcast(
                room,
                "GAME_STARTED",
                roomState(room)
            );

            return;
        }

        /*
         * PLAYER MOVE
         */

        if (
            type === "PLAYER_MOVE"
        ) {

            if (
                room.phase !==
                "PLAYING"
            ) {
                return;
            }

            if (!player.alive) {
                return;
            }

            let x =
                Number(data.x);

            let y =
                Number(data.y);

            let rotation =
                Number(data.rotation);

            if (!Number.isFinite(x)) {
                x = player.x;
            }

            if (!Number.isFinite(y)) {
                y = player.y;
            }

            if (!Number.isFinite(rotation)) {
                rotation =
                    player.rotation;
            }

            /*
             * Limite simples do mapa
             */

            x = Math.max(
                -2000,
                Math.min(
                    2000,
                    x
                )
            );

            y = Math.max(
                -2000,
                Math.min(
                    2000,
                    y
                )
            );

            player.move(
                x,
                y,
                rotation
            );

            broadcast(
                room,
                "PLAYER_UPDATE",
                {
                    player:
                        player.toJSON()
                }
            );

            return;
        }

        /*
         * OBJECTIVE
         */

        if (
            type === "OBJECTIVE"
        ) {

            if (
                room.phase !==
                "PLAYING"
            ) {
                return;
            }

            if (
                player.role !==
                "SURVIVOR"
            ) {
                return;
            }

            if (!player.alive) {
                return;
            }

            const objectiveId =
                Number(
                    data.objectiveId
                );

            const amount =
                Number(
                    data.amount || 10
                );

            if (
                !Number.isFinite(
                    objectiveId
                )
            ) {
                return;
            }

            const safeAmount =
                Math.max(
                    1,
                    Math.min(
                        20,
                        amount
                    )
                );

            const objective =
                room.objective(
                    objectiveId,
                    safeAmount
                );

            if (!objective) {
                return;
            }

            broadcast(
                room,
                "OBJECTIVE_UPDATE",
                {
                    objective:
                        objective
                }
            );

            return;
        }

        /*
         * BEAR HIT
         */

        if (
            type === "HIT"
        ) {

            if (
                room.phase !==
                "PLAYING"
            ) {
                return;
            }

            if (
                player.role !==
                "BEAR"
            ) {
                return;
            }

            if (!player.alive) {
                return;
            }

            const targetId =
                String(
                    data.targetId || ""
                );

            const target =
                room.getPlayer(
                    targetId
                );

            if (!target) {
                return;
            }

            if (
                target.role !==
                "SURVIVOR"
            ) {
                return;
            }

            if (!target.alive) {
                return;
            }

            target.health -= 25;

            if (
                target.health <= 0
            ) {

                target.health =
                    0;

                target.alive =
                    false;
            }

            broadcast(
                room,
                "DAMAGE",
                {
                    targetId:
                        target.id,

                    health:
                        target.health,

                    alive:
                        target.alive
                }
            );

            /*
             * Verifica fim da partida
             */

            const survivors =
                Object.values(
                    room.players
                ).filter(
                    function(p) {
                        return (
                            p.role ===
                            "SURVIVOR"
                        );
                    }
                );

            const aliveSurvivors =
                survivors.filter(
                    function(p) {
                        return p.alive;
                    }
                );

            if (
                survivors.length > 0 &&
                aliveSurvivors.length === 0
            ) {

                room.phase =
                    "FINISHED";

                broadcast(
                    room,
                    "GAME_END",
                    {
                        winner:
                            "BEAR",

                        reason:
                            "ALL_SURVIVORS_ELIMINATED"
                    }
                );
            }

            return;
        }

        /*
         * LEAVE
         */

        if (
            type === "LEAVE"
        ) {

            removeClientFromRoom(ws);

            send(
                ws,
                "LEFT_ROOM",
                {}
            );

            return;
        }

        /*
         * PING
         */

        if (
            type === "PING"
        ) {

            send(
                ws,
                "PONG",
                {
                    time:
                        Date.now()
                }
            );

            return;
        }

        send(
            ws,
            "ERROR",
            {
                message:
                    "Unknown packet: " +
                    type
            }
        );
    });

    ws.on("close", function() {

        console.log(
            "DISCONNECTED:",
            playerId
        );

        removeClientFromRoom(
            ws
        );

        delete clients[
            playerId
        ];
    });

    ws.on("error", function(error) {

        console.log(
            "WEBSOCKET ERROR:",
            error.message
        );
    });
});

server.on("error", function(error) {

    console.error(
        "SERVER ERROR:",
        error
    );
});

server.listen(
    PORT,
    "0.0.0.0",
    function() {

        console.log(
            "================================"
        );

        console.log(
            "      BEARSTAR SERVER"
        );

        console.log(
            "================================"
        );

        console.log(
            "Port:",
            PORT
        );

        console.log(
            "HTTP: ONLINE"
        );

        console.log(
            "WebSocket: ONLINE"
        );
    }
);
