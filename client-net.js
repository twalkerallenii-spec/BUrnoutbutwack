// REDLINE client networking layer
// --------------------------------
// Drop-in module that connects the single-file game to the multiplayer server.
//
// HOW TO WIRE IT INTO redline.html (high level — you'll do this part):
//   1. Host the server on Render and note its URL, e.g.
//        https://redline-multiplayer.onrender.com
//      The WebSocket URL is the same with wss:// , e.g.
//        wss://redline-multiplayer.onrender.com
//   2. Include this file (or paste it) into the game, BEFORE the main game
//      script, and set NET.url to your wss URL.
//   3. In the game:
//        - When the player picks world+event and hits "online", call
//            NET.connect(world, event, playerName)
//        - Each frame while racing, call
//            NET.sendState({ x:G.x, dist:G.dist, speed:G.speed,
//                            boosting:G.boosting, crashed:G.crashed })
//        - Render remote cars every frame from NET.cars (see shape below).
//        - Hook NET.on('start', gridArray => {...}) to spawn the grid,
//          NET.on('lobby', info => {...}) to show the countdown,
//          NET.on('snapshot', () => {...}) (optional) when fresh data arrives.
//
// NET.cars is a Map keyed by car id -> { x, dist, speed, boosting, crashed, ai, name }
// You position each remote car using the SAME world-scroll math as your own
// car: a remote car's on-screen Z = (myDist - theirDist), and X = their x.
// (i.e. relZ = G.dist - car.dist), exactly like ambient traffic uses trackPos.

const NET = (() => {
  const listeners = {};
  let ws = null;
  let connected = false;
  let myId = null;
  let mySlot = 0;
  let lastSent = 0;
  const SEND_HZ = 15;

  const cars = new Map(); // id -> latest state from server (excludes me)

  function on(evt, fn) { (listeners[evt] ||= []).push(fn); }
  function emit(evt, data) { (listeners[evt] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

  function connect(world, event, name) {
    if (ws) try { ws.close(); } catch {}
    cars.clear();
    ws = new WebSocket(NET.url);
    ws.onopen = () => {
      connected = true;
      ws.send(JSON.stringify({ t: 'join', world, event, name: name || 'PLAYER' }));
      emit('open');
    };
    ws.onclose = () => { connected = false; emit('close'); };
    ws.onerror = (e) => { emit('error', e); };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      route(msg);
    };
  }

  function route(msg) {
    switch (msg.t) {
      case 'joined':
        myId = msg.id; mySlot = msg.slot;
        emit('joined', msg);
        emit('lobby', { count: msg.players.length, capacity: msg.capacity, secondsLeft: msg.secondsLeft });
        break;
      case 'lobby':
        emit('lobby', msg);
        break;
      case 'start':
        emit('start', msg.grid);
        break;
      case 'snapshot':
        cars.clear();
        for (const c of msg.cars) {
          if (c.id === myId) continue; // skip my own car; the game owns it
          cars.set(c.id, c);
        }
        emit('snapshot', cars);
        break;
      case 'player_join': emit('player_join', msg.player); break;
      case 'player_leave': cars.delete(msg.id); emit('player_leave', msg.id); break;
      case 'event': emit('event', msg); break;
      case 'finished': emit('finished', msg); break;
    }
  }

  function sendState(s) {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - lastSent < 1000 / SEND_HZ) return; // throttle
    lastSent = now;
    ws.send(JSON.stringify({ t: 'state', x: s.x, dist: s.dist, speed: s.speed, boosting: s.boosting, crashed: s.crashed }));
  }

  function sendEvent(kind, target) {
    if (!connected) return;
    ws.send(JSON.stringify({ t: 'event', kind, target }));
  }

  function sendFinished(position) {
    if (!connected) return;
    ws.send(JSON.stringify({ t: 'finished', position }));
  }

  function leave() {
    if (ws && connected) ws.send(JSON.stringify({ t: 'leave' }));
    try { ws && ws.close(); } catch {}
    connected = false;
  }

  return {
    url: 'wss://REPLACE-WITH-YOUR-RENDER-URL.onrender.com', // <-- set this
    connect, sendState, sendEvent, sendFinished, leave, on,
    get cars() { return cars; },
    get myId() { return myId; },
    get mySlot() { return mySlot; },
    get connected() { return connected; },
  };
})();

// expose globally for the game script
window.NET = NET;
