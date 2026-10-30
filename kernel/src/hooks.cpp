// ============================================================================
//  Hook steamclient de bao "da so huu" + quan sat duong lay ticket Denuvo.
//
//  Ticket nap vao g_tickets tu CA HAI nguon (loadAllCwk + loadLuaTickets): file .cwk
//  (lua da ma hoa) va denuvo_g4play.lua (lua tron) — cung 1 parser.
//
//  DIA CHI ham lay tu RE (data/pattern + data/ipc, theo sha256 steamclient):
//   - CheckAppOwnership   : RVA rieng + sig -> hook native truc tiep (ep owned).
//   - SpawnProcess / BuildSpawnEnvBlock : diem chen ticket vao env game (quan sat).
//   - RequestEncryptedAppTicket : target rieng -> hook quan sat (duong Denuvo).
//     GetEncryptedAppTicket + GetAppOwnershipTicketExtendedData DUNG CHUNG 1 stub IPC
//     (target_rva trung) -> KHONG hook thang (se bat nham nhieu method).
//
//  CAI CON PHAI RE TREN MAY (danh dau // >>> CAN HOAN THIEN):
//   - Offset field "owned" trong CAppOwnershipInfo: chua co trong toml -> hook tam
//     DUMP pInfo ra kernel.log de ban doi chieu, roi dien owns_offset vao [layout]
//     cua data/layout/<hash>.toml (giu qua resync). Co offset la ep owned that su.
//   - Phuc vu eticket qua IPC can RE marshalling (IPCProcessMessage dispatch theo
//     funcHash). Trong luc do eticket VAN duoc phuc vu qua lua setETicket + registry
//     (SteamTools/xinput doc) nen Denuvo van qua — kernel la kenh bo tro.
// ============================================================================
#include "hooks.hpp"
#include "cwk.hpp"
#include "log.hpp"
#include <MinHook.h>
#include <windows.h>
#include <map>
#include <set>
#include <string>
#include <cstdint>

using namespace g4;

