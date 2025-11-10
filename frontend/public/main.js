// ===== DOM elements =====
const bridgeUrlInput = document.getElementById('bridgeUrl');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusSpan = document.getElementById('status');

const subTopicInput = document.getElementById('subTopic');
const subBtn = document.getElementById('subBtn');

const pubTopicInput = document.getElementById('pubTopic');
const pubPayloadInput = document.getElementById('pubPayload');
const pubBtn = document.getElementById('pubBtn');

const logEl = document.getElementById('log');

// NEW: messages box
const messagesEl = document.getElementById('messages');

const enc = new TextEncoder();
const dec = new TextDecoder();

let transport = null;
let stream = null;
let writer = null;
let reader = null;
let nextMessageId = 1;

function log(...args) {
  const line = document.createElement('div');
  line.textContent = args.join(' ');
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log('[client]', ...args);
}

function showMessage(topic, payload) {
  const line = document.createElement('div');
  const ts = new Date().toISOString().split('T')[1].replace('Z','');
  line.textContent = `${ts}  [${topic}] ${payload}`;
  messagesEl.appendChild(line);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ===== MQTT v5 helpers =====

function encodeVarInt(n) {
  const bytes = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b = b | 0x80;
    bytes.push(b);
  } while (n > 0);
  return Uint8Array.from(bytes);
}

function decodeVarInt(buf, offset) {
  let multiplier = 1;
  let value = 0;
  let consumed = 0;
  let encodedByte;
  do {
    if (offset + consumed >= buf.length) return { value: null, consumed: 0 };
    encodedByte = buf[offset + consumed++];
    value += (encodedByte & 0x7f) * multiplier;
    multiplier *= 128;
    if (multiplier > 128*128*128*128) return { value: null, consumed: 0 };
  } while ((encodedByte & 0x80) !== 0);
  return { value, consumed };
}

function encodeFixedHeader(packetType, flags, remainingLength) {
  const rl = encodeVarInt(remainingLength);
  const header = new Uint8Array(1 + rl.length);
  header[0] = (packetType << 4) | (flags & 0x0f);
  header.set(rl, 1);
  return header;
}

function writeUTF8(str) {
  const bytes = enc.encode(str);
  const len = bytes.length;
  const buf = new Uint8Array(2 + len);
  buf[0] = (len >> 8) & 0xff;
  buf[1] = len & 0xff;
  buf.set(bytes, 2);
  return buf;
}

function encodeConnectV5(clientId) {
  // Variable header:
  //  - Protocol Name "MQTT"
  //  - Protocol Level 5
  //  - Connect Flags (Clean Start bit set)
  //  - Keep Alive (60s)
  //  - Properties (v5): length varint (0 = none)
  const protoName = writeUTF8('MQTT');
  const variable = new Uint8Array(protoName.length + 1 + 1 + 2 + 1); // +1 for props length 0
  let o = 0;
  variable.set(protoName, o); o += protoName.length;
  variable[o++] = 5;          // level
  variable[o++] = 0x02;       // flags: Clean Start
  variable[o++] = 0x00;       // keep-alive MSB
  variable[o++] = 60;         // keep-alive LSB
  variable[o++] = 0x00;       // properties length = 0

  // Payload:
  //  - Client Identifier (UTF-8)
  const clientIdBuf = writeUTF8(clientId);

  const remaining = variable.length + clientIdBuf.length;
  const header = encodeFixedHeader(1, 0, remaining); // CONNECT

  const pkt = new Uint8Array(header.length + remaining);
  pkt.set(header, 0);
  pkt.set(variable, header.length);
  pkt.set(clientIdBuf, header.length + variable.length);

  return pkt;
}

function encodeSubscribeV5(topic, messageId) {
  // Variable header:
  //  - Packet Identifier
  //  - Properties length (0)
  const variable = new Uint8Array(2 + 1);
  variable[0] = (messageId >> 8) & 0xff;
  variable[1] = messageId & 0xff;
  variable[2] = 0x00; // properties length

  // Payload:
  //  - [Topic UTF8][Options byte]
  const t = writeUTF8(topic);
  const payload = new Uint8Array(t.length + 1);
  payload.set(t, 0);
  payload[payload.length - 1] = 0x00; // QoS 0

  const remaining = variable.length + payload.length;
  const header = encodeFixedHeader(8, 2, remaining); // SUBSCRIBE (flags must be 0x2)

  const pkt = new Uint8Array(header.length + remaining);
  pkt.set(header, 0);
  pkt.set(variable, header.length);
  pkt.set(payload, header.length + variable.length);
  return pkt;
}

function encodePublishV5(topic, payloadStr, qos = 0) {
  const topicBuf = writeUTF8(topic);
  const payloadBuf = enc.encode(payloadStr);

  let vhLen = topicBuf.length;
  let messageId = 0;
  if (qos > 0) {
    vhLen += 2;
    messageId = (nextMessageId++) & 0xffff;
  }

  // v5 requires Properties after topic (and msgId if qos>0)
  const props = encodeVarInt(0); // empty properties
  vhLen += props.length;

  const variable = new Uint8Array(vhLen);
  let o = 0;
  variable.set(topicBuf, o); o += topicBuf.length;
  if (qos > 0) {
    variable[o++] = (messageId >> 8) & 0xff;
    variable[o++] = messageId & 0xff;
  }
  variable.set(props, o); o += props.length;

  const remaining = variable.length + payloadBuf.length;
  const flags = (qos === 0) ? 0 : (qos << 1);
  const header = encodeFixedHeader(3, flags, remaining); // PUBLISH

  const pkt = new Uint8Array(header.length + remaining);
  pkt.set(header, 0);
  pkt.set(variable, header.length);
  pkt.set(payloadBuf, header.length + variable.length);
  return pkt;
}

