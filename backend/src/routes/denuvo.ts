// TRAI TIM CUA BAN VA NAY.
//
// Truoc:  app cam publishable key -> GET denuvo_accounts -> nhan CA BANG mat khau plaintext.
// Sau :   app ky request -> backend giai ma DUNG 1 tai khoan cho DUNG 1 appid,
//         tra ve trong phong bi ma hoa rieng cho device do, co han su dung, co log.
//
// Response envelope: { enc: 1, iv, ct }  voi khoa = HKDF(device_secret, nonce request).
// => Ke dat proxy TLS (Fiddler/mitmproxy) giua app va server VAN khong doc duoc payload.
import { cfg } from "../config.ts";
import { db, type AccountRow, type RequirementRow } from "../supabase.ts";
import { deriveResponseKey, open, seal } from "../crypto.ts";
import { HttpError, logLine, ok } from "../http.ts";
import { checkLeaseLimits } from "../ratelimit.ts";
import type { AuthedDevice } from "../auth.ts";

/** Boc payload vao phong bi ma hoa gan voi device + nonce cua chinh request nay. */
async function sealed(auth: AuthedDevice, payload: unknown): Promise<Response> {
  const key = await deriveResponseKey(auth.secret, auth.nonce);
  const box = await seal(key, JSON.stringify(payload), `resp:${auth.device.id}:${auth.nonce}`);
  return ok({ enc: 1, iv: box.iv, ct: box.ct });
}

/**
 * Lay mat khau cua 1 account.
 * Doc cot `password` plaintext nhu truoc; neu dong do co ban ma hoa (ENCRYPT_AT_REST)
 * thi uu tien ban ma hoa. Gia tri tra ve CHI ton tai trong bo nho cua request nay,
 * va chi di ra ngoai qua phong bi AES-256-GCM trong sealed().
 */
async function accountPassword(acc: AccountRow): Promise<string | null> {
  if (acc.password_enc && acc.password_iv) {
    try {
      return await open(cfg.encKey, { ct: acc.password_enc, iv: acc.password_iv }, `acct:${acc.id}`);
    } catch {
      logLine("decrypt_fail", { account_id: acc.id });
      return null;
    }
  }
  return acc.password ?? null;   // duong chinh: cot plaintext, y nhu truoc
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
 *      backend tu lay ticket, app KHONG con thay mat khau bao gio nua; protocol da san sang)
 */
export async function ticket(auth: AuthedDevice, bodyText: string, ip: string): Promise<Response> {
  const body = JSON.parse(bodyText || "{}") as TicketBody;
  const appid = String(body.appid ?? "").trim();
  if (!/^\d{1,10}$/.test(appid)) throw new HttpError(400, "bad_appid", "appid khong hop le");

  if (cfg.minAppVersion && verLt(body.app_version ?? "0", cfg.minAppVersion)) {
    throw new HttpError(426, "app_outdated", `Can cap nhat app len ${cfg.minAppVersion} tro len`);
  }

  await checkLeaseLimits(auth.device.id, appid);

  const nowIso = new Date().toISOString();
  const exclude = (body.exclude ?? []).filter((n) => Number.isInteger(n)).slice(0, 50);
  const notIn = exclude.length ? `&id=not.in.(${exclude.join(",")})` : "";

  // Uu tien account lau chua dung nhat -> trai deu tai, giam nguy co Steam khoa 1 acc.
  const accounts = await db.select<AccountRow>(
    "denuvo_accounts",
    `select=*&appid=eq.${appid}&status=eq.available` +
      `&or=(cooldown_until.is.null,cooldown_until.lt.${nowIso})` +
      `${notIn}&order=last_used_at.asc.nullsfirst&limit=1`,
  );

  const acc = accounts[0];
  if (!acc) {
    await logLease(auth.device.id, null, appid, ip, "no_account", exclude.length ? "het account de thu" : "");
    throw new HttpError(404, "no_account", "Chua co tai khoan kha dung cho game nay");
  }

  const password = await accountPassword(acc);
  if (!password) {
    await logLease(auth.device.id, acc.id, appid, ip, "no_password", "");
    throw new HttpError(500, "no_password", "Tai khoan chua co mat khau hop le");
  }

  const [logRow] = await db.insert<{ id: number }>("denuvo_lease_log", {
    device_id: auth.device.id,
    account_id: acc.id,
    appid,
    ip,
    result: "issued",
  });

  // Dat cooldown NGAY khi phat: neu app khong bao ket qua ve, account van khong bi
  // xoay vong lien tuc (Steam khoa tam neu login qua day).
  await db.update("denuvo_accounts", `id=eq.${acc.id}`, {
    last_used_at: nowIso,
    cooldown_until: new Date(Date.now() + cfg.limits.accountCooldownSec * 1000).toISOString(),
  });
  await db.update("denuvo_devices", `id=eq.${auth.device.id}`, { last_seen_at: nowIso, last_ip: ip });

  logLine("lease_issued", { device_id: auth.device.id, appid, account_id: acc.id, lease_id: logRow?.id });

  return await sealed(auth, {
    mode: "lease",
    lease_id: logRow?.id ?? 0,
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
 * App bao lai ket qua -> backend biet account nao hong ma tu chan, va co audit trail thuc.
 */
export async function ticketResult(auth: AuthedDevice, bodyText: string, ip: string): Promise<Response> {
  const body = JSON.parse(bodyText || "{}") as ResultBody;
  const accountId = Number(body.account_id);
  const good = body.ok === true;
  const reason = String(body.reason ?? "").slice(0, 200);

  await db.insert(
    "denuvo_lease_log",
    {
      device_id: auth.device.id,
      account_id: Number.isInteger(accountId) ? accountId : null,
      ip,
      result: good ? "ok" : "login_fail",
      reason,
    },
    false,
  );

  if (Number.isInteger(accountId)) {
    const acc = await db.selectOne<AccountRow>("denuvo_accounts", `select=*&id=eq.${accountId}`);
    if (acc) {
      const fails = good ? 0 : (acc.fail_count ?? 0) + 1;
      const patch: Record<string, unknown> = { fail_count: fails };
      if (!good && fails >= cfg.limits.accountFailBlock) {
        patch.status = "blocked";
        patch.note = `tu chan sau ${fails} lan login loi: ${reason}`;
        logLine("account_blocked", { account_id: accountId, fails, reason });
      }
      if (good) patch.cooldown_until = null;
      await db.update("denuvo_accounts", `id=eq.${accountId}`, patch);
    }
  }

  return await sealed(auth, { ok: true });
}

/** GET /v1/denuvo/requirement — nguon tai extract_tickets (khong con de anon doc). */
export async function requirement(auth: AuthedDevice): Promise<Response> {
  const rows = await db.select<RequirementRow>("denuvo_requirement", "select=url,file_type,zip_rar&order=id.asc");
  return await sealed(auth, { ok: true, rows });
}

// ---------------------------------------------------------------- tien ich
async function logLease(
  deviceId: string,
  accountId: number | null,
  appid: string,
  ip: string,
  result: string,
  reason: string,
): Promise<void> {
  try {
    await db.insert("denuvo_lease_log", { device_id: deviceId, account_id: accountId, appid, ip, result, reason }, false);
  } catch { /* log hong khong duoc lam hong request */ }
}

function verLt(a: string, b: string): boolean {
  const A = a.split(".").map(Number), B = b.split(".").map(Number);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
