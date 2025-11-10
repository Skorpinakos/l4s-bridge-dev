// main.js
// Telemetry demo: subscribe to telemetry/geopose, multi-probe time-sync to server
// over MQTT, plot clock-corrected one-way latency.
// Stats: last 5 seconds. Graph: last 3 seconds.

import { WebTransportMqttClient } from './mqtt-wt-client.js';

// ----- DOM -----
const bridgeUrlInput = document.getElementById('bridgeUrl');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

const msgCountEl = document.getElementById('msgCount');
const lastLatencyEl = document.getElementById('lastLatency');
const avgLatencyEl = document.getElementById('avgLatency');
const minMaxLatencyEl = document.getElementById('minMaxLatency');

const latencyCanvas = document.getElementById('latencyCanvas');
const latencyCtx = latencyCanvas.getContext('2d');

// ----- Config -----

const topic = 'telemetry/geopose';

// Time sync topics – must match the Python publisher
const TIME_SYNC_REQ_TOPIC = 'time/sync/req';
const TIME_SYNC_RESP_TOPIC = 'time/sync/resp';

// Time windows (ms)
const STATS_WINDOW_MS = 5000; // stats over last 5s
const GRAPH_WINDOW_MS = 3000; // graph over last 3s

// ----- State -----

let client = null;

// server_time ≈ client_time + clockOffsetMs
let clockOffsetMs = 0;

// store (time, value) for latency samples
const latencySamples = []; // { t: number, v: number }

// Batch DOM/canvas updates via rAF
let needsRender = true;

// ----- UI helpers -----

function setStatus(connected, text) {
  statusText.textContent = text;
  statusDot.classList.toggle('connected', !!connected);
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
}

function resetStats() {
  latencySamples.length = 0;
  clockOffsetMs = 0;
  needsRender = true;
}

// ----- Drawing -----

function drawLatencyChart(values) {
  const ctx = latencyCtx;
  const canvas = latencyCanvas;
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const marginLeft = 40;
  const marginRight = 10;
  const marginTop = 15;
  const marginBottom = 25;
  const plotW = w - marginLeft - marginRight;
  const plotH = h - marginTop - marginBottom;

  // background
  const grad = ctx.createLinearGradient(0, marginTop, 0, h - marginBottom);
  grad.addColorStop(0, '#020617');
  grad.addColorStop(1, '#020617');
  ctx.fillStyle = grad;
  ctx.fillRect(marginLeft, marginTop, plotW, plotH);

  ctx.lineWidth = 1;

  // axes
  ctx.strokeStyle = 'rgba(148,163,184,0.6)';
  ctx.beginPath();
  // x-axis
  ctx.moveTo(marginLeft, h - marginBottom);
  ctx.lineTo(w - marginRight, h - marginBottom);
  // y-axis
  ctx.moveTo(marginLeft, marginTop);
  ctx.lineTo(marginLeft, h - marginBottom);
  ctx.stroke();

  if (!values.length) {
    ctx.fillStyle = 'rgba(148,163,184,0.7)';
    ctx.font = '12px system-ui';
    ctx.fillText('No data yet…', marginLeft + 10, marginTop + 20);
    return;
  }

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    const delta = Math.max(1, Math.abs(min) * 0.1);
    min -= delta;
    max += delta;
  }

  const range = max - min;
  const n = values.length;
  const dx = n > 1 ? plotW / (n - 1) : 0;

  const avg = values.reduce((a, b) => a + b, 0) / n;
  const yAvg = marginTop + plotH - ((avg - min) / range) * plotH;

  // avg grid line
  ctx.strokeStyle = 'rgba(79,209,197,0.3)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(marginLeft, yAvg);
  ctx.lineTo(w - marginRight, yAvg);
  ctx.stroke();
  ctx.setLineDash([]);

  // ticks / labels (min, avg, max)
  ctx.fillStyle = 'rgba(148,163,184,0.9)';
  ctx.font = '11px system-ui';
  ctx.fillText(max.toFixed(0) + ' ms', 4, marginTop + 8);
  ctx.fillText(avg.toFixed(0) + ' ms', 4, yAvg + 4);
  ctx.fillText(min.toFixed(0) + ' ms', 4, h - marginBottom - 2);

  // latency line
  ctx.strokeStyle = '#4fd1c5';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = marginLeft + dx * i;
    const v = values[i];
    const y = marginTop + plotH - ((v - min) / range) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // area fill under curve
  ctx.lineTo(marginLeft + dx * (n - 1), h - marginBottom);
  ctx.lineTo(marginLeft, h - marginBottom);
  ctx.closePath();
  ctx.fillStyle = 'rgba(79,209,197,0.11)';
  ctx.fill();
}

// ----- Data update -----

function addSample(latencyMs) {
  const now = Date.now();
  const v = latencyMs < 0 ? 0 : latencyMs;

  latencySamples.push({ t: now, v });

  // prune samples older than STATS_WINDOW_MS
  const threshold = now - STATS_WINDOW_MS;
  while (latencySamples.length && latencySamples[0].t < threshold) {
    latencySamples.shift();
  }

  needsRender = true;
}

// ----- Render loop -----

