const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const SIZE = 15;
const LIMIT_MS = 120000;
const SWITCH_DELAY_MS = 2000;

const BASE = [
  { x: 0, y: 1, p: "HEAD" },
  { x: -2, y: 0, p: "WING" },
  { x: -1, y: 0, p: "WING" },
  { x: 1, y: 0, p: "WING" },
  { x: 2, y: 0, p: "WING" },
  { x: 0, y: 0, p: "BODY" },
  { x: 0, y: -1, p: "BODY" },
  { x: 0, y: -2, p: "BODY" },
  { x: -1, y: -2, p: "TAIL" },
  { x: 1, y: -2, p: "TAIL" }
];

const rooms = new Map();

function emptyGrid() {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null));
}

function validName(name) {
  return /^[\u4e00-\u9fa5]{1,4}$/.test(String(name || "").trim());
}

function makeToken() {
  return crypto.randomBytes(16).toString("hex");
}

function makeRoomCode() {
  let code;
  do code = String(Math.floor(100000 + Math.random() * 900000));
  while (rooms.has(code));
  return code;
}

function newPlayer(name, token) {
  return {
    name,
    token: token || makeToken(),
    planes: [],
    grid: emptyGrid(),
    attacks: emptyGrid()
  };
}

function rotatePoint(pt, r) {
  let x = pt.x;
  let y = pt.y;
  for (let i = 0; i < r; i++) {
    const dx = x;
    const dy = y - 1;
    x = dy;
    y = 1 - dx;
  }
  return { x, y, p: pt.p };
}

function planeCells(cx, cy, rotation) {
  return BASE.map((p) => {
    const q = rotatePoint(p, rotation);
    return { x: cx + q.x, y: cy - q.y, p: q.p };
  });
}

function legalPlane(cells, player) {
  return cells.every((c) =>
    c.x >= 0 &&
    c.x < SIZE &&
    c.y >= 0 &&
    c.y < SIZE &&
    !player.grid[c.y][c.x]
  );
}

function rollDice(room) {
  const history = [];
  let a;
  let b;

  do {
    a = Math.floor(Math.random() * 6) + 1;
    b = Math.floor(Math.random() * 6) + 1;
    history.push([a, b]);
  } while (a === b);

  room.phase = "dice";
  room.dice = [a, b];
  room.diceHistory = history;
  room.diceStart = Date.now();
  room.diceEnd = Date.now() + Math.max(1800, history.length * 450);
  room.pendingTurn = a > b ? 0 : 1;
  room.turn = 0;
  room.lockUntil = 0;
}

function resetForRematch(room) {
  const p0 = newPlayer(room.players[0].name, room.players[0].token);
  const p1 = newPlayer(room.players[1].name, room.players[1].token);
  const now = Date.now();

  room.phase = "place";
  room.players = [p0, p1];
  room.placeDeadlines = [now + LIMIT_MS, now + LIMIT_MS];
  room.dice = [0, 0];
  room.diceHistory = [];
  room.diceStart = 0;
  room.diceEnd = 0;
  room.pendingTurn = 0;
  room.turn = 0;
  room.lockUntil = 0;
  room.winner = null;
  room.reason = "";
  room.rematch = [false, false];
}

function normalize(room) {
  const now = Date.now();

  if (room.phase === "place") {
    for (let i = 0; i < 2; i++) {
      const player = room.players[i];
      if (!player) continue;

      const done = player.planes.length >= room.planeCount;
      if (!done && room.placeDeadlines[i] <= now) {
        room.phase = "end";
        room.winner = 1 - i;
        room.reason = "TIMEOUT";
        room.lockUntil = 0;
        return;
      }
    }

    if (
      room.players[0] &&
      room.players[1] &&
      room.players[0].planes.length >= room.planeCount &&
      room.players[1].planes.length >= room.planeCount
    ) {
      rollDice(room);
      return;
    }
  }

  if (room.phase === "dice" && room.diceEnd <= now) {
    room.phase = "battle";
    room.turn = room.pendingTurn;
    room.lockUntil = 0;
  }

  if (room.phase === "battle" && room.lockUntil && room.lockUntil <= now) {
    room.turn = 1 - room.turn;
    room.lockUntil = 0;
  }
}

function findPlayer(room, token) {
  return room.players.findIndex((p) => p && p.token === token);
}

