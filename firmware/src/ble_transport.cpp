#include "ble_transport.h"
#include <BLEDevice.h>
#include <BLE2902.h>
#include <Preferences.h>
#include <atomic>
#include <vector>
#include <mbedtls/gcm.h>
#include <mbedtls/md.h>

namespace {
constexpr size_t nonceSize = 16, tagSize = 16, keySize = 32, maxMessage = 16384;
constexpr uint16_t noConnection = UINT16_MAX;
const char *rxUuid = "B623A0C1-5E48-46D3-BA39-000000000000";
const char *txUuid = "B623A0C2-5E48-46D3-BA39-000000000000";
enum EventType { connected, disconnected, data };
struct Event { EventType type; uint16_t connection, size; uint8_t bytes[512]; };
QueueHandle_t events;
std::atomic<bool> queueOverflow{false};
BLEServer *server;
BLECharacteristic *tx;
std::atomic<esp_gatt_if_t> gattInterface{ESP_GATT_IF_NONE};
BleMessage receiveMessage;
void (*linkClosed)();
String deviceId;
uint8_t key[keySize];
bool paired, encrypted, authenticated, closing;
uint16_t connection = noConnection;
uint32_t lastPacket;
uint64_t sent, received;
uint8_t txKey[keySize], rxKey[keySize];
std::vector<uint8_t> input, output;
size_t outputOffset;

void enqueue(Event &event) {
  if (xQueueSend(events, &event, 0) != pdTRUE) queueOverflow = true;
}

class ServerEvents : public BLEServerCallbacks {
  void onConnect(BLEServer *, esp_ble_gatts_cb_param_t *p) override {
    Event event{connected, p->connect.conn_id, 0, {}};
    enqueue(event);
  }
  void onDisconnect(BLEServer *, esp_ble_gatts_cb_param_t *p) override {
    Event event{disconnected, p->disconnect.conn_id, 0, {}};
    enqueue(event);
  }
};

class RxEvents : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *, esp_ble_gatts_cb_param_t *p) override {
    if (p->write.is_prep || p->write.len > 512) { queueOverflow = true; return; }
    Event event{data, p->write.conn_id, p->write.len, {}};
    memcpy(event.bytes, p->write.value, event.size);
    enqueue(event);
  }
};

ServerEvents serverEvents;
RxEvents rxEvents;

void reset() {
  encrypted = authenticated = closing = false;
  sent = received = 0;
  input.clear(); output.clear(); outputOffset = 0;
  memset(txKey, 0, sizeof(txKey)); memset(rxKey, 0, sizeof(rxKey));
}

void disconnectLink() {
  if (connection == noConnection || closing) return;
  closing = true;
  server->disconnect(connection);
}

void advertise() {
  if (server && paired && connection == noConnection) BLEDevice::startAdvertising();
}

void start() {
  if (server) return;
  events = xQueueCreate(32, sizeof(Event));
  if (!events) return;
  BLEDevice::init("AgentReminder");
  BLEDevice::setCustomGattsHandler([](esp_gatts_cb_event_t event, esp_gatt_if_t iface, esp_ble_gatts_cb_param_t *) {
    if (event == ESP_GATTS_REG_EVT) gattInterface = iface;
  });
  BLEDevice::setMTU(185);
  server = BLEDevice::createServer();
  server->setCallbacks(&serverEvents);
  const String uuid = "B623A0C0-5E48-46D3-BA39-" + deviceId;
  BLEService *service = server->createService(uuid.c_str());
  auto *rx = service->createCharacteristic(rxUuid, BLECharacteristic::PROPERTY_WRITE);
  rx->setCallbacks(&rxEvents);
  tx = service->createCharacteristic(txUuid, BLECharacteristic::PROPERTY_NOTIFY);
  tx->addDescriptor(new BLE2902());
  service->start();
  BLEAdvertisementData advertisement;
  advertisement.setFlags(ESP_BLE_ADV_FLAG_GEN_DISC | ESP_BLE_ADV_FLAG_BREDR_NOT_SPT);
  advertisement.setCompleteServices(BLEUUID(uuid.c_str()));
  BLEDevice::getAdvertising()->setAdvertisementData(advertisement);
  BLEDevice::getAdvertising()->setScanResponse(false);
  advertise();
}

// A fresh nonce from each side gives new directional keys on every connection.
bool derive(const char *direction, const uint8_t *host, const uint8_t *device, uint8_t *out) {
  uint8_t message[64];
  size_t n = snprintf(reinterpret_cast<char *>(message), sizeof(message), "agentreminder-ble-v1:%s:", direction);
  memcpy(message + n, host, nonceSize);
  memcpy(message + n + nonceSize, device, nonceSize);
  return mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, sizeof(key), message, n + 2 * nonceSize, out) == 0;
}

void counterNonce(uint64_t counter, uint8_t (&nonce)[12]) {
  memset(nonce, 0, sizeof(nonce));
  for (int i = 11; i >= 4; --i) { nonce[i] = counter & 255; counter >>= 8; }
}

void queueFrame(const uint8_t *bytes, size_t size) {
  if (output.size() + size + 2 > 2 * maxMessage) { disconnectLink(); return; }
  output.push_back(size >> 8);
  output.push_back(size & 255);
  output.insert(output.end(), bytes, bytes + size);
}

