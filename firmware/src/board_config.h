#pragma once
// Official Waveshare 05_LVGL_Widgets pin map and panel orientation:
// https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-2.16
#include <Arduino.h>
#include <Wire.h>
#include <databus/Arduino_ESP32QSPI.h>
#include <display/Arduino_CO5300.h>
#include <touch/TouchDrvCST92xx.h>

#define TFT_W 480
#define TFT_H 480
#define TP_INT 11
#define TP_RST 40
#define TP_SDA 15
#define TP_SCL 14
#define BUTTON_DENY_PIN 18   // left +/KEY
#define BUTTON_ALLOW_PIN 0   // right BOOT/-

static volatile bool boardTouchPending = false;
static void IRAM_ATTR boardTouchInterrupt() { boardTouchPending = true; }

class BoardDisplay {
  Arduino_ESP32QSPI bus{12, 38, 4, 5, 6, 7};
  Arduino_CO5300 panel{&bus, 39, 0, TFT_W, TFT_H, 0, 0, 0, 0};
  TouchDrvCST92xx touch;
  bool touchReady = false, pressed = false;
  uint16_t lastX = 0, lastY = 0;
public:
  void init() {
    touch.setPins(TP_RST, TP_INT);
    touchReady = touch.begin(Wire, CST92XX_SLAVE_ADDRESS, TP_SDA, TP_SCL);
    if (touchReady) {
      touch.setMaxCoordinates(TFT_W, TFT_H);
      touch.setSwapXY(true);
      touch.setMirrorXY(true, false);
    }
    pinMode(TP_INT, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(TP_INT), boardTouchInterrupt, FALLING);
    Serial.printf("{\"t\":\"log\",\"msg\":\"CST9220 touch %s\"}\n", touchReady ? "ready" : "FAILED");
    bool ok = panel.begin();
    bus.writeC8D8(0x36, 0xA0);
    Serial.printf("{\"t\":\"log\",\"msg\":\"CO5300 display %s\"}\n", ok ? "ready" : "FAILED");
  }
  int width() { return TFT_W; }
  int height() { return TFT_H; }
  void setBrightness(uint8_t value) { panel.setBrightness(value); }
  void draw(int x, int y, int w, int h, uint16_t *pixels) {
    panel.draw16bitRGBBitmap(x, y, pixels, w, h);
  }
  bool getTouch(uint16_t *x, uint16_t *y) {
    if (!touchReady) return false;
    noInterrupts();
    const bool pending = boardTouchPending;
    boardTouchPending = false;
    interrupts();
    if (pending) {
      int16_t xs[5], ys[5];
      pressed = touch.getPoint(xs, ys, 5) > 0;
      if (pressed) { lastX = xs[0]; lastY = ys[0]; }
    }
    *x = lastX; *y = lastY;
    return pressed && *x < TFT_W && *y < TFT_H;
  }
};
