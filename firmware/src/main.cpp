// AgentReminder firmware: USB CDC, BLE, and optional Wi-Fi transport for the same cards.
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "ui.h"
#include "ble_transport.h"

#define FW_VERSION "0.3.4"
#define TCP_PORT 47322
#define HOSTNAME "agentreminder"

static WiFiServer server(TCP_PORT);
static WiFiClient client;
static Preferences prefs;
static String usbBuf, tcpBuf;
static String pairingId, pairingKey;
static uint32_t pairingAt, lastUsbPacket, lastWifiPacket;
static bool usbActive, wifiActive;
static bool mdnsUp = false;

static String deviceId() {
  uint64_t mac = ESP.getEfuseMac();
  char b[13]; snprintf(b, sizeof b, "%04X%08X", (uint16_t)(mac >> 32), (uint32_t)mac);
  return String(b);
}

static void sendOn(uint8_t ch, JsonDocument &doc) {
  String s; serializeJson(doc, s); s += '\n';
  if ((ch & CH_USB)) Serial.print(s);
  if ((ch & CH_WIFI) && client && client.connected()) client.print(s);
  if (ch & CH_BLE) ble_send(s);
}

static void clearPairing() { pairingId = ""; pairingKey = ""; }

void sendDecision(const Item &it, const char *decision) {
  JsonDocument d;
  d["t"] = "decision"; d["id"] = it.id; d["decision"] = decision;
  if (pairingId.length() && it.id == pairingId && (it.channels & CH_USB)) {
    if (!strcmp(decision, "allow")) {
      const bool saved = ble_save_key(pairingKey.c_str());
      d["ble_paired"] = saved;
      if (!saved) d["decision"] = "skip";
    }
    clearPairing();
  }
  sendOn(it.channels, d);
}

static void startWifi() {
  prefs.begin("ar", true);
  String ssid = prefs.getString("ssid", ""), pass = prefs.getString("pass", "");
  prefs.end();
  if (!ssid.length()) return;
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.setSleep(false);              // lower latency for button presses
  WiFi.begin(ssid.c_str(), pass.c_str());
}

static void handle(const String &line, uint8_t ch) {
  JsonDocument m;
  if (deserializeJson(m, line)) return;
  const char *t = m["t"] | "";
  if (ch == CH_USB) { lastUsbPacket = millis(); usbActive = true; }
  if (ch == CH_WIFI) { lastWifiPacket = millis(); wifiActive = true; }

  if (!strcmp(t, "hello")) {
    ui_set_connected_host(ch, m["host"] | "");
    JsonDocument r;
    r["t"] = "hello"; r["app"] = "agentreminder"; r["fw"] = FW_VERSION; r["id"] = deviceId();
    r["link"] = ch == CH_USB ? "usb" : ch == CH_BLE ? "ble" : "wifi";
    r["ble"] = 1; r["ble_paired"] = ble_paired();
    r["interaction"] = true;
    r["font_ok"] = ui_font_ok();
    if (WiFi.status() == WL_CONNECTED) r["ip"] = WiFi.localIP().toString();
    sendOn(ch, r);
  } else if (!strcmp(t, "ping")) {
    JsonDocument r; r["t"] = "pong"; r["ts"] = m["ts"]; sendOn(ch, r);
  } else if (!strcmp(t, "approval") || !strcmp(t, "notify") || (!strcmp(t, "ble-pair") && ch == CH_USB)) {
    const bool pairing = !strcmp(t, "ble-pair");
    Item it;
    it.id = m["id"] | ""; it.agent = m["agent"] | "agent";
    it.conversation = m["conversation"] | "未命名对话"; it.reason = m["reason"] | "";
    it.title = m["title"] | ""; it.channels = ch; it.at = millis();
    it.interaction = (m["interaction"] | false) || !strcmp(m["kind"] | "", "input");
    if (it.interaction) {
      it.leftChoice = m["choices"][0] | "";
      it.rightChoice = m["choices"][1] | "";
    }
    it.timeoutMs = constrain(m["timeout"] | static_cast<int>(DEFAULT_APPROVAL_SECONDS), 1, 3600) * 1000UL;
    if (pairing) {
      const char *candidate = m["key"] | "";
      if (it.id.isEmpty() || strlen(candidate) != 64 || strspn(candidate, "0123456789abcdef") != 64) return;
      if (pairingId.length()) ui_remove(pairingId);
      pairingId = it.id; pairingKey = candidate; pairingAt = millis();
      it.title = "配对这台电脑";
      it.timeoutMs = 60000;
    } else if (it.agent != "setup") {
      it.host = m["host"] | "";
      if (it.host.isEmpty()) it.host = ui_connected_host(ch);
      if (it.host.isEmpty()) it.host = "未知主机";
      it.project = m["project"] | "";
      if (it.project.isEmpty()) it.project = "未命名项目";
    }
    if (pairing || !strcmp(t, "approval")) ui_add_approval(it);
    else {
      it.completed = !strcmp(m["kind"] | "", "done");
      ui_add_notify(it);
    }
  } else if (!strcmp(t, "resolved") || !strcmp(t, "cancel")) {
    const char *id = m["id"] | "";
    if (pairingId == id) {
      if (ch != CH_USB) return;
      clearPairing();
    }
    ui_remove(id);
  } else if (!strcmp(t, "wifi") && ch == CH_USB) {
    prefs.begin("ar", false);
    prefs.putString("ssid", m["ssid"] | ""); prefs.putString("pass", m["pass"] | "");
    prefs.end();
    WiFi.disconnect(true); mdnsUp = false;
    startWifi();
    JsonDocument r; r["t"] = "log"; r["msg"] = "wifi saved, connecting"; sendOn(ch, r);
  }
}

static void pump(Stream &s, String &buf, uint8_t ch) {
  while (s.available()) {
    char c = s.read();
    if (c == '\n') { buf.trim(); if (buf.length() && buf[0] == '{') handle(buf, ch); buf = ""; }
    else if (buf.length() < 16384) buf += c;
  }
}

void setup() {
  Serial.setRxBufferSize(16384);
  Serial.begin(115200);
  ui_init();
  ble_init(deviceId(), [](const String &line) { handle(line, CH_BLE); }, [] { ui_remove_channel(CH_BLE); });
  startWifi();
}

void loop() {
  pump(Serial, usbBuf, CH_USB);
  if (usbActive && (!Serial.isPlugged() || millis() - lastUsbPacket > 40000UL)) {
    usbActive = false;
    usbBuf = "";
    clearPairing();
    ui_remove_channel(CH_USB);
  }
  if (pairingId.length() && millis() - pairingAt >= 60000UL) clearPairing();
  ble_poll();

  const bool wifiUp = WiFi.status() == WL_CONNECTED;
  if (wifiActive && (!wifiUp || !client.connected() || millis() - lastWifiPacket > 40000UL)) {
    wifiActive = false;
    client.stop();
    tcpBuf = "";
    ui_remove_channel(CH_WIFI);
  }
  if (wifiUp && !mdnsUp) {
    mdnsUp = MDNS.begin(HOSTNAME);
    if (mdnsUp) MDNS.addService("agentreminder", "tcp", TCP_PORT);
    server.begin(); server.setNoDelay(true);
  }
  if (wifiUp) {
    WiFiClient nc = server.available();
    if (nc) {
      if (client) client.stop();
      if (wifiActive) ui_remove_channel(CH_WIFI);
      wifiActive = false;
      client = nc; client.setNoDelay(true); tcpBuf = "";
    }
    if (client && client.connected()) pump(client, tcpBuf, CH_WIFI);
  }

  ui_loop();
  delay(5);
}
