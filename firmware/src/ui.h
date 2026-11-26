#pragma once
#include <Arduino.h>

// Channel bitmask: which link(s) an item came from, so the decision goes back the same way.
enum : uint8_t { CH_USB = 1, CH_WIFI = 2, CH_BLE = 4 };
constexpr uint32_t DEFAULT_APPROVAL_SECONDS = 300;
constexpr size_t NOTIFICATION_DISMISSAL_LIMIT = 100;

struct Item {
  String id, agent, sessionId, conversation, reason, title, host, project, receivedTime, leftChoice, rightChoice;
  bool completed = false, interaction = false;
  uint8_t channels = 0;
  uint32_t at = 0, timeoutMs = DEFAULT_APPROVAL_SECONDS * 1000UL;
  uint64_t receivedAt = 0, sequence = 0;
};

// Implemented in main.cpp: send a decision ("allow" | "deny" | "skip") back to the host.
void sendDecision(const Item &it, const char *decision);
void sendNotificationDismissal(const String &id);

void ui_init();
void ui_loop();
void ui_add_approval(const Item &it, bool audible = true);
void ui_add_notify(const Item &it);
void ui_dismiss_notify(const String &id);
void ui_remove(const String &id);
void ui_set_connected_host(uint8_t channel, const String &host);
const String &ui_connected_host(uint8_t channel);
void ui_remove_channel(uint8_t channel);

bool ui_font_ok();
bool ui_landscape();
