# Riftline multiplayer server

Server-authoritative online multiplayer for the Riftline browser FPS on Shopify:
1v1 / 2v2 / 3v3, public matchmaking, private lobbies with invite links and 6-letter codes,
reconnection, and PC + mobile crossplay.

* Plain Node.js (20+), **no npm packages** – nothing to install, no build step.
* Talks to the game over secure WebSockets (`wss://`). Health check: `GET /health`.

## What the server decides (players cannot cheat these by editing the page)
Seats, teams, host permissions, lobby codes, room capacity, round/match state, money and buying,
weapon ownership, ammo and reload timing, fire rate, hit detection (with lag compensation and
wall checks using the map's collision boxes), damage (same numbers and armour rule as single
player), health, deaths, scores and results.

Movement is predicted by each player's browser and *checked* by the server (speed, teleport and
map-bounds checks, frozen during the buy phase). It is not fully simulated on the server.

## Run it locally
```
node src/server.js          # listens on http://localhost:2567  (ws://localhost:2567)
npm test                    # 13 automated tests with real WebSocket clients
```

## Deploy (Render.com, free)
1. Put this folder in a GitHub repository (github.com → New repository → "uploading an existing file" → drag the files in).
2. render.com → New → Blueprint → pick the repository → Apply. `render.yaml` sets everything up.
3. Copy the service address, e.g. `https://riftline-multiplayer.onrender.com`.
   The game needs it as `wss://riftline-multiplayer.onrender.com`.
4. Put that address in the Shopify theme (templates/page.play.liquid): `window.RL_MP_URL="wss://…";`

Free Render servers sleep after ~15 minutes without players; the first player then waits up to
about a minute while it wakes up (the game shows "Waking up the game server…").
Any Node host with WebSocket support works (Railway, Fly.io, a VPS): run `node src/server.js`
with the `PORT` environment variable set.

## Environment variables
See `.env.example`. There are no secrets.

## Files
* `src/server.js` – HTTP + WebSocket entry point, message routing, rate limits
* `src/ws.js` – WebSocket protocol (RFC 6455)
* `src/game.js` – lobbies, matchmaking, rounds, combat validation, reconnection
* `src/data.js` – weapons, maps, spawns, hitboxes (copied from the game)
* `src/geom.js` – ray tests for hit and wall checks
* `src/mapcols.json` – collision boxes exported from both maps
* `test/` – automated tests
