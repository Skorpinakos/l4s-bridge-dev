// frontend/main.js
import { WebTransportMqttClient } from './mqtt-wt-client.js';

// ----- DOM elements -----
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
const messagesEl = document.getElementById('messages');

let client = null;

// ----- UI helpers -----

function log(...args) {
  const line = document.createElement('div');
  line.textContent = args.join(' ');
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log('[client]', ...args);
}

function showMessage(topic, payload) {
  const line = document.createElement('div');
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  line.textContent = `${ts}  [${topic}] ${payload}`;
  messagesEl.appendChild(line);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setDisconnectedState(reasonText = 'Disconnected') {
  statusSpan.textContent = reasonText;
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  subBtn.disabled = true;
  pubBtn.disabled = true;
}

function setConnectedState() {
  statusSpan.textContent = 'Connected';
  connectBtn.disabled = true;
  disconnectBtn.disabled = false;
  subBtn.disabled = false;
  pubBtn.disabled = false;
}

// ----- Button handlers -----

connectBtn.addEventListener('click', async () => {
  try {
    const url =
      bridgeUrlInput.value.trim() ||
      'https://nam5gxr.duckdns.org:1027/mqtt';

    // fresh client each time for now
    client = new WebTransportMqttClient(url);

    client
      .on('log', (...args) => log(...args))
      .on('message', (topic, payload) => showMessage(topic, payload))
      .on('connect', () => {
        log('Client connected (MQTT v5)');
        setConnectedState();
      })
      .on('connack', ({ reason }) => {
        if (reason !== 0) {
          log('CONNACK non-zero reason:', reason);
        }
      })
      .on('suback', ({ packetId, codes }) => {
        log('SUBACK', `pid=${packetId}`, `codes=${codes.join(',')}`);
      })
      .on('close', () => {
        log('Client closed');
        setDisconnectedState('Disconnected');
      })
      .on('error', (err) => {
        log('Client error:', err);
        setDisconnectedState('Disconnected (error)');
      });

    statusSpan.textContent = 'Connecting…';
    connectBtn.disabled = true;

    await client.connect();
  } catch (e) {
    log('Connect error:', e);
    setDisconnectedState('Disconnected (error)');
  }
});

disconnectBtn.addEventListener('click', async () => {
  try {
    if (client) await client.disconnect();
  } catch (e) {
    log('Disconnect error:', e);
  } finally {
    setDisconnectedState('Disconnected');
  }
});

subBtn.addEventListener('click', async () => {
  try {
    if (!client) return;
    const topic = subTopicInput.value.trim();
    if (!topic) return;
    await client.subscribe(topic);
  } catch (e) {
    log('Subscribe error:', e);
  }
});

pubBtn.addEventListener('click', async () => {
  try {
    if (!client) return;
    const topic = pubTopicInput.value.trim();
    const payload = pubPayloadInput.value;
    if (!topic) return;
    await client.publish(topic, payload, 0);
  } catch (e) {
    log('Publish error:', e);
  }
});
