// Test chong RO RI: mat khau plaintext trong DB khong duoc phep di ra ngoai qua API
// duoi dang doc duoc. Day la dieu kien then chot cua che do "giu cot plaintext".
//
//   deno task test
import { maskAccount } from "./mask.ts";
import { deriveResponseKey, seal } from "./crypto.ts";
import type { AccountRow } from "./supabase.ts";

const MAT_KHAU = "SieuBiMat!2026";

const acc: AccountRow = {
  id: 42,
  appid: "1174180",
  username: "steamuser",
  password: MAT_KHAU, // <- plaintext, dung nhu cach ban luu trong Supabase
  status: "available",
};

Deno.test("maskAccount KHONG lo mat khau ra endpoint quan tri", () => {
  const out = JSON.stringify(maskAccount(acc));
  if (out.includes(MAT_KHAU)) throw new Error("LO MAT KHAU trong /v1/admin/accounts: " + out);
  if (out.includes("password")) throw new Error("Con truong ten 'password' trong phan hoi: " + out);
  // Van phai bao duoc la dong do co mat khau hay khong.
  if (!out.includes('"co_mat_khau":true')) throw new Error("Mat thong tin co_mat_khau: " + out);
});

Deno.test("maskAccount bao dung khi dong THIEU mat khau", () => {
  const out = JSON.stringify(maskAccount({ ...acc, password: null }));
  if (!out.includes('"co_mat_khau":false')) throw new Error("Phai bao co_mat_khau=false: " + out);
});

Deno.test("phong bi tra ve KHONG chua mat khau o dang doc duoc", async () => {
  // Mo phong dung nhung gi ticket() lam khi tra credential ve app.
  const deviceSecret = "b".repeat(64);
  const nonce = "0123456789abcdef0123456789abcdef";
  const deviceId = "11111111-2222-3333-4444-555555555555";
  const payload = { mode: "lease", account_id: acc.id, username: acc.username, password: MAT_KHAU };

  const key = await deriveResponseKey(deviceSecret, nonce);
  const box = await seal(key, JSON.stringify(payload), `resp:${deviceId}:${nonce}`);
  const wire = JSON.stringify({ enc: 1, iv: box.iv, ct: box.ct });

  // Day la CHINH XAC nhung byte di tren day. Ke bat duoc no (proxy TLS, log,
  // trinh duyet) khong duoc phep thay mat khau.
  if (wire.includes(MAT_KHAU)) throw new Error("LO MAT KHAU tren duong truyen: " + wire);
  if (wire.includes(acc.username)) throw new Error("LO username tren duong truyen: " + wire);
  if (wire.includes("password")) throw new Error("Lo ten truong tren duong truyen: " + wire);
  if (atob(box.ct).includes(MAT_KHAU)) throw new Error("Ciphertext khong thuc su duoc ma hoa");
});

Deno.test("moi request sinh ciphertext khac nhau (khong nhan dang duoc theo mau)", async () => {
  const secret = "c".repeat(64);
  const a = await seal(await deriveResponseKey(secret, "nonce-a"), "cung mot noi dung", "aad");
  const b = await seal(await deriveResponseKey(secret, "nonce-b"), "cung mot noi dung", "aad");
  if (a.ct === b.ct) throw new Error("2 request cho ra cung ciphertext - de nhan dang");
});