function parseIncoming(buf) {
  if (buf.length < 2) return;

  const packetType = buf[0] >> 4;
  const flags = buf[0] & 0x0f;

  // remaining length
  const { value: rl, consumed: rlBytes } = decodeVarInt(buf, 1);
  if (rl == null) return;
  let o = 1 + rlBytes;

  if (packetType === 2) { // CONNACK v5
    // ConnAck Flags, Reason Code, Properties (varint len)
    const ackFlags = buf[o++];      // bit 0 = Session Present
    const reason = buf[o++];        // 0 = Success
    const { value: propsLen, consumed } = decodeVarInt(buf, o);
    o += consumed + propsLen;
    log('<< CONNACK', `reason=${reason}`, `sessionPresent=${(ackFlags & 0x01) ? 1 : 0}`);
    return;
  }

  if (packetType === 9) { // SUBACK v5
    const pid = (buf[o] << 8) | buf[o + 1]; o += 2;
    const { value: propsLen, consumed } = decodeVarInt(buf, o); o += consumed;
    o += propsLen; // skip properties
    const codes = [];
    while (o < buf.length) codes.push(buf[o++]);
    log('<< SUBACK', `pid=${pid}`, `codes=${codes.join(',')}`);
    return;
  }

  if (packetType === 3) { // PUBLISH v5
    const topicLen = (buf[o] << 8) | buf[o + 1]; o += 2;
    const topic = dec.decode(buf.subarray(o, o + topicLen)); o += topicLen;

    let pkid = null;
    const qos = (flags & 0x06) >> 1;
    if (qos > 0) { pkid = (buf[o] << 8) | buf[o + 1]; o += 2; }

    const { value: propsLen, consumed } = decodeVarInt(buf, o); o += consumed;
    o += propsLen; // skip properties

    const payload = dec.decode(buf.subarray(o));
    log('<< PUBLISH', `topic=${topic}`, `qos=${qos}`, pkid != null ? `pkid=${pkid}` : '');
    showMessage(topic, payload);
    return;
  }

  log('<< packet type', packetType, 'len', rl);
}

// ===== WebTransport wiring =====

async function sendBinary(bytes) {
  if (!writer) throw new Error('No active WebTransport writer');
  await writer.write(bytes);
}

async function startReadLoop() {
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      parseIncoming(new Uint8Array(value));
    }
  } catch (e) {
    log('Read loop error:', e);
  } finally {
    log('Read loop finished');
  }
}

// ===== Button handlers =====

connectBtn.addEventListener('click', async () => {
  try {
    const url = bridgeUrlInput.value.trim() || 'https://nam5gxr.duckdns.org:1027/mqtt';

    log('Connecting WebTransport to', url);
    statusSpan.textContent = 'Connecting…';

    transport = new WebTransport(url);

    transport.closed.then(
      () => {
        log('WebTransport closed');
        statusSpan.textContent = 'Disconnected';
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        subBtn.disabled = true;
        pubBtn.disabled = true;
      },
      (err) => {
        log('WebTransport closed with error:', err);
        statusSpan.textContent = 'Disconnected (error)';
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        subBtn.disabled = true;
        pubBtn.disabled = true;
      }
    );

    await transport.ready;
    log('WebTransport ready');

    stream = await transport.createBidirectionalStream();
    writer = stream.writable.getWriter();
    reader = stream.readable.getReader();

    statusSpan.textContent = 'Connected';
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    subBtn.disabled = false;
    pubBtn.disabled = false;

    const clientId = 'browser-' + Math.random().toString(16).slice(2);
    const connectPacket = encodeConnectV5(clientId);
    log('>> CONNECT(v5)', clientId);
    await sendBinary(connectPacket);

    void startReadLoop();
  } catch (e) {
    log('Connect error:', e);
    statusSpan.textContent = 'Disconnected (error)';
  }
});

disconnectBtn.addEventListener('click', async () => {
  try {
    if (transport) await transport.close();
  } catch (e) {
    log('Disconnect error:', e);
  } finally {
    transport = null;
    stream = null;
    writer = null;
    reader = null;
    statusSpan.textContent = 'Disconnected';
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    subBtn.disabled = true;
    pubBtn.disabled = true;
  }
});

subBtn.addEventListener('click', async () => {
  try {
    const topic = subTopicInput.value.trim();
    if (!topic) return;
    const packet = encodeSubscribeV5(topic, nextMessageId++);
    log('>> SUBSCRIBE(v5)', topic);
    await sendBinary(packet);
  } catch (e) {
    log('Subscribe error:', e);
  }
});

pubBtn.addEventListener('click', async () => {
  try {
    const topic = pubTopicInput.value.trim();
    const payload = pubPayloadInput.value;
    if (!topic) return;
    const packet = encodePublishV5(topic, payload, 0);
    log('>> PUBLISH(v5)', `topic=${topic}`, `payload=${payload}`);
    await sendBinary(packet);
  } catch (e) {
    log('Publish error:', e);
  }
});
