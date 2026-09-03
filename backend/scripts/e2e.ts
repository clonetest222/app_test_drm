// E2E: kiem tra mot backend DANG CHAY (local hoac da deploy).
//
//   deno task e2e                              -> http://localhost:8000
//   deno task e2e https://<project>.deno.dev   -> ban that
//
// Dung dung thuat toan ky trong api.js cua app, nen no kiem luon ca su an khop
// giua hai ben. Chay duoc voi backend that ma khong lam ban du lieu: chi tao
// them mot device test (co the xoa qua /v1/admin/devices/revoke).
import { createHash, createHmac, randomBytes } from "node:crypto";
const BASE = Deno.args[0] ?? "http://localhost:8000";

/** Phan hoi JSON cua backend - chi can vai truong nen khai bao long. */
type RespJson = { device_id?: string; device_secret?: string; code?: string } | null;

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

async function jreq(method: string, path: string, o: { headers?: Record<string,string>; body?: string | null } = {}) {
  const headers = o.headers ?? {}, body = o.body ?? null;
  const r = await fetch(BASE + path, {
    method,
    headers: { ...headers, ...(body != null ? { "Content-Type": "application/json" } : {}) },
    body,
  });
  let j: RespJson = null;
  const t = await r.text();
  try { j = JSON.parse(t); } catch { /* khong phai JSON - de nguyen null */ }
  return { status: r.status, json: j, raw: t };
}

function signHeaders(dev: { id: string; secret: string }, method: string, path: string, bodyText: string) {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const canonical = [method, path, ts, nonce, sha256Hex(bodyText)].join("\n");
  const sig = createHmac("sha256", dev.secret).update(canonical).digest("hex");
  return { "X-G4-Device": dev.id, "X-G4-Ts": ts, "X-G4-Nonce": nonce, "X-G4-Sig": sig };
}

await (async () => {
  let pass = 0, fail = 0;
  const check = (name: string, cond: boolean, extra?: string) => {
    if (cond) { console.log("  OK   " + name); pass++; }
    else { console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); fail++; }
  };

  // 1. dang ky thiet bi
  const fp = randomBytes(32).toString("hex");
  const reg = await jreq("POST", "/v1/device/register", {
    body: JSON.stringify({ fingerprint: fp, app_version: "1.1.0", platform: "win32" }),
  });
  check("dang ky thiet bi tra 200 + device_secret", reg.status === 200 && !!reg.json?.device_secret, reg.raw.slice(0, 120));
  const dev = { id: reg.json?.device_id ?? "", secret: reg.json?.device_secret ?? "" };

  // 2. dang ky lai cung fingerprint -> phai ra CUNG device id (khong tao rac)
  const reg2 = await jreq("POST", "/v1/device/register", {
    body: JSON.stringify({ fingerprint: fp, app_version: "1.1.0", platform: "win32" }),
  });
  check("dang ky lai cung may -> cung device_id", reg2.json?.device_id === dev.id, `${reg2.json?.device_id} vs ${dev.id}`);
  check("dang ky lai -> secret MOI (xoay khoa)", reg2.json?.device_secret !== dev.secret);
  dev.secret = reg2.json?.device_secret ?? dev.secret;

  // 3. goi khong ky -> 401
  const unsigned = await jreq("GET", "/v1/denuvo/requirement");
  check("khong ky -> 401 unsigned", unsigned.status === 401 && unsigned.json?.code === "unsigned", unsigned.raw.slice(0, 100));

  // 4. ky dung -> phai QUA duoc lop auth (khong con 401)
  const h = signHeaders(dev, "GET", "/v1/denuvo/requirement", "");
  const signed = await jreq("GET", "/v1/denuvo/requirement", { headers: h });
  check("ky dung -> qua duoc auth (khong phai 401)", signed.status !== 401, "status=" + signed.status);

  // 5. REPLAY dung lai y nguyen header -> phai bi chan
  const replay = await jreq("GET", "/v1/denuvo/requirement", { headers: h });
  check("replay cung nonce -> 401 replay", replay.status === 401 && replay.json?.code === "replay", replay.raw.slice(0, 120));

  // 6. chu ky sai -> 401
  const bad = { ...signHeaders(dev, "GET", "/v1/denuvo/requirement", ""), "X-G4-Sig": "a".repeat(64) };
  const badRes = await jreq("GET", "/v1/denuvo/requirement", { headers: bad });
  check("chu ky sai -> 401 bad_sig", badRes.status === 401 && badRes.json?.code === "bad_sig", badRes.raw.slice(0, 120));

  // 7. doi body sau khi ky -> chu ky khong con khop
  const bodyText = JSON.stringify({ appid: "1174180", exclude: [] });
  const h7 = signHeaders(dev, "POST", "/v1/denuvo/ticket", bodyText);
  const tampered = await jreq("POST", "/v1/denuvo/ticket", { headers: h7, body: JSON.stringify({ appid: "999" }) });
  check("sua body sau khi ky -> 401", tampered.status === 401, "status=" + tampered.status);

  // 8. dong ho lech -> 401
  const h8 = signHeaders(dev, "GET", "/v1/denuvo/requirement", "");
  h8["X-G4-Ts"] = String(Date.now() - 10 * 60_000);
  const skew = await jreq("GET", "/v1/denuvo/requirement", { headers: h8 });
  check("dong ho lech 10 phut -> 401 clock_skew", skew.status === 401 && skew.json?.code === "clock_skew", skew.raw.slice(0, 120));

  // 9. admin khong token -> 401
  const adm = await jreq("GET", "/v1/admin/health");
  check("admin khong token -> 401", adm.status === 401);

  console.log(`\n${pass} pass, ${fail} fail`);
  Deno.exit(fail ? 1 : 0);
})();
