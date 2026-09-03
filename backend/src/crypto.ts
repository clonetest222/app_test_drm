// Nguyen thuy mat ma — WebCrypto co san trong Deno, khong dependency ngoai.
//
//  * AES-256-GCM  : ma hoa password Steam + device secret khi luu DB.
//  * HMAC-SHA256  : ky request tu app (chong gia mao / replay).
//  * HKDF-SHA256  : sinh khoa ma hoa response rieng cho tung request.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = {
  enc: (b: Uint8Array): string => btoa(String.fromCharCode(...b)),
  dec: (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
export const hex = {
  enc: (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join(""),
  dec: (s: string): Uint8Array => {
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  },
};

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? enc.encode(data) : data;
  return hex.enc(new Uint8Array(await crypto.subtle.digest("SHA-256", buf as BufferSource)));
}

/** So sanh chuoi thoi gian HANG SO — tranh ro ri qua timing khi verify chu ky. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- AES-256-GCM
async function aesKey(rawB64: string): Promise<CryptoKey> {
  const raw = b64.dec(rawB64);
  if (raw.length !== 32) throw new Error("CRED_ENC_KEY phai la 32 byte base64 (dung `deno task keygen`)");
  return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface Sealed {
  ct: string; // base64 ciphertext + tag
  iv: string; // base64 IV 12 byte
}

/** Ma hoa 1 chuoi. `aad` gan ciphertext vao ngu canh (vd id dong) -> khong the doi cho. */
export async function seal(keyB64: string, plain: string, aad?: string): Promise<Sealed> {
  const key = await aesKey(keyB64);
  const iv = randomBytes(12);
  const params: AesGcmParams = { name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 };
  if (aad) params.additionalData = enc.encode(aad) as BufferSource;
  const ct = await crypto.subtle.encrypt(params, key, enc.encode(plain) as BufferSource);
  return { ct: b64.enc(new Uint8Array(ct)), iv: b64.enc(iv) };
}

export async function open(keyB64: string, sealed: Sealed, aad?: string): Promise<string> {
  const key = await aesKey(keyB64);
  const params: AesGcmParams = { name: "AES-GCM", iv: b64.dec(sealed.iv) as BufferSource, tagLength: 128 };
  if (aad) params.additionalData = enc.encode(aad) as BufferSource;
  const pt = await crypto.subtle.decrypt(params, key, b64.dec(sealed.ct) as BufferSource);
  return dec.decode(pt);
}

// ------------------------------------------------------------------ HMAC + HKDF
export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex.enc(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg) as BufferSource)));
}

/** Khoa AES rieng cho 1 response: HKDF(device_secret, salt = nonce request). */
export async function deriveResponseKey(deviceSecret: string, nonce: string): Promise<string> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(deviceSecret) as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(nonce) as BufferSource,
      info: enc.encode("g4play-denuvo-response-v1") as BufferSource,
    },
    ikm,
    256,
  );
  return b64.enc(new Uint8Array(bits));
}
