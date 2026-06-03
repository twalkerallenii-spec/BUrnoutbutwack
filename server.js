// REDLINE multiplayer server
// ---------------------------
// A lightweight authoritative-ish lobby + relay server.
//
// Responsibilities:
//   - Accept WebSocket connections from game clients.
//   - Group players into rooms (one room per world+event).
//   - Run a 60-second JOIN timer once the first player enters a room.
//   - When the timer expires (or the room is full), START the race and
//     fill any empty grid slots with server-driven AI placeholders.
//   - Relay each human player's state (position, speed, etc.) to everyone
//     else in the room ~15x/sec, and tick simple AI so remote clients can
//     render the bots.
//
// Design notes / honesty:
//   - This is a *relay* model: each client still simulates its own car and
//     just broadcasts where it is. That's simple and robust for an arcade
//     racer but it is NOT cheat-proof and does NOT do lag compensation.
//     For a hobby game that's fine; for anything competitive you'd move the
//     simulation server-side.
//   - The AI here is intentionally simple (advances down the track at a
//     pace, light side-to-side). The client renders these bots using the
//     same car model as human rivals.
//
// Protocol (JSON messages over WS):
//   client -> server:
//     {t:'join', name, world, event}                  // ask to join a room
//     {t:'state', x, dist, speed, boosting, crashed}  // my car state (frequent)
//     {t:'event', kind, ...}                          // takedown/finish/etc (rare)
//     {t:'leave'}                                      // graceful exit
//   server -> client:
//     {t:'joined', id, room, slot, players:[...]}      // accepted; your id+slot
//     {t:'lobby', count, capacity, secondsLeft}        // lobby countdown ticks
//     {t:'start', grid:[{id,slot,ai,name}]}            // race begins; full grid
//     {t:'snapshot', cars:[{id,x,dist,speed,boosting,crashed,ai}]}  // world state
//     {t:'player_join', player} / {t:'player_leave', id}
//     {t:'event', from, kind, ...}                     // relayed gameplay event
//     {t:'finished', id, position}                     // someone finished

import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 8080;     // Render provides PORT
const ROOM_CAPACITY = 6;                    // total cars per race (humans + AI)
const JOIN_WINDOW_MS = 60_000;              // 1 minute lobby wait
const SNAPSHOT_HZ = 15;                     // state broadcasts per second
const AI_TICK_HZ = 20;

// ---- tiny HTTP server so Render health checks pass + a status page ----
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: totalPlayers() }));
  } else {
    res.writeHead(404); res.end();
  }
});

const wss = new WebSocketServer({ server: httpServer });

// ---- state ----
let nextClientId = 1;
const rooms = new Map(); // key: `${world}:${event}` -> room object

function totalPlayers() {
  let n = 0; for (const r of rooms.values()) n += r.humans.size; return n;
}

function roomKey(world, event) { return `${world}:${event}`; }

function getOrCreateRoom(world, event) {
  const key = roomKey(world, event);
  let room = rooms.get(key);
  // only reuse a room that is still in the lobby phase; otherwise open a fresh one
  if (room && room.phase !== 'lobby') {
    // append a counter so a new lobby spins up while the old race runs
    let n = 2;
    while (rooms.get(`${key}#${n}`) && rooms.get(`${key}#${n}`).phase !== 'lobby') n++;
    const altKey = `${key}#${n}`;
    room = rooms.get(altKey);
    if (!room) { room = makeRoom(altKey, world, event); rooms.set(altKey, room); }
    return room;
  }
  if (!room) { room = makeRoom(key, world, event); rooms.set(key, room); }
  return room;
}

function makeRoom(key, world, event) {
  return {
    key, world, event,
    phase: 'lobby',            // 'lobby' | 'racing' | 'done'
    humans: new Map(),         // id -> {id, ws, name, slot, state}
    ais: [],                   // [{id, slot, name, x, dist, speed, baseSpeed}]
    grid: [],                  // finalized [{id, slot, ai, name}]
    startsAt: Date.now() + JOIN_WINDOW_MS,
    lobbyTimer: null,
    snapTimer: null,
    aiTimer: null,
    lobbyTickTimer: null,
  };
}

const SLOT_X = [-6, 6, 16, -16, 26, -26]; // grid lateral offsets per slot

function broadcast(room, msg, exceptId = null) {
  const s = JSON.stringify(msg);
  for (const p of room.humans.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(s);
  }
}

function playerList(room) {
  return [...room.humans.values()].map(p => ({ id: p.id, name: p.name, slot: p.slot }));
}

// ---- lobby lifecycle ----
function startLobbyClock(room) {
  // tick the countdown to clients once a second
  if (room.lobbyTickTimer) return;
  room.lobbyTickTimer = setInterval(() => {
    if (room.phase !== 'lobby') return;
    const secondsLeft = Math.max(0, Math.ceil((room.startsAt - Date.now()) / 1000));
    broadcast(room, { t: 'lobby', count: room.humans.size, capacity: ROOM_CAPACITY, secondsLeft });
    if (secondsLeft <= 0) startRace(room);
  }, 1000);

  room.lobbyTimer = setTimeout(() => startRace(room), JOIN_WINDOW_MS + 200);
}

function maybeStartEarly(room) {
  if (room.phase === 'lobby' && room.humans.size >= ROOM_CAPACITY) startRace(room);
}

