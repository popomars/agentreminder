#pragma once
#include <Arduino.h>

// Channel bitmask: which link(s) an item came from, so the decision goes back the same way.
enum : uint8_t { CH_USB = 1, CH_WIFI = 2 };

struct Item {
  String id, agent, conversation, reason, title;
  uint8_t channels = 0;
  uint32_t at = 0, timeoutMs = 90000;
};

// Implemented in main.cpp: send a decision ("allow" | "deny" | "skip") back to the host.
void sendDecision(const Item &it, const char *decision);

void ui_init();
void ui_loop();
void ui_add_approval(const Item &it);
void ui_add_notify(const Item &it);
void ui_remove(const String &id);

bool ui_font_ok();
