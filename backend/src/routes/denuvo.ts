// TRAI TIM CUA BAN VA NAY.
//
// Truoc:  app cam publishable key -> GET denuvo_accounts -> nhan CA BANG mat khau.
// Sau :   app ky request -> backend chon DUNG 1 tai khoan cho DUNG 1 appid,
//         tra ve trong phong bi ma hoa rieng cho device do, co rate limit + audit.
//
// Supabase chi duoc DOC (bang denuvo_accounts / denuvo_requirement, y nhu app cu
// van doc). Cooldown, dem loi, audit... nam trong Deno KV -> khong phai them cot,
// khong phai tao bang, khong can quyen ghi.
//
// Response envelope: { enc: 1, iv, ct } voi khoa = HKDF(device_secret, nonce).
// => Ke dat proxy TLS (Fiddler/mitmproxy) giua app va server VAN khong doc duoc.
import { cfg, secrets } from "../config.ts";
import { db, type AccountRow, type RequirementRow } from "../supabase.ts";
import {
  delHold, getAcctState, getAcctStates, getHold, logLease,
  putHold, setAcctState, touchDevice,
} from "../kv.ts";
import { deriveResponseKey, hex, open, randomBytes, seal } from "../crypto.ts";
import { HttpError, logLine, ok } from "../http.ts";
import { checkLeaseAvailable, checkLeaseLimits, commitLease, quotaStatus } from "../ratelimit.ts";
import type { AuthedDevice } from "../auth.ts";

/** Boc payload vao phong bi ma hoa gan voi device + nonce cua chinh request nay. */
async function sealed(auth: AuthedDevice, payload: unknown): Promise<Response> {
  const key = await deriveResponseKey(auth.secret, auth.nonce);
  const box = await seal(key, JSON.stringify(payload), `resp:${auth.device.id}:${auth.nonce}`);
  return ok({ enc: 1, iv: box.iv, ct: box.ct });
}

/**
 * Lay mat khau cua 1 account: doc cot `password` plaintext nhu truoc; neu dong
 * do co ban ma hoa (ENCRYPT_AT_REST) thi uu tien ban ma hoa. Gia tri tra ve CHI
 * ton tai trong bo nho request nay va chi ra ngoai qua phong bi trong sealed().
 */
async function accountPassword(acc: AccountRow): Promise<string | null> {
  if (acc.password_enc && acc.password_iv) {
    try {
      return await open(secrets.encKey, { ct: acc.password_enc, iv: acc.password_iv }, `acct:${acc.id}`);
    } catch {
      logLine("decrypt_fail", { account_id: acc.id });
      return null;
    }
  }
  return acc.password ?? null;
}

interface TicketBody {
  appid?: string | number;
  exclude?: number[];      // id account da thu that bai trong lan chay nay
  app_version?: string;
}

/**
 * POST /v1/denuvo/ticket
 * Tra ve MOT trong hai:
 *   { mode:"lease", lease_id, account_id, username, password, ttl_ms }  (hom nay)
 *   { mode:"ticket", appticket, eticket }                               (giai doan 2 —
 *      backend tu lay ticket, app KHONG con thay mat khau; protocol da san sang)
 */
