// LVGL UI: approval card with 拒绝 / 终端 / 同意, otherwise a list of recent notifications.
#include "ui.h"
#include "notification_sound.h"
#ifdef AGENTREMINDER_PASSPORT
#include "board_passport.h"
#include "passport_keys.h"
#include <Preferences.h>
#else
#include "board_config.h"
#endif
#include <lvgl.h>
#include <algorithm>
#include <vector>
#include <esp_heap_caps.h>

static BoardDisplay lcd;
static lv_display_t *disp;
#ifdef AGENTREMINDER_PASSPORT
static constexpr bool compactScreen = true;
static constexpr int stripRows = 12;
static constexpr int passportScreenPadding = 8;
static constexpr int passportCueDepth = 38;
static constexpr int passportPortraitCueSpan = 90;
static constexpr int passportLandscapeCueSpan = 80;
static constexpr int passportCueGap = 8;
static PassportKeys passportKeys;
static lv_obj_t *passportScrollArea;
static uint32_t passportScrollAt;
static size_t selectedNote;
static lv_obj_t *passportSoundStatus;
static uint32_t passportSoundStatusUntil;
#else
static constexpr bool compactScreen = false;
static constexpr int stripRows = 32;
#endif
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

#ifdef AGENTREMINDER_PASSPORT
LV_FONT_DECLARE(agentreminder_passport_24);
static lv_font_t passportHostFont;
#else
LV_FONT_DECLARE(agentreminder_cjk_35);
LV_FONT_DECLARE(agentreminder_hint_22);
LV_FONT_DECLARE(agentreminder_meta_24);
#endif
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

#ifndef AGENTREMINDER_PASSPORT
static void touch_cb(lv_indev_t *, lv_indev_data_t *data) {
  uint16_t x, y;
  if (lcd.getTouch(&x, &y)) {
    data->point.x = x; data->point.y = y; data->state = LV_INDEV_STATE_PRESSED;
    lcd.setBrightness(200); dimAt = millis() + 60000;
  } else data->state = LV_INDEV_STATE_RELEASED;
}
#endif

static constexpr uint8_t awakeBrightness = 220;

static void wake() {
  lcd.setBrightness(awakeBrightness);
  dimAt = millis() + 60000;
}

#ifdef AGENTREMINDER_PASSPORT
static void updatePassportReadingScroll(uint32_t now) {
  if (!passportScrollArea || approvals.empty() || int32_t(now - passportScrollAt) < 0) return;
  const int32_t remaining = lv_obj_get_scroll_bottom(passportScrollArea);
  if (remaining > 0) {
    lv_obj_scroll_by_bounded(passportScrollArea, 0, -std::min<int32_t>(2, remaining), LV_ANIM_OFF);
    passportScrollAt = now + (remaining <= 2 ? 3000 : 65);
  } else {
    if (lv_obj_get_scroll_y(passportScrollArea) > 0) lv_obj_scroll_to_y(passportScrollArea, 0, LV_ANIM_OFF);
    passportScrollAt = now + 2600;
  }
}
#endif

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

static lv_obj_t *timedMetadata(lv_obj_t *parent, const String &text, const String &time,
                               lv_color_t color, const char *status = nullptr) {
  if (time.isEmpty() && !status) return metaLabel(parent, text, color);
  auto *row = horizontalRow(parent);
  auto *leading = metaLabel(row, text, color);
  lv_obj_set_width(leading, 0);
  lv_obj_set_flex_grow(leading, 1);
  if (!time.isEmpty()) {
    auto *timestamp = metaLabel(row, time, color);
    lv_obj_set_width(timestamp, LV_SIZE_CONTENT);
    if (compactScreen) lv_obj_set_style_text_font(timestamp, &lv_font_montserrat_16, 0);
  }
  if (status) lv_obj_set_width(metaLabel(row, status, color), LV_SIZE_CONTENT);
  if (compactScreen) {
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  }
  return leading;
}

