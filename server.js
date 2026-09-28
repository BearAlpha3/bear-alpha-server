const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 10000;

const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

const MAX_PLAYERS_PER_ROOM = 8;
const MIN_PLAYERS_TO_START = 2;

const MAP_WIDTH = 2000;
const MAP_HEIGHT = 1200;

const PLAYER_RADIUS = 22;

const SURVIVOR_MAX_HP = 100;
const BEAR_MAX_HP = 500;

const SURVIVOR_SPEED = 220;
const BEAR_SPEED = 190;

const BEAR_ATTACK_RANGE = 75;
const BEAR_ATTACK_DAMAGE = 100;
const BEAR_ATTACK_COOLDOWN = 650;

const ROUND_TIME = 180000;
const COUNTDOWN_TIME = 5000;
const END_SCREEN_TIME = 5000;

const rooms = new Map();

let nextPlayerNumber = 1;
let nextRoomNumber = 1;


/* =========================================================
   HTTP
   ========================================================= */

const httpServer = http.createServer((req, res) => {
    if (req.url === "/") {
        res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8"
        });

        res.end("BEAR Alpha 2D Server Online");
        return;
    }

    if (req.url === "/health") {
        const roomList = [];

        for (const room of rooms.values()) {
            roomList.push({
                id: room.id,
                players: room.players.size,
                phase: room.phase
            });
        }

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
            online: true,
            players: countPlayers(),
            rooms: rooms.size,
            uptime: process.uptime(),
            roomList: roomList
        }));

        return;
    }

    res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Not Found");
});


/* =========================================================
   WEBSOCKET
   ========================================================= */

const wss = new WebSocket.Server({
    server: httpServer,
    maxPayload: 32768
});


/* =========================================================
   UTILS
   ========================================================= */

function countPlayers() {
    let total = 0;

    for (const room of rooms.values()) {
        total += room.players.size;
    }

    return total;
}

function generatePlayerId() {
    const id = "player_" + nextPlayerNumber;
    nextPlayerNumber++;
    return id;
}

function generateRoomId() {
    const id = "room_" + nextRoomNumber;
    nextRoomNumber++;
    return id;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function distance(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;

    return Math.sqrt(dx * dx + dy * dy);
}

function safeNumber(value, fallback = 0) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return number;
}

function send(ws, data) {
    if (
        ws &&
        ws.readyState === WebSocket.OPEN
    ) {
        try {
            ws.send(JSON.stringify(data));
        } catch (error) {
            console.log("Erro enviando mensagem:", error.message);
        }
    }
}

function broadcast(room, data) {
    const message = JSON.stringify(data);

    for (const player of room.players.values()) {
        if (
            player.ws.readyState === WebSocket.OPEN
        ) {
            try {
                player.ws.send(message);
            } catch (error) {
                console.log(
                    "Erro enviando broadcast:",
                    error.message
                );
            }
        }
    }
}


/* =========================================================
   PLAYER
   ========================================================= */

function createPlayer(ws) {
    return {
        id: generatePlayerId(),

        ws: ws,

        name: "Player",

        role: "SURVIVOR",

        x: 0,
        y: 0,

        hp: SURVIVOR_MAX_HP,
        maxHp: SURVIVOR_MAX_HP,

        alive: true,

        kills: 0,
        deaths: 0,

        inputX: 0,
        inputY: 0,

        lastAttack: 0,

        connectedAt: Date.now()
    };
}

function getPlayerData(player) {
    return {
        id: player.id,

        name: player.name,

        role: player.role,

        x: Math.round(player.x * 10) / 10,
        y: Math.round(player.y * 10) / 10,

        hp: player.hp,
        maxHp: player.maxHp,

        alive: player.alive,

        kills: player.kills,
        deaths: player.deaths
    };
}


/* =========================================================
   ROOM
   ========================================================= */

function createRoom() {
    const room = {
        id: generateRoomId(),

        players: new Map(),

        phase: "WAITING",

        countdownEnd: 0,

        roundEnd: 0,

        endScreenEnd: 0,

        winner: null,

        roundNumber: 0
    };

    rooms.set(room.id, room);

    console.log("Sala criada:", room.id);

    return room;
}

