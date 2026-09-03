// Endpoint quan tri — CHI goi tu may ban (header X-G4-Admin). Khong nhung token nay vao app.
import { cfg } from "../config.ts";
import { db, type AccountRow, type DeviceRow } from "../supabase.ts";
import { seal } from "../crypto.ts";
import { HttpError, logLine, ok } from "../http.ts";
import { maskAccount } from "../mask.ts";

interface AddAccountBody {
  appid?: string | number;
  username?: string;
  password?: string;
  status?: string;
  note?: string;
}

/**
 * POST /v1/admin/accounts - them account moi.
 *
 * Mac dinh ghi thang cot `password` (plaintext) nhu truoc. Bat ENCRYPT_AT_REST=true
 * thi ghi ban ma hoa thay vi plaintext. Ca hai truong hop, mat khau deu khong bao gio
 * di nguoc ra qua API - xem maskAccount() trong ../mask.ts.
 */
export async function addAccount(bodyText: string): Promise<Response> {
  const b = JSON.parse(bodyText || "{}") as AddAccountBody;
  const appid = String(b.appid ?? "").trim();
  const username = String(b.username ?? "").trim();
  const password = String(b.password ?? "");
  if (!/^\d{1,10}$/.test(appid)) throw new HttpError(400, "bad_appid", "appid khong hop le");
  if (!username || !password) throw new HttpError(400, "bad_input", "Thieu username/password");

  const [row] = await db.insert<AccountRow>("denuvo_accounts", {
    appid,
    username,
    status: b.status ?? "available",
    note: b.note ?? null,
  });
  if (!row) throw new HttpError(500, "insert_fail", "Khong tao duoc dong");

  if (cfg.encryptAtRest) {
    // id cua dong duoc dung lam AAD -> ke co quyen ghi DB khong the "chuyen"
    // ciphertext cua account A sang dong account B.
    const box = await seal(cfg.encKey, password, `acct:${row.id}`);
    await db.update("denuvo_accounts", `id=eq.${row.id}`, {
      password_enc: box.ct,
      password_iv: box.iv,
      enc_ver: 1,
    });
  } else {
    await db.update("denuvo_accounts", `id=eq.${row.id}`, { password });
  }

  logLine("account_added", { account_id: row.id, appid, username, encrypted: cfg.encryptAtRest });
  return ok({ ok: true, id: row.id });
}

/**
 * GET /v1/admin/accounts?appid=&limit= - liet ke account de doi soat.
 * KHONG BAO GIO tra ve mat khau, chi tra ve co/khong co.
 */
export async function listAccounts(url: URL): Promise<Response> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
  const parts = ["select=*", "order=appid.asc,id.asc", `limit=${limit}`];
  const appid = url.searchParams.get("appid");
  if (appid) parts.push(`appid=eq.${appid}`);
  const rows = await db.select<AccountRow>("denuvo_accounts", parts.join("&"));
  return ok({ ok: true, rows: rows.map(maskAccount) });
}

/** POST /v1/admin/devices/revoke  { device_id, reason } — khoa 1 may bi phat hien lam ro ri. */
export async function revokeDevice(bodyText: string): Promise<Response> {
  const b = JSON.parse(bodyText || "{}") as { device_id?: string; reason?: string; unrevoke?: boolean };
  if (!b.device_id) throw new HttpError(400, "bad_input", "Thieu device_id");
  const rows = await db.update<DeviceRow>("denuvo_devices", `id=eq.${b.device_id}`, {
    revoked: !b.unrevoke,
    revoke_reason: b.unrevoke ? null : (b.reason ?? "Bi khoa boi quan tri"),
  });
  if (!rows.length) throw new HttpError(404, "not_found", "Khong thay device");
  logLine("device_revoked", { device_id: b.device_id, unrevoke: !!b.unrevoke });
  return ok({ ok: true });
}

/** GET /v1/admin/audit?device=&appid=&limit= — xem ai lay credential nao. */
export async function audit(url: URL): Promise<Response> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const parts = [`select=*`, `order=created_at.desc`, `limit=${limit}`];
  const dev = url.searchParams.get("device");
  const appid = url.searchParams.get("appid");
  if (dev) parts.push(`device_id=eq.${dev}`);
  if (appid) parts.push(`appid=eq.${appid}`);
  const rows = await db.select("denuvo_lease_log", parts.join("&"));
  return ok({ ok: true, rows });
}

/** GET /v1/admin/health — kiem tra con bao nhieu dong chua ma hoa. */
export async function health(): Promise<Response> {
  const [coMatKhau, daMaHoa, total, devices] = await Promise.all([
    db.count("denuvo_accounts", "or=(password.not.is.null,password_enc.not.is.null)"),
    db.count("denuvo_accounts", "password_enc=not.is.null"),
    db.count("denuvo_accounts", "id=gte.0"),
    db.count("denuvo_devices", "revoked=is.false"),
  ]);
  const thieuMatKhau = total - coMatKhau;
  return ok({
    ok: true,
    che_do: cfg.encryptAtRest ? "ma hoa tai DB" : "plaintext tai DB (mac dinh)",
    accounts_total: total,
    accounts_co_mat_khau: coMatKhau,
    accounts_da_ma_hoa: daMaHoa,
    devices_active: devices,
    // Chi so suc khoe THAT SU: dong nao khong co mat khau nao ca thi app khong dung duoc.
    canh_bao: thieuMatKhau > 0 ? `${thieuMatKhau} dong khong co mat khau nao - app se bo qua` : null,
  });
}
