// Shared between the Gadget Cam Studio camera component (runs inside Windows' Frame Server)
// and the app (writes frames). Keep in sync with electron/vcam.js.
#pragma once
#include <windows.h>
#include <stdint.h>

// {476C473E-FE84-43EB-82C1-F0C70887D7C9}
static const GUID CLSID_GcsCamSource = { 0x476c473e, 0xfe84, 0x43eb, { 0x82, 0xc1, 0xf0, 0xc7, 0x08, 0x87, 0xd7, 0xc9 } };
#define GCS_CLSID_STRING L"{476C473E-FE84-43EB-82C1-F0C70887D7C9}"
#define GCS_FRIENDLY_NAME L"Gadget Cam Studio"
#define GCS_MAPPING_NAME L"Global\\GadgetCamStudioFrames"

#define GCS_MAGIC 0x31534347u          // "GCS1"
#define GCS_MAX_W 1920
#define GCS_MAX_H 1080
#define GCS_SLOTS 3
#define GCS_SLOT_BYTES (GCS_MAX_W * GCS_MAX_H * 3 / 2)
#define GCS_HEADER_BYTES 64

// 64-byte header followed by GCS_SLOTS NV12 frames of up to 1920x1080.
// Writer: fill slot (writeCount + 1) % GCS_SLOTS, then set width/height/fps, lastWriteMs, and finally writeCount + 1.
#pragma pack(push, 4)
struct GcsHeader {
  uint32_t magic;              // 0
  uint32_t version;            // 4
  uint32_t width;              // 8   size of the frames the app is writing
  uint32_t height;             // 12
  uint32_t fps;                // 16
  volatile uint32_t writeCount;// 20  number of frames written; latest is in slot (writeCount % GCS_SLOTS)
  volatile uint64_t lastWriteMs; // 24  GetTickCount64() at the last write
  uint32_t reserved[8];        // 32..63
};
#pragma pack(pop)
static_assert(sizeof(GcsHeader) == GCS_HEADER_BYTES, "header must be 64 bytes");
#define GCS_MAPPING_BYTES (GCS_HEADER_BYTES + GCS_SLOTS * GCS_SLOT_BYTES)
