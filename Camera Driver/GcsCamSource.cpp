// Gadget Cam Studio virtual camera: a Media Foundation media source loaded by Windows 11's Frame Server.
// It reads NV12 frames the app writes into shared memory and hands them to any app using the camera
// (Meet, Zoom, Teams, OBS, Windows Camera). When the app isn't sending, it shows a dark standby frame.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <initguid.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <mfobjects.h>
#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>   // IKsControl
#include <sddl.h>
#include <wrl/client.h>
#include <new>
#include <string.h>
#include "shared.h"

using Microsoft::WRL::ComPtr;

static HMODULE g_module = nullptr;
static volatile LONG g_objects = 0;
static volatile LONG g_locks = 0;

struct Lock {
  CRITICAL_SECTION* cs;
  explicit Lock(CRITICAL_SECTION* c) : cs(c) { EnterCriticalSection(cs); }
  ~Lock() { LeaveCriticalSection(cs); }
};

// ---------------------------------------------------------------------------------------------
// Shared memory reader
// ---------------------------------------------------------------------------------------------
class FrameReader {
public:
  ~FrameReader() { Close(); }
  void EnsureOpen() {
    if (view_) return;
    ULONGLONG now = GetTickCount64();
    if (now - lastTry_ < 1000) return;
    lastTry_ = now;
    // Users (the app) may read and write; the services that host us get full control.
    SECURITY_ATTRIBUTES sa = { sizeof(sa), nullptr, FALSE };
    PSECURITY_DESCRIPTOR sd = nullptr;
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:(A;;GA;;;SY)(A;;GA;;;LS)(A;;GA;;;BA)(A;;GA;;;AU)S:(ML;;NW;;;LW)",
                                                             SDDL_REVISION_1, &sd, nullptr))
      sa.lpSecurityDescriptor = sd;
    mapping_ = CreateFileMappingW(INVALID_HANDLE_VALUE, sa.lpSecurityDescriptor ? &sa : nullptr, PAGE_READWRITE, 0,
                                  GCS_MAPPING_BYTES, GCS_MAPPING_NAME);
    if (sd) LocalFree(sd);
    if (!mapping_) return;
    bool created = GetLastError() != ERROR_ALREADY_EXISTS;
    view_ = (uint8_t*)MapViewOfFile(mapping_, FILE_MAP_ALL_ACCESS, 0, 0, GCS_MAPPING_BYTES);
    if (!view_) { CloseHandle(mapping_); mapping_ = nullptr; return; }
    GcsHeader* h = (GcsHeader*)view_;
    if (created || h->magic != GCS_MAGIC) {
      ZeroMemory(view_, GCS_HEADER_BYTES);
      h->version = 1;
      h->magic = GCS_MAGIC;
    }
  }
  void Close() {
    if (view_) UnmapViewOfFile(view_);
    if (mapping_) CloseHandle(mapping_);
    view_ = nullptr; mapping_ = nullptr;
  }
  // Fill an NV12 buffer of w x h. Returns true if a live frame from the app was used.
  bool Fill(uint8_t* dst, UINT32 w, UINT32 h) {
    EnsureOpen();
    if (view_) {
      GcsHeader* hd = (GcsHeader*)view_;
      ULONGLONG now = GetTickCount64();
      UINT32 sw = hd->width, sh = hd->height, count = hd->writeCount;
      if (count && now - hd->lastWriteMs < 1500 && sw >= 2 && sh >= 2 && sw <= GCS_MAX_W && sh <= GCS_MAX_H) {
        const uint8_t* src = view_ + GCS_HEADER_BYTES + (size_t)(count % GCS_SLOTS) * GCS_SLOT_BYTES;
        if (sw == w && sh == h) memcpy(dst, src, (size_t)w * h * 3 / 2);
        else ScaleNV12(src, sw, sh, dst, w, h);
        return true;
      }
    }
    Standby(dst, w, h);
    return false;
  }

