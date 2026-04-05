const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Game config
const WORLD_W = 4000;
const WORLD_H = 4000;
const TICK_RATE = 60;
const FOOD_COUNT = 500;
const SPEED = 3.2;
const BOOST_SPEED = 5.5;
const SEGMENT_DIST = 12;
const START_LENGTH = 15;
const FOOD_GROW = 1;

// State
const players = {};
let food = [];

// Colors for snakes
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

// Initialize food
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

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function angleLerp(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// Game loop
setInterval(() => {
  // Update each player
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;

    // Smooth turn
    p.angle = angleLerp(p.angle, p.targetAngle, 0.12);

    const speed = p.boosting ? BOOST_SPEED : SPEED;

    // Lose segments when boosting
    if (p.boosting && p.segments.length > 5 && Math.random() < 0.15) {
      const tail = p.segments.pop();
      food.push({
        x: tail.x,
        y: tail.y,
        r: 4,
        color: p.color,
      });
      p.score = Math.max(0, p.score - 1);
    }

    // Move head
    const head = p.segments[0];
    const newHead = {
      x: head.x + Math.cos(p.angle) * speed,
      y: head.y + Math.sin(p.angle) * speed,
    };

    // World boundaries - die on border hit
    if (newHead.x < 0 || newHead.x > WORLD_W || newHead.y < 0 || newHead.y > WORLD_H) {
      p.alive = false;
      dropFood(p.segments);
      io.to(id).emit('dead', { killer: null });
      continue;
    }

    p.segments.unshift(newHead);

    // Maintain segment spacing
    for (let i = 1; i < p.segments.length; i++) {
      const prev = p.segments[i - 1];
      const curr = p.segments[i];
      const d = dist(prev, curr);
      if (d > SEGMENT_DIST) {
        const ratio = SEGMENT_DIST / d;
        curr.x = prev.x + (curr.x - prev.x) * ratio;
        curr.y = prev.y + (curr.y - prev.y) * ratio;
      }
    }

    // Remove extra tail segment (constant length unless growing)
    if (p.segments.length > START_LENGTH + p.score) {
      p.segments.pop();
    }

    // Eat food
    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];
      if (dist(newHead, f) < f.r + 14) {
        p.score += FOOD_GROW;
        food[i] = spawnFood();
      }
    }

    // Collision with other snakes
    for (const otherId in players) {
      if (otherId === id) continue;
      const other = players[otherId];
      if (!other.alive) continue;

      // Check head vs other body (skip first 5 segments to avoid unfair collisions)
      for (let i = 5; i < other.segments.length; i++) {
        const seg = other.segments[i];
        if (dist(newHead, seg) < 16) {
          // This player dies
          p.alive = false;
          dropFood(p.segments);
          other.score += Math.floor(p.segments.length / 3);

          // Add segments to killer
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

  // Build leaderboard
  const leaderboard = Object.values(players)
    .filter(p => p.alive)
    .sort((a, b) => b.segments.length - a.segments.length)
    .slice(0, 10)
    .map(p => ({ name: p.name, score: p.segments.length }));

  // Send state to each player (only nearby data)
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;

    const head = p.segments[0];
    const viewDist = 900;

    // Nearby players
    const nearPlayers = {};
    for (const oid in players) {
      const op = players[oid];
      if (!op.alive) continue;
      // Check if any segment is visible
      const oh = op.segments[0];
      if (Math.abs(oh.x - head.x) < viewDist + op.segments.length * SEGMENT_DIST ||
          Math.abs(oh.y - head.y) < viewDist + op.segments.length * SEGMENT_DIST) {
        nearPlayers[oid] = {
          name: op.name,
          color: op.color,
          segments: op.segments,
          boosting: op.boosting,
        };
      }
    }

    // Nearby food
    const nearFood = food.filter(f =>
      Math.abs(f.x - head.x) < viewDist &&
      Math.abs(f.y - head.y) < viewDist
    );

    io.to(id).emit('state', {
      players: nearPlayers,
      food: nearFood,
      you: id,
      score: p.segments.length,
      leaderboard,
      world: { w: WORLD_W, h: WORLD_H },
    });
  }
}, 1000 / TICK_RATE);

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
  console.log(`🐍 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📡 Para jugar en LAN, compartí tu IP local con el puerto ${PORT}`);
});
