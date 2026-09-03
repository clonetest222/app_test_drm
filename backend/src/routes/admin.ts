// Endpoint quan tri — CHI goi tu may ban (header X-G4-Admin).
// Token khong dat trong env thi backend tu sinh va in ra log luc khoi dong.
import { cfg } from "../config.ts";
import { db, type AccountRow } from "../supabase.ts";
import { countRecentLeases, getAcctState, getDevice, listDevices, listLeases, putDevice, setAcctState } from "../kv.ts";
import { HttpError, logLine, ok } from "../http.ts";
import { maskAccount } from "../mask.ts";

/**
 * GET /v1/admin/accounts?appid=&limit= — liet ke account de doi soat.
 * KHONG BAO GIO tra ve mat khau, chi tra ve co/khong co.
 */
export async function listAccounts(url: URL): Promise<Response> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
  const parts = ["select=*", "order=appid.asc,id.asc", `limit=${limit}`];
  const appid = url.searchParams.get("appid");
  if (appid) parts.push(`appid=eq.${appid}`);

  const rows = await db.select<AccountRow>("denuvo_accounts", parts.join("&"));
  const out = [];
  for (const r of rows) {
    const st = await getAcctState(r.id);
    out.push({
      ...maskAccount(r),
      // Trang thai van hanh nam trong KV, khong phai trong Supabase.
      fail_count: st.failCount,
      cooldown_until: st.cooldownUntil ? new Date(st.cooldownUntil).toISOString() : null,
      last_used_at: st.lastUsedAt ? new Date(st.lastUsedAt).toISOString() : null,
      bi_chan: st.failCount >= cfg.limits.accountFailBlock,
    });
  }
  return ok({ ok: true, rows: out });
}

/** POST /v1/admin/accounts/reset { account_id } — go chan / xoa cooldown 1 account. */
export async function resetAccount(bodyText: string): Promise<Response> {
  const b = JSON.parse(bodyText || "{}") as { account_id?: number };
  const id = Number(b.account_id);
  if (!Number.isInteger(id)) throw new HttpError(400, "bad_input", "Thieu account_id");
  await setAcctState(id, { failCount: 0, cooldownUntil: 0, lastUsedAt: 0 });
  logLine("account_reset", { account_id: id });
  return ok({ ok: true });
}

/** POST /v1/admin/devices/revoke { device_id, reason } — khoa 1 may lam ro ri. */
export async function revokeDevice(bodyText: string): Promise<Response> {
  const b = JSON.parse(bodyText || "{}") as { device_id?: string; reason?: string; unrevoke?: boolean };
  if (!b.device_id) throw new HttpError(400, "bad_input", "Thieu device_id");
  const d = await getDevice(b.device_id);
  if (!d) throw new HttpError(404, "not_found", "Khong thay device");
  d.revoked = !b.unrevoke;
  d.revokeReason = b.unrevoke ? null : (b.reason ?? "Bi khoa boi quan tri");
  await putDevice(d);
  logLine("device_revoked", { device_id: b.device_id, unrevoke: !!b.unrevoke });
  return ok({ ok: true });
}

/** GET /v1/admin/devices — danh sach may da dang ky (khong lo secret). */
export async function devices(url: URL): Promise<Response> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const rows = await listDevices(limit);
  return ok({
    ok: true,
    rows: rows.map((d) => ({
      id: d.id,
      app_version: d.appVersion,
      platform: d.platform,
      revoked: d.revoked,
      revoke_reason: d.revokeReason,
      created_at: new Date(d.createdAt).toISOString(),
      last_seen_at: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null,
      last_ip: d.lastIp,
    })),
  });
}

/** GET /v1/admin/audit?device=&appid=&limit= — ai lay credential nao, luc nao. */
export async function audit(url: URL): Promise<Response> {
  const rows = await listLeases({
    deviceId: url.searchParams.get("device") ?? undefined,
    appid: url.searchParams.get("appid") ?? undefined,
    limit: Math.min(Number(url.searchParams.get("limit") ?? 100), 500),
  });
  return ok({
    ok: true,
    rows: rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
  });
}

/** GET /v1/admin/health — tinh trang tong quan. */
export async function health(): Promise<Response> {
  const [accounts, devs, leases24h] = await Promise.all([
    db.select<AccountRow>("denuvo_accounts", "select=id,password,password_enc"),
    listDevices(500),
    countRecentLeases(86_400_000),
  ]);
  const thieuMatKhau = accounts.filter((a) => !a.password && !a.password_enc).length;
  return ok({
    ok: true,
    bao_mat: cfg.usingAnonKey ? "CHUA VA XONG - dang dung key anon" : "da khoa anon",
    che_do_luu_mat_khau: cfg.encryptAtRest ? "ma hoa tai DB" : "plaintext tai DB (mac dinh)",
    accounts_total: accounts.length,
    accounts_thieu_mat_khau: thieuMatKhau,
    devices_total: devs.length,
    devices_bi_khoa: devs.filter((d) => d.revoked).length,
    leases_24h: leases24h,
    canh_bao: thieuMatKhau > 0 ? `${thieuMatKhau} dong khong co mat khau - app se bo qua` : null,
  });
}