namespace {

std::map<uint32_t, CwkTicket> g_tickets;    // appid -> ticket (tu .cwk + .lua)

// Config ownership — nap tu [layout] cua toml (RE xong dien, khong can recompile).
uint32_t g_ownForce   = 1;   // 1 = ep CheckAppOwnership tra "owned" cho appid co ticket
uint32_t g_ownResult  = 1;   // gia tri tra ve coi la owned (EResult k_EResultOK = 1)
uint32_t g_ownsOffset = 0;   // offset field "owned" trong CAppOwnershipInfo (0 = chua RE)
uint32_t g_ownsValue  = 1;   // gia tri set vao field do

// ---- helpers an toan (SEH tach rieng, khong dinh C++ unwinding) ----
bool safeWriteU32(void* p, uint32_t v) {
    if (!p) return false;
    __try { *(volatile uint32_t*)p = v; return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
// Doc <= n byte tai p (an toan) -> hex vao out. Tra so byte doc duoc.
size_t safeHexDump(const void* p, size_t n, char* out, size_t outSz) {
    if (!p || !out || outSz < 3) { if (out && outSz) out[0] = 0; return 0; }
    static const char hx[] = "0123456789abcdef";
    size_t got = 0, oi = 0;
    for (size_t i = 0; i < n && oi + 3 < outSz; i++) {
        uint8_t b = 0;
        __try { b = ((const volatile uint8_t*)p)[i]; }
        __except (EXCEPTION_EXECUTE_HANDLER) { break; }
        out[oi++] = hx[b >> 4]; out[oi++] = hx[b & 0xF]; out[oi++] = ' ';
        got++;
    }
    out[oi] = 0;
    return got;
}

std::set<uint32_t> g_logged;
bool firstTime(uint32_t appId) {                     // true dung LAN DAU thay appid (chong spam log)
    if (g_logged.count(appId)) return false;
    g_logged.insert(appId); return true;
}
void dumpOwnership(uint32_t appId, void* pInfo) {
    char buf[64 * 3 + 1];
    size_t got = safeHexDump(pInfo, 64, buf, sizeof(buf));
    logf("[RE] CAppOwnershipInfo(appid=%u) %zu byte dau: %s", appId, got, buf);
    logf("[RE] -> so sanh voi 1 game SO HUU THAT, tim byte doi 00->01, dien owns_offset=<n> "
         "vao data\\layout\\<hash>.toml roi mo lai Steam.");
}

// ---- CheckAppOwnership: ham co RVA rieng + sig -> hook native truc tiep ----
// Chu ky (tu RE): int CheckAppOwnership(void* self, AppId_t appId, CAppOwnershipInfo* pInfo).
using Fn_CheckAppOwnership = int (*)(void* self, uint32_t appId, void* pInfo);
Fn_CheckAppOwnership o_CheckAppOwnership = nullptr;
int hk_CheckAppOwnership(void* self, uint32_t appId, void* pInfo) {
    int r = o_CheckAppOwnership ? o_CheckAppOwnership(self, appId, pInfo) : 0;
    if (g_tickets.find(appId) == g_tickets.end()) return r;   // chi dong vao appid co ticket cua ta
    bool first = firstTime(appId);                            // log 1 lan/appid (ham nay goi rat nhieu)
    if (first) dumpOwnership(appId, pInfo);                   // de RE offset
    if (g_ownsOffset && pInfo) {                              // da co offset -> ep owned that su
        if (!safeWriteU32((uint8_t*)pInfo + g_ownsOffset, g_ownsValue) && first)
            logf("[hook] set owns_offset=0x%X loi (offset sai?)", g_ownsOffset);
    }
    if (g_ownForce) {
        if (first)
            logf("[hook] CheckAppOwnership(appid=%u) goc=%d -> ep tra %u%s",
                 appId, r, g_ownResult, g_ownsOffset ? " + set owns field" : " (chua co owns_offset)");
        return (int)g_ownResult;
    }
    return r;
}

// ---- Quan sat: pass-through an toan (x64: <=4 arg o thanh ghi; dung 7-slot cho chac) ----
using Fn_Generic7 = void* (*)(void*, void*, void*, void*, void*, void*, void*);
Fn_Generic7 o_SpawnProcess = nullptr, o_BuildSpawnEnvBlock = nullptr;
void* hk_SpawnProcess(void* a, void* b, void* c, void* d, void* e, void* f, void* g) {
    logf("[hook] SpawnProcess (game sap chay) — diem chen ownership ticket vao env. >>> CAN HOAN THIEN RE");
    return o_SpawnProcess ? o_SpawnProcess(a, b, c, d, e, f, g) : nullptr;
}
void* hk_BuildSpawnEnvBlock(void* a, void* b, void* c, void* d, void* e, void* f, void* g) {
    logf("[hook] BuildSpawnEnvBlock — Steam dung env block cho game (ticket di qua day).");
    return o_BuildSpawnEnvBlock ? o_BuildSpawnEnvBlock(a, b, c, d, e, f, g) : nullptr;
}

using Fn_Generic4 = void* (*)(void*, void*, void*, void*);
Fn_Generic4 o_ReqEncTicket = nullptr;
void* hk_ReqEncTicket(void* a, void* b, void* c, void* d) {
    logf("[hook] RequestEncryptedAppTicket — game xin encrypted app ticket (duong Denuvo).");
    return o_ReqEncTicket ? o_ReqEncTicket(a, b, c, d) : nullptr;
}

bool createHook(void* target, void* detour, void** orig, const char* name) {
    if (!target) { logf("[hook] bo qua %s: khong resolve duoc dia chi", name); return false; }
    MH_STATUS s = MH_CreateHook(target, detour, orig);
    if (s != MH_OK) { logf("[hook] MH_CreateHook(%s) loi: %d", name, (int)s); return false; }
    logf("[hook] da tao hook %s @%p", name, target);
    return true;
}

// Nhan 1 ticket vao map: giu ban MOI nhat (created lon hon) neu appid trung o nhieu nguon.
void mergeTicket(CwkTicket&& t) {
    if (!t.valid) return;
    auto it = g_tickets.find(t.appid);
    if (it == g_tickets.end() || t.created >= it->second.created)
        g_tickets[t.appid] = std::move(t);
}

void loadAllCwk(const std::wstring& dir) {
    WIN32_FIND_DATAW fd;
    std::wstring pat = dir + L"\\*.cwk";
    HANDLE h = FindFirstFileW(pat.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) { logf("[cwk] khong co file .cwk trong %ls", dir.c_str()); return; }
    size_t n = 0;
    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        CwkTicket t = cwkLoad(dir + L"\\" + fd.cFileName);
        if (t.valid) { mergeTicket(std::move(t)); ++n; }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    logf("[cwk] da nap %zu ticket tu .cwk", n);
}

// Nap ticket tu file .lua TRON (denuvo_g4play.lua) o ca hai thu muc lua cua Steam.
void loadLuaTickets(const std::wstring& steamDir) {
    const wchar_t* luaFiles[] = {
        L"\\config\\lua\\denuvo_g4play.lua",
        L"\\config\\stplug-in\\denuvo_g4play.lua",
    };
    size_t n = 0;
    for (const wchar_t* sub : luaFiles)
        for (CwkTicket& t : luaLoadFile(steamDir + sub)) { mergeTicket(std::move(t)); ++n; }
    if (n) logf("[lua] da nap %zu block ticket tu denuvo_g4play.lua", n);
}

} // namespace

namespace g4::hooks {

bool install(Resolver& r, const std::wstring& steamDir) {
    loadAllCwk(steamDir + L"\\cwk");     // nguon 1: .cwk (lua da ma hoa)
    loadLuaTickets(steamDir);            // nguon 2: denuvo_g4play.lua (lua tron)
    logf("[tickets] tong cong %zu ticket (cwk + lua)", g_tickets.size());

    // Config ownership tu [layout] (pattern toml hoac data\layout\<hash>.toml).
    g_ownForce   = (uint32_t)r.lay("own_force", 1);
    g_ownResult  = (uint32_t)r.lay("own_result_value", 1);
    g_ownsOffset = (uint32_t)r.lay("owns_offset", 0);
    g_ownsValue  = (uint32_t)r.lay("owns_value", 1);
    logf("[hook] cau hinh ownership: force=%u result=%u owns_offset=0x%X owns_value=%u%s",
         g_ownForce, g_ownResult, g_ownsOffset, g_ownsValue,
         g_ownsOffset ? "" : " (chua RE offset -> se dump pInfo de doi chieu)");

    if (MH_Initialize() != MH_OK) { logf("[hook] MH_Initialize that bai"); return false; }

    createHook(r.func("CheckAppOwnership"),  (void*)&hk_CheckAppOwnership,  (void**)&o_CheckAppOwnership,  "CheckAppOwnership");
    createHook(r.func("SpawnProcess"),       (void*)&hk_SpawnProcess,       (void**)&o_SpawnProcess,       "SpawnProcess");
    createHook(r.func("BuildSpawnEnvBlock"), (void*)&hk_BuildSpawnEnvBlock, (void**)&o_BuildSpawnEnvBlock, "BuildSpawnEnvBlock");

    // Duong lay encrypted app ticket (Denuvo).
    void* getEnc  = r.ipc("IClientUser", "GetEncryptedAppTicket");
    void* reqEnc  = r.ipc("IClientUser", "RequestEncryptedAppTicket");
    void* extData = r.ipc("IClientUser", "GetAppOwnershipTicketExtendedData");
    logf("[hook] IClientUser GetEncryptedAppTicket=%p RequestEncryptedAppTicket=%p ExtData=%p",
         getEnc, reqEnc, extData);
    if (reqEnc && reqEnc != getEnc && reqEnc != extData)
        createHook(reqEnc, (void*)&hk_ReqEncTicket, (void**)&o_ReqEncTicket, "RequestEncryptedAppTicket");
    else
        logf("[hook] RequestEncryptedAppTicket dung chung stub IPC -> bo qua hook (tranh bat nham).");
    // >>> CAN HOAN THIEN: phuc vu eticket that qua IPC can RE marshalling. Hien eticket
    //     van phuc vu qua lua setETicket + registry (SteamTools/xinput doc).

    if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) { logf("[hook] MH_EnableHook that bai"); return false; }
    logf("[hook] da bat tat ca hook.");
    return true;
}

void uninstall() {
    MH_DisableHook(MH_ALL_HOOKS);
    MH_Uninitialize();
}

} // namespace g4::hooks
