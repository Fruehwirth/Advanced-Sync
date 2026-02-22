# Advanced Sync — Documentation

> End-to-end encrypted vault synchronisation across devices via a self-hosted Docker server.
> Version 0.1.0 · Works on desktop and mobile · `isDesktopOnly: false`

---

## Table of Contents

1. [Overview](#1-overview)
2. [Server Setup](#2-server-setup)
3. [First-time Setup Wizard](#3-first-time-setup-wizard)
4. [Settings Reference](#4-settings-reference)
5. [UI Elements](#5-ui-elements)
6. [Commands](#6-commands)
7. [How Sync Works](#7-how-sync-works)
8. [Initial Sync Strategies](#8-initial-sync-strategies)
9. [Conflict Resolution](#9-conflict-resolution)
10. [What Gets Synced](#10-what-gets-synced)
11. [Security Model](#11-security-model)
12. [Troubleshooting](#12-troubleshooting)
13. [Architecture Notes](#13-architecture-notes)

---

## 1. Overview

Advanced Sync keeps your Obsidian vault in sync across all your devices using a server you host yourself. All data is encrypted on your device before it leaves — the server stores only ciphertext and never sees your notes, passwords, or file names.

**Key properties:**

- End-to-end encrypted (AES-256-GCM, PBKDF2 key derivation)
- Real-time sync via persistent WebSocket connection
- Selective sync: notes only, or include plugins / settings / all file types
- Works on desktop and mobile
- Multi-device: unlimited devices per vault
- Self-hosted: your data stays on your own infrastructure

---

## 2. Server Setup

The sync server runs as a Docker container. A minimal `docker-compose.yml`:

```yaml
services:
  advanced-sync:
    image: your-dockerhub-username/advanced-sync:latest
    ports:
      - "8443:8443"
    environment:
      SERVER_PASSWORD: "your-server-password"
    volumes:
      - ./data:/data
```

Start with `docker compose up -d`. The server exposes:

| Endpoint | Purpose |
|---|---|
| `ws://<host>:8443/sync` | WebSocket sync connection |
| `http://<host>:8443/health` | Health check (used by wizard) |
| `http://<host>:8443/api/clients` | Connected device list |
| `http://<host>:8443/api/theme` | Receives Obsidian theme vars for the web UI |

**Server password** — set via `SERVER_PASSWORD` in docker-compose. This authenticates clients at the WebSocket level. It is hashed (SHA-256) on the client before being sent.

**WebSocket payload limit** — by default many servers limit WebSocket frames to a few MB. If you sync large binary files (icon packs, PDFs, attachments), increase `MAX_PAYLOAD` in the server config. A `lucide-icons.zip` of ~5 MB becomes ~7 MB after encryption + base64 encoding.

---

## 3. First-time Setup Wizard

Open **Settings → Advanced Sync**. The wizard runs inline (no popup). There are 7 steps:

### Step 0 — Welcome
Introduction screen. No input required.

### Step 1 — Find Server
Enter the server's host/IP and port. The wizard auto-pings `/health` 500 ms after you stop typing and shows an inline status indicator:

- 🔄 Spinning loader — ping in progress
- ✓ Green check — server reachable, **Next** unlocked
- ✗ Red cross — server unreachable, **Next** stays locked

On desktop, auto-discovery scans the local network for Advanced Sync servers and lists them for one-click selection.

**Next is disabled until the server responds successfully.** You cannot proceed with an unreachable server.

### Step 2 — Server Password
Enter the `SERVER_PASSWORD` configured on the server. This is hashed locally (SHA-256) and sent to authenticate the WebSocket connection. It is never stored in plaintext.

### Step 3 — Encryption Password
This password encrypts your vault data. **The server never sees it.** It is used locally to derive an AES-256-GCM key (via PBKDF2 with a server-provided salt).

> ⚠️ There is no password recovery. If you lose this password, your encrypted data on the server cannot be decrypted.

Confirm the password in the second field before proceeding.

### Step 4 — Device Name
A human-readable name shown in the Devices panel and sync logs (e.g. "MacBook", "iPhone", "Desktop").

### Step 5 — Sync Setup
Choose what to sync and how to handle the first sync:

**File scope toggles:**

| Toggle | Default | What it controls |
|---|---|---|
| Sync all file types | On | Sync every file type. Off = only `.md` notes (`.obsidian/` controlled separately) |
| Sync plugins | On | `.obsidian/plugins/` and all subdirectories |
| Sync settings | On | `.obsidian/*.json`, `.obsidian/icons/`, `.obsidian/snippets/`, `.obsidian/themes/`, etc. |
| Sync workspace | Off | `workspace.json` and `workspace-mobile.json` |

**Initial sync strategy** (only matters for this first connection — reset to Merge afterwards):

| Strategy | Behaviour |
|---|---|
| **Merge** *(recommended for non-empty vaults)* | Newest timestamp wins per file. `.obsidian/` files always come from the server to prevent a new device's defaults from overwriting your real config. |
| **Pull from server** | Download everything from server. Delete local files not on server. |
| **Push to server** | Upload everything local. Delete server files not local. |

If the vault is empty, Pull is selected automatically.

### Step 6 — Summary
Review all choices. Click **Start Syncing** to save settings and initiate the first connection.

---

## 4. Settings Reference

After the wizard completes, **Settings → Advanced Sync** shows the dashboard. Scroll down for all individual settings.

### Connection

| Setting | Description |
|---|---|
| Server URL | WebSocket URL, e.g. `ws://10.0.0.1:8443/sync` or `wss://sync.example.com/sync` |
| Device name | Display name for this device |
| Auto-connect | Connect automatically when Obsidian starts (default: on) |

### Sync Options

| Setting | Default | Description |
|---|---|---|
| Sync all file types | On | Sync every file extension. Off = only `.md` files (`.obsidian/` is separate) |
| Sync plugins | On | `.obsidian/plugins/` — plugins, their data, and icon packs |
| Sync settings | On | `.obsidian/` config files and all subdirectories (icons, snippets, themes, …) |
| Sync workspace | Off | `workspace.json` / `workspace-mobile.json` — open tabs and layout |
| Excluded paths | *(empty)* | Glob patterns to exclude, one per line. Supports `*` and `**`. Example: `*.tmp`, `.trash/**` |

### History Display

| Setting | Default | Description |
|---|---|---|
| Hide .obsidian/ in Recent Changes | Off | Filter `.obsidian/` config file changes out of all history views |

### Advanced

| Action | Description |
|---|---|
| Force Sync | Rebuilds the local file manifest and requests a full sync from the server. Use this after changing sync settings or if files are out of sync. |
| Reset sync state | Clears all local sync state (sequence number, server ID, device name, server URL). Your vault files are **not** deleted. You must run the wizard again. |

---

## 5. UI Elements

### Status Bar (bottom right, desktop only)

Shows the current sync state. Click to open the quick-action popup.

| Icon | State |
|---|---|
| ✓ circle (green) | Connected and up to date |
| ↻ spinning (accent) | Syncing |
| ⟳ loader (accent) | Connecting / Authenticating |
| ✗ wifi-off (muted) | Disconnected |
| ⚠ triangle (red) | Error |

### Quick-Action Popup

Opens when you click the status bar item. Contains:

- **Title row** — "Advanced Sync" label + live status badge (green/accent/red pill)
- **Syncing toggle** — pause/resume sync without disconnecting
- **Force sync** — trigger an immediate full resync
- **Connect / Disconnect** — manage the server connection

### Sync History Sidebar Tab

Open via command palette → **Show sync history**, or programmatically with the `show-history` command.

The tab is a standard Obsidian sidebar panel that can be pinned, dragged, and stacked like any other. It shows:

- **State badge** — live connection state in the header
- **Progress bar** — visible during sync, shows "N files remaining — [current file]"
- **History list** — every uploaded, downloaded, or deleted file with:
  - Direction icon (↑ upload, ↓ download, 🗑 delete, wifi connect/disconnect, ⚠ error)
  - Filename and full path
  - Repeat count (×N) when the same file is modified multiple times consecutively
  - Relative timestamp ("just now", "3m ago", "2h ago", etc.)

The view **live-updates** on every file sync event and state change. No manual refresh needed.

Filtering: if **Hide .obsidian/ in Recent Changes** is enabled in settings, `.obsidian/` entries are hidden here too.

### Settings Dashboard

The top of the settings page (after wizard completion) shows:

- **State pill** — live connection state, refreshes every 3 seconds and immediately on state changes
- **Recent Changes card** — same history list as the sidebar tab, with progress bar during sync
- **Devices card** — all connected and recently-seen devices polled from `GET /api/clients`, refreshes every 3 seconds

---

## 6. Commands

All commands are available in the command palette (`Ctrl/Cmd+P`).

| Command ID | Name | Action |
|---|---|---|
| `advanced-sync:connect` | Connect to sync server | Prompt for encryption password and connect |
| `advanced-sync:disconnect` | Disconnect from sync server | Close WebSocket connection |
| `advanced-sync:force-sync` | Force full sync | Rebuild manifest + full resync with server |
| `advanced-sync:setup-wizard` | Run setup wizard | Open Settings → Advanced Sync (shows wizard if not configured, dashboard if configured) |
| `advanced-sync:show-history` | Show sync history | Open or focus the Sync History sidebar tab |

---

## 7. How Sync Works

### Connection lifecycle

```
Disconnected
    │  connect() called
    ▼
Connecting  (WebSocket handshake)
    │
    ▼
Authenticating  (AUTH message with password hash)
    │  AUTH_OK received (server sends vault salt)
    ▼
Syncing  (initial full sync or incremental)
    │  all pending downloads written to disk
    ▼
Idle  (watching for changes)
```

### Initial sync (full sync)

Triggered on the first connection to a server, or after Force Sync. The server responds with a `SYNC_RESPONSE` that includes metadata for every stored file.

**Critical detail:** download requests are sent first (fire-and-forget to the server), then uploads and deletes are processed sequentially. `readyForIncrementalSync` is **not set to `true` until the last download binary frame has been fully written to disk.** This prevents the incremental sync engine from re-uploading files that are still being downloaded.

### Incremental sync

Once `readyForIncrementalSync = true`, the plugin:

- **Watches for local changes** via `vault.on("modify" | "create" | "delete" | "rename")` with a 300 ms debounce
- **Watches `.obsidian/` files** via a 5-second adapter poll (vault events don't fire reliably for `.obsidian/` on mobile)
- **Receives server push notifications** (`FILE_CHANGED`, `FILE_REMOVED`) when another device makes changes

### Write-back suppression

When the sync engine writes a downloaded file, it:

1. Calls `suppress(path)` before the write
2. Writes the file via `vault.adapter.writeBinary()`
3. For `.obsidian/` files: immediately stats the file and updates the adapter poll's mtime cache (`setCachedMtime`) so the next poll tick sees no change
4. Clears the suppression after 1 second

This prevents the just-written file from triggering an upload back to the server. The suppression window covers Obsidian's double-fire behaviour (it emits both `create` and `modify` for a single write).

### Sequence numbers

Every change on the server increments a global sequence number. The client stores its last known sequence (`lastSequence`). On reconnect, the client sends its `lastSequence` and the server responds with only the changes since then (incremental sync), or a full sync if `lastSequence = 0`.

---

## 8. Initial Sync Strategies

These only apply to the very first `SYNC_RESPONSE` (`fullSync: true`). After use, the strategy is reset to Merge.

### Pull
Download everything from the server. Local files not on the server are deleted.

### Push
Upload everything local. Server files not local are deleted from the server.

### Merge (default)
Newest timestamp wins per file, with one important exception:

**`.obsidian/` files always come from the server during the initial full sync.**

Rationale: a freshly-installed Obsidian on a new device creates `community-plugins.json`, `app.json`, etc. with the current timestamp. These defaults are newer than the server's real config (which was set up weeks or months ago). Without this rule, the new device's minimal defaults would overwrite your carefully configured settings on every device.

For subsequent incremental syncs, normal conflict resolution applies to all files including `.obsidian/`.

---

## 9. Conflict Resolution

For incremental syncs and the Merge initial strategy on regular vault files:

**Newest modification time wins.** The file with the higher `mtime` is kept. There is no three-way merge; the losing version is silently overwritten.

For the history deduplication: when the same file is modified multiple times in a row (within a window of the last 5 history entries), the count is incremented on the existing entry rather than creating a new row. The matched entry is moved to the top.

---

## 10. What Gets Synced

### Regular vault files
All files returned by `vault.getFiles()`.

- If **Sync all file types** is on: everything (`.md`, `.pdf`, `.png`, `.zip`, attachments, …)
- If **Sync all file types** is off: only `.md` files

### `.obsidian/` files
Handled separately via `vault.adapter.list()` because `vault.getFiles()` does not return them.

| Path | Controlled by |
|---|---|
| `.obsidian/plugins/**` | Sync plugins toggle |
| `.obsidian/icons/**` | Sync settings toggle |
| `.obsidian/snippets/**` | Sync settings toggle |
| `.obsidian/themes/**` | Sync settings toggle |
| `.obsidian/*.json` (app, appearance, hotkeys, etc.) | Sync settings toggle |
| `.obsidian/workspace.json` | Sync workspace toggle |
| `.obsidian/workspace-mobile.json` | Sync workspace toggle |

### Always excluded
- `.obsidian/plugins/advanced-sync/` — the plugin's own files (would cause sync loops)
- Paths matching user-defined exclude patterns

### Mobile note on `.obsidian/` detection
Vault events (`vault.on("modify")` etc.) do not reliably fire for `.obsidian/` files on mobile. Advanced Sync polls these directories every 5 seconds using `vault.adapter.stat()` to detect changes on mobile.

---

## 11. Security Model

| Layer | Mechanism |
|---|---|
| Authentication | Server password hashed with SHA-256, sent on WebSocket connect. Server returns `AUTH_OK` or `AUTH_FAIL`. |
| Key derivation | Encryption password + server-provided salt → PBKDF2 → AES-256-GCM vault key |
| File encryption | Each file encrypted with AES-256-GCM with a random IV. The result is base64-encoded and sent as a binary WebSocket frame. |
| File path encryption | File paths are encrypted separately as metadata (`encryptMetadata`) so the server cannot infer vault structure from filenames. |
| File identity | File IDs are derived via HKDF from the file path + vault key. The server stores only these opaque IDs — it cannot map them to file paths. |
| Server trust | The server is fully untrusted. It stores ciphertext only. Even a compromised server cannot read your vault. |
| Local storage | The server password is stored as a SHA-256 hash. The encryption password is **never** stored — it must be re-entered on each Obsidian restart (unless auto-connect is used with a stored key during the session). |

---

## 12. Troubleshooting

### Sync not starting
- Check that the server is running: `curl http://<host>:8443/health` should return `200 OK`
- Verify the Server URL in settings matches exactly (including `/sync` suffix for `ws://` URLs)
- Check that the server password is correct (the wizard validates server reachability but not the password until actually connecting)

### Files not appearing on another device
1. Open **Settings → Advanced Sync** and check the state pill shows "Connected"
2. Press **Force Sync** on the device that *has* the files — this rebuilds the manifest and uploads anything new
3. Press **Force Sync** on the device that *should receive* the files — this downloads

### Large files not syncing (zips, PDFs, attachments)
The server has a WebSocket `maxPayload` limit. A 5 MB file becomes ~7 MB after encryption + base64 encoding. If large files silently fail to upload, increase the server's payload limit in `docker-compose.yml`:
```yaml
environment:
  MAX_PAYLOAD: 52428800  # 50 MB in bytes
```

### `.obsidian/icons/` or other subdirectory not syncing
Ensure **Sync settings** is enabled. All `.obsidian/` subdirectories (icons, snippets, themes) are covered by this toggle. After enabling it, press **Force Sync**.

### New device overwrote plugins on other devices
This was a known bug (now fixed). The Merge strategy now always takes `.obsidian/` files from the server during the initial full sync, so a new device's Obsidian defaults cannot overwrite your configured plugin list.

### Phone keeps uploading files right after a Pull
This was a known bug (now fixed). `readyForIncrementalSync` is now only set to `true` after the last download binary frame is fully written to disk, so the incremental upload engine cannot fire while files are still being received.

### "Wizard Test" device showing in device list
This was a known issue from a previous version that validated the server password via a temporary WebSocket handshake. That validation has been removed. If the device is still listed, it is an offline entry on the server; it can be cleaned up server-side.

### Sync History shows the same file multiple times
If a background file (e.g. `vault-stats.json`) writes between two edits of the same file, the count-up check looks back up to 5 entries instead of just the top one. After updating to the current version this should no longer occur.

---

## 13. Architecture Notes

### File structure (plugin source)
```
plugin/src/
├── main.ts                  Plugin entry point, lifecycle, command registration
├── settings.ts              Settings tab (inline wizard + dashboard)
├── types.ts                 Settings interface and defaults
├── sync/
│   ├── sync-engine.ts       Orchestrates full + incremental sync, manifest, history
│   ├── file-watcher.ts      Vault events + adapter poll for .obsidian/ files
│   └── conflict-resolver.ts Timestamp-based conflict resolution
├── network/
│   ├── connection.ts        WebSocket lifecycle, auth handshake, message routing
│   ├── ws-client.ts         Low-level WebSocket client
│   └── discovery.ts         UDP auto-discovery of servers on local network
├── crypto/
│   ├── encryption.ts        AES-256-GCM encrypt/decrypt, SHA-256
│   └── key-management.ts    PBKDF2 key derivation, file ID derivation (HKDF)
└── ui/
    ├── sync-popup.ts        Quick-action popup (anchored to status bar)
    ├── sync-history-view.ts ItemView sidebar tab for recent changes + progress
    ├── sync-status.ts       Status bar indicator
    ├── wizard-modal.ts      Standalone wizard modal + PasswordPromptModal
    └── loading-overlay.ts   (Unused — kept for reference)
```

### Data flow: local change → server

```
User edits file
    → vault.on("modify") fires
    → FileWatcher.handleEvent() (300 ms debounce)
    → SyncEngine.handleLocalChange()
    → SyncEngine.uploadFile()
        → adapter.readBinary()
        → encryptBlob() + encryptMetadata()
        → connection.send(FILE_UPLOAD header)
        → connection.sendBinary(encrypted blob)
    → Server stores ciphertext
    → Server broadcasts FILE_CHANGED to all other clients
```

### Data flow: server push → local file

```
Server broadcasts FILE_CHANGED
    → SyncEngine.handleRemoteFileChanged()
    → conflict check (mtime comparison)
    → connection.send(FILE_DOWNLOAD request)
    → Server sends FILE_DOWNLOAD_RESPONSE (metadata)
    → Server sends binary frame (encrypted blob)
    → SyncEngine.handleBinaryDownload()
        → decryptMetadata() → file path
        → decryptBlob() → plaintext
        → SyncEngine.writeFile()
            → fileWatcher.suppress(path)
            → adapter.writeBinary()
            → fileWatcher.setCachedMtime() (for .obsidian/ files)
            → setTimeout(unsuppress, 1000)
```

### Adapter poll (mobile .obsidian/ change detection)

The vault event system does not reliably fire for `.obsidian/` file writes on mobile. A `setInterval(5000)` poll scans `.obsidian/` via `adapter.list()` and compares mtimes against a cached baseline. Key design decisions:

- The baseline uses `Math.max(diskMtime, cachedMtime)` on each tick to avoid a race condition where a `setCachedMtime()` call (from a concurrent download write) would be overwritten by a stale disk read from the same poll run
- The first poll tick only seeds the baseline — it never emits events — to prevent startup false positives
- `setCachedMtime()` is called immediately after every sync write so the next poll sees no change for that file

### Protocol messages (shared types)
Defined in `@vault-sync/shared/protocol`. Key message types:

| Type | Direction | Purpose |
|---|---|---|
| `AUTH` | Client → Server | clientId, deviceName, passwordHash, protocolVersion |
| `AUTH_OK` | Server → Client | vaultSalt, serverId |
| `AUTH_FAIL` | Server → Client | reason string |
| `SYNC_REQUEST` | Client → Server | lastSequence (0 = full sync) |
| `SYNC_RESPONSE` | Server → Client | entries[], fullSync flag, currentSequence |
| `FILE_UPLOAD` | Client → Server | header (fileId, encryptedMeta, mtime, size) + binary frame |
| `FILE_UPLOAD_ACK` | Server → Client | sequence number |
| `FILE_DOWNLOAD` | Client → Server | fileId |
| `FILE_DOWNLOAD_RESPONSE` | Server → Client | fileId, encryptedMeta, mtime, size + binary frame |
| `FILE_DELETE` | Client → Server | fileId |
| `FILE_CHANGED` | Server → Client | push notification to other clients |
| `FILE_REMOVED` | Server → Client | push notification to other clients |
