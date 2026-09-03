// Rate limit dua tren audit log (denuvo_lease_log) — khong can Redis, ben qua restart.
// Muc dich KHONG phai chong DDoS ma la chan MOT device hut sach kho tai khoan.
import { cfg } from "./config.ts";
import { db } from "./supabase.ts";
import { HttpError } from "./http.ts";

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

export async function checkLeaseLimits(deviceId: string, appid: string): Promise<void> {
  const [hour, day, perApp] = await Promise.all([
    db.count("denuvo_lease_log", `device_id=eq.${deviceId}&result=eq.issued&created_at=gte.${isoAgo(3_600_000)}`),
    db.count("denuvo_lease_log", `device_id=eq.${deviceId}&result=eq.issued&created_at=gte.${isoAgo(86_400_000)}`),
    db.count(
      "denuvo_lease_log",
      `device_id=eq.${deviceId}&appid=eq.${appid}&result=eq.issued&created_at=gte.${isoAgo(600_000)}`,
    ),
  ]);

  if (perApp >= cfg.limits.perDeviceAppid10m) {
    throw new HttpError(429, "rate_appid", "Thu qua nhieu lan cho game nay, doi 10 phut roi thu lai");
  }
  if (hour >= cfg.limits.perDeviceHour) {
    throw new HttpError(429, "rate_hour", "Vuot gioi han theo gio, thu lai sau");
  }
  if (day >= cfg.limits.perDeviceDay) {
    throw new HttpError(429, "rate_day", "Vuot gioi han theo ngay, thu lai vao ngay mai");
  }
}

export async function checkEnrollLimit(ip: string): Promise<void> {
  const n = await db.count("denuvo_devices", `last_ip=eq.${encodeURIComponent(ip)}&created_at=gte.${isoAgo(3_600_000)}`);
  if (n >= cfg.limits.enrollPerIpHour) {
    throw new HttpError(429, "rate_enroll", "Dang ky thiet bi qua nhieu tu IP nay");
  }
}