private:
  static void ScaleNV12(const uint8_t* s, UINT32 sw, UINT32 sh, uint8_t* d, UINT32 dw, UINT32 dh) {
    for (UINT32 y = 0; y < dh; y++) {
      const uint8_t* row = s + (size_t)(y * sh / dh) * sw;
      uint8_t* out = d + (size_t)y * dw;
      for (UINT32 x = 0; x < dw; x++) out[x] = row[x * sw / dw];
    }
    const uint8_t* suv = s + (size_t)sw * sh;
    uint8_t* duv = d + (size_t)dw * dh;
    UINT32 cw = dw / 2, ch = dh / 2, scw = sw / 2, sch = sh / 2;
    for (UINT32 y = 0; y < ch; y++) {
      const uint8_t* row = suv + (size_t)(y * sch / ch) * sw;
      uint8_t* out = duv + (size_t)y * dw;
      for (UINT32 x = 0; x < cw; x++) { UINT32 sx = (x * scw / cw) * 2; out[x * 2] = row[sx]; out[x * 2 + 1] = row[sx + 1]; }
    }
  }
  // Dark standby frame with a soft red "record" dot, shown while the app isn't sending video.
  static void Standby(uint8_t* d, UINT32 w, UINT32 h) {
    memset(d, 28, (size_t)w * h);
    memset(d + (size_t)w * h, 128, (size_t)w * h / 2);
    int cx = (int)w / 2, cy = (int)h / 2, r = (int)h / 14;
    for (int y = cy - r; y < cy + r; y++) for (int x = cx - r; x < cx + r; x++) {
      int dx = x - cx, dy = y - cy; if (dx * dx + dy * dy > r * r) continue;
      d[(size_t)y * w + x] = 81;
      uint8_t* uv = d + (size_t)w * h + (size_t)(y / 2) * w + (x / 2) * 2;
      uv[0] = 90; uv[1] = 240;
    }
  }
  HANDLE mapping_ = nullptr;
  uint8_t* view_ = nullptr;
  ULONGLONG lastTry_ = 0;
};

// ---------------------------------------------------------------------------------------------
// Media stream
// ---------------------------------------------------------------------------------------------
class MediaSource;

class MediaStream : public IMFMediaStream2 {
public:
  MediaStream(MediaSource* src) : source_(src) { InitializeCriticalSection(&cs_); InterlockedIncrement(&g_objects); }
  ~MediaStream() { DeleteCriticalSection(&cs_); InterlockedDecrement(&g_objects); }

  HRESULT Initialize();
  HRESULT Start();
  HRESULT Stop();
  void Shutdown();
  IMFStreamDescriptor* Descriptor() { return descriptor_.Get(); }

  // IUnknown
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == __uuidof(IMFMediaEventGenerator) || riid == __uuidof(IMFMediaStream) || riid == __uuidof(IMFMediaStream2)) {
      *ppv = static_cast<IMFMediaStream2*>(this); AddRef(); return S_OK;
    }
    *ppv = nullptr; return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref_); }
  STDMETHODIMP_(ULONG) Release() override { ULONG r = InterlockedDecrement(&ref_); if (!r) delete this; return r; }

  // IMFMediaEventGenerator
  STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** ev) override { ComPtr<IMFMediaEventQueue> q; { Lock l(&cs_); if (!queue_) return MF_E_SHUTDOWN; q = queue_; } return q->GetEvent(flags, ev); }
  STDMETHODIMP BeginGetEvent(IMFAsyncCallback* cb, IUnknown* st) override { Lock l(&cs_); if (!queue_) return MF_E_SHUTDOWN; return queue_->BeginGetEvent(cb, st); }
  STDMETHODIMP EndGetEvent(IMFAsyncResult* r, IMFMediaEvent** ev) override { Lock l(&cs_); if (!queue_) return MF_E_SHUTDOWN; return queue_->EndGetEvent(r, ev); }
  STDMETHODIMP QueueEvent(MediaEventType t, REFGUID g, HRESULT hr, const PROPVARIANT* v) override { Lock l(&cs_); if (!queue_) return MF_E_SHUTDOWN; return queue_->QueueEventParamVar(t, g, hr, v); }

  // IMFMediaStream
  STDMETHODIMP GetMediaSource(IMFMediaSource** ms) override;
  STDMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** sd) override {
    if (!sd) return E_POINTER; Lock l(&cs_); if (!descriptor_) return MF_E_SHUTDOWN;
    *sd = descriptor_.Get(); (*sd)->AddRef(); return S_OK;
  }
  STDMETHODIMP RequestSample(IUnknown* token) override;

  // IMFMediaStream2
  STDMETHODIMP SetStreamState(MF_STREAM_STATE s) override {
    if (s == MF_STREAM_STATE_RUNNING) return Start();
    if (s == MF_STREAM_STATE_STOPPED) return Stop();
    return MF_E_INVALID_STATE_TRANSITION;
  }
  STDMETHODIMP GetStreamState(MF_STREAM_STATE* s) override { if (!s) return E_POINTER; Lock l(&cs_); *s = state_; return S_OK; }

