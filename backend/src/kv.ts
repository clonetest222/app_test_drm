// ============================================================================
//  Deno KV — noi chua TAT CA state cua backend.
//
//  Vi sao khong dung Supabase cho phan nay:
//    * khong phai chay lenh SQL nao, khong tao bang nao -> cai dat = 0 buoc
//    * app chi cam publishable key (= anon), ma anon thuong khong duoc GHI vao
//      Supabase; KV thi backend toan quyen, khong dinh gi toi RLS
//    * KV co TTL san (expireIn) -> nonce/rate-limit/audit tu het han, khong
//      can job don rac
//
//  Supabase gio CHI CON dung de DOC (accounts / requirement / releases).
//
//  Layout khoa:
//    ["cfg","enc_key"]                 khoa AES tu sinh lan dau
//    ["cfg","admin_token"]             admin token tu sinh lan dau
//    ["device", id]                    { fingerprint, secret, revoked, ... }
//    ["device_fp", fingerprint]        -> id  (tra cuu nguoc)
//    ["nonce", nonce]                  chong replay, TTL 5 phut
//    ["acct", accountId]               { fail_count, cooldown_until, last_used_at }
//    ["rate", deviceId, bucket]        dem so lan, TTL theo cua so
//    ["lease", ts_rand]                audit, TTL 90 ngay
// ============================================================================
import { hex, randomBytes } from "./crypto.ts";

let _kv: Deno.Kv | null = null;

/** Mo KV (1 lan cho ca tien trinh). Tren Deno Deploy khong can cau hinh gi. */
export async function kv(): Promise<Deno.Kv> {
  if (!_kv) _kv = await Deno.openKv();
  return _kv;
}

// ---------------------------------------------------------------- bi mat
export interface Secrets {
  encKey: string;      // base64 32 byte
  adminToken: string;
  /** true = vua sinh lan dau (de main.ts in ra cho biet). */
  freshAdminToken: boolean;
}

/**
 * Lay bi mat: uu tien bien moi truong, khong co thi tu sinh va luu vao KV.
 *
 * Nho vay backend chay duoc voi DUNG 2 bien SUPABASE_* — khong phai dat them
 * gi. Gia tri tu sinh nam trong KV nen SONG QUA moi lan deploy lai; neu no
 * mat thi app chi phai dang ky lai thiet bi, khong mat du lieu that.
 */
export async function loadSecrets(env: {
  encKey?: string;
  adminToken?: string;
}): Promise<Secrets> {
  const db = await kv();

  let encKey = env.encKey ?? "";
  if (!encKey) {
    const got = await db.get<string>(["cfg", "enc_key"]);
    if (got.value) {
      encKey = got.value;
    } else {
      encKey = btoa(String.fromCharCode(...randomBytes(32)));
      // check: chi ghi neu chua ai ghi -> 2 instance khoi dong cung luc van
      // thong nhat mot khoa duy nhat.
      const res = await db.atomic().check({ key: ["cfg", "enc_key"], versionstamp: null })
        .set(["cfg", "enc_key"], encKey).commit();
      if (!res.ok) encKey = (await db.get<string>(["cfg", "enc_key"])).value ?? encKey;
    }
  }

  let adminToken = env.adminToken ?? "";
  let fresh = false;
  if (!adminToken) {
    const got = await db.get<string>(["cfg", "admin_token"]);
    if (got.value) {
      adminToken = got.value;
    } else {
      adminToken = hex.enc(randomBytes(32));
      const res = await db.atomic().check({ key: ["cfg", "admin_token"], versionstamp: null })
        .set(["cfg", "admin_token"], adminToken).commit();
      if (res.ok) fresh = true;
      else adminToken = (await db.get<string>(["cfg", "admin_token"])).value ?? adminToken;
    }
  }

  return { encKey, adminToken, freshAdminToken: fresh };
}

// ---------------------------------------------------------------- thiet bi
export interface Device {
  id: string;
  fingerprint: string;
  secret: string;              // ma hoa AES truoc khi ghi (xem devices.ts)
  secretIv: string;
  appVersion: string | null;
  platform: string | null;
  revoked: boolean;
  revokeReason: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  lastIp: string | null;
}

export async function getDevice(id: string): Promise<Device | null> {
  return (await (await kv()).get<Device>(["device", id])).value ?? null;
}

export async function getDeviceByFingerprint(fp: string): Promise<Device | null> {
  const db = await kv();
  const id = (await db.get<string>(["device_fp", fp])).value;
  if (!id) return null;
  return (await db.get<Device>(["device", id])).value ?? null;
}

export async function putDevice(d: Device): Promise<void> {
  await (await kv()).atomic()
    .set(["device", d.id], d)
    .set(["device_fp", d.fingerprint], d.id)
    .commit();
}

