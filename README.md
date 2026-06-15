<div align="center">

# 🔗 PeerLink

### Direct, encrypted, browser-to-browser file transfer — no cloud, no middleman.

Drop a file. Share a link. Your peer gets it straight from your browser.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-peerlink--p2p.vercel.app-6366f1?style=for-the-badge&logo=vercel)](https://peerlink-p2p.vercel.app)
![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react)
![Node.js](https://img.shields.io/badge/Node.js-Express-339933?style=flat-square&logo=nodedotjs)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-orange?style=flat-square)
![AES-256](https://img.shields.io/badge/Encryption-AES--256--GCM-violet?style=flat-square)

</div>

---

## 📖 Table of Contents

- [What is PeerLink?](#what-is-peerlink)
- [Why not just use Google Drive / WhatsApp?](#why-not-just-use-google-drive--whatsapp)
- [Key Features](#key-features)
- [How It Works](#how-it-works)
  - [Step-by-Step User Journey](#step-by-step-user-journey)
  - [Under the Hood: WebRTC Handshake](#under-the-hood-webrtc-handshake)
  - [Under the Hood: Zero-Knowledge Encryption](#under-the-hood-zero-knowledge-encryption)
  - [Under the Hood: Chunk Wire Format](#under-the-hood-chunk-wire-format)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Running Locally](#running-locally)
- [Environment Variables](#environment-variables)
- [Security Design](#security-design)
- [Known Limitations](#known-limitations)

---

## What is PeerLink?

Traditional file sharing works like this: you upload your file to a server (Google Drive, WeTransfer, etc.), which stores it, and your recipient downloads it from that server. Your file lives on someone else's computer - you pay in storage limits, upload time, and privacy.

**PeerLink skips the middleman entirely.**

When you share a file with PeerLink, it travels in a direct tunnel between *your browser* and *your peer's browser* using WebRTC which is the same technology that powers video calls in Google Meet. A tiny Node.js server exists only to help the two browsers find each other; after the handshake, the server is out of the picture completely. It never reads, buffers, or stores any part of your file.

On top of that, every chunk is encrypted with AES-256-GCM inside your browser *before* it's sent  and the decryption key lives only in the URL fragment, a part of the URL that browsers never send to servers. Not even the signaling server has any chance of reading your data.

---

## Why not just use Google Drive / WhatsApp?

| | Google Drive / WeTransfer | WhatsApp | **PeerLink** |
|---|:---:|:---:|:---:|
| File stored on a server | ✅ Yes | ✅ Yes | ❌ Never |
| Server can read your file | ✅ Yes | Varies | ❌ Never |
| Transfer speed limited by server | ✅ Yes | ✅ Yes | ❌ Direct P2P |
| Requires an account | ✅ Yes | ✅ Yes | ❌ No |
| End-to-end encrypted | Partial | Partial | ✅ AES-256-GCM |
| File size limits (free) | 15 GB | 2 GB | 50 MB\* |

*\*50 MB limit is a current browser RAM constraint.*

---

##  Key Features

###  Zero-Knowledge Encryption 
AES-256-GCM encryption runs entirely inside the browser using the native **Web Crypto API**: no external library, no server-side key management. The 256-bit key is generated fresh for every session, base64url-encoded, and placed in the **URL hash** (`#key=...`). Because browsers never include the hash in HTTP requests, the key is mathematically impossible for the signaling server to intercept.

###  True P2P Transfer
Once the WebRTC handshake is complete via [simple-peer](https://github.com/feross/simple-peer), the signaling server drops out of the data path entirely. File chunks flow directly between two browser tabs — or two different devices — over an encrypted data channel.

###  SHA-256 Integrity Verification
Before sending, PeerLink computes a SHA-256 hash of the entire file. After the receiver reassembles all chunks and decrypts them, the hash is recomputed and compared. A mismatch triggers an error — no silently corrupted file ever gets saved.

###  Drag-and-Drop UI
Drop a file anywhere on the zone (or click to browse). Files up to 50 MB are accepted. The selected file is shown with its name and size before you send.

###  Real-Time Transfer Progress
A live progress bar updates as each chunk arrives, alongside bytes transferred and current speed in MB/s — calculated continuously from transfer start time.

### Auto-Download
The moment the final chunk arrives and the hash is verified, the browser automatically triggers a file download — no button to click.

###  Graceful Disconnect Handling
If either peer closes their tab, refreshes, or loses connection mid-transfer:
- A `peer-left` Socket.io event is fired on the server.
- The remaining peer's UI immediately updates to show the disconnect.
- No crash, no freeze, no hanging spinner.

---

##  How It Works 

### Step-by-Step User Journey

```
SENDER                                          RECEIVER
──────                                          ────────

1. Opens peerlink-p2p.vercel.app
   → Connects to signaling server via Socket.io

2. Clicks "Create Room"
   → Server generates a unique 8-char Room ID (nanoid)
   → Browser generates a fresh AES-256-GCM key
   → Key is base64url-encoded and embedded in URL hash

3. Share link is displayed:
   https://peerlink-p2p.vercel.app
     ?room=aB3xYz9k          ← room ID (query param, visible to server)
     #key=dGhpcyBpcyBh...    ← encryption key (hash fragment, NEVER sent to server)

4. Sender copies and shares the link
                                                5. Opens the share link
                                                   → Socket.io joins the room
                                                   → Key extracted from URL hash
                                                   → Key imported via Web Crypto API

                                                6. Server emits peer-joined → Sender
                                                   WebRTC handshake begins (offer/answer/ICE)
                                                   relayed through signaling server

7. ✅ Both peers show "Connected to peer"
   ✅ Both show "End-to-end encrypted" badge

8. Sender drags a file → clicks Send
   → File read as ArrayBuffer
   → SHA-256 hash computed
   → file-meta JSON sent first (name, size, mimeType, hash, totalChunks)
   → File split into 16 KB chunks
   → Each chunk encrypted → packed into binary frame → sent over WebRTC data channel

                                                9. Receiver gets file-meta → shows progress bar
                                                   Each chunk arrives → decrypted → stored by index
                                                   Progress bar + speed updates in real time

                                                10. file-end JSON arrives
                                                    → All chunks reassembled into Blob
                                                    → SHA-256 recomputed on plaintext
                                                    → Hash matches → ✅ "Verified — download started"
                                                    → Browser auto-downloads the file
```

---

### Under the Hood: WebRTC Handshake

WebRTC requires both browsers to exchange connection metadata (IP candidates, codec info) before a direct channel can open. This is what the signaling server does — and only this.

```
Sender                  Socket.io Server                Receiver
  |                           |                              |
  |── create-room ──────────► |                              |
  |◄── room-created ───────── |                              |
  |                           |◄───────────── join-room ──── |
  |                           |──────────── joined-room ───► |
  |◄──────────── peer-joined ─|                              |
  |                           |                              |
  | [Sender creates WebRTC offer via simple-peer]            |
  |── signal (offer) ───────► |──────── signal (offer) ────► |
  |                           |                              |
  |                    [Receiver creates answer]             |
  |◄── signal (answer) ────── |◄───── signal (answer) ────── | 
  |                           |                              |
  |      [ICE candidates exchanged the same way]             |
  |                           |                              |
  |◄══════════ Direct WebRTC Data Channel open ════════════► |
  |          (signaling server no longer involved)           |
```


---

### Under the Hood: Zero-Knowledge Encryption


**Key generation (Sender's browser):**
```js
// A fresh 256-bit AES-GCM key, generated in-browser, never leaves the browser
const key = await crypto.subtle.generateKey(
  { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
);

// Exported as base64url, embedded in the URL hash
// Browsers never include #fragment in HTTP requests → server is blind to the key
window.history.replaceState(null, '', `?room=${roomId}#key=${base64Key}`);
```

**Key import (Receiver's browser):**
```js
// Extracted from the URL hash — purely client-side
const hashParams = new URLSearchParams(window.location.hash.slice(1));
const base64Key = hashParams.get('key');
const key = await crypto.subtle.importKey('raw', base64UrlDecode(base64Key),
  { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
);
```

The server sees `?room=aB3xYz9k` in the HTTP request. It never sees `#key=...`. Zero knowledge.

---

### Under the Hood: Chunk Wire Format

Every 16 KB of plaintext is packed into this binary frame before being sent over the WebRTC data channel:

```
┌────────────────┬──────────────────────┬──────────────────────────────────────────┐
│  Chunk Index   │     AES-GCM IV       │     Ciphertext + Auth Tag (16 bytes)     │
│   (4 bytes)    │     (12 bytes)       │            (N + 16 bytes)                │
└────────────────┴──────────────────────┴──────────────────────────────────────────┘
```

- **Chunk Index** - 4-byte big-endian integer. Lets the receiver store chunks in order even if they arrive out of sequence.
- **IV (Initialization Vector)** - 12 random bytes, freshly generated for *every single chunk*. This means encrypting the same file twice produces completely different ciphertext each time — no patterns can leak.
- **Auth Tag** - AES-GCM appends a 16-byte authentication tag to the ciphertext. If even one bit of the ciphertext is tampered with in transit, decryption fails immediately at the chunk level — before any SHA-256 check even runs.

---

##  Tech Stack

| Layer | Technology | Why this choice |
|---|---|---|
| **Frontend framework** | React 19 + Vite | Fast dev iteration; component model maps cleanly to room/peer/transfer states |
| **Styling** | Tailwind CSS v4 | Utility-first; rapid UI without leaving JSX |
| **Icons** | lucide-react | Clean, consistent icon set with tree-shaking |
| **WebRTC** | simple-peer | Wraps the verbose WebRTC API into a clean event-emitter interface |
| **Realtime signaling** | Socket.io (client) | Persistent WebSocket with automatic reconnection |
| **Encryption** | Web Crypto API — AES-256-GCM | Native browser API; no third-party crypto dependency; hardware-accelerated |
| **Hashing** | Web Crypto API — SHA-256 | Same API; zero extra dependencies |
| **Node polyfills** | vite-plugin-node-polyfills | simple-peer uses Node.js `process` and `Buffer` — this shims them for the browser |
| **Signaling backend** | Node.js + Express | Minimal HTTP server; only needed for the health check endpoint |
| **WebSocket backend** | Socket.io (server) | Handles rooms, signal relay, and disconnect events cleanly |
| **Room ID generation** | nanoid | URL-safe, cryptographically random 8-character IDs |
| **Frontend hosting** | Vercel | Zero-config Vite deployment |
| **Backend hosting** | Render | Free-tier Node.js hosting; auto-restarts on crash |

---

##  Project Structure

```
Direct_Browser_to_Browser_File_Transfer/
│
├── client/                          # React frontend (Vite)
│   ├── index.html                   # App shell; sets page title "PeerLink — P2P File Share"
│   ├── vite.config.js               # React plugin + Tailwind v4 plugin + Node polyfills
│   ├── package.json
│   └── src/
│       ├── main.jsx                 # React root mount
│       ├── index.css                # Tailwind base styles
│       ├── App.jsx                  #  Main component:
│       │                            #   - Socket.io connection lifecycle
│       │                            #   - WebRTC peer creation (initiator / responder)
│       │                            #   - Encryption key generation & import
│       │                            #   - Incoming data handler (JSON messages vs binary chunks)
│       │                            #   - Full UI: room creation, share link, drop zone,
│       │                            #     send/receive progress bars, status badge
│       └── lib/
│           └── fileTransfer.js      #  All transfer logic, isolated from UI:
│                                    #   - generateKey / exportKeyToBase64 / importKeyFromBase64
│                                    #   - packChunk(index, key, plaintext) → binary frame
│                                    #   - unpackChunk(key, frame) → { index, plaintext }
│                                    #   - hashArrayBuffer(buffer) → SHA-256 hex string
│                                    #   - sendFile(peer, file, key, onProgress)
│                                    #   - waitForDrain(channel) — WebRTC backpressure control
│                                    #   - formatBytes / formatSpeed — display helpers
│
└── server/
    ├── package.json                 # express, socket.io, cors, nanoid
    └── index.js                     # Signaling server:
                                     #   - GET /  → health check ("signaling server is running")
                                     #   - create-room → generates nanoid roomId, stores in Map
                                     #   - join-room  → validates room, adds socket, emits peer-joined
                                     #   - signal     → blindly relays WebRTC offer/answer/ICE to room
                                     #   - disconnect → removes socket from room, emits peer-left
```

---

## Running Locally

### Prerequisites

- **Node.js ≥ 18** - check with `node -v`
- **npm** - bundled with Node.js

### Step 1 - Clone

```bash
git clone https://github.com/sourav-101/Direct_Browser_to_Browser_File_Transfer.git
cd Direct_Browser_to_Browser_File_Transfer
```

### Step 2 - Start the signaling server

```bash
cd server
npm install
npm run dev
# ✅ Signaling server listening on port 4000
```

> `npm run dev` uses Node's built-in `--watch` flag for automatic restart on file changes.
> For production, use `npm start`.

### Step 3 - Start the frontend

Open a **new terminal tab**:

```bash
cd client
npm install
npm run dev
# ✅ App running at http://localhost:5173
```

### Step 4 - Try a transfer

1. Go to `http://localhost:5173` in your browser - click **Create Room**.
2. Copy the share link from the UI (it includes the room ID *and* the encryption key in the hash).
3. Open that link in a **second browser window** (or another device on the same network).
4. Once both show the green **"Connected to peer"** badge, drag a file onto Window A and click **Send**.
5. Watch Window B auto-download the verified file. 

> **Tip:** Open both windows side-by-side to watch the send progress bar on the left and the receive progress bar on the right update in sync.

---

##  Environment Variables

### Client (`client/.env`)

```env
# URL of your signaling server.
# Defaults to http://localhost:4000 if not set.
VITE_SERVER_URL=http://localhost:4000
```

All Vite env vars must be prefixed with `VITE_` to be accessible in the browser bundle.

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Port the Express + Socket.io server listens on. Set automatically by Render in production. |

---

##  Security Design

### Why the key never reaches the server

HTTP requests include the path and query string - but **never the URL fragment** (`#...`). This is defined in the HTTP/1.1 specification. When a receiver opens:

```
https://peerlink-p2p.vercel.app?room=aB3xYz9k#key=dGhpcyBpcyBh...
```

The browser sends `GET /?room=aB3xYz9k` to Vercel's CDN. The `#key=...` part is processed entirely in JavaScript, client-side. Vercel, Render, and the signaling server all receive zero bytes of the key.

### Layers of protection

```
Layer 1 — Transport:    WebRTC data channels are DTLS-encrypted by default (mandatory in spec)
Layer 2 — Application:  AES-256-GCM encryption applied before the data even enters WebRTC
Layer 3 — Integrity:    AES-GCM auth tag on every chunk → tampered chunk fails immediately
Layer 4 — Integrity:    SHA-256 on the full file → any missing/reordered chunk detected at end
```

Even if someone intercepted the raw WebRTC packets, they would see AES-256-GCM ciphertext with no access to the key.

### What the signaling server does and does not do

| The server DOES | The server does NOT |
|---|---|
| Generate a room ID (nanoid) | Read or store any file bytes |
| Track which socket IDs are in a room | Know the encryption key |
| Relay raw WebRTC signal blobs | Decode or inspect signal content |
| Emit `peer-joined` / `peer-left` events | Log any file metadata |

---

##  Known Limitations

**50 MB file size limit**
The entire file is read into browser memory as an `ArrayBuffer` before chunking begins (`file.arrayBuffer()`). Most browsers limit this to around 50–100 MB before becoming unstable. This is a conscious trade-off for simplicity in the MVP.

*Possible extension:* stream directly from the `File` object using the Streams API, bypassing the full in-memory read. Large file support (>500 MB) via OPFS or IndexedDB was listed as an optional brownie point but is not implemented in this version.

**1-to-1 only**
Each room supports exactly two peers. A third peer attempting to join receives a `Room is full` error. Multi-peer mesh swarming (another optional brownie point) is not implemented.

**Room is single-use**
Once either peer disconnects, the room is cleaned up on the server. To transfer again, the sender must refresh and create a new room.

**No auto-resume on disconnect**
If the connection drops mid-transfer, the transfer must restart from 0%. Connection churn recovery (optional brownie point) is not implemented.


---

<div align="center">

Built with React, Node.js, WebRTC, and the Web Crypto API.

</div>