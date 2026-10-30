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
//    ["hold", deviceId, leaseId]       request dang cho confirm, TTL 10 phut
//    ["lease", ts_rand]                audit, TTL 90 ngay
// ============================================================================
import { hex, randomBytes } from "./crypto.ts";
import { MemKv } from "./memkv.ts";

// Chi dung mot phan nho cua API Deno.Kv -> khai bao vua du de MemKv thay the duoc.
type KvLike = Pick<Deno.Kv, "get" | "getMany" | "set" | "list" | "atomic" | "delete">;

let _kv: KvLike | null = null;
let _inMemory = false;

/**
 * Mo KV. Deno Deploy doi phai GAN mot KV database trong dashboard truoc; chua
 * gan thi Deno.openKv() nem loi. Thay vi chet luc khoi dong, roi xuong ban
 * trong bo nho — backend van chay, chi mat state khi isolate khoi dong lai.
 * Gan KV trong dashboard la tu dong dung KV that, khong phai sua code.
 */
export async function kv(): Promise<KvLike> {
  if (_kv) return _kv;
  try {
    _kv = await Deno.openKv();
  } catch (e) {
    _inMemory = true;
    console.warn(
      [
        "",
        "!!! KHONG MO DUOC DENO KV - dang chay bang bo nho tam !!!",
        "    " + String(e instanceof Error ? e.message : e),
        "",
        "    Backend van chay binh thuong. Nhung moi lan isolate khoi dong lai:",
        "      - thiet bi phai dang ky lai (app tu lam, nguoi dung khong thay gi)",
        "      - bo dem rate limit ve 0",
        "      - audit log mat",
        "",
        "    Khac phuc: Deno Deploy > Databases > gan mot KV database vao app",
        "    roi deploy lai. Khong phai sua code.",
        "",
      ].join("\n"),
    );
    _kv = new MemKv() as unknown as KvLike;
  }
  return _kv;
}

/** Dang chay bang bo nho tam hay KV that (bao ra /health). */
export function kvIsInMemory(): boolean {
  return _inMemory;
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

  // Dung SO THUONG, khong dung Deno.KvU64: kieu do chi ton tai khi KV bat, ma
  // ban du phong trong bo nho thi khong co. Doi lai phai tu cong.
  const cur = await db.get<number>(key);
  const next = (typeof cur.value === "number" ? cur.value : 0) + 1;

  // Ghi co kiem versionstamp -> hai request cung luc thi mot cai thua, thu lai
  // mot lan roi thoi. Rate limit khong can chinh xac tuyet doi.
  const res = await db.atomic()
    .check({ key, versionstamp: cur.versionstamp })
    .set(key, next, { expireIn: windowMs * 2 })
    .commit();
  if (res.ok) return next;

  const again = await db.get<number>(key);
  const n2 = (typeof again.value === "number" ? again.value : 0) + 1;
  await db.set(key, n2, { expireIn: windowMs * 2 });
  return n2;
}

/**
 * Doc gia tri bo dem cua cua so HIEN TAI ma KHONG tang.
 * Dung o buoc auth/request de kiem tra han muc truoc; quota chi bi TRU THAT
 * (bumpCounter) khi auth/confirm. Nho vay lan fix that bai khong an mat quota.
 */
export async function readCounter(parts: (string | number)[], windowMs: number): Promise<number> {
  const bucket = Math.floor(Date.now() / windowMs);
  const key = ["rate", ...parts, bucket] as Deno.KvKey;
  const cur = await (await kv()).get<number>(key);
  return typeof cur.value === "number" ? cur.value : 0;
}

// ------------------------------------------------------------- hold (giu cho)
// Mot "hold" = mot lan auth/request DANG CHO ket qua (confirm hoac cancel).
// Han muc tinh ca hold dang treo (chong spam request khong bao gio confirm),
// nhung quota CHI bi tru that o auth/confirm. App tat giua chung -> hold tu het
// han sau HOLD_TTL_MS, khong ket dinh quota.
export interface Hold {
  appid: string;
  accountId: number | null;
  at: number;
}
export const HOLD_TTL_MS = 10 * 60_000;

export async function putHold(deviceId: string, leaseId: string, h: Hold): Promise<void> {
  await (await kv()).set(["hold", deviceId, leaseId], h, { expireIn: HOLD_TTL_MS });
}
export async function getHold(deviceId: string, leaseId: string): Promise<Hold | null> {
  return (await (await kv()).get<Hold>(["hold", deviceId, leaseId])).value ?? null;
}
export async function delHold(deviceId: string, leaseId: string): Promise<void> {
  await (await kv()).delete(["hold", deviceId, leaseId]);
}
/** Danh sach hold dang treo cua 1 device (da loc het han nho TTL cua KV). */
export async function listHolds(deviceId: string): Promise<Hold[]> {
  const out: Hold[] = [];
  for await (const e of (await kv()).list<Hold>({ prefix: ["hold", deviceId] }, { limit: 100 })) {
    out.push(e.value);
  }
  return out;
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