function findAvailableRoom() {
    for (const room of rooms.values()) {
        if (
            room.phase === "WAITING" &&
            room.players.size < MAX_PLAYERS_PER_ROOM
        ) {
            return room;
        }
    }

    return createRoom();
}

function removeEmptyRooms() {
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.size === 0) {
            rooms.delete(roomId);

            console.log(
                "Sala removida:",
                roomId
            );
        }
    }
}


/* =========================================================
   SPAWN
   ========================================================= */

function getSpawnPosition(room, role) {
    if (role === "BEAR") {
        return {
            x: 1000,
            y: 600
        };
    }

    const index =
        Array.from(room.players.values())
            .filter(player =>
                player.role === "SURVIVOR"
            ).length;

    const survivorSpawns = [
        { x: 250, y: 250 },
        { x: 1750, y: 250 },
        { x: 250, y: 950 },
        { x: 1750, y: 950 },
        { x: 1000, y: 180 },
        { x: 1000, y: 1020 },
        { x: 500, y: 600 }
    ];

    return survivorSpawns[
        index % survivorSpawns.length
    ];
}


/* =========================================================
   ROLE SYSTEM
   ========================================================= */

function assignRoles(room) {
    const players =
        Array.from(room.players.values());

    if (players.length === 0) {
        return;
    }

    for (const player of players) {
        player.role = "SURVIVOR";
        player.maxHp = SURVIVOR_MAX_HP;
        player.hp = SURVIVOR_MAX_HP;
    }

    const bearIndex =
        Math.floor(
            Math.random() * players.length
        );

    const bear =
        players[bearIndex];

    bear.role = "BEAR";
    bear.maxHp = BEAR_MAX_HP;
    bear.hp = BEAR_MAX_HP;
}

function resetPlayersForRound(room) {
    for (const player of room.players.values()) {
        player.alive = true;

        player.hp = player.maxHp;

        player.inputX = 0;
        player.inputY = 0;

        player.lastAttack = 0;

        const spawn =
            getSpawnPosition(
                room,
                player.role
            );

        player.x = spawn.x;
        player.y = spawn.y;
    }
}


/* =========================================================
   ROUND SYSTEM
   ========================================================= */

function startCountdown(room) {
    if (
        room.phase !== "WAITING"
    ) {
        return;
    }

    if (
        room.players.size <
        MIN_PLAYERS_TO_START
    ) {
        return;
    }

    room.phase = "COUNTDOWN";

    room.countdownEnd =
        Date.now() + COUNTDOWN_TIME;

    room.winner = null;

    broadcast(room, {
        type: "countdown",

        duration: COUNTDOWN_TIME,

        players: getRoomPlayers(room)
    });

    console.log(
        room.id,
        "começou countdown"
    );
}

function startRound(room) {
    if (
        room.players.size <
        MIN_PLAYERS_TO_START
    ) {
        room.phase = "WAITING";
        return;
    }

    room.roundNumber++;

    room.phase = "PLAYING";

    room.winner = null;

    assignRoles(room);

    resetPlayersForRound(room);

    room.roundEnd =
        Date.now() + ROUND_TIME;

    broadcast(room, {
        type: "round_start",

        round: room.roundNumber,

        duration: ROUND_TIME,

        players: getRoomPlayers(room)
    });

    console.log(
        room.id,
        "rodada iniciada:",
        room.roundNumber
    );
}

function endRound(room, winner) {
    if (
        room.phase !== "PLAYING"
    ) {
        return;
    }

    room.phase = "ENDED";

    room.winner = winner;

    room.endScreenEnd =
        Date.now() + END_SCREEN_TIME;

    broadcast(room, {
        type: "round_end",

        winner: winner,

        players: getRoomPlayers(room)
    });

    console.log(
        room.id,
        "rodada terminou. Vencedor:",
        winner
    );
}

