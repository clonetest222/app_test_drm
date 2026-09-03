// Rate limit bang bo dem trong Deno KV.
//
// Muc dich KHONG phai chong DDoS ma la chan MOT may hut sach kho tai khoan.
// Khoa gan lien voi so hieu cua so thoi gian + co TTL, nen khong can don rac.
import { cfg } from "./config.ts";
import { bumpCounter } from "./kv.ts";
import { HttpError } from "./http.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const TEN_MIN = 600_000;

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
