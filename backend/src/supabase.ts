// Client Supabase REST toi gian, dung SERVICE ROLE key (di xuyen RLS).
// Khong dung @supabase/supabase-js de backend khong keo theo dependency nao.
import { cfg } from "./config.ts";

const baseHeaders = {
  apikey: cfg.serviceKey,
  Authorization: `Bearer ${cfg.serviceKey}`,
  "Content-Type": "application/json",
};

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...baseHeaders, ...(init.headers ?? {}) },
  });
  return r;
}

async function json<T>(r: Response): Promise<T> {
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export const db = {
  /** SELECT. `query` la chuoi PostgREST, vd "select=*&appid=eq.123&limit=5". */
  select<T = Record<string, unknown>>(table: string, query: string): Promise<T[]> {
    return rest(`${table}?${query}`).then((r) => json<T[]>(r));
  },

  async selectOne<T = Record<string, unknown>>(table: string, query: string): Promise<T | null> {
    const rows = await db.select<T>(table, `${query}&limit=1`);
    return rows[0] ?? null;
  },

  insert<T = Record<string, unknown>>(table: string, row: unknown, ret = true): Promise<T[]> {
    return rest(table, {
      method: "POST",
      headers: { Prefer: ret ? "return=representation" : "return=minimal" },
      body: JSON.stringify(row),
    }).then((r) => json<T[]>(r));
  },

  update<T = Record<string, unknown>>(table: string, query: string, patch: unknown): Promise<T[]> {
    return rest(`${table}?${query}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch),
    }).then((r) => json<T[]>(r));
  },

  upsert<T = Record<string, unknown>>(table: string, row: unknown, onConflict: string): Promise<T[]> {
    return rest(`${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row),
    }).then((r) => json<T[]>(r));
  },

  /** Dem so dong khop dieu kien (khong keo du lieu ve). */
  async count(table: string, query: string): Promise<number> {
    const r = await rest(`${table}?${query}&select=id`, {
      method: "HEAD",
      headers: { Prefer: "count=exact", Range: "0-0" },
    });
    const cr = r.headers.get("content-range") ?? "";
    const n = Number(cr.split("/")[1]);
    return Number.isFinite(n) ? n : 0;
  },

  /** INSERT bo qua neu trung khoa chinh — dung cho nonce chong replay. */
  async insertIfNew(table: string, row: unknown): Promise<boolean> {
    const r = await rest(table, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
    if (r.status === 409) { await r.body?.cancel(); return false; }   // trung nonce = replay
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await r.body?.cancel();
    return true;
  },
};

// ------------------------------------------------------------------ kieu bang
export interface AccountRow {
  id: number;
  appid: string;
  username: string;
  password?: string | null;      // cot cu (plaintext) — se bi xoa sau migrate
  password_enc?: string | null;
  password_iv?: string | null;
  enc_ver?: number | null;
  status: string;
  fail_count?: number | null;
  cooldown_until?: string | null;
  last_used_at?: string | null;
}

export interface DeviceRow {
  id: string;
  fingerprint: string;
  secret_enc: string;
  secret_iv: string;
  app_version: string | null;
  revoked: boolean;
  revoke_reason: string | null;
  lease_count: number;
}

export interface RequirementRow {
  id?: number;
  url: string;
  file_type: string;
  zip_rar: boolean;
}
