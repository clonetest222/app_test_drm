// ============================================================================
//  g4 loader — proxy dwmapi.dll (dat o Steam\bin) -> nap xinput1_4.dll (engine).
//
//  Mo phong y het bin\dwmapi.dll cua CaigamerQ:
//    - DllMain(PROCESS_ATTACH): dung bang con tro ham that cua dwmapi (System32) de
//      forward moi export Dwm* (dwmapi_thunks.asm jmp qua g_realProcs[]). Nho vay DWM
//      cua host van chay binh thuong.
//    - Neu host la steam.exe -> LoadLibrary("xinput1_4.dll") (engine OpenSteamTool
//      merged, da co GetSteamID spoof). Engine tu khoi dong trong DllMain cua no.
//  Khac CaigamerQ: nap "xinput1_4.dll" thay vi "CaigamerQ.dll".
//
//  Deploy:  <Steam>\bin\dwmapi.dll  (file nay)  +  <Steam>\xinput1_4.dll (Release10).
// ============================================================================
#include <windows.h>
#include <string>

// g_realProcs[119] + initRealProcs() + g_realDwm : copy System32\dwmapi.dll ra temp,
// nap, GetProcAddress tung export vao bang. Export cua ta jmp qua bang nay.
#include "dwmapi_realprocs.inc"

static HMODULE g_self = nullptr;

// --- log nhe (mo "ab" = append binary, tranh loi CRT invalid-parameter) ---
static std::wstring selfDir() {
    wchar_t path[MAX_PATH]{}; GetModuleFileNameW(g_self, path, MAX_PATH);
    std::wstring p(path); size_t s = p.find_last_of(L"\\/");
    return s == std::wstring::npos ? L"." : p.substr(0, s);
}
static void logf(const char* fmt, ...) {
    std::wstring lp = selfDir() + L"\\g4loader.log";
    FILE* f = _wfopen(lp.c_str(), L"ab");
    if (!f) return;
    char buf[1024];
    va_list ap; va_start(ap, fmt);
    int n = _vsnprintf(buf, sizeof(buf) - 2, fmt, ap);
    va_end(ap);
    if (n < 0) n = (int)sizeof(buf) - 2;
    buf[n] = '\n'; buf[n + 1] = 0;
    fputs(buf, f);
    fclose(f);
}

static std::wstring hostExeName() {
    wchar_t path[MAX_PATH]{}; GetModuleFileNameW(nullptr, path, MAX_PATH);
    std::wstring p(path); size_t s = p.find_last_of(L"\\/");
    return s == std::wstring::npos ? p : p.substr(s + 1);
}
static std::wstring hostDir() {
    wchar_t path[MAX_PATH]{}; GetModuleFileNameW(nullptr, path, MAX_PATH);
    std::wstring p(path); size_t s = p.find_last_of(L"\\/");
    return s == std::wstring::npos ? L"." : p.substr(0, s);
}

static int _wcsicmp_eq(const std::wstring& a, const wchar_t* b) {
    return _wcsicmp(a.c_str(), b) == 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_self = inst;
        DisableThreadLibraryCalls(inst);

        // (1) Dung proxy dwmapi THAT truoc khi host goi bat ky export Dwm* nao.
        initRealProcs();

        std::wstring host = hostExeName();
        logf("[g4loader] attach host=%ls realDwm=%p proc0=%p",
             host.c_str(), (void*)g_realDwm, g_realProcs[0]);

        // (2) Chi nap engine khi host la steam.exe (giong CaigamerQ).
        if (_wcsicmp_eq(host, L"steam.exe")) {
            std::wstring xi = hostDir() + L"\\xinput1_4.dll";   // engine canh steam.exe (Steam root)
            HMODULE h = LoadLibraryW(xi.c_str());
            if (h) logf("[g4loader] loaded engine %ls -> %p", xi.c_str(), (void*)h);
            else   logf("[g4loader] FAILED load %ls err=%lu", xi.c_str(), GetLastError());
        }
    }
    return TRUE;
}
