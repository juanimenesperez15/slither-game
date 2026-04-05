const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 4000,
  pingTimeout: 8000,
  maxHttpBufferSize: 1e5,
});

app.use(express.static(path.join(__dirname, 'public')));

// Game config
const WORLD_W = 2000;
const WORLD_H = 2000;
const GAME_TPS = 60;
const NET_TPS = 30;
const FOOD_COUNT = 400;
const POWERUP_COUNT = 8;
const SPEED = 3.2;
const BOOST_SPEED = 5.5;
const SEGMENT_DIST = 12;
const START_LENGTH = 15;
const FOOD_GROW = 1;
const SEG_DIST_SQ = SEGMENT_DIST * SEGMENT_DIST;

// State
const players = {};
let food = [];
let powerups = [];
const allTimeScores = [];

// Power-up types
const POWERUP_TYPES = [
  { type: 'speed',   color: '#FBBF24', icon: '⚡', duration: 5000, desc: 'Velocidad x1.5' },
  { type: 'shield',  color: '#3B82F6', icon: '🛡️', duration: 4000, desc: 'Escudo temporal' },
  { type: 'magnet',  color: '#A78BFA', icon: '🧲', duration: 6000, desc: 'Imán de comida' },
  { type: 'x2',      color: '#22C55E', icon: '✖️2', duration: 8000, desc: 'Puntos x2' },
  { type: 'shrink',  color: '#EF4444', icon: '💀', duration: 0,    desc: 'Reduce enemigos' },
  { type: 'ghost',   color: '#94A3B8', icon: '👻', duration: 4000, desc: 'Atravesar cuerpos' },
];

function spawnFood() {
  return {
    x: 20 + Math.random() * (WORLD_W - 40),
    y: 20 + Math.random() * (WORLD_H - 40),
    r: 5 + Math.random() * 4,
    color: `hsl(${Math.floor(Math.random() * 360)}, 80%, 60%)`,
  };
}

function spawnPowerup() {
  const t = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  return {
    id: Date.now() + Math.random(),
    x: 100 + Math.random() * (WORLD_W - 200),
    y: 100 + Math.random() * (WORLD_H - 200),
    r: 12,
    type: t.type,
    color: t.color,
    icon: t.icon,
  };
}

for (let i = 0; i < FOOD_COUNT; i++) food.push(spawnFood());
for (let i = 0; i < POWERUP_COUNT; i++) powerups.push(spawnPowerup());

function createPlayer(id, name, skin) {
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
    id, name: name || 'Gusano', skin: skin || 'classic',
    segments, angle, targetAngle: angle,
    boosting: false, score: 0, alive: true,
    effects: {}, // { speed: expireTime, shield: expireTime, ... }
  };
}

function dropFood(segments) {
  const count = Math.min(segments.length, 30);
  for (let i = 0; i < count; i++) {
    const seg = segments[Math.floor(Math.random() * segments.length)];
    food.push({
      x: Math.max(5, Math.min(WORLD_W - 5, seg.x + (Math.random() - 0.5) * 30)),
      y: Math.max(5, Math.min(WORLD_H - 5, seg.y + (Math.random() - 0.5) * 30)),
      r: 5 + Math.random() * 5,
      color: `hsl(${Math.floor(Math.random() * 360)}, 80%, 60%)`,
    });
  }
}