static void cardMetadata(lv_obj_t *parent, const Item &item, bool scroll) {
  if (item.host.isEmpty()) return;
  auto color = lv_color_hex(0xC5C5C5);
  auto *host = scroll || compactScreen ? metaLabel(parent, "主机 " + item.host, color)
    : timedMetadata(parent, "主机 " + item.host, item.receivedTime, color);
  auto *project = metaLabel(parent, "项目 " + item.project, color);
  if (scroll || compactScreen) {
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

#ifndef AGENTREMINDER_PASSPORT
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
#else
static lv_obj_t *passportCardBody() {
  auto *body = lv_obj_create(content);
  lv_obj_remove_style_all(body);
  if (lcd.landscape()) {
    const int cueOffset = passportCueDepth + passportCueGap;
    lv_obj_set_width(body, lv_pct(100));
    // The cue strip is positioned outside flex layout, so reserve its height here.
    lv_obj_set_height(body, lcd.height() - 2 * passportScreenPadding - cueOffset);
    lv_obj_set_style_margin_top(body, cueOffset, 0);
  } else {
    lv_obj_set_width(body, lcd.width() - 2 * passportScreenPadding - passportCueDepth - passportCueGap);
    lv_obj_set_flex_grow(body, 1);
  }
  lv_obj_set_flex_flow(body, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(body, 4, 0);
  lv_obj_remove_flag(body, LV_OBJ_FLAG_SCROLLABLE);
  return body;
}

static void passportKeyCue(PassportKey key, const char *text, uint32_t color, bool enabled = true) {
  // Offsets along the button edge, measured from the top of the portrait panel.
  int center;
  switch (key) {
    case PassportKey::top: center = 56; break;
    case PassportKey::middle: center = 160; break;
    case PassportKey::bottom: center = 272; break;
    default: return;
  }
  auto *cue = lv_obj_create(content);
  lv_obj_remove_style_all(cue);
  lv_obj_add_flag(cue, LV_OBJ_FLAG_IGNORE_LAYOUT);
  lv_obj_remove_flag(cue, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_remove_flag(cue, LV_OBJ_FLAG_SCROLLABLE);
  const bool landscape = lcd.landscape();
  const int span = landscape ? passportLandscapeCueSpan : passportPortraitCueSpan;
  const int w = landscape ? span : passportCueDepth;
  const int h = landscape ? passportCueDepth : span;
  const int start = center - passportScreenPadding - span / 2;
  lv_obj_set_size(cue, w, h);
  if (landscape) lv_obj_align(cue, LV_ALIGN_TOP_LEFT, start, 0);
  else lv_obj_align(cue, LV_ALIGN_TOP_RIGHT, 0, start);
  lv_obj_set_style_bg_opa(cue, LV_OPA_COVER, 0);
  lv_obj_set_style_bg_color(cue, lv_color_hex(enabled ? color : 0x212121), 0);
  lv_obj_set_style_radius(cue, 5, 0);
  lv_obj_set_style_border_side(cue, landscape ? LV_BORDER_SIDE_TOP : LV_BORDER_SIDE_RIGHT, 0);
  lv_obj_set_style_border_width(cue, 3, 0);
  lv_obj_set_style_border_color(cue, lv_color_hex(enabled ? 0xD5D5D5 : 0x383838), 0);

  String captionText;
  if (landscape) captionText = text;
  else {
    for (const char *glyph = text; *glyph;) {
      const char *next = glyph + 1;
      while ((static_cast<uint8_t>(*next) & 0xC0) == 0x80) ++next;
      if (glyph != text) captionText += '\n';
      captionText.concat(glyph, next - glyph);
      glyph = next;
    }
  }
  auto *caption = metaLabel(cue, captionText, lv_color_hex(enabled ? 0xFFFFFF : 0x919191));
  lv_obj_set_width(caption, w - (landscape ? 4 : 8));
  lv_obj_set_style_text_align(caption, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_center(caption);
}
#endif

/* ---------------- screens ---------------- */

#ifdef AGENTREMINDER_PASSPORT
static const char *passportSoundText() {
  return notification_sound_enabled() ? "提示音：开" : "提示音：关";
}

static void buildPassportLandscapeIdle(lv_obj_t *body, const String &host) {
  lv_obj_set_flex_align(body, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_top(body, 8, 0);
  lv_obj_set_style_pad_row(body, 9, 0);
  auto *title = label(body, host.isEmpty() ? String("未连接主机") : host, lv_color_white());
  lv_obj_set_style_text_font(title, &passportHostFont, 0);
  lv_obj_set_style_pad_hor(title, 8, 0);
  lv_label_set_long_mode(title, LV_LABEL_LONG_SCROLL_CIRCULAR);

  auto *links = horizontalRow(body);
  for (const auto &connection : connections) {
    if (connection.channel != CH_BLE && connection.channel != CH_USB) continue;
    auto *tile = lv_obj_create(links);
    lv_obj_remove_style_all(tile);
    lv_obj_remove_flag(tile, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(tile, 0, LV_SIZE_CONTENT);
    lv_obj_set_flex_grow(tile, 1);
    lv_obj_set_flex_flow(tile, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_ver(tile, 10, 0);
    lv_obj_set_style_pad_hor(tile, 5, 0);
    lv_obj_set_style_pad_row(tile, 3, 0);
    lv_obj_set_style_radius(tile, 8, 0);
    lv_obj_set_style_bg_opa(tile, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(tile, lv_color_hex(0x242424), 0);

    const String text = String(connection.name) + (connection.active ? "已连接" : "未连接");
    auto *state = metaLabel(tile, text, lv_color_hex(connection.active ? 0x64DEAD : 0xB5B5B5));
    lv_obj_set_style_text_align(state, LV_TEXT_ALIGN_CENTER, 0);
    if (connection.active && connection.host != host) {
      auto *otherHost = metaLabel(tile, connection.host, lv_color_hex(0xD5D5D5));
      lv_obj_set_style_text_align(otherHost, LV_TEXT_ALIGN_CENTER, 0);
      lv_label_set_long_mode(otherHost, LV_LABEL_LONG_SCROLL_CIRCULAR);
    }
  }

  auto *sound = metaLabel(body, passportSoundText(), lv_color_hex(0xD5D5D5));
  lv_obj_set_style_pad_left(sound, 8, 0);
  lv_obj_set_style_text_align(sound, LV_TEXT_ALIGN_LEFT, 0);

  passportKeyCue(PassportKey::middle, "横竖屏", 0x363636);
  passportKeyCue(PassportKey::bottom, "提示音", 0x363636);
}
#endif

static void buildIdle() {
  lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);
#ifdef AGENTREMINDER_PASSPORT
  auto *body = passportCardBody();
#else
  auto *body = content;
#endif
  lv_obj_set_flex_align(body, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  String host;
  for (const auto &connection : connections) {
    if (connection.active) { host = connection.host; break; }
  }
#ifdef AGENTREMINDER_PASSPORT
  if (lcd.landscape()) {
    buildPassportLandscapeIdle(body, host);
    return;
  }
#endif
  auto *title = label(body, host.isEmpty() ? String("未连接主机") : host, lv_color_white());
  lv_obj_set_style_text_align(title, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_margin_bottom(title, 12, 0);
  for (const auto &connection : connections) {
    if (!connection.active && connection.channel != CH_BLE) continue;
    String text = String(connection.name) + (connection.active ? "已连接" : "未连接");
    if (connection.active && connection.host != host) text += " · " + connection.host;
    auto *state = metaLabel(body, text, lv_color_hex(connection.active ? 0x64DEAD : 0xB5B5B5));
    lv_obj_set_style_text_align(state, LV_TEXT_ALIGN_CENTER, 0);
  }
#ifdef AGENTREMINDER_PASSPORT
  auto *sound = metaLabel(body, passportSoundText(), lv_color_hex(0xD5D5D5));
  lv_obj_set_style_margin_top(sound, 8, 0);
  lv_obj_set_style_text_align(sound, LV_TEXT_ALIGN_CENTER, 0);
  auto *hint = metaLabel(body, "长按切换", lv_color_hex(0xB5B5B5));
  lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
  passportKeyCue(PassportKey::middle, "横竖屏", 0x363636);
  passportKeyCue(PassportKey::bottom, "提示音", 0x363636);
#endif
}

static void updateApprovalCount() {
  const bool hasInput = std::any_of(approvals.begin(), approvals.end(), [](const Item &item) { return item.interaction; });
  const unsigned count = static_cast<unsigned>(approvals.size());
#ifdef AGENTREMINDER_PASSPORT
  lv_label_set_text_fmt(approvalCountLabel, hasInput ? "待办 %u" : "审批 %u", count);
#else
  lv_label_set_text_fmt(approvalCountLabel, hasInput ? "待处理 %u 项" : "待审批 %u 项", count);
#endif
}

static bool hasChoices(const Item &item) { return item.leftChoice.length() && item.rightChoice.length(); }

static lv_obj_t *cardScrollArea(lv_obj_t *parent, int rowGap) {
  auto *area = lv_obj_create(parent);
  lv_obj_remove_style_all(area);
  lv_obj_set_width(area, lv_pct(100));
  lv_obj_set_flex_grow(area, 1);
  lv_obj_set_flex_flow(area, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(area, rowGap, 0);
  lv_obj_add_flag(area, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_scroll_dir(area, LV_DIR_VER);
  return area;
}

static void buildApproval() {
  const Item &it = approvals.front();
  Serial.printf("{\"t\":\"log\",\"msg\":\"render approval %s\"}\n", it.id.c_str());
  lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);
#ifdef AGENTREMINDER_PASSPORT
  auto *body = passportCardBody();
#else
  auto *body = content;
#endif
  approvalCountLabel = timedMetadata(body, "", it.receivedTime, lv_color_hex(0xC5C5C5));
  updateApprovalCount();

  auto *summary = cardScrollArea(body, compactScreen ? 6 : 16);
#ifdef AGENTREMINDER_PASSPORT
  passportScrollArea = summary;
  passportScrollAt = millis() + 2600;
#endif

  label(summary, it.reason.length() ? it.reason : it.title, lv_color_hex(0xFFD369));
#ifdef AGENTREMINDER_PASSPORT
  if (it.interaction && hasChoices(it)) {
    const String first = "1. " + it.leftChoice;
    const String second = "2. " + it.rightChoice;
    for (const auto &choice : {first, second}) {
      if (it.reason.indexOf("\n" + choice) < 0) label(summary, choice, lv_color_hex(0xFFD369));
    }
  }
#endif
  if (it.conversation.length()) label(summary, it.conversation, lv_color_white());
  cardMetadata(body, it, true);

#ifdef AGENTREMINDER_PASSPORT
  if (!it.interaction) {
    passportKeyCue(PassportKey::top, "拒绝", 0x873329);
    passportKeyCue(PassportKey::middle, "同意", 0x216343);
  } else if (hasChoices(it)) {
    passportKeyCue(PassportKey::top, "第一项", 0x365578);
    passportKeyCue(PassportKey::middle, "第二项", 0x365578);
  } else {
    passportKeyCue(PassportKey::top, "向上", 0x363636);
    passportKeyCue(PassportKey::middle, "向下", 0x363636);
  }
  passportKeyCue(PassportKey::bottom, "回电脑", 0x454545);
#else
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
#endif
}

static void buildNotes() {
  lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);
#ifdef AGENTREMINDER_PASSPORT
  selectedNote = std::min(selectedNote, notes.size() - 1);
  const size_t start = selectedNote, end = selectedNote + 1;
  char page[24];
  snprintf(page, sizeof(page), "%u / %u", unsigned(selectedNote + 1), unsigned(notes.size()));
  auto *pane = passportCardBody();
  timedMetadata(pane, page, notes[selectedNote].receivedTime, lv_color_hex(0xB5B5B5),
                lcd.landscape() ? passportSoundText() : nullptr);
  auto *body = cardScrollArea(pane, 4);
  passportScrollArea = body;
  passportKeyCue(PassportKey::top, "上一张", 0x363636, selectedNote > 0);
  passportKeyCue(PassportKey::middle, "下一张", 0x363636, selectedNote + 1 < notes.size());
  passportKeyCue(PassportKey::bottom, "清除", 0x454545);
#else
  auto *body = content;
  const size_t start = 0, end = notes.size();
  if (std::any_of(notes.begin(), notes.end(), [](const Item &note) { return note.completed; })) {
    auto *hint = label(content, "单击任务可清除", lv_color_hex(0xB5B5B5));
    lv_obj_set_style_text_font(hint, &agentreminder_hint_22, 0);
  }
#endif
  for (size_t i = start; i < end; i++) {
    const Item &n = notes[i];
    lv_obj_t *card = lv_obj_create(body);
    lv_obj_set_size(card, lv_pct(100), LV_SIZE_CONTENT);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x1E1E1E), 0);
    lv_obj_set_style_border_side(card, LV_BORDER_SIDE_LEFT, 0);
    lv_obj_set_style_border_color(card, agentColor(n.agent), 0);
    lv_obj_set_style_border_width(card, 4, 0);
    lv_obj_set_style_pad_all(card, 6, 0);
    lv_obj_set_flex_flow(card, LV_FLEX_FLOW_COLUMN);
#ifndef AGENTREMINDER_PASSPORT
    lv_obj_add_event_cb(card, onDismiss, LV_EVENT_CLICKED, (void *)(uintptr_t)i);
#endif
    label(card, n.title, lv_color_white());
    if (n.interaction && n.reason.length()) label(card, n.reason, lv_color_white());
    if (n.conversation.length()) label(card, n.conversation, lv_color_hex(0xD2D2D2));
    cardMetadata(card, n, false);
    if (n.interaction) metaLabel(card, "请在电脑上继续", lv_color_hex(0xC5C5C5));
  }
}

static void rebuild(bool force = false) {
  if (!force && approvalCountLabel && !approvals.empty() && displayedApprovalId == approvals.front().id) {
    // A change behind the visible card should not reset its scroll position.
    updateApprovalCount();
    dirty = false;
    return;
  }
  approvalCountLabel = nullptr;
#ifdef AGENTREMINDER_PASSPORT
  passportScrollArea = nullptr;
  passportKeys.reset();
#endif
  displayedApprovalId = approvals.empty() ? String() : approvals.front().id;
  lv_obj_clean(content);
  lv_obj_set_flex_align(content, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
  if (approvals.empty() && notes.empty()) {
    lv_obj_remove_flag(content, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_scroll_to_y(content, 0, LV_ANIM_OFF);
    buildIdle();
  } else if (approvals.empty()) {
    if (compactScreen) lv_obj_remove_flag(content, LV_OBJ_FLAG_SCROLLABLE);
    else lv_obj_add_flag(content, LV_OBJ_FLAG_SCROLLABLE);
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
#ifndef AGENTREMINDER_PASSPORT
  denyKey.init(); allowKey.init();
#endif
  notification_sound_init();
  lcd.init();
#ifdef AGENTREMINDER_PASSPORT
  Preferences prefs;
  if (prefs.begin("ar", true)) {
    lcd.setLandscape(prefs.getBool("landscape", false));
    prefs.end();
  }
#endif
  wake();
  lv_init();
  lv_tick_set_cb([]() -> uint32_t { return millis(); });
#ifdef AGENTREMINDER_PASSPORT
  fontCn = agentreminder_passport_24;
  fontCn.fallback = &lv_font_montserrat_16;
  fontCn.line_height = 29;
  fontCn.base_line = 7;
  fontMeta = fontCn;
  fontMeta.line_height = 27;
  passportHostFont = lv_font_montserrat_28;
  passportHostFont.fallback = FONT;
  passportHostFont.line_height = 36;
#else
  fontCn = agentreminder_cjk_35;
  fontCn.fallback = &lv_font_montserrat_28;
  fontCn.line_height = 45;
  fontCn.base_line = 10;
  fontMeta = agentreminder_meta_24;
  fontMeta.fallback = FONT;
  fontMeta.line_height = 36;
#endif
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
  const size_t bufSz = std::max(w, h) * stripRows * sizeof(uint16_t);
  void *drawPixels = heap_caps_malloc(bufSz, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  if (!drawPixels) { Serial.println("LVGL buffer allocation failed"); abort(); }
  lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);
#ifndef AGENTREMINDER_PASSPORT
  // CO5300 requires even start coordinates and even pixel dimensions.
  lv_display_add_event_cb(disp, [](lv_event_t *event) {
    auto *area = (lv_area_t *)lv_event_get_param(event);
    area->x1 &= ~1; area->y1 &= ~1; area->x2 |= 1; area->y2 |= 1;
  }, LV_EVENT_INVALIDATE_AREA, nullptr);
#endif
  lv_display_set_buffers(disp, drawPixels, nullptr, bufSz, LV_DISPLAY_RENDER_MODE_PARTIAL);
  lv_display_set_flush_cb(disp, flush_cb);
#ifndef AGENTREMINDER_PASSPORT
  lv_indev_t *in = lv_indev_create();
  lv_indev_set_type(in, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(in, touch_cb);
#endif

  lv_obj_t *scr = lv_screen_active();
  lv_obj_set_style_bg_color(scr, lv_color_hex(0x111111), 0);
  lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
#ifdef AGENTREMINDER_PASSPORT
  lv_obj_set_style_pad_all(scr, passportScreenPadding, 0);
#else
  lv_obj_set_style_pad_all(scr, 20, 0);
#endif
  lv_obj_set_style_pad_row(scr, 6, 0);

  content = lv_obj_create(scr);
  lv_obj_remove_style_all(content);
  lv_obj_set_width(content, lv_pct(100));
  lv_obj_set_flex_grow(content, 1);
  lv_obj_set_style_pad_row(content, compactScreen ? 4 : 8, 0);
  lv_obj_add_flag(content, LV_OBJ_FLAG_SCROLLABLE);


  rebuild();
}

#ifdef AGENTREMINDER_PASSPORT
bool ui_passport_landscape() { return lcd.landscape(); }

static void togglePassportOrientation() {
  lcd.setLandscape(!lcd.landscape());
  lv_display_set_resolution(disp, lcd.width(), lcd.height());
  // Recreate the cues for the current card and re-arm the key after release.
  rebuild(true);

  Preferences prefs;
  bool saved = false;
  if (prefs.begin("ar", false)) {
    saved = prefs.putBool("landscape", lcd.landscape()) == sizeof(bool);
    prefs.end();
  }
  Serial.printf("{\"t\":\"log\",\"msg\":\"Passport display %s%s\"}\n",
                lcd.landscape() ? "landscape" : "portrait", saved ? "" : " (not saved)");
}

static void scrollPassportText(int distance, uint32_t now, bool wrap = false) {
  if (!passportScrollArea) return;
  if (wrap && lv_obj_get_scroll_bottom(passportScrollArea) <= 0)
    lv_obj_scroll_to_y(passportScrollArea, 0, LV_ANIM_OFF);
  else
    lv_obj_scroll_by_bounded(passportScrollArea, 0, distance, LV_ANIM_OFF);
  passportScrollAt = now + 5500;
}

static void togglePassportSound(uint32_t now) {
  const bool saved = notification_sound_toggle();
  dirty = true;
  if (notes.empty() && saved) return;
  if (passportSoundStatus) lv_obj_delete(passportSoundStatus);
  String text = passportSoundText();
  if (!saved) text += "（本次有效）";
  passportSoundStatus = metaLabel(lv_layer_top(), text, lv_color_white());
  lv_obj_set_width(passportSoundStatus, LV_SIZE_CONTENT);
  lv_obj_set_style_pad_all(passportSoundStatus, 5, 0);
  lv_obj_set_style_bg_color(passportSoundStatus, lv_color_hex(0x383838), 0);
  lv_obj_set_style_bg_opa(passportSoundStatus, LV_OPA_COVER, 0);
  lv_obj_align(passportSoundStatus, LV_ALIGN_BOTTOM_MID, 0, -8);
  passportSoundStatusUntil = now + 1800;
}

static void pollPassportKeys(uint32_t now) {
  const String head = approvals.empty() ? String() : approvals.front().id;
  if (displayedApprovalId != head) return;
  const PassportKeyEvent event = passportKeys.poll(lcd.readKeyMillivolts(), now);
  if (event.key == PassportKey::released) return;
  wake();
  if (event.held) {
    if (event.key == PassportKey::middle) togglePassportOrientation();
    else if (event.key == PassportKey::bottom && approvals.empty()) togglePassportSound(now);
    else if (event.key == PassportKey::top) scrollPassportText(-54, now, !event.repeat);
    return;
  }
  if (!approvals.empty()) {
    const auto &item = approvals.front();
    if (event.key == PassportKey::bottom) decide("skip");
    else if (!item.interaction || hasChoices(item)) decide(event.key == PassportKey::top ? "deny" : "allow");
    else scrollPassportText(event.key == PassportKey::top ? 54 : -54, now);
  } else if (!notes.empty() && selectedNote < notes.size()) {
    if (event.key == PassportKey::bottom) notes.erase(notes.begin() + selectedNote);
    else if (event.key == PassportKey::top && selectedNote > 0) --selectedNote;
    else if (event.key == PassportKey::middle && selectedNote + 1 < notes.size()) ++selectedNote;
    else return;
    dirty = true;
  }
}
#endif

void ui_loop() {
  const uint32_t now = millis();
  for (size_t i = 0; i < approvals.size();) {
    if ((uint32_t)(now - approvals[i].at) >= approvals[i].timeoutMs) {
      approvals.erase(approvals.begin() + i); dirty = true;
    } else ++i;
  }
#ifdef AGENTREMINDER_PASSPORT
  pollPassportKeys(now);
  if (passportSoundStatus && int32_t(now - passportSoundStatusUntil) >= 0) {
    lv_obj_delete(passportSoundStatus);
    passportSoundStatus = nullptr;
  }
#else
  const String activeId = approvals.empty() || (approvals.front().interaction && !hasChoices(approvals.front()))
    ? "" : approvals.front().id;
  const bool denied = denyKey.poll(activeId), allowed = allowKey.poll(activeId);
  const bool handoff = lcd.pollPowerKey();
  if (handoff && !approvals.empty()) {
    Serial.printf("{\"t\":\"log\",\"msg\":\"approval %s physical PWR -> skip\"}\n", approvals.front().id.c_str());
    decide("skip");
  } else if (denied) decide("deny", BUTTON_DENY_PIN);
  else if (allowed) decide("allow", BUTTON_ALLOW_PIN);
#endif
  if (dirty) rebuild();
  if (dimAt && millis() > dimAt && approvals.empty()) { lcd.setBrightness(30); dimAt = 0; }
  lv_timer_handler();
#ifdef AGENTREMINDER_PASSPORT
  updatePassportReadingScroll(now);
#endif
}

void ui_add_approval(const Item &it, bool audible) {
  for (auto &a : approvals) if (a.id == it.id) { a.channels |= it.channels; return; }
  approvals.push_back(it);
  wake(); dirty = true;
  if (audible) notification_sound_notify();
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
#ifdef AGENTREMINDER_PASSPORT
  selectedNote = 0;
#endif
  notification_sound_notify();
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