export async function ticket(auth: AuthedDevice, bodyText: string, ip: string): Promise<Response> {
  const body = JSON.parse(bodyText || "{}") as TicketBody;
  const appid = String(body.appid ?? "").trim();
  if (!/^\d{1,10}$/.test(appid)) throw new HttpError(400, "bad_appid", "appid khong hop le");

  if (cfg.minAppVersion && verLt(body.app_version ?? "0", cfg.minAppVersion)) {
    throw new HttpError(426, "app_outdated", `Can cap nhat app len ${cfg.minAppVersion} tro len`);
  }

  await checkLeaseLimits(auth.device.id, appid);

  const exclude = new Set((body.exclude ?? []).filter((n) => Number.isInteger(n)).slice(0, 50));

  // Doc danh sach account tu Supabase (chi SELECT, dung quyen anon nhu app cu).
  const rows = await db.select<AccountRow>(
    "denuvo_accounts",
    `select=*&appid=eq.${appid}&status=eq.available&order=id.asc`,
  );
  const candidates = rows.filter((r) => !exclude.has(r.id));

  if (!candidates.length) {
    await logLease({
      at: Date.now(), deviceId: auth.device.id, accountId: null, appid, ip,
      result: "no_account", reason: exclude.size ? "het account de thu" : "",
    });
    throw new HttpError(404, "no_account", "Chua co tai khoan kha dung cho game nay");
  }

  // Cooldown + dem loi nam trong KV. Uu tien account LAU CHUA DUNG NHAT -> trai
  // deu tai, giam nguy co Steam khoa vi login don dap vao mot acc.
  const now = Date.now();
  const states = await getAcctStates(candidates.map((c) => c.id));
  const usable = candidates
    .filter((c) => (states.get(c.id)?.cooldownUntil ?? 0) <= now)
    .filter((c) => (states.get(c.id)?.failCount ?? 0) < cfg.limits.accountFailBlock)
    .sort((a, b) => (states.get(a.id)?.lastUsedAt ?? 0) - (states.get(b.id)?.lastUsedAt ?? 0));

  const acc = usable[0];
  if (!acc) {
    await logLease({
      at: now, deviceId: auth.device.id, accountId: null, appid, ip,
      result: "no_account", reason: "tat ca dang cooldown hoac da bi chan",
    });
    throw new HttpError(404, "no_account", "Tai khoan cho game nay dang ban, thu lai sau it phut");
  }

  const password = await accountPassword(acc);
  if (!password) {
    await logLease({
      at: now, deviceId: auth.device.id, accountId: acc.id, appid, ip,
      result: "no_password", reason: "",
    });
    throw new HttpError(500, "no_password", "Tai khoan chua co mat khau hop le");
  }

  // Dat cooldown NGAY khi phat: app tat giua chung thi account van khong bi
  // xoay vong lien tuc (Steam khoa tam neu login qua day).
  const st = await getAcctState(acc.id);
  await setAcctState(acc.id, {
    ...st,
    lastUsedAt: now,
    cooldownUntil: now + cfg.limits.accountCooldownSec * 1000,
  });
  await touchDevice(auth.device.id, ip);

  const leaseId = now;
  await logLease({
    at: now, deviceId: auth.device.id, accountId: acc.id, appid, ip, result: "issued", reason: "",
  });
  logLine("lease_issued", { device_id: auth.device.id, appid, account_id: acc.id });

  return await sealed(auth, {
    mode: "lease",
    lease_id: leaseId,
    account_id: acc.id,
    username: acc.username,
    password,
    ttl_ms: 5 * 60_000,
  });
}

interface ResultBody {
  lease_id?: number;
  account_id?: number;
  ok?: boolean;
  reason?: string;
}

/**
 * POST /v1/denuvo/ticket/result
 * App bao lai ket qua -> backend biet account nao hong ma tu chan, va co audit that.
 */
export async function ticketResult(auth: AuthedDevice, bodyText: string, ip: string): Promise<Response> {
  const body = JSON.parse(bodyText || "{}") as ResultBody;
  const accountId = Number(body.account_id);
  const good = body.ok === true;
  const reason = String(body.reason ?? "").slice(0, 200);

  await logLease({
    at: Date.now(),
    deviceId: auth.device.id,
    accountId: Number.isInteger(accountId) ? accountId : null,
    appid: null,
    ip,
    result: good ? "ok" : "login_fail",
    reason,
  });

  if (Number.isInteger(accountId)) {
    const st = await getAcctState(accountId);
    const fails = good ? 0 : st.failCount + 1;
    await setAcctState(accountId, {
      failCount: fails,
      cooldownUntil: good ? 0 : st.cooldownUntil,
      lastUsedAt: st.lastUsedAt,
    });
    if (!good && fails >= cfg.limits.accountFailBlock) {
      // Khong sua `status` trong Supabase (khong co quyen ghi) — chan o KV,
      // vong loc `failCount` ben tren se bo qua account nay.
      logLine("account_blocked", { account_id: accountId, fails, reason });
    }
  }

  return await sealed(auth, { ok: true });
}

