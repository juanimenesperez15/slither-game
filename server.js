const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 5000,
  pingTimeout: 10000,
});

app.use(express.static(path.join(__dirname, 'public')));

// Game config
const WORLD_W = 4000;
const WORLD_H = 4000;
const GAME_TPS = 60;       // Physics ticks per second
const NET_TPS = 20;         // Network sends per second
const FOOD_COUNT = 500;
const SPEED = 3.2;
const BOOST_SPEED = 5.5;
const SEGMENT_DIST = 12;
const START_LENGTH = 15;
const FOOD_GROW = 1;

// State
const players = {};
let food = [];

const SNAKE_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F0B27A', '#82E0AA',
  '#F1948A', '#AED6F1', '#D2B4DE', '#A3E4D7',
];

function randomColor() {
  return SNAKE_COLORS[Math.floor(Math.random() * SNAKE_COLORS.length)];
}

function spawnFood() {
  return {
    x: Math.random() * WORLD_W,
    y: Math.random() * WORLD_H,
    r: 5 + Math.random() * 4,
    color: `hsl(${Math.floor(Math.random() * 360)}, 80%, 60%)`,
  };
}

for (let i = 0; i < FOOD_COUNT; i++) {
  food.push(spawnFood());
}

function createPlayer(id, name) {
  const x = 200 + Math.random() * (WORLD_W - 400);
  const y = 200 + Math.random() * (WORLD_H - 400);
  const angle = Math.random() * Math.PI * 2;
  const segments = [];
  for (let i = 0; i < START_LENGTH; i++) {
    segments.push({
      x: x - Math.cos(angle) * i * SEGMENT_DIST,
      y: y - Math.sin(angle) * i * SEGMENT_DIST,
    });
  }
  return {
    id,
    name: name || 'Gusano',
    color: randomColor(),
    segments,
    angle,
    targetAngle: angle,
    boosting: false,
    score: 0,
    alive: true,
  };
}

function dropFood(segments) {
  const count = Math.min(segments.length, 30);
  for (let i = 0; i < count; i++) {
    const seg = segments[Math.floor(Math.random() * segments.length)];
    food.push({
      x: seg.x + (Math.random() - 0.5) * 30,
      y: seg.y + (Math.random() - 0.5) * 30,
      r: 5 + Math.random() * 5,
      color: `hsl(${Math.floor(Math.random() * 360)}, 80%, 60%)`,
    });
  }
}

function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function angleLerp(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// Round coords to save bandwidth
function roundSeg(s) {
  return { x: Math.round(s.x), y: Math.round(s.y) };
}

// ── Physics loop (60 TPS) ──
setInterval(() => {
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;

    p.angle = angleLerp(p.angle, p.targetAngle, 0.12);
    const speed = p.boosting ? BOOST_SPEED : SPEED;

    // Boost cost
    if (p.boosting && p.segments.length > 5 && Math.random() < 0.15) {
      const tail = p.segments.pop();
      food.push({ x: tail.x, y: tail.y, r: 4, color: p.color });
      p.score = Math.max(0, p.score - 2);
    }

    const head = p.segments[0];
    const newHead = {
      x: head.x + Math.cos(p.angle) * speed,
      y: head.y + Math.sin(p.angle) * speed,
    };

    // Border death
    if (newHead.x < 0 || newHead.x > WORLD_W || newHead.y < 0 || newHead.y > WORLD_H) {
      p.alive = false;
      dropFood(p.segments);
      io.to(id).emit('dead', { killer: null });
      continue;
    }

    p.segments.unshift(newHead);

    for (let i = 1; i < p.segments.length; i++) {
      const prev = p.segments[i - 1];
      const curr = p.segments[i];
      const dsq = distSq(prev, curr);
      if (dsq > SEGMENT_DIST * SEGMENT_DIST) {
        const d = Math.sqrt(dsq);
        const ratio = SEGMENT_DIST / d;
        curr.x = prev.x + (curr.x - prev.x) * ratio;
        curr.y = prev.y + (curr.y - prev.y) * ratio;
      }
    }

    if (p.segments.length > START_LENGTH + p.score) {
      p.segments.pop();
    }

    // Eat food (use distSq to avoid sqrt)
    const eatRadSq = (14 + 5) * (14 + 5); // approx max
    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];
      const threshold = f.r + 14;
      if (distSq(newHead, f) < threshold * threshold) {
        p.score += FOOD_GROW;
        food[i] = spawnFood();
      }
    }

    // Snake collision (use distSq)
    const collisionRadSq = 16 * 16;
    for (const otherId in players) {
      if (otherId === id) continue;
      const other = players[otherId];
      if (!other.alive) continue;

      for (let i = 5; i < other.segments.length; i++) {
        if (distSq(newHead, other.segments[i]) < collisionRadSq) {
          p.alive = false;
          dropFood(p.segments);
          other.score += Math.floor(p.segments.length / 3);

          for (let j = 0; j < Math.floor(p.segments.length / 5); j++) {
            const last = other.segments[other.segments.length - 1];
            other.segments.push({ x: last.x, y: last.y });
          }

          io.to(id).emit('dead', { killer: other.name });
          break;
        }
      }
    }
  }
}, 1000 / GAME_TPS);