private:
  volatile ULONG ref_ = 1;
  CRITICAL_SECTION cs_;
  MediaSource* source_;               // weak: the source owns the stream
  ComPtr<IMFMediaEventQueue> queue_;
  ComPtr<IMFStreamDescriptor> descriptor_;
  MF_STREAM_STATE state_ = MF_STREAM_STATE_STOPPED;
  MFTIME startTime_ = 0;
  MFTIME lastSample_ = 0;
  FrameReader reader_;
};

static HRESULT MakeNV12Type(UINT32 w, UINT32 h, IMFMediaType** out) {
  ComPtr<IMFMediaType> t;
  HRESULT hr = MFCreateMediaType(&t); if (FAILED(hr)) return hr;
  t->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  t->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  MFSetAttributeSize(t.Get(), MF_MT_FRAME_SIZE, w, h);
  MFSetAttributeRatio(t.Get(), MF_MT_FRAME_RATE, 30, 1);
  MFSetAttributeRatio(t.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  t->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  t->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
  t->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
  t->SetUINT32(MF_MT_DEFAULT_STRIDE, w);
  t->SetUINT32(MF_MT_SAMPLE_SIZE, w * h * 3 / 2);
  t->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
  t->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
  *out = t.Detach();
  return S_OK;
}

HRESULT MediaStream::Initialize() {
  HRESULT hr = MFCreateEventQueue(&queue_); if (FAILED(hr)) return hr;
  const UINT32 sizes[][2] = { { 1280, 720 }, { 1920, 1080 }, { 640, 360 } };
  IMFMediaType* types[3] = {};
  for (int i = 0; i < 3; i++) { hr = MakeNV12Type(sizes[i][0], sizes[i][1], &types[i]); if (FAILED(hr)) break; }
  if (SUCCEEDED(hr)) hr = MFCreateStreamDescriptor(0, 3, types, &descriptor_);
  for (auto* t : types) if (t) t->Release();
  if (FAILED(hr)) return hr;
  descriptor_->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
  descriptor_->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0);
  descriptor_->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
  descriptor_->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes_Color);
  ComPtr<IMFMediaTypeHandler> handler;
  hr = descriptor_->GetMediaTypeHandler(&handler); if (FAILED(hr)) return hr;
  ComPtr<IMFMediaType> first;
  hr = handler->GetMediaTypeByIndex(0, &first); if (FAILED(hr)) return hr;
  return handler->SetCurrentMediaType(first.Get());
}

HRESULT MediaStream::Start() {
  Lock l(&cs_);
  if (!queue_) return MF_E_SHUTDOWN;
  state_ = MF_STREAM_STATE_RUNNING;
  startTime_ = MFGetSystemTime();
  return queue_->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr);
}
HRESULT MediaStream::Stop() {
  Lock l(&cs_);
  if (!queue_) return MF_E_SHUTDOWN;
  state_ = MF_STREAM_STATE_STOPPED;
  return queue_->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr);
}
void MediaStream::Shutdown() {
  Lock l(&cs_);
  if (queue_) { queue_->Shutdown(); queue_.Reset(); }
  descriptor_.Reset();
  reader_.Close();
  source_ = nullptr;
}

