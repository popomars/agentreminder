// AgentReminder firmware: talks NDJSON (docs/protocol.md) over USB CDC and Wi-Fi TCP at the same time.
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "ui.h"

#define FW_VERSION "0.2.0"
#define TCP_PORT 47322
#define HOSTNAME "agentreminder"

static WiFiServer server(TCP_PORT);
static WiFiClient client;
static Preferences prefs;
static String usbBuf, tcpBuf;
static uint32_t usbSeen = 0, tcpSeen = 0;   // last message time per channel
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
}

void sendDecision(const Item &it, const char *decision) {
  JsonDocument d;
  d["t"] = "decision"; d["id"] = it.id; d["decision"] = decision;
  sendOn(it.channels ? it.channels : (CH_USB | CH_WIFI), d);
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
  if (ch == CH_USB) usbSeen = millis(); else tcpSeen = millis();

  if (!strcmp(t, "hello")) {
    JsonDocument r;
    r["t"] = "hello"; r["app"] = "agentreminder"; r["fw"] = FW_VERSION; r["id"] = deviceId();
    r["link"] = ch == CH_USB ? "usb" : "wifi";
    r["font_ok"] = ui_font_ok();
    if (WiFi.status() == WL_CONNECTED) r["ip"] = WiFi.localIP().toString();
    sendOn(ch, r);
  } else if (!strcmp(t, "ping")) {
    JsonDocument r; r["t"] = "pong"; r["ts"] = m["ts"]; sendOn(ch, r);
  } else if (!strcmp(t, "approval") || !strcmp(t, "notify")) {
    Item it;
    it.id = m["id"] | ""; it.agent = m["agent"] | "agent"; it.project = m["project"] | "";
    it.conversation = m["conversation"] | "未命名对话"; it.reason = m["reason"] | "";
    it.title = m["title"] | ""; it.detail = m["detail"] | ""; it.channels = ch; it.at = millis();
    it.timeoutMs = constrain(m["timeout"] | 90, 1, 3600) * 1000UL;
    if (!strcmp(t, "approval")) { it.kind = "approval"; ui_add_approval(it); }
    else { it.kind = m["kind"] | "info"; ui_add_notify(it); }
  } else if (!strcmp(t, "resolved") || !strcmp(t, "cancel")) {
    ui_remove(m["id"] | "");
  } else if (!strcmp(t, "wifi")) {
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
  startWifi();
}

void loop() {
  pump(Serial, usbBuf, CH_USB);

  const bool wifiUp = WiFi.status() == WL_CONNECTED;
  if (wifiUp && !mdnsUp) {
    mdnsUp = MDNS.begin(HOSTNAME);
    if (mdnsUp) MDNS.addService("agentreminder", "tcp", TCP_PORT);
    server.begin(); server.setNoDelay(true);
  }
  if (wifiUp) {
    WiFiClient nc = server.available();
    if (nc) { if (client) client.stop(); client = nc; client.setNoDelay(true); tcpBuf = ""; }
    if (client && client.connected()) pump(client, tcpBuf, CH_WIFI);
  }

  static uint32_t lastStatus = 0;
  if (millis() - lastStatus > 1000) {
    lastStatus = millis();
    const bool usbHost = usbSeen && millis() - usbSeen < 40000;     // host pings every 15 s
    const bool wifiHost = client && client.connected() && tcpSeen && millis() - tcpSeen < 40000;
    ui_set_status(usbHost, wifiUp, wifiUp ? WiFi.localIP().toString() : "", wifiHost);
  }
  ui_loop();
  delay(5);
}
