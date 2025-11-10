# l4s-bridge-dev – Architecture, Setup & Notes

## Overview

This document describes the full setup for the **l4s-bridge-dev** stack:

- A public **EMQX MQTT broker** running in Docker on an Ubuntu server.
- A custom **Node.js bridge** that:
  - Accepts **WebTransport over HTTP/3 over QUIC** from browser clients.
  - Connects to EMQX over **QUIC** with ALPN=`mqtt`, forwarding **raw MQTT bytes**.
- A simple **frontend web client** that speaks MQTT directly over WebTransport (binary framing), so messages can flow:
  - **Browser ⇄ Bridge** over WebTransport/QUIC.
  - **Bridge ⇄ EMQX** over QUIC (`mqtt` ALPN).
  - **Traditional MQTT clients** over TCP (Python, etc.) also connect to EMQX and exchange messages with the browser.

Certificates are managed by **acme.sh** with **ZeroSSL** and **DuckDNS**, and are shared between EMQX and the bridge so that automated renewal keeps everything valid.

Git is configured on the server and the entire project is pushed to a GitHub repo: **`Skorpinakos/l4s-bridge-dev`** via SSH.

This file is meant as a compact “state of the world” so future work (auth, QoS, performance tuning, UI, etc.) can build on it without re-discovering all the details.

---

## 1. Host, OS & Network

- Hostname: `l4s-tests`
- OS: **Ubuntu 22.04 (jammy)**
- Public static IP: fronted by DuckDNS domain `nam5gxr.duckdns.org`.
- SSH:
  - Port: **22**
  - User: `ubuntu`
  - Example (Windows, using key.txt on Desktop):
    ```bash
    ssh -i ~/Desktop/key.txt ubuntu@150.140.195.216
    ```

### Firewall (ufw)

- Default policies:
  - `sudo ufw default deny incoming`
  - `sudo ufw default allow outgoing`
- Allowed incoming rules:
  - `22/tcp`  (SSH)
  - `1026:1030/tcp`
  - `1026:1030/udp`
- Status check:
  ```bash
  sudo ufw status numbered
  ```

This ensures only SSH and your custom ports (bridge, frontend, and EMQX mappings) are reachable from the internet.

---

## 2. Domain & TLS Certificates

- Dynamic DNS: **DuckDNS**
  - Domain: `nam5gxr.duckdns.org`
  - Points to the server’s public IP.
- ACME client: **acme.sh** installed as user `ubuntu`:
  - Installed under: `/home/ubuntu/.acme.sh`

### Certificate Issuance (ZeroSSL, DNS-01 via DuckDNS)

1. Set DuckDNS token in the environment (for this shell):
   ```bash
   export DuckDNS_Token="YOUR_DUCKDNS_TOKEN"
   ```

2. Issue an ECC certificate for the domain:
   ```bash
   ~/.acme.sh/acme.sh --issue      --dns dns_duckdns      -d nam5gxr.duckdns.org      --keylength ec-256
   ```

### Certificate Install (Shared Between EMQX & Bridge)

We store key and full chain in a shared directory:

```bash
mkdir -p /home/ubuntu/.acme-certs

~/.acme.sh/acme.sh --install-cert -d nam5gxr.duckdns.org --ecc   --key-file      /home/ubuntu/.acme-certs/privkey.pem   --fullchain-file /home/ubuntu/.acme-certs/fullchain.pem   --reloadcmd "docker compose -f /home/ubuntu/emqx/docker-compose.yml restart emqx || true"
```

Symlinks for EMQX (which expects `key.pem`, `cert.pem`, `cacert.pem`):

```bash
cd /home/ubuntu/.acme-certs
ln -sf privkey.pem   key.pem
ln -sf fullchain.pem cert.pem
ln -sf fullchain.pem cacert.pem
```

### Renewal

- `acme.sh` sets up its own cron job at install time.
- On renewal, it re-runs the `--install-cert` step, which:
  - Updates `/home/ubuntu/.acme-certs/privkey.pem` and `fullchain.pem`.
  - Executes the `--reloadcmd` which restarts EMQX via Docker Compose.
- The bridge reuses the same certs via a Docker volume mount, so renewed certs are used on container restart (or bind-mounted live if you reload the bridge container).

---

## 3. EMQX Broker (Docker)

### Location & Compose

- EMQX project directory on server: `~/emqx`
- Compose file: `~/emqx/docker-compose.yml`
- The same compose is also copied into the repo under:
  - `~/l4s-bridge-dev/emqx/docker-compose.yml`

### Port Mapping

The EMQX container uses its default internal ports:

- MQTT TCP: `1883`
- MQTT over WS: `8083`
- MQTT over WSS: `8084`
- MQTT over QUIC: `14567` (UDP)

Mapped to host as requested:

- **Host 1028/tcp → EMQX 1883** (raw MQTT TCP)
- **Host 1029/tcp → EMQX 8084** (MQTT over WSS)
- **Host 1030/udp → EMQX 14567** (MQTT over QUIC)

Example docker-compose snippet (simplified to only the important parts):

```yaml
services:
  emqx:
    image: emqx/emqx:latest
    container_name: emqx
    restart: unless-stopped
    ports:
      - "1028:1883"       # MQTT TCP
      - "1029:8084"       # WSS
      - "1030:14567/udp"  # QUIC
    volumes:
      - /home/ubuntu/.acme-certs:/opt/emqx/etc/certs:ro
    environment:
      # QUIC listener
      EMQX_LISTENERS__QUIC__DEFAULT__ENABLE: "true"
      EMQX_LISTENERS__QUIC__DEFAULT__BIND: 14567
      EMQX_LISTENERS__QUIC__DEFAULT__SSL__CERTFILE: "/opt/emqx/etc/certs/cert.pem"
      EMQX_LISTENERS__QUIC__DEFAULT__SSL__KEYFILE: "/opt/emqx/etc/certs/key.pem"
      EMQX_LISTENERS__QUIC__DEFAULT__SSL__CACERTFILE: "/opt/emqx/etc/certs/cacert.pem"
      EMQX_LISTENERS__QUIC__DEFAULT__ALPN: "mqtt"

      # WSS listener
      EMQX_LISTENERS__WSS__DEFAULT__ENABLE: "true"
      EMQX_LISTENERS__WSS__DEFAULT__BIND: 8084
      EMQX_LISTENERS__WSS__DEFAULT__SSL__CERTFILE: "/opt/emqx/etc/certs/cert.pem"
      EMQX_LISTENERS__WSS__DEFAULT__SSL__KEYFILE: "/opt/emqx/etc/certs/key.pem"
```

### Running EMQX

```bash
cd ~/emqx
docker compose up -d
```

Check logs:

```bash
docker logs --tail=200 emqx
```

Verify listeners from inside the container:

```bash
docker exec -it emqx emqx ctl listeners
```

You should see:

- `tcp:default` on `0.0.0.0:1883` (running)
- `ws:default` on `0.0.0.0:8083` (running)
- `wss:default` on `0.0.0.0:8084` (running)
- `quic:default` on `0.0.0.0:14567` (running, ALPN `mqtt`)

---

## 4. Bridge – QUIC + WebTransport

The bridge connects browser → WebTransport → QUIC → EMQX and forwards **raw MQTT bytes**.

### Repo Layout

- Root: `~/l4s-bridge-dev`
- Bridge: `~/l4s-bridge-dev/bridge`
- Frontend: `~/l4s-bridge-dev/frontend`
- EMQX compose copy: `~/l4s-bridge-dev/emqx/docker-compose.yml`

### Node.js & Libraries

- Host Node (for dev): `node 22.21.0` (installed via NodeSource).
- Bridge container base image: `node:22` (Debian bookworm).

Key npm dependencies in the bridge:

- `@fails-components/webtransport`
- `@fails-components/webtransport-transport-http3-quiche`
- `@matrixai/quic`
- `@peculiar/webcrypto`

### Bridge Environment (.env)

In `~/l4s-bridge-dev/bridge/.env`:

```env
BRIDGE_PORT=1027
BRIDGE_HOST=0.0.0.0
BRIDGE_CERT_FILE=/certs/fullchain.pem
BRIDGE_KEY_FILE=/certs/privkey.pem

EMQX_HOST=emqx
EMQX_QUIC_PORT=14567
EMQX_SNI=nam5gxr.duckdns.org
```

- `EMQX_HOST=emqx` assumes the EMQX container name on the same Docker network.
- QUIC to EMQX uses `14567/udp` and ALPN `mqtt`.

### Bridge Core Logic (high level)

#### WebTransport HTTP/3 Server

Using `@fails-components/webtransport`:

```js
const server = new Http3Server({
  port: Number(BRIDGE_PORT),   // 1027
  host: BRIDGE_HOST,           // 0.0.0.0
  cert,                        // /certs/fullchain.pem
  privKey,                     // /certs/privkey.pem
  secret: 'change-me-to-something-random',
});

const sessionStream = server.sessionStream('/mqtt');

for await (const session of sessionStream) {
  // New WebTransport session from browser
  for await (const bidi of session.incomingBidirectionalStreams) {
    // Each bidi stream is one logical MQTT connection
  }
}
```

Endpoint for browsers:  
`https://nam5gxr.duckdns.org:1027/mqtt`

#### QUIC Client to EMQX (critical fix: ALPN)

Using `@matrixai/quic`:

