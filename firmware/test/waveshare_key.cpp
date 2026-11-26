#include "../src/waveshare_key.h"

#include <cassert>

int main() {
  using Gesture = KeyGesture;
  WaveshareKey key;
  key.reset(true, 0); // Held across boot or a new card.
  assert(key.poll(true, 600) == Gesture::none);
  assert(key.poll(false, 610) == Gesture::none);
  assert(key.poll(false, 645) == Gesture::none);

  assert(key.poll(true, 650) == Gesture::none);
  assert(key.poll(true, 685) == Gesture::none);
  assert(key.poll(false, 720) == Gesture::none);
  assert(key.poll(false, 754) == Gesture::none);
  assert(key.poll(false, 755) == Gesture::tap);

  assert(key.poll(true, 800) == Gesture::none);
  assert(key.poll(true, 835) == Gesture::none);
  assert(key.poll(true, 1334) == Gesture::none);
  assert(key.poll(true, 1335) == Gesture::hold);
  assert(key.poll(true, 1654) == Gesture::none);
  assert(key.poll(true, 1655) == Gesture::repeat);
  assert(key.poll(false, 1700) == Gesture::none);
  assert(key.poll(false, 1735) == Gesture::none);

  key.reset(false, UINT32_MAX - 20);
  assert(key.poll(true, UINT32_MAX - 19) == Gesture::none);
  assert(key.poll(true, 15) == Gesture::none);
  assert(key.poll(true, 515) == Gesture::hold);
}