function publicState(room, playerId) {
  normalize(room);

  const me = room.players[playerId];
  const enemyId = 1 - playerId;
  const enemy = room.players[enemyId];
  const now = Date.now();
  const ownDone = me.planes.length >= room.planeCount;
  const enemyDone = enemy ? enemy.planes.length >= room.planeCount : false;

  return {
    room: room.code,
    phase: room.phase,
    playerId,
    planeCount: room.planeCount,
    names: room.players.map((p) => p ? p.name : null),
    ownPlaced: me.planes.length,
    enemyPlaced: enemy ? enemy.planes.length : 0,
    ownDone,
    enemyDone,
    timeLeft: room.phase === "place" && !ownDone ? Math.max(0, Math.ceil((room.placeDeadlines[playerId] - now) / 1000)) : 0,
    enemyTimeLeft: room.phase === "place" && enemy && !enemyDone ? Math.max(0, Math.ceil((room.placeDeadlines[enemyId] - now) / 1000)) : 0,
    dice: room.dice,
    diceHistory: room.diceHistory,
    diceStart: room.diceStart,
    turn: room.turn,
    lockMs: room.lockUntil ? Math.max(0, room.lockUntil - now) : 0,
    winner: room.winner,
    reason: room.reason,
    rematch: room.rematch,
    ownGrid: me.grid,
    ownAttacks: me.attacks,
    enemyView: enemy ? enemy.attacks : emptyGrid()
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1000000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("BAD_JSON"));
      }
    });
  });
}

function auth(data) {
  const room = rooms.get(String(data.room || ""));
  if (!room) return { error: "房间不存在" };

  const playerId = findPlayer(room, data.token);
  if (playerId < 0) return { error: "身份无效" };

  normalize(room);
  return { room, playerId };
}

setInterval(() => {
  for (const room of rooms.values()) normalize(room);
}, 250);

const manifest = {
  name: "藏好你的飞机",
  short_name: "藏飞机",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0E0E1A",
  theme_color: "#1A1A2E",
  description: "双人联机打飞机游戏",
  icons: [
    {
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any maskable"
    }
  ]
};

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#1A1A2E"/>
  <circle cx="256" cy="256" r="210" fill="#25254A"/>
  <text x="256" y="285" font-size="210" text-anchor="middle" dominant-baseline="middle">✈️</text>
  <text x="256" y="430" font-size="54" text-anchor="middle" fill="#FFD866" font-family="Arial, sans-serif" font-weight="bold">藏飞机</text>
