// Dang ky thiet bi. Moi cai dat app tao 1 device_secret rieng -> tu do moi request
// deu ky duoc va co the KHOA RIENG tung may khi phat hien lam ro ri tai khoan.
import { cfg } from "../config.ts";
import { db, type DeviceRow } from "../supabase.ts";
import { randomBytes, hex, seal, timingSafeEqual } from "../crypto.ts";
import { HttpError, logLine, ok } from "../http.ts";
import { checkEnrollLimit } from "../ratelimit.ts";

interface EnrollBody {
  fingerprint?: string;
  app_version?: string;
  platform?: string;
}

export async function enroll(req: Request, bodyText: string, ip: string): Promise<Response> {
  if (!timingSafeEqual(req.headers.get("x-g4-enroll") ?? "", cfg.enrollToken)) {
    throw new HttpError(401, "enroll_denied", "Ban app khong hop le");
  }

  const body = JSON.parse(bodyText || "{}") as EnrollBody;
  const fp = (body.fingerprint ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fp)) throw new HttpError(400, "bad_fingerprint", "Fingerprint sai dinh dang");

  // Da co device cho may nay -> XOAY secret moi (app mat secret sau khi cai lai la binh thuong).
  const existing = await db.selectOne<DeviceRow>("denuvo_devices", `select=*&fingerprint=eq.${fp}`);
  if (existing?.revoked) {
    throw new HttpError(403, "device_revoked", existing.revoke_reason || "Thiet bi da bi khoa");
  }

  const secret = hex.enc(randomBytes(32));
  const id = existing?.id ?? crypto.randomUUID();
  const sealed = await seal(cfg.encKey, secret, `device:${id}`);

  const row = {
    id,
    fingerprint: fp,
    secret_enc: sealed.ct,
    secret_iv: sealed.iv,
    app_version: body.app_version ?? null,
    platform: body.platform ?? null,
    last_seen_at: new Date().toISOString(),
    last_ip: ip,
  };

  if (existing) {
    await db.update("denuvo_devices", `id=eq.${id}`, row);
  } else {
    await checkEnrollLimit(ip);
    await db.insert("denuvo_devices", row, false);
  }

  logLine("device_enroll", { device_id: id, ip, renewed: !!existing, app_version: body.app_version });
  return ok({ ok: true, device_id: id, device_secret: secret });
}
