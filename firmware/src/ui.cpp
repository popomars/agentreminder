// LVGL UI: approval card with 拒绝 / 终端 / 同意, otherwise a list of recent notifications.
#include "ui.h"
#include "board_config.h"
#include <lvgl.h>
#include <vector>
#include <esp_heap_caps.h>

static BoardDisplay lcd;
static lv_display_t *disp;
static std::vector<Item> approvals;   // oldest first
static std::vector<Item> notes;       // newest first, max 20
static lv_obj_t *statusLbl, *content, *toast;
static bool dirty = true;
static uint32_t toastUntil = 0, dimAt = 0;

LV_FONT_DECLARE(agentreminder_cjk_18);
static lv_font_t fontCn;
static bool fontReady = false;
bool ui_font_ok() { return fontReady; }
#define FONT (&fontCn)

/* ---------------- display / touch glue ---------------- */

static void flush_cb(lv_display_t *d, const lv_area_t *a, uint8_t *px) {
  uint32_t w = lv_area_get_width(a), h = lv_area_get_height(a);
  lcd.draw(a->x1, a->y1, w, h, (uint16_t *)px);
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

static lv_obj_t *chip(lv_obj_t *parent, const String &agent) {
  lv_obj_t *c = lv_obj_create(parent);
  lv_obj_remove_style_all(c);
  lv_obj_set_size(c, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(c, agentColor(agent), 0);
  lv_obj_set_style_bg_opa(c, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(c, 6, 0);
  lv_obj_set_style_pad_hor(c, 6, 0); lv_obj_set_style_pad_ver(c, 2, 0);
  label(c, agent, lv_color_white(), false);
  return c;
}

static void decide(const char *decision) {
  if (approvals.empty()) return;
  Item it = approvals.front();
  approvals.erase(approvals.begin());
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

static lv_obj_t *button(lv_obj_t *parent, const char *txt, uint32_t color, const char *decision, int grow) {
  lv_obj_t *b = lv_button_create(parent);
  lv_obj_set_flex_grow(b, grow);
  lv_obj_set_height(b, 66);
  lv_obj_set_style_bg_color(b, lv_color_hex(color), 0);
  lv_obj_set_style_radius(b, 10, 0);
  lv_obj_add_event_cb(b, onDecision, LV_EVENT_CLICKED, (void *)decision);
  lv_obj_t *l = label(b, txt, lv_color_white(), false);
  lv_obj_center(l);
  return b;
}

/* ---------------- screens ---------------- */

static void buildApproval() {
  const Item &it = approvals.front();
  Serial.printf("{\"t\":\"log\",\"msg\":\"render approval %s\"}\n", it.id.c_str());
  lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);

  label(content, it.conversation, lv_color_white());

  lv_obj_t *row = lv_obj_create(content);
  lv_obj_remove_style_all(row);
  lv_obj_set_size(row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
  lv_obj_set_style_pad_column(row, 6, 0);
  lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  chip(row, it.agent);
  String hdr = it.project;
  if (approvals.size() > 1) hdr += "   (1/" + String(approvals.size()) + ")";
  label(row, hdr, lv_color_hex(0xBBBBBB), false);

  label(content, String(LV_SYMBOL_WARNING " 需要审批: ") + it.title, lv_color_hex(0xFFC857));

  lv_obj_t *box = lv_obj_create(content);
  lv_obj_set_width(box, lv_pct(100));
  lv_obj_set_flex_grow(box, 1);
  lv_obj_set_style_bg_color(box, lv_color_hex(0x1E1E1E), 0);
  lv_obj_set_style_border_width(box, 0, 0);
  lv_obj_set_style_pad_all(box, 8, 0);
  label(box, (it.reason.length() ? it.reason + "\n\n" : "") + it.detail, lv_color_hex(0xE6E6E6));

  lv_obj_t *btns = lv_obj_create(content);
  lv_obj_remove_style_all(btns);
  lv_obj_set_size(btns, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(btns, LV_FLEX_FLOW_ROW);
  lv_obj_set_style_pad_column(btns, 8, 0);
  button(btns, "左键 · 拒绝", 0xC0392B, "deny", 2);
  button(btns, "终端", 0x555555, "skip", 1);
  button(btns, "右键 · 同意", 0x27AE60, "allow", 2);
}

static void buildNotes() {
  lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);
  if (notes.empty()) {
    lv_obj_t *l = label(content, LV_SYMBOL_OK "  一切就绪\n等待 agent 消息…", lv_color_hex(0x777777));
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
    return;
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
    const char *icon = n.kind == "done" ? LV_SYMBOL_OK " " : n.kind == "idle" ? LV_SYMBOL_BELL " " : LV_SYMBOL_BELL " ";
    label(card, String(icon) + n.agent + " · " + n.conversation + "  " + n.title, lv_color_white());
    if (n.detail.length()) label(card, n.detail, lv_color_hex(0xAAAAAA));
  }
}

static void rebuild() {
  lv_obj_clean(content);
  if (!approvals.empty()) buildApproval(); else buildNotes();
  dirty = false;
}

static void showToast(const String &txt) {
  lv_label_set_text(lv_obj_get_child(toast, 0), txt.c_str());
  lv_obj_remove_flag(toast, LV_OBJ_FLAG_HIDDEN);
  lv_obj_move_foreground(toast);
  toastUntil = millis() + 3500;
}

/* ---------------- public ---------------- */

void ui_init() {
  denyKey.init(); allowKey.init();
  lcd.init();
  wake();
  lv_init();
  lv_tick_set_cb([]() -> uint32_t { return millis(); });
  fontCn = agentreminder_cjk_18;
  fontCn.fallback = &lv_font_montserrat_16;
  fontCn.line_height = 24;
  fontCn.base_line = 5;
  fontReady = true;
  // Exercise the actual LVGL bitmap decoder, not just font character coverage.
  for (uint32_t cp : {0x41U, 0x5BA1U, 0x6279U, 0x62D2U, 0x7EDDU, 0x00B7U, 0x2192U}) {
    lv_font_glyph_dsc_t glyph{};
    if (!lv_font_get_glyph_dsc(FONT, &glyph, cp, 0) || glyph.is_placeholder) { fontReady = false; break; }
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
  const size_t bufSz = w * 40 * sizeof(uint16_t);
  void *b1 = heap_caps_malloc(bufSz, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  void *b2 = heap_caps_malloc(bufSz, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  if (!b1 || !b2) { Serial.println("LVGL buffer allocation failed"); abort(); }
  lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);
  // CO5300 requires even start coordinates and even pixel dimensions.
  lv_display_add_event_cb(disp, [](lv_event_t *e) {
    auto *a = (lv_area_t *)lv_event_get_param(e);
    a->x1 &= ~1; a->y1 &= ~1; a->x2 |= 1; a->y2 |= 1;
  }, LV_EVENT_INVALIDATE_AREA, nullptr);
  lv_display_set_buffers(disp, b1, b2, bufSz, LV_DISPLAY_RENDER_MODE_PARTIAL);
  lv_display_set_flush_cb(disp, flush_cb);
  lv_indev_t *in = lv_indev_create();
  lv_indev_set_type(in, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(in, touch_cb);

  lv_obj_t *scr = lv_screen_active();
  lv_obj_set_style_bg_color(scr, lv_color_hex(0x111111), 0);
  lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_all(scr, 22, 0);
  lv_obj_set_style_pad_row(scr, 6, 0);

  statusLbl = label(scr, "AgentReminder", lv_color_hex(0x888888));
  lv_obj_set_style_text_font(statusLbl, &lv_font_montserrat_14, 0);

  content = lv_obj_create(scr);
  lv_obj_remove_style_all(content);
  lv_obj_set_width(content, lv_pct(100));
  lv_obj_set_flex_grow(content, 1);
  lv_obj_set_style_pad_row(content, 6, 0);
  lv_obj_add_flag(content, LV_OBJ_FLAG_SCROLLABLE);

  toast = lv_obj_create(lv_layer_top());
  lv_obj_set_size(toast, lv_pct(92), LV_SIZE_CONTENT);
  lv_obj_align(toast, LV_ALIGN_TOP_MID, 0, 30);
  lv_obj_set_style_bg_color(toast, lv_color_hex(0x2D7FF9), 0);
  lv_obj_set_style_border_width(toast, 0, 0);
  label(toast, "", lv_color_white());
  lv_obj_add_flag(toast, LV_OBJ_FLAG_HIDDEN);
  rebuild();
}

void ui_loop() {
  const uint32_t now = millis();
  for (size_t i = 0; i < approvals.size();) {
    if ((uint32_t)(now - approvals[i].at) >= approvals[i].timeoutMs) {
      approvals.erase(approvals.begin() + i); dirty = true;
    } else ++i;
  }
  const String activeId = approvals.empty() ? "" : approvals.front().id;
  const bool denied = denyKey.poll(activeId), allowed = allowKey.poll(activeId);
  if (denied) decide("deny");
  else if (allowed) decide("allow");
  if (dirty) rebuild();
  if (toastUntil && millis() > toastUntil) { lv_obj_add_flag(toast, LV_OBJ_FLAG_HIDDEN); toastUntil = 0; }
  if (dimAt && millis() > dimAt && approvals.empty()) { lcd.setBrightness(30); dimAt = 0; }
  lv_timer_handler();
}

void ui_add_approval(const Item &it) {
  for (auto &a : approvals) if (a.id == it.id) { a.channels |= it.channels; return; }
  approvals.push_back(it);
  wake(); dirty = true;
}

void ui_add_notify(const Item &it) {
  for (auto &n : notes) if (n.id == it.id) return;
  notes.insert(notes.begin(), it);
  if (notes.size() > 20) notes.pop_back();
  wake(); dirty = true;
  if (!approvals.empty()) showToast(it.agent + " · " + it.title);   // don't hide the pending card
}

void ui_remove(const String &id) {
  for (size_t i = 0; i < approvals.size(); i++)
    if (approvals[i].id == id) { approvals.erase(approvals.begin() + i); dirty = true; return; }
}

void ui_set_status(bool usb, bool wifiUp, const String &ip, bool hostWifi) {
  String s = "AgentReminder   ";
  s += usb ? LV_SYMBOL_USB " USB  " : "";
  if (wifiUp) { s += LV_SYMBOL_WIFI " "; s += ip; s += hostWifi ? " " LV_SYMBOL_OK : ""; }
  else s += LV_SYMBOL_WIFI " --";
  lv_label_set_text(statusLbl, s.c_str());
}