function updateRound(room) {
    const now = Date.now();

    if (
        room.phase === "WAITING"
    ) {
        if (
            room.players.size >=
            MIN_PLAYERS_TO_START
        ) {
            startCountdown(room);
        }

        return;
    }

    if (
        room.phase === "COUNTDOWN"
    ) {
        if (
            room.players.size <
            MIN_PLAYERS_TO_START
        ) {
            room.phase = "WAITING";

            broadcast(room, {
                type: "waiting"
            });

            return;
        }

        if (
            now >= room.countdownEnd
        ) {
            startRound(room);
        }

        return;
    }

    if (
        room.phase === "PLAYING"
    ) {
        if (
            now >= room.roundEnd
        ) {
            endRound(
                room,
                "SURVIVORS"
            );

            return;
        }

        checkWinCondition(room);

        return;
    }

    if (
        room.phase === "ENDED"
    ) {
        if (
            now >= room.endScreenEnd
        ) {
            if (
                room.players.size >=
                MIN_PLAYERS_TO_START
            ) {
                room.phase = "WAITING";

                room.winner = null;

                broadcast(room, {
                    type: "waiting"
                });

                startCountdown(room);
            } else {
                room.phase = "WAITING";

                room.winner = null;

                broadcast(room, {
                    type: "waiting"
                });
            }
        }
    }
}


/* =========================================================
   WIN CONDITION
   ========================================================= */

function checkWinCondition(room) {
    const players =
        Array.from(room.players.values());

    const bear =
        players.find(
            player =>
                player.role === "BEAR"
        );

    if (!bear || !bear.alive) {
        endRound(
            room,
            "SURVIVORS"
        );

        return;
    }

    const survivors =
        players.filter(
            player =>
                player.role === "SURVIVOR"
        );

    const aliveSurvivors =
        survivors.filter(
            player =>
                player.alive
        );

    if (
        survivors.length > 0 &&
        aliveSurvivors.length === 0
    ) {
        endRound(
            room,
            "BEAR"
        );
    }
}


/* =========================================================
   MOVEMENT
   ========================================================= */

function updateMovement(room) {
    for (const player of room.players.values()) {
        if (!player.alive) {
            continue;
        }

        if (
            room.phase !== "PLAYING"
        ) {
            continue;
        }

        let inputX = player.inputX;
        let inputY = player.inputY;

        const length =
            Math.sqrt(
                inputX * inputX +
                inputY * inputY
            );

        if (length > 1) {
            inputX /= length;
            inputY /= length;
        }

        const speed =
            player.role === "BEAR"
                ? BEAR_SPEED
                : SURVIVOR_SPEED;

        const dt =
            TICK_MS / 1000;

        player.x +=
            inputX * speed * dt;

        player.y +=
            inputY * speed * dt;

        player.x =
            clamp(
                player.x,
                PLAYER_RADIUS,
                MAP_WIDTH - PLAYER_RADIUS
            );

        player.y =
            clamp(
                player.y,
                PLAYER_RADIUS,
                MAP_HEIGHT - PLAYER_RADIUS
            );
    }
}


/* =========================================================
   ATTACK
   ========================================================= */

function bearAttack(room, bear) {
    if (
        room.phase !== "PLAYING"
    ) {
        return;
    }

    if (
        !bear.alive ||
        bear.role !== "BEAR"
    ) {
        return;
    }

    const now = Date.now();

    if (
        now - bear.lastAttack <
        BEAR_ATTACK_COOLDOWN
    ) {
        return;
    }

    bear.lastAttack = now;

    let target = null;

    let nearestDistance =
        BEAR_ATTACK_RANGE + 1;

    for (const player of room.players.values()) {
        if (
            player.id === bear.id
        ) {
            continue;
        }

        if (
            player.role !== "SURVIVOR"
        ) {
            continue;
        }

        if (!player.alive) {
            continue;
        }

        const d =
            distance(
                bear.x,
                bear.y,
                player.x,
                player.y
            );

        if (
            d <= BEAR_ATTACK_RANGE &&
            d < nearestDistance
        ) {
            nearestDistance = d;
            target = player;
        }
    }

    if (!target) {
        broadcast(room, {
            type: "attack",
            attackerId: bear.id,
            hit: false
        });

        return;
    }

    target.hp =
        Math.max(
            0,
            target.hp -
            BEAR_ATTACK_DAMAGE
        );

    broadcast(room, {
        type: "attack",

        attackerId: bear.id,

        targetId: target.id,

        hit: true,

        damage: BEAR_ATTACK_DAMAGE,

        targetHp: target.hp
    });

    if (
        target.hp <= 0
    ) {
        eliminatePlayer(
            room,
            target,
            bear
        );
    }
}


