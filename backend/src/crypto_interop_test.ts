// Kiem tra doi xung giua backend (Deno WebCrypto) va app (Node crypto trong api.js).
//
// Chay:  deno task test        hoac  deno test src/crypto_interop_test.ts
//
// Test nay chi kiem phia Deno (seal/open/HKDF/HMAC on dinh). Phan doi chieu THAT SU
// voi Node nam o scripts/interop_check.ts — no goi node de mo phong bi do Deno tao.
import { deriveResponseKey, hmacHex, open, randomBytes, seal, sha256Hex, timingSafeEqual } from "./crypto.ts";

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const KEY = b64(randomBytes(32));

Deno.test("seal/open khu hoi duoc noi dung", async () => {
  const box = await seal(KEY, "mat-khau-steam-123", "acct:42");
  const back = await open(KEY, box, "acct:42");
  if (back !== "mat-khau-steam-123") throw new Error("open khong tra ve dung plaintext");
});

Deno.test("AAD sai thi KHONG mo duoc (chong doi cho ciphertext giua cac dong)", async () => {
  const box = await seal(KEY, "mat-khau", "acct:42");
  let threw = false;
  try {
    await open(KEY, box, "acct:43");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("AAD sai ma van giai ma duoc — GCM khong duoc bind dung");
});

Deno.test("khoa sai thi khong mo duoc", async () => {
  const box = await seal(KEY, "mat-khau", "acct:1");
  let threw = false;
  try {
    await open(b64(randomBytes(32)), box, "acct:1");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("khoa sai ma van giai ma duoc");
});

Deno.test("HKDF sinh khoa on dinh va khac nhau theo nonce", async () => {
  const a1 = await deriveResponseKey("secret", "nonce-1");
  const a2 = await deriveResponseKey("secret", "nonce-1");
  const b1 = await deriveResponseKey("secret", "nonce-2");
  if (a1 !== a2) throw new Error("HKDF khong tat dinh");
  if (a1 === b1) throw new Error("nonce khac ma khoa giong nhau");
});

Deno.test("HMAC khop vector co dinh (doi xung voi Node createHmac)", async () => {
  // Vector nay duoc doi chieu voi:
  //   node -e "console.log(require('crypto').createHmac('sha256','k').update('m').digest('hex'))"
  const got = await hmacHex("k", "m");
  if (got !== "b60090e3052297aeb5a080889ce2fc4bca957e756faeb4df7d31800ca1e771ec") {
    throw new Error("HMAC khong khop Node: " + got);
  }
});

Deno.test("sha256Hex khop vector co dinh", async () => {
  const got = await sha256Hex("");
  if (got !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") {
    throw new Error("sha256 sai: " + got);
  }
});

Deno.test("timingSafeEqual dung ve mat logic", () => {
  if (!timingSafeEqual("abc", "abc")) throw new Error("bang nhau ma bao khac");
  if (timingSafeEqual("abc", "abd")) throw new Error("khac nhau ma bao bang");
  if (timingSafeEqual("abc", "abcd")) throw new Error("khac do dai ma bao bang");
});