```js
const webcrypto = new peculiarWebcrypto.Crypto();
async function randomBytes(data) {
  webcrypto.getRandomValues(new Uint8Array(data));
}

async function createEmqxQuicClient() {
  console.log(
    `[bridge] creating QUIC client -> ${EMQX_HOST}:${EMQX_QUIC_PORT} (ALPN=mqtt)`,
  );

  const client = await QUICClient.createQUICClient({
    host: EMQX_HOST,
    port: parseInt(EMQX_QUIC_PORT, 10),
    config: {
      // This is key: sets ALPN to "mqtt"
      applicationProtos: ['mqtt'],
      // Dev mode: don't verify peer cert
      verifyPeer: false,
    },
    crypto: {
      crypto: webcrypto,
      ops: { randomBytes },
    },
  });

  console.log('[bridge] QUIC client created');
  return client;
}
```

The important discovery: **must use `config.applicationProtos = ['mqtt']`** so EMQX accepts the QUIC/TLS handshake. Previously, EMQX returned transport code `376` (TLS alert `no_application_protocol`) until this was fixed.

#### Stream Bridging (WebTransport ⇄ QUIC)

For each WebTransport bidi stream:

- Create a new QUIC client + QUIC stream to EMQX.
- Pipe browser bytes → EMQX and EMQX bytes → browser.

Rough structure:

```js
async function handleBidiStream(session, bidi) {
  let quicClient;
  let quicStream;
  let wtReader;
  let wtWriter;
  let quicWriter;
  let quicReader;

  try {
    quicClient = await createEmqxQuicClient();
    quicStream = quicClient.connection.newStream();

    wtReader = bidi.readable.getReader();
    wtWriter = bidi.writable.getWriter();
    quicWriter = quicStream.writable.getWriter();
    quicReader = quicStream.readable.getReader();

    // Browser -> EMQX
    const clientToEmqx = (async () => {
      for (;;) {
        const { value, done } = await wtReader.read();
        if (done) break;
        if (value && value.byteLength) {
          await quicWriter.write(value);
        }
      }
      await quicWriter.close();
    })();

    // EMQX -> Browser
    const emqxToClient = (async () => {
      for (;;) {
        const { value, done } = await quicReader.read();
        if (done) break;
        if (value && value.byteLength) {
          await wtWriter.write(value);
        }
      }
      await wtWriter.close();
    })();

    await Promise.race([
      clientToEmqx,
      emqxToClient,
      session.closed.catch(() => {}),
    ]);
  } finally {
    try { wtReader?.releaseLock(); } catch {}
    try { quicReader?.releaseLock(); } catch {}
    if (quicClient) {
      try { await quicClient.close(); } catch {}
    }
  }
}
```

### Bridge Docker Image & Container

Dockerfile (simplified idea, actual file is in repo):

- Base image: `node:22`
- Copy `package.json` / `package-lock.json`, run `npm install`.
- Copy `src/` (including `server.mjs`), set `CMD` to `node src/server.mjs`.

Run container:

```bash
cd ~/l4s-bridge-dev/bridge

docker build -t l4s-bridge .

docker rm -f l4s-bridge || true
docker run -d --name l4s-bridge   --restart unless-stopped   --network emqx_default   -p 1027:1027/udp   -v /home/ubuntu/.acme-certs:/certs:ro   --env-file .env   l4s-bridge
```

Logs:

```bash
docker logs -f l4s-bridge
```

Successful startup looks like:

```text
[bridge] WebTransport listening on udp://0.0.0.0:1027/mqtt
[bridge] Forwarding QUIC streams to emqx:14567 (ALPN=mqtt)
```

When a browser connects:

```text
[bridge] New WebTransport session
[bridge] New bidi stream from client
[bridge] creating QUIC client -> emqx:14567 (ALPN=mqtt)
INFO:QUICClient:Create QUICClient to emqx:14567
...
[bridge] QUIC client created
[bridge] QUIC stream opened to EMQX
```

At that point, MQTT packets flow through the bridge.

---

## 5. Frontend (Browser MQTT over WebTransport)

Directory: `~/l4s-bridge-dev/frontend`

### Frontend Server

A small Node-based HTTP server serves static files (HTML + JS) on port **1026** (host). It’s separate from EMQX and from the QUIC/WebTransport bridge.

You can run it with something like:

```bash
cd ~/l4s-bridge-dev/frontend
node server.mjs
```

(Actual script is in the repo; it just serves `index.html` and `main.js`.)

### Frontend UI (index.html)

- Inputs:
  - Bridge URL (default: `https://nam5gxr.duckdns.org:1027/mqtt`)
- Buttons:
  - Connect / Disconnect
  - Subscribe (topic: default `test/topic`)
  - Publish (topic + payload)
- Panels:
  - Log area (and optionally a separate “incoming messages” box).

### MQTT over WebTransport (main.js)

