// Resolver: anh xa ten ham steamclient -> dia chi that trong RAM, dua tren bo toml
// cua steam-monitor (nhanh `pattern` + `ipc`), tra cuu theo SHA-256 cua steamclient64.dll.
//
// Vi file toml duoc dat ten = sha256(steamclient64.dll) nen chi can hash dung ban
// steamclient dang nap la co RVA chinh xac cho dung ban do -> ben voi update Steam.
#pragma once
#include "toml.hpp"
#include "crypto.hpp"
#include "log.hpp"
#include <windows.h>
#include <string>
#include <map>
#include <vector>
#include <fstream>

namespace g4 {

struct FuncInfo { uint64_t rva = 0; std::string sig; void* addr = nullptr; };

struct IpcMethod { int methodIndex = -1; void* addr = nullptr; };
struct IpcIface  { uint64_t vtableRva = 0; void** vtable = nullptr;
                   std::map<std::string, IpcMethod> methods; };

class Resolver {
public:
    HMODULE self = nullptr;                       // DLL cua ta (de biet thu muc data)
    uintptr_t base = 0;                            // base steamclient64.dll
    std::string hash;                              // sha256 hex
    std::map<std::string, FuncInfo> funcs;         // pattern: ten -> ham
    std::map<std::string, IpcIface> ifaces;        // ipc: interface -> {vtable, methods}
    std::map<std::string, uint64_t> layout;        // [layout]: offset/flag do RE dien (vd owns_offset)

    explicit Resolver(HMODULE me) : self(me) {}

    // Gia tri trong [layout] (pattern toml) hoac file override; def neu khong co.
    uint64_t lay(const std::string& k, uint64_t def = 0) const {
        auto it = layout.find(k); return it == layout.end() ? def : it->second;
    }

    // Cho den khi steam.exe nap steamclient64.dll (Steam nap tre sau khoi dong).
    bool waitForSteamclient(DWORD timeoutMs = 120000) {
        DWORD t0 = GetTickCount();
        HMODULE h = nullptr;
        while (!(h = GetModuleHandleW(L"steamclient64.dll"))) {
            if (GetTickCount() - t0 > timeoutMs) return false;
            Sleep(250);
        }
        base = (uintptr_t)h;
        wchar_t path[MAX_PATH]{}; GetModuleFileNameW(h, path, MAX_PATH);
        hash = fileSha256(path);
        logf("[resolver] steamclient64.dll base=%p sha256=%s", (void*)base, hash.c_str());
        return base != 0 && !hash.empty();
    }

    bool loadTables() {
        if (hash.empty()) return false;
        std::wstring dir = moduleDir(self);
        std::string ptxt = readFile(dir + L"\\data\\pattern\\" + widen(hash) + L".toml");
        std::string itxt = readFile(dir + L"\\data\\ipc\\" + widen(hash) + L".toml");
        if (ptxt.empty()) { logf("[resolver] THIEU pattern toml cho hash nay (chay tools/sync_steam_monitor.ps1)"); return false; }
        parsePattern(ptxt);
        if (!itxt.empty()) parseIpc(itxt); else logf("[resolver] khong co ipc toml (bo qua phan vtable)");
        // Offset do RE dien tay, GIU QUA resync: data\layout\<hash>.toml de len [layout] cua pattern.
        std::string ltxt = readFile(dir + L"\\data\\layout\\" + widen(hash) + L".toml");
        if (!ltxt.empty()) mergeLayout(ltxt);
        logf("[resolver] resolved %zu ham pattern, %zu interface ipc, %zu gia tri layout",
             funcs.size(), ifaces.size(), layout.size());
        return !funcs.empty();
    }

