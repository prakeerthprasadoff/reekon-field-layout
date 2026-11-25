# Field Layout

Dana lays out a space on site (phone or tablet, gloves, sun) and Marcus watches it arrive live on an iPad in the office.
Expo SDK 58 app running in **Expo Go**, plus a small self-hosted sync server (Node + WebSocket + SQLite, no BaaS).

Design notes: [NOTES.md](NOTES.md)

## Setup (about 5 minutes)

**You need:** Node **22.13+** (24 recommended), the **Expo Go** app (SDK 58) on a phone and/or iPad, and the phone and laptop on the **same Wi-Fi**.

```bash
npm install                 # installs app, server and shared workspaces
```

**Terminal 1: sync server** (pick one)
```bash
npm run server              # Node directly, listens on :8787
# or
docker compose up --build   # same server in Docker, data kept in a volume
```

**Terminal 2: app**
```bash
npm run app                 # starts Metro, then scan the QR code with Expo Go (iOS: Camera app)
```

The app finds the sync server by itself. It takes the laptop's LAN address from Expo (the same host Metro serves from) and connects to port 8787. There's no URL to configure.

## Try it (two devices)

**Phone, as Dana**
1. Enter a name and choose **Field**. Tap **New job**, then **New space**, then **Rectangle**, then **Start**.
2. Press the orange **TAPE** button (the simulated Bluetooth tape). Each reading fills the orange wall and moves on to the next one, and the view follows it. When every wall is in and the walls meet, the header turns **✓ Good to go**.
3. Tap **+ Add**, then **Window**, then tap a wall. The **Wall view** opens: drag the window sideways and up or down, or tap a size and press **Tape it**.
4. **↶ / ↷** undo and redo anything. **Edit** clears readings, removes a wall, or opens **Change shape / add on…** to extend the plan with new corners.

**iPad (or a second phone), as Marcus**
1. Enter a name and choose **Office**, then open the same job. Readings appear as Dana takes them, and **Follow** keeps the view on her current wall.
2. Tap any measurement, then **⚑ Flag for re-measure**. The flag jumps to the front of Dana's queue, and her next reading on that item resolves it. Office can flag but never change a measurement.

Long-press **TAPE** for simulator settings: exact or noisy readings (noise shows the closure check naming the walls that disagree), angle output for **Irregular** shapes, disconnect, and reading values aloud.

## Troubleshooting

| Problem | Fix |
|---|---|
| Pill says **Offline** on the device | Make sure the server is running and allow Node through the macOS firewall prompt. On the Jobs screen, tap *Sync server: …* and enter `ws://<laptop-LAN-IP>:8787`. With `npm run server` the server prints its LAN addresses. In Docker it prints the container's address (172.17.x.x), so use the laptop's own IP instead. |
| "Didn't save: the sync server is out of date" | You pulled new code while the server was running. Restart it. |
| Using `expo start --tunnel` | Tunnels only Metro, not the sync server. Use LAN mode, or set `EXPO_PUBLIC_SYNC_URL`. |
| "Web Bundling failed" after pressing `w` | Web isn't a target (the brief is Expo Go). Open the app on a phone or tablet in Expo Go. |
| Start fresh | Stop the server and delete `server/data/` (or `docker compose down -v`). In the app, use *Switch* on the Jobs screen to change role. |

## Checks

```bash
npm test            # vitest: units parser, geometry, closure, op reducer, flags, roles, undo, extend
npm run typecheck   # shared + server + app
```

## Layout

```
app/      Expo Router app (field + office modes)   src/app = routes, src/canvas = Skia plan, src/field = tape, keypad, wall view
server/   Sync server: op log in node:sqlite, ws   Dockerfile here
shared/   Types, zod op schemas, applyOp reducer, geometry, units (used by app AND server)
```
