// LVGL UI: approval card with 拒绝 / 终端 / 同意, otherwise a list of recent notifications.
#include "ui.h"
#include "board_config.h"
#include <lvgl.h>
#include <vector>
#include <cstring>
#include <esp_heap_caps.h>

static BoardDisplay lcd;
static lv_display_t *disp;
static constexpr int displayScale = 2;
static constexpr int stripRows = 16;
static uint16_t *scaledPixels;
static std::vector<Item> approvals;   // oldest first
static std::vector<Item> notes;       // newest first, max 20
static lv_obj_t *content;
static bool dirty = true;
static uint32_t dimAt = 0;

LV_FONT_DECLARE(agentreminder_cjk_26);
static lv_font_t fontCn;
static bool fontReady = false;
bool ui_font_ok() { return fontReady; }
#define FONT (&fontCn)

/* ---------------- display / touch glue ---------------- */

static void flush_cb(lv_display_t *d, const lv_area_t *a, uint8_t *px) {
  const int width = lv_area_get_width(a);
  const int height = lv_area_get_height(a);
  const int outWidth = width * displayScale;
  const auto stride = lv_draw_buf_width_to_stride(width, LV_COLOR_FORMAT_RGB565);
  // Scaling by two also meets CO5300's even-coordinate and even-size requirement.
  for (int top = 0; top < height; top += stripRows) {
    const int rows = min(stripRows, height - top);
    for (int row = 0; row < rows; ++row) {
      const auto *src = reinterpret_cast<const uint16_t *>(px + (top + row) * stride);
      auto *dst = scaledPixels + row * displayScale * outWidth;
      for (int x = 0; x < width; ++x) {
        dst[x * displayScale] = src[x];
        dst[x * displayScale + 1] = src[x];
      }
      std::memcpy(dst + outWidth, dst, outWidth * sizeof(uint16_t));
    }
    lcd.draw(a->x1 * displayScale, (a->y1 + top) * displayScale,
             outWidth, rows * displayScale, scaledPixels);
  }
  lv_display_flush_ready(d);
}

static void touch_cb(lv_indev_t *, lv_indev_data_t *data) {
  uint16_t x, y;
  if (lcd.getTouch(&x, &y)) {
    data->point.x = x / displayScale; data->point.y = y / displayScale; data->state = LV_INDEV_STATE_PRESSED;
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

static lv_obj_t *button(lv_obj_t *parent, const char *txt, uint32_t color, const char *decision) {
  lv_obj_t *b = lv_button_create(parent);
  lv_obj_set_width(b, 0);
  lv_obj_set_flex_grow(b, 1);
  lv_obj_set_height(b, 46);
  lv_obj_set_style_pad_all(b, 0, 0);
  lv_obj_set_style_bg_color(b, lv_color_hex(color), 0);
  lv_obj_set_style_radius(b, 5, 0);
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

  lv_obj_t *summary = lv_obj_create(content);
  lv_obj_remove_style_all(summary);
  lv_obj_set_width(summary, lv_pct(100));
  lv_obj_set_flex_grow(summary, 1);
  lv_obj_set_flex_flow(summary, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(summary, 9, 0);
  lv_obj_add_flag(summary, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_scroll_dir(summary, LV_DIR_VER);

  label(summary, it.reason.length() ? it.reason : it.title, lv_color_hex(0xFFD369));
  if (it.conversation.length()) label(summary, it.conversation, lv_color_white());

  lv_obj_t *btns = lv_obj_create(content);
  lv_obj_remove_style_all(btns);
  lv_obj_set_size(btns, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(btns, LV_FLEX_FLOW_ROW);
  lv_obj_set_style_pad_column(btns, 4, 0);
  button(btns, "拒绝", 0xC0392B, "deny");
  button(btns, "终端", 0x555555, "skip");
  button(btns, "同意", 0x27AE60, "allow");
}

static void buildNotes() {
  lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);
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
    if (n.conversation.length()) label(card, n.conversation, lv_color_hex(0xD2D2D2));
  }
}

static void rebuild() {
  lv_obj_clean(content);
  if (approvals.empty()) {
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
  fontCn = agentreminder_cjk_26;
  fontCn.fallback = &lv_font_montserrat_22;
  fontCn.line_height = 34;
  fontCn.base_line = 8;
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
  const int w = lcd.width() / displayScale, h = lcd.height() / displayScale;
  disp = lv_display_create(w, h);
  const uint32_t stride = lv_draw_buf_width_to_stride(w, LV_COLOR_FORMAT_RGB565);
  const size_t bufSz = stride * stripRows;
  void *drawPixels = heap_caps_malloc(bufSz, MALLOC_CAP_INTERNAL);
  scaledPixels = static_cast<uint16_t *>(heap_caps_malloc(
    lcd.width() * stripRows * displayScale * sizeof(uint16_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
  if (!drawPixels || !scaledPixels) { Serial.println("LVGL buffer allocation failed"); abort(); }
  lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);
  lv_display_set_buffers(disp, drawPixels, nullptr, bufSz, LV_DISPLAY_RENDER_MODE_PARTIAL);
  lv_display_set_flush_cb(disp, flush_cb);
  lv_indev_t *in = lv_indev_create();
  lv_indev_set_type(in, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(in, touch_cb);

  lv_obj_t *scr = lv_screen_active();
  lv_obj_set_style_bg_color(scr, lv_color_hex(0x111111), 0);
  lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_all(scr, 10, 0);
  lv_obj_set_style_pad_row(scr, 6, 0);

  content = lv_obj_create(scr);
  lv_obj_remove_style_all(content);
  lv_obj_set_width(content, lv_pct(100));
  lv_obj_set_flex_grow(content, 1);
  lv_obj_set_style_pad_row(content, 4, 0);
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
  const String activeId = approvals.empty() ? "" : approvals.front().id;
  const bool denied = denyKey.poll(activeId), allowed = allowKey.poll(activeId);
  if (denied) decide("deny", BUTTON_DENY_PIN);
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

void ui_add_notify(const Item &it) {
  for (auto &n : notes) if (n.id == it.id) return;
  notes.insert(notes.begin(), it);
  if (notes.size() > 20) notes.pop_back();
  wake(); dirty = true;
}

void ui_remove(const String &id) {
  for (size_t i = 0; i < approvals.size(); i++)
    if (approvals[i].id == id) { approvals.erase(approvals.begin() + i); dirty = true; return; }
}
