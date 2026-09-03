// Dang ky thiet bi. Moi cai dat app tao 1 device_secret rieng -> tu do moi
// request deu ky duoc, va co the KHOA RIENG tung may khi phat hien lam ro ri.
//
// Thiet bi luu trong Deno KV, khong dung bang Supabase nao.
import { cfg, secrets } from "../config.ts";
import { getDeviceByFingerprint, putDevice, type Device } from "../kv.ts";
import { hex, randomBytes, seal, timingSafeEqual } from "../crypto.ts";
import { HttpError, logLine, ok } from "../http.ts";
import { checkEnrollLimit } from "../ratelimit.ts";

interface EnrollBody {
  fingerprint?: string;
  app_version?: string;
  platform?: string;
}

export async function enroll(req: Request, bodyText: string, ip: string): Promise<Response> {
  // ENROLL_TOKEN khong dat -> bo qua kiem tra. Token nay von nam trong app nen
  // ai cung rut duoc; no chua bao gio la bi mat that. Rao can that la gioi han
  // theo IP ben duoi + rate limit khi xin credential.
  if (cfg.enrollToken && !timingSafeEqual(req.headers.get("x-g4-enroll") ?? "", cfg.enrollToken)) {
    throw new HttpError(401, "enroll_denied", "Ban app khong hop le");
  }

  const body = JSON.parse(bodyText || "{}") as EnrollBody;
  const fp = (body.fingerprint ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fp)) throw new HttpError(400, "bad_fingerprint", "Fingerprint sai dinh dang");

  // Da co device cho may nay -> XOAY secret moi (cai lai app la mat secret cu,
  // chuyen binh thuong). Khong tao them dong rac cho cung mot may.
  const existing = await getDeviceByFingerprint(fp);
  if (existing?.revoked) {
    throw new HttpError(403, "device_revoked", existing.revokeReason || "Thiet bi da bi khoa");
  }
  if (!existing) await checkEnrollLimit(ip);

  const secret = hex.enc(randomBytes(32));
  const id = existing?.id ?? crypto.randomUUID();
  const sealed = await seal(secrets.encKey, secret, `device:${id}`);

  const device: Device = {
    id,
    fingerprint: fp,
    secret: sealed.ct,
    secretIv: sealed.iv,
    appVersion: body.app_version ?? null,
    platform: body.platform ?? null,
    revoked: false,
    revokeReason: null,
    createdAt: existing?.createdAt ?? Date.now(),
    lastSeenAt: Date.now(),
    lastIp: ip,
  };
  await putDevice(device);

  logLine("device_enroll", { device_id: id, ip, renewed: !!existing, app_version: body.app_version });
  return ok({ ok: true, device_id: id, device_secret: secret });
}