/* =========================================================
   ELIMINATION
   ========================================================= */

function eliminatePlayer(
    room,
    victim,
    killer
) {
    if (!victim.alive) {
        return;
    }

    victim.alive = false;

    victim.hp = 0;

    victim.deaths++;

    if (killer) {
        killer.kills++;
    }

    victim.inputX = 0;
    victim.inputY = 0;

    broadcast(room, {
        type: "player_eliminated",

        victimId: victim.id,

        killerId:
            killer
                ? killer.id
                : null
    });

    checkWinCondition(room);
}


/* =========================================================
   ROOM PLAYERS
   ========================================================= */

function getRoomPlayers(room) {
    const list = [];

    for (const player of room.players.values()) {
        list.push(
            getPlayerData(player)
        );
    }

    return list;
}

function sendSnapshot(room, player) {
    send(player.ws, {
        type: "snapshot",

        roomId: room.id,

        phase: room.phase,

        round: room.roundNumber,

        winner: room.winner,

        map: {
            width: MAP_WIDTH,
            height: MAP_HEIGHT
        },

        playerId: player.id,

        players: getRoomPlayers(room)
    });
}


/* =========================================================
   STATE BROADCAST
   ========================================================= */

function broadcastState(room) {
    if (
        room.players.size === 0
    ) {
        return;
    }

    const now = Date.now();

    let timeLeft = 0;

    if (
        room.phase === "PLAYING"
    ) {
        timeLeft =
            Math.max(
                0,
                room.roundEnd - now
            );
    }

    if (
        room.phase === "COUNTDOWN"
    ) {
        timeLeft =
            Math.max(
                0,
                room.countdownEnd - now
            );
    }

    broadcast(room, {
        type: "state",

        phase: room.phase,

        round: room.roundNumber,

        timeLeft: timeLeft,

        winner: room.winner,

        players: getRoomPlayers(room)
    });
}


/* =========================================================
   MESSAGE HANDLING
   ========================================================= */

function handleMessage(player, data) {
    if (
        !data ||
        typeof data !== "object"
    ) {
        return;
    }

    const type = data.type;

    if (type === "ping") {
        send(player.ws, {
            type: "pong",
            time: Date.now()
        });

        return;
    }


    if (type === "set_name") {
        let name =
            String(
                data.name || "Player"
            );

        name =
            name
                .replace(
                    /[^a-zA-Z0-9À-ÿ _-]/g,
                    ""
                )
                .trim();

        if (name.length === 0) {
            name = "Player";
        }

        name =
            name.substring(0, 16);

        player.name = name;

        if (player.room) {
            broadcast(
                player.room,
                {
                    type: "player_update",
                    player:
                        getPlayerData(player)
                }
            );
        }

        return;
    }


    if (type === "move") {
        let x =
            safeNumber(
                data.x,
                0
            );

        let y =
            safeNumber(
                data.y,
                0
            );

        const length =
            Math.sqrt(
                x * x +
                y * y
            );

        if (length > 1) {
            x /= length;
            y /= length;
        }

        player.inputX =
            clamp(
                x,
                -1,
                1
            );

        player.inputY =
            clamp(
                y,
                -1,
                1
            );

        return;
    }


    if (type === "stop") {
        player.inputX = 0;
        player.inputY = 0;

        return;
    }


    if (type === "attack") {
        if (player.room) {
            bearAttack(
                player.room,
                player
            );
        }

        return;
    }
}


