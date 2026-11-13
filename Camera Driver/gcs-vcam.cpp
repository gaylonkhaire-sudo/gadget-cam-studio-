// gcs-vcam.exe: installs or removes the "Gadget Cam Studio" camera. Run as administrator (the app installer does this).
//   gcs-vcam install     register the camera component and add the camera to Windows
//   gcs-vcam uninstall   remove the camera and unregister the component
//   gcs-vcam status      print whether the camera is supported/installed
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <wchar.h>
#include <string.h>
#include <mfapi.h>
#include <mfvirtualcamera.h>
#include <stdio.h>
#include "shared.h"

typedef HRESULT(WINAPI* PFN_MFCreateVirtualCamera)(MFVirtualCameraType, MFVirtualCameraLifetime, MFVirtualCameraAccess,
                                                   LPCWSTR, LPCWSTR, const GUID*, ULONG, IMFVirtualCamera**);

static int fail(const char* what, HRESULT hr) { fprintf(stderr, "%s failed (0x%08lX)\n", what, (unsigned long)hr); return 1; }

static HRESULT callDll(const char* fn) {
  wchar_t path[MAX_PATH]; GetModuleFileNameW(nullptr, path, MAX_PATH);
  wchar_t* slash = wcsrchr(path, L'\\'); if (slash) *(slash + 1) = 0;
  wcscat_s(path, L"GcsCamSource.dll");
  HMODULE m = LoadLibraryW(path);
  if (!m) return HRESULT_FROM_WIN32(GetLastError());
  typedef HRESULT(STDAPICALLTYPE* PFN)();
  PFN f = (PFN)GetProcAddress(m, fn);
  HRESULT hr = f ? f() : HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
  FreeLibrary(m);
  return hr;
}

static HRESULT makeCamera(IMFVirtualCamera** cam) {
  HMODULE sg = LoadLibraryW(L"mfsensorgroup.dll");
  PFN_MFCreateVirtualCamera create = sg ? (PFN_MFCreateVirtualCamera)GetProcAddress(sg, "MFCreateVirtualCamera") : nullptr;
  if (!create) return HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED);      // Windows 10: no virtual camera API
  return create(MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_System, MFVirtualCameraAccess_AllUsers,
                GCS_FRIENDLY_NAME, GCS_CLSID_STRING, nullptr, 0, cam);
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) { printf("usage: gcs-vcam install | uninstall | status\n"); return 1; }
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  MFStartup(MF_VERSION);
  int rc = 0;
  if (!_wcsicmp(argv[1], L"install")) {
    HRESULT hr = callDll("DllRegisterServer");
    if (FAILED(hr)) rc = fail("Registering the camera component", hr);
    else {
      IMFVirtualCamera* cam = nullptr;
      hr = makeCamera(&cam);
      if (hr == HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED)) { printf("This version of Windows has no virtual camera support (Windows 11 needed).\n"); rc = 2; }
      else if (FAILED(hr)) rc = fail("Creating the camera", hr);
      else {
        hr = cam->Start(nullptr);
        if (FAILED(hr)) rc = fail("Starting the camera", hr); else printf("Gadget Cam Studio camera installed.\n");
        cam->Shutdown(); cam->Release();
      }
    }
  } else if (!_wcsicmp(argv[1], L"uninstall")) {
    IMFVirtualCamera* cam = nullptr;
    if (SUCCEEDED(makeCamera(&cam))) { cam->Remove(); cam->Shutdown(); cam->Release(); }
    callDll("DllUnregisterServer");
    printf("Gadget Cam Studio camera removed.\n");
  } else if (!_wcsicmp(argv[1], L"status")) {
    HMODULE sg = LoadLibraryW(L"mfsensorgroup.dll");
    bool api = sg && GetProcAddress(sg, "MFCreateVirtualCamera");
    HKEY k; bool reg = RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"Software\\Classes\\CLSID\\" GCS_CLSID_STRING, 0, KEY_READ, &k) == ERROR_SUCCESS;
    if (reg) RegCloseKey(k);
    printf("virtual camera support: %s\ncomponent registered: %s\n", api ? "yes" : "no", reg ? "yes" : "no");
    rc = api && reg ? 0 : 3;
  } else { printf("unknown command\n"); rc = 1; }
  MFShutdown();
  CoUninitialize();
  return rc;
}
