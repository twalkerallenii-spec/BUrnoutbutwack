# REDLINE Multiplayer Server

A small WebSocket lobby + relay server for the REDLINE racing game.
It groups players into rooms, runs a **60-second join timer**, **fills empty
grid slots with AI**, and relays everyone's positions so players see each
other race.

---

## What this is (and isn't)

**Is:** a working, deployable backend that gives you real-time, multi-human
racing rooms with an AI-filled grid and a lobby countdown.

**Isn't:** a cheat-proof, lag-compensated competitive netcode stack. This uses
a **relay model** — each browser simulates its own car and broadcasts its
position; the server forwards those positions and runs the bots. That's the
right level of complexity for an arcade hobby game. It will feel great on good
connections and can look rubber-bandy on bad ones. Making it authoritative
(server simulates everything) is a much bigger project; this is the pragmatic
version.

---

## Files

| File | Purpose |
|------|---------|
| `server.js` | The server: rooms, lobby timer, AI fill, state relay. |
| `package.json` | Dependencies (`ws`) and the `start` script. |
| `render.yaml` | Render Blueprint for one-click deploy. |
| `client-net.js` | Drop-in client module the game uses to connect. |
| `.gitignore` | Keeps `node_modules` out of git. |

---

## Deploy to Render (via GitHub)

1. **Create the GitHub repo.** Put these files in a repo (e.g. `redline-server`)
   and push it:
   ```bash
   git init
   git add .
   git commit -m "REDLINE multiplayer server"
   git branch -M main
   git remote add origin https://github.com/YOURNAME/redline-server.git
   git push -u origin main
   ```

2. **Create the Render service.**
   - Go to Render → **New +** → **Blueprint** (it reads `render.yaml`), OR
   - **New +** → **Web Service**, connect the repo, and set:
     - **Build command:** `npm install`
     - **Start command:** `npm start`
     - **Health check path:** `/health`
     - **Instance type:** Free is fine to start.

3. **Wait for the deploy**, then open the service URL. You should see JSON like
   `{"ok":true,"rooms":0,"players":0}`. That confirms it's live.

4. **Note your WebSocket URL.** It's your service URL with `wss://`:
   ```
   https://redline-multiplayer.onrender.com   ->   wss://redline-multiplayer.onrender.com
   ```

> ⚠️ **Render Free tier sleeps after inactivity.** The first connection after
> idle can take ~30–60s to wake the server. For always-on, use a paid instance.

---

## Wire the game to the server

1. In `client-net.js`, set your URL near the bottom:
   ```js
   url: 'wss://redline-multiplayer.onrender.com',
   ```

2. Include `client-net.js` in `redline.html` **before** the main game `<script>`:
   ```html
   <script src="client-net.js"></script>
   <script> /* ...the big game script... */ </script>
   ```
   (Or paste its contents in directly.)

3. **Add an "ONLINE" path** to your menu flow. After the player picks a world
   and event, instead of `beginRace()`, call:
   ```js
   NET.connect(selectedWorld, selectedEvent, 'PLAYER1');
   NET.on('lobby', info => {
     // show "Waiting for players… 47s  (2/6)"
     showLobbyUI(info.secondsLeft, info.count, info.capacity);
   });
   NET.on('start', grid => {
     // grid is [{id, slot, ai, name}] for all 6 cars
     beginRaceOnline(grid);   // your version of beginRace that uses this grid
   });
   ```

4. **Each frame while racing**, send your car state and read everyone else's:
   ```js
   // send mine
   NET.sendState({ x:G.x, dist:G.dist, speed:G.speed, boosting:G.boosting, crashed:G.crashed });

   // render the others — NET.cars is a Map id -> {x,dist,speed,boosting,crashed,ai,name}
   for (const [id, car] of NET.cars) {
     const mesh = remoteMeshFor(id);     // create/reuse a car mesh per id
     const relZ = G.dist - car.dist;     // same math as ambient traffic
     mesh.position.set(car.x, 0, relZ);
     mesh.visible = relZ < 60;           // cull behind camera
   }
   ```

5. **Optional events** (takedowns, finishing):
   ```js
   NET.sendEvent('takedown', targetId);
   NET.on('event', e => { /* show their takedown popup */ });
   NET.sendFinished(G.position);
   NET.on('finished', f => { /* someone crossed the line */ });
   ```

---

## The coordinate-space gotcha (read this)

Your single-player game keeps **your** car near origin and scrolls the world
past you; `G.dist` is how far you've travelled. That model works fine for
multiplayer **as long as you position remote cars by **relative** distance**:

```
remote car on-screen Z = G.dist - theirDist
```

A car ahead of you has a larger `dist`, so `relZ` is negative (into the screen)
— exactly how your ambient traffic already works via `trackPos`. So you do
**not** need to rewrite your whole world model; you just render remote cars
using their `dist` relative to yours. Collisions between you and remote cars
can reuse your existing car-overlap checks against these meshes.

---

## Tuning knobs (in `server.js`)

| Constant | Default | Meaning |
|----------|---------|---------|
| `ROOM_CAPACITY` | 6 | Cars per race (humans + AI). |
| `JOIN_WINDOW_MS` | 60000 | Lobby wait before auto-start. |
| `SNAPSHOT_HZ` | 15 | Position broadcasts/sec (higher = smoother, more bandwidth). |
| `AI_TICK_HZ` | 20 | Server AI update rate. |

---

## Local testing (optional)

```bash
npm install
npm start
# server on http://localhost:8080  (ws://localhost:8080)
```

Set `NET.url = 'ws://localhost:8080'` (note: `ws://`, not `wss://`, for local)
and open two browser tabs of the game to watch them join the same room.

---

## Honest limitations / things you'll likely hit

- **Cold starts** on Render Free (first join is slow after idle).
- **No lag compensation** — fast cars on laggy links will look jumpy to others.
- **Relay trust** — clients report their own position; a modified client could
  cheat. Fine for friends; not for leaderboards.
- **AI bots are simple** — they pace down the track and weave lightly; they
  don't do the full single-player slam/takedown AI. You can enrich the server
  AI later if you want bots to fight in multiplayer too.
- **Reconnection** isn't automatic — if a player drops, they're removed; you'd
  add reconnect logic for robustness.

This gets you a real, playable online mode you can iterate on. Start by getting
two tabs racing locally, then deploy and race across machines.
