// BUOC TUY CHON - KHONG can chay neu dung che do mac dinh (plaintext tai DB).
//
// Script nay tao them ban ma hoa (password_enc) cho cac account dang co. Chi co y
// nghia khi ban dat ENCRYPT_AT_REST=true tren backend. Che do mac dinh doc thang
// cot `password` plaintext nen khong dung den no.
//
//   deno task migrate --dry-run         xem truoc, khong ghi gi
//   deno task migrate                   tao password_enc, GIU NGUYEN plaintext
//   deno task migrate --wipe-plaintext  tao password_enc roi xoa plaintext
//
// Nho: mat CRED_ENC_KEY sau khi --wipe-plaintext = mat sach mat khau.
import { cfg } from "../src/config.ts";
import { db, type AccountRow } from "../src/supabase.ts";
import { open, seal } from "../src/crypto.ts";

const DRY = Deno.args.includes("--dry-run");
const WIPE = Deno.args.includes("--wipe-plaintext");   // KHONG mac dinh, phai go tay

const rows = await db.select<AccountRow>("denuvo_accounts", "select=*&order=id.asc");
console.log(`Tim thay ${rows.length} tai khoan.`);

let encrypted = 0, skipped = 0, failed = 0;

for (const acc of rows) {
  // Da co ban ma hoa hop le -> bo qua.
  if (acc.password_enc && acc.password_iv) {
    try {
      await open(cfg.encKey, { ct: acc.password_enc, iv: acc.password_iv }, `acct:${acc.id}`);
      skipped++;
      continue;
    } catch {
      console.warn(`  ! id=${acc.id} co password_enc nhung KHONG giai ma duoc (sai CRED_ENC_KEY?)`);
      failed++;
      continue;
    }
  }

  const plain = acc.password ?? "";
  if (!plain) {
    console.warn(`  ! id=${acc.id} (${acc.username}) khong co mat khau nao — bo qua`);
    failed++;
    continue;
  }

  if (DRY) {
    console.log(`  [dry] se ma hoa id=${acc.id} ${acc.username}`);
    encrypted++;
    continue;
  }

  const box = await seal(cfg.encKey, plain, `acct:${acc.id}`);
  await db.update("denuvo_accounts", `id=eq.${acc.id}`, {
    password_enc: box.ct,
    password_iv: box.iv,
    enc_ver: 1,
    ...(WIPE ? { password: null } : {}),   // mac dinh GIU plaintext lam du phong
  });
  encrypted++;
  console.log(`  ok id=${acc.id} ${acc.username}`);
}

const chuaMaHoa = await db.count("denuvo_accounts", "password_enc=is.null");
const conPlain = await db.count("denuvo_accounts", "password=not.is.null");

console.log(`
Ma hoa: ${encrypted} | Bo qua (da ma hoa): ${skipped} | Loi: ${failed}`);
console.log(
  chuaMaHoa === 0
    ? "OK - moi tai khoan deu co ban ma hoa."
    : `!! CON ${chuaMaHoa} dong CHUA co password_enc - app khong dung duoc nhung dong nay.`,
);
console.log(
  WIPE
    ? `Da xoa plaintext. Con lai ${conPlain} dong co plaintext.`
    : `Giu nguyen plaintext lam du phong (${conPlain} dong) - dung y do, khong phai loi.`,
);