HRESULT MediaStream::RequestSample(IUnknown* token) {
  // Pace delivery to 30 fps: callers ask for the next frame as soon as they get one.
  DWORD waitMs = 0;
  {
    Lock l(&cs_);
    if (!queue_) return MF_E_SHUTDOWN;
    if (state_ != MF_STREAM_STATE_RUNNING) return MF_E_MEDIA_SOURCE_WRONGSTATE;
    MFTIME since = MFGetSystemTime() - lastSample_;
    if (lastSample_ && since >= 0 && since < 333333) waitMs = (DWORD)((333333 - since) / 10000);
  }
  if (waitMs) Sleep(waitMs);
  Lock l(&cs_);
  if (!queue_) return MF_E_SHUTDOWN;
  if (state_ != MF_STREAM_STATE_RUNNING) return MF_E_MEDIA_SOURCE_WRONGSTATE;
  ComPtr<IMFMediaTypeHandler> handler; ComPtr<IMFMediaType> type;
  HRESULT hr = descriptor_->GetMediaTypeHandler(&handler); if (FAILED(hr)) return hr;
  hr = handler->GetCurrentMediaType(&type); if (FAILED(hr)) return hr;
  UINT32 w = 0, h = 0;
  MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &w, &h);
  if (!w || !h) return MF_E_INVALIDMEDIATYPE;
  DWORD bytes = w * h * 3 / 2;
  ComPtr<IMFMediaBuffer> buffer;
  hr = MFCreateMemoryBuffer(bytes, &buffer); if (FAILED(hr)) return hr;
  BYTE* data = nullptr;
  hr = buffer->Lock(&data, nullptr, nullptr); if (FAILED(hr)) return hr;
  reader_.Fill(data, w, h);
  buffer->Unlock();
  buffer->SetCurrentLength(bytes);
  ComPtr<IMFSample> sample;
  hr = MFCreateSample(&sample); if (FAILED(hr)) return hr;
  sample->AddBuffer(buffer.Get());
  MFTIME now = MFGetSystemTime();
  lastSample_ = now;
  sample->SetSampleTime(now);          // live source: system (QPC) time, like a hardware camera
  sample->SetSampleDuration(333333);
  if (token) sample->SetUnknown(MFSampleExtension_Token, token);
  PROPVARIANT v; PropVariantInit(&v);
  v.vt = VT_UNKNOWN; v.punkVal = sample.Get();
  return queue_->QueueEventParamVar(MEMediaSample, GUID_NULL, S_OK, &v);
}

// ---------------------------------------------------------------------------------------------
// Media source
// ---------------------------------------------------------------------------------------------
class MediaSource : public IMFMediaSourceEx, public IMFGetService, public IKsControl, public IMFSampleAllocatorControl {
public:
  MediaSource() { InitializeCriticalSection(&cs_); InterlockedIncrement(&g_objects); }
  ~MediaSource() { DeleteCriticalSection(&cs_); InterlockedDecrement(&g_objects); }

  HRESULT Initialize() {
    HRESULT hr = MFCreateEventQueue(&queue_); if (FAILED(hr)) return hr;
    hr = MFCreateAttributes(&attributes_, 4); if (FAILED(hr)) return hr;
    stream_.Attach(new (std::nothrow) MediaStream(this));
    if (!stream_) return E_OUTOFMEMORY;
    hr = stream_->Initialize(); if (FAILED(hr)) return hr;
    IMFStreamDescriptor* sds[1] = { stream_->Descriptor() };
    hr = MFCreatePresentationDescriptor(1, sds, &pd_); if (FAILED(hr)) return hr;
    return pd_->SelectStream(0);
  }

