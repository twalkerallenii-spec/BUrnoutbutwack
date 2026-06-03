# REDLINE — Full Setup Guide

Everything to get the multiplayer server live and the game racing online.

There are **two separate things** here:

1. **The game** — `redline.html`. A single file. Already has the multiplayer
   client built in and already points at the server URL
   `wss://burnoutbutwack.onrender.com`. You just open it.
2. **The server** — the files in this folder (`server.js`, `package.json`,
   etc.). This is the backend that runs the lobby + relays players. It goes on
   GitHub → Render.

If your server is **already deployed** at `burnoutbutwack.onrender.com` and
working (you saw `{"ok":true,...}`), you do NOT need to redeploy. Skip to
**Part 3 — Play**.

---

## Part 1 — Put the server on GitHub

Open a terminal in this folder (the one with `server.js`) and run:

```bash
git init
git add .
git commit -m "REDLINE multiplayer server"
git branch -M main
git remote add origin https://github.com/YOURNAME/redline-server.git
git push -u origin main
```

Replace `YOURNAME` with your GitHub username and make the repo first on
github.com (New repository → name it `redline-server` → don't add a README,
since you already have these files).

---

## Part 2 — Deploy to Render

1. Go to **https://dashboard.render.com** and sign in (signing in with GitHub
   makes the next step easier).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account if asked, then pick your **redline-server** repo.
4. Fill in (Render may auto-detect some of these):
   - **Name:** `redline-multiplayer` (or anything)
   - **Region:** closest to you
   - **Branch:** `main`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **Create Web Service**. Wait for the build (a couple minutes). The log
   should end with `REDLINE multiplayer server listening on :10000` (or similar).

### Confirm it's live
Open your Render service URL in a browser. You should see:
```json
{"ok":true,"rooms":0,"players":0}
```
That JSON = the server is running.

### Your WebSocket URL
It's your Render URL with `wss://` instead of `https://`. For example:
```
https://redline-multiplayer.onrender.com   ->   wss://redline-multiplayer.onrender.com
```

---

## Part 2.5 — Point the game at YOUR server (only if your URL differs)

The game currently has this URL baked in:
```
wss://burnoutbutwack.onrender.com
```

If your Render service uses a **different** URL, open `redline.html` in a text
editor, search for `burnoutbutwack.onrender.com`, and replace it with your own
`wss://...` URL. There's exactly one place to change — this line near the top
of the script:

```js
return { url:'wss://burnoutbutwack.onrender.com', connect, sendState, ... };
```

If your server already IS `burnoutbutwack.onrender.com`, change nothing.

---

## Part 3 — Play

> ⚠️ **Wake the server first.** Render's free tier sleeps after ~15 min idle.
> Open your server URL (`https://...onrender.com`) in a tab and wait for the
> `{"ok":true...}` JSON before playing. The first connect after idle takes
> 30–60s; if you skip this the lobby will hang on "CONNECTING…".

### Single player
Open `redline.html` → **START** → pick world → pick event → pick car → race.

### Online race
1. Open `redline.html`.
2. Click **ONLINE RACE**.
3. Pick a world → garage → **TO THE GRID ▸**.
4. You land in the **lobby** with a 60-second countdown and a player count.
5. Empty slots fill with CPU when the timer ends (or instantly at 6 players).

### Testing with 2 players (recommended first test)
- Open the game in **two browser tabs** (or two devices/computers).
- In each: ONLINE RACE → **same world** → TO THE GRID.
- Both should show **2 / 6 players** in the lobby, then start together.
- You should see the **other tab's car moving** on the track.

---

## What to expect (honest)

- **Cold start lag** on the first connect after the server's been idle (Render
  free tier). Normal.
- **Rubber-banding** — remote cars can look jumpy. This is a *relay* model with
  no lag compensation; it's smooth on good connections, less so on bad ones.
- **No physical collisions with other players** — remote cars are visual only.
  You can't ram another human's car (the server just relays positions). Traffic
  and the race-to-finish still work normally.
- **CPU bots** pace down the track; they don't do the full single-player
  takedown AI.
- **No reconnection** — if a player's connection drops, they leave the race.

---

## Troubleshooting

| Problem | Likely cause / fix |
|---|---|
| Lobby stuck on "CONNECTING…" | Server asleep — open the server URL, wait for JSON, try again. |
| "CONNECTION FAILED" message | Wrong URL in the game, or server down. Check `wss://` URL matches Render. |
| Lobby works but no other car appears | Other tab didn't pick the **same world** (rooms are per world). |
| Other car appears but frozen | That player isn't moving, or their connection dropped. |
| Want always-on (no cold starts) | Upgrade the Render instance from Free to a paid tier. |

---

## Files in this repo

| File | What it's for |
|---|---|
| `server.js` | The server — lobby, 60s timer, CPU fill, position relay. |
| `package.json` | Server dependencies (`ws`) + start script. |
| `render.yaml` | Render Blueprint (optional one-click deploy). |
| `SETUP.md` | This guide. |
| `README.md` | Deeper technical notes on the server + protocol. |
| `client-net.js` | Reference copy of the client networking code. NOTE: the game `redline.html` already has this built in, so you don't need to include this file — it's here for reference only. |

`redline.html` (the game) lives outside this folder — it's the file you open to play.

---

## Tuning the server (optional)

In `server.js`, near the top:

| Constant | Default | Meaning |
|---|---|---|
| `ROOM_CAPACITY` | 6 | Cars per race (humans + CPU). |
| `JOIN_WINDOW_MS` | 60000 | Lobby wait before auto-start (1 min). |
| `SNAPSHOT_HZ` | 15 | Position broadcasts/sec. Higher = smoother, more bandwidth. |
| `AI_TICK_HZ` | 20 | CPU update rate. |

Change a value, commit, push — Render auto-redeploys.