function distSq(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function angleLerp(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function roundSeg(s) { return { x: Math.round(s.x), y: Math.round(s.y) }; }

function hasEffect(p, type) {
  return p.effects[type] && p.effects[type] > Date.now();
}

function applyPowerup(p, type) {
  const now = Date.now();
  const def = POWERUP_TYPES.find(t => t.type === type);
  if (!def) return;

  if (type === 'shrink') {
    // Shrink all OTHER alive players by 20%
    for (const oid in players) {
      if (oid === p.id) continue;
      const other = players[oid];
      if (!other.alive || hasEffect(other, 'shield')) continue;
      const remove = Math.floor(other.segments.length * 0.2);
      for (let i = 0; i < remove && other.segments.length > 5; i++) {
        other.segments.pop();
        other.score = Math.max(0, other.score - 1);
      }
    }
  } else {
    p.effects[type] = now + def.duration;
  }
}

function addAllTimeScore(name, score) {
  allTimeScores.push({ name, score, time: Date.now() });
  allTimeScores.sort((a, b) => b.score - a.score);
  if (allTimeScores.length > 50) allTimeScores.length = 50;
}

function getTopScores() {
  return allTimeScores.slice(0, 20).map(e => ({ n: e.name, s: e.score }));
}

function killPlayer(p, killerName) {
  p.alive = false;
  const finalScore = p.segments.length;
  dropFood(p.segments);
  addAllTimeScore(p.name, finalScore);
  io.to(p.id).emit('dead', { killer: killerName, score: finalScore, ranking: getTopScores() });
}

// ── Physics loop ──
setInterval(() => {
  const now = Date.now();

  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;

    p.angle = angleLerp(p.angle, p.targetAngle, 0.12);

    // Speed calculation
    let speed = SPEED;
    if (p.boosting) speed = BOOST_SPEED;
    if (hasEffect(p, 'speed')) speed *= 1.5;

    // Boost cost
    if (p.boosting && p.segments.length > 5 && Math.random() < 0.15) {
      const tail = p.segments.pop();
      food.push({ x: tail.x, y: tail.y, r: 4, color: '#888' });
      p.score = Math.max(0, p.score - 2);
    }

    const head = p.segments[0];
    const newHead = {
      x: head.x + Math.cos(p.angle) * speed,
      y: head.y + Math.sin(p.angle) * speed,
    };

    // Border death (shield saves you)
    if (newHead.x < 0 || newHead.x > WORLD_W || newHead.y < 0 || newHead.y > WORLD_H) {
      if (hasEffect(p, 'shield')) {
        newHead.x = Math.max(5, Math.min(WORLD_W - 5, newHead.x));
        newHead.y = Math.max(5, Math.min(WORLD_H - 5, newHead.y));
        delete p.effects.shield; // Shield breaks
      } else {
        killPlayer(p, null);
        continue;
      }
    }

    p.segments.unshift(newHead);

    for (let i = 1; i < p.segments.length; i++) {
      const prev = p.segments[i - 1];
      const curr = p.segments[i];
      const dsq = distSq(prev, curr);
      if (dsq > SEG_DIST_SQ) {
        const d = Math.sqrt(dsq);
        const ratio = SEGMENT_DIST / d;
        curr.x = prev.x + (curr.x - prev.x) * ratio;
        curr.y = prev.y + (curr.y - prev.y) * ratio;
      }
    }

    if (p.segments.length > START_LENGTH + p.score) {
      p.segments.pop();
    }

    // Magnet: pull nearby food toward head
    if (hasEffect(p, 'magnet')) {
      const magnetRSq = 120 * 120;
      for (let i = 0; i < food.length; i++) {
        const f = food[i];
        const dsq = distSq(newHead, f);
        if (dsq < magnetRSq && dsq > 1) {
          const d = Math.sqrt(dsq);
          const pull = 2.5;
          f.x += (newHead.x - f.x) / d * pull;
          f.y += (newHead.y - f.y) / d * pull;
        }
      }
    }

    // Eat food
    const scoreMulti = hasEffect(p, 'x2') ? 2 : 1;
    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];
      const threshold = f.r + 14;
      if (distSq(newHead, f) < threshold * threshold) {
        p.score += FOOD_GROW * scoreMulti;
        food[i] = spawnFood();
      }
    }

    // Eat powerups
    for (let i = powerups.length - 1; i >= 0; i--) {
      const pw = powerups[i];
      if (distSq(newHead, pw) < (pw.r + 14) * (pw.r + 14)) {
        applyPowerup(p, pw.type);
        io.to(id).emit('powerup', { type: pw.type });
        powerups[i] = spawnPowerup();
      }
    }

    // Snake collision (ghost = pass through, includes self-collision)
    if (!hasEffect(p, 'ghost') && p.alive) {
      const collisionRadSq = 16 * 16;
      let died = false;

      // Self-collision: skip first 15 segments to avoid instant death on tight turns
      for (let i = 15; i < p.segments.length; i++) {
        if (distSq(newHead, p.segments[i]) < collisionRadSq) {
          if (hasEffect(p, 'shield')) {
            delete p.effects.shield;
          } else {
            killPlayer(p, null);
            died = true;
          }
          break;
        }
      }

      // Other snake collision
      if (!died) {
        for (const otherId in players) {
          if (otherId === id) continue;
          if (died) break;
          const other = players[otherId];
          if (!other.alive) continue;

          for (let i = 5; i < other.segments.length; i++) {
            if (distSq(newHead, other.segments[i]) < collisionRadSq) {
              if (hasEffect(p, 'shield')) {
                delete p.effects.shield;
              } else {
                other.score += Math.floor(p.segments.length / 3);
                for (let j = 0; j < Math.floor(p.segments.length / 5); j++) {
                  const last = other.segments[other.segments.length - 1];
                  other.segments.push({ x: last.x, y: last.y });
                }
                killPlayer(p, other.name);
                died = true;
              }
              break;
            }
          }
        }
      }
    }
  }

  // Respawn powerups if needed
  while (powerups.length < POWERUP_COUNT) powerups.push(spawnPowerup());

}, 1000 / GAME_TPS);

