// Kiem tra ban cap nhat (installer + hot-update giao dien).
// Khong chua bi mat -> khong ma hoa response, nhung VAN qua backend de app
// khong con phai cam key Supabase nao het.
import { db, type ReleaseRow } from "../supabase.ts";
import { logLine, ok } from "../http.ts";

async function latest(table: string): Promise<Response> {
  let row: ReleaseRow | null = null;
  try {
    row = await db.selectOne<ReleaseRow>(table, "select=version,url,notes,mandatory&order=created_at.desc");
  } catch (e) {
    // Bang chua tao (PGRST205) / Supabase loi / mat mang -> KHONG duoc 500.
    // "Khong biet co ban moi" phai xu ly y het "chua co ban moi": app im lang chay
    // tiep, dung nhu ban g4_tool cu (no bat loi va coi nhu khong co update).
    logLine("update_check_fail", { table, error: String((e as Error)?.message ?? e).slice(0, 200) });
    return ok({ ok: true, found: false, unavailable: true });
  }
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
