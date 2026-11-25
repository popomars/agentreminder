// LVGL UI: approval card with 拒绝 / 终端 / 同意, otherwise a list of recent notifications.
#include "ui.h"
#include "board_config.h"
#include <lvgl.h>
#include <algorithm>
#include <vector>
#include <esp_heap_caps.h>

static BoardDisplay lcd;
static lv_display_t *disp;
static constexpr int stripRows = 32;
static std::vector<Item> approvals;   // oldest first
static std::vector<Item> notes;       // newest first, max 20
static lv_obj_t *content;
static lv_obj_t *approvalCountLabel;
static String displayedApprovalId;
static bool dirty = true;
static uint32_t dimAt = 0;

struct Connection {
  uint8_t channel;
  const char *name;
  bool active;
  String host;
};
static Connection connections[] = {{CH_BLE, "蓝牙", false, {}}, {CH_USB, "USB", false, {}}, {CH_WIFI, "Wi-Fi", false, {}}};

LV_FONT_DECLARE(agentreminder_cjk_35);
LV_FONT_DECLARE(agentreminder_hint_22);
LV_FONT_DECLARE(agentreminder_meta_24);
static lv_font_t fontCn, fontMeta;
static bool fontReady = false;
bool ui_font_ok() { return fontReady; }
#define FONT (&fontCn)

/* ---------------- display / touch glue ---------------- */

static void flush_cb(lv_display_t *d, const lv_area_t *a, uint8_t *px) {
  lcd.draw(a->x1, a->y1, lv_area_get_width(a), lv_area_get_height(a),
           reinterpret_cast<uint16_t *>(px));
  lv_display_flush_ready(d);
}

static void touch_cb(lv_indev_t *, lv_indev_data_t *data) {
  uint16_t x, y;
  if (lcd.getTouch(&x, &y)) {
    data->point.x = x; data->point.y = y; data->state = LV_INDEV_STATE_PRESSED;
    lcd.setBrightness(200); dimAt = millis() + 60000;
  } else data->state = LV_INDEV_STATE_RELEASED;
}

static void wake() { lcd.setBrightness(220); dimAt = millis() + 60000; }

/* ---------------- helpers ---------------- */

static lv_color_t agentColor(const String &a) {
  if (a == "claude") return lv_color_hex(0xD97757);
  if (a == "codex")  return lv_color_hex(0x10A37F);
  if (a == "dsh")    return lv_color_hex(0x4D6BFE);
  return lv_color_hex(0x888888);
}

static lv_obj_t *label(lv_obj_t *parent, const String &txt, lv_color_t col, bool wrap = true) {
  lv_obj_t *l = lv_label_create(parent);
  lv_obj_set_style_text_font(l, FONT, 0);
  lv_obj_set_style_text_color(l, col, 0);
  lv_label_set_text(l, txt.c_str());
  if (wrap) { lv_obj_set_width(l, lv_pct(100)); lv_label_set_long_mode(l, LV_LABEL_LONG_WRAP); }
  return l;
}

static lv_obj_t *metaLabel(lv_obj_t *parent, const String &text, lv_color_t color) {
  auto *l = label(parent, text, color);
  lv_obj_set_style_text_font(l, &fontMeta, 0);
  return l;
}