function startRace(room) {
  if (room.phase !== 'lobby') return;
  room.phase = 'racing';
  clearInterval(room.lobbyTickTimer); room.lobbyTickTimer = null;
  clearTimeout(room.lobbyTimer); room.lobbyTimer = null;

  // assign slots to humans (in join order), fill the rest with AI
  const humans = [...room.humans.values()];
  let slot = 0;
  for (const p of humans) { p.slot = slot++; }

  room.ais = [];
  for (; slot < ROOM_CAPACITY; slot++) {
    room.ais.push({
      id: `ai_${room.key}_${slot}`,
      slot,
      name: `CPU ${slot}`,
      x: SLOT_X[slot] || 0,
      dist: 0,
      speed: 0,
      baseSpeed: 70 + Math.random() * 22, // matches client rival pace ballpark
      ai: true,
    });
  }

  room.grid = [
    ...humans.map(p => ({ id: p.id, slot: p.slot, ai: false, name: p.name })),
    ...room.ais.map(a => ({ id: a.id, slot: a.slot, ai: true, name: a.name })),
  ].sort((a, b) => a.slot - b.slot);

  broadcast(room, { t: 'start', grid: room.grid });

  // begin world snapshots + AI ticking
  room.snapTimer = setInterval(() => sendSnapshot(room), 1000 / SNAPSHOT_HZ);
  room.aiTimer = setInterval(() => tickAI(room), 1000 / AI_TICK_HZ);

  // safety: auto-clean the room after a generous race duration
  setTimeout(() => closeRoom(room), 6 * 60_000);
}

function tickAI(room) {
  const dt = 1 / AI_TICK_HZ;
  // find the furthest human dist for light rubber-banding
  let lead = 0;
  for (const p of room.humans.values()) lead = Math.max(lead, p.state?.dist || 0);
  for (const a of room.ais) {
    const rubber = Math.max(-8, Math.min(10, (lead - a.dist) * 0.05));
    a.speed += ((a.baseSpeed + rubber) - a.speed) * dt * 1.5;
    a.dist += a.speed * dt;
    // gentle lane weave
    a.x += Math.sin(Date.now() * 0.001 + a.slot) * dt * 2;
  }
}

function sendSnapshot(room) {
  const cars = [];
  for (const p of room.humans.values()) {
    const s = p.state || {};
    cars.push({ id: p.id, x: s.x || 0, dist: s.dist || 0, speed: s.speed || 0,
                boosting: !!s.boosting, crashed: !!s.crashed, ai: false, name: p.name });
  }
  for (const a of room.ais) {
    cars.push({ id: a.id, x: a.x, dist: a.dist, speed: a.speed, boosting: false, crashed: false, ai: true, name: a.name });
  }
  broadcast(room, { t: 'snapshot', cars });
}

function closeRoom(room) {
  if (room.phase === 'done') return;
  room.phase = 'done';
  clearInterval(room.snapTimer); clearInterval(room.aiTimer);
  clearInterval(room.lobbyTickTimer); clearTimeout(room.lobbyTimer);
  rooms.delete(room.key);
}

// ---- connection handling ----
wss.on('connection', (ws) => {
  ws.id = nextClientId++;
  ws.room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => removeFromRoom(ws));
  ws.on('error', () => removeFromRoom(ws));
});

function handleMessage(ws, msg) {
  switch (msg.t) {
    case 'join': {
      if (ws.room) return; // already in a room
      const world = String(msg.world || 'highway');
      const event = String(msg.event || 'race');
      const name = String(msg.name || 'PLAYER').slice(0, 16);
      const room = getOrCreateRoom(world, event);
      if (room.humans.size >= ROOM_CAPACITY) return; // shouldn't happen; lobby swaps
      const player = { id: ws.id, ws, name, slot: room.humans.size, state: {} };
      room.humans.set(ws.id, player);
      ws.room = room;
      ws.send(JSON.stringify({
        t: 'joined', id: ws.id, room: room.key, slot: player.slot,
        players: playerList(room), capacity: ROOM_CAPACITY,
        secondsLeft: Math.max(0, Math.ceil((room.startsAt - Date.now()) / 1000)),
      }));
      broadcast(room, { t: 'player_join', player: { id: ws.id, name, slot: player.slot } }, ws.id);
      startLobbyClock(room);
      maybeStartEarly(room);
      break;
    }
    case 'state': {
      const room = ws.room; if (!room) return;
      const p = room.humans.get(ws.id); if (!p) return;
      p.state = { x: msg.x, dist: msg.dist, speed: msg.speed, boosting: msg.boosting, crashed: msg.crashed };
      break;
    }
    case 'event': {
      const room = ws.room; if (!room) return;
      broadcast(room, { t: 'event', from: ws.id, kind: msg.kind, target: msg.target }, ws.id);
      break;
    }
    case 'finished': {
      const room = ws.room; if (!room) return;
      broadcast(room, { t: 'finished', id: ws.id, position: msg.position });
      break;
    }
    case 'leave': removeFromRoom(ws); break;
  }
}

function removeFromRoom(ws) {
  const room = ws.room; if (!room) return;
  room.humans.delete(ws.id);
  ws.room = null;
  broadcast(room, { t: 'player_leave', id: ws.id });
  // if the room emptied out, close it
  if (room.humans.size === 0) closeRoom(room);
}

// heartbeat to drop dead sockets
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30_000);

httpServer.listen(PORT, () => {
  console.log(`REDLINE multiplayer server listening on :${PORT}`);
});
