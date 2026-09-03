// ============================================================================
//  G4play Denuvo Manage — Backend (Deno)
//
//  Ly do ton tai: app Electron KHONG duoc phep cam key doc thang bang
//  denuvo_accounts nua. Moi thu cham vao credential deu di qua day, noi giu
//  service-role key + khoa ma hoa, va noi co the rate-limit / khoa / ghi log.
//
//  Chay local : deno task dev        (doc backend/.env)
//  Deploy     : Deno Deploy (tro vao main.ts) hoac `deno task start` sau reverse proxy
// ============================================================================
import { cfg, secrets } from "./src/config.ts";
import { requireAdmin, requireDevice } from "./src/auth.ts";
import { clientIp, fail, HttpError, logLine, ok } from "./src/http.ts";
import { enroll } from "./src/routes/devices.ts";
import { requirement, ticket, ticketResult } from "./src/routes/denuvo.ts";
import { release, renderer } from "./src/routes/updates.ts";
import * as admin from "./src/routes/admin.ts";
import { kvIsInMemory, loadSecrets } from "./src/kv.ts";

async function route(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const ip = clientIp(req, info);
  // Doc body MOT lan: chuoi tho nay chinh la thu duoc dua vao chu ky HMAC.
  const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();

  if (path === "/" || path === "/health") {
    return ok({
      ok: true,
      service: "g4play-denuvo-manage",
      env: cfg.env,
      // Bao ra day de nhin mot cai la biet lo hong da dong chua, khong phai doan.
      bao_mat: cfg.usingAnonKey
        ? "CHUA VA XONG - dang dung key anon, chay sql/02_khoa_anon.sql khi san sang"
        : "da khoa anon",
      luu_tru: kvIsInMemory() ? "bo nho tam (chua gan Deno KV)" : "Deno KV",
      time: new Date().toISOString(),
    });
  }

  // ---- cong khai (co enroll token) ----
  if (path === "/v1/device/register" && req.method === "POST") return await enroll(req, bodyText, ip);
  if (path === "/v1/update/release" && req.method === "GET") return await release();
  if (path === "/v1/update/renderer" && req.method === "GET") return await renderer();

  // ---- can chu ky device ----
  if (path.startsWith("/v1/denuvo/")) {
    const auth = await requireDevice(req, bodyText);
    if (path === "/v1/denuvo/ticket" && req.method === "POST") return await ticket(auth, bodyText, ip);
    if (path === "/v1/denuvo/ticket/result" && req.method === "POST") return await ticketResult(auth, bodyText, ip);
    if (path === "/v1/denuvo/requirement" && req.method === "GET") return await requirement(auth);
  }

  // ---- quan tri ----
  if (path.startsWith("/v1/admin/")) {
    requireAdmin(req);
    if (path === "/v1/admin/accounts" && req.method === "GET") return await admin.listAccounts(url);
    if (path === "/v1/admin/accounts/reset" && req.method === "POST") return await admin.resetAccount(bodyText);
    if (path === "/v1/admin/devices" && req.method === "GET") return await admin.devices(url);
    if (path === "/v1/admin/devices/revoke" && req.method === "POST") return await admin.revokeDevice(bodyText);
    if (path === "/v1/admin/audit" && req.method === "GET") return await admin.audit(url);
    if (path === "/v1/admin/health" && req.method === "GET") return await admin.health();
  }

  return fail(404, "not_found", "Khong co endpoint nay");
}

const handler = {
  async fetch(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
    const started = Date.now();
    const url = new URL(req.url);
    try {
      const res = await route(req, info);
      logLine("req", { m: req.method, p: url.pathname, s: res.status, ms: Date.now() - started });
      return res;
    } catch (e) {
      if (e instanceof HttpError) {
        logLine("req_err", { m: req.method, p: url.pathname, s: e.status, code: e.code });
        return e.toResponse();
      }
      // Loi khong luong truoc: log day du o server, tra ve client CHUNG CHUNG
      // (thong bao loi chi tiet la mot kenh ro ri thong tin).
      logLine("req_crash", { m: req.method, p: url.pathname, err: String(e instanceof Error ? e.stack : e) });
      return fail(500, "internal", "Loi may chu");
    }
  },
} satisfies Deno.ServeDefaultExport;

// Cho `deno serve main.ts` va cac host dung default export.
export default handler;

// Nap bi mat TRUOC khi phuc vu request dau tien. Khong dat trong env thi tu sinh
// va giu trong KV -> backend chay duoc voi dung 2 bien SUPABASE_*.
const s = await loadSecrets({ encKey: cfg.encKeyEnv, adminToken: cfg.adminTokenEnv });
secrets.encKey = s.encKey;
secrets.adminToken = s.adminToken;

if (import.meta.main) {
  const canhBao: string[] = [];
  if (cfg.usingAnonKey) {
    canhBao.push(
      "!!! DANG DUNG KEY ANON (publishable) !!!",
      "    Backend chay duoc, nhung `anon` van doc duoc denuvo_accounts, nghia la",
      "    app 1.0.0 da phat hanh VAN dump duoc ca kho tai khoan Steam.",
      "    De dong han: lay secret key o Supabase > Project Settings > API Keys,",
      "    dat vao SUPABASE_SERVICE_ROLE_KEY, roi chay sql/02_khoa_anon.sql.",
      "",
    );
  }
  if (!cfg.enrollToken) {
    canhBao.push(
      "ENROLL_TOKEN khong dat -> bo qua kiem tra khi dang ky thiet bi.",
      "    Chi con gioi han theo IP. Dat bien do (trung G4_ENROLL_TOKEN cua app) de siet lai.",
      "",
    );
  }
  if (s.freshAdminToken) {
    // In DUY NHAT lan dau. Cac lan sau doc lai tu KV nen khong in nua.
    canhBao.push(
      "ADMIN_TOKEN vua duoc sinh va luu vao Deno KV. CHEP LAI NGAY:",
      "",
      "    " + s.adminToken,
      "",
      "    Dung o header X-G4-Admin cho cac endpoint /v1/admin/*.",
      "    Muon tu dat thi khai bien ADMIN_TOKEN, no se de len gia tri nay.",
      "",
    );
  }
  if (canhBao.length) console.warn("\n" + canhBao.join("\n"));

  // Mo cong bang `deno run main.ts` — day la cach Deno Deploy chay entrypoint,
  // va cung la cach chay o may/VPS. Deploy cap cong qua bien PORT.
  //
  // Goi VO DIEU KIEN, khong do theo DENO_DEPLOYMENT_ID: doan sai bien do la
  // server khong mo cong nao ca, deploy bao "Warm up failed" rat kho tim ra.
  // Neu chay bang `deno serve` thi default export da mo cong roi -> lan bind
  // thu hai nem AddrInUse, nuot di la xong.
  try {
    Deno.serve(
      { port: cfg.port, onListen: (a) => console.log(`G4play Denuvo API dang chay tren cong ${a.port}`) },
      handler.fetch,
    );
  } catch (e) {
    if (!(e instanceof Deno.errors.AddrInUse)) throw e;
  }
}