static lv_obj_t *horizontalRow(lv_obj_t *parent) {
  lv_obj_t *row = lv_obj_create(parent);
  lv_obj_remove_style_all(row);
  lv_obj_set_size(row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
  lv_obj_set_style_pad_column(row, 8, 0);
  return row;
}

static lv_obj_t *timedMetadata(lv_obj_t *parent, const String &text, const String &time, lv_color_t color) {
  if (time.isEmpty()) return metaLabel(parent, text, color);
  auto *row = horizontalRow(parent);
  auto *leading = metaLabel(row, text, color);
  lv_obj_set_width(leading, 0);
  lv_obj_set_flex_grow(leading, 1);
  lv_obj_set_width(metaLabel(row, time, color), LV_SIZE_CONTENT);
  return leading;
}

static void cardMetadata(lv_obj_t *parent, const Item &item, bool scroll) {
  if (item.host.isEmpty()) return;
  auto color = lv_color_hex(0xC5C5C5);
  auto *host = scroll ? metaLabel(parent, "主机 " + item.host, color)
    : timedMetadata(parent, "主机 " + item.host, item.receivedTime, color);
  auto *project = metaLabel(parent, "项目 " + item.project, color);
  if (scroll) {
    lv_label_set_long_mode(host, LV_LABEL_LONG_SCROLL_CIRCULAR);
    lv_label_set_long_mode(project, LV_LABEL_LONG_SCROLL_CIRCULAR);
  }
}

static void decide(const char *decision, int gpio = -1) {
  if (approvals.empty()) return;
  Item it = approvals.front();
  approvals.erase(approvals.begin());
  if (gpio >= 0) {
    Serial.printf("{\"t\":\"log\",\"msg\":\"approval %s physical GPIO %d -> %s\"}\n",
                  it.id.c_str(), gpio, decision);
  }
  sendDecision(it, decision);
  dirty = true;
}

static void onDecision(lv_event_t *e) {
  decide((const char *)lv_event_get_user_data(e));
}

// A held key never carries over to the next approval. Ignore boot-time holds.
struct ApprovalKey {
  int pin;
  bool sample = false, stable = false;
  uint32_t changed = 0;
  String request;
  explicit ApprovalKey(int p) : pin(p) {}
  void init() { pinMode(pin, INPUT_PULLUP); sample = stable = digitalRead(pin) == LOW; }
  bool poll(const String &id) {
    const bool down = digitalRead(pin) == LOW;
    const uint32_t now = millis();
    if (request != id) { request = id; sample = stable = down; changed = now; return false; }
    if (sample != down) { sample = down; changed = now; }
    if (stable != sample && (uint32_t)(now - changed) >= 35) {
      stable = sample;
      return stable && id.length();
    }
    return false;
  }
};
static ApprovalKey denyKey(BUTTON_DENY_PIN), allowKey(BUTTON_ALLOW_PIN);

static void onDismiss(lv_event_t *e) {
  size_t i = (size_t)(uintptr_t)lv_event_get_user_data(e);
  if (i < notes.size()) notes.erase(notes.begin() + i);
  dirty = true;
}

static lv_obj_t *button(lv_obj_t *parent, const char *txt, uint32_t color, const char *decision, int height = 86, bool compact = false) {
  lv_obj_t *b = lv_button_create(parent);
  lv_obj_set_width(b, 0);
  lv_obj_set_flex_grow(b, 1);
  lv_obj_set_height(b, height);
  lv_obj_set_style_pad_all(b, 0, 0);
  lv_obj_set_style_bg_color(b, lv_color_hex(color), 0);
  lv_obj_set_style_radius(b, 10, 0);
  lv_obj_add_event_cb(b, onDecision, LV_EVENT_CLICKED, (void *)decision);
  lv_obj_t *l = compact ? metaLabel(b, txt, lv_color_white()) : label(b, txt, lv_color_white(), false);
  if (compact) {
    lv_obj_set_width(l, lv_pct(94));
    lv_label_set_long_mode(l, LV_LABEL_LONG_SCROLL_CIRCULAR);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
  }
  lv_obj_center(l);
  return b;
}

/* ---------------- screens ---------------- */

static void buildIdle() {
  lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(content, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  String host;
  for (const auto &connection : connections) {
    if (connection.active) { host = connection.host; break; }
  }
  auto *title = label(content, host.isEmpty() ? String("未连接主机") : host, lv_color_white());
  lv_obj_set_style_text_align(title, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_margin_bottom(title, 12, 0);
  for (const auto &connection : connections) {
    if (!connection.active && connection.channel != CH_BLE) continue;
    String text = String(connection.name) + (connection.active ? "已连接" : "未连接");
    if (connection.active && connection.host != host) text += " · " + connection.host;
    auto *state = metaLabel(content, text, lv_color_hex(connection.active ? 0x64DEAD : 0xB5B5B5));
    lv_obj_set_style_text_align(state, LV_TEXT_ALIGN_CENTER, 0);
  }
}

static void updateApprovalCount() {
  const bool hasInput = std::any_of(approvals.begin(), approvals.end(), [](const Item &item) { return item.interaction; });
  lv_label_set_text_fmt(approvalCountLabel, hasInput ? "待处理 %u 项" : "待审批 %u 项", static_cast<unsigned>(approvals.size()));
}

static bool hasChoices(const Item &item) { return item.leftChoice.length() && item.rightChoice.length(); }

static void buildApproval() {
  const Item &it = approvals.front();
  Serial.printf("{\"t\":\"log\",\"msg\":\"render approval %s\"}\n", it.id.c_str());
  lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);
  approvalCountLabel = timedMetadata(content, "", it.receivedTime, lv_color_hex(0xC5C5C5));
  updateApprovalCount();

  lv_obj_t *summary = lv_obj_create(content);
  lv_obj_remove_style_all(summary);
  lv_obj_set_width(summary, lv_pct(100));
  lv_obj_set_flex_grow(summary, 1);
  lv_obj_set_flex_flow(summary, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(summary, 16, 0);
  lv_obj_add_flag(summary, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_scroll_dir(summary, LV_DIR_VER);

  label(summary, it.reason.length() ? it.reason : it.title, lv_color_hex(0xFFD369));
  if (it.conversation.length()) label(summary, it.conversation, lv_color_white());
  cardMetadata(content, it, true);

  if (it.interaction) {
    if (hasChoices(it)) {
      auto *choices = horizontalRow(content);
      button(choices, it.leftChoice.c_str(), 0x365578, "deny", 68, true);
      button(choices, it.rightChoice.c_str(), 0x365578, "allow", 68, true);
    }
    button(horizontalRow(content), "中键 · 回电脑上继续", 0x555555, "skip", 50, true);
  } else {
    auto *btns = horizontalRow(content);
    button(btns, "拒绝", 0xC0392B, "deny");
    button(btns, "终端", 0x555555, "skip");
    button(btns, "同意", 0x27AE60, "allow");
  }
}

static void buildNotes() {
  lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);
  if (std::any_of(notes.begin(), notes.end(), [](const Item &note) { return note.completed; })) {
    auto *hint = label(content, "单击任务可清除", lv_color_hex(0xB5B5B5));
    lv_obj_set_style_text_font(hint, &agentreminder_hint_22, 0);
  }
  for (size_t i = 0; i < notes.size(); i++) {
    const Item &n = notes[i];
    lv_obj_t *card = lv_obj_create(content);
    lv_obj_set_size(card, lv_pct(100), LV_SIZE_CONTENT);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x1E1E1E), 0);
    lv_obj_set_style_border_side(card, LV_BORDER_SIDE_LEFT, 0);
    lv_obj_set_style_border_color(card, agentColor(n.agent), 0);
    lv_obj_set_style_border_width(card, 4, 0);
    lv_obj_set_style_pad_all(card, 6, 0);
    lv_obj_set_flex_flow(card, LV_FLEX_FLOW_COLUMN);
    lv_obj_add_event_cb(card, onDismiss, LV_EVENT_CLICKED, (void *)(uintptr_t)i);
    label(card, n.title, lv_color_white());
    if (n.interaction && n.reason.length()) label(card, n.reason, lv_color_white());
    if (n.conversation.length()) label(card, n.conversation, lv_color_hex(0xD2D2D2));
    cardMetadata(card, n, false);
    if (n.interaction) metaLabel(card, "请在电脑上继续", lv_color_hex(0xC5C5C5));
  }
}

static void rebuild() {
  if (approvalCountLabel && !approvals.empty() && displayedApprovalId == approvals.front().id) {
    // A change behind the visible card should not reset its scroll position.
    updateApprovalCount();
    dirty = false;
    return;
  }
  approvalCountLabel = nullptr;
  displayedApprovalId = approvals.empty() ? String() : approvals.front().id;
  lv_obj_clean(content);
  lv_obj_set_flex_align(content, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
  if (approvals.empty() && notes.empty()) {
    lv_obj_remove_flag(content, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_scroll_to_y(content, 0, LV_ANIM_OFF);
    buildIdle();
  } else if (approvals.empty()) {
    lv_obj_add_flag(content, LV_OBJ_FLAG_SCROLLABLE);
    buildNotes();
  } else {
    lv_obj_remove_flag(content, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_scroll_to_y(content, 0, LV_ANIM_OFF);
    buildApproval();
  }
  dirty = false;
}

/* ---------------- public ---------------- */

void ui_init() {
  denyKey.init(); allowKey.init();
  lcd.init();
  wake();
  lv_init();
  lv_tick_set_cb([]() -> uint32_t { return millis(); });
  fontCn = agentreminder_cjk_35;
  fontCn.fallback = &lv_font_montserrat_28;
  fontCn.line_height = 45;
  fontCn.base_line = 10;
  fontMeta = agentreminder_meta_24;
  fontMeta.fallback = FONT;
  fontMeta.line_height = 36;
  fontReady = true;
  // Exercise the actual LVGL bitmap decoder, not just font character coverage.
  for (uint32_t cp : {0x41U, 0x5BA1U, 0x6279U, 0x62D2U, 0x7EDDU, 0x00B7U, 0x2192U, 0x84DDU, 0x9879U}) {
    const lv_font_t *font = cp == 0x84DDU || cp == 0x9879U ? &fontMeta : FONT;
    lv_font_glyph_dsc_t glyph{};
    if (!lv_font_get_glyph_dsc(font, &glyph, cp, 0) || glyph.is_placeholder) { fontReady = false; break; }
    lv_draw_buf_t *buf = lv_draw_buf_create(glyph.box_w, glyph.box_h, LV_COLOR_FORMAT_A8, LV_STRIDE_AUTO);
    bool ok = buf && lv_font_get_glyph_bitmap(&glyph, buf);
    if (ok) {
      ok = false;
      for (uint32_t i = 0; i < buf->data_size; ++i) if (buf->data[i]) { ok = true; break; }
    }
    if (buf) lv_draw_buf_destroy(buf);
    if (!ok) { fontReady = false; break; }
  }
  const int w = lcd.width(), h = lcd.height();
  disp = lv_display_create(w, h);
  const size_t bufSz = w * stripRows * sizeof(uint16_t);
  void *drawPixels = heap_caps_malloc(bufSz, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  if (!drawPixels) { Serial.println("LVGL buffer allocation failed"); abort(); }
  lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);
  // CO5300 requires even start coordinates and even pixel dimensions.
  lv_display_add_event_cb(disp, [](lv_event_t *event) {
    auto *area = (lv_area_t *)lv_event_get_param(event);
    area->x1 &= ~1; area->y1 &= ~1; area->x2 |= 1; area->y2 |= 1;
  }, LV_EVENT_INVALIDATE_AREA, nullptr);
  lv_display_set_buffers(disp, drawPixels, nullptr, bufSz, LV_DISPLAY_RENDER_MODE_PARTIAL);
  lv_display_set_flush_cb(disp, flush_cb);
  lv_indev_t *in = lv_indev_create();
  lv_indev_set_type(in, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(in, touch_cb);

  lv_obj_t *scr = lv_screen_active();
  lv_obj_set_style_bg_color(scr, lv_color_hex(0x111111), 0);
  lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_all(scr, 20, 0);
  lv_obj_set_style_pad_row(scr, 6, 0);

  content = lv_obj_create(scr);
  lv_obj_remove_style_all(content);
  lv_obj_set_width(content, lv_pct(100));
  lv_obj_set_flex_grow(content, 1);
  lv_obj_set_style_pad_row(content, 8, 0);
  lv_obj_add_flag(content, LV_OBJ_FLAG_SCROLLABLE);

  rebuild();
}

void ui_loop() {
  const uint32_t now = millis();
  for (size_t i = 0; i < approvals.size();) {
    if ((uint32_t)(now - approvals[i].at) >= approvals[i].timeoutMs) {
      approvals.erase(approvals.begin() + i); dirty = true;
    } else ++i;
  }
  const String activeId = approvals.empty() || (approvals.front().interaction && !hasChoices(approvals.front()))
    ? "" : approvals.front().id;
  const bool denied = denyKey.poll(activeId), allowed = allowKey.poll(activeId);
  const bool handoff = lcd.pollPowerKey();
  if (handoff && !approvals.empty()) {
    Serial.printf("{\"t\":\"log\",\"msg\":\"approval %s physical PWR -> skip\"}\n", approvals.front().id.c_str());
    decide("skip");
  } else if (denied) decide("deny", BUTTON_DENY_PIN);
  else if (allowed) decide("allow", BUTTON_ALLOW_PIN);
  if (dirty) rebuild();
  if (dimAt && millis() > dimAt && approvals.empty()) { lcd.setBrightness(30); dimAt = 0; }
  lv_timer_handler();
}

void ui_add_approval(const Item &it) {
  for (auto &a : approvals) if (a.id == it.id) { a.channels |= it.channels; return; }
  approvals.push_back(it);
  wake(); dirty = true;
}

static bool sameCompletion(const Item &a, const Item &b) {
  if (!a.completed || !b.completed || a.host != b.host || a.project != b.project) return false;
  if (a.sessionId.length() || b.sessionId.length()) return a.sessionId == b.sessionId;
  return a.conversation.length() && a.conversation != "未命名对话" && a.conversation == b.conversation;
}

void ui_add_notify(const Item &it) {
  auto existing = std::find_if(notes.begin(), notes.end(), [&](const Item &note) {
    return note.id == it.id || sameCompletion(note, it);
  });
  if (existing != notes.end()) {
    if (existing->id == it.id) return;
    if (it.receivedAt && existing->receivedAt && (it.receivedAt < existing->receivedAt ||
        (it.receivedAt == existing->receivedAt && it.sequence < existing->sequence))) return;
    notes.erase(existing);
  }
  notes.insert(notes.begin(), it);
  if (notes.size() > 20) notes.pop_back();
  wake(); dirty = true;
}

void ui_remove(const String &id) {
  for (size_t i = 0; i < approvals.size(); i++)
    if (approvals[i].id == id) { approvals.erase(approvals.begin() + i); dirty = true; return; }
}

void ui_set_connected_host(uint8_t channel, const String &host) {
  for (auto &connection : connections) {
    if (connection.channel != channel) continue;
    const String name = host.isEmpty() ? String("未知主机") : host;
    if (!connection.active || connection.host != name) {
      connection.active = true;
      connection.host = name;
      if (approvals.empty() && notes.empty()) { wake(); dirty = true; }
    }
    break;
  }
}

const String &ui_connected_host(uint8_t channel) {
  static const String empty;
  for (const auto &connection : connections)
    if (connection.channel == channel && connection.active) return connection.host;
  return empty;
}

void ui_remove_channel(uint8_t channel) {
  for (auto &connection : connections) {
    if (connection.channel == channel && connection.active) {
      connection.active = false;
      connection.host = "";
      if (approvals.empty() && notes.empty()) { wake(); dirty = true; }
    }
  }
  for (auto &approval : approvals) approval.channels &= ~channel;
  const auto end = std::remove_if(approvals.begin(), approvals.end(), [](const Item &item) { return !item.channels; });
  if (end != approvals.end()) {
    approvals.erase(end, approvals.end());
    dirty = true;
  }
}