// ── Network loop ──
let netTick = 0;
setInterval(() => {
  netTick++;
  const now = Date.now();
  const alivePlayers = Object.values(players).filter(p => p.alive);

  const leaderboard = alivePlayers
    .sort((a, b) => b.segments.length - a.segments.length)
    .slice(0, 10)
    .map(p => ({ n: p.name, s: p.segments.length }));

  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;

    const head = p.segments[0];
    const viewDist = 900;

    // Nearby players
    const np = {};
    for (const oid in players) {
      const op = players[oid];
      if (!op.alive) continue;
      const oh = op.segments[0];
      const extra = op.segments.length * SEGMENT_DIST;
      if (Math.abs(oh.x - head.x) < viewDist + extra && Math.abs(oh.y - head.y) < viewDist + extra) {
        let segs;
        if (op.segments.length > 80) {
          segs = [];
          const step = Math.max(2, Math.floor(op.segments.length / 60));
          for (let i = 0; i < op.segments.length; i += step) segs.push(roundSeg(op.segments[i]));
        } else {
          segs = op.segments.map(roundSeg);
        }
        // Build active effects list
        const fx = [];
        for (const k in op.effects) { if (op.effects[k] > now) fx.push(k); }

        np[oid] = { n: op.name, sk: op.skin, s: segs, b: op.boosting ? 1 : 0, fx };
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

    // Nearby powerups
    const npw = [];
    for (let i = 0; i < powerups.length; i++) {
      const pw = powerups[i];
      if (Math.abs(pw.x - head.x) < viewDist && Math.abs(pw.y - head.y) < viewDist) {
        npw.push({ x: Math.round(pw.x), y: Math.round(pw.y), r: pw.r, t: pw.type, c: pw.color, ic: pw.icon });
      }
    }

    io.volatile.to(id).emit('s', {
      p: np, f: nf, pw: npw,
      i: id, sc: p.segments.length, lb: leaderboard,
    });
  }
}, 1000 / NET_TPS);

// Socket connections
io.on('connection', (socket) => {
  socket.emit('ranking', getTopScores());

  socket.on('join', (data) => {
    const name = (data.name || 'Gusano').substring(0, 15);
    const skin = typeof data.skin === 'string' ? data.skin.substring(0, 50) : 'classic';
    players[socket.id] = createPlayer(socket.id, name, skin);
  });

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (typeof data.angle === 'number' && isFinite(data.angle)) {
      p.targetAngle = data.angle;
    }
    p.boosting = !!data.boost;
  });

  socket.on('respawn', (data) => {
    const name = (data.name || 'Gusano').substring(0, 15);
    const skin = typeof data.skin === 'string' ? data.skin.substring(0, 50) : 'classic';
    players[socket.id] = createPlayer(socket.id, name, skin);
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p && p.alive) dropFood(p.segments);
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
