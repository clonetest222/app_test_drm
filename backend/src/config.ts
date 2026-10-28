// Cau hinh backend.
//
// BAT BUOC dung 2 bien — chinh la 2 bien ban da co san tren Deno Deploy:
//    SUPABASE_URL
//    SUPABASE_PUBLISHABLE_KEY   (hoac SERVICE_ROLE / SECRET / SUPABASE_KEY)
//
// Moi thu khac deu TU SINH va luu trong Deno KV (xem kv.ts: loadSecrets).
// Muon ghi de thi dat bien moi truong, khong dat cung chay.

function needOneOf(names: string[]): string {
  for (const n of names) {
    const v = Deno.env.get(n);
    if (v) return v;
  }
  throw new Error(`Thieu bien moi truong: can mot trong ${names.join(" / ")}`);
}
function opt(name: string, dflt: string): string {
  return Deno.env.get(name) ?? dflt;
}
function num(name: string, dflt: number): number {
  const v = Deno.env.get(name);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

export const cfg = {
  /** Supabase project URL, vd https://xxx.supabase.co */
  supabaseUrl: needOneOf(["SUPABASE_URL"]).replace(/\/+$/, ""),

  /**
   * Key goi Supabase. Backend CHI DOC tu Supabase (accounts / requirement /
   * releases) nen publishable key la du — mien la bang van con policy cho anon
   * doc, dung nhu app 1.0.0 van lam.
   */
  supabaseKey: needOneOf([
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_KEY",
  ]),

  /**
   * Dang dung key `anon` (publishable) hay khong.
   *
   * Dung anon = backend doc duoc denuvo_accounts, nhung AI CO KEY DO CUNG DOC
   * DUOC — ke ca qua app 1.0.0 da phat hanh. Bao ra /health de khong ai tuong
   * nham la da va xong.
   */
  usingAnonKey: !Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") && !Deno.env.get("SUPABASE_SECRET_KEY"),

  // ---- deu TUY CHON: khong dat thi tu sinh / tu bo qua ----

  /** Khoa AES-256-GCM base64. Khong dat -> sinh 1 lan va giu trong KV. */
  encKeyEnv: opt("CRED_ENC_KEY", ""),

  /** Token quan tri. Khong dat -> sinh 1 lan, in ra log luc khoi dong. */
  adminTokenEnv: opt("ADMIN_TOKEN", ""),

  /**
   * Token app gui khi dang ky thiet bi. Khong dat -> BO QUA kiem tra, chi con
   * gioi han theo IP. Chap nhan duoc vi token nay von nam trong app, ai cung
   * rut duoc; no chua bao gio la bi mat that.
   */
  enrollToken: opt("ENROLL_TOKEN", ""),

  /** Co ma hoa mat khau tai DB khong. Mac dinh khong — giu plaintext nhu truoc. */
  encryptAtRest: opt("ENCRYPT_AT_REST", "false").toLowerCase() === "true",

  /** Do lech dong ho toi da cua request da ky (ms). */
  maxSkewMs: num("MAX_SKEW_MS", 120_000),

  limits: {
    perDeviceHour: num("LIMIT_DEVICE_HOUR", 12),
    perDeviceDay: num("LIMIT_DEVICE_DAY", 40),
    perDeviceAppid10m: num("LIMIT_DEVICE_APPID_10M", 10),
    accountCooldownSec: num("ACCOUNT_COOLDOWN_SEC", 90),
    accountFailBlock: num("ACCOUNT_FAIL_BLOCK", 5),
    enrollPerIpHour: num("LIMIT_ENROLL_IP_HOUR", 6),
  },

  /** Phien ban toi thieu cua app duoc phep goi API ("" = khong ep). */
  minAppVersion: opt("MIN_APP_VERSION", ""),

  port: num("PORT", 8000),
  env: opt("DENO_ENV", "production"),
};

/** Bi mat da giai quyet xong (env hoac KV) — main.ts gan vao luc khoi dong. */
export const secrets = {
  encKey: "",
  adminToken: "",
};

export type Cfg = typeof cfg;
