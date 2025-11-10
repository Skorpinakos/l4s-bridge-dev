#!/usr/bin/env python3
import json
import os
import time
import random

from dotenv import load_dotenv
import paho.mqtt.client as mqtt

load_dotenv()

MQTT_HOST = os.getenv("MQTT_HOST", "nam5gxr.duckdns.org")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1028"))
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "telemetry/geopose")
MQTT_CLIENT_ID = os.getenv("MQTT_CLIENT_ID", "python-telemetry")
MQTT_RATE_HZ = float(os.getenv("MQTT_RATE_HZ", "10.0"))

MQTT_USERNAME = os.getenv("MQTT_USERNAME") or None
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD") or None

# QoS 0 = fire-and-forget
QOS = 0

INTERVAL = 1.0 / MQTT_RATE_HZ

# Time sync topics (JS will use them)
TIME_SYNC_REQ_TOPIC = os.getenv("TIME_SYNC_REQ_TOPIC", "time/sync/req")
TIME_SYNC_RESP_TOPIC = os.getenv("TIME_SYNC_RESP_TOPIC", "time/sync/resp")

cnt = 0


def now_ms() -> int:
  """Milliseconds since Unix epoch."""
  return time.time_ns() // 1_000_000


def on_connect(client, userdata, flags, reason_code, properties=None):
  print(f"[on_connect] Connected to {MQTT_HOST}:{MQTT_PORT} rc={reason_code}")
  # Listen for time-sync requests from the browser
  client.subscribe(TIME_SYNC_REQ_TOPIC, qos=0)


def on_message(client, userdata, msg):
  # Simple NTP-style time sync responder
  if msg.topic != TIME_SYNC_REQ_TOPIC:
    return

  try:
    data = json.loads(msg.payload.decode("utf-8"))
    t1 = data.get("t1")
    if not isinstance(t1, (int, float)):
      return
  except Exception:
    return

  # T2 = server receive, T3 = server send (keep code path tiny)
  t2 = now_ms()
  t3 = now_ms()

  resp = {"t1": t1, "t2": t2, "t3": t3}
  client.publish(
    TIME_SYNC_RESP_TOPIC,
    json.dumps(resp, separators=(",", ":")),
    qos=0,
    retain=False,
  )


def main():
  global cnt

  client = mqtt.Client(
    client_id=MQTT_CLIENT_ID,
    protocol=mqtt.MQTTv5,
    transport="tcp",
  )

  client.on_connect = on_connect
  client.on_message = on_message

  if MQTT_USERNAME:
    client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

  print(f"Connecting to {MQTT_HOST}:{MQTT_PORT} ...")
  client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)

  # Run network loop in background thread
  client.loop_start()

  try:
    # Target time for next send (used for pacing only)
    target_time = time.time()

    while True:
      cnt += 1

      ts_ms = now_ms()  # send timestamp (server clock)

      payload = {
        "cnt": cnt,
        "ts": ts_ms,
        "body": {
          "lon": 21.7300 + random.uniform(-0.0001, 0.0001),
          "lat": 38.2466 + random.uniform(-0.0001, 0.0001),
          "alt": 50.0 + random.uniform(-1.0, 1.0),
          "yaw": random.uniform(-180, 180),
          "pitch": random.uniform(-90, 90),
          "roll": random.uniform(-180, 180),
        },
      }

      payload_str = json.dumps(payload, separators=(",", ":"))

      client.publish(MQTT_TOPIC, payload_str, qos=QOS, retain=False)

      # Pacing to target MQTT_RATE_HZ
      target_time += INTERVAL
      sleep_time = target_time - time.time()
      if sleep_time > 0:
        time.sleep(sleep_time)
      else:
        # We are lagging; reset to avoid drift explosion
        target_time = time.time()

  except KeyboardInterrupt:
    print("\nStopping publisher (Ctrl+C)…")
  finally:
    client.loop_stop()
    client.disconnect()
    print("Disconnected cleanly.")


if __name__ == "__main__":
  main()