export async function touchDevice(id: string, ip: string): Promise<void> {
  const d = await getDevice(id);
  if (!d) return;
  d.lastSeenAt = Date.now();
  d.lastIp = ip;
  await (await kv()).set(["device", id], d);
}

export async function listDevices(limit = 100): Promise<Device[]> {
  const out: Device[] = [];
  for await (const e of (await kv()).list<Device>({ prefix: ["device"] }, { limit })) out.push(e.value);
  return out;
}

// ---------------------------------------------------------------- nonce
/** Ghi nonce; tra false neu nonce da dung roi (= request bi phat lai). */
export async function claimNonce(nonce: string, deviceId: string): Promise<boolean> {
  const res = await (await kv()).atomic()
    .check({ key: ["nonce", nonce], versionstamp: null })     // phai chua ton tai
    .set(["nonce", nonce], deviceId, { expireIn: 5 * 60_000 })
    .commit();
  return res.ok;
}

// ------------------------------------------------------- trang thai account
export interface AcctState {
  failCount: number;
  cooldownUntil: number;   // epoch ms, 0 = khong cooldown
  lastUsedAt: number;
}

export async function getAcctState(id: number): Promise<AcctState> {
  const v = (await (await kv()).get<AcctState>(["acct", id])).value;
  return v ?? { failCount: 0, cooldownUntil: 0, lastUsedAt: 0 };
}

export async function setAcctState(id: number, s: AcctState): Promise<void> {
  await (await kv()).set(["acct", id], s);
}

/** Doc trang thai nhieu account mot luot (getMany toi da 10 khoa/lan). */
export async function getAcctStates(ids: number[]): Promise<Map<number, AcctState>> {
  const db = await kv();
  const out = new Map<number, AcctState>();
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const res = await db.getMany<AcctState[]>(chunk.map((id) => ["acct", id]));
    res.forEach((r, k) => {
      out.set(chunk[k]!, r.value ?? { failCount: 0, cooldownUntil: 0, lastUsedAt: 0 });
    });
  }
  return out;
}

// ---------------------------------------------------------------- rate limit
/**
 * Tang bo dem cua mot cua so thoi gian roi tra ve gia tri moi.
 * Khoa gan lien voi so hieu cua so nen cua so cu tu het han, khong can don.
 */
export async function bumpCounter(parts: (string | number)[], windowMs: number): Promise<number> {
  const db = await kv();
  const bucket = Math.floor(Date.now() / windowMs);
  const key = ["rate", ...parts, bucket] as Deno.KvKey;
  const res = await db.atomic().sum(key, 1n).commit();
  if (!res.ok) return 0;
  const cur = await db.get<Deno.KvU64>(key);
  // Dat han cho ban ghi (sum khong nhan expireIn) -> ghi de bang chinh gia tri do.
  await db.set(key, cur.value ?? new Deno.KvU64(1n), { expireIn: windowMs * 2 });
  return Number(cur.value?.value ?? 1n);
}

// ---------------------------------------------------------------- audit
export interface LeaseLog {
  at: number;
  deviceId: string;
  accountId: number | null;
  appid: string | null;
  ip: string;
  result: string;
  reason: string;
}

const NINETY_DAYS = 90 * 24 * 3600_000;

export async function logLease(e: LeaseLog): Promise<void> {
  // Khoa giam dan theo thoi gian -> list() tu tra ve moi nhat truoc, khong can sap xep.
  const key = ["lease", Number.MAX_SAFE_INTEGER - e.at, hex.enc(randomBytes(4))];
  await (await kv()).set(key, e, { expireIn: NINETY_DAYS });
}

export async function listLeases(
  filter: { deviceId?: string; appid?: string; limit: number },
): Promise<LeaseLog[]> {
  const out: LeaseLog[] = [];
  // Quet toi da 10x so dong can, tranh quet vo han khi loc qua hep.
  const scanMax = Math.min(filter.limit * 10, 2000);
  let scanned = 0;
  for await (const e of (await kv()).list<LeaseLog>({ prefix: ["lease"] }, { limit: scanMax })) {
    scanned++;
    const v = e.value;
    if (filter.deviceId && v.deviceId !== filter.deviceId) continue;
    if (filter.appid && v.appid !== filter.appid) continue;
    out.push(v);
    if (out.length >= filter.limit) break;
  }
  return out;
}

/** Dem so lan phat credential trong khoang thoi gian gan day (cho /v1/admin/health). */
export async function countRecentLeases(sinceMs: number): Promise<number> {
  const cutoff = Date.now() - sinceMs;
  let n = 0;
  for await (const e of (await kv()).list<LeaseLog>({ prefix: ["lease"] }, { limit: 1000 })) {
    if (e.value.at < cutoff) break;      // khoa sap theo thoi gian giam dan
    if (e.value.result === "issued") n++;
  }
  return n;
}
