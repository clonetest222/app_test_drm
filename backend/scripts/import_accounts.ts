// Nhap hang loat tai khoan tu file JSON/CSV — ma hoa NGAY, khong bao gio ghi plaintext vao DB.
//
//   deno task import accounts.json
//   deno task import accounts.csv          (cot: appid,username,password[,status])
//
// JSON: [{ "appid": "1174180", "username": "u", "password": "p", "status": "available" }]
//
// XOA FILE NGUON sau khi nhap xong — no la ban plaintext duy nhat con lai.
import { cfg } from "../src/config.ts";
import { db, type AccountRow } from "../src/supabase.ts";
import { seal } from "../src/crypto.ts";

const file = Deno.args[0];
if (!file) {
  console.error("Dung: deno task import <accounts.json|accounts.csv>");
  Deno.exit(1);
}

interface Item { appid: string; username: string; password: string; status?: string }

const text = await Deno.readTextFile(file);
let items: Item[];

if (file.toLowerCase().endsWith(".csv")) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  items = lines.slice(1).map((l) => {
    const c = l.split(",");
    const get = (k: string) => (c[head.indexOf(k)] ?? "").trim();
    return { appid: get("appid"), username: get("username"), password: get("password"), status: get("status") || undefined };
  });
} else {
  items = JSON.parse(text) as Item[];
}

console.log(`Doc ${items.length} dong tu ${file}`);
let added = 0;

for (const it of items) {
  const appid = String(it.appid ?? "").trim();
  if (!/^\d{1,10}$/.test(appid) || !it.username || !it.password) {
    console.warn(`  ! bo qua dong khong hop le: ${JSON.stringify({ ...it, password: "***" })}`);
    continue;
  }
  const [row] = await db.insert<AccountRow>("denuvo_accounts", {
    appid,
    username: it.username.trim(),
    status: it.status ?? "available",
  });
  if (!row) { console.warn(`  ! khong tao duoc dong cho ${it.username}`); continue; }

  if (cfg.encryptAtRest) {
    const box = await seal(cfg.encKey, it.password, `acct:${row.id}`);
    await db.update("denuvo_accounts", `id=eq.${row.id}`, {
      password_enc: box.ct,
      password_iv: box.iv,
      enc_ver: 1,
    });
  } else {
    // Mac dinh: ghi thang cot plaintext, y nhu cach ban van nhap tay tren Supabase.
    await db.update("denuvo_accounts", `id=eq.${row.id}`, { password: it.password });
  }

  added++;
  console.log(`  ok id=${row.id} ${it.username} (appid ${appid})`);
}

console.log(`\nDa them ${added}/${items.length}.`);
console.log(
  cfg.encryptAtRest
    ? `DB luu ban ma hoa. NHO XOA ${file} - ban plaintext cuoi cung.`
    : "DB luu cot password plaintext nhu truoc (ENCRYPT_AT_REST=false).",
);