// ── Network loop (20 TPS) ──
setInterval(() => {
  const leaderboard = Object.values(players)
    .filter(p => p.alive)
    .sort((a, b) => b.segments.length - a.segments.length)
    .slice(0, 10)
    .map(p => ({ n: p.name, s: p.segments.length }));

  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;

    const head = p.segments[0];
    const viewDist = 900;
    const viewDistSq = viewDist * viewDist;

    // Nearby players - send compressed segments
    const np = {};
    for (const oid in players) {
      const op = players[oid];
      if (!op.alive) continue;
      const oh = op.segments[0];
      const dx = Math.abs(oh.x - head.x);
      const dy = Math.abs(oh.y - head.y);
      const extraDist = op.segments.length * SEGMENT_DIST;
      if (dx < viewDist + extraDist && dy < viewDist + extraDist) {
        // Sample segments for long snakes to reduce data
        let segs;
        if (op.segments.length > 80) {
          segs = [];
          const step = Math.floor(op.segments.length / 60);
          for (let i = 0; i < op.segments.length; i += step) {
            segs.push(roundSeg(op.segments[i]));
          }
        } else {
          segs = op.segments.map(roundSeg);
        }
        np[oid] = {
          n: op.name,
          c: op.color,
          s: segs,
          b: op.boosting ? 1 : 0,
        };
      }
    }

    // Nearby food
    const nf = [];
    for (let i = 0; i < food.length; i++) {
      const f = food[i];
      if (Math.abs(f.x - head.x) < viewDist && Math.abs(f.y - head.y) < viewDist) {
        nf.push({ x: Math.round(f.x), y: Math.round(f.y), r: Math.round(f.r), c: f.color });
      }
    }

    io.volatile.to(id).emit('s', {
      p: np,
      f: nf,
      i: id,
      sc: p.segments.length,
      lb: leaderboard,
      t: Date.now(),
    });
  }
}, 1000 / NET_TPS);

// Socket connections
io.on('connection', (socket) => {
  console.log(`Conectado: ${socket.id}`);

  socket.on('join', (data) => {
    const name = (data.name || 'Gusano').substring(0, 15);
    players[socket.id] = createPlayer(socket.id, name);
    console.log(`${name} se unió al juego`);
  });

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (typeof data.angle === 'number') {
      p.targetAngle = data.angle;
    }
    p.boosting = !!data.boost;
  });

  socket.on('respawn', (data) => {
    const name = (data.name || 'Gusano').substring(0, 15);
    players[socket.id] = createPlayer(socket.id, name);
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p && p.alive) {
      dropFood(p.segments);
    }
    delete players[socket.id];
    console.log(`Desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