  // IUnknown
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == __uuidof(IMFMediaEventGenerator) || riid == __uuidof(IMFMediaSource) || riid == __uuidof(IMFMediaSourceEx))
      *ppv = static_cast<IMFMediaSourceEx*>(this);
    else if (riid == __uuidof(IMFGetService)) *ppv = static_cast<IMFGetService*>(this);
    else if (riid == __uuidof(IKsControl)) *ppv = static_cast<IKsControl*>(this);
    else if (riid == __uuidof(IMFSampleAllocatorControl)) *ppv = static_cast<IMFSampleAllocatorControl*>(this);
    else { *ppv = nullptr; return E_NOINTERFACE; }
    AddRef(); return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref_); }
  STDMETHODIMP_(ULONG) Release() override { ULONG r = InterlockedDecrement(&ref_); if (!r) delete this; return r; }

  // IMFMediaEventGenerator
  STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** ev) override { ComPtr<IMFMediaEventQueue> q; { Lock l(&cs_); if (!queue_) return MF_E_SHUTDOWN; q = queue_; } return q->GetEvent(flags, ev); }
  STDMETHODIMP BeginGetEvent(IMFAsyncCallback* cb, IUnknown* st) override { Lock l(&cs_); if (!queue_) return MF_E_SHUTDOWN; return queue_->BeginGetEvent(cb, st); }
  STDMETHODIMP EndGetEvent(IMFAsyncResult* r, IMFMediaEvent** ev) override { Lock l(&cs_); if (!queue_) return MF_E_SHUTDOWN; return queue_->EndGetEvent(r, ev); }
  STDMETHODIMP QueueEvent(MediaEventType t, REFGUID g, HRESULT hr, const PROPVARIANT* v) override { Lock l(&cs_); if (!queue_) return MF_E_SHUTDOWN; return queue_->QueueEventParamVar(t, g, hr, v); }

  // IMFMediaSource
  STDMETHODIMP GetCharacteristics(DWORD* c) override { if (!c) return E_POINTER; Lock l(&cs_); if (!queue_) return MF_E_SHUTDOWN; *c = MFMEDIASOURCE_IS_LIVE; return S_OK; }
  STDMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** pd) override {
    if (!pd) return E_POINTER; Lock l(&cs_); if (!pd_) return MF_E_SHUTDOWN; return pd_->Clone(pd);
  }
  STDMETHODIMP Start(IMFPresentationDescriptor* pd, const GUID* fmt, const PROPVARIANT* pos) override {
    if (!pd) return E_INVALIDARG;
    if (fmt && *fmt != GUID_NULL) return MF_E_UNSUPPORTED_TIME_FORMAT;
    Lock l(&cs_);
    if (!queue_) return MF_E_SHUTDOWN;
    BOOL selected = FALSE; ComPtr<IMFStreamDescriptor> sd;
    HRESULT hr = pd->GetStreamDescriptorByIndex(0, &selected, &sd); if (FAILED(hr)) return hr;
    // apply the media type the caller picked, if any
    ComPtr<IMFMediaTypeHandler> inH, myH; ComPtr<IMFMediaType> t;
    if (SUCCEEDED(sd->GetMediaTypeHandler(&inH)) && SUCCEEDED(inH->GetCurrentMediaType(&t)) &&
        SUCCEEDED(stream_->Descriptor()->GetMediaTypeHandler(&myH)))
      myH->SetCurrentMediaType(t.Get());
    if (selected) {
      PROPVARIANT v; PropVariantInit(&v); v.vt = VT_UNKNOWN; v.punkVal = static_cast<IMFMediaStream2*>(stream_.Get());
      hr = queue_->QueueEventParamVar(running_ ? MEUpdatedStream : MENewStream, GUID_NULL, S_OK, &v); if (FAILED(hr)) return hr;
      hr = stream_->Start(); if (FAILED(hr)) return hr;
    }
    running_ = true;
    PROPVARIANT t0; PropVariantInit(&t0);
    if (pos && pos->vt == VT_I8) t0 = *pos; else { t0.vt = VT_I8; t0.hVal.QuadPart = MFGetSystemTime(); }
    return queue_->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, &t0);
  }
  STDMETHODIMP Stop() override {
    Lock l(&cs_);
    if (!queue_) return MF_E_SHUTDOWN;
    if (stream_) stream_->Stop();
    running_ = false;
    return queue_->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, nullptr);
  }
  STDMETHODIMP Pause() override { return MF_E_INVALID_STATE_TRANSITION; }
  STDMETHODIMP Shutdown() override {
    Lock l(&cs_);
    if (queue_) { queue_->Shutdown(); queue_.Reset(); }
    if (stream_) { stream_->Shutdown(); stream_.Reset(); }
    pd_.Reset(); attributes_.Reset();
    return S_OK;
  }

  // IMFMediaSourceEx
  STDMETHODIMP GetSourceAttributes(IMFAttributes** a) override { if (!a) return E_POINTER; Lock l(&cs_); if (!attributes_) return MF_E_SHUTDOWN; *a = attributes_.Get(); (*a)->AddRef(); return S_OK; }
  STDMETHODIMP GetStreamAttributes(DWORD id, IMFAttributes** a) override {
    if (!a) return E_POINTER; if (id != 0) return MF_E_INVALIDSTREAMNUMBER;
    Lock l(&cs_); if (!stream_) return MF_E_SHUTDOWN;
    return stream_->Descriptor()->QueryInterface(IID_PPV_ARGS(a));
  }
  STDMETHODIMP SetD3DManager(IUnknown*) override { return S_OK; }   // we build frames on the CPU

  // IMFGetService
  STDMETHODIMP GetService(REFGUID, REFIID, LPVOID* p) override { if (p) *p = nullptr; return MF_E_UNSUPPORTED_SERVICE; }

  // IKsControl: no custom camera properties
  STDMETHODIMP KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }
  STDMETHODIMP KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }
  STDMETHODIMP KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }

  // IMFSampleAllocatorControl: we make our own samples
  STDMETHODIMP SetDefaultAllocator(DWORD, IUnknown*) override { return S_OK; }
  STDMETHODIMP GetAllocatorUsage(DWORD id, DWORD* inId, MFSampleAllocatorUsage* usage) override {
    if (!inId || !usage) return E_POINTER; if (id != 0) return MF_E_INVALIDSTREAMNUMBER;
    *inId = id; *usage = MFSampleAllocatorUsage_UsesCustomAllocator; return S_OK;
  }

