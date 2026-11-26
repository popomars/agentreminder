#include "notification_sound.h"
#include "notification_cooldown.h"

#include <Arduino.h>
#include <Wire.h>
#include <atomic>
#include <cmath>
#include <driver/i2s.h>
#include <nvs.h>

namespace {
constexpr auto audioPort = I2S_NUM_0;
constexpr uint32_t sampleRate = 16000;
constexpr size_t blockFrames = 128;
#ifdef AGENTREMINDER_PASSPORT
constexpr int peakAmplitude = 20000;
constexpr i2s_pin_config_t audioPins{6, 5, 3, 2, I2S_PIN_NO_CHANGE};
constexpr uint8_t volume = 0xB2;
constexpr size_t leadFrames = 0;
constexpr size_t toneCount = 1;
constexpr size_t toneFrames = sampleRate * 72 / 1000;
constexpr size_t gapFrames = 0;
constexpr size_t attackFrames = sampleRate * 3 / 1000;
constexpr size_t releaseFrames = toneFrames;
#else
// Waveshare Touch AMOLED 2.16 audio pins: MCLK, BCLK, LRCK, DAC data.
constexpr i2s_pin_config_t audioPins{42, 9, 45, 8, I2S_PIN_NO_CHANGE};
constexpr int ampEnablePin = 46;  // Active-high PA_CTRL
constexpr uint8_t volume = 0xD0;
constexpr int peakAmplitude = 1500;
// Give the DAC time to settle after unmuting before the first short tone.
constexpr size_t leadFrames = sampleRate * 70 / 1000;
constexpr size_t toneCount = 2;
constexpr size_t toneFrames = sampleRate * 30 / 1000;
constexpr size_t gapFrames = sampleRate * 120 / 1000;
constexpr size_t attackFrames = sampleRate * 5 / 1000;
constexpr size_t releaseFrames = sampleRate * 10 / 1000;
#endif
constexpr size_t cueFrames = leadFrames + toneCount * toneFrames + (toneCount - 1) * gapFrames;
constexpr uint8_t codecAddress = 0x18;
constexpr uint8_t dacMute = 0x31;
constexpr uint8_t dacVolume = 0x32;
constexpr char preference[] = "sound";
std::atomic<bool> enabled{false};
TaskHandle_t worker = nullptr;
NotificationCooldown cooldown;
int16_t cue[cueFrames];

struct Register {
  uint8_t address;
  uint8_t value;
};

bool writeCodec(uint8_t address, uint8_t value) {
  Wire.beginTransmission(codecAddress);
  Wire.write(address);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool startCodec() {
  // Both boards use the ES8311 as an I2S slave with a 4.096 MHz external
  // master clock, 16 kHz sample rate, two 16-bit slots and DAC output.
  // https://github.com/espressif/esp-bsp/blob/master/components/es8311/es8311.c
  writeCodec(0x44, 0x08); // The first transaction can fail as the codec wakes.
  if (!writeCodec(0x44, 0x08) || !writeCodec(0x00, 0x1F)) return false;
  vTaskDelay(pdMS_TO_TICKS(20));
  constexpr Register settings[] = {
    {0x00, 0x00}, {0x00, 0x80}, {dacMute, 0x60},
    {0x01, 0x3F}, {0x02, 0x00}, {0x03, 0x10}, {0x04, 0x10},
    {0x05, 0x00}, {0x06, 0x03}, {0x07, 0x00}, {0x08, 0xFF},
    {0x09, 0x0C}, {0x0A, 0x4C},
    {0x0D, 0x01}, {0x0E, 0x02}, {0x12, 0x00}, {0x13, 0x10},
    {0x37, 0x08}, {dacVolume, volume},
  };
  for (const auto &reg : settings) {
    if (!writeCodec(reg.address, reg.value)) return false;
  }
  vTaskDelay(pdMS_TO_TICKS(50));
  return true;
}

void stopCodec() {
  // The codec's full power-down sequence runs before stopping I2S clocks.
  // https://github.com/espressif/esp-audio-dev/blob/main/esp_codec_dev/device/es8311/es8311.c
  writeCodec(dacMute, 0x60);
#ifndef AGENTREMINDER_PASSPORT
  digitalWrite(ampEnablePin, LOW);
#endif
  constexpr Register shutdown[] = {
    {dacVolume, 0x00}, {0x17, 0x00}, {0x0E, 0xFF},
    {0x12, 0x02}, {0x14, 0x00}, {0x0D, 0xFA}, {0x15, 0x00}, {0x02, 0x10},
    {0x00, 0x00}, {0x00, 0x1F}, {0x01, 0x30}, {0x01, 0x00}, {0x45, 0x00},
    {0x0D, 0xFC}, {0x02, 0x00},
  };
  for (const auto &reg : shutdown) writeCodec(reg.address, reg.value);
}

void prepareCue() {
  constexpr float radiansPerFrame = 6.2831853f * 784.0f / sampleRate;
  // Only tone samples are populated. The amplifier stays on during the silence.
  for (size_t frame = 0; frame < toneFrames; ++frame) {
    const float attack = float(min(frame, attackFrames)) / attackFrames;
    const float tail = float(min(toneFrames - frame, releaseFrames)) / releaseFrames;
    const auto sample = int16_t(peakAmplitude * attack * tail * tail * sinf(radiansPerFrame * frame));
    for (size_t tone = 0; tone < toneCount; ++tone) {
      cue[leadFrames + tone * (toneFrames + gapFrames) + frame] = sample;
    }
  }
}

bool playCue() {
  int16_t stereo[2 * blockFrames]{};
  if (!enabled.load()) return true;
#ifndef AGENTREMINDER_PASSPORT
  digitalWrite(ampEnablePin, HIGH);
  // Allow the NS4150B to leave shutdown before sending the first samples.
  // Its typical wake time is 35 ms.
  vTaskDelay(pdMS_TO_TICKS(80));
#endif
  if (!writeCodec(dacMute, 0x00)) return false;
  for (size_t start = 0; start < cueFrames && enabled.load(); start += blockFrames) {
    const size_t frames = min(blockFrames, cueFrames - start);
    for (size_t i = 0; i < frames; ++i) stereo[2 * i] = stereo[2 * i + 1] = cue[start + i];
    const size_t bytes = frames * 2 * sizeof(stereo[0]);
    size_t written = 0;
    if (i2s_write(audioPort, stereo, bytes, &written, pdMS_TO_TICKS(40)) != ESP_OK ||
        written != bytes) return false;
  }
  // Allow the final DMA buffers to drain before muting and stopping their clock.
  if (enabled.load()) vTaskDelay(pdMS_TO_TICKS(40));
  return true;
}

void runAudio(void *) {
  // Synthesis can outlast a DMA buffer on the C3. Prepare the cue once before starting I2S.
  prepareCue();
#ifdef AGENTREMINDER_PASSPORT
  bool wireReady = false;
#endif
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    if (!enabled.load()) continue;
#ifdef AGENTREMINDER_PASSPORT
    if (!wireReady) wireReady = Wire.begin(10, 7, 100000);
    if (!wireReady) {
      Serial.println("{\"t\":\"log\",\"msg\":\"Notification sound I2C unavailable\"}");
      continue;
    }
#endif
    // Waveshare already uses Wire for touch and the PMIC.
    i2s_config_t config{};
    config.mode = i2s_mode_t(I2S_MODE_MASTER | I2S_MODE_TX);
    config.sample_rate = sampleRate;
    config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
    config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
    config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    config.dma_buf_count = 4;
    config.dma_buf_len = blockFrames;
    config.tx_desc_auto_clear = true;
    config.mclk_multiple = I2S_MCLK_MULTIPLE_256;
    if (i2s_driver_install(audioPort, &config, 0, nullptr) != ESP_OK) {
      Serial.println("{\"t\":\"log\",\"msg\":\"Notification sound I2S unavailable\"}");
      continue;
    }
    const bool i2sReady = i2s_set_pin(audioPort, &audioPins) == ESP_OK &&
      i2s_zero_dma_buffer(audioPort) == ESP_OK;
    const bool codecReady = i2sReady && startCodec();
    const uint32_t pcmStarted = millis();
    const bool played = codecReady && playCue();
    const uint32_t pcmMs = millis() - pcmStarted;
    if (i2sReady) stopCodec();
    i2s_driver_uninstall(audioPort);
    if (played && enabled.load()) {
      Serial.printf("{\"t\":\"log\",\"msg\":\"Notification sound played (%lu ms PCM)\"}\n",
                    static_cast<unsigned long>(pcmMs));
    }
    if (!played) Serial.println("{\"t\":\"log\",\"msg\":\"Notification sound failed\"}");
  }
}
}

