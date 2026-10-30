// Crypto bang Windows BCrypt (khong phu thuoc thu vien ngoai):
//   * SHA-256  — bam steamclient64.dll de tra cuu file pattern/ipc theo hash.
//   * AES-256-GCM decrypt — mo file .CWK.
// Khoa .CWK = SHA-256(CWK_SEED). CWK_SEED chi la rao can doc-ngang (obfuscation),
// KHONG phai bao mat that — y het CW_AES_KEY_SEED cua tool khac. Bao mat that nam
// o backend (ky HMAC + quota). Seed nay phai TRUNG voi ben Node (xem api/main.js).
#pragma once
#include <windows.h>
#include <bcrypt.h>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>
#pragma comment(lib, "bcrypt.lib")

namespace g4::crypto {

using Bytes = std::vector<uint8_t>;

// Seed chia se voi ben Node (producer .CWK). Doi o CA HAI noi neu muon.
static const char* CWK_SEED = "g4market-cwk-v1/change-me-together";

inline bool sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
    BCRYPT_ALG_HANDLE alg = nullptr; BCRYPT_HASH_HANDLE h = nullptr;
    bool ok = false;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0) {
        if (BCryptCreateHash(alg, &h, nullptr, 0, nullptr, 0, 0) == 0) {
            if (BCryptHashData(h, (PUCHAR)data, (ULONG)len, 0) == 0 &&
                BCryptFinishHash(h, out, 32, 0) == 0) ok = true;
            BCryptDestroyHash(h);
        }
        BCryptCloseAlgorithmProvider(alg, 0);
    }
    return ok;
}

inline std::string sha256Hex(const uint8_t* data, size_t len) {
    uint8_t d[32]; if (!sha256(data, len, d)) return "";
    static const char* hx = "0123456789abcdef";
    std::string s; s.reserve(64);
    for (uint8_t b : d) { s.push_back(hx[b >> 4]); s.push_back(hx[b & 0xF]); }
    return s;
}

// AES-256-GCM decrypt. Tra true + plaintext neu tag khop.
inline bool aesGcmDecrypt(const uint8_t key[32],
                          const uint8_t* iv, size_t ivLen,
                          const uint8_t* aad, size_t aadLen,
                          const uint8_t* ct, size_t ctLen,
                          const uint8_t* tag, size_t tagLen,
                          Bytes& out) {
    BCRYPT_ALG_HANDLE alg = nullptr; BCRYPT_KEY_HANDLE k = nullptr;
    bool ok = false;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_AES_ALGORITHM, nullptr, 0) != 0) return false;
    BCryptSetProperty(alg, BCRYPT_CHAINING_MODE,
                      (PUCHAR)BCRYPT_CHAIN_MODE_GCM, sizeof(BCRYPT_CHAIN_MODE_GCM), 0);
    if (BCryptGenerateSymmetricKey(alg, &k, nullptr, 0, (PUCHAR)key, 32, 0) == 0) {
        BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info;
        BCRYPT_INIT_AUTH_MODE_INFO(info);
        info.pbNonce = (PUCHAR)iv;    info.cbNonce = (ULONG)ivLen;
        info.pbAuthData = (PUCHAR)aad; info.cbAuthData = (ULONG)aadLen;
        info.pbTag = (PUCHAR)tag;     info.cbTag = (ULONG)tagLen;
        out.resize(ctLen);
        ULONG done = 0;
        NTSTATUS s = BCryptDecrypt(k, (PUCHAR)ct, (ULONG)ctLen, &info,
                                   nullptr, 0, out.data(), (ULONG)ctLen, &done, 0);
        if (s == 0) { out.resize(done); ok = true; }
        BCryptDestroyKey(k);
    }
    BCryptCloseAlgorithmProvider(alg, 0);
    return ok;
}

// Khoa .CWK = SHA-256(CWK_SEED).
inline void cwkKey(uint8_t out[32]) { sha256((const uint8_t*)CWK_SEED, strlen(CWK_SEED), out); }

} // namespace g4::crypto
