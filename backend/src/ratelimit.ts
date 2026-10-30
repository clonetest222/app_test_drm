// Rate limit bang bo dem trong Deno KV.
//
// Muc dich KHONG phai chong DDoS ma la chan MOT may hut sach kho tai khoan.
// Khoa gan lien voi so hieu cua so thoi gian + co TTL, nen khong can don rac.
import { cfg } from "./config.ts";
import { bumpCounter, listHolds, readCounter } from "./kv.ts";
import { HttpError } from "./http.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const TEN_MIN = 600_000;

/**
 * KIEM TRA han muc o buoc auth/request — KHONG tru quota.
 * Dem = so lan DA confirm trong cua so (readCounter) + so hold dang treo. Nho
 * dem ca hold ma mot may khong the spam request lien tuc de giu het account;
 * nhung lan fix that bai (cancel) khong bi tinh vao quota that.
 */
export async function checkLeaseAvailable(deviceId: string, appid: string): Promise<void> {
  const holds = await listHolds(deviceId);
  const holdTotal = holds.length;
  const holdApp = holds.filter((h) => h.appid === appid).length;

  const [perApp, hour, day] = await Promise.all([
    readCounter([deviceId, "app", appid], TEN_MIN),
    readCounter([deviceId, "h"], HOUR),
    readCounter([deviceId, "d"], DAY),
  ]);

  if (perApp + holdApp >= cfg.limits.perDeviceAppid10m) {
    throw new HttpError(429, "rate_appid", "Thu qua nhieu lan cho game nay, doi 10 phut roi thu lai");
  }
  if (hour + holdTotal >= cfg.limits.perDeviceHour) {
    throw new HttpError(429, "rate_hour", "Vuot gioi han theo gio, thu lai sau");
  }
  if (day + holdTotal >= cfg.limits.perDeviceDay) {
    throw new HttpError(429, "rate_day", "Vuot gioi han theo ngay, thu lai vao ngay mai");
  }
}

/** TRU quota THAT — goi o auth/confirm khi fix da thanh cong. */
export async function commitLease(deviceId: string, appid: string): Promise<void> {
  await Promise.all([
    bumpCounter([deviceId, "app", appid], TEN_MIN),
    bumpCounter([deviceId, "h"], HOUR),
    bumpCounter([deviceId, "d"], DAY),
  ]);
}

/** Trang thai han muc hien tai cua 1 device (cho GET /v1/denuvo/permissions). */
export async function quotaStatus(deviceId: string): Promise<{
  hour: { used: number; limit: number; remaining: number };
  day: { used: number; limit: number; remaining: number };
  pending: number;
}> {
  const [hour, day, holds] = await Promise.all([
    readCounter([deviceId, "h"], HOUR),
    readCounter([deviceId, "d"], DAY),
    listHolds(deviceId),
  ]);
  const pending = holds.length;
  return {
    hour: {
      used: hour,
      limit: cfg.limits.perDeviceHour,
      remaining: Math.max(0, cfg.limits.perDeviceHour - hour - pending),
    },
    day: {
      used: day,
      limit: cfg.limits.perDeviceDay,
      remaining: Math.max(0, cfg.limits.perDeviceDay - day - pending),
    },
    pending,
  };
}

/** (Legacy) tang bo dem NGAY khi xin — dung cho endpoint /v1/denuvo/ticket cu. */
export async function checkLeaseLimits(deviceId: string, appid: string): Promise<void> {
  // Tang truoc roi so — mot lan xin la mot lan tinh, ke ca khi sau do khong co
  // account nao. Nguoc lai thi goi hong lien tuc se khong bi tinh gi ca.
  const [perApp, hour, day] = await Promise.all([
    bumpCounter([deviceId, "app", appid], TEN_MIN),
    bumpCounter([deviceId, "h"], HOUR),
    bumpCounter([deviceId, "d"], DAY),
  ]);

  if (perApp > cfg.limits.perDeviceAppid10m) {
    throw new HttpError(429, "rate_appid", "Thu qua nhieu lan cho game nay, doi 10 phut roi thu lai");
  }
  if (hour > cfg.limits.perDeviceHour) {
    throw new HttpError(429, "rate_hour", "Vuot gioi han theo gio, thu lai sau");
  }
  if (day > cfg.limits.perDeviceDay) {
    throw new HttpError(429, "rate_day", "Vuot gioi han theo ngay, thu lai vao ngay mai");
  }
}

export async function checkEnrollLimit(ip: string): Promise<void> {
  const n = await bumpCounter(["enroll", ip], HOUR);
  if (n > cfg.limits.enrollPerIpHour) {
    throw new HttpError(429, "rate_enroll", "Dang ky thiet bi qua nhieu tu IP nay");
  }
}
