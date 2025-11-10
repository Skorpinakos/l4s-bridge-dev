import { Http3Server } from '@fails-components/webtransport';
import '@fails-components/webtransport-transport-http3-quiche';
import { QUICClient } from '@matrixai/quic';
import * as peculiarWebcrypto from '@peculiar/webcrypto';
import fs from 'fs/promises';

const {
  BRIDGE_PORT = '1027',
  BRIDGE_HOST = '0.0.0.0',
  BRIDGE_CERT_FILE = '/certs/fullchain.pem',
  BRIDGE_KEY_FILE = '/certs/privkey.pem',

  // EMQX is the broker container on the Docker network
  EMQX_HOST = 'emqx',
  EMQX_QUIC_PORT = '14567',
  // SNI must match the cert’s hostname (your duckdns domain)
  EMQX_SNI = 'nam5gxr.duckdns.org',
} = process.env;

// WebCrypto for js-quic
const webcrypto = new peculiarWebcrypto.Crypto();

async function randomBytes(data) {
  webcrypto.getRandomValues(new Uint8Array(data));
}

// ---------- QUIC client to EMQX (one MQTT connection per bidi stream) ----------

async function createEmqxQuicClient() {
  console.log(
    `[bridge] creating QUIC client -> ${EMQX_HOST}:${EMQX_QUIC_PORT} (ALPN=mqtt)`
  );

  const client = await QUICClient.createQUICClient({
    host: EMQX_HOST,
    port: parseInt(EMQX_QUIC_PORT, 10),
    config: {
      // This is what sets ALPN on the QUIC/TLS side
      applicationProtos: ['mqtt'],
      // dev mode: don’t verify EMQX cert
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


// ---------- WebTransport HTTP/3 server (browser ⇄ bridge) ----------

async function startServer() {
  const cert = await fs.readFile(BRIDGE_CERT_FILE);
  const privKey = await fs.readFile(BRIDGE_KEY_FILE);

  const server = new Http3Server({
    port: Number(BRIDGE_PORT),
    host: BRIDGE_HOST,
    cert,
    privKey,
    secret: 'change-me-to-something-random',
  });

  const sessionStream = server.sessionStream('/mqtt');

  (async () => {
    for await (const session of sessionStream) {
      console.log('[bridge] New WebTransport session');
      handleSession(session).catch((err) => {
        console.error('[bridge] Session error', err);
      });
    }
  })().catch((err) => console.error('[bridge] session loop failed', err));

  await server.startServer();
  await server.ready;

  console.log(
    `[bridge] WebTransport listening on udp://${BRIDGE_HOST}:${BRIDGE_PORT}/mqtt`,
  );
  console.log(
    `[bridge] Forwarding QUIC streams to ${EMQX_HOST}:${EMQX_QUIC_PORT} (ALPN=mqtt)`,
  );
}

async function handleSession(session) {
  const incoming = session.incomingBidirectionalStreams;

  for await (const bidi of incoming) {
    console.log('[bridge] New bidi stream from client');
    handleBidiStream(session, bidi).catch((err) => {
      console.error('[bridge] Bidi stream error', err);
    });
  }
}

async function handleBidiStream(session, bidi) {
  let quicClient;
  let quicStream;
  let wtReader;
  let wtWriter;
  let quicWriter;
  let quicReader;

  try {
    // 1. QUIC to EMQX
    quicClient = await createEmqxQuicClient();
    quicStream = quicClient.connection.newStream();

    wtReader = bidi.readable.getReader();
    wtWriter = bidi.writable.getWriter();
    quicWriter = quicStream.writable.getWriter();
    quicReader = quicStream.readable.getReader();

    console.log('[bridge] QUIC stream opened to EMQX');

    // Browser -> EMQX
    const clientToEmqx = (async () => {
      try {
        while (true) {
          const { value, done } = await wtReader.read();
          if (done) break;
          if (value && value.byteLength) {
            await quicWriter.write(value);
          }
        }
        await quicWriter.close();
      } catch (err) {
        console.error('[bridge] client->emqx error', err);
        try { await quicWriter.abort(err); } catch {}
      }
    })();

    // EMQX -> Browser
    const emqxToClient = (async () => {
      try {
        while (true) {
          const { value, done } = await quicReader.read();
          if (done) break;
          if (value && value.byteLength) {
            await wtWriter.write(value);
          }
        }
        await wtWriter.close();
      } catch (err) {
        console.error('[bridge] emqx->client error', err);
        try { await wtWriter.abort(err); } catch {}
      }
    })();

    await Promise.race([
      clientToEmqx,
      emqxToClient,
      session.closed.catch(() => {}),
    ]);
  } catch (err) {
    console.error('[bridge] handleBidiStream fatal error', err);
  } finally {
    try {
      wtReader?.releaseLock();
    } catch {}
    try {
      quicReader?.releaseLock();
    } catch {}

    if (quicClient) {
      try {
        await quicClient.close();
      } catch (e) {
        console.error('[bridge] Error closing QUIC client', e);
      }
    }
    console.log('[bridge] Stream + QUIC client closed');
  }
}

startServer().catch((err) => {
  console.error('[bridge] Bridge failed to start', err);
  process.exit(1);
});