// ============================================================================
//  LUONG BAT DONG BO (hoc tu CaigamerQ): request -> confirm / cancel
//
//    auth/request : KIEM TRA han muc (KHONG tru), chon account, tao HOLD, tra
//                   lease trong phong bi ma hoa. Quota chua bi dong.
//    auth/confirm : fix da xong -> TRU quota that, xoa hold, danh dau acc tot.
//    auth/cancel  : fix that bai / bo -> tra hold (KHONG tru quota), bao acc hong.
//
//  Khac han ban cu (/v1/denuvo/ticket): o do moi lan XIN la tru quota ngay, nen
//  fix that bai van an mat luot. O day quota chi mat khi fix THANH CONG.
//
//  Van la hybrid: ticket that van do MAY NGUOI DUNG dump (extract_tickets) vi
//  Deno Deploy khong mo socket toi Steam CM de tu mint. Backend chi dieu phoi
//  account + quota + audit theo dung hinh dang async cua CaigamerQ.
// ============================================================================
const randLeaseSuffix = () => hex.enc(randomBytes(4));

/**
 * Chon 1 account kha dung cho appid: loai `exclude`, loai dang cooldown / da bi
 * chan vi fail nhieu; uu tien acc LAU CHUA DUNG NHAT (trai deu tai). Dat cooldown
 * ngay khi phat. Nem HttpError neu khong con account nao.
 */
async function pickAccount(appid: string, exclude: Set<number>): Promise<{ acc: AccountRow; password: string }> {
  const rows = await db.select<AccountRow>(
    "denuvo_accounts",
    `select=*&appid=eq.${appid}&status=eq.available&order=id.asc`,
  );
  const candidates = rows.filter((r) => !exclude.has(r.id));
  if (!candidates.length) {
    throw new HttpError(404, "no_account", exclude.size ? "Da thu het tai khoan cho game nay" : "Chua co tai khoan kha dung cho game nay");
  }

  const now = Date.now();
  const states = await getAcctStates(candidates.map((c) => c.id));
  const usable = candidates
    .filter((c) => (states.get(c.id)?.cooldownUntil ?? 0) <= now)
    .filter((c) => (states.get(c.id)?.failCount ?? 0) < cfg.limits.accountFailBlock)
    .sort((a, b) => (states.get(a.id)?.lastUsedAt ?? 0) - (states.get(b.id)?.lastUsedAt ?? 0));

  const acc = usable[0];
  if (!acc) throw new HttpError(404, "no_account", "Tai khoan cho game nay dang ban, thu lai sau it phut");

  const password = await accountPassword(acc);
  if (!password) throw new HttpError(500, "no_password", "Tai khoan chua co mat khau hop le");

  const st = await getAcctState(acc.id);
  await setAcctState(acc.id, { ...st, lastUsedAt: now, cooldownUntil: now + cfg.limits.accountCooldownSec * 1000 });
  return { acc, password };
}

interface AuthRequestBody {
  appid?: string | number;
  exclude?: number[];       // id account da thu that bai trong lan chay nay
  app_version?: string;
}

/**
 * POST /v1/denuvo/auth/request
 * Tra ve phong bi ma hoa chua MOT trong hai:
 *   { mode:"lease",  lease_id, account_id, username, password, ttl_ms }  (hom nay)
 *   { mode:"ticket", lease_id, appticket, eticket }                       (neu sau
 *      nay co ticket-worker tu mint — app chi ghi lua, khong login Steam)
 */
export async function authRequest(auth: AuthedDevice, bodyText: string, ip: string): Promise<Response> {
  const body = JSON.parse(bodyText || "{}") as AuthRequestBody;
  const appid = String(body.appid ?? "").trim();
  if (!/^\d{1,10}$/.test(appid)) throw new HttpError(400, "bad_appid", "appid khong hop le");

  if (cfg.minAppVersion && verLt(body.app_version ?? "0", cfg.minAppVersion)) {
    throw new HttpError(426, "app_outdated", `Can cap nhat app len ${cfg.minAppVersion} tro len`);
  }

  // Kiem tra han muc — KHONG tru. Quota chi tru o auth/confirm.
  await checkLeaseAvailable(auth.device.id, appid);

  const exclude = new Set((body.exclude ?? []).filter((n) => Number.isInteger(n)).slice(0, 50));

  let picked: { acc: AccountRow; password: string };
  try {
    picked = await pickAccount(appid, exclude);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : "no_account";
    await logLease({ at: Date.now(), deviceId: auth.device.id, accountId: null, appid, ip, result: code, reason: "" });
    throw e;
  }
  const { acc, password } = picked;

  await touchDevice(auth.device.id, ip);

  const leaseId = `${Date.now()}-${randLeaseSuffix()}`;
  await putHold(auth.device.id, leaseId, { appid, accountId: acc.id, at: Date.now() });
  await logLease({ at: Date.now(), deviceId: auth.device.id, accountId: acc.id, appid, ip, result: "issued", reason: "" });
  logLine("auth_request", { device_id: auth.device.id, appid, account_id: acc.id, lease_id: leaseId });

  return await sealed(auth, {
    mode: "lease",
    lease_id: leaseId,
    account_id: acc.id,
    username: acc.username,
    password,
    ttl_ms: 5 * 60_000,
  });
}