void notification_sound_init() {
#ifndef AGENTREMINDER_PASSPORT
  pinMode(ampEnablePin, OUTPUT);
  digitalWrite(ampEnablePin, LOW);
#endif
  nvs_handle_t prefs;
  const esp_err_t opened = nvs_open("ar", NVS_READONLY, &prefs);
  if (opened == ESP_ERR_NVS_NOT_FOUND) {
    enabled.store(true);
  } else if (opened == ESP_OK) {
    uint8_t stored = 0;
    const esp_err_t read = nvs_get_u8(prefs, preference, &stored);
    enabled.store(read == ESP_ERR_NVS_NOT_FOUND || (read == ESP_OK && stored == 1));
    nvs_close(prefs);
  }
}

bool notification_sound_enabled() { return enabled.load(); }

bool notification_sound_toggle() {
  const bool next = !enabled.load();
  enabled.store(next);
  nvs_handle_t prefs;
  if (nvs_open("ar", NVS_READWRITE, &prefs) != ESP_OK) return false;
  const bool saved = nvs_set_u8(prefs, preference, next) == ESP_OK && nvs_commit(prefs) == ESP_OK;
  nvs_close(prefs);
  if (saved) Serial.printf("{\"t\":\"log\",\"msg\":\"Notification sound %s\"}\n", next ? "on" : "off");
  return saved;
}

void notification_sound_notify() {
  if (!enabled.load()) return;
  const uint32_t now = millis();
  // A burst of cards still produces one brief cue.
  if (!cooldown.ready(now)) return;
  if (!worker && xTaskCreate(runAudio, "ar-sound", 4096, nullptr, 1, &worker) != pdPASS) return;
  cooldown.record(now);
  xTaskNotifyGive(worker);
}
