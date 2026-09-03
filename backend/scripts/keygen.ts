// Sinh bo khoa cho backend. Chay: deno task keygen
// Chep ket qua vao bien moi truong cua Deno Deploy (hoac backend/.env khi chay local).
//
// !! CRED_ENC_KEY mat = KHONG giai ma duoc mat khau nao nua (phai nhap lai tay).
//    Luu no o cho khac ngoai server: password manager / ghi giay cat tu.
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

console.log(`
# ---- Dan vao Deno Deploy > Settings > Environment Variables ----
CRED_ENC_KEY=${b64(rnd(32))}
ENROLL_TOKEN=${hex(rnd(24))}
ADMIN_TOKEN=${hex(rnd(32))}

# ---- Va 2 dong nay lay tu Supabase > Project Settings > API ----
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# ENROLL_TOKEN cung phai dat trong .env cua app Electron (G4_ENROLL_TOKEN).
# ADMIN_TOKEN thi KHONG BAO GIO — chi giu tren may ban.
`);
