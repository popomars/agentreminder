#include "../src/notification_cooldown.h"

#include <cassert>

int main() {
  NotificationCooldown sound;
  assert(sound.ready(0));
  sound.record(0);
  assert(!sound.ready(0));
  assert(!sound.ready(999));
  assert(sound.ready(1000));
  assert(sound.ready(1001)); // A failed playback start need not consume the next cue.
  sound.record(1001);
  assert(!sound.ready(2000));
  assert(sound.ready(2001));

  NotificationCooldown wrap;
  wrap.record(UINT32_MAX - 499);
  assert(!wrap.ready(UINT32_MAX));
  assert(!wrap.ready(499));
  assert(wrap.ready(500));
}
