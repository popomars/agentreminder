#pragma once
#include <Arduino.h>

using BleMessage = void (*)(const String &);
void ble_init(const String &deviceId, BleMessage receive, void (*disconnected)());
void ble_poll();
void ble_send(const String &line);
bool ble_save_key(const char *hex);
bool ble_paired();