private:
  volatile ULONG ref_ = 1;
  CRITICAL_SECTION cs_;
  ComPtr<IMFMediaEventQueue> queue_;
  ComPtr<IMFAttributes> attributes_;
  ComPtr<IMFPresentationDescriptor> pd_;
  ComPtr<MediaStream> stream_;
  bool running_ = false;
};

STDMETHODIMP MediaStream::GetMediaSource(IMFMediaSource** ms) {
  if (!ms) return E_POINTER;
  Lock l(&cs_);
  if (!source_) return MF_E_SHUTDOWN;
  return source_->QueryInterface(IID_PPV_ARGS(ms));
}

// ---------------------------------------------------------------------------------------------
// Activator (what the Frame Server creates from our CLSID)
// ---------------------------------------------------------------------------------------------
#define FWD(call) { if (!attrs_) return E_UNEXPECTED; return attrs_->call; }
class Activator : public IMFActivate {
public:
  Activator() { InterlockedIncrement(&g_objects); }
  ~Activator() { InterlockedDecrement(&g_objects); }
  HRESULT Initialize() { return MFCreateAttributes(&attrs_, 4); }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == __uuidof(IMFAttributes) || riid == __uuidof(IMFActivate)) { *ppv = static_cast<IMFActivate*>(this); AddRef(); return S_OK; }
    *ppv = nullptr; return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref_); }
  STDMETHODIMP_(ULONG) Release() override { ULONG r = InterlockedDecrement(&ref_); if (!r) delete this; return r; }

  STDMETHODIMP ActivateObject(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (!source_) {
      ComPtr<MediaSource> s; s.Attach(new (std::nothrow) MediaSource());
      if (!s) return E_OUTOFMEMORY;
      HRESULT hr = s->Initialize(); if (FAILED(hr)) return hr;
      source_ = s;
    }
    return source_->QueryInterface(riid, ppv);
  }
  STDMETHODIMP ShutdownObject() override { if (source_) { source_->Shutdown(); source_.Reset(); } return S_OK; }
  STDMETHODIMP DetachObject() override { source_.Reset(); return S_OK; }

  // IMFAttributes → forward to an internal attribute store
  STDMETHODIMP GetItem(REFGUID k, PROPVARIANT* v) override FWD(GetItem(k, v))
  STDMETHODIMP GetItemType(REFGUID k, MF_ATTRIBUTE_TYPE* t) override FWD(GetItemType(k, t))
  STDMETHODIMP CompareItem(REFGUID k, REFPROPVARIANT v, BOOL* r) override FWD(CompareItem(k, v, r))
  STDMETHODIMP Compare(IMFAttributes* a, MF_ATTRIBUTES_MATCH_TYPE m, BOOL* r) override FWD(Compare(a, m, r))
  STDMETHODIMP GetUINT32(REFGUID k, UINT32* v) override FWD(GetUINT32(k, v))
  STDMETHODIMP GetUINT64(REFGUID k, UINT64* v) override FWD(GetUINT64(k, v))
  STDMETHODIMP GetDouble(REFGUID k, double* v) override FWD(GetDouble(k, v))
  STDMETHODIMP GetGUID(REFGUID k, GUID* v) override FWD(GetGUID(k, v))
  STDMETHODIMP GetStringLength(REFGUID k, UINT32* v) override FWD(GetStringLength(k, v))
  STDMETHODIMP GetString(REFGUID k, LPWSTR s, UINT32 n, UINT32* l) override FWD(GetString(k, s, n, l))
  STDMETHODIMP GetAllocatedString(REFGUID k, LPWSTR* s, UINT32* l) override FWD(GetAllocatedString(k, s, l))
  STDMETHODIMP GetBlobSize(REFGUID k, UINT32* v) override FWD(GetBlobSize(k, v))
  STDMETHODIMP GetBlob(REFGUID k, UINT8* b, UINT32 n, UINT32* s) override FWD(GetBlob(k, b, n, s))
  STDMETHODIMP GetAllocatedBlob(REFGUID k, UINT8** b, UINT32* s) override FWD(GetAllocatedBlob(k, b, s))
  STDMETHODIMP GetUnknown(REFGUID k, REFIID r, LPVOID* p) override FWD(GetUnknown(k, r, p))
  STDMETHODIMP SetItem(REFGUID k, REFPROPVARIANT v) override FWD(SetItem(k, v))
  STDMETHODIMP DeleteItem(REFGUID k) override FWD(DeleteItem(k))
  STDMETHODIMP DeleteAllItems() override FWD(DeleteAllItems())
  STDMETHODIMP SetUINT32(REFGUID k, UINT32 v) override FWD(SetUINT32(k, v))
  STDMETHODIMP SetUINT64(REFGUID k, UINT64 v) override FWD(SetUINT64(k, v))
  STDMETHODIMP SetDouble(REFGUID k, double v) override FWD(SetDouble(k, v))
  STDMETHODIMP SetGUID(REFGUID k, REFGUID v) override FWD(SetGUID(k, v))
  STDMETHODIMP SetString(REFGUID k, LPCWSTR v) override FWD(SetString(k, v))
  STDMETHODIMP SetBlob(REFGUID k, const UINT8* b, UINT32 n) override FWD(SetBlob(k, b, n))
  STDMETHODIMP SetUnknown(REFGUID k, IUnknown* p) override FWD(SetUnknown(k, p))
  STDMETHODIMP LockStore() override FWD(LockStore())
  STDMETHODIMP UnlockStore() override FWD(UnlockStore())
  STDMETHODIMP GetCount(UINT32* n) override FWD(GetCount(n))
  STDMETHODIMP GetItemByIndex(UINT32 i, GUID* k, PROPVARIANT* v) override FWD(GetItemByIndex(i, k, v))
  STDMETHODIMP CopyAllItems(IMFAttributes* d) override FWD(CopyAllItems(d))

