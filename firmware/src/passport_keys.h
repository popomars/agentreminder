#pragma once
#include <stdint.h>

// Button positions with the Passport held upright.
enum class PassportKey { invalid, released, top, middle, bottom };

struct PassportKeyEvent {
  PassportKey key = PassportKey::released;
  bool held = false;
  bool repeat = false;
  PassportKeyEvent() = default;
  PassportKeyEvent(PassportKey key, bool held, bool repeat = false) : key(key), held(held), repeat(repeat) {}
};

class PassportKeys {
  PassportKey sample = PassportKey::invalid;
  PassportKey active = PassportKey::released;
  uint32_t changedAt = 0, pressedAt = 0, heldAt = 0;
  bool armed = false, held = false;

  static PassportKey decode(int millivolts) {
    if (millivolts < 0) return PassportKey::invalid;
    if (millivolts < 150) return PassportKey::top;
    if (millivolts < 447) return PassportKey::middle;
    if (millivolts < 1900) return PassportKey::bottom;
    return PassportKey::released;
  }

public:
  void reset() {
    sample = PassportKey::invalid;
    active = PassportKey::released;
    armed = held = false;
  }

  PassportKeyEvent poll(int millivolts, uint32_t now) {
    const PassportKey key = decode(millivolts);
    if (key == PassportKey::invalid) { reset(); return {}; }
    if (sample != key) { sample = key; changedAt = now; }
    const uint32_t stableFor = now - changedAt;

    // Require a real release before arming, including after a new card appears.
    if (!armed) {
      armed = key == PassportKey::released && stableFor >= 120;
    } else if (active == PassportKey::released) {
      if (key != PassportKey::released && stableFor >= 40) {
        active = key;
        pressedAt = now;
        held = false;
      }
    } else if (key == PassportKey::released) {
      if (stableFor >= 120) {
        const PassportKey released = active;
        active = PassportKey::released;
        if (!held) return {released, false};
      }
    } else if (key != active) {
      // A transition to another ladder window can be a partial release.
      if (stableFor >= 40) reset();
    } else if (now - pressedAt >= 500 && (!held || now - heldAt >= 320)) {
      const PassportKeyEvent event{active, true, held};
      heldAt = now;
      held = true;
      return event;
    }
    return {};
  }
};
