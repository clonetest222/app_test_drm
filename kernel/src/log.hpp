// Log don gian ra file ben canh DLL (kernel.log). Khong dung cout vi chay trong steam.exe.
#pragma once
#include <windows.h>
#include <string>
#include <cstdio>
#include <cstdarg>

namespace g4 {

inline std::wstring moduleDir(HMODULE self) {
    wchar_t buf[MAX_PATH]{};
    GetModuleFileNameW(self, buf, MAX_PATH);
    std::wstring p(buf);
    size_t s = p.find_last_of(L"\\/");
    return s == std::wstring::npos ? L"." : p.substr(0, s);
}

// Duong dan log — set 1 lan trong DllMain.
inline std::wstring& logPath() { static std::wstring p = L"kernel.log"; return p; }

inline void logf(const char* fmt, ...) {
    char line[2048];
    va_list ap; va_start(ap, fmt);
    _vsnprintf_s(line, sizeof(line), _TRUNCATE, fmt, ap);
    va_end(ap);

    SYSTEMTIME st; GetLocalTime(&st);
    char ts[32];
    _snprintf_s(ts, sizeof(ts), _TRUNCATE, "%02d:%02d:%02d.%03d ",
                st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);

    // QUAN TRONG: mo "ab" (append BINARY), KHONG dung "ccs=UTF-8".
    // Mo ccs=UTF-8 bien stream thanh Unicode-oriented -> ghi bang ham NARROW (fputs)
    // se kich hoat invalid-parameter handler -> __fastfail -> 0xC0000409 (sap ca
    // tien trinh chu, vd steam.exe). Chuoi log la ASCII nen ghi byte truc tiep la du.
    FILE* f = nullptr;
    if (_wfopen_s(&f, logPath().c_str(), L"ab") == 0 && f) {
        fputs(ts, f); fputs(line, f); fputc('\n', f); fclose(f);
    }
}

} // namespace g4
