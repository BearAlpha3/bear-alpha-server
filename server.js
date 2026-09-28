const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
        res.writeHead(200, {
            "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
            ok: true,
            server: "BEAR Alpha 2D",
            players: players.size,
            rooms: rooms.size
        }));

        return;
    }

    res.writeHead(404);
    res.end("Not Found");
});

const wss = new WebSocket.Server({
    server
});

/* =========================
   CONFIGURAÇÃO
========================= */

const MAP_WIDTH = 2000;
const MAP_HEIGHT = 1200;

const MAX_PLAYERS_PER_ROOM = 8;
const MIN_PLAYERS_TO_START = 2;

const SURVIVOR_HP = 100;
const BEAR_HP = 500;

const SURVIVOR_SPEED = 220;
const BEAR_SPEED = 190;

const ATTACK_RANGE = 85;
const ATTACK_DAMAGE = 100;
const ATTACK_COOLDOWN = 650;

const ROUND_COUNTDOWN = 5;
const ROUND_TIME = 180;

const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

/* =========================
   DADOS
========================= */

const players = new Map();
const rooms = new Map();

let nextPlayerNumber = 1;
let nextRoomNumber = 1;

/* =========================
   UTILIDADES
========================= */

function randomId() {
    return (
        Date.now().toString(36) +
        Math.random().toString(36).substring(2, 8)
    );
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(value) {
    return (
        typeof value === "number" &&
        Number.isFinite(value)
    );
}

function distance(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;

    return Math.sqrt(
        dx * dx +
        dy * dy
    );
}

function send(ws, data) {
    if (
        ws &&
        ws.readyState === WebSocket.OPEN
    ) {
        try {
            ws.send(JSON.stringify(data));
        } catch (e) {
            console.log("Erro ao enviar:", e.message);
        }
    }
}

function broadcast(room, data) {
    if (!room)
        return;

    for (const player of room.players) {
        send(player.ws, data);
    }
}

/* =========================
   SALA
========================= */

function createRoom() {

    const room = {
        id: "room_" + nextRoomNumber++,

        players: new Set(),

        phase: "WAITING",

        countdown: 0,

        roundStartedAt: 0,

        roundEndsAt: 0,

        countdownTimer: null
    };

    rooms.set(
        room.id,
        room
    );

    return room;
}

function findAvailableRoom() {

    for (const room of rooms.values()) {

        if (
            room.phase === "WAITING" &&
            room.players.size <
            MAX_PLAYERS_PER_ROOM
        ) {
            return room;
        }
    }

    return createRoom();
}

/* =========================
   SPAWN
========================= */

function getSpawnPosition(role) {

    if (role === "BEAR") {

        return {
            x: MAP_WIDTH / 2,
            y: MAP_HEIGHT / 2
        };
    }

    const margin = 150;

    const positions = [
        {
            x: margin,
            y: margin
        },
        {
            x: MAP_WIDTH - margin,
            y: margin
        },
        {
            x: margin,
            y: MAP_HEIGHT - margin
        },
        {
            x: MAP_WIDTH - margin,
            y: MAP_HEIGHT - margin
        },
        {
            x: MAP_WIDTH / 2,
            y: margin
        },
        {
            x: MAP_WIDTH / 2,
            y: MAP_HEIGHT - margin
        }
    ];

    return positions[
        Math.floor(
            Math.random() *
            positions.length
        )
    ];
}

/* =========================
   PLAYER
========================= */

function createPlayer(ws) {

    const id = randomId();

    const player = {

        id: id,

        ws: ws,

        number: nextPlayerNumber++,

        name:
            "Guest" +
            nextPlayerNumber,

        role: "SURVIVOR",

        x: 1000,

        y: 600,

        hp: SURVIVOR_HP,

        maxHp: SURVIVOR_HP,

        dead: false,

        kills: 0,

        moveX: 0,

        moveY: 0,

        lastAttack: 0,

        room: null
    };

    players.set(
        id,
        player
    );

    return player;
}

/* =========================
   PLAYER DATA
========================= */

function publicPlayer(player) {

    return {
        id: player.id,

        name: player.name,

        role: player.role,

        x: player.x,

        y: player.y,

        hp: player.hp,

        maxHp: player.maxHp,

        dead: player.dead,

        kills: player.kills
    };
}

function roomPlayers(room) {

    const result = [];

    for (const player of room.players) {
        result.push(
            publicPlayer(player)
        );
    }

    return result;
}

/* =========================
   SNAPSHOT
========================= */

function sendSnapshot(player) {

    const room = player.room;

    if (!room)
        return;

    send(
        player.ws,
        {
            type: "snapshot",

            playerId: player.id,

            roomId: room.id,

            phase: room.phase,

            countdown: room.countdown,

            timeLeft:
                getTimeLeft(room),

            players:
                roomPlayers(room)
        }
    );
}

/* =========================
   TEMPO
========================= */

function getTimeLeft(room) {

    if (
        room.phase !== "PLAYING"
    ) {
        return 0;
    }

    const remaining =
        room.roundEndsAt -
        Date.now();

    return Math.max(
        0,
        Math.ceil(
            remaining / 1000
        )
    );
}

/* =========================
   ESTADO
========================= */

function broadcastState(room) {

    broadcast(
        room,
        {
            type: "state",

            phase: room.phase,

            timeLeft:
                getTimeLeft(room),

            players:
                roomPlayers(room)
        }
    );
}

/* =========================
   COMEÇAR ROUND
========================= */

function tryStartRound(room) {

    if (!room)
        return;

    if (
        room.phase !== "WAITING"
    ) {
        return;
    }

    if (
        room.players.size <
        MIN_PLAYERS_TO_START
    ) {
        broadcast(
            room,
            {
                type: "waiting",

                players:
                    room.players.size,

                needed:
                    MIN_PLAYERS_TO_START
            }
        );

        return;
    }

    room.phase = "COUNTDOWN";

    room.countdown =
        ROUND_COUNTDOWN;

    broadcast(
        room,
        {
            type: "countdown",

            seconds:
                room.countdown
        }
    );

    if (room.countdownTimer) {
        clearInterval(
            room.countdownTimer
        );
    }

    room.countdownTimer =
        setInterval(
            () => {

                if (
                    room.phase !==
                    "COUNTDOWN"
                ) {

                    clearInterval(
                        room.countdownTimer
                    );

                    room.countdownTimer =
                        null;

                    return;
                }

                room.countdown--;

                if (
                    room.countdown > 0
                ) {

                    broadcast(
                        room,
                        {
                            type:
                                "countdown",

                            seconds:
                                room.countdown
                        }
                    );

                } else {

                    clearInterval(
                        room.countdownTimer
                    );

                    room.countdownTimer =
                        null;

                    startRound(room);
                }

            },
            1000
        );
}

/* =========================
   ROUND START
========================= */

function startRound(room) {

    if (!room)
        return;

    if (
        room.players.size <
        MIN_PLAYERS_TO_START
    ) {

        room.phase =
            "WAITING";

        return;
    }

    room.phase = "PLAYING";

    room.roundStartedAt =
        Date.now();

    room.roundEndsAt =
        Date.now() +
        ROUND_TIME * 1000;

    const playersArray =
        Array.from(
            room.players
        );

    /*
     * ESCOLHE O BEAR
     */

    const bearIndex =
        Math.floor(
            Math.random() *
            playersArray.length
        );

    for (
        let i = 0;
        i < playersArray.length;
        i++
    ) {

        const player =
            playersArray[i];

        player.dead = false;

        player.moveX = 0;
        player.moveY = 0;

        player.kills = 0;

        player.lastAttack = 0;

        if (i === bearIndex) {

            player.role = "BEAR";

            player.hp = BEAR_HP;

            player.maxHp = BEAR_HP;

        } else {

            player.role =
                "SURVIVOR";

            player.hp =
                SURVIVOR_HP;

            player.maxHp =
                SURVIVOR_HP;
        }

        const spawn =
            getSpawnPosition(
                player.role
            );

        player.x = spawn.x;
        player.y = spawn.y;
    }

    broadcast(
        room,
        {
            type: "round_start",

            timeLeft:
                ROUND_TIME,

            players:
                roomPlayers(room)
        }
    );
}

/* =========================
   MOVIMENTO
========================= */

function setMovement(
    player,
    x,
    y
) {

    if (!player)
        return;

    /*
     * Nunca aceitar NaN,
     * Infinity ou valores estranhos.
     */

    if (
        !isFiniteNumber(x) ||
        !isFiniteNumber(y)
    ) {

        player.moveX = 0;
        player.moveY = 0;

        return;
    }

    /*
     * Limita o input.
     */

    x = clamp(x, -1, 1);
    y = clamp(y, -1, 1);

    /*
     * NORMALIZA O VETOR.
     *
     * Isso evita que diagonal seja
     * mais rápida.
     */

    const length =
        Math.sqrt(
            x * x +
            y * y
        );

    if (length < 0.05) {

        player.moveX = 0;
        player.moveY = 0;

        return;
    }

    if (length > 1) {

        x /= length;
        y /= length;
    }

    player.moveX = x;
    player.moveY = y;
}

/* =========================
   ATUALIZAR MOVIMENTO
========================= */

function updatePlayerMovement(
    player,
    deltaSeconds
) {

    if (!player)
        return;

    if (player.dead)
        return;

    if (
        !player.room ||
        player.room.phase !==
        "PLAYING"
    ) {
        return;
    }

    /*
     * SEGURANÇA EXTRA:
     * nunca deixar um frame gigante
     * teleportar o jogador.
     */

    deltaSeconds =
        clamp(
            deltaSeconds,
            0,
            0.1
        );

    let x =
        player.moveX;

    let y =
        player.moveY;

    if (
        !isFiniteNumber(x) ||
        !isFiniteNumber(y)
    ) {

        x = 0;
        y = 0;
    }

    const speed =
        player.role === "BEAR"
            ? BEAR_SPEED
            : SURVIVOR_SPEED;

    let newX =
        player.x +
        x *
        speed *
        deltaSeconds;

    let newY =
        player.y +
        y *
        speed *
        deltaSeconds;

    /*
     * LIMITES DO MAPA
     */

    const margin = 45;

    newX =
        clamp(
            newX,
            margin,
            MAP_WIDTH - margin
        );

    newY =
        clamp(
            newY,
            margin,
            MAP_HEIGHT - margin
        );

    /*
     * SEGURANÇA FINAL.
     */

    if (
        isFiniteNumber(newX) &&
        isFiniteNumber(newY)
    ) {

        player.x = newX;
        player.y = newY;
    }
}

/* =========================
   ATAQUE DO BEAR
========================= */

function bearAttack(player) {

    if (!player)
        return;

    if (
        player.role !== "BEAR"
    ) {
        return;
    }

    if (player.dead)
        return;

    const room =
        player.room;

    if (!room)
        return;

    if (
        room.phase !==
        "PLAYING"
    ) {
        return;
    }

    const now =
        Date.now();

    if (
        now -
        player.lastAttack <
        ATTACK_COOLDOWN
    ) {
        return;
    }

    player.lastAttack = now;

    let hitPlayer = null;

    let closestDistance =
        Infinity;

    for (
        const target of room.players
    ) {

        if (
            target.id ===
            player.id
        ) {
            continue;
        }

        if (
            target.role !==
            "SURVIVOR"
        ) {
            continue;
        }

        if (target.dead)
            continue;

        const d =
            distance(
                player.x,
                player.y,
                target.x,
                target.y
            );

        if (
            d <= ATTACK_RANGE &&
            d < closestDistance
        ) {

            closestDistance = d;

            hitPlayer = target;
        }
    }

    broadcast(
        room,
        {
            type: "attack",

            playerId:
                player.id,

            x: player.x,

            y: player.y,

            range:
                ATTACK_RANGE,

            hit:
                hitPlayer
                    ? hitPlayer.id
                    : null
        }
    );

    if (!hitPlayer)
        return;

    hitPlayer.hp -=
        ATTACK_DAMAGE;

    if (
        hitPlayer.hp <= 0
    ) {

        hitPlayer.hp = 0;

        hitPlayer.dead = true;

        hitPlayer.moveX = 0;
        hitPlayer.moveY = 0;

        player.kills++;

        broadcast(
            room,
            {
                type:
                    "player_eliminated",

                playerId:
                    hitPlayer.id,

                killerId:
                    player.id,

                players:
                    roomPlayers(room)
            }
        );

        checkRoundEnd(room);
    }
}

/* =========================
   FINAL DA PARTIDA
========================= */

function checkRoundEnd(room) {

    if (!room)
        return;

    if (
        room.phase !==
        "PLAYING"
    ) {
        return;
    }

    let bear = null;

    let survivorsAlive = 0;

    for (
        const player of room.players
    ) {

        if (
            player.role ===
            "BEAR"
        ) {

            bear = player;
        }

        if (
            player.role ===
            "SURVIVOR" &&
            !player.dead
        ) {

            survivorsAlive++;
        }
    }

    /*
     * BEAR morreu
     */

    if (
        !bear ||
        bear.dead ||
        bear.hp <= 0
    ) {

        endRound(
            room,
            "SURVIVORS"
        );

        return;
    }

    /*
     * Todos os survivors morreram
     */

    if (
        survivorsAlive <= 0
    ) {

        endRound(
            room,
            "BEAR"
        );
    }
}

/* =========================
   END ROUND
========================= */

function endRound(
    room,
    winner
) {

    if (!room)
        return;

    if (
        room.phase !==
        "PLAYING"
    ) {
        return;
    }

    room.phase = "ENDED";

    for (
        const player of room.players
    ) {

        player.moveX = 0;
        player.moveY = 0;
    }

    broadcast(
        room,
        {
            type: "round_end",

            winner: winner,

            players:
                roomPlayers(room)
        }
    );

    setTimeout(
        () => {

            if (!rooms.has(room.id))
                return;

            resetRoom(room);

        },
        5000
    );
}

/* =========================
   RESET
========================= */

function resetRoom(room) {

    if (!room)
        return;

    if (
        room.players.size <
        MIN_PLAYERS_TO_START
    ) {

        room.phase =
            "WAITING";

        room.countdown = 0;

        room.roundStartedAt = 0;
        room.roundEndsAt = 0;

        for (
            const player of room.players
        ) {

            player.role =
                "SURVIVOR";

            player.hp =
                SURVIVOR_HP;

            player.maxHp =
                SURVIVOR_HP;

            player.dead = false;

            player.moveX = 0;
            player.moveY = 0;
        }

        broadcast(
            room,
            {
                type: "waiting",

                players:
                    room.players.size,

                needed:
                    MIN_PLAYERS_TO_START
            }
        );

        return;
    }

    room.phase =
        "WAITING";

    room.countdown = 0;

    room.roundStartedAt = 0;
    room.roundEndsAt = 0;

    for (
        const player of room.players
    ) {

        player.role =
            "SURVIVOR";

        player.hp =
            SURVIVOR_HP;

        player.maxHp =
            SURVIVOR_HP;

        player.dead = false;

        player.moveX = 0;
        player.moveY = 0;

        const spawn =
            getSpawnPosition(
                "SURVIVOR"
            );

        player.x = spawn.x;
        player.y = spawn.y;
    }

    broadcast(
        room,
        {
            type: "waiting",

            players:
                room.players.size,

            needed: 0
        }
    );

    tryStartRound(room);
}

/* =========================
   WEBSOCKET
========================= */

wss.on(
    "connection",
    (ws) => {

        const player =
            createPlayer(ws);

        const room =
            findAvailableRoom();

        player.room = room;

        room.players.add(player);

        console.log(
            "Player entrou:",
            player.id,
            "Room:",
            room.id
        );

        /*
         * Primeiro envia conexão.
         */

        send(
            ws,
            {
                type: "connected",

                playerId:
                    player.id,

                roomId:
                    room.id
            }
        );

        /*
         * Snapshot inicial.
         */

        sendSnapshot(player);

        /*
         * Avisa os outros.
         */

        broadcast(
            room,
            {
                type:
                    "player_joined",

                player:
                    publicPlayer(player)
            }
        );

        /*
         * Tenta iniciar.
         */

        tryStartRound(room);

        ws.on(
            "message",
            (raw) => {

                handleMessage(
                    player,
                    raw
                );
            }
        );

        ws.on(
            "close",
            () => {

                removePlayer(player);
            }
        );

        ws.on(
            "error",
            () => {

                removePlayer(player);
            }
        );
    }
);

/* =========================
   MENSAGENS
========================= */

function handleMessage(
    player,
    raw
) {

    let data;

    try {

        data =
            JSON.parse(
                raw.toString()
            );

    } catch (e) {

        return;
    }

    if (!data || !data.type)
        return;

    /*
     * MOVIMENTO
     */

    if (
        data.type ===
        "move"
    ) {

        /*
         * O CLIENTE SÓ ENVIA
         * DIREÇÃO.
         *
         * Nunca posição.
         */

        setMovement(
            player,
            Number(data.x),
            Number(data.y)
        );

        return;
    }

    /*
     * PARAR
     */

    if (
        data.type ===
        "stop"
    ) {

        player.moveX = 0;
        player.moveY = 0;

        return;
    }

    /*
     * ATAQUE
     */

    if (
        data.type ===
        "attack"
    ) {

        bearAttack(player);

        return;
    }

    /*
     * NOME
     */

    if (
        data.type ===
        "set_name"
    ) {

        if (
            typeof data.name !==
            "string"
        ) {
            return;
        }

        let name =
            data.name
                .trim()
                .substring(0, 16);

        if (name.length === 0)
            name = "Guest";

        player.name = name;

        if (player.room) {

            broadcastState(
                player.room
            );
        }

        return;
    }

    /*
     * PING
     */

    if (
        data.type ===
        "ping"
    ) {

        send(
            player.ws,
            {
                type: "pong",

                time:
                    Date.now()
            }
        );

        return;
    }
}

/* =========================
   REMOVER PLAYER
========================= */

function removePlayer(player) {

    if (!player)
        return;

    /*
     * Evita executar duas vezes.
     */

    if (
        !players.has(
            player.id
        )
    ) {
        return;
    }

    players.delete(
        player.id
    );

    const room =
        player.room;

    if (!room)
        return;

    room.players.delete(
        player
    );

    player.room = null;

    console.log(
        "Player saiu:",
        player.id
    );

    broadcast(
        room,
        {
            type:
                "player_left",

            playerId:
                player.id
        }
    );

    /*
     * Se o BEAR saiu durante a partida,
     * survivors vencem.
     */

    if (
        room.phase ===
        "PLAYING" &&
        player.role ===
        "BEAR"
    ) {

        endRound(
            room,
            "SURVIVORS"
        );

        return;
    }

    /*
     * Se não há jogadores,
     * remove a sala.
     */

    if (
        room.players.size === 0
    ) {

        if (
            room.countdownTimer
        ) {

            clearInterval(
                room.countdownTimer
            );

            room.countdownTimer =
                null;
        }

        rooms.delete(
            room.id
        );

        return;
    }

    /*
     * Se estava esperando,
     * atualiza.
     */

    if (
        room.phase ===
        "WAITING"
    ) {

        tryStartRound(room);
    }

    /*
     * Se estava jogando,
     * verifica vitória.
     */

    if (
        room.phase ===
        "PLAYING"
    ) {

        checkRoundEnd(room);
    }
}

/* =========================
   GAME LOOP
========================= */

let lastTick =
    Date.now();

setInterval(
    () => {

        const now =
            Date.now();

        let delta =
            (now - lastTick) /
            1000;

        lastTick = now;

        /*
         * Nunca deixar atraso do servidor
         * virar teleport.
         */

        delta =
            clamp(
                delta,
                0,
                0.1
            );

        for (
            const player of players.values()
        ) {

            updatePlayerMovement(
                player,
                delta
            );
        }

        for (
            const room of rooms.values()
        ) {

            if (
                room.phase ===
                "PLAYING"
            ) {

                if (
                    Date.now() >=
                    room.roundEndsAt
                ) {

                    endRound(
                        room,
                        "SURVIVORS"
                    );

                    continue;
                }

                checkRoundEnd(room);
            }
        }

    },
    TICK_MS
);

/* =========================
   BROADCAST DE ESTADO
========================= */

setInterval(
    () => {

        for (
            const room of rooms.values()
        ) {

            if (
                room.phase ===
                "PLAYING"
            ) {

                broadcastState(room);
            }
        }

    },
    100
);

/* =========================
   HEARTBEAT
========================= */

setInterval(
    () => {

        for (
            const player of players.values()
        ) {

            if (
                player.ws.readyState !==
                WebSocket.OPEN
            ) {
                continue;
            }

            try {

                player.ws.ping();

            } catch (e) {

                removePlayer(player);
            }
        }

    },
    15000
);

/* =========================
   START SERVER
========================= */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "================================"
        );

        console.log(
            "BEAR Alpha 2D SERVER"
        );

        console.log(
            "Port:",
            PORT
        );

        console.log(
            "Map:",
            MAP_WIDTH +
            "x" +
            MAP_HEIGHT
        );

        console.log(
            "WebSocket ativo"
        );

        console.log(
            "================================"
        );
    }
);

/* =========================
   ERROS
========================= */

process.on(
    "uncaughtException",
    (error) => {

        console.error(
            "Erro não tratado:",
            error
        );
    }
);

process.on(
    "unhandledRejection",
    (error) => {

        console.error(
            "Promise rejeitada:",
            error
        );
    }
);

process.on(
    "SIGTERM",
    () => {

        console.log(
            "Servidor encerrando..."
        );

        for (
            const player of players.values()
        ) {

            send(
                player.ws,
                {
                    type:
                        "server_shutdown"
                }
            );

            try {
                player.ws.close();
            } catch (e) {}
        }

        server.close(
            () => {
                process.exit(0);
            }
        );
    }
);