/* =========================================================
   CONNECTION
   ========================================================= */

wss.on("connection", (ws) => {
    const player =
        createPlayer(ws);

    const room =
        findAvailableRoom();

    player.room = room;

    room.players.set(
        player.id,
        player
    );

    ws.isAlive = true;

    console.log(
        player.id,
        "entrou na sala",
        room.id
    );


    send(ws, {
        type: "connected",

        playerId: player.id,

        roomId: room.id,

        map: {
            width: MAP_WIDTH,
            height: MAP_HEIGHT
        },

        maxPlayers:
            MAX_PLAYERS_PER_ROOM
    });


    sendSnapshot(
        room,
        player
    );


    broadcast(
        room,
        {
            type: "player_joined",

            player:
                getPlayerData(player)
        }
    );


    ws.on("pong", () => {
        ws.isAlive = true;
    });


    ws.on("message", (rawMessage) => {
        try {
            const text =
                rawMessage.toString();

            if (
                text.length >
                16000
            ) {
                return;
            }

            const data =
                JSON.parse(text);

            handleMessage(
                player,
                data
            );

        } catch (error) {
            send(ws, {
                type: "error",
                message:
                    "Mensagem inválida."
            });
        }
    });


    ws.on("close", () => {
        disconnectPlayer(player);
    });


    ws.on("error", (error) => {
        console.log(
            player.id,
            "socket error:",
            error.message
        );
    });
});


/* =========================================================
   DISCONNECT
   ========================================================= */

function disconnectPlayer(player) {
    const room =
        player.room;

    if (!room) {
        return;
    }

    if (
        !room.players.has(
            player.id
        )
    ) {
        return;
    }

    room.players.delete(
        player.id
    );

    console.log(
        player.id,
        "saiu da sala",
        room.id
    );

    broadcast(
        room,
        {
            type: "player_left",

            playerId:
                player.id
        }
    );

    if (
        room.players.size === 0
    ) {
        rooms.delete(room.id);

        console.log(
            "Sala destruída:",
            room.id
        );

        return;
    }

    /*
     * Se o BEAR sair durante a partida,
     * os sobreviventes vencem.
     */

    if (
        room.phase === "PLAYING" &&
        player.role === "BEAR"
    ) {
        endRound(
            room,
            "SURVIVORS"
        );
    }
}


/* =========================================================
   GAME LOOP
   ========================================================= */

setInterval(() => {
    for (const room of rooms.values()) {
        updateRound(room);

        updateMovement(room);

        broadcastState(room);
    }

    removeEmptyRooms();

}, TICK_MS);


/* =========================================================
   HEARTBEAT
   ========================================================= */

setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) {
            try {
                ws.terminate();
            } catch (error) {
            }

            continue;
        }

        ws.isAlive = false;

        try {
            ws.ping();
        } catch (error) {
        }
    }
}, 30000);


/* =========================================================
   SERVER START
   ========================================================= */

httpServer.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            "================================="
        );

        console.log(
            "BEAR Alpha 2D Server"
        );

        console.log(
            "Porta:",
            PORT
        );

        console.log(
            "Tick:",
            TICK_RATE,
            "Hz"
        );

        console.log(
            "Mapa:",
            MAP_WIDTH,
            "x",
            MAP_HEIGHT
        );

        console.log(
            "Max jogadores por sala:",
            MAX_PLAYERS_PER_ROOM
        );

        console.log(
            "================================="
        );
    }
);


/* =========================================================
   GRACEFUL SHUTDOWN
   ========================================================= */

function shutdown() {
    console.log(
        "Desligando servidor..."
    );

    for (const room of rooms.values()) {
        for (const player of room.players.values()) {
            send(
                player.ws,
                {
                    type: "server_shutdown"
                }
            );

            try {
                player.ws.close();
            } catch (error) {
            }
        }
    }

    httpServer.close(() => {
        process.exit(0);
    });
}

process.on(
    "SIGTERM",
    shutdown
);

process.on(
    "SIGINT",
    shutdown
);
