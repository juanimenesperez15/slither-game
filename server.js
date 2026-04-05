const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 4000, pingTimeout: 8000, maxHttpBufferSize: 1e5 });
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ──
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

const LOBBY_TIME = 60;     // 1 min lobby
const MATCH_TIME = 180;    // 3 min match
const SHRINK_INTERVAL = 20; // shrink every 20s
const MAP_INITIAL = 2000;
const MAP_MIN = 300;

// ── Battle Royale state ──
// phase: 'lobby' | 'playing' | 'ended'
let phase = 'lobby';
let phaseStart = Date.now();
let mapSize = MAP_INITIAL; // current map boundary (square centered at MAP_INITIAL/2)
let mapCenter = MAP_INITIAL / 2;
let lastShrinkTime = 0;
let winner = null;

const players = {};    // all connected (alive or spectating)
let food = [];
let powerups = [];
const allTimeScores = [];

// Power-up types
const POWERUP_TYPES = [
  { type: 'speed',  color: '#FBBF24', icon: '\u26A1',     duration: 5000 },
  { type: 'shield', color: '#3B82F6', icon: '\uD83D\uDEE1\uFE0F', duration: 4000 },
  { type: 'magnet', color: '#A78BFA', icon: '\uD83E\uDDF2',       duration: 6000 },
  { type: 'x2',     color: '#22C55E', icon: '\u2716\uFE0F2',      duration: 8000 },
  { type: 'shrink', color: '#EF4444', icon: '\uD83D\uDC80',       duration: 0 },
  { type: 'ghost',  color: '#94A3B8', icon: '\uD83D\uDC7B',       duration: 4000 },
];

// ── Color validation ──
function isColorToosDark(hex) {
  if (!hex || hex.length < 7) return false;
  var r = parseInt(hex.substr(1, 2), 16);
  var g = parseInt(hex.substr(3, 2), 16);
  var b = parseInt(hex.substr(5, 2), 16);
  // Block very dark colors (luminance < 25) and dark blues
  var lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum < 25) return true;
  // Block dark blue: high blue, low red/green
  if (b > 100 && r < 40 && g < 40) return true;
  return false;
}

function sanitizeSkin(skin) {
  if (!skin || typeof skin !== 'string') return '#4ECDC4';
  var colors = skin.split(',');
  var clean = [];
  for (var i = 0; i < colors.length && i < 6; i++) {
    var c = colors[i].trim();
    if (/^#[0-9a-fA-F]{6}$/.test(c) && !isColorToosDark(c)) {
      clean.push(c);
    }
  }
  return clean.length ? clean.join(',') : '#4ECDC4';
}

// ── Map helpers ──
function getMapBounds() {
  var half = mapSize / 2;
  return { x1: mapCenter - half, y1: mapCenter - half, x2: mapCenter + half, y2: mapCenter + half };
}

function spawnInMap() {
  var b = getMapBounds();
  var pad = 100;
  return {
    x: b.x1 + pad + Math.random() * (mapSize - pad * 2),
    y: b.y1 + pad + Math.random() * (mapSize - pad * 2),
  };
}

function spawnFood() {
  var p = spawnInMap();
  return { x: p.x, y: p.y, r: 5 + Math.random() * 4, color: 'hsl(' + Math.floor(Math.random() * 360) + ', 80%, 60%)' };
}

function spawnPowerup() {
  var t = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  var p = spawnInMap();
  return { id: Date.now() + Math.random(), x: p.x, y: p.y, r: 12, type: t.type, color: t.color, icon: t.icon };
}

function initMap() {
  mapSize = MAP_INITIAL;
  food = []; powerups = [];
  for (var i = 0; i < FOOD_COUNT; i++) food.push(spawnFood());
  for (var j = 0; j < POWERUP_COUNT; j++) powerups.push(spawnPowerup());
}
initMap();