function renderFrame() {
  if (needsRender) {
    const now = Date.now();
    const statsFrom = now - STATS_WINDOW_MS;
    const graphFrom = now - GRAPH_WINDOW_MS;

    const last5s = latencySamples.filter((s) => s.t >= statsFrom);
    const last3s = latencySamples.filter((s) => s.t >= graphFrom);

    // Stats over last 5 seconds
    if (!last5s.length) {
      msgCountEl.textContent = '0';
      lastLatencyEl.textContent = '–';
      avgLatencyEl.textContent = '–';
      minMaxLatencyEl.textContent = '–';
    } else {
      const values = last5s.map((s) => s.v);
      const count = values.length;
      const last = values[values.length - 1];
      const sum = values.reduce((a, b) => a + b, 0);
      const min = Math.min(...values);
      const max = Math.max(...values);

      msgCountEl.textContent = String(count);
      lastLatencyEl.textContent = last.toFixed(1) + ' ms';
      avgLatencyEl.textContent = (sum / count).toFixed(1) + ' ms';
      minMaxLatencyEl.textContent =
        `${min.toFixed(1)} / ${max.toFixed(1)} ms`;
    }

    // Graph over last 3 seconds (raw values)
    const rawValues = last3s.map((s) => s.v);
    drawLatencyChart(rawValues);

    needsRender = false;
  }

  window.requestAnimationFrame(renderFrame);
}

// ----- Time sync over MQTT (multi-probe NTP-style) -----

function timeSyncProbe(client) {
  return new Promise((resolve, reject) => {
    const t1 = Date.now();
    let settled = false;

    const handler = (topic, payloadStr) => {
      if (topic !== TIME_SYNC_RESP_TOPIC) return;

      let msg;
      try {
        msg = JSON.parse(payloadStr);
      } catch {
        return;
      }
      if (msg.t1 !== t1) return;

      const t4 = Date.now();
      const { t2, t3 } = msg;
      if (typeof t2 !== 'number' || typeof t3 !== 'number') return;

      client.off('message', handler);
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const offset = ((t2 - t1) + (t3 - t4)) / 2;
      const delay = (t4 - t1) - (t3 - t2);
      resolve({ offset, delay });
    };

    client.on('message', handler);

    const timer = setTimeout(() => {
      client.off('message', handler);
      if (settled) return;
      settled = true;
      reject(new Error('time sync timeout'));
    }, 500);

    client.subscribe(TIME_SYNC_RESP_TOPIC).catch(() => {});

    client.publish(
      TIME_SYNC_REQ_TOPIC,
      JSON.stringify({ t1 }),
      0,
    ).catch(() => {});
  });
}

async function runTimeSyncMulti(client, probes = 7) {
  const results = [];

  for (let i = 0; i < probes; i++) {
    try {
      const r = await timeSyncProbe(client);
      results.push(r);
    } catch {
      // ignore failed probe
    }
  }

  if (!results.length) {
    throw new Error('no successful time sync probes');
  }

  const minDelay = Math.min(...results.map((r) => r.delay));
  const best = results.filter((r) => r.delay <= minDelay + 1);

  const offsets = best.map((r) => r.offset).sort((a, b) => a - b);
  const medianOffset = offsets[Math.floor(offsets.length / 2)];

  return { offset: medianOffset, delay: minDelay };
}

// ----- MQTT / WebTransport wiring -----

async function connect() {
  if (client) return;

  const url = bridgeUrlInput.value.trim();
  if (!url) {
    alert('Please enter a WebTransport bridge URL');
    return;
  }

  resetStats();
  setStatus(false, 'Connecting…');

  client = new WebTransportMqttClient(url);

  const telemetryHandler = (msgTopic, payloadStr) => {
    if (msgTopic !== topic) return;

    let payload;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      return;
    }

    if (typeof payload.ts !== 'number') {
      return;
    }

    const arrivalMs = Date.now();
    const measured = arrivalMs - payload.ts; // client - server
    const latencyMs = measured + clockOffsetMs; // ~ one-way latency (corrected)

    addSample(latencyMs);
  };

  client
    .on('message', telemetryHandler)
    .on('close', () => {
      setStatus(false, 'Disconnected');
      client = null;
    })
    .on('error', () => {
      setStatus(false, 'Error');
      client = null;
    })
    .on('connect', async () => {
      setStatus(true, 'Connected');

      // multi-probe time sync (best effort)
      try {
        const { offset } = await runTimeSyncMulti(client, 7);
        clockOffsetMs = offset;
      } catch {
        clockOffsetMs = 0;
      }

      // subscribe to telemetry
      try {
        await client.subscribe(topic);
      } catch {
        // best-effort
      }
    });

  try {
    await client.connect();
  } catch {
    setStatus(false, 'Error');
    client = null;
  }
}

async function disconnect() {
  if (!client) return;
  try {
    await client.disconnect();
  } finally {
    setStatus(false, 'Disconnected');
    client = null;
  }
}

// ----- Event listeners -----

connectBtn.addEventListener('click', () => {
  void connect();
});

disconnectBtn.addEventListener('click', () => {
  void disconnect();
});

// Initial render & start rAF loop
drawLatencyChart([]);
setStatus(false, 'Disconnected');
window.requestAnimationFrame(renderFrame);
