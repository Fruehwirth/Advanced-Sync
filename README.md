# Advanced Sync

> End-to-end encrypted vault synchronisation across devices via a self-hosted Docker server.

**Advanced Sync** keeps your Obsidian vault in sync across all your devices in real time. All data is encrypted on your device before it leaves — the server stores only ciphertext and never sees your notes, file names, or passwords.

---

## Features

- **End-to-end encrypted** — AES-256-GCM with PBKDF2 key derivation. The server is fully untrusted.
- **Real-time sync** — Changes appear on other devices within seconds via a persistent WebSocket connection.
- **Single password** — One password authenticates you with the server and encrypts your vault data.
- **Sync preview** — See exactly what will change before the first sync applies.
- **Session tokens** — After the first login, Obsidian reconnects automatically on restart without re-entering your password.
- **Selective sync** — Choose to sync notes only, or include plugins, settings, and all file types.
- **Device management** — See all connected devices and kick sessions from the plugin dashboard or server web UI.
- **Self-hosted** — Your data stays on your own infrastructure.
- **Desktop and mobile** — Works on all platforms Obsidian supports.

---

## Server Setup

The server runs as a Docker container. One-line install:

```bash
docker run -d \
  --name advanced-sync \
  -p 8443:8443 \
  -p 21547:21547/udp \
  -v ./data:/data \
  -e SERVER_PASSWORD=your-password \
  --user 1000:1000 \
  --restart unless-stopped \
  fruehwirth/advanced-sync:latest
```

Or with `docker-compose.yml`:

```yaml
services:
  advanced-sync:
    image: fruehwirth/advanced-sync:latest
    ports:
      - "8443:8443"        # WebSocket sync + web UI
      - "21547:21547/udp"  # LAN auto-discovery
    volumes:
      - ./data:/data
    environment:
      - SERVER_PASSWORD=your-password
    user: "1000:1000"
    restart: unless-stopped
```

```bash
docker compose up -d
```

The server exposes a web dashboard at `http://<host>:8443` where you can monitor connected devices, view the change log, and manage sessions.

> **Note:** Change `SERVER_PASSWORD` to a strong password before deploying. This is the same password you will enter in the Obsidian plugin wizard.

---

## Plugin Installation

### From the Obsidian community store *(coming soon)*

Search for **Advanced Sync** in **Settings → Community plugins**.

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Copy them to `.obsidian/plugins/advanced-sync/` in your vault
3. Enable the plugin in **Settings → Community plugins**

---

## Quick Start

1. Start the server (see above)
2. Open **Settings → Advanced Sync** in Obsidian
3. Follow the setup wizard:
   - **Server** — enter your server's IP/hostname and port (or select it from the auto-discovered list)
   - **Password** — enter the `SERVER_PASSWORD` you set on the server. An inline check confirms the password is correct as you type.
   - **Device** — give this device a name
   - **Sync** — choose what to sync and how to handle the initial merge
   - **Preview** — review exactly which files will be downloaded, uploaded, or deleted before anything happens
   - **Apply** — watch live progress as the first sync completes
4. Done. Obsidian will auto-connect on every restart from now on.

---

## Showcase

![dashboard](https://raw.githubusercontent.com/Fruehwirth/Advanced-Sync/refs/heads/main/images/dashboard.png)
![Wizard](https://raw.githubusercontent.com/Fruehwirth/Advanced-Sync/refs/heads/main/images/setup-wizard.png)
![sync-tab](https://raw.githubusercontent.com/Fruehwirth/Advanced-Sync/refs/heads/main/images/synctab.png)



---

## Security

| Layer | Mechanism |
|---|---|
| Authentication | Password hashed with SHA-256, sent on WebSocket connect. Stored as an opaque session token after first login. |
| Key derivation | Password + server-provided salt → PBKDF2 (210,000 iterations, SHA-512) → AES-256-GCM vault key |
| File encryption | Each file encrypted with AES-256-GCM with a random 12-byte IV. Sent as raw binary — no base64 overhead. |
| Metadata encryption | File paths encrypted separately so the server cannot infer vault structure from filenames. |
| File identity | File IDs derived via HKDF from the file path + vault key. The server stores only opaque IDs. |
| Server trust | The server is fully untrusted. A compromised server cannot read your vault. |

---

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| `8443` | TCP | WebSocket sync, web dashboard, REST API |
| `21547` | UDP | LAN auto-discovery (optional) |

---

## Version

`0.3.0` — Protocol v2 · Single password auth · Session tokens · Sync preview · Raw binary transfers · Non-blocking sync
