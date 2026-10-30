// ============================================================================
//  g4market kernel — proxy dwmapi.dll + bootstrap hook steamclient.
//
//  Steam nap dwmapi.dll tu thu muc cua no (DLL search order) -> file nay duoc nap
//  cung process steam.exe. Cac export Dwm* forward thang toi dwmapi THAT trong
//  System32 (xem dwmapi_forwards.h) nen DWM van chay. Rieng ta: o PROCESS_ATTACH
//  tao 1 thread, cho steamclient64.dll nap, resolve ham theo toml cua steam-monitor,
//  nap .CWK va cai hook.
//
//  Dat file: doi ten ban build (g4kernel.dll) -> dwmapi.dll, chep vao thu muc Steam
//  (canh steam.exe). Kem thu muc:  data\pattern, data\ipc  (toml) va  cwk\ (.cwk).
// ============================================================================
#include "resolver.hpp"
#include "hooks.hpp"
#include "log.hpp"
#include <windows.h>
#include <string>
#include <cwctype>

// Proxy 1-FILE: thay forwarder bang trampoline. g_realProcs + initRealProcs do file
// TU SINH cung cap; export (dwmapi_thunks.asm + dwmapi_proxy.def) jmp qua bang nay.
// Nho vay chi can 1 dwmapi.dll, khong can dwmreal.dll.
#include "dwmapi_realprocs.inc"

static HMODULE g_self = nullptr;

static std::wstring hostExe() {
    wchar_t path[MAX_PATH]{}; GetModuleFileNameW(nullptr, path, MAX_PATH);
    std::wstring p(path);
    size_t s = p.find_last_of(L"\\/");
    return s == std::wstring::npos ? p : p.substr(s + 1);
}

// Thu muc STEAM ROOT = thu muc chua steam.exe (host exe). KHAC thu muc DLL khi DLL
// nam o Steam\bin -> ticket (cwk, config\lua) van o Steam root, khong o bin.
static std::wstring hostDir() {
    wchar_t path[MAX_PATH]{}; GetModuleFileNameW(nullptr, path, MAX_PATH);
    std::wstring p(path);
    size_t s = p.find_last_of(L"\\/");
    return s == std::wstring::npos ? L"." : p.substr(0, s);
}

static DWORD WINAPI bootstrap(LPVOID) {
    g4::logf("[proxy] g_realDwm=%p g_realProcs[0]=%p (dien trong DllMain)", (void*)g_realDwm, g_realProcs[0]);
    g4::logf("========== g4market kernel bootstrap (host=%ls) ==========", hostExe().c_str());
    static g4::Resolver r(g_self);
    // Dat trong Steam\bin -> process nap dwmapi co the KHONG phai steam.exe. Khong loc
    // theo ten exe nua: cho steamclient64.dll xuat hien (co timeout); process nao khong
    // nap steamclient thi het gio roi thoat yen lang, khong lam gi.
    if (!r.waitForSteamclient(90000)) { g4::logf("[boot] process nay khong nap steamclient64.dll -> thoat."); return 0; }
    if (!r.loadTables())              { g4::logf("[boot] khong nap duoc bang pattern/ipc -> dung."); return 0; }
    // steamDir = thu muc steam.exe (Steam root) -> hooks::install nap .cwk (<steam>\cwk)
    // va denuvo_g4play.lua (<steam>\config\{lua,stplug-in}). Dung host-exe-dir chu KHONG
    // dung moduleDir(DLL): khi DLL o Steam\bin thi hai cai khac nhau.
    std::wstring steamRoot = hostDir();
    g4::logf("[boot] steamRoot=%ls (DLL o %ls)", steamRoot.c_str(), g4::moduleDir(g_self).c_str());
    g4::hooks::install(r, steamRoot);
    g4::logf("[boot] xong.");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_self = inst;
        DisableThreadLibraryCalls(inst);
        g4::logPath() = g4::moduleDir(inst) + L"\\kernel.log";
        // Dien bang con tro ham that trong DllMain -> xong TRUOC khi host goi export Dwm*
        // (tranh race). CopyFile + LoadLibrary ban copy ten khac: khong trung basename.
        initRealProcs();
        CreateThread(nullptr, 0, bootstrap, nullptr, 0, nullptr);
    } else if (reason == DLL_PROCESS_DETACH) {
        g4::hooks::uninstall();
    }
    return TRUE;
}
