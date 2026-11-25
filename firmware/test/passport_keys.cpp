#include "../src/passport_keys.h"
#include <cassert>

static void quiet(PassportKeys &keys, int millivolts, uint32_t now) {
  assert(keys.poll(millivolts, now).key == PassportKey::released);
}

static void arm(PassportKeys &keys, uint32_t now) {
  quiet(keys, 2500, now);
  quiet(keys, 2500, now + 120);
}

int main() {
  PassportKeys keys;
  quiet(keys, 300, 0);
  quiet(keys, 300, 1000);
  arm(keys, 1010);

  quiet(keys, 300, 1200);
  quiet(keys, 300, 1240);
  quiet(keys, 595, 1300); // Briefly passes through the OK window on release.
  quiet(keys, 2500, 1310);
  quiet(keys, 2500, 1429);
  auto event = keys.poll(2500, 1430);
  assert(event.key == PassportKey::middle && !event.held);
  quiet(keys, 2500, 1435);

  quiet(keys, 0, 1500);
  quiet(keys, 0, 1540);
  event = keys.poll(0, 2040);
  assert(event.key == PassportKey::top && event.held && !event.repeat);
  quiet(keys, 0, 2359);
  assert(keys.poll(0, 2360).repeat);
  arm(keys, 2420); // Release after a scroll must not deny.

  quiet(keys, 300, 2600);
  quiet(keys, 300, 2640);
  keys.reset(); // The current request was removed while the key was down.
  quiet(keys, 300, 2700);
  quiet(keys, 300, 3200);
  arm(keys, 3300);

  quiet(keys, 595, 3500);
  quiet(keys, 595, 3540);
  quiet(keys, -1, 3600); // ADC failure cannot acknowledge or select.
  arm(keys, 3610);
  quiet(keys, 595, 3800);
  quiet(keys, 595, 3840);
  quiet(keys, 2500, 3900);
  event = keys.poll(2500, 4020);
  assert(event.key == PassportKey::bottom && !event.held);

  quiet(keys, 595, 4100);
  quiet(keys, 595, 4140);
  event = keys.poll(595, 4640);
  assert(event.key == PassportKey::bottom && event.held);
  keys.reset(); // Toggling sound rebuilds the current screen.
  quiet(keys, 595, 4650);
  quiet(keys, 595, 5850); // A continued hold cannot toggle again.
  arm(keys, 5900);       // Release also cannot clear the current card.
  quiet(keys, 595, 6100);
  quiet(keys, 595, 6140);
  quiet(keys, 2500, 6200);
  event = keys.poll(2500, 6320);
  assert(event.key == PassportKey::bottom && !event.held);

  quiet(keys, 300, 6400);
  quiet(keys, 300, 6440);
  quiet(keys, 300, 6939);
  event = keys.poll(300, 6940);
  assert(event.key == PassportKey::middle && event.held && !event.repeat);
  keys.reset(); // Rotating an active card rebuilds it and requires release.
  quiet(keys, 300, 6950);
  quiet(keys, 300, 8000);
  arm(keys, 8100); // A long press and its release cannot approve the card.
  quiet(keys, 300, 8300);
  quiet(keys, 300, 8340);
  quiet(keys, 2500, 8400);
  event = keys.poll(2500, 8520);
  assert(event.key == PassportKey::middle && !event.held);
}
