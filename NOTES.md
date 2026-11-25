# Field Layout: design notes

An Expo Go app where Dana lays out a space on site and Marcus watches it arrive live in the office, backed by a small self-hosted sync server.

## Running it (about 5 minutes)

Needs Node 22.13+, Expo Go (SDK 58), and the phone and laptop on the same Wi-Fi.

```bash
npm install
npm run server      # terminal 1 (or: docker compose up --build)
npm run app         # terminal 2, then scan the QR code with Expo Go
```

The app finds the server by itself: it uses Metro's host, port 8787. Use one phone as **Field** (New job → New space → Rectangle), then press the orange **TAPE** button, a simulated Bluetooth tape. Open the same job on a second device as **Office**. `npm test` runs 25 tests. The README has troubleshooting.

## a. Key interaction decisions

1. **The next reading always has a destination.** The tape sends only a string like `12' 4 1/2"`. So one target is always highlighted orange, and each reading fills it and moves on, with the view following. No taps are needed between readings. Tapping a label re-aims, and a reading with nothing aimed waits in a tray.
2. **Shape first, then measure.** Presets (rectangle, L, U, fence), tapping corners on a grid, or tracing an irregular space wall by wall from turn buttons or the tool's angle. A least-squares solver fills in walls that haven't been measured, so the plan always closes. Estimates stay dashed and marked **≈**.
3. **The app finds mistakes.** If measured walls don't meet, it names the walls that disagree ("Wall 3 is 1/4" longer than Wall 1"), circles the corner, and offers one-tap retakes. When everything is measured, closes and has no flags, the space shows **✓ Good to go**.
4. **Openings get a wall view.** Adding a door or window opens the wall face-on. Drag it on both axes, then measure its offset, width, height and sill.
5. **Marcus flags; he never edits.** A flag jumps to the front of Dana's queue, and her next reading on that item resolves it. He then sees the old and new values.
6. **Everything is reversible.** Undo and redo cover every field action. Deletes need a deliberate second tap instead of a modal, and deleted jobs can be restored.

## b. Fit to Dana and Marcus

**Dana (gloves, sun, rain, one free hand):**
- 56 pt touch targets.
- In the wall view, dragging works anywhere, not just on the item.
- When drawing corners, the cursor appears above her finger so her glove doesn't hide it, and corners snap to a 1 ft grid and to right angles.
- Colors tuned for sunlight: dark slate on near-white, safety orange for "act here", no light-grey text.
- A haptic and optional voice confirm each reading, and the screen stays awake, so she can measure without watching the phone.
- Edits apply locally and sync from an outbox, so a dead zone loses nothing.
- Raw strings and 1/16" precision are kept.

**Marcus (iPad, estimating):**
- Sidebar layout with live **Follow** of Dana's current wall.
- Any value shown as ft/in, decimal inches and metric, plus the raw string, the source, who took it and when, and its retake history.
- Totals: area, perimeter, wall less openings, closure, and what's still estimated.
- He can explore freely but can't corrupt the data.

## c. Packages

| Used | Why |
|---|---|
| `react-native-skia` + `reanimated` + `gesture-handler` | Pan and zoom run on the UI thread and drive Skia directly, so gestures never re-render React |
| `zustand` | Per-job selectors: a reading re-renders only what shows it |
| `expo-sqlite/kv-store` | Synchronous local persistence that works in Expo Go |
| `expo-router`, `-haptics`, `-speech`, `-keep-awake`, `-crypto`, `-constants`, `@expo/vector-icons` | Navigation, field feedback, IDs, finding the server automatically, icons |
| `zod` | One schema validates every change on the device and the server |
| `ws` + built-in `node:sqlite` | Two runtime packages, no native build, small Docker image |

**Rejected:**
- Firebase and Supabase: a BaaS.
- `react-native-ble-plx`, MMKV and WatermelonDB: they need a dev build. A real tape plugs into the existing `MeasurementSource` interface.
- `react-native-svg`: slower at large pan and zoom.
- socket.io: duplicates the sync engine's reconnect logic.
- better-sqlite3: a native build step.
- three.js: more than estimating needs.

**Architecture:** an append-only log of changes. The app and the server share the same tested change-handling code, so a feature is one schema entry plus one handler. The server sets the order and enforces roles. Undo, restore, offline catch-up and retake history all came almost free.

## d. What I cut, and the next week

**Cut:**
- Real Bluetooth (not possible in Expo Go).
- Web.
- Accounts.
- Ceiling height (the wall view assumes 8 ft).
- Moving an opening to another wall.
- Adding posts and partitions.
- One field device per space is assumed.

**Next week:**
1. A dev build with real BLE tape and caliper support.
2. Ceiling height, and a 3D view drawn in Skia from the data already stored.
3. Export for estimating (PDF plan with elevations, CSV takeoff) and photos attached to walls.
4. Scale: store changes on the device as SQLite rows, add server snapshots and compaction, and replace snapshot undo with reverse changes so several devices can share a space.
5. Split the field screen into hooks and panels, and tune the lint config. Most current errors are React Compiler false positives on Reanimated code.
