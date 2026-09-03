// Client Supabase REST — CHI DOC.
//
// Backend khong ghi gi vao Supabase nua: moi state (thiet bi, nonce, cooldown,
// audit) nam trong Deno KV. Nho vay:
//   * khong phai chay lenh SQL nao, khong tao bang nao
//   * chay duoc bang publishable key (anon thuong chi co quyen doc)
//
// Neu sau nay doi sang service_role, code nay khong phai sua gi.
import { cfg } from "./config.ts";

const headers = {
  apikey: cfg.supabaseKey,
  Authorization: `Bearer ${cfg.supabaseKey}`,
};

export const db = {
  /** SELECT. `query` la chuoi PostgREST, vd "select=*&appid=eq.123&limit=5". */
  async select<T = Record<string, unknown>>(table: string, query: string): Promise<T[]> {
    const r = await fetch(`${cfg.supabaseUrl}/rest/v1/${table}?${query}`, { headers });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : []) as T[];
  },

  async selectOne<T = Record<string, unknown>>(table: string, query: string): Promise<T | null> {
    const rows = await db.select<T>(table, `${query}&limit=1`);
    return rows[0] ?? null;
  },
};

// ------------------------------------------------------------------ kieu bang
export interface AccountRow {
  id: number;
  appid: string;
  username: string;
  password?: string | null;      // cot plaintext, giu nguyen nhu truoc
  password_enc?: string | null;  // chi co neu bat ENCRYPT_AT_REST
  password_iv?: string | null;
  status: string;
}

export interface RequirementRow {
  url: string;
  file_type: string;
  zip_rar: boolean;
}

export interface ReleaseRow {
  version: string;
  url: string;
  notes: string | null;
  mandatory?: boolean | null;
}