private:
  volatile ULONG ref_ = 1;
  ComPtr<IMFAttributes> attrs_;
  ComPtr<MediaSource> source_;
};
#undef FWD

// ---------------------------------------------------------------------------------------------
// COM plumbing
// ---------------------------------------------------------------------------------------------
class ClassFactory : public IClassFactory {
public:
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IClassFactory) { *ppv = static_cast<IClassFactory*>(this); AddRef(); return S_OK; }
    *ppv = nullptr; return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return 2; }
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER; *ppv = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    ComPtr<Activator> a; a.Attach(new (std::nothrow) Activator());
    if (!a) return E_OUTOFMEMORY;
    HRESULT hr = a->Initialize(); if (FAILED(hr)) return hr;
    return a->QueryInterface(riid, ppv);
  }
  STDMETHODIMP LockServer(BOOL lock) override { if (lock) InterlockedIncrement(&g_locks); else InterlockedDecrement(&g_locks); return S_OK; }
};
static ClassFactory g_factory;

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv) {
  if (clsid != CLSID_GcsCamSource) return CLASS_E_CLASSNOTAVAILABLE;
  return g_factory.QueryInterface(riid, ppv);
}
STDAPI DllCanUnloadNow() { return (g_objects == 0 && g_locks == 0) ? S_OK : S_FALSE; }

