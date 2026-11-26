#pragma once

#include <Arduino.h>
#include <SPI.h>
#include <driver/adc.h>
#include <esp_adc_cal.h>

// Pin mapping, ADC voltage windows and ST7789P3 settings:
// https://github.com/FoloToy/ai-passport/tree/main/components/bsp
class BoardDisplay {
  static constexpr int lcdSclk = 8, lcdMosi = 9, lcdCs = 1, lcdDc = 20, lcdBl = 21;
  static constexpr int backlight = 0;
  static constexpr adc1_channel_t keyChannel = ADC1_CHANNEL_0;
  static constexpr adc_atten_t keyAttenuation = ADC_ATTEN_DB_12;
  static constexpr adc_bits_width_t keyWidth = ADC_WIDTH_BIT_12;
  esp_adc_cal_characteristics_t keyCalibration{};
  bool keysReady = false;
  bool landscapeMode = false;

  static void beginTransfer() {
    SPI.beginTransaction(SPISettings(40000000, MSBFIRST, SPI_MODE0));
    digitalWrite(lcdCs, LOW);
  }

  static void command(uint8_t cmd, const uint8_t *args = nullptr, size_t length = 0) {
    digitalWrite(lcdDc, LOW);
    SPI.write(cmd);
    digitalWrite(lcdDc, HIGH);
    if (length) SPI.writeBytes(args, length);
  }

  static void endTransfer() {
    digitalWrite(lcdCs, HIGH);
    SPI.endTransaction();
  }

public:
  int width() const { return landscapeMode ? 320 : 240; }
  int height() const { return landscapeMode ? 240 : 320; }
  bool landscape() const { return landscapeMode; }

  void setLandscape(bool enabled) {
    if (landscapeMode == enabled) return;
    // ST7789P3 MADCTL MV|MX puts the portrait right edge at the top, with
    // the three side buttons in their original order from left to right.
    const uint8_t madctl = enabled ? 0x60 : 0x00;
    beginTransfer();
    command(0x36, &madctl, sizeof(madctl));
    endTransfer();
    landscapeMode = enabled;
  }

  void init() {
    pinMode(lcdCs, OUTPUT);
    pinMode(lcdDc, OUTPUT);
    digitalWrite(lcdCs, HIGH);
    SPI.begin(lcdSclk, -1, lcdMosi, lcdCs);
    ledcSetup(backlight, 5000, 8);
    ledcAttachPin(lcdBl, backlight);
    setBrightness(0);

    beginTransfer();
    command(0x01); // Software reset (there is no reset GPIO).
    endTransfer();
    delay(150);
    beginTransfer();
    command(0x11);
    endTransfer();
    delay(120);

    // Panel-specific RGB565, porch, power and gamma registers from the Passport BSP.
    static constexpr struct {
      uint8_t code, length, data[14];
    } setup[] = {
      {0x36, 1, {0x00}}, {0x3A, 1, {0x55}}, {0xB2, 5, {0x05, 0x05, 0, 0x33, 0x33}},
      {0xB7, 1, {0x35}}, {0xBB, 1, {0x21}}, {0xC0, 1, {0x2C}}, {0xC2, 1, {0x01}},
      {0xC3, 1, {0x0B}}, {0xC4, 1, {0x20}}, {0xC6, 1, {0x0F}}, {0xD0, 2, {0xA4, 0xA1}},
      {0xD6, 1, {0xA1}},
      {0xE0, 14, {0xD0, 0x04, 0x08, 0x0A, 0x09, 0x05, 0x2D, 0x43, 0x49, 0x09, 0x16, 0x15, 0x26, 0x2B}},
      {0xE1, 14, {0xD0, 0x03, 0x09, 0x0A, 0x0A, 0x06, 0x2E, 0x44, 0x40, 0x3A, 0x15, 0x15, 0x26, 0x2A}},
    };
    beginTransfer();
    for (const auto &entry : setup) command(entry.code, entry.data, entry.length);
    endTransfer();
    delay(10);
    beginTransfer();
    command(0x21); // The Passport ST7789P3 panel requires inversion.
    command(0x29);
    endTransfer();

    keysReady = adc1_config_width(keyWidth) == ESP_OK &&
      adc1_config_channel_atten(keyChannel, keyAttenuation) == ESP_OK;
    if (keysReady) esp_adc_cal_characterize(ADC_UNIT_1, keyAttenuation, keyWidth, 1100, &keyCalibration);
  }

  int readKeyMillivolts() const {
    if (!keysReady) return -1;
    int total = 0;
    for (int n = 0; n < 3; n++) {
      const int raw = adc1_get_raw(keyChannel);
      if (raw < 0) return -1;
      total += raw;
    }
    return esp_adc_cal_raw_to_voltage(total / 3, &keyCalibration);
  }

  void setBrightness(uint8_t value) { ledcWrite(backlight, value); }

  void draw(int x, int y, int w, int h, uint16_t *pixels) {
    const int right = x + w - 1, bottom = y + h - 1;
    const uint8_t cols[] = {uint8_t(x >> 8), uint8_t(x), uint8_t(right >> 8), uint8_t(right)};
    const uint8_t rows[] = {uint8_t(y >> 8), uint8_t(y), uint8_t(bottom >> 8), uint8_t(bottom)};
    beginTransfer();
    command(0x2A, cols, sizeof(cols));
    command(0x2B, rows, sizeof(rows));
    command(0x2C);
    // Arduino's writePixels converts native RGB565 words to panel byte order.
    SPI.writePixels(pixels, w * h * sizeof(uint16_t));
    endTransfer();
  }
};