</svg>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8" });
      res.end(JSON.stringify(manifest));
      return;
    }

    if (req.method === "GET" && (url.pathname === "/icon.svg" || url.pathname === "/favicon.ico")) {
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
      res.end(iconSvg);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const file = path.join(__dirname, "index.html");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const room = rooms.get(String(url.searchParams.get("room") || ""));
      if (!room) return sendJson(res, 404, { ok: false, error: "房间不存在" });

      const playerId = findPlayer(room, url.searchParams.get("token"));
      if (playerId < 0) return sendJson(res, 403, { ok: false, error: "身份无效" });

      return sendJson(res, 200, { ok: true, state: publicState(room, playerId) });
    }

    if (req.method !== "POST") {
      return sendJson(res, 404, { ok: false, error: "接口不存在" });
    }

    const data = await readJson(req);

    if (url.pathname === "/api/create") {
      const name = String(data.name || "").trim();
      const planeCount = Number(data.planeCount);

      if (!validName(name)) return sendJson(res, 400, { ok: false, error: "姓名必须是1到4个汉字" });
      if (![1, 2, 3].includes(planeCount)) return sendJson(res, 400, { ok: false, error: "飞机数量必须是1到3架" });

      const code = makeRoomCode();
      const p0 = newPlayer(name);

      const room = {
        code,
        phase: "lobby",
        planeCount,
        players: [p0, null],
        placeDeadlines: [0, 0],
        dice: [0, 0],
        diceHistory: [],
        diceStart: 0,
        diceEnd: 0,
        pendingTurn: 0,
        turn: 0,
        lockUntil: 0,
        winner: null,
        reason: "",
        rematch: [false, false]
      };

      rooms.set(code, room);
      return sendJson(res, 200, { ok: true, room: code, token: p0.token, playerId: 0 });
    }

    if (url.pathname === "/api/join") {
      const code = String(data.room || "").trim();
      const name = String(data.name || "").trim();
      const room = rooms.get(code);

      if (!room) return sendJson(res, 404, { ok: false, error: "房间不存在" });
      if (room.phase !== "lobby" || room.players[1]) return sendJson(res, 400, { ok: false, error: "房间已开始" });
      if (!validName(name)) return sendJson(res, 400, { ok: false, error: "姓名必须是1到4个汉字" });
      if (room.players[0].name === name) return sendJson(res, 400, { ok: false, error: "两位玩家姓名不能相同" });

      const now = Date.now();
      const p1 = newPlayer(name);

      room.players[1] = p1;
      room.phase = "place";
      room.placeDeadlines = [now + LIMIT_MS, now + LIMIT_MS];

      return sendJson(res, 200, { ok: true, room: code, token: p1.token, playerId: 1 });
    }

    if (url.pathname === "/api/place") {
      const a = auth(data);
      if (a.error) return sendJson(res, 403, { ok: false, error: a.error });

      const { room, playerId } = a;
      if (room.phase !== "place") return sendJson(res, 400, { ok: false, error: "当前不能放置" });

      const player = room.players[playerId];
      if (player.planes.length >= room.planeCount) return sendJson(res, 400, { ok: false, error: "你已完成放置" });

      const cx = Number(data.x);
      const cy = Number(data.y);
      const rotation = Number(data.rotation) % 4;

      if (!Number.isInteger(cx) || !Number.isInteger(cy) || !Number.isInteger(rotation)) {
        return sendJson(res, 400, { ok: false, error: "坐标无效" });
      }

      const cells = planeCells(cx, cy, rotation);
      if (!legalPlane(cells, player)) return sendJson(res, 400, { ok: false, error: "位置非法" });

      const planeId = player.planes.length;
      player.planes.push({ cells, down: false });
      cells.forEach((c) => {
        player.grid[c.y][c.x] = { plane: planeId, part: c.p };
      });

      if (player.planes.length < room.planeCount) {
        room.placeDeadlines[playerId] = Date.now() + LIMIT_MS;
      } else {
        room.placeDeadlines[playerId] = 0;
      }

      normalize(room);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/attack") {
      const a = auth(data);
      if (a.error) return sendJson(res, 403, { ok: false, error: a.error });

      const { room, playerId } = a;
      normalize(room);

      if (room.phase !== "battle") return sendJson(res, 400, { ok: false, error: "当前不能攻击" });
      if (playerId !== room.turn) return sendJson(res, 400, { ok: false, error: "还没轮到你攻击" });
      if (room.lockUntil && room.lockUntil > Date.now()) return sendJson(res, 400, { ok: false, error: "等待回合切换" });

      const x = Number(data.x);
      const y = Number(data.y);

      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE) {
        return sendJson(res, 400, { ok: false, error: "坐标无效" });
      }

      const target = room.players[1 - playerId];
      if (target.attacks[y][x]) return sendJson(res, 400, { ok: false, error: "该格子已攻击过" });

      const hit = target.grid[y][x];

      if (!hit) {
        target.attacks[y][x] = { kind: "MISS" };
        room.lockUntil = Date.now() + SWITCH_DELAY_MS;
        return sendJson(res, 200, { ok: true, result: "MISS" });
      }

      target.attacks[y][x] = { kind: "HIT", part: hit.part, plane: hit.plane };

      if (hit.part === "HEAD") {
        const plane = target.planes[hit.plane];
        plane.down = true;

        plane.cells.forEach((c) => {
          target.attacks[c.y][c.x] = { kind: "HIT", part: c.p, plane: hit.plane };
        });

        if (target.planes.every((p) => p.down)) {
          room.phase = "end";
          room.winner = playerId;
          room.reason = "WIN";
          room.lockUntil = 0;
          return sendJson(res, 200, { ok: true, result: "WIN" });
        }
      }

      room.lockUntil = Date.now() + SWITCH_DELAY_MS;
      return sendJson(res, 200, { ok: true, result: "HIT" });
    }

    if (url.pathname === "/api/rematch") {
      const a = auth(data);
      if (a.error) return sendJson(res, 403, { ok: false, error: a.error });

      const { room, playerId } = a;
      if (room.phase !== "end") return sendJson(res, 400, { ok: false, error: "当前不能重开" });

      room.rematch[playerId] = true;
      if (room.rematch[0] && room.rematch[1]) resetForRematch(room);

      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: "接口不存在" });
  } catch {
    return sendJson(res, 500, { ok: false, error: "服务器错误" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`服务器已启动，端口：${PORT}`);
  console.log(`本机地址: http://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat().filter(Boolean).forEach((net) => {
    if (net.family === "IPv4" && !net.internal) {
      console.log(`局域网地址: http://${net.address}:${PORT}`);
    }
  });
});
