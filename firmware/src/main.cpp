// AgentReminder firmware: USB CDC, BLE, and optional Wi-Fi transport for the same cards.
#include <Arduino.h>
#ifndef AGENTREMINDER_PASSPORT
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#endif
#include <ArduinoJson.h>
#include "ui.h"
#include "ble_transport.h"
#include "notification_sound.h"

#ifdef AGENTREMINDER_PASSPORT
#include <nvs_flash.h>

// Arduino reformats default NVS on two initialization errors. A Passport may
// still need that data for the previous play, so keep it and leave BLE unpaired.
extern "C" esp_err_t __real_nvs_flash_init(void);
extern "C" esp_err_t __wrap_nvs_flash_init(void) {
  const esp_err_t error = __real_nvs_flash_init();
  if (error == ESP_ERR_NVS_NO_FREE_PAGES || error == ESP_ERR_NVS_NEW_VERSION_FOUND) return ESP_ERR_INVALID_STATE;
  return error;
}

static constexpr size_t usbRxBuffer = 4096;
static constexpr char fwVersion[] = "0.3.20";
#else
static constexpr size_t usbRxBuffer = 16384;
static constexpr char fwVersion[] = "0.3.16";
static constexpr uint16_t tcpPort = 47322;
static WiFiServer server(tcpPort);
static WiFiClient client;
static Preferences prefs;
static String tcpBuf;
static uint32_t lastWifiPacket;
static bool wifiActive;
static bool mdnsUp;
#endif

static String usbBuf;
static String pairingId, pairingKey;
static uint32_t pairingAt, lastUsbPacket;
static bool usbActive;

static String deviceId() {
  uint64_t mac = ESP.getEfuseMac();
  char b[13]; snprintf(b, sizeof b, "%04X%08X", (uint16_t)(mac >> 32), (uint32_t)mac);
  return String(b);
}

static void sendOn(uint8_t ch, JsonDocument &doc) {
  String s; serializeJson(doc, s); s += '\n';
  if ((ch & CH_USB)) Serial.print(s);
#ifndef AGENTREMINDER_PASSPORT
  if ((ch & CH_WIFI) && client && client.connected()) client.print(s);
#endif
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

#ifndef AGENTREMINDER_PASSPORT
static constexpr char hostname[] = "agentreminder";
static void startWifi() {
  prefs.begin("ar", true);
  String ssid = prefs.getString("ssid", ""), pass = prefs.getString("pass", "");
  prefs.end();
  if (!ssid.length()) return;
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(hostname);
  WiFi.setSleep(false);              // lower latency for button presses
  WiFi.begin(ssid.c_str(), pass.c_str());
}
#endif

static void handle(const String &line, uint8_t ch) {
  JsonDocument m;
  if (deserializeJson(m, line)) return;
  const char *t = m["t"] | "";
  if (ch == CH_USB) { lastUsbPacket = millis(); usbActive = true; }
#ifndef AGENTREMINDER_PASSPORT
  if (ch == CH_WIFI) { lastWifiPacket = millis(); wifiActive = true; }
#endif

  if (!strcmp(t, "hello")) {
    ui_set_connected_host(ch, m["host"] | "");
    JsonDocument r;
    r["t"] = "hello"; r["app"] = "agentreminder"; r["fw"] = fwVersion; r["id"] = deviceId();
    r["link"] = ch == CH_USB ? "usb" : ch == CH_BLE ? "ble" : "wifi";
    r["ble"] = 1; r["ble_paired"] = ble_paired();
    r["interaction"] = true;
    r["font_ok"] = ui_font_ok();
    r["sound"] = notification_sound_enabled();
    r["orientation"] = ui_landscape() ? "landscape" : "portrait";
#ifdef AGENTREMINDER_PASSPORT
    r["board"] = "folotoy-passport";
#else
    if (WiFi.status() == WL_CONNECTED) r["ip"] = WiFi.localIP().toString();
#endif
    sendOn(ch, r);
  } else if (!strcmp(t, "ping")) {
    JsonDocument r; r["t"] = "pong"; r["ts"] = m["ts"]; sendOn(ch, r);
  } else if (!strcmp(t, "approval") || !strcmp(t, "notify") || (!strcmp(t, "ble-pair") && ch == CH_USB)) {
    const bool pairing = !strcmp(t, "ble-pair");
    Item it;
    it.id = m["id"] | ""; it.agent = m["agent"] | "agent";
    it.sessionId = m["sessionId"] | "";
    it.conversation = m["conversation"] | "未命名对话"; it.reason = m["reason"] | "";
    it.title = m["title"] | ""; it.channels = ch; it.at = millis();
    if (!pairing) {
      const char *receivedTime = m["receivedTime"] | "";
      if (strlen(receivedTime) == 11 && strspn(receivedTime, "0123456789- :") == 11) it.receivedTime = receivedTime;
      it.receivedAt = m["ts"] | uint64_t{0};
      it.sequence = m["sequence"] | uint64_t{0};
    }
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
    if (pairing || !strcmp(t, "approval")) ui_add_approval(it, !pairing);
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
#ifndef AGENTREMINDER_PASSPORT
  } else if (!strcmp(t, "wifi") && ch == CH_USB) {
    prefs.begin("ar", false);
    prefs.putString("ssid", m["ssid"] | ""); prefs.putString("pass", m["pass"] | "");
    prefs.end();
    WiFi.disconnect(true); mdnsUp = false;
    startWifi();
    JsonDocument r; r["t"] = "log"; r["msg"] = "wifi saved, connecting"; sendOn(ch, r);
#endif
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
  Serial.setRxBufferSize(usbRxBuffer);
  Serial.begin(115200);
  ui_init();
  ble_init(deviceId(), [](const String &line) { handle(line, CH_BLE); }, [] { ui_remove_channel(CH_BLE); });
#ifndef AGENTREMINDER_PASSPORT
  startWifi();
#endif
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

#ifndef AGENTREMINDER_PASSPORT
  const bool wifiUp = WiFi.status() == WL_CONNECTED;
  if (wifiActive && (!wifiUp || !client.connected() || millis() - lastWifiPacket > 40000UL)) {
    wifiActive = false;
    client.stop();
    tcpBuf = "";
    ui_remove_channel(CH_WIFI);
  }
  if (wifiUp && !mdnsUp) {
    mdnsUp = MDNS.begin(hostname);
    if (mdnsUp) MDNS.addService("agentreminder", "tcp", tcpPort);
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
#endif

  ui_loop();
  delay(5);
}
