// Cau hinh backend — TAT CA bi mat nam o day, KHONG BAO GIO ra client.
// Deno Deploy: dat trong Settings > Environment Variables.
// Chay local:  copy .env.example -> .env roi `deno task dev` (Deno tu doc .env).

function need(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Thieu bien moi truong bat buoc: ${name}`);
  return v;
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
  supabaseUrl: need("SUPABASE_URL").replace(/\/+$/, ""),
  /** SERVICE ROLE key — di xuyen RLS. Ro ri key nay = ro ri toan bo DB. */
  serviceKey: need("SUPABASE_SERVICE_ROLE_KEY"),

  /** Khoa AES-256-GCM (base64, 32 byte) ma hoa password + device secret. `deno task keygen`. */
  encKey: need("CRED_ENC_KEY"),

  /** Token app gui khi dang ky device lan dau. KHONG phai bi mat that (nam trong app,
   *  ai cung rut duoc) — chi la rao can toc do; bao ve that nam o rate limit + audit. */
  enrollToken: need("ENROLL_TOKEN"),

  /** Token cho cac endpoint /v1/admin/* — CHI dung tu may ban, khong nhung vao app. */
  adminToken: need("ADMIN_TOKEN"),

  /** Do lech dong ho toi da cua request da ky (ms). */
  maxSkewMs: num("MAX_SKEW_MS", 120_000),

  /** Rate limit phat credential. */
  limits: {
    perDeviceHour: num("LIMIT_DEVICE_HOUR", 12),
    perDeviceDay: num("LIMIT_DEVICE_DAY", 40),
    perDeviceAppid10m: num("LIMIT_DEVICE_APPID_10M", 4),
    /** Cooldown 1 account sau khi vua phat (giay) — tranh Steam khoa vi login lien tuc. */
    accountCooldownSec: num("ACCOUNT_COOLDOWN_SEC", 90),
    /** Login fail lien tiep bao nhieu lan thi tu dat status='blocked'. */
    accountFailBlock: num("ACCOUNT_FAIL_BLOCK", 5),
    /** Dang ky device toi da tren 1 IP trong 1 gio. */
    enrollPerIpHour: num("LIMIT_ENROLL_IP_HOUR", 6),
  },

  /**
   * Co ma hoa mat khau TAI DB hay khong.
   *
   * false (MAC DINH) - dung cot `password` plaintext y nhu truoc. Ban van sua
   *                    account thang trong Supabase Table Editor nhu binh thuong.
   * true             - account moi them se duoc ma hoa AES-256-GCM.
   *
   * Du dat the nao thi mat khau CUNG KHONG LO QUA API:
   *   - `anon` co 0 quyen doc bang (RLS dong hoan toan) - app khong con key nao
   *   - chi endpoint da ky moi xin duoc, va CHI 1 account cho 1 appid
   *   - payload tra ve nam trong phong bi AES-256-GCM rieng cho tung request
   *   - khong endpoint nao tra ve mat khau o dang doc duoc, ke ca /v1/admin/*
   *
   * Doi lai khi de false: ai doc duoc DB bang service_role van thay plaintext.
   */
  encryptAtRest: (Deno.env.get("ENCRYPT_AT_REST") ?? "false").toLowerCase() === "true",

  /** Phien ban toi thieu cua app duoc phep goi API ("" = khong ep). */
  minAppVersion: opt("MIN_APP_VERSION", ""),

  port: num("PORT", 8000),
  env: opt("DENO_ENV", "production"),
};

export type Cfg = typeof cfg;
