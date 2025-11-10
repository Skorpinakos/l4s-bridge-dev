// frontend/mqtt-wt-client.js
// Minimal MQTT v5 client over WebTransport, for the l4s bridge.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ----- MQTT helpers (mostly your existing code) -----

function encodeVarInt(n) {
  const bytes = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
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
    if (multiplier > 128 * 128 * 128 * 128) return { value: null, consumed: 0 };
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

// ----- Client class -----

export class WebTransportMqttClient {
  /**
   * @param {string} url  WebTransport URL of the bridge, e.g. https://host:1027/mqtt
   * @param {object} [options]
   * @param {string} [options.clientId]
   * @param {number} [options.keepAlive]  seconds
   */
  constructor(url, options = {}) {
    this.url = url;
    this.clientId =
      options.clientId || 'browser-' + Math.random().toString(16).slice(2);
    this.keepAlive = options.keepAlive ?? 60;

    this.transport = null;
    this.stream = null;
    this.writer = null;
    this.reader = null;
    this.nextMessageId = 1;

    // simple event emitter: connect, close, error, message, log, connack, suback
    this._events = new Map();
  }

  // --- public API (mqtt.js / Paho-ish) ---

  on(event, handler) {
    if (!this._events.has(event)) this._events.set(event, new Set());
    this._events.get(event).add(handler);
    return this;
  }

  off(event, handler) {
    const set = this._events.get(event);
    if (!set) return this;
    set.delete(handler);
    return this;
  }

  async connect() {
    if (this.transport) throw new Error('Already connected');

    this._emit('log', 'Connecting WebTransport to', this.url);
    this.transport = new WebTransport(this.url);

    this.transport.closed.then(
      () => {
        this._emit('log', 'WebTransport closed');
        this._emit('close');
        this._cleanup();
      },
      (err) => {
        this._emit('log', 'WebTransport closed with error', err);
        this._emit('error', err);
        this._cleanup();
      },
    );

    await this.transport.ready;
    this._emit('log', 'WebTransport ready');

    this.stream = await this.transport.createBidirectionalStream();
    this.writer = this.stream.writable.getWriter();
    this.reader = this.stream.readable.getReader();

    const connectPacket = this._encodeConnectV5(this.clientId, this.keepAlive);
    this._emit('log', '>> CONNECT(v5)', this.clientId);
    await this._sendBinary(connectPacket);

    void this._startReadLoop();
  }

  async disconnect() {
    if (!this.transport) return;
    await this.transport.close();
    // cleanup happens in .closed handler
  }

  async subscribe(topic) {
    if (!topic) throw new Error('Topic is required');
    const packet = this._encodeSubscribeV5(topic, this.nextMessageId++);
    this._emit('log', '>> SUBSCRIBE(v5)', topic);
    await this._sendBinary(packet);
  }

  async publish(topic, payload, qos = 0) {
    if (!topic) throw new Error('Topic is required');
    const packet = this._encodePublishV5(
      topic,
      String(payload ?? ''),
      qos,
    );
    this._emit('log', '>> PUBLISH(v5)', `topic=${topic}`, `payload=${payload}`);
    await this._sendBinary(packet);
  }

  // --- internals ---

  _emit(event, ...args) {
    const set = this._events.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(...args);
      } catch (e) {
        console.error('[WebTransportMqttClient] handler error', e);
      }
    }
  }

  _cleanup() {
    this.transport = null;
    this.stream = null;
    this.writer = null;
    this.reader = null;
  }

  async _sendBinary(bytes) {
    if (!this.writer) throw new Error('No active WebTransport writer');
    await this.writer.write(bytes);
  }

  async _startReadLoop() {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value || !value.byteLength) continue;
        this._parseIncoming(new Uint8Array(value));
      }
    } catch (e) {
      this._emit('log', 'Read loop error:', e);
      this._emit('error', e);
    } finally {
      this._emit('log', 'Read loop finished');
    }
  }

  // ----- MQTT encoding -----

  _encodeConnectV5(clientId, keepAliveSeconds) {
    const protoName = writeUTF8('MQTT');
    const variable = new Uint8Array(protoName.length + 1 + 1 + 2 + 1);
    let o = 0;
    variable.set(protoName, o); o += protoName.length;
    variable[o++] = 5;          // level
    variable[o++] = 0x02;       // flags: Clean Start
    const ka = keepAliveSeconds ?? 60;
    variable[o++] = (ka >> 8) & 0xff;
    variable[o++] = ka & 0xff;
    variable[o++] = 0x00;       // properties length = 0

    const clientIdBuf = writeUTF8(clientId);

    const remaining = variable.length + clientIdBuf.length;
    const header = encodeFixedHeader(1, 0, remaining); // CONNECT

    const pkt = new Uint8Array(header.length + remaining);
    pkt.set(header, 0);
    pkt.set(variable, header.length);
    pkt.set(clientIdBuf, header.length + variable.length);

    return pkt;
  }

  _encodeSubscribeV5(topic, messageId) {
    const variable = new Uint8Array(2 + 1);
    variable[0] = (messageId >> 8) & 0xff;
    variable[1] = messageId & 0xff;
    variable[2] = 0x00; // properties length

    const t = writeUTF8(topic);
    const payload = new Uint8Array(t.length + 1);
    payload.set(t, 0);
    payload[payload.length - 1] = 0x00; // QoS 0

    const remaining = variable.length + payload.length;
    const header = encodeFixedHeader(8, 2, remaining); // SUBSCRIBE

    const pkt = new Uint8Array(header.length + remaining);
    pkt.set(header, 0);
    pkt.set(variable, header.length);
    pkt.set(payload, header.length + variable.length);
    return pkt;
  }

  _encodePublishV5(topic, payloadStr, qos = 0) {
    const topicBuf = writeUTF8(topic);
    const payloadBuf = enc.encode(payloadStr);

    let vhLen = topicBuf.length;
    let messageId = 0;
    if (qos > 0) {
      vhLen += 2;
      messageId = (this.nextMessageId++) & 0xffff;
    }

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
    const flags = qos === 0 ? 0 : (qos << 1);
    const header = encodeFixedHeader(3, flags, remaining); // PUBLISH

    const pkt = new Uint8Array(header.length + remaining);
    pkt.set(header, 0);
    pkt.set(variable, header.length);
    pkt.set(payloadBuf, header.length + variable.length);
    return pkt;
  }

  // ----- MQTT parsing -----

  _parseIncoming(buf) {
    if (buf.length < 2) return;

    const packetType = buf[0] >> 4;
    const flags = buf[0] & 0x0f;

    const { value: rl, consumed: rlBytes } = decodeVarInt(buf, 1);
    if (rl == null) return;
    let o = 1 + rlBytes;

    if (packetType === 2) { // CONNACK v5
      const ackFlags = buf[o++];
      const reason = buf[o++];
      const { value: propsLen, consumed } = decodeVarInt(buf, o);
      o += consumed + propsLen;
      const sessionPresent = (ackFlags & 0x01) ? 1 : 0;
      this._emit(
        'log',
        '<< CONNACK',
        `reason=${reason}`,
        `sessionPresent=${sessionPresent}`,
      );
      this._emit('connack', { reason, sessionPresent: !!sessionPresent });
      if (reason === 0) this._emit('connect');
      return;
    }

    if (packetType === 9) { // SUBACK v5
      const pid = (buf[o] << 8) | buf[o + 1]; o += 2;
      const { value: propsLen, consumed } = decodeVarInt(buf, o); o += consumed;
      o += propsLen;
      const codes = [];
      while (o < buf.length) codes.push(buf[o++]);
      this._emit('log', '<< SUBACK', `pid=${pid}`, `codes=${codes.join(',')}`);
      this._emit('suback', { packetId: pid, codes });
      return;
    }

    if (packetType === 3) { // PUBLISH v5
      const topicLen = (buf[o] << 8) | buf[o + 1]; o += 2;
      const topic = dec.decode(buf.subarray(o, o + topicLen)); o += topicLen;

      let pkid = null;
      const qos = (flags & 0x06) >> 1;
      if (qos > 0) { pkid = (buf[o] << 8) | buf[o + 1]; o += 2; }

      const { value: propsLen, consumed } = decodeVarInt(buf, o); o += consumed;
      o += propsLen;

      const payload = dec.decode(buf.subarray(o));
      this._emit(
        'log',
        '<< PUBLISH',
        `topic=${topic}`,
        `qos=${qos}`,
        pkid != null ? `pkid=${pkid}` : '',
      );
      this._emit('message', topic, payload, { qos, packetId: pkid });
      return;
    }

    this._emit('log', '<< packet type', packetType, 'len', rl);
  }
}