- Uses **native `WebTransport`** API in the browser:

  ```js
  const url = bridgeUrlInput.value.trim()
    || 'https://nam5gxr.duckdns.org:1027/mqtt';

  const transport = new WebTransport(url);
  await transport.ready;

  const stream = await transport.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  ```

- Implements minimal MQTT 3.1.1 encode/decode over that bidi stream:

  - **CONNECT** packet:
    - Protocol name: `MQTT`
    - Version: 4
    - Clean session flag.
    - Keepalive: 60 seconds.
    - `clientId` = `"browser-" + random hex`.

  - **SUBSCRIBE**:
    - Topic string from text field (`subTopic`), QoS 0.
    - Increments a message ID counter.

  - **PUBLISH**:
    - Topic + payload from input fields.
    - QoS 0 by default.

- The parser handles:
  - `CONNACK`
  - `SUBACK`
  - `PUBLISH` (topic + payload)
  - Logs each packet type to the log panel.

- Example log when working:
  - `>> CONNECT browser-...`
  - `<< CONNACK`
  - `>> SUBSCRIBE test/topic`
  - `<< SUBACK`
  - `>> PUBLISH topic=test/topic payload=hello from WebTransport`
  - `<< PUBLISH topic=test/topic payload=...` (from other clients)

---

## 6. Python MQTT Test Clients

Using `paho-mqtt` (not necessarily committed yet, but conceptually):

- Connect to EMQX via the TCP MQTT mapping:

  ```python
  client.connect("nam5gxr.duckdns.org", 1028, 60)
  ```

- Topic used: `test/topic`

Bindings:

- Browser ⇄ Bridge ⇄ EMQX over QUIC.
- Python ⇄ EMQX over TCP.
- Messages from browser appear in Python subscriber (and vice versa) once the bridge is working.

---

## 7. Node / System Configuration Notes

- System originally had `nodejs 12.22.9` from Ubuntu.
- For dev, Node 22 was installed via NodeSource:
  - Needed to remove `libnode-dev` conflict before installing.
- The **bridge container** uses `node:22` (Debian) image to ensure GLIBC compatibility and ease of building the `webtransport-transport-http3-quiche` native module from source.
- Native module was built in the container (not on the host) to avoid GLIBC/GLIBCXX version issues.

---

## 8. Git & GitHub Setup

### Local Git

Project root is a git repo:

```bash
cd ~/l4s-bridge-dev
git init
git branch -M main
```

`.gitignore` at root:

```gitignore
node_modules/
.env
npm-debug.log*
.DS_Store
```

Git global identity (on the server):

```bash
git config --global user.name "Ioannis Tsamprs"
git config --global user.email "itsampras@ece.upatras.gr"
```

### SSH Key for GitHub

On the server:

```bash
ssh-keygen -t ed25519 -C "itsampras@ece.upatras.gr" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

The public key (`~/.ssh/id_ed25519.pub`) was added to GitHub under:

> Settings → SSH and GPG keys

Tested with:

```bash
ssh -T git@github.com
```

### GitHub Repository

- GitHub username: **`Skorpinakos`**
- Repository: **`l4s-bridge-dev`** (created manually on GitHub).
- SSH remote from server:

  ```bash
  cd ~/l4s-bridge-dev
  git remote add origin git@github.com:Skorpinakos/l4s-bridge-dev.git
  git add .
  git commit -m "Initial commit: l4s QUIC/WebTransport bridge, frontend, EMQX compose"
  git push -u origin main
  ```

GitHub initially blocked pushes due to email privacy (GH007) but was resolved by adjusting email visibility / settings or using the correct allowed email.

---

## 9. Current Working State

As of the last working test:

- EMQX is running in Docker with:
  - TCP MQTT on host `1028/tcp` → EMQX `1883`.
  - WSS MQTT on host `1029/tcp` → EMQX `8084`.
  - QUIC MQTT on host `1030/udp` → EMQX `14567/udp` with ALPN `mqtt`.

- Bridge container is running with:
  - WebTransport listener on host `1027/udp` at path `/mqtt`.
  - QUIC client to EMQX `emqx:14567` with `applicationProtos = ['mqtt']` and `verifyPeer = false`.
  - Certificates read from `/home/ubuntu/.acme-certs` via `/certs` bind mount.

- Frontend is served via simple HTTP on host `1026/tcp` and can connect to:
  - `https://nam5gxr.duckdns.org:1027/mqtt` over WebTransport.

- Functionality:
  - Browser client receives `CONNACK` from EMQX via bridge.
  - Browser can `SUBSCRIBE` and `PUBLISH` to `test/topic`.
  - Python TCP clients connected to `nam5gxr.duckdns.org:1028` see browser messages and can send messages that appear in the browser.
  - Logs confirm QUIC connection from bridge to EMQX is stable and no longer failing with TLS `no_application_protocol`.

This is the baseline to build on in future sessions (auth, QoS, performance tuning, better UI, etc.).
