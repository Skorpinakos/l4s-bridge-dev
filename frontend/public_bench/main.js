// main.js
// Demo: subscribe to telemetry/geopose and plot (arrivalTime - payload.ts) in ms.

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

const canvas = document.getElementById('latencyCanvas');
const ctx = canvas.getContext('2d');

// ----- State -----
let client = null;
const topic = 'telemetry/geopose';

const maxPoints = 1000;
const latencyPoints = []; // numbers (ms)

// global stats (over all samples seen)
let count = 0;
let sumLatency = 0;
let minLatency = Infinity;
let maxLatency = -Infinity;
let lastLatencyMs = null;

// flag to batch DOM updates & drawing using requestAnimationFrame
let needsRender = true;

// ----- UI helpers -----

function setStatus(connected, text) {
  statusText.textContent = text;
  statusDot.classList.toggle('connected', !!connected);
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
}

function resetStats() {
  count = 0;
  sumLatency = 0;
  minLatency = Infinity;
  maxLatency = -Infinity;
  lastLatencyMs = null;
  latencyPoints.length = 0;
  needsRender = true;
}

// ----- Chart rendering -----

function drawLatencyChart() {
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

  if (!latencyPoints.length) {
    ctx.fillStyle = 'rgba(148,163,184,0.7)';
    ctx.font = '12px system-ui';
    ctx.fillText('No data yet…', marginLeft + 10, marginTop + 20);
    return;
  }

  const values = latencyPoints;
  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    // avoid flatline zero range
    const delta = Math.max(1, Math.abs(min) * 0.1);
    min -= delta;
    max += delta;
  }

  const range = max - min;
  const n = values.length;
  const dx = n > 1 ? plotW / (n - 1) : 0;

  // grid line at avg (window avg, just for the chart)
  const avgWin = values.reduce((a, b) => a + b, 0) / n;
  const yAvg =
    marginTop + plotH - ((avgWin - min) / range) * plotH;
  ctx.strokeStyle = 'rgba(79,209,197,0.3)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(marginLeft, yAvg);
  ctx.lineTo(w - marginRight, yAvg);
  ctx.stroke();
  ctx.setLineDash([]);

  // ticks / labels (min, avgWin, max)
  ctx.fillStyle = 'rgba(148,163,184,0.9)';
  ctx.font = '11px system-ui';
  ctx.fillText(max.toFixed(0) + ' ms', 4, marginTop + 8);
  ctx.fillText(avgWin.toFixed(0) + ' ms', 4, yAvg + 4);
  ctx.fillText(min.toFixed(0) + ' ms', 4, h - marginBottom - 2);

  // latency line
  ctx.strokeStyle = '#4fd1c5';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = marginLeft + dx * i;
    const v = values[i];
    const y =
      marginTop + plotH - ((v - min) / range) * plotH;
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

function addLatencyPoint(latencyMs) {
  latencyPoints.push(latencyMs);
  if (latencyPoints.length > maxPoints) latencyPoints.shift();

  lastLatencyMs = latencyMs;
  count += 1;
  sumLatency += latencyMs;
  minLatency = Math.min(minLatency, latencyMs);
  maxLatency = Math.max(maxLatency, latencyMs);

  // mark for next rAF frame
  needsRender = true;
}

// ----- Render loop (batch DOM + canvas at refresh rate) -----

function renderFrame() {
  if (needsRender) {
    // stats DOM
    msgCountEl.textContent = String(count);

    if (!count || lastLatencyMs == null) {
      lastLatencyEl.textContent = '–';
      avgLatencyEl.textContent = '–';
      minMaxLatencyEl.textContent = '–';
    } else {
      lastLatencyEl.textContent = lastLatencyMs.toFixed(1) + ' ms';
      avgLatencyEl.textContent =
        (sumLatency / count).toFixed(1) + ' ms';
      minMaxLatencyEl.textContent =
        `${minLatency.toFixed(1)} / ${maxLatency.toFixed(1)} ms`;
    }

    // chart
    drawLatencyChart();

    needsRender = false;
  }

  window.requestAnimationFrame(renderFrame);
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

  client
    // we ignore 'log' / 'suback' events to reduce overhead
    .on('connect', async () => {
      setStatus(true, 'Connected');
      try {
        await client.subscribe(topic);
      } catch {
        // soft-fail; status remains "Connected"
      }
    })
    .on('message', (msgTopic, payloadStr) => {
      if (msgTopic !== topic) return;
      let payload;
      try {
        payload = JSON.parse(payloadStr);
      } catch {
        // invalid payload; ignore
        return;
      }

      if (typeof payload.ts !== 'number') {
        return;
      }

      const arrivalMs = Date.now();
      const latencyMs = arrivalMs - payload.ts;

      addLatencyPoint(latencyMs);
    })
    .on('close', () => {
      setStatus(false, 'Disconnected');
      client = null;
    })
    .on('error', () => {
      setStatus(false, 'Error');
      client = null;
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

// initial render + start rAF loop
drawLatencyChart();
setStatus(false, 'Disconnected');
window.requestAnimationFrame(renderFrame);
