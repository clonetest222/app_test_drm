// Xac thuc request tu app:
//
//   X-G4-Device  : uuid device (cap luc dang ky)
//   X-G4-Ts      : unix ms
//   X-G4-Nonce   : 32 hex ngau nhien, chi dung 1 lan
//   X-G4-Sig     : hex HMAC-SHA256(device_secret, canonical)
//
//   canonical = METHOD \n PATH \n TS \n NONCE \n sha256hex(body)
//
// Chong:
//   * gia mao       — khong co device_secret thi khong ky duoc
//   * replay        — nonce ghi vao denuvo_nonce (unique), ts lech > 2 phut la loai
//   * doi body/path — ca hai nam trong chuoi ky
import { cfg } from "./config.ts";
import { db, type DeviceRow } from "./supabase.ts";
import { hmacHex, open, sha256Hex, timingSafeEqual } from "./crypto.ts";
import { HttpError } from "./http.ts";

export interface AuthedDevice {
  device: DeviceRow;
  secret: string;   // da giai ma, CHI ton tai trong bo nho request nay
  nonce: string;
}

export async function requireDevice(req: Request, bodyText: string): Promise<AuthedDevice> {
  const deviceId = req.headers.get("x-g4-device") ?? "";
  const ts = req.headers.get("x-g4-ts") ?? "";
  const nonce = req.headers.get("x-g4-nonce") ?? "";
  const sig = req.headers.get("x-g4-sig") ?? "";

  if (!deviceId || !ts || !nonce || !sig) {
    throw new HttpError(401, "unsigned", "Request chua duoc ky");
  }
  if (!/^[0-9a-f]{32,64}$/i.test(nonce) || !/^[0-9a-f]{64}$/i.test(sig)) {
    throw new HttpError(401, "bad_sig_format", "Chu ky sai dinh dang");
  }
  // Chan som device id rac: de lot xuong PostgREST se thanh loi 400 -> 500 khong can thiet.
  if (!/^[0-9a-f-]{36}$/i.test(deviceId)) {
    throw new HttpError(401, "unknown_device", "Thiet bi chua dang ky");
  }

  const skew = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(skew) || skew > cfg.maxSkewMs) {
    throw new HttpError(401, "clock_skew", "Dong ho may lech qua nhieu, kiem tra gio he thong");
  }

  const device = await db.selectOne<DeviceRow>("denuvo_devices", `select=*&id=eq.${encodeURIComponent(deviceId)}`);
  if (!device) throw new HttpError(401, "unknown_device", "Thiet bi chua dang ky");
  if (device.revoked) {
    throw new HttpError(403, "device_revoked", device.revoke_reason || "Thiet bi da bi khoa");
  }

  const secret = await open(cfg.encKey, { ct: device.secret_enc, iv: device.secret_iv }, `device:${device.id}`);

  const url = new URL(req.url);
  const canonical = [req.method, url.pathname, ts, nonce, await sha256Hex(bodyText)].join("\n");
  const expect = await hmacHex(secret, canonical);
  if (!timingSafeEqual(expect, sig.toLowerCase())) {
    throw new HttpError(401, "bad_sig", "Chu ky khong hop le");
  }

  // Nonce chi duoc dung 1 lan (khoa chinh) -> chan replay.
  const fresh = await db.insertIfNew("denuvo_nonce", { nonce, device_id: device.id });
  if (!fresh) throw new HttpError(401, "replay", "Request da duoc dung roi");

  return { device, secret, nonce };
}

export function requireAdmin(req: Request): void {
  const t = req.headers.get("x-g4-admin") ?? "";
  if (!t || !timingSafeEqual(t, cfg.adminToken)) {
    throw new HttpError(401, "admin_denied", "Sai admin token");
  }
}
