// Kiem tra ban cap nhat (installer + hot-update giao dien).
// Khong chua bi mat -> khong ma hoa response, nhung VAN qua backend de app
// khong con phai cam key Supabase nao het.
import { db, type ReleaseRow } from "../supabase.ts";
import { ok } from "../http.ts";

async function latest(table: string): Promise<Response> {
  const row = await db.selectOne<ReleaseRow>(table, "select=version,url,notes,mandatory&order=created_at.desc");
  if (!row?.version) return ok({ ok: true, found: false });
  return ok({
    ok: true,
    found: true,
    version: row.version,
    url: row.url,
    notes: row.notes,
    mandatory: !!row.mandatory,
  });
}

export const release = () => latest("denuvo_releases");
export const renderer = () => latest("denuvo_renderer");