interface ConfirmBody { lease_id?: string }

/** POST /v1/denuvo/auth/confirm — fix xong -> tru quota that + danh dau acc tot. */
export async function authConfirm(auth: AuthedDevice, bodyText: string, ip: string): Promise<Response> {
  const body = JSON.parse(bodyText || "{}") as ConfirmBody;
  const leaseId = String(body.lease_id ?? "");
  if (!leaseId) throw new HttpError(400, "bad_lease", "Thieu lease_id");

  const hold = await getHold(auth.device.id, leaseId);
  if (!hold) throw new HttpError(410, "lease_expired", "Phien da het han, hay thu lai");

  await commitLease(auth.device.id, hold.appid);   // <-- quota bi tru O DAY
  await delHold(auth.device.id, leaseId);

  if (hold.accountId != null) {
    const st = await getAcctState(hold.accountId);
    await setAcctState(hold.accountId, { failCount: 0, cooldownUntil: st.cooldownUntil, lastUsedAt: st.lastUsedAt });
  }
  await logLease({ at: Date.now(), deviceId: auth.device.id, accountId: hold.accountId, appid: hold.appid, ip, result: "ok", reason: "" });
  logLine("auth_confirm", { device_id: auth.device.id, appid: hold.appid, account_id: hold.accountId });

  return await sealed(auth, { ok: true, quota: await quotaStatus(auth.device.id) });
}

interface CancelBody { lease_id?: string; account_id?: number; ok?: boolean; reason?: string }

/** POST /v1/denuvo/auth/cancel — fix that bai / bo -> tra hold (khong tru quota) + bao acc hong. */
export async function authCancel(auth: AuthedDevice, bodyText: string, ip: string): Promise<Response> {
  const body = JSON.parse(bodyText || "{}") as CancelBody;
  const leaseId = String(body.lease_id ?? "");
  const hold = leaseId ? await getHold(auth.device.id, leaseId) : null;
  if (leaseId) await delHold(auth.device.id, leaseId);   // tra hold -> quota KHONG bi tru

  const accountId = Number(body.account_id ?? hold?.accountId);
  const good = body.ok === true;
  const reason = String(body.reason ?? "").slice(0, 200);

  if (Number.isInteger(accountId)) {
    const st = await getAcctState(accountId);
    const fails = good ? 0 : st.failCount + 1;
    await setAcctState(accountId, { failCount: fails, cooldownUntil: st.cooldownUntil, lastUsedAt: st.lastUsedAt });
    if (!good && fails >= cfg.limits.accountFailBlock) {
      logLine("account_blocked", { account_id: accountId, fails, reason });
    }
  }
  await logLease({
    at: Date.now(), deviceId: auth.device.id,
    accountId: Number.isInteger(accountId) ? accountId : null,
    appid: hold?.appid ?? null, ip, result: good ? "ok" : "login_fail", reason,
  });
  return await sealed(auth, { ok: true });
}

/** GET /v1/denuvo/permissions — trang thai han muc hien tai (de UI hien truoc khi fix). */
export async function permissions(auth: AuthedDevice): Promise<Response> {
  return await sealed(auth, { ok: true, quota: await quotaStatus(auth.device.id) });
}

/** GET /v1/denuvo/requirement — nguon tai extract_tickets. */
export async function requirement(auth: AuthedDevice): Promise<Response> {
  // Bang nay KHONG co cot `id` -> khong order duoc theo id.
  const rows = await db.select<RequirementRow>("denuvo_requirement", "select=url,file_type,zip_rar");
  return await sealed(auth, { ok: true, rows });
}

// ---------------------------------------------------------------- tien ich
function verLt(a: string, b: string): boolean {
  const A = a.split(".").map(Number), B = b.split(".").map(Number);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