    void* func(const std::string& name) const {
        auto it = funcs.find(name); return it == funcs.end() ? nullptr : it->second.addr;
    }
    void* ipc(const std::string& iface, const std::string& method) const {
        auto i = ifaces.find(iface); if (i == ifaces.end()) return nullptr;
        auto m = i->second.methods.find(iface + "." + method);
        if (m == i->second.methods.end()) m = i->second.methods.find(method);
        return m == i->second.methods.end() ? nullptr : m->second.addr;
    }

private:
    static std::wstring widen(const std::string& s) { return std::wstring(s.begin(), s.end()); }

    static std::string readFile(const std::wstring& p) {
        std::ifstream f(p, std::ios::binary);
        if (!f) return "";
        return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    }

    static std::string fileSha256(const std::wstring& path) {
        std::ifstream f(path, std::ios::binary);
        if (!f) return "";
        std::vector<uint8_t> d((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        return crypto::sha256Hex(d.data(), d.size());
    }

    // "48 8B C4 ?? .." -> kiem tra byte co dinh tai addr. ?? = bo qua.
    static bool sigMatch(const uint8_t* addr, const std::string& sig) {
        size_t i = 0;
        while (i < sig.size()) {
            while (i < sig.size() && sig[i] == ' ') i++;
            if (i >= sig.size()) break;
            if (sig[i] == '?') { while (i < sig.size() && sig[i] == '?') i++; addr++; continue; }
            int hi = hexd(sig[i]), lo = hexd(sig[i + 1]);
            if (hi < 0 || lo < 0) return false;
            if (*addr != (uint8_t)((hi << 4) | lo)) return false;
            addr++; i += 2;
        }
        return true;
    }
    static int hexd(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }

    // Nap moi key cua section [layout] vao map layout (vd owns_offset = "0x08").
    void mergeLayout(const std::string& txt) {
        for (auto& sec : toml::parse(txt)) {
            if (sec.name != "layout") continue;
            for (auto& kv : sec.kv) layout[kv.first] = toml::toU64(kv.second);
        }
    }

    void parsePattern(const std::string& txt) {
        for (auto& sec : toml::parse(txt)) {
            if (sec.name == "layout") { for (auto& kv : sec.kv) layout[kv.first] = toml::toU64(kv.second); continue; }
            auto n = sec.kv.find("name"); auto r = sec.kv.find("rva");
            if (n == sec.kv.end() || r == sec.kv.end()) continue;
            FuncInfo fi; fi.rva = toml::toU64(r->second);
            auto sg = sec.kv.find("sig"); if (sg != sec.kv.end()) fi.sig = sg->second;
            fi.addr = (void*)(base + fi.rva);
            if (!fi.sig.empty() && !sigMatch((const uint8_t*)fi.addr, fi.sig))
                logf("[resolver] CANH BAO: sig khong khop cho %s @%p (RVA co the le ban)",
                     n->second.c_str(), fi.addr);
            funcs[n->second] = fi;
        }
    }

    void parseIpc(const std::string& txt) {
        std::string curIface;
        for (auto& sec : toml::parse(txt)) {
            if (sec.name.find('.') == std::string::npos) {
                // [IClientUser]
                IpcIface ifc;
                auto v = sec.kv.find("vtable_rva");
                ifc.vtableRva = v == sec.kv.end() ? 0 : toml::toU64(v->second);
                ifc.vtable = (void**)(base + ifc.vtableRva);
                ifaces[sec.name] = ifc; curIface = sec.name;
            } else {
                // [IClientUser.GetAppID]
                std::string iface = sec.name.substr(0, sec.name.find('.'));
                auto it = ifaces.find(iface); if (it == ifaces.end()) continue;
                auto mi = sec.kv.find("method_index"); if (mi == sec.kv.end()) continue;
                IpcMethod m; m.methodIndex = (int)toml::toU64(mi->second);
                if (it->second.vtable && m.methodIndex >= 0)
                    m.addr = it->second.vtable[m.methodIndex];   // vtable[idx] = dia chi ham
                it->second.methods[sec.name] = m;
            }
        }
    }
};

} // namespace g4
