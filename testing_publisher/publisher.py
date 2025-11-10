#!/usr/bin/env python3
import json
import os
import time
import random

from dotenv import load_dotenv
import paho.mqtt.client as mqtt

# Load configuration from .env in the same folder
# Expected keys (with sensible defaults):
#   MQTT_HOST, MQTT_PORT, MQTT_TOPIC, MQTT_CLIENT_ID,
#   MQTT_RATE_HZ, MQTT_USERNAME, MQTT_PASSWORD
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

# Interval between messages (seconds)
INTERVAL = 1.0 / MQTT_RATE_HZ

cnt = 0


def on_connect(client, userdata, flags, reason_code, properties=None):
    print(f"[on_connect] Connected to {MQTT_HOST}:{MQTT_PORT} rc={reason_code}")


def main():
    global cnt

    # MQTT v5 client over TCP
    client = mqtt.Client(
        client_id=MQTT_CLIENT_ID,
        protocol=mqtt.MQTTv5,
        transport="tcp",
    )

    client.on_connect = on_connect

    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    print(f"Connecting to {MQTT_HOST}:{MQTT_PORT} ...")
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)

    # Run network loop in background thread
    client.loop_start()

    try:
        next_send = time.time()
        while True:
            cnt += 1

            # Milliseconds since Unix epoch – easy to compare with JS Date.now()
            ts_ms = time.time_ns() // 1_000_000

            # Example geopose payload; replace with real sensors if you wish
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

            # Fire-and-forget publish
            client.publish(MQTT_TOPIC, payload_str, qos=QOS, retain=False)

            # Simple rate control to target MQTT_RATE_HZ
            next_send += INTERVAL
            sleep_time = next_send - time.time()
            if sleep_time > 0:
                time.sleep(sleep_time)
            else:
                # We are lagging; reset schedule to avoid drift explosion
                next_send = time.time()
            if sleep_time>=0.05:
                print(cnt)
    except KeyboardInterrupt:
        print("\nStopping publisher (Ctrl+C)…")
    finally:
        client.loop_stop()
        client.disconnect()
        print("Disconnected cleanly.")


if __name__ == "__main__":
    main()
