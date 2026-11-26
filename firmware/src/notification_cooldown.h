#pragma once

#include <stdint.h>

class NotificationCooldown {
public:
  bool ready(uint32_t now) const { return !played || now - last >= 1000; }
  void record(uint32_t now) {
    last = now;
    played = true;
  }

private:
  uint32_t last = 0;
  bool played = false;
};