static const wchar_t* kKey = L"Software\\Classes\\CLSID\\" GCS_CLSID_STRING;
STDAPI DllRegisterServer() {
  wchar_t path[MAX_PATH];
  if (!GetModuleFileNameW(g_module, path, MAX_PATH)) return HRESULT_FROM_WIN32(GetLastError());
  HKEY key = nullptr, inproc = nullptr;
  LONG r = RegCreateKeyExW(HKEY_LOCAL_MACHINE, kKey, 0, nullptr, 0, KEY_WRITE, nullptr, &key, nullptr);
  if (r != ERROR_SUCCESS) return HRESULT_FROM_WIN32(r);
  RegSetValueExW(key, nullptr, 0, REG_SZ, (const BYTE*)GCS_FRIENDLY_NAME, (DWORD)sizeof(GCS_FRIENDLY_NAME));
  r = RegCreateKeyExW(key, L"InprocServer32", 0, nullptr, 0, KEY_WRITE, nullptr, &inproc, nullptr);
  if (r == ERROR_SUCCESS) {
    RegSetValueExW(inproc, nullptr, 0, REG_SZ, (const BYTE*)path, (DWORD)((wcslen(path) + 1) * sizeof(wchar_t)));
    const wchar_t both[] = L"Both";
    RegSetValueExW(inproc, L"ThreadingModel", 0, REG_SZ, (const BYTE*)both, (DWORD)sizeof(both));
    RegCloseKey(inproc);
  }
  RegCloseKey(key);
  return HRESULT_FROM_WIN32(r);
}
STDAPI DllUnregisterServer() {
  LONG r = RegDeleteTreeW(HKEY_LOCAL_MACHINE, kKey);
  return (r == ERROR_SUCCESS || r == ERROR_FILE_NOT_FOUND) ? S_OK : HRESULT_FROM_WIN32(r);
}

BOOL APIENTRY DllMain(HMODULE m, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) { g_module = m; DisableThreadLibraryCalls(m); }
  return TRUE;
}
