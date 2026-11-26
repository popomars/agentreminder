#pragma once

#include <stdint.h>

enum class KeyGesture { none, tap, hold, repeat };

// A tap is emitted on release so that a long press can't also choose a card.
class WaveshareKey {
public:
  void reset(bool down, uint32_t now) {
    sample = stable = down;
    armed = !down;
    held = false;
    changedAt = pressedAt = repeatedAt = now;
  }

  KeyGesture poll(bool down, uint32_t now) {
    if (sample != down) {
      sample = down;
      changedAt = now;
    }
    if (stable != sample && now - changedAt >= 35) {
      stable = sample;
      if (!stable) {
        const bool tap = armed && !held;
        armed = true;
        return tap ? KeyGesture::tap : KeyGesture::none;
      }
      pressedAt = now;
      held = false;
    }
    if (armed && stable && sample && now - pressedAt >= 500) {
      if (!held || now - repeatedAt >= 320) {
        const auto gesture = held ? KeyGesture::repeat : KeyGesture::hold;
        held = true;
        repeatedAt = now;
        return gesture;
      }
    }
    return KeyGesture::none;
  }

private:
  bool sample = false, stable = false, armed = false, held = false;
  uint32_t changedAt = 0, pressedAt = 0, repeatedAt = 0;
};