function createPlayer(id, name, skin) {
  var p = spawnInMap();
  var angle = Math.random() * Math.PI * 2;
  var segments = [];
  for (var i = 0; i < START_LENGTH; i++) {
    segments.push({ x: p.x - Math.cos(angle) * i * SEGMENT_DIST, y: p.y - Math.sin(angle) * i * SEGMENT_DIST });
  }
  return {
    id: id, name: name || 'Gusano', skin: sanitizeSkin(skin),
    segments: segments, angle: angle, targetAngle: angle,
    boosting: false, score: 0, alive: true, spectating: false,
    effects: {},
  };
}

function dropFood(segments) {
  var b = getMapBounds();
  var count = Math.min(segments.length, 30);
  for (var i = 0; i < count; i++) {
    var seg = segments[Math.floor(Math.random() * segments.length)];
    var fx = seg.x + (Math.random() - 0.5) * 30;
    var fy = seg.y + (Math.random() - 0.5) * 30;
    fx = Math.max(b.x1 + 5, Math.min(b.x2 - 5, fx));
    fy = Math.max(b.y1 + 5, Math.min(b.y2 - 5, fy));
    food.push({ x: fx, y: fy, r: 5 + Math.random() * 5, color: 'hsl(' + Math.floor(Math.random() * 360) + ', 80%, 60%)' });
  }
}

