// Doc ticket Denuvo tu HAI nguon, CUNG mot format lua:
//   * file .cwk  = block lua da ma hoa AES-256-GCM (producer: main.js dvPackCWK)
//   * file .lua  = block lua TRON (denuvo_g4play.lua — chinh app ghi ra)
// -> kernel "phu hop cho ca .CWK va lua": cung parser parseTicketLua() cho ca hai.
//
// Dinh dang .cwk (envelope, khop ben Node dvPackCWK):
//   [0]  magic  6 byte  "G4CWK1"
//   [6]  ver    1 byte  0x01
//   [7]  iv    12 byte  (GCM nonce)
//   [19] tag   16 byte  (GCM tag)
//   [35] ct    con lai  = AES-256-GCM(plaintext, key=SHA256(CWK_SEED), iv, aad="g4cwk-v1")
//
// plaintext (= noi dung .lua, 1+ block, moi block ngan cach bang dong "--"):
//   --denuvo appid=<so> created=<ms> createdAt="..." name=<ten game>
//   setAppTicket(<appid>, "<hex ownership ticket>")
//   setETicket(<appid>, "<hex encrypted app ticket>")
#pragma once
#include "crypto.hpp"
#include "log.hpp"
#include <windows.h>
#include <string>
#include <vector>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <fstream>

namespace g4 {

struct CwkTicket {
    uint32_t appid = 0;
    crypto::Bytes appticket;   // byte tho
    crypto::Bytes eticket;     // byte tho
    std::string name;
    uint64_t created = 0;
    bool valid = false;
};

inline crypto::Bytes hexToBytes(const std::string& h) {
    crypto::Bytes b;
    if (h.size() % 2) return b;
    auto nib = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    b.reserve(h.size() / 2);
    for (size_t i = 0; i < h.size(); i += 2) {
        int hi = nib(h[i]), lo = nib(h[i + 1]);
        if (hi < 0 || lo < 0) { b.clear(); return b; }
        b.push_back((uint8_t)((hi << 4) | lo));
    }
    return b;
}

// ---- tien ich parse 1 dong lua ----
// Chuoi hex trong cap dau nháy dau tien:  fn(123, "DEADBEEF")  -> "DEADBEEF"
inline std::string luaFirstQuoted(const std::string& ln) {
    size_t a = ln.find('"'); if (a == std::string::npos) return "";
    size_t b = ln.find('"', a + 1); if (b == std::string::npos) return "";
    return ln.substr(a + 1, b - a - 1);
}
// So trong cap ngoac dau tien:  setAppTicket(123, ...) -> 123
inline uint32_t luaFirstParenNum(const std::string& ln) {
    size_t a = ln.find('('); if (a == std::string::npos) return 0;
    return (uint32_t)strtoul(ln.c_str() + a + 1, nullptr, 10);
}
// Gia tri so cua "key=" trong dong (vd "created=").
inline uint64_t luaKvNum(const std::string& ln, const char* key) {
    size_t p = ln.find(key); if (p == std::string::npos) return 0;
    return strtoull(ln.c_str() + p + strlen(key), nullptr, 10);
}
// name= la truong CUOI block comment -> lay het phan con lai cua dong (da bo \r).
inline std::string luaNameField(const std::string& ln) {
    size_t p = ln.find("name="); if (p == std::string::npos) return "";
    std::string v = ln.substr(p + 5);
    while (!v.empty() && (v.back() == '\r' || v.back() == ' ' || v.back() == '\t')) v.pop_back();
    return v;
}

// Parse 1+ block ticket tu noi dung lua (ap dung cho ca .cwk giai ma lan file .lua).
inline std::vector<CwkTicket> parseTicketLua(const std::string& s) {
    std::vector<CwkTicket> out;
    // tach theo dong (bo \r)
    std::vector<std::string> lines;
    { std::string cur;
      for (char c : s) { if (c == '\n') { lines.push_back(cur); cur.clear(); } else if (c != '\r') cur.push_back(c); }
      if (!cur.empty()) lines.push_back(cur); }

    CwkTicket t; bool have = false;
    auto flush = [&]() {
        if (have) {
            t.valid = t.appid != 0 && !t.appticket.empty() && !t.eticket.empty();
            if (t.valid) out.push_back(t);
        }
        t = CwkTicket(); have = false;
    };
    for (const std::string& ln : lines) {
        if (ln.find("--denuvo") != std::string::npos || ln.find("-- denuvo") != std::string::npos) {
            flush(); have = true;                       // comment header mo block moi
            t.appid   = (uint32_t)luaKvNum(ln, "appid=");
            t.created = luaKvNum(ln, "created=");
            t.name    = luaNameField(ln);
        } else if (ln.find("setAppTicket") != std::string::npos) {
            have = true; t.appticket = hexToBytes(luaFirstQuoted(ln));
            if (!t.appid) t.appid = luaFirstParenNum(ln);
        } else if (ln.find("setETicket") != std::string::npos) {
            have = true; t.eticket = hexToBytes(luaFirstQuoted(ln));
            if (!t.appid) t.appid = luaFirstParenNum(ln);
        }
    }
    flush();
    return out;
}

// Doc + giai ma 1 file .cwk -> ticket dau tien (1 .cwk = 1 ticket).
inline CwkTicket cwkLoad(const std::wstring& path) {
    CwkTicket t;
    std::ifstream f(path, std::ios::binary);
    if (!f) return t;
    std::vector<uint8_t> raw((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (raw.size() < 35 || memcmp(raw.data(), "G4CWK1", 6) != 0 || raw[6] != 0x01) {
        logf("[cwk] file khong hop le hoac sai magic/version");
        return t;
    }
    const uint8_t* iv = raw.data() + 7;
    const uint8_t* tag = raw.data() + 19;
    const uint8_t* ct = raw.data() + 35;
    size_t ctLen = raw.size() - 35;

    uint8_t key[32]; crypto::cwkKey(key);
    const char* aad = "g4cwk-v1";
    crypto::Bytes pt;
    if (!crypto::aesGcmDecrypt(key, iv, 12, (const uint8_t*)aad, strlen(aad), ct, ctLen, tag, 16, pt)) {
        logf("[cwk] giai ma that bai (sai seed hoac file hong)");
        return t;
    }

    auto v = parseTicketLua(std::string((char*)pt.data(), pt.size()));
    if (v.empty()) { logf("[cwk] giai ma OK nhung khong parse duoc ticket (lua rong?)"); return t; }
    t = v.front();
    if (t.valid)
        logf("[cwk] OK appid=%u name=%s appticket=%zuB eticket=%zuB",
             t.appid, t.name.c_str(), t.appticket.size(), t.eticket.size());
    return t;
}

// Doc 1 file .lua TRON (vd denuvo_g4play.lua) -> moi block ticket trong do.
inline std::vector<CwkTicket> luaLoadFile(const std::wstring& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return {};
    std::string s((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    return parseTicketLua(s);
}

} // namespace g4