void readFrame(const uint8_t *bytes, size_t size) {
  if (!encrypted) {
    if (size != nonceSize) { disconnectLink(); return; }
    uint8_t challenge[nonceSize];
    esp_fill_random(challenge, sizeof(challenge));
    encrypted = derive("c2d", bytes, challenge, rxKey) && derive("d2c", bytes, challenge, txKey);
    if (!encrypted) { disconnectLink(); return; }
    queueFrame(challenge, sizeof(challenge));
    return;
  }
  if (size <= tagSize) { disconnectLink(); return; }
  const size_t length = size - tagSize;
  std::vector<uint8_t> plain(length + 1, 0);
  uint8_t nonce[12];
  counterNonce(received, nonce);
  mbedtls_gcm_context ctx;
  mbedtls_gcm_init(&ctx);
  int result = mbedtls_gcm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, rxKey, 256);
  if (!result) result = mbedtls_gcm_auth_decrypt(&ctx, length, nonce, sizeof(nonce), nullptr, 0, bytes + length, tagSize, bytes, plain.data());
  mbedtls_gcm_free(&ctx);
  if (result) { disconnectLink(); return; }
  ++received;
  authenticated = true;
  lastPacket = millis();
  receiveMessage(String(reinterpret_cast<const char *>(plain.data())));
}
}

void ble_init(const String &id, BleMessage receive, void (*onDisconnect)()) {
  deviceId = id;
  receiveMessage = receive;
  linkClosed = onDisconnect;
  Preferences prefs;
  if (prefs.begin("ar", true)) {
    paired = prefs.getBytesLength("ble-key") == sizeof(key) && prefs.getBytes("ble-key", key, sizeof(key)) == sizeof(key);
    prefs.end();
  }
  if (paired) start();
}

bool ble_save_key(const char *hex) {
  if (strlen(hex) != keySize * 2 || strspn(hex, "0123456789abcdef") != keySize * 2) return false;
  uint8_t candidate[keySize];
  for (size_t i = 0; i < keySize; ++i) {
    const char pair[]{hex[2 * i], hex[2 * i + 1], 0};
    candidate[i] = strtoul(pair, nullptr, 16);
  }
  Preferences prefs;
  if (!prefs.begin("ar", false)) return false;
  const bool saved = prefs.putBytes("ble-key", candidate, sizeof(candidate)) == sizeof(candidate);
  prefs.end();
  if (!saved) return false;
  memcpy(key, candidate, sizeof(key));
  paired = true;
  disconnectLink();
  start();
  return true;
}

bool ble_paired() { return paired; }

void ble_poll() {
  if (!server) return;
  Event event;
  unsigned budget = 32;
  while (budget-- && xQueueReceive(events, &event, 0) == pdTRUE) {
    if (event.type == connected) {
      if (connection != noConnection) { server->disconnect(event.connection); continue; }
      reset();
      connection = event.connection;
      lastPacket = millis();
    } else if (event.type == disconnected && event.connection == connection) {
      connection = noConnection;
      reset();
      linkClosed();
      advertise();
    } else if (event.type == data && event.connection == connection && !closing) {
      input.insert(input.end(), event.bytes, event.bytes + event.size);
      while (input.size() >= 2 && !closing) {
        const size_t length = (size_t(input[0]) << 8) | input[1];
        if (!length || length > maxMessage + tagSize) { disconnectLink(); break; }
        if (input.size() < length + 2) break;
        readFrame(input.data() + 2, length);
        input.erase(input.begin(), input.begin() + 2 + length);
      }
    }
  }
  if (queueOverflow.exchange(false)) disconnectLink();
  if (connection == noConnection || closing) return;
  if (millis() - lastPacket > (authenticated ? 40000UL : 6000UL)) { disconnectLink(); return; }
  if (outputOffset < output.size()) {
    const size_t mtu = server->getPeerMTU(connection);
    const size_t length = std::min(output.size() - outputOffset, mtu > 23 ? mtu - 3 : 20);
    if (esp_ble_gatts_send_indicate(gattInterface, connection, tx->getHandle(), length,
                                  output.data() + outputOffset, false) == ESP_OK) {
      outputOffset += length;
      if (outputOffset == output.size()) { output.clear(); outputOffset = 0; }
    }
  }
}

void ble_send(const String &line) {
  const size_t length = line.length();
  if (!authenticated || closing || length > maxMessage) return;
  std::vector<uint8_t> encryptedLine(length + tagSize);
  uint8_t nonce[12];
  counterNonce(sent, nonce);
  mbedtls_gcm_context ctx;
  mbedtls_gcm_init(&ctx);
  int result = mbedtls_gcm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, txKey, 256);
  if (!result) result = mbedtls_gcm_crypt_and_tag(&ctx, MBEDTLS_GCM_ENCRYPT, length, nonce, sizeof(nonce), nullptr, 0,
      reinterpret_cast<const uint8_t *>(line.c_str()), encryptedLine.data(), tagSize, encryptedLine.data() + length);
  mbedtls_gcm_free(&ctx);
  if (result) { disconnectLink(); return; }
  ++sent;
  queueFrame(encryptedLine.data(), encryptedLine.size());
}