function distSq(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function angleLerp(a, b, t) { var d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; }
function roundSeg(s) { return { x: Math.round(s.x), y: Math.round(s.y) }; }
function hasEffect(p, type) { return p.effects[type] && p.effects[type] > Date.now(); }

function applyPowerup(p, type) {
  var def = POWERUP_TYPES.find(function(t) { return t.type === type; });
  if (!def) return;
  if (type === 'shrink') {
    for (var oid in players) {
      if (oid === p.id) continue;
      var other = players[oid];
      if (!other.alive || hasEffect(other, 'shield')) continue;
      var remove = Math.floor(other.segments.length * 0.2);
      for (var i = 0; i < remove && other.segments.length > 5; i++) { other.segments.pop(); other.score = Math.max(0, other.score - 1); }
    }
  } else {
    p.effects[type] = Date.now() + def.duration;
  }
}

function addAllTimeScore(name, score) {
  allTimeScores.push({ name: name, score: score, time: Date.now() });
  allTimeScores.sort(function(a, b) { return b.score - a.score; });
  if (allTimeScores.length > 50) allTimeScores.length = 50;
}
function getTopScores() { return allTimeScores.slice(0, 20).map(function(e) { return { n: e.name, s: e.score }; }); }

function killPlayer(p, killerName) {
  p.alive = false;
  p.spectating = true;
  var finalScore = p.segments.length;
  dropFood(p.segments);
  addAllTimeScore(p.name, finalScore);
  io.to(p.id).emit('dead', { killer: killerName, score: finalScore, ranking: getTopScores() });
}

function getAlivePlayers() {
  return Object.values(players).filter(function(p) { return p.alive; });
}

// ── Phase management ──
function startLobby() {
  phase = 'lobby';
  phaseStart = Date.now();
  winner = null;
  mapSize = MAP_INITIAL;
  lastShrinkTime = 0;
  initMap();
  // Kill all existing players so they rejoin
  for (var id in players) {
    players[id].alive = false;
    players[id].spectating = false;
  }
  io.emit('phase', { phase: 'lobby', time: LOBBY_TIME });
}

function startMatch() {
  phase = 'playing';
  phaseStart = Date.now();
  lastShrinkTime = Date.now();
  mapSize = MAP_INITIAL;
  initMap();
  // Spawn all players in a circle around center, facing outward
  var ids = Object.keys(players);
  var count = ids.length;
  var radius = Math.min(300, mapSize * 0.2);
  for (var i = 0; i < count; i++) {
    var old = players[ids[i]];
    var angleOnCircle = (i / count) * Math.PI * 2;
    var cx = mapCenter + Math.cos(angleOnCircle) * radius;
    var cy = mapCenter + Math.sin(angleOnCircle) * radius;
    var segments = [];
    // Face outward: head at circle edge, body toward center
    for (var j = 0; j < START_LENGTH; j++) {
      segments.push({ x: cx - Math.cos(angleOnCircle) * j * SEGMENT_DIST, y: cy - Math.sin(angleOnCircle) * j * SEGMENT_DIST });
    }
    players[ids[i]] = {
      id: ids[i], name: old.name, skin: sanitizeSkin(old.skin),
      segments: segments, angle: angleOnCircle, targetAngle: angleOnCircle,
      boosting: false, score: 0, alive: true, spectating: false, effects: {},
    };
  }
  io.emit('phase', { phase: 'playing', time: MATCH_TIME });
}

function endMatch(winnerPlayer) {
  phase = 'ended';
  phaseStart = Date.now();
  winner = winnerPlayer ? { name: winnerPlayer.name, score: winnerPlayer.segments.length } : null;
  io.emit('phase', { phase: 'ended', winner: winner, ranking: getTopScores() });
  // After 10 seconds, start new lobby
  setTimeout(startLobby, 10000);
}

// Start first lobby
startLobby();

// ── Physics loop ──
setInterval(function() {
  var now = Date.now();
  var elapsed = (now - phaseStart) / 1000;

  // Phase transitions
  if (phase === 'lobby') {
    if (elapsed >= LOBBY_TIME) {
      var connected = Object.keys(players).length;
      if (connected >= 1) { startMatch(); } else { startLobby(); } // restart lobby if empty
    }
    return; // No physics during lobby
  }

  if (phase === 'ended') return;

  // phase === 'playing'
  // Check match time
  if (elapsed >= MATCH_TIME) {
    var alive = getAlivePlayers();
    var best = alive.length ? alive.sort(function(a, b) { return b.segments.length - a.segments.length; })[0] : null;
    endMatch(best);
    return;
  }

  // Shrink map every SHRINK_INTERVAL seconds
  if (now - lastShrinkTime >= SHRINK_INTERVAL * 1000) {
    lastShrinkTime = now;
    var totalShrinks = Math.floor(MATCH_TIME / SHRINK_INTERVAL);
    var shrinkAmount = (MAP_INITIAL - MAP_MIN) / totalShrinks;
    mapSize = Math.max(MAP_MIN, mapSize - shrinkAmount);

    // Remove food/powerups outside new bounds
    var b = getMapBounds();
    food = food.filter(function(f) { return f.x >= b.x1 && f.x <= b.x2 && f.y >= b.y1 && f.y <= b.y2; });
    powerups = powerups.filter(function(pw) { return pw.x >= b.x1 && pw.x <= b.x2 && pw.y >= b.y1 && pw.y <= b.y2; });

    io.emit('shrink', { size: mapSize });
  }

  var bounds = getMapBounds();

  for (var id in players) {
    var p = players[id];
    if (!p.alive) continue;

    p.angle = angleLerp(p.angle, p.targetAngle, 0.12);
    var speed = SPEED;
    if (p.boosting) speed = BOOST_SPEED;
    if (hasEffect(p, 'speed')) speed *= 1.5;

    if (p.boosting && p.segments.length > 5 && Math.random() < 0.15) {
      var tail = p.segments.pop();
      food.push({ x: tail.x, y: tail.y, r: 4, color: '#888' });
      p.score = Math.max(0, p.score - 2);
    }

    var head = p.segments[0];
    var newHead = { x: head.x + Math.cos(p.angle) * speed, y: head.y + Math.sin(p.angle) * speed };

    // Border death (use current map bounds)
    if (newHead.x < bounds.x1 || newHead.x > bounds.x2 || newHead.y < bounds.y1 || newHead.y > bounds.y2) {
      if (hasEffect(p, 'shield')) {
        newHead.x = Math.max(bounds.x1 + 5, Math.min(bounds.x2 - 5, newHead.x));
        newHead.y = Math.max(bounds.y1 + 5, Math.min(bounds.y2 - 5, newHead.y));
        delete p.effects.shield;
      } else {
        killPlayer(p, null);
        continue;
      }
    }

    p.segments.unshift(newHead);
    for (var si = 1; si < p.segments.length; si++) {
      var prev = p.segments[si - 1], curr = p.segments[si];
      var dsq = distSq(prev, curr);
      if (dsq > SEG_DIST_SQ) { var d = Math.sqrt(dsq); var ratio = SEGMENT_DIST / d; curr.x = prev.x + (curr.x - prev.x) * ratio; curr.y = prev.y + (curr.y - prev.y) * ratio; }
    }
    if (p.segments.length > START_LENGTH + p.score) p.segments.pop();

    // Magnet
    if (hasEffect(p, 'magnet')) {
      for (var mi = 0; mi < food.length; mi++) {
        var mf = food[mi], mdsq = distSq(newHead, mf);
        if (mdsq < 14400 && mdsq > 1) { var md = Math.sqrt(mdsq); mf.x += (newHead.x - mf.x) / md * 2.5; mf.y += (newHead.y - mf.y) / md * 2.5; }
      }
    }

    // Eat food
    var multi = hasEffect(p, 'x2') ? 2 : 1;
    for (var fi = food.length - 1; fi >= 0; fi--) {
      var f = food[fi], thr = f.r + 14;
      if (distSq(newHead, f) < thr * thr) { p.score += FOOD_GROW * multi; food[fi] = spawnFood(); }
    }

    // Eat powerups
    for (var pi = powerups.length - 1; pi >= 0; pi--) {
      var pw = powerups[pi];
      if (distSq(newHead, pw) < (pw.r + 14) * (pw.r + 14)) {
        applyPowerup(p, pw.type);
        io.to(id).emit('powerup', { type: pw.type });
        powerups[pi] = spawnPowerup();
      }
    }

    // Collisions
    if (!hasEffect(p, 'ghost') && p.alive) {
      var collRSq = 16 * 16, died = false;
      // Self
      for (var sci = 15; sci < p.segments.length; sci++) {
        if (distSq(newHead, p.segments[sci]) < collRSq) {
          if (hasEffect(p, 'shield')) { delete p.effects.shield; } else { killPlayer(p, null); died = true; }
          break;
        }
      }
      // Others
      if (!died) {
        for (var oid in players) {
          if (oid === id || died) continue;
          var other = players[oid];
          if (!other.alive) continue;
          for (var oci = 5; oci < other.segments.length; oci++) {
            if (distSq(newHead, other.segments[oci]) < collRSq) {
              if (hasEffect(p, 'shield')) { delete p.effects.shield; }
              else {
                other.score += Math.floor(p.segments.length / 3);
                for (var oj = 0; oj < Math.floor(p.segments.length / 5); oj++) { var last = other.segments[other.segments.length - 1]; other.segments.push({ x: last.x, y: last.y }); }
                killPlayer(p, other.name); died = true;
              }
              break;
            }
          }
        }
      }
    }
  }

  // Check winner
  var alivePlayers = getAlivePlayers();
  if (phase === 'playing' && Object.keys(players).length > 1 && alivePlayers.length <= 1) {
    endMatch(alivePlayers[0] || null);
  }

  // Refill powerups
  while (powerups.length < POWERUP_COUNT) powerups.push(spawnPowerup());

}, 1000 / GAME_TPS);

// ── Network loop ──
setInterval(function() {
  if (phase === 'ended') return;
  var now = Date.now();
  var elapsed = Math.floor((now - phaseStart) / 1000);
  var timeLeft = (phase === 'lobby' ? LOBBY_TIME : MATCH_TIME) - elapsed;

  var alivePlayers = getAlivePlayers();
  var leaderboard = alivePlayers.sort(function(a, b) { return b.segments.length - a.segments.length; }).slice(0, 10)
    .map(function(p) { return { n: p.name, s: p.segments.length }; });

  var bounds = getMapBounds();

  for (var id in players) {
    var p = players[id];

    // Determine camera target (own head or first alive for spectators, or map center)
    var camPlayer = p.alive ? p : alivePlayers[0];
    var camHead;
    if (camPlayer && camPlayer.segments && camPlayer.segments.length) {
      camHead = camPlayer.segments[0];
    } else {
      camHead = { x: mapCenter, y: mapCenter }; // fallback: center of map
    }
    var viewDist = 900;

    var np = {};
    for (var oid in players) {
      var op = players[oid];
      if (!op.alive) continue;
      var oh = op.segments[0];
      var extra = op.segments.length * SEGMENT_DIST;
      if (Math.abs(oh.x - camHead.x) < viewDist + extra && Math.abs(oh.y - camHead.y) < viewDist + extra) {
        var segs;
        if (op.segments.length > 80) {
          segs = []; var step = Math.max(2, Math.floor(op.segments.length / 60));
          for (var i = 0; i < op.segments.length; i += step) segs.push(roundSeg(op.segments[i]));
        } else { segs = op.segments.map(roundSeg); }
        var fx = [];
        for (var k in op.effects) { if (op.effects[k] > now) fx.push(k); }
        np[oid] = { n: op.name, sk: op.skin, s: segs, b: op.boosting ? 1 : 0, fx: fx };
      }
    }

    var nf = [], npw = [];
    for (var fi = 0; fi < food.length; fi++) {
      var fd = food[fi];
      if (Math.abs(fd.x - camHead.x) < viewDist && Math.abs(fd.y - camHead.y) < viewDist)
        nf.push({ x: Math.round(fd.x), y: Math.round(fd.y), r: Math.round(fd.r), c: fd.color });
    }
    for (var pwi = 0; pwi < powerups.length; pwi++) {
      var pw = powerups[pwi];
      if (Math.abs(pw.x - camHead.x) < viewDist && Math.abs(pw.y - camHead.y) < viewDist)
        npw.push({ x: Math.round(pw.x), y: Math.round(pw.y), r: pw.r, t: pw.type, c: pw.color, ic: pw.icon });
    }

    io.volatile.to(id).emit('s', {
      p: np, f: nf, pw: npw,
      i: id, sc: p.alive ? p.segments.length : 0, lb: leaderboard,
      ph: phase, tl: Math.max(0, timeLeft), ms: Math.round(mapSize),
      ac: alivePlayers.length, spec: !p.alive && p.spectating ? 1 : 0,
      bx1: Math.round(bounds.x1), by1: Math.round(bounds.y1), bx2: Math.round(bounds.x2), by2: Math.round(bounds.y2),
    });
  }
}, 1000 / NET_TPS);

// ── Sockets ──
io.on('connection', function(socket) {
  socket.emit('ranking', getTopScores());
  socket.emit('phase', { phase: phase, time: Math.max(0, Math.floor(((phase === 'lobby' ? LOBBY_TIME : MATCH_TIME) * 1000 - (Date.now() - phaseStart)) / 1000)) });

  socket.on('join', function(data) {
    var name = (data.name || 'Gusano').substring(0, 15);
    var skin = sanitizeSkin(data.skin);
    if (phase === 'lobby') {
      players[socket.id] = createPlayer(socket.id, name, skin);
    } else if (phase === 'playing') {
      // Can't join mid-match, spectate instead
      players[socket.id] = { id: socket.id, name: name, skin: skin, segments: [{ x: 1000, y: 1000 }], angle: 0, targetAngle: 0, boosting: false, score: 0, alive: false, spectating: true, effects: {} };
      socket.emit('spectate', { msg: 'Partida en curso. Esperando la siguiente ronda...' });
    }
  });

  socket.on('input', function(data) {
    var p = players[socket.id];
    if (!p || !p.alive) return;
    if (typeof data.angle === 'number' && isFinite(data.angle)) p.targetAngle = data.angle;
    p.boosting = !!data.boost;
  });

  socket.on('respawn', function(data) {
    // Only allow respawn in lobby phase
    if (phase !== 'lobby') {
      socket.emit('spectate', { msg: 'Espera a la siguiente ronda para jugar.' });
      return;
    }
    var name = (data.name || 'Gusano').substring(0, 15);
    var skin = sanitizeSkin(data.skin);
    players[socket.id] = createPlayer(socket.id, name, skin);
  });

  socket.on('disconnect', function() {
    var p = players[socket.id];
    if (p && p.alive) dropFood(p.segments);
    delete players[socket.id];
  });
});

var PORT = process.env.PORT || 3333;
server.listen(PORT, '0.0.0.0', function() { console.log('Servidor BR en http://localhost:' + PORT); });
