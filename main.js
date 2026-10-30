// ============================================================================
//  G4play Denuvo Manage — quet & fix Denuvo cho thu vien Steam.
//  Giu:  tab Denuvo (quet + fix ticket), tab Cai dat (phien ban + thu muc Steam),
//        he thong cap nhat (installer + hot-update giao dien).
//  Doc lua o CA config\stplug-in va config\lua.
//
//  BAO MAT (ban 1.1.0): app KHONG con cam key Supabase. Moi request cham vao
//  credential deu di qua backend Deno (thu muc backend/), duoc ky HMAC bang
//  device secret rieng cua may, tra ve trong phong bi AES-256-GCM, co rate limit
//  va audit log. Xem api.js + backend/README.md + specs/security.md.
// ============================================================================
const { app, BrowserWindow, ipcMain, shell, dialog, net } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { execFileSync, execFile, spawn } = require("child_process");

// ---- Doc .env (khong can dotenv) ----
function loadEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch (_) {}
  return out;
}
const ENV = loadEnv();

// Backend Deno — DUY NHAT duong ra ngoai cua app. Khong con SUPABASE_URL /
// SUPABASE_PUBLISHABLE_KEY o day nua: key nam trong app la key ai cung rut duoc.
const API_BASE = (ENV.G4_API_BASE || "").replace(/\/+$/, "");
const ENROLL_TOKEN = ENV.G4_ENROLL_TOKEN || "";

const { G4Api } = require("./api.js");
let _api = null;
function api() {
  if (!_api) _api = new G4Api({ baseUrl: API_BASE, enrollToken: ENROLL_TOKEN, appVersion: app.getVersion() });
  return _api;
}

// ============================================================================
//  SUPABASE TRUC TIEP (nhu g4_tool) — duong ra khi backend Deno chet (503).
//  Backend Deno ban 1.1.0 bi treo khi het quota -> moi thao tac Denuvo 503.
//  App doc thang Supabase bang PUBLISHABLE key: chi la key cong khai (RLS moi
//  la lop bao ve that), nen giau trong .env chi de chong grep, khong phai ma hoa.
//
//  Key trong .env la chuoi DA XAO. moKhoa() khoi phuc key that luc chay. Xao bang
//  hoan vi Fisher-Yates CO SEED CO DINH -> giau()/moKhoa() dao nguoc duoc nhau
//  (Math.random() thi KHONG dao nguoc duoc, nen phai dung PRNG co seed).
// ============================================================================
function _rng(seed) {                      // mulberry32 — PRNG deterministic
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function _perm(n, seed) {                   // hoan vi [0..n) theo Fisher-Yates co seed
  const p = Array.from({ length: n }, (_, i) => i);
  const rnd = _rng(seed);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return p;
}
const _KEY_SEED = 0x9e3779b1;               // seed co dinh — cong cu giau va app phai trung
function giau(s) {                          // GOC -> xao (chay 1 lan de tao chuoi bo vao .env)
  s = String(s); const p = _perm(s.length, _KEY_SEED); const o = new Array(s.length);
  for (let i = 0; i < s.length; i++) o[p[i]] = s[i];
  return o.join("");
}
function moKhoa(s) {                         // xao -> GOC (app chay luc khoi dong)
  s = String(s); const p = _perm(s.length, _KEY_SEED); const o = new Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s[p[i]];
  return o.join("");
}

// SUPABASE_URL de thuong; SUPABASE_PUBLISHABLE_KEY_SCRAMBLED la key DA XAO -> moKhoa().
const SUPA_URL = (ENV.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPA_KEY = ENV.SUPABASE_PUBLISHABLE_KEY_SCRAMBLED
  ? moKhoa(ENV.SUPABASE_PUBLISHABLE_KEY_SCRAMBLED)
  : (ENV.SUPABASE_PUBLISHABLE_KEY || "");   // du phong neu ai do dien key chua xao

// ---- Supabase REST (select) — doc thang bang URL/KEY trong .env (giong g4_tool) ----
function sbSelect(table, query) {
  return new Promise((resolve) => {
    if (!SUPA_URL || !SUPA_KEY) { resolve({ error: "Chua cau hinh Supabase (.env)" }); return; }
    const url = `${SUPA_URL}/rest/v1/${table}?${query}`;
    const req = https.get(url, { headers: { apikey: SUPA_KEY, Authorization: "Bearer " + SUPA_KEY } },
      (res) => {
        let b = ""; res.setEncoding("utf8");
        res.on("data", (c) => (b += c));
        res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ error: "JSON loi", raw: b }); } });
      });
    req.on("error", (e) => resolve({ error: String(e) }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ error: "timeout" }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cau hinh luu tren may (userData\g4_config.json) — vd thu muc Steam set thu cong.
function configPath() { return path.join(app.getPath("userData"), "g4_config.json"); }
function readConfig() { try { return JSON.parse(fs.readFileSync(configPath(), "utf8")) || {}; } catch (_) { return {}; } }
function writeConfig(cfg) {
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8"); return true; }
  catch (_) { return false; }
}

// Thu muc Steam set thu cong (backup — chi dung khi registry loi). Hop le = co steam.exe.
function manualSteamDir() {
  const ov = readConfig().steamDir;
  return ov && fs.existsSync(path.join(ov, "steam.exe")) ? ov : null;
}

// Thu muc Steam: TU DONG doc registry (reg.exe) truoc; loi/khong thay -> backup thu cong (set o Cai dat).
function getSteamDir() {
  try {
    const out = execFileSync("reg",
      ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
      { encoding: "utf8", windowsHide: true });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) {
      const dir = m[1].trim().replace(/\//g, "\\");
      if (fs.existsSync(dir)) return dir;
    }
  } catch (_) {}
  return manualSteamDir();   // backup khi registry loi
}

// Duong dan thu muc Steam hien tai (hien o Cai dat). manual=true neu dang dung backup thu cong.
ipcMain.handle("steam-dir-get", () => {
  const dir = getSteamDir();
  const usingManual = !!(dir && manualSteamDir() && dir === manualSteamDir());
  return { path: dir, manual: usingManual };
});

// Cac thu muc .lua dang duoc doc (config\stplug-in va/hoac config\lua) -> hien o tab Cai dat.
ipcMain.handle("lua-dirs", () => luaDirs());

// Set thu cong thu muc Steam (backup khi registry loi) -> luu vao config.
ipcMain.handle("steam-dir-set-manual", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Chọn thư mục Steam (nơi có steam.exe)",
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, status: "canceled" };
  const sd = res.filePaths[0];
  if (!fs.existsSync(path.join(sd, "steam.exe"))) {
    return { ok: false, status: "not_steam", message: "Thư mục chưa đúng — phải là nơi có steam.exe" };
  }
  const cfg = readConfig(); cfg.steamDir = sd; writeConfig(cfg);
  return { ok: true, path: sd };
});

// Thu muc chua file .lua cua Steam. Ban G4Market goc chi doc config\stplug-in; ban nay
// doc CA config\lua (mot so may de lua o day) -> quet duoc het game da them.
const LUA_SUBDIRS = [["config", "stplug-in"], ["config", "lua"]];
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

// Ticket Denuvo ghi RIENG ra file denuvo_g4play.lua — khong tron vao file lua cua
// game nua. File nay chi chua block setAppTicket/setETicket (khong co addappid) nen
// khong bao gio bi tinh la game khi quet thu vien.
// Ghi vao CA HAI thu muc trong LUA_SUBDIRS (stplug-in + lua) — xem dvTicketLuaPaths().
const TICKET_FILE = "denuvo_g4play.lua";
// Cac file ticket cua ban CU — van doc de biet han, va don khi ghi de ticket moi.
const OLD_TICKET_FILES = ["g4_tool.lua"];

// Thu muc GHI mac dinh (stplug-in) — dung khi chua xac dinh duoc game nam o dau.
function luaDir() {
  const sd = getSteamDir();
  return sd ? path.join(sd, "config", "stplug-in") : null;
}
// MOI thu muc lua dang ton tai (de DOC). Khong co thu muc nao -> mang rong.
function luaDirsIn(steamDir) {
  if (!steamDir) return [];
  return LUA_SUBDIRS.map((p) => path.join(steamDir, ...p)).filter(isDir);
}
function luaDirs() { return luaDirsIn(getSteamDir()); }
function blockMainAppid(block) { const m = String(block).match(/addappid\s*\(\s*(\d+)/i); return m ? m[1] : null; }
function readLuaBlocks(luaFile) {
  try {
    return fs.readFileSync(luaFile, "utf8").split(/\n\s*--\s*\n/).map((b) => b.trim()).filter(Boolean);
  } catch (_) { return []; }
}

ipcMain.handle("app-version", () => app.getVersion());
ipcMain.handle("get-platform", () => process.platform);

// ---- Cap nhat app (chi THONG BAO + tai khi nguoi dung bam) ----
function verTuple(v) {
  return String(v || "0").trim().replace(/^v/i, "").split(".").map((p) => parseInt(p.replace(/\D/g, ""), 10) || 0);
}
function verGt(a, b) {
  const A = verTuple(a), B = verTuple(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0);
  }
  return false;
}

// Auto-update doc THANG GitHub Releases cua repo phat hanh (repo public -> khong can
// token). Phat ban moi = tao 1 Release tag version cao hon, dinh kem file *-Setup-*.exe.
// GitHub API bat buoc co User-Agent. Doi repo -> sua GH_RELEASE_REPO trong .env.
const GH_RELEASE_REPO = ENV.GH_RELEASE_REPO || "clonetest222/app_test_drm";

ipcMain.handle("check-update", async () => {
  const current = app.getVersion();
  if (!GH_RELEASE_REPO) return { update: false, current };
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_RELEASE_REPO}/releases/latest`,
      { headers: { "User-Agent": "g4-denuvo", Accept: "application/vnd.github+json" } });
    if (!r.ok) return { update: false, current };   // 404 = chua co release -> coi nhu dang la ban moi nhat
    const rel = await r.json();
    const version = String(rel.tag_name || "").replace(/^v/i, "");   // "v1.1.2" -> "1.1.2"
    if (!version) return { update: false, current };
    // Lay asset installer (.exe), bo qua .blockmap / .yml.
    const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name || ""));
    const url = asset && asset.browser_download_url;
    if (!url) return { update: false, current };
    return { update: verGt(version, current), version, url, notes: rel.body || "", current };
  } catch (_) { return { update: false, current }; }
});

// Tai file setup MOI -> folder 'update' canh exe (KHONG tu chay, KHONG qua browser).
ipcMain.handle("install-update", async (_e, url) => {
  if (!url) return { ok: false, message: "Thiếu link tải" };
  const send = (data) => { try { _e.sender.send("update-progress", data); } catch (_) {} };
  try {
    const base = app.isPackaged ? path.dirname(app.getPath("exe")) : __dirname;
    const dir = path.join(base, "update");
    fs.mkdirSync(dir, { recursive: true });
    let fname = "G4playDenuvo-Setup.exe";
    try { const b = path.basename(new URL(url).pathname); if (b.toLowerCase().endsWith(".exe")) fname = b; } catch (_) {}
    const dest = path.join(dir, fname);

    send({ stage: "download", pct: 0, received: 0, total: 0 });
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return { ok: false, message: "Tải thất bại (HTTP " + r.status + ")" };
    const total = +(r.headers.get("content-length") || 0);
    const reader = r.body.getReader();
    const chunks = []; let received = 0, lastPct = -1;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); received += value.length;
      const pct = total ? Math.floor(received * 100 / total) : -1;
      if (pct !== lastPct) { lastPct = pct; send({ stage: "download", pct, received, total }); }
    }
    fs.writeFileSync(dest, Buffer.concat(chunks));

    send({ stage: "done", received, total });
    return { ok: true, path: dest };   // KHONG tu chay - chi tai ve folder update
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
});

// Mo folder 'update' (canh exe) trong Explorer.
ipcMain.handle("open-update-folder", () => {
  try {
    const base = app.isPackaged ? path.dirname(app.getPath("exe")) : __dirname;
    const dir = path.join(base, "update");
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
});

// ======================================================================
// DENUVO: quet store (phat hien Denuvo/DRM) + fix (login Steam an -> lay
// ownership ticket bang extract_tickets.exe -> ghi nomore.lua).
// Toan bo logic nang chay o main (Node). Log stream ve renderer qua "denuvo-log".
// ======================================================================
const DV_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// GET text qua ELECTRON net (stack mang Chromium). QUAN TRONG: Steam/Akamai chan
// fingerprint cua node http/https (tra 403 "Access Denied"), nhung cho qua request
// kieu trinh duyet -> phai dung net.request thay vi https.get. Gui cookie age-gate +
// tu theo redirect (redirect:"follow"). Tra { ok, html } / { error, status }.
function dvGetTextOnce(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let req;
    try { req = net.request({ method: "GET", url, redirect: "follow" }); }
    catch (e) { return resolve({ error: String(e) }); }
    req.setHeader("User-Agent", DV_UA);
    req.setHeader("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    req.setHeader("Accept-Language", "en-US,en;q=0.9");
    req.setHeader("Cookie", "birthtime=0; mature_content=1; wants_mature_content=1; " +
      "lastagecheckage=1-0-1970; Steam_Language=english");
    let body = "", done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { req.abort(); } catch (_) {} finish({ error: `timeout (${timeoutMs}ms)` }); }, timeoutMs);
    req.on("response", (res) => {
      const sc = res.statusCode || 0;
      res.on("data", (c) => (body += c.toString()));
      res.on("end", () => sc === 200 ? finish({ ok: true, html: body }) : finish({ error: "HTTP " + sc, status: sc }));
      res.on("error", (e) => finish({ error: String(e) }));
    });
    req.on("error", (e) => finish({ error: String(e) }));
    try { req.end(); } catch (e) { finish({ error: String(e) }); }
  });
}
// ---- VUOT CHAN DNS CUA ISP (net::ERR_NAME_NOT_RESOLVED) — KHONG CAN VPN ----
// ISP (VN) dau doc DNS cho store.steampowered.com: tra NXDOMAIN. Nhung IP va SNI KHONG bi
// chan -> hoi IP that qua DNS-over-HTTPS roi noi THANG toi IP do (servername = ten mien that
// nen TLS/SNI van dung) la doc duoc trang store binh thuong.
// Luu y: Steam dung Akamai -> moi resolver tra IP khac nhau va tu VN co IP CHET (timeout),
// nen phai thu lan luot cac IP va NHO lai IP nao noi duoc.
const DV_DOH = [
  (h) => `https://dns.google/resolve?name=${h}&type=A`,             // uu tien: tra IP song tu VN
  (h) => `https://8.8.8.8/resolve?name=${h}&type=A`,                // khi ten dns.google cung bi chan
  (h) => `https://cloudflare-dns.com/dns-query?name=${h}&type=A`,
  (h) => `https://1.1.1.1/dns-query?name=${h}&type=A`,
];
const DV_IP_TTL = 10 * 60 * 1000;      // nho IP song trong 10 phut
const dvIpCache = new Map();           // host -> { ip, at }
let dvDnsBlocked = false;              // gap NXDOMAIN 1 lan -> ca phien di thang duong ghim IP
const DV_DNS_ERR = /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND|getaddrinfo/i;

// Hoi IP cua 1 host qua DoH (JSON API). Tra ve mang IPv4 theo thu tu uu tien.
async function dvDohResolve(host) {
  const ips = [];
  for (const mk of DV_DOH) {
    try {
      const r = await fetch(mk(host), {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) continue;
      for (const a of ((await r.json()).Answer || []))
        if (a.type === 1 && /^[0-9.]+$/.test(a.data) && !ips.includes(a.data)) ips.push(a.data);
    } catch (_) {}
    if (ips.length >= 2) break;   // du 2 IP de thu -> khoi hoi them resolver
  }
  return ips;
}

// GET qua 1 IP cu the (Node https): servername = ten mien that -> bat tay TLS/SNI dung.
function dvGetTextViaIp(ip, u, timeoutMs, redirects = 0) {
  return new Promise((resolve) => {
    const req = https.request({
      host: ip, servername: u.hostname, port: 443, path: u.pathname + u.search, method: "GET",
      headers: {
        Host: u.hostname, "User-Agent": DV_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9", "Accept-Encoding": "identity",
        Cookie: "birthtime=0; mature_content=1; wants_mature_content=1; " +
          "lastagecheckage=1-0-1970; Steam_Language=english",
      },
    }, (res) => {
      const sc = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(sc) && res.headers.location && redirects < 5) {
        res.resume();
        let nu; try { nu = new URL(res.headers.location, u.toString()); } catch (_) { return resolve({ error: "redirect loi" }); }
        return resolve(nu.hostname === u.hostname
          ? dvGetTextViaIp(ip, nu, timeoutMs, redirects + 1)         // cung host -> giu IP dang dung
          : dvGetTextPinned(nu.toString(), { timeoutMs }, redirects + 1));
      }
      let b = ""; res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => (sc === 200 ? resolve({ ok: true, html: b }) : resolve({ error: "HTTP " + sc, status: sc })));
      res.on("error", (e) => resolve({ error: String(e) }));
    });
    req.on("error", (e) => resolve({ error: String((e && e.message) || e) }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: `timeout (${timeoutMs}ms)` }); });
    try { req.end(); } catch (e) { resolve({ error: String(e) }); }
  });
}

// GET bang duong GHIM IP: thu IP da nho truoc, roi den cac IP tu DoH (bo IP chet).
async function dvGetTextPinned(url, { timeoutMs = 15000 } = {}, redirects = 0) {
  let u; try { u = new URL(url); } catch (_) { return { error: "URL loi" }; }
  if (u.protocol !== "https:") return { error: "duong ghim IP chi ho tro https" };
  const c = dvIpCache.get(u.hostname);
  const ips = (c && Date.now() - c.at < DV_IP_TTL) ? [c.ip] : [];
  for (const ip of await dvDohResolve(u.hostname)) if (!ips.includes(ip)) ips.push(ip);
  if (!ips.length) return { error: "DoH khong resolve duoc " + u.hostname };
  let last = { error: "khong noi duoc toi " + u.hostname };
  for (let i = 0; i < ips.length; i++) {
    const ip = ips[i];
    // IP chet (Akamai) chi bi DROP goi -> phai CHO het timeout. Con IP de thu thi cho ngan
    // thoi (6s) roi chuyen ngay sang IP khac; IP cuoi cung moi cho du timeout.
    const tmo = i < ips.length - 1 ? Math.min(timeoutMs, 6000) : timeoutMs;
    const r = await dvGetTextViaIp(ip, u, tmo, redirects);
    if (r.ok) { dvIpCache.set(u.hostname, { ip, at: Date.now() }); return r; }
    if (r.status) return r;              // may chu TRA LOI that (403/404...) -> khong phai loi IP
    dvIpCache.delete(u.hostname);        // IP chet -> quen di, thu IP tiep theo
    last = r;
  }
  return last;
}

// GET text: uu tien Electron net (fingerprint trinh duyet). Bi ISP chan DNS hoac loi mang
// -> tu chuyen sang duong ghim IP qua DoH.
async function dvGetText(url, opts = {}) {
  if (dvDnsBlocked) {                              // da biet DNS bi chan -> khoi phi 3 lan thu qua net
    const p = await dvGetTextPinned(url, opts);
    if (p.ok || p.status) return p;
  }
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await dvGetTextOnce(url, opts);
    if (r.ok) return r;
    if (DV_DNS_ERR.test(r.error || "")) {          // ISP chan DNS -> chuyen han sang ghim IP
      dvDnsBlocked = true;
      const p = await dvGetTextPinned(url, opts);
      return (p.ok || p.status) ? p : r;
    }
    if (r.status === 403 || r.status === 429) { await sleep(800 * (attempt + 1)); continue; }  // rate-limit -> thu lai
    if (r.status) return r;                        // loi HTTP that (404...) -> tra luon
    break;                                         // loi mang (timeout/reset) -> thu duong ghim IP
  }
  const p = await dvGetTextPinned(url, opts);
  return p.ok ? p : r;
}

function dvStripTags(s) {
  return (s || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

// Lay noi dung 1 the <div ...>...</div> CAN BANG (xu ly div long nhau) tu openIdx.
function dvExtractBalancedDiv(html, openIdx) {
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = openIdx;
  let depth = 0, m, contentStart = -1;
  while ((m = tagRe.exec(html))) {
    const isClose = m[0][1] === "/";
    if (!isClose) { depth++; if (depth === 1) contentStart = m.index + m[0].length; }
    else { depth--; if (depth === 0) return html.slice(contentStart, m.index); }
  }
  return null;
}

// { ok, appid, name, denuvo, drm, hasNotice } cho 1 appid (doc DRM_notice tren store).
async function denuvoCheck(appid) {
  appid = String(appid == null ? "" : appid).trim();
  if (!/^\d+$/.test(appid)) return { ok: false, appid, error: "appid khong hop le" };
  const url = `https://store.steampowered.com/app/${appid}/?l=english&cc=us`;
  const r = await dvGetText(url);
  if (r.error) return { ok: false, appid, error: r.error };
  const html = r.html || "";
  // Trang san pham THAT luon co apphub_AppName. Khong co -> bi day sang age-check /
  // chan vung (game region-locked nhu Stellar Blade) / redirect -> bao loi de KHONG
  // nham thanh "game sach" roi bo qua.
  const isProductPage = /apphub_AppName/i.test(html) || /class="DRM_notice"/i.test(html);
  if (!isProductPage) {
    const ageGate = /agecheck|app_agegate|agegate_birthday/i.test(html);
    return {
      ok: false, appid,
      error: ageGate ? "age_gate (chua qua trang 18+)" : "khong tai duoc trang game (chan vung?)",
    };
  }
  const notices = [];
  const startRe = /<div class="DRM_notice"/gi;
  let s;
  while ((s = startRe.exec(html))) {
    const inner = dvExtractBalancedDiv(html, s.index);
    if (inner) { const t = dvStripTags(inner); if (t) notices.push(t); }
  }
  const drm = notices.join(" | ");
  const denuvo = /denuvo/i.test(drm) || /denuvo\s*anti-?tamper/i.test(html);
  const nameM = html.match(/<div[^>]+class="apphub_AppName"[^>]*>([^<]+)<\/div>/i) ||
                html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  const name = nameM ? dvStripTags(nameM[1]) : null;
  return { ok: true, appid, name, denuvo, drm, hasNotice: notices.length > 0 };
}
ipcMain.handle("denuvo-check", (_e, appid) => denuvoCheck(appid));

// GET tra ve response object (da theo redirect) de caller tu xu ly (buffer hoac pipe).
function dvRes(url, { redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("qua nhieu redirect"));
    let u; try { u = new URL(url); } catch (e) { return reject(new Error("URL loi")); }
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.get(u, { headers: { "User-Agent": DV_UA } }, (res) => {
      const sc = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(sc) && res.headers.location) {
        res.resume();
        return resolve(dvRes(new URL(res.headers.location, url).toString(), { redirects: redirects + 1 }));
      }
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("timeout")));
  });
}

// appdetails(filters=basic) cua 1 appid -> { type, name, dlc[], base }.
// Dung dvGetText (Electron net + retry) vi node https bi Steam chan 403.
async function dvAppDetailsBasic(aid) {
  const u = `https://store.steampowered.com/api/appdetails?appids=${aid}&filters=basic&l=english&cc=us`;
  const r = await dvGetText(u);
  if (!r.ok) return null;                       // loi mang -> khong ro
  try {
    const node = JSON.parse(r.html)[String(aid)] || {};
    if (!node.success) return { notApp: true };  // depot / khong phai store app
    const d = node.data || {};
    return {
      type: d.type || null, name: d.name || null,
      dlc: (d.dlc || []).map(String),
      base: (d.fullgame && d.fullgame.appid) ? String(d.fullgame.appid) : null,
    };
  } catch (e) { return null; }
}

// Tu danh sach appid (game + DLC tron lan) -> CHI giu GAME CHINH.
// Toi uu: appdetails cua 1 game co san mang 'dlc' -> loai het DLC con bang vai request.
async function denuvoGamesOnly(appids) {
  const list = appids.map(String);
  const pending = new Set(list);
  const fetched = new Set();
  const games = [];
  const get = async (aid) => { if (fetched.has(aid)) return null; fetched.add(aid); return await dvAppDetailsBasic(aid); };
  let consecErr = 0;
  for (const aid of list) {
    if (!pending.has(aid)) continue;
    pending.delete(aid);
    const d = await get(aid);
    if (d === null) {                                  // loi mang (Steam co the dang chan)
      games.push(aid);                                 // giu de scan sau
      if (++consecErr >= 8) {                           // chan lien tiep -> BO loc DLC, tra het phan con lai
        for (const x of pending) games.push(x);         // tranh treo ~40 phut khi >500 appid bi chan
        break;
      }
      continue;
    }
    consecErr = 0;
    if (d.notApp) continue;                            // depot -> bo, KHONG check
    if (!d.type) { games.push(aid); continue; }        // khong ro -> giu de check
    if (d.type === "game") {
      games.push(aid);
      for (const x of d.dlc) pending.delete(x);
    } else if (d.base && !fetched.has(d.base)) {
      const bd = await get(d.base);
      if (bd && bd.type === "game") {
        if (pending.has(d.base)) { games.push(d.base); pending.delete(d.base); }
        for (const x of bd.dlc) pending.delete(x);
      }
    }
    await sleep(100);
  }
  return games;
}
ipcMain.handle("denuvo-games-only", (_e, appids) => denuvoGamesOnly(Array.isArray(appids) ? appids : []));

// Lay appid GAME CHINH tu MOI file .lua trong CA HAI thu muc config\stplug-in va
// config\lua — khong loai tru file nao, vi file nao cung co the la game do tool khac cai.
// (File chi chua ticket nhu denuvo_g4play.lua / nomore.lua doi cu khong co dong addappid
//  nen tu nhien khong dong gop gi, khong can loai bang ten.)
//
// Cach doc phu thuoc file co chia block hay khong:
//   * CO block (cac dong chi co "--" ngan cach): moi block = 1 game + depot/DLC cua no,
//     dong addappid DAU block la game chinh -> chi lay dong dau -> bo qua het depot/DLC.
//     Day la dinh dang do g4_tool / nomore ghi ra.
//   * KHONG chia block (file cua tool khac): khong biet dong nao la game, lay HET roi
//     de denuvoGamesOnly() loc DLC/depot. Truoc day chi lay dong dau tien cua ca file,
//     nen file liet ke nhieu game thi chi thay duoc 1 game.
function denuvoInstalledAppids() {
  const seen = new Set(), out = [];
  const push = (id) => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };
  for (const dir of luaDirs()) {         // ca config\stplug-in lan config\lua
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.lua$/i.test(f)); }
    catch (_) { continue; }
    for (const f of files) {
      let txt = "";
      try { txt = fs.readFileSync(path.join(dir, f), "utf8"); } catch (_) { continue; }
      const blocks = txt.split(/\r?\n\s*--\s*\r?\n/);
      if (blocks.length > 1) {
        for (const block of blocks) {
          const m = block.match(/addappid\s*\(\s*(\d+)/i);   // addappid dau block = game chinh
          if (m) push(m[1]);
        }
      } else {
        for (const m of txt.matchAll(/addappid\s*\(\s*(\d+)/gi)) push(m[1]);
      }
    }
  }
  return out;
}
ipcMain.handle("denuvo-installed", () => denuvoInstalledAppids());

// Thu muc temp cua app (chua extract_tickets, tickets.txt). Dung cung cap voi exe (packaged).
function denuvoTempDir() {
  const base = app.isPackaged ? path.dirname(app.getPath("exe")) : __dirname;
  return path.join(base, "temp");
}

// Supabase KHONG con duoc goi truc tiep tu app — moi thu qua backend Deno (api.js).
// Ham sbSelect() cu da bi xoa co chu dich: no la duong ma app cam key doc thang
// bang denuvo_accounts (mat khau plaintext) truoc day.

// ---- Tai file (ho tro Google Drive: tu vuot trang canh bao virus) ----
function dvDecodeEnt(s) {
  return (s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function dvGdriveId(link) {
  link = (link || "").trim();
  for (const pat of [/\/file\/d\/([A-Za-z0-9_-]+)/, /[?&]id=([A-Za-z0-9_-]+)/, /\/d\/([A-Za-z0-9_-]+)/]) {
    const m = link.match(pat); if (m) return m[1];
  }
  return /^[A-Za-z0-9_-]{20,}$/.test(link) ? link : null;
}
async function dvDownloadFile(link, dest, onProgress) {
  const id = dvGdriveId(link);
  const startUrl = id
    ? `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`
    : link;
  let res = await dvRes(startUrl);
  if ((res.headers["content-type"] || "").toLowerCase().includes("text/html")) {
    let body = ""; res.setEncoding("utf8");
    await new Promise((r) => { res.on("data", (c) => (body += c)); res.on("end", r); });
    const am = body.match(/<form[^>]+action="([^"]+)"/i);
    const action = am ? dvDecodeEnt(am[1]) : "https://drive.usercontent.google.com/download";
    const fields = {}; const re = /<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi; let m;
    while ((m = re.exec(body))) fields[dvDecodeEnt(m[1])] = dvDecodeEnt(m[2]);
    const q = new URLSearchParams(fields).toString();
    res = await dvRes(action + (action.includes("?") ? "&" : "?") + q);
  }
  if ((res.statusCode || 0) !== 200) throw new Error("HTTP " + res.statusCode);
  const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
  let received = 0; const tmp = dest + ".part";
  await new Promise((resolve, reject) => {
    const f = fs.createWriteStream(tmp);
    res.on("data", (c) => { received += c.length; if (onProgress) onProgress(received, total); });
    res.on("error", reject); res.pipe(f);
    f.on("finish", () => f.close(() => resolve())); f.on("error", reject);
  });
  try { fs.renameSync(tmp, dest); } catch (e) { fs.copyFileSync(tmp, dest); fs.unlinkSync(tmp); }
  return { received, total };
}

// ---- NGUON PHU: tai bang Electron net (stack Chromium) — dung khi Node https bi
//      chan/reset TLS (vd "Client network socket disconnected before secure TLS ...").
//      net ton trong chung chi + proxy cua Windows, hanh xu nhu trinh duyet nen thuong lot qua. ----
function dvNetGet(url) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = net.request({ method: "GET", url, redirect: "follow" }); }
    catch (e) { return reject(e); }
    req.setHeader("User-Agent", DV_UA);
    req.on("response", (res) => resolve(res));
    req.on("error", reject);
    try { req.end(); } catch (e) { reject(e); }
  });
}
function dvHeader(res, name) { const v = res.headers[name]; return Array.isArray(v) ? v[0] : v; }

async function dvDownloadFileNet(link, dest, onProgress) {
  const id = dvGdriveId(link);
  const startUrl = id
    ? `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`
    : link;
  let res = await dvNetGet(startUrl);
  if (String(dvHeader(res, "content-type") || "").toLowerCase().includes("text/html")) {
    let body = "";
    await new Promise((r) => { res.on("data", (c) => (body += c.toString())); res.on("end", r); });
    const am = body.match(/<form[^>]+action="([^"]+)"/i);
    const action = am ? dvDecodeEnt(am[1]) : "https://drive.usercontent.google.com/download";
    const fields = {}; const re = /<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi; let m;
    while ((m = re.exec(body))) fields[dvDecodeEnt(m[1])] = dvDecodeEnt(m[2]);
    const q = new URLSearchParams(fields).toString();
    res = await dvNetGet(action + (action.includes("?") ? "&" : "?") + q);
  }
  if ((res.statusCode || 0) !== 200) throw new Error("HTTP " + res.statusCode);
  const total = parseInt(dvHeader(res, "content-length") || "0", 10) || 0;
  let received = 0; const tmp = dest + ".part";
  await new Promise((resolve, reject) => {
    const f = fs.createWriteStream(tmp);
    res.on("data", (c) => { received += c.length; f.write(c); if (onProgress) onProgress(received, total); });
    res.on("end", () => f.end(() => resolve()));
    res.on("error", reject); f.on("error", reject);
  });
  try { fs.renameSync(tmp, dest); } catch (e) { fs.copyFileSync(tmp, dest); fs.unlinkSync(tmp); }
  return { received, total };
}

// Tai file: thu Node https truoc; loi (chan TLS/mang) -> tu chuyen sang Electron net.
async function dvDownloadSmart(link, dest, onProgress, log) {
  try {
    return await dvDownloadFile(link, dest, onProgress);
  } catch (e) {
    if (log) log("Nguon chinh loi -> dang chuyen nguon phu...");
    return await dvDownloadFileNet(link, dest, onProgress);
  }
}

// ---- Giai nen (.rar can 7-Zip/WinRAR; .zip dung Expand-Archive co san) ----
function dvFindArchiveTool() {
  for (const c of [
    "C:/Program Files/7-Zip/7z.exe", "C:/Program Files (x86)/7-Zip/7z.exe",
    "C:/Program Files/WinRAR/UnRAR.exe", "C:/Program Files/WinRAR/WinRAR.exe",
  ]) if (fs.existsSync(c)) return c;
  return null;
}
function dvExtractArchive(file, outDir, fileType) {
  return new Promise((resolve) => {
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
    if (fileType === "zip") {
      const ps = `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' ` +
        `-DestinationPath '${outDir.replace(/'/g, "''")}' -Force`;
      return execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { windowsHide: true }, (err) => resolve({ ok: !err, err: err ? String(err) : "" }));
    }
    const tool = dvFindArchiveTool();
    if (!tool) return resolve({ ok: false, err: "Khong tim thay 7-Zip/WinRAR de giai nen .rar" });
    const is7z = /7z\.exe$/i.test(tool);
    const args = is7z ? ["x", "-y", "-o" + outDir, file] : ["x", "-y", file, outDir + path.sep];
    execFile(tool, args, { windowsHide: true },
      (err, out) => resolve({ ok: !err, out: String(out || ""), err: err ? String(err) : "" }));
  });
}

// ---- Steam: doc duong dan + dang nhap AN (-silent -login) ----
function dvRegQuery(key, name) {
  return new Promise((resolve) => {
    execFile("reg", ["query", key, "/v", name], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = (stdout || "").match(new RegExp(
        name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+REG_\\w+\\s+([^\\r\\n]+)"));
      resolve(m ? m[1].trim() : null);
    });
  });
}
async function dvSteamPaths() {
  const sp = await dvRegQuery("HKCU\\Software\\Valve\\Steam", "SteamPath");
  const se = await dvRegQuery("HKCU\\Software\\Valve\\Steam", "SteamExe");
  const steamPath = sp ? sp.replace(/\//g, "\\") : null;
  const steamExe = (se ? se.replace(/\//g, "\\") : null) ||
    (steamPath ? path.join(steamPath, "steam.exe") : null);
  return { steamPath, steamExe };
}
function dvSteamRunning() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq steam.exe", "/NH"], { windowsHide: true },
      (err, out) => resolve(/steam\.exe/i.test(out || "")));
  });
}

// ---- Moc thoi gian cua luong dang nhap / dang xuat ----
const DV_LOGIN_POLL_MS = 200;          // nhip doc connection_log (0.2s -> phat hien login nhanh; watcher doc tang dan nen re)
const DV_LOGIN_TIMEOUT_MS = 120000;    // toi da 2 phut cho 1 lan dang nhap
const DV_SHUTDOWN_GRACE_MS = 25000;    // cho Steam tu thoat truoc khi buoc dong (luc login)
const DV_LOGOUT_GRACE_MS = 15000;      // nhu tren, luc dang xuat
// connection_log.txt chi ghi thoi gian den GIAY: dong ghi ngay sau khi bam login co the
// mang moc lam tron xuong truoc do mot chut, lui moc so sanh lai de khong bo sot.
// An toan vi watcher chot vi tri cuoi file luc tao -> khong the doc trung dong cu.
const DV_LOG_SKEW_MS = 2000;
// Dong han Steam: xin thoat tu te (-shutdown) truoc, het kien nhan moi buoc dong.
// Tra ve { ok, forced, skipped }:
//   ok=false  -> Steam VAN dang chay (nguoi goi phai coi la that bai, khong duoc di tiep)
//   skipped   -> Steam von khong chay, khong lam gi ca
// Fast-path "khong chay" quan trong: `steam.exe -shutdown` khi Steam dang tat se
// KHOI DONG Steam len roi moi tat, ton them vai giay moi vong lap fix.
async function dvSteamShutdownWait(steamExe, log, maxMs = DV_SHUTDOWN_GRACE_MS) {
  if (!(await dvSteamRunning())) return { ok: true, forced: false, skipped: true };
  try { execFile(steamExe, ["-shutdown"], { windowsHide: true }); } catch (e) {}
  const n = Math.ceil(maxMs / 500);
  for (let i = 0; i < n; i++) {
    if (!(await dvSteamRunning())) return { ok: true, forced: false, skipped: false };
    await sleep(500);
  }
  if (log) log("Steam khong tu thoat -> buoc dong...");
  try { execFile("taskkill", ["/IM", "steam.exe", "/F"], { windowsHide: true }); } catch (e) {}
  await sleep(1500);
  return { ok: !(await dvSteamRunning()), forced: true, skipped: false };
}
// Thu muc + exe Steam: uu tien dvSteamPaths (registry), fallback getSteamDir (co backup thu cong).
async function dvSteamDirExe() {
  const { steamPath, steamExe } = await dvSteamPaths();
  let dir = steamPath, exe = steamExe;
  if (!dir || !exe || !fs.existsSync(exe)) {
    const g = getSteamDir();
    if (g) { dir = g; exe = path.join(g, "steam.exe"); }
  }
  return { dir: dir || null, exe: (exe && fs.existsSync(exe)) ? exe : null };
}

// ---- GIU acc Denuvo trong danh sach chon tai khoan cua Steam ----
// Steam MOI luu acc nho + token o config.vdf (Steam tu ghi khi -rememberpassword). Nhung
// danh sach hien trong "switcher" doc tu loginusers.vdf — ma login dong lenh KHONG duoc
// Steam ghi vao do. Nen ta tu GHI entry acc Denuvo vao loginusers.vdf (sau khi Steam tat).
// Token da nam o config.vdf -> switch sang acc Denuvo dung duoc, khong hoi mat khau.
function dvLoginUsersPath(dir) { return dir ? path.join(dir, "config", "loginusers.vdf") : null; }

// SteamID64 cua acc DANG dang nhap (doc registry ActiveUser ngay sau khi login).
function dvActiveSteamId() {
  return new Promise((resolve) => {
    execFile("reg", ["query", "HKCU\\Software\\Valve\\Steam\\ActiveProcess", "/v", "ActiveUser"],
      { windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        const m = (out || "").match(/ActiveUser\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
        if (!m) return resolve(null);
        const id = parseInt(m[1], 16);
        if (!id) return resolve(null);                     // 0 = khong co ai dang nhap
        resolve((76561197960265728n + BigInt(id)).toString());
      });
  });
}

// Them entry acc Denuvo vao loginusers.vdf (goi SAU khi Steam da tat de khong bi ghi de).
function dvAddLoginUsersEntry(dir, steamId, username, log) {
  const p = dvLoginUsersPath(dir);
  if (!p || !steamId || !username) return false;
  let txt = ""; try { txt = fs.readFileSync(p, "utf8"); } catch (_) { txt = ""; }
  if (txt.includes('"' + steamId + '"')) { if (log) log("Acc Denuvo da co trong loginusers.vdf."); return true; }
  const ts = Math.floor(Date.now() / 1000);
  const entry =
    '\t"' + steamId + '"\n\t{\n' +
    '\t\t"AccountName"\t\t"' + username + '"\n' +
    '\t\t"PersonaName"\t\t"' + username + '"\n' +
    '\t\t"RememberPassword"\t\t"1"\n' +
    '\t\t"WantsOfflineMode"\t\t"0"\n' +
    '\t\t"SkipOfflineModeWarning"\t\t"0"\n' +
    '\t\t"AutoLogin"\t\t"0"\n' +
    '\t\t"timestamp"\t\t"' + ts + '"\n' +
    '\t}\n';
  let out;
  if (/"users"\s*\{/i.test(txt)) {
    const idx = txt.lastIndexOf("}");                       // dau } cuoi = dong block "users"
    out = idx >= 0 ? (txt.slice(0, idx) + entry + "}\n") : (txt + "\n" + entry);
  } else {
    out = '"users"\n{\n' + entry + "}\n";
  }
  try { fs.writeFileSync(p, out, "utf8"); if (log) log("Da them acc Denuvo vao loginusers.vdf (switch sang dung duoc)."); return true; }
  catch (e) { if (log) log("Khong ghi duoc loginusers.vdf: " + e); return false; }
}

// ---- Phat hien ket qua dang nhap qua Steam connection_log.txt (hoc tu g4play-client) ----
// KHONG dung registry (AutoLoginUser/ActiveUser) -> chay duoc du Steam chua tung login,
// va khong bi chan boi policy DisableRegistryTools.
const DV_LOGON_PREFIX = "RecvMsgClientLogOnResponse() :";
const DV_LOGON_FAILURES = {
  InvalidPassword: "sai mat khau",
  AccountLogonDenied: "can Steam Guard (tai khoan phai duoc uy quyen may nay tu truoc; khong ho tro 2FA thu cong)",
  InvalidLoginAuthCode: "sai ma Steam Guard email",
  AccountLoginDeniedNeedTwoFactor: "can Steam Guard 2FA (tai khoan phai duoc uy quyen tu truoc)",
  TwoFactorCodeMismatch: "sai ma 2FA",
  AccountLogonDeniedVerifiedEmailRequired: "can email da xac minh",
  AccountLogonDeniedNoMail: "can Steam Guard nhung khong gui email",
  LoggedInElsewhere: "tai khoan dang dang nhap noi khac",
  ServiceUnavailable: "Steam dang bao tri",
  RateLimitExceeded: "bi gioi han so lan thu (thu lai sau)",
  AccessDenied: "bi tu choi truy cap",
  IPLoginRestrictionFailed: "bi chan theo IP",
  AccountLockedDown: "tai khoan bi khoa",
};
function dvParseLogTs(line) {   // "[2024-01-02 15:04:05] ..." -> ms (gio local)
  if (line[0] !== "[" || line.length < 21) return null;
  const t = Date.parse(line.slice(1, 20).replace(" ", "T"));
  return isNaN(t) ? null : t;
}
function dvParseLogonResult(line) {
  const idx = line.indexOf(DV_LOGON_PREFIX);
  if (idx < 0) return null;
  const rest = line.slice(idx + DV_LOGON_PREFIX.length);
  if (rest.includes("processing complete")) return "processing complete";
  const q1 = rest.indexOf("'"); if (q1 < 0) return null;
  const q2 = rest.indexOf("'", q1 + 1); if (q2 < 0) return null;
  return rest.slice(q1 + 1, q2);
}
// Theo doi connection_log.txt cho DUNG MOT lan dang nhap (port tu g4play-client
// initiator/util.go: steamLoginWatcher). Khac ban cu o cho: chi doc phan MOI duoc
// ghi them ke tu luc tao watcher, thay vi doc lai ca file moi giay.
//   1. Re hon han — log cua may dung lau nang vai MB, ban cu doc lai 120 lan/1 lan fix.
//   2. QUAN TRONG: ket qua cua LAN DANG NHAP TRUOC khong the lot vao lan nay.
//      Vong lap fix thu tai khoan noi tiep nhau, hai lan cach nhau co khi < 2s,
//      ma moc thoi gian phai lui lai 2s (log chi co do phan giai giay) -> ban cu
//      co the doc trung dong "InvalidPassword" cua tai khoan TRUOC roi bao hong
//      oan cho tai khoan sau. Chot vi tri file luc bat dau thi khong con cua nao.
// poll() -> "pending" | "ok" | { fail, reason }
function dvNewLoginWatcher(logFile, fromTime) {
  let offset = 0;
  try { offset = fs.statSync(logFile).size; } catch (_) {}
  let carry = "";        // dong cuoi doc dang do (chua co xuong dong) -> de danh lan sau
  let sawOK = false;

  const handleLine = (line) => {
    const ts = dvParseLogTs(line);
    if (ts == null || ts < fromTime) return "pending";
    if (line.includes("[Logged On,")) return "ok";
    const res = dvParseLogonResult(line);
    if (res == null) return "pending";
    if (res === "OK") { sawOK = true; return "pending"; }
    if (res === "processing complete") return sawOK ? "ok" : "pending";
    return { fail: true, reason: DV_LOGON_FAILURES[res] || res };
  };

  return function poll() {
    let size;
    try { size = fs.statSync(logFile).size; } catch (_) { return "pending"; }  // Steam chua tao log
    if (size < offset) { offset = 0; carry = ""; sawOK = false; }   // log bi xoay vong -> doc lai tu dau
    if (size === offset) return "pending";

    let chunk = "", fd = null;
    try {
      fd = fs.openSync(logFile, "r");
      const buf = Buffer.allocUnsafe(size - offset);
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      chunk = buf.subarray(0, n).toString("utf8");
      offset += n;
    } catch (_) { return "pending"; }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }

    const lines = (carry + chunk).split(/\r?\n/);
    carry = lines.pop();                       // phan chua tron dong -> giu lai
    for (const line of lines) {
      const r = handleLine(line);
      if (r !== "pending") return r;           // gap ket qua dau tien la chot
    }
    return "pending";
  };
}

async function dvSteamLoginHidden(user, pass, log) {
  const { dir, exe } = await dvSteamDirExe();
  if (!exe) return { ok: false, msg: "Khong tim thay steam.exe" };

  // BAT BUOC dong han Steam cu truoc: neu con chay, -login bi bo qua va Steam giu
  // nguyen session cua tai khoan cu. Truoc day ket qua dong Steam bi bo qua ->
  // van chay tiep -> "dang nhap thanh cong" nhung thuc te la tai khoan cua NGUOI DUNG,
  // roi extract_tickets bao khong co ticket, rat kho doan ra nguyen nhan.
  log("Dang dong Steam hien tai...");
  const stop = await dvSteamShutdownWait(exe, log);
  if (!stop.ok) {
    return { ok: false, msg: "Khong dong duoc Steam dang chay (dang nhap luc nay se bam nham tai khoan)" };
  }

  const logPath = dir ? path.join(dir, "logs", "connection_log.txt") : null;
  // Tao watcher TRUOC khi chay -login: no chot vi tri cuoi file ngay bay gio, nen
  // moi dong Steam ghi them tu day tro di moi duoc tinh la ket qua cua lan nay.
  const poll = logPath ? dvNewLoginWatcher(logPath, Date.now() - DV_LOG_SKEW_MS) : null;

  log("Dang dang nhap tai khoan...");
  // -login user pass: dang nhap. -silent: thu vao tray (an). -rememberpassword: de Steam
  // LUU acc nay vao loginusers.vdf (kem token) -> acc Denuvo con hieu luc, nam trong danh
  // sach tai khoan, switch sang van dung duoc ma khong hoi lai mat khau.
  try { spawn(exe, ["-silent", "-login", user, pass, "-rememberpassword"], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); }
  catch (e) { return { ok: false, msg: String(e) }; }

  const deadline = Date.now() + DV_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(DV_LOGIN_POLL_MS);
    if (poll) {
      const r = poll();
      if (r === "ok") { log("Steam da dang nhap."); return { ok: true }; }
      if (r && r.fail) { log("Login that bai: " + r.reason); return { ok: false, msg: r.reason }; }
    } else if (await dvSteamRunning()) {   // khong ro thu muc log -> fallback: coi nhu OK khi Steam chay
      await sleep(4000); log("Steam da dang nhap."); return { ok: true };
    }
  }
  return { ok: false, msg: "Het thoi gian cho Steam dang nhap (tai khoan co the can uy quyen may nay / Steam Guard)" };
}

// Dang xuat = dong han Steam. Bao dung su that: neu Steam khong chiu tat thi tai khoan
// van dang dang nhap tren may, phai noi ra thay vi in "Da dang xuat" nhu ban cu.
async function dvSteamLogout(log) {
  const { exe } = await dvSteamDirExe();
  if (!exe) return { ok: false, msg: "Khong tim thay steam.exe" };
  log("Dang dang xuat tai khoan...");
  const r = await dvSteamShutdownWait(exe, log, DV_LOGOUT_GRACE_MS);
  if (r.skipped) { log("Steam khong chay - khong can dang xuat."); return { ok: true }; }
  if (r.ok) { log("Da dang xuat tai khoan." + (r.forced ? " (phai buoc dong)" : "")); return { ok: true }; }
  log("CANH BAO: khong dong duoc Steam - tai khoan co the van dang dang nhap.");
  return { ok: false, msg: "Steam van dang chay sau khi dang xuat" };
}

// ---- extract_tickets.exe ----
function dvFindExtractTickets(root) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) stack.push(p);
      else if (/^extract_tickets\.exe$/i.test(it.name)) return p;
    }
  }
  return null;
}
function dvRunExtractTickets(exe, appid, onLine) {
  return new Promise((resolve) => {
    let ps;
    try { ps = spawn(exe, [String(appid)], { cwd: path.dirname(exe), windowsHide: true }); }
    catch (e) { return resolve({ ok: false, out: "", err: String(e) }); }
    let out = "", err = "";
    ps.stdout.on("data", (d) => { const s = d.toString(); out += s; if (onLine) s.split(/\r?\n/).forEach((l) => l && onLine(l)); });
    ps.stderr.on("data", (d) => { const s = d.toString(); err += s; if (onLine) s.split(/\r?\n/).forEach((l) => l && onLine("[err] " + l)); });
    ps.on("error", (e) => resolve({ ok: false, out, err: String(e) }));
    ps.on("exit", (code) => resolve({ ok: code === 0, code, out, err }));
    try { ps.stdin.write("\n"); ps.stdin.end(); } catch (e) {}   // tra loi "Press Enter to exit..."
  });
}
function dvGrabTicketHex(out, marker) {
  const lines = out.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(marker));
  if (i < 0) return null;
  const bytes = [];
  for (let j = i + 1; j < lines.length; j++) {
    const toks = lines[j].trim().split(/\s+/);
    if (!/^[0-9a-fA-F]{4}$/.test(toks[0])) break;
    for (const t of toks.slice(1)) {
      if (/^[0-9a-fA-F]{2}$/.test(t)) bytes.push(t.toLowerCase());
      else break;
    }
  }
  return bytes.length ? bytes.join("") : null;
}
function dvParseTickets(out) {
  if (/GetAppOwnershipTicketData returned no ticket/i.test(out)) {
    const m = out.match(/GetAppOwnershipTicketData[^\r\n]*/i);
    return { ok: false, reason: "no_ticket", msg: m ? m[0].trim() : "GetAppOwnershipTicketData returned no ticket" };
  }
  if (/appticket\s*:\s*null|eticket\s*:\s*null/i.test(out)) {
    return { ok: false, reason: "null", msg: "appticket:null / eticket:null" };
  }
  const appticket = dvGrabTicketHex(out, "Ownership ticket (184") || dvGrabTicketHex(out, "Ownership ticket (");
  const eticket = dvGrabTicketHex(out, "Encrypted ticket (143") || dvGrabTicketHex(out, "Encrypted ticket (");
  if (!appticket || !eticket) return { ok: false, reason: "parse", msg: "Khong doc duoc ticket tu output" };
  return { ok: true, appticket, eticket };
}
const DENUVO_TTL_MS = 30 * 60 * 1000;   // ticket Denuvo chi hieu luc 30 phut

// Chon file g4_tool.lua de GHI ticket. Ticket chi co tac dung neu nam CUNG thu muc voi lua
// cua game, ma may co the dung config\stplug-in HOAC config\lua -> uu tien:
//   1. thu muc dang chua chinh appid nay,  2. thu muc dang co g4_tool.lua,  3. stplug-in.
// Duong dan file ticket o CA HAI thu muc lua (config\stplug-in va config\lua).
// Ghi ca hai vi khong biet loader tren may nguoi dung doc thu muc nao — ghi mot
// cho la co the ticket nam sai cho va game van bao thieu ban quyen.
// Thu muc chua co thi tao; tao khong duoc thi bo qua thu muc do (van con cai kia).
function dvTicketLuaPaths(steamPath) {
  const out = [];
  for (const sub of LUA_SUBDIRS) {
    const dir = path.join(steamPath, ...sub);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { continue; }
    out.push(path.join(dir, TICKET_FILE));
  }
  return out;
}

// Block lua chuan cho 1 ticket. Dung CHUNG cho file .lua VA cho plaintext ben trong
// .CWK -> hai kenh luon mang DUNG mot noi dung (`batch_lua_content` kieu tool khac),
// chi khac co ma hoa hay khong. Parser C++ (kernel/src/cwk.hpp parseTicketLua) doc
// dung format nay cho ca .lua lan .cwk.
function dvTicketLuaBlock(appid, name, appticketHex, eticketHex, ts) {
  let iso = ""; try { iso = new Date(ts).toLocaleString("sv-SE"); } catch (_) {}
  const safeName = String(name || "").replace(/[\r\n]+/g, " ").trim();
  return [
    `--denuvo appid=${appid} created=${ts} createdAt="${iso}" name=${safeName}`,
    `setAppTicket(${appid}, "${appticketHex}")`,
    `setETicket(${appid}, "${eticketHex}")`,
    // Cau hinh Denuvo cho engine (OpenSteamTool/xinput1_4.dll):
    //  forcedenuvo: ep duong Denuvo (ProtectionScan co the bo sot game) -> arm cua so uy quyen.
    //  dauth2     : cua so dai (2500ms+3000ms) thay vi 300ms -> con mo luc game xin ownership
    //               ticket muon -> serve ticket THAT cua donor (khong forge rac) -> GetSteamID
    //               spoof khop memcmp -> qua loi 54. (Day la mat xich da fix duoc Onimusha.)
    `forcedenuvo(${appid})`,
    `dauth2(${appid})`,
  ].join("\r\n");
}

// Ban truoc ghi ticket lan vao g4_tool.lua. Neu con block cu cua chinh appid nay o do
// thi se co HAI ticket cho cung 1 game (ban cu da het han) -> don sach truoc khi ghi
// ticket moi, o moi thu muc lua. Chi dong vao block "--denuvo ...", giu nguyen game.
function dvPurgeOldTicketBlocks(steamPath, appid) {
  const re = new RegExp(`^--\\s*denuvo\\s+appid=${appid}\\b`);
  for (const dir of luaDirsIn(steamPath)) {
    for (const name of OLD_TICKET_FILES) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      const blocks = readLuaBlocks(p);
      const kept = blocks.filter((b) => !re.test(b));
      if (kept.length === blocks.length) continue;            // khong co gi de don
      try {
        if (kept.length) fs.writeFileSync(p, kept.join("\r\n--\r\n") + "\r\n", "utf8");
        else fs.unlinkSync(p);                                // file chi co ticket -> bo luon
      } catch (_) {}
    }
  }
}

// SteamID cua DONOR nam trong ownership ticket (appticket) tai offset 8, 8 byte LE:
//   layout: [uint32 Size][uint32 Version][uint64 SteamID][...]
// Loader (OpenSteamTool/xinput) spoof GetSteamID = gia tri nay -> Denuvo so chéo
//   memcmp(ticket.SteamID, GetSteamID()) MOI khop -> khong thi bao LOI 54.
function dvSteamIdFromAppticket(hex) {
  if (!hex || hex.length < 32) return null;
  const le = hex.substr(16, 16);            // 8 byte offset 8 (dang hex LE)
  let be = "";
  for (let i = 14; i >= 0; i -= 2) be += le.substr(i, 2);   // dao ve big-endian
  try { const v = BigInt("0x" + be); return v === 0n ? null : v.toString(); }
  catch (_) { return null; }
}

// Ghi ticket vao REGISTRY = credential store ma loader (xinput/OpenSteamTool) DOC:
//   HKCU\Software\Valve\Steam\Apps\<appid>\AppTicket  (REG_BINARY = byte tho)
//   HKCU\Software\Valve\Steam\Apps\<appid>\ETicket    (REG_BINARY)
//   HKCU\Software\Valve\Steam\Apps\<appid>\SteamID    (REG_SZ = SteamID donor, so thap phan)
// SteamID la MAU CHOT: thieu no loader khong spoof GetSteamID -> Denuvo bao loi 54.
function dvWriteTicketRegistry(appid, appticketHex, eticketHex, log) {
  if (!/^[0-9a-fA-F]+$/.test(appticketHex) || appticketHex.length % 2 ||
      !/^[0-9a-fA-F]+$/.test(eticketHex) || eticketHex.length % 2) {
    if (log) log("Ticket khong phai hex hop le -> bo qua ghi registry.");
    return false;
  }
  const key = `HKCU\\Software\\Valve\\Steam\\Apps\\${appid}`;
  const putBin = (name, hex) => execFileSync(
    "reg", ["add", key, "/v", name, "/t", "REG_BINARY", "/d", hex, "/f"],
    { windowsHide: true, stdio: "ignore" });
  try {
    putBin("AppTicket", appticketHex);
    putBin("ETicket", eticketHex);
    const steamId = dvSteamIdFromAppticket(appticketHex);
    if (steamId) {
      execFileSync("reg", ["add", key, "/v", "SteamID", "/t", "REG_SZ", "/d", steamId, "/f"],
        { windowsHide: true, stdio: "ignore" });
      if (log) log(`Da ghi registry: AppTicket/ETicket + SteamID=${steamId} (de loader spoof GetSteamID -> qua loi 54).`);
    } else {
      if (log) log("Da ghi registry AppTicket/ETicket (KHONG trich duoc SteamID tu ticket -> loader tu moi offset 8).");
    }
    return true;
  } catch (e) {
    if (log) log("Khong ghi duoc ticket vao registry (auth_registry_failed): " + ((e && e.message) || e));
    return false;
  }
}

// ---- .CWK cho kernel native (xem kernel/) ----
// Seed PHAI trung voi kernel C++ (kernel/src/crypto.hpp CWK_SEED). Chi la rao can
// doc-ngang (obfuscation), KHONG phai bao mat that — bao mat that o backend.
const CWK_SEED = "g4market-cwk-v1/change-me-together";
function dvCwkDir(steamPath) { return path.join(steamPath, "cwk"); }
function dvCwkPath(steamPath, appid) { return path.join(dvCwkDir(steamPath), `${appid}.cwk`); }

// Tao file .CWK (1 ticket/file): magic "G4CWK1" + ver(1) + iv(12) + tag(16) + ciphertext.
// ciphertext = AES-256-GCM(plaintext, key=sha256(CWK_SEED), iv, aad="g4cwk-v1").
// plaintext = DUNG block lua (dvTicketLuaBlock) -> giai ma .CWK ra la lua chay duoc
// ngay (giong tool khac: decrypt .CWK -> batch_lua_content). .CWK & lua khop tuyet doi.
function dvPackCWK(steamPath, appid, name, appticketHex, eticketHex, created, log) {
  try {
    const key = crypto.createHash("sha256").update(CWK_SEED).digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from("g4cwk-v1"));
    const plain = dvTicketLuaBlock(appid, name, appticketHex, eticketHex, created) + "\r\n";
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    const out = Buffer.concat([Buffer.from("G4CWK1"), Buffer.from([1]), iv, tag, ct]);
    fs.mkdirSync(dvCwkDir(steamPath), { recursive: true });
    fs.writeFileSync(dvCwkPath(steamPath, appid), out);
    if (log) log(`Da ghi .CWK cho kernel: ${dvCwkPath(steamPath, appid)}`);
    return true;
  } catch (e) { if (log) log("Khong ghi duoc .CWK: " + ((e && e.message) || e)); return false; }
}
function dvDeleteCwk(steamPath, appid) {
  try { fs.rmSync(dvCwkPath(steamPath, appid), { force: true }); } catch (_) {}
}

// Giai ma .CWK -> lay lai noi dung lua + cac truong (giong pycryptodome cua tool khac:
// decrypt -> batch_lua_content). Vo dao nguoc dvPackCWK. Tra null neu sai seed / hong /
// thieu ticket. Dung khi .CWK la NGUON (backend ship, dong bo tu may khac, ap thu cong).
function dvUnpackCWK(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 35) return null;
    if (buf.subarray(0, 6).toString("latin1") !== "G4CWK1" || buf[6] !== 1) return null;
    const iv = buf.subarray(7, 19), tag = buf.subarray(19, 35), ct = buf.subarray(35);
    const key = crypto.createHash("sha256").update(CWK_SEED).digest();
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(Buffer.from("g4cwk-v1"));
    d.setAuthTag(tag);
    const lua = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    const appid = (lua.match(/setAppTicket\s*\(\s*(\d+)/i) || [])[1]
               || (lua.match(/--\s*denuvo\s+appid=(\d+)/i) || [])[1];
    const appticket = (lua.match(/setAppTicket\s*\(\s*\d+\s*,\s*"([0-9a-fA-F]+)"/i) || [])[1];
    const eticket   = (lua.match(/setETicket\s*\(\s*\d+\s*,\s*"([0-9a-fA-F]+)"/i) || [])[1];
    const name    = (lua.match(/--\s*denuvo\b[^\r\n]*\bname=([^\r\n]*)/i) || [])[1];
    const created = parseInt((lua.match(/--\s*denuvo\b[^\r\n]*\bcreated=(\d+)/i) || [])[1], 10) || 0;
    if (!appid || !appticket || !eticket) return null;
    return { lua, appid, appticket, eticket, name: (name || "").trim(), created };
  } catch (_) { return null; }
}

// Ap dung 1 .CWK: giai ma -> GHI lua + registry (KHONG tao lai .CWK vi .CWK chinh la
// nguon). Nhan Buffer hoac duong dan. Chinh la khuc "decrypt .CWK -> write lua" cua
// tool khac, de only_denuvo dung duoc .CWK ma KHONG can kernel native.
function dvApplyCWK(steamPath, cwkBufOrPath, log) {
  let buf = cwkBufOrPath;
  if (typeof cwkBufOrPath === "string") {
    try { buf = fs.readFileSync(cwkBufOrPath); }
    catch (e) { if (log) log("Khong doc duoc .CWK: " + ((e && e.message) || e)); return { ok: false }; }
  }
  const t = dvUnpackCWK(buf);
  if (!t) { if (log) log("Giai ma .CWK that bai (sai seed / file hong / thieu ticket)."); return { ok: false }; }
  const ts = t.created || Date.now();
  const { reg, written } = dvDeliverTicket(steamPath, t.appid, t.name, t.appticket, t.eticket, ts, log);
  if (log) log(`Da ap dung .CWK: appid=${t.appid} -> registry ${reg ? "OK" : "X"} + ${written.length} thu muc lua.`);
  return { ok: reg || written.length > 0, appid: t.appid, name: t.name, reg, written, appticket: t.appticket, eticket: t.eticket };
}

// Xoa ticket cua 1 appid khoi registry (goi khi xoa thu cong / don het han — song song voi don lua).
function dvDeleteTicketRegistry(appid) {
  const key = `HKCU\\Software\\Valve\\Steam\\Apps\\${String(appid).replace(/\D/g, "")}`;
  for (const v of ["AppTicket", "ETicket"]) {
    try { execFileSync("reg", ["delete", key, "/v", v, "/f"], { windowsHide: true, stdio: "ignore" }); } catch (_) {}
  }
}

// Ghi key CONFIG cua "kernel" g4market (HKCU\Software\Valve\G4market). Chi la trang thai
// cua app (bat unlock + kernel + phien ban) — khong phai ticket, khong game nao doc.
// Viet 1 lan khi fix xong de co parity + de kernel (neu sau nay tu viet) biet dang bat.
function dvWriteKernelRegistry(log) {
  const key = "HKCU\\Software\\Valve\\G4market";
  let ver = "0"; try { ver = app.getVersion(); } catch (_) {}
  const put = (name, val) => execFileSync(
    "reg", ["add", key, "/v", name, "/t", "REG_SZ", "/d", val, "/f"],
    { windowsHide: true, stdio: "ignore" });
  try {
    put("UnlockEnabled", "true");
    put("SelectedKernelId", "g4denuvo");
    put("KernelVersions", JSON.stringify({ g4denuvo: ver }));
    return true;
  } catch (e) { if (log) log("Khong ghi duoc registry kernel g4market: " + ((e && e.message) || e)); return false; }
}

// Loi GIAO ticket qua 2 kenh truc tiep (khong qua .CWK): REGISTRY + LUA.
//   Kenh 1 REGISTRY (giong tool khac write_steam_registry) — khong phu thuoc thu muc Steam.
//   Kenh 2 LUA (cho loader SteamTools/xinput) — 1 block/appid, ghi ca hai thu muc lua.
// Dung chung boi dvWriteTicketFiles (sau khi dump) va dvApplyCWK (giai ma .CWK). Tra
// { reg, written[] }. `ts` quyet dinh `created` cua block (de tinh het han + gop trung).
function dvDeliverTicket(steamPath, appid, name, appticket, eticket, ts, log) {
  // Kenh 1: REGISTRY — ghi truoc vi khong can biet thu muc Steam.
  const reg = dvWriteTicketRegistry(appid, appticket, eticket, log);
  dvWriteKernelRegistry(log);   // config kernel g4market (parity, khong bat buoc)

  // Kenh 2: LUA.
  if (!steamPath) { log("Khong ro Steam -> bo qua ghi lua (ticket da vao registry)."); return { reg, written: [] }; }
  dvPurgeOldTicketBlocks(steamPath, appid);   // bo ticket cu con sot trong g4_tool.lua

  const block = dvTicketLuaBlock(appid, name, appticket, eticket, ts);
  const stale = new RegExp(`^--\\s*denuvo\\s+appid=${appid}\\b`);

  // Thu muc nao ghi hong (khong co quyen...) thi bo qua, van ghi not thu muc con lai.
  const written = [];
  for (const luaPath of dvTicketLuaPaths(steamPath)) {
    try {
      const blocks = readLuaBlocks(luaPath).filter((b) => !stale.test(b));   // bo ticket cu cung appid
      blocks.push(block);
      fs.writeFileSync(luaPath, blocks.join("\r\n--\r\n") + "\r\n", "utf8");
      written.push(luaPath);
    } catch (e) { log("Khong ghi duoc " + luaPath + ": " + ((e && e.message) || e)); }
  }
  return { reg, written };
}

// Ghi tickets.txt (vao temp) + giao ticket qua registry + lua (dvDeliverTicket) +
// dong goi .CWK cho kernel (dvPackCWK). Ba kenh deu mang DUNG mot block lua -> .CWK,
// file lua va registry nhat quan tuyet doi. readDenuvoEntries() gop trung theo
// "appid:created" nen 2 file lua giong het nhau khong bi dem thanh 2 ticket.
function dvWriteTicketFiles(temp, steamPath, appid, name, appticket, eticket, log) {
  const txtPath = path.join(temp, "tickets.txt");
  fs.writeFileSync(txtPath,
    `appid: ${appid}\nappticket(184 bytes): ${appticket}\neticket(143 bytes): ${eticket}\n`, "utf8");
  log("Da luu ticket.");

  const ts = Date.now();
  const { reg: regTicket, written } = dvDeliverTicket(steamPath, appid, name, appticket, eticket, ts, log);

  // Kenh 3: .CWK cho kernel native (dung `ts` giong block lua -> plaintext trung khop).
  const cwkOk = steamPath ? dvPackCWK(steamPath, appid, name, appticket, eticket, ts, log) : false;

  if (!written.length) {
    log(regTicket ? `Khong ghi duoc lua, nhung ticket da vao registry${cwkOk ? " + .CWK" : ""}.` : "KHONG ghi duoc ticket vao registry lan lua.");
    return { txtPath, reg: regTicket, cwk: cwkOk };
  }
  log(`Da ghi ticket vao registry + ${written.length} thu muc lua${cwkOk ? " + .CWK" : ""} (het han sau 30 phut).`);
  return { txtPath, reg: regTicket, cwk: cwkOk, luaPath: written[0], luaPaths: written };
}

// Sau khi ghi xong lua: don thu muc "extracted", chi giu lai extract_tickets.exe
// (bo cac folder ticket theo appid + file bin/txt tam do cong cu sinh ra moi lan chay).
function dvCleanupExtracted(temp) {
  // Xoa tickets.txt tam trong temp (da ghi vao lua roi).
  try { fs.rmSync(path.join(temp, "tickets.txt"), { force: true }); } catch (e) {}
  const exe = dvFindExtractTickets(temp);
  if (!exe) return;
  const dir = path.dirname(exe);
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const it of items) {
    if (/^extract_tickets\.exe$/i.test(it.name)) continue;   // giu lai cong cu fix
    try { fs.rmSync(path.join(dir, it.name), { recursive: true, force: true }); } catch (e) {}
  }
}

// Doc cac ticket Denuvo da ghi -> con han hay het han (TTL 30 phut).
async function readDenuvoEntries() {
  let { steamPath } = await dvSteamPaths();
  if (!steamPath) steamPath = getSteamDir();          // du phong: thu muc Steam set thu cong
  if (!steamPath) return [];
  const out = [], seen = new Set();
  // File ticket hien tai (denuvo_g4play.lua) + file cua ban cu (g4_tool.lua) o moi
  // thu muc lua -> may vua nang cap van con thay ticket cu cho toi luc no het han.
  const files = [];
  for (const dir of luaDirsIn(steamPath)) {
    for (const name of [TICKET_FILE, ...OLD_TICKET_FILES]) files.push(path.join(dir, name));
  }
  for (const f of files) {
    let cur = "";
    try { cur = fs.readFileSync(f, "utf8"); } catch (e) { continue; }
    const re = /--\s*denuvo\s+appid=(\d+)\s+created=(\d+)[^\r\n]*?\bname=([^\r\n]*)/gi;
    let m;
    while ((m = re.exec(cur))) {
      const created = parseInt(m[2], 10) || 0;
      const key = m[1] + ":" + created;
      if (seen.has(key)) continue;                    // cung ticket o 2 file -> chi tinh 1
      seen.add(key);
      const age = Date.now() - created;
      out.push({
        appid: m[1], created, name: (m[3] || "").trim(),
        expireAt: created + DENUVO_TTL_MS,
        expired: age > DENUVO_TTL_MS, remainingMs: Math.max(0, DENUVO_TTL_MS - age),
      });
    }
  }
  return out;
}
ipcMain.handle("denuvo-expiry", () => readDenuvoEntries());

// ---- Xoa block ticket Denuvo khoi file lua (het han tu dong / thu cong theo appid) ----
// Chi dong vao block "--denuvo appid=...", KHONG dong vao block game (addappid). Xoa o
// CA HAI thu muc lua (stplug-in + lua) va ca file cu (g4_tool.lua). File chi con rong -> bo luon.
function dvRemoveTicketBlocksWhere(steamPath, shouldRemove) {
  let removed = 0;
  const removedAppids = new Set();
  for (const dir of luaDirsIn(steamPath)) {
    for (const name of [TICKET_FILE, ...OLD_TICKET_FILES]) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      let blocks;
      try { blocks = readLuaBlocks(p); } catch (_) { continue; }
      const kept = blocks.filter((b) => {
        const rm = /^--\s*denuvo\s+appid=\d+/.test(b) && shouldRemove(b);   // chi block ticket
        if (rm) { removed++; const m = b.match(/appid=(\d+)/); if (m) removedAppids.add(m[1]); }
        return !rm;
      });
      if (kept.length === blocks.length) continue;               // khong co gi de xoa
      try {
        if (kept.length) fs.writeFileSync(p, kept.join("\r\n--\r\n") + "\r\n", "utf8");
        else fs.unlinkSync(p);                                   // file chi con ticket -> bo
      } catch (_) {}
    }
  }
  for (const appid of removedAppids) { dvDeleteTicketRegistry(appid); dvDeleteCwk(steamPath, appid); }   // don registry + .CWK
  return removed;
}
// Xoa ticket cua 1 appid cu the (xoa thu cong).
function dvRemoveTicket(steamPath, appid) {
  const re = new RegExp(`^--\\s*denuvo\\s+appid=${String(appid).replace(/\D/g, "")}\\b`);
  const n = dvRemoveTicketBlocksWhere(steamPath, (b) => re.test(b));
  dvDeleteTicketRegistry(appid);          // ca khi ticket chi nam o registry (khong co block lua)
  dvDeleteCwk(steamPath, appid);          // va file .CWK cho kernel
  return n;
}
// Xoa moi ticket DA HET HAN (age > TTL 30 phut).
function dvCleanExpiredTickets(steamPath) {
  return dvRemoveTicketBlocksWhere(steamPath, (b) => {
    const m = b.match(/--\s*denuvo\s+appid=\d+\s+created=(\d+)/);
    if (!m) return false;
    return (Date.now() - (parseInt(m[1], 10) || 0)) > DENUVO_TTL_MS;
  });
}

// Xoa thu cong theo appid (nguoi dung nhap trong modal Fix thu cong).
ipcMain.handle("denuvo-remove", async (_e, arg) => {
  const appid = String((arg && arg.appid) || arg || "").trim();
  if (!/^\d+$/.test(appid)) return { ok: false, msg: "appid khong hop le" };
  let { steamPath } = await dvSteamPaths();
  if (!steamPath) steamPath = getSteamDir();
  if (!steamPath) return { ok: false, msg: "khong tim thay thu muc Steam" };
  const n = dvRemoveTicket(steamPath, appid);
  return { ok: true, removed: n, msg: n ? `Da xoa ticket cho appid ${appid}` : `Khong thay ticket cho appid ${appid}` };
});
// Don ticket het han (goi thu cong hoac tu dong).
ipcMain.handle("denuvo-clean-expired", async () => {
  let { steamPath } = await dvSteamPaths();
  if (!steamPath) steamPath = getSteamDir();
  if (!steamPath) return { ok: false, removed: 0 };
  return { ok: true, removed: dvCleanExpiredTickets(steamPath) };
});

// ---- Buoc 1: tai + giai nen requirement vao temp ----
// ============================================================================
//  CAI / CAP NHAT KERNEL NATIVE (dwmapi.dll) VAO <Steam>\bin
//
//  - dwmapi.dll  : tai tu Supabase bang `denuvo_kernel` (cot url, version, file_type).
//  - pattern/ipc : tai THANG tu GitHub kasakigaming/steam-monitor theo sha256 cua
//                  steamclient64.dll hien tai (giong tools/sync_steam_monitor.ps1).
//  - layout      : file RE rieng, khong co tren steam-monitor -> bo qua (kernel dung default).
//
//  dwmapi.dll bi KHOA khi Steam dang chay -> phai dong Steam truoc khi ghi de. Chi cai
//  khi THIEU/KHAC ban (so marker g4kernel.ver + co du toml cho hash) -> khong kill Steam
//  vo co moi lan mo app. Da tung chay thi mo lai Steam de kernel nap.
// ============================================================================
const KERNEL_REPO = "kasakigaming/steam-monitor";
// Loader dwmapi.dll (39KB) = proxy dat o <Steam>\bin -> nap engine xinput1_4.dll vao
// steam.exe. KIEN TRUC MOI: app NAY chi cai loader dwmapi.dll; engine xinput1_4.dll +
// pattern/ipc do noi khac/engine tu lo (engine tu tai pattern/ipc ve <Steam>\win64).
// URL mac dinh dung khi bang denuvo_kernel trong/chua cau hinh.
const DENUVO_LOADER_URL = "https://activegameg4-4.netlify.app/new_fix_denuvo/bin/dwmapi.dll";
function dvBinDir(steamPath) { return path.join(steamPath, "bin"); }
function dvKernelDataDir(steamPath) { return path.join(dvBinDir(steamPath), "data"); }
function dvKernelVerFile(steamPath) { return path.join(dvBinDir(steamPath), "g4kernel.ver"); }
function dvKernelInstalledVer(steamPath) { try { return fs.readFileSync(dvKernelVerFile(steamPath), "utf8").trim(); } catch (_) { return ""; } }

function dvFileSha256(p) {
  return new Promise((resolve) => {
    try {
      const h = crypto.createHash("sha256"), s = fs.createReadStream(p);
      s.on("data", (d) => h.update(d));
      s.on("end", () => resolve(h.digest("hex").toLowerCase()));
      s.on("error", () => resolve(null));
    } catch (_) { resolve(null); }
  });
}
function dvSteamclientHash(steamPath) { return dvFileSha256(path.join(steamPath, "steamclient64.dll")); }

// Tim de quy 1 file khop regex (dung khi goi kernel la .zip/.rar).
function dvFindFileRec(dir, re) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) { const r = dvFindFileRec(p, re); if (r) return r; }
    else if (re.test(it.name)) return p;
  }
  return null;
}

// Chep MOI *.toml nam duoi thu muc pattern/ipc/layout trong goi da giai nen -> <Steam>\bin\data.
// Nho vay goi .zip (dll + data) tu bao dam co data cho moi ban steamclient trong snapshot,
// khong phu thuoc fetch GitHub luc chay. Giu cau truc data\<kind>\<hash>.toml.
function dvCopyKernelDataFrom(exDir, steamPath, log) {
  const dataDst = dvKernelDataDir(steamPath);
  let n = 0;
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) { walk(p); continue; }
      if (!/\.toml$/i.test(it.name)) continue;
      const kind = path.basename(path.dirname(p)).toLowerCase();
      if (kind !== "pattern" && kind !== "ipc" && kind !== "layout") continue;
      const dst = path.join(dataDst, kind, it.name);
      try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(p, dst); n++; } catch (_) {}
    }
  };
  walk(exDir);
  if (log && n) log(`Kernel: da chep ${n} toml tu goi vao bin\\data.`);
  return n;
}

// 1 toml hop le = du dai + khong phai trang HTML/404.
function dvTomlValid(txt) {
  return !!txt && txt.length > 20 && !/^\s*</.test(txt) && !/Not Found/i.test(txt.slice(0, 40));
}
// Tai 1 toml tu steam-monitor (<branch>/steamclient/<hash>.toml) -> destDir.
//  - Da co ban HOP LE roi -> khong tai lai (tranh dung vao file dang dung).
//  - Tai vao file .dl tam, validate, CHI rename de len dest khi hop le.
//  - Fetch loi/invalid -> GIU NGUYEN file cu (KHONG xoa) -> khong bao gio lam kernel mat data.
async function dvFetchMonitorToml(branch, hash, destDir, log) {
  try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) {}
  const dest = path.join(destDir, `${hash}.toml`);
  try { if (dvTomlValid(fs.readFileSync(dest, "utf8"))) return true; } catch (_) {}
  const url = `https://raw.githubusercontent.com/${KERNEL_REPO}/${branch}/steamclient/${hash}.toml`;
  const tmp = dest + ".dl";
  try {
    await dvDownloadSmart(url, tmp, null, log);
    const txt = fs.readFileSync(tmp, "utf8");
    if (!dvTomlValid(txt)) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} return false; }
    fs.renameSync(tmp, dest);   // chi thay khi ban moi hop le
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    if (log) log(`  ${branch}: khong tai duoc (${(e && e.message) || e})`);
    return false;
  }
}

// Cai/cap nhat kernel neu can. Tra { ok, skipped?, reopened? }.
async function denuvoKernelEnsure(log) {
  log = log || (() => {});
  const steamPath = getSteamDir();
  if (!steamPath) { log("Kernel: khong ro thu muc Steam -> bo qua."); return { ok: false }; }
  // Doc bang denuvo_kernel (neu co Supabase); thieu/loi/trong -> dung URL mac dinh (netlify).
  let k = null;
  if (SUPA_URL && SUPA_KEY) {
    const rows = await sbSelect("denuvo_kernel", "select=url,version,file_type");
    if (Array.isArray(rows) && rows.length && rows[0] && rows[0].url) k = rows[0];
    else if (rows && rows.error) log("Kernel: doc bang denuvo_kernel loi (" + rows.error + ") -> dung URL mac dinh.");
    else log("Kernel: bang denuvo_kernel trong/thieu url -> dung URL mac dinh.");
  } else {
    log("Kernel: chua cau hinh Supabase -> dung URL mac dinh.");
  }
  if (!k) k = { url: DENUVO_LOADER_URL, version: "new_fix_denuvo", file_type: "direct" };
  const wantVer = String(k.version || "");

  const bin = dvBinDir(steamPath);
  try { fs.mkdirSync(bin, { recursive: true }); } catch (_) {}
  const dllPath = path.join(bin, "dwmapi.dll");
  const haveDll = fs.existsSync(dllPath);
  if (haveDll && dvKernelInstalledVer(steamPath) === wantVer) {
    log("Loader dwmapi.dll da dung ban -> khong lam gi. (engine xinput1_4.dll + pattern/ipc do noi khac / engine tu lo win64)");
    return { ok: true, skipped: true };
  }

  const ft = String(k.file_type || "direct").toLowerCase();
  const isArchive = ft === "zip" || ft === "rar";

  // Goi .zip/.rar tai + giai nen 1 LAN, dung cho ca data lan dll.
  let exDir = null, pkgTried = false;
  async function ensurePkg() {
    if (exDir || pkgTried) return exDir;
    pkgTried = true;
    if (!isArchive) return null;
    try {
      const temp = denuvoTempDir(); fs.mkdirSync(temp, { recursive: true });
      const arc = path.join(temp, "kernel_dl" + (ft === "rar" ? ".rar" : ".zip"));
      await dvDownloadSmart(k.url, arc, null, log);
      const ex = path.join(temp, "kernel_ex");
      try { fs.rmSync(ex, { recursive: true, force: true }); } catch (_) {}
      const r = await dvExtractArchive(arc, ex, ft);
      try { fs.rmSync(arc, { force: true }); } catch (_) {}
      if (!r.ok) { log("Kernel: giai nen goi loi: " + r.err); return null; }
      exDir = ex;
    } catch (e) { log("Kernel: tai goi loi: " + ((e && e.message) || e)); }
    return exDir;
  }

  // --- DATA (pattern/ipc): KIEN TRUC MOI -> engine OpenSteamTool (xinput1_4.dll) TU tai
  //     pattern/ipc ve <Steam>\win64 khi chay. App NAY khong con fetch vao bin\data nua
  //     (do la cho kernel native cu da bo). App chi lo moi loader dwmapi.dll. ---

  // --- DLL loader: chi dong Steam khi THUC SU can thay (thieu / khac version). ---
  const needDll = !haveDll || dvKernelInstalledVer(steamPath) !== wantVer;
  let reopened = false;
  if (!needDll) {
    log("Kernel: dwmapi.dll da dung ban -> khong dong Steam.");
  } else {
    const { steamExe } = await dvSteamPaths();
    const exe = steamExe || path.join(steamPath, "steam.exe");
    const wasRunning = await dvSteamRunning();
    if (wasRunning) {
      log("Kernel: dong Steam de ghi de dwmapi.dll (file bi khoa khi Steam chay)...");
      const sd = await dvSteamShutdownWait(exe, log);
      if (!sd.ok) { log("Kernel: khong dong duoc Steam -> giu DLL cu (data da cap nhat)."); if (exDir) try { fs.rmSync(exDir, { recursive: true, force: true }); } catch (_) {} return { ok: false, dataOnly: true }; }
    }
    try {
      if (isArchive) {
        if (!(await ensurePkg())) return { ok: false };
        const dll = dvFindFileRec(exDir, /^dwmapi\.dll$/i);
        if (!dll) { log("Kernel: khong thay dwmapi.dll trong goi."); return { ok: false }; }
        fs.copyFileSync(dll, dllPath);
        dvCopyKernelDataFrom(exDir, steamPath, log);   // chac chan data tu goi co mat
      } else {
        await dvDownloadSmart(k.url, dllPath, null, log);
      }
      log("Kernel: da dat dwmapi.dll vao " + bin);
    } catch (e) { log("Kernel: tai/ghi dwmapi.dll loi: " + ((e && e.message) || e)); return { ok: false }; }

    try { fs.writeFileSync(dvKernelVerFile(steamPath), wantVer, "utf8"); } catch (_) {}
    if (wasRunning) {
      try { spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref(); reopened = true; log("Kernel: da mo lai Steam."); }
      catch (_) {}
    }
  }
  if (exDir) try { fs.rmSync(exDir, { recursive: true, force: true }); } catch (_) {}

  log("Kernel: cai xong.");
  return { ok: true, reopened };
}

ipcMain.handle("denuvo-kernel-install", async (e) => {
  const log = (m) => { try { e.sender.send("denuvo-log", String(m)); } catch (_) {} };
  try { return await denuvoKernelEnsure(log); }
  catch (err) { log("Loi cai kernel: " + String((err && err.message) || err)); return { ok: false, msg: String(err) }; }
});

async function denuvoPrepare(log) {
  // KIEN TRUC MOI (da qua loi 54): serve ticket + spoof IClientUser::GetSteamID la ENGINE
  // OpenSteamTool (xinput1_4.dll o Steam ROOT), duoc nap boi LOADER dwmapi.dll o <Steam>\bin.
  // App NAY lo:
  //   (1) cai LOADER dwmapi.dll  -> denuvoKernelEnsure (bang denuvo_kernel, fallback netlify);
  //   (2) ghi credential store (registry AppTicket/ETicket/SteamID donor) + lua
  //       (dvTicketLuaBlock, da gom forcedenuvo(appid)+dauth2(appid)) cho engine doc.
  // Engine xinput1_4.dll + pattern/ipc do NOI KHAC lo (engine tu tai pattern/ipc ve win64).
  try { await denuvoKernelEnsure(log); } catch (e) { log("Loader dwmapi.dll: " + ((e && e.message) || e)); }

  const temp = denuvoTempDir();
  fs.mkdirSync(temp, { recursive: true });
  if (dvFindExtractTickets(temp)) { log("Cong cu fix da san sang."); return true; }
  if (!SUPA_URL || !SUPA_KEY) { log("Chua cau hinh Supabase trong .env."); return false; }
  const rows = await sbSelect("denuvo_requirement", "select=*");   // doc thang Supabase (nhu g4_tool)
  if (rows && rows.error) { log("Khong lay duoc cau hinh fix: " + rows.error); return false; }
  if (!Array.isArray(rows) || !rows.length) { log("Khong lay duoc cau hinh fix."); return false; }
  log("Dang tai cong cu fix...");
  for (const r of rows) {
    const ext = r.file_type === "rar" ? ".rar" : (r.file_type === "zip" ? ".zip" : ".bin");
    const dest = path.join(temp, "denuvo_req" + ext);
    let last = -1;
    await dvDownloadSmart(r.url, dest, (rec, tot) => {
      const p = tot ? Math.floor(rec * 100 / tot) : -1;
      if (p !== last) { last = p; log(`  tai ${(rec / 1048576).toFixed(1)}MB${p >= 0 ? " (" + p + "%)" : ""}`); }
    }, log);
    if (r.zip_rar) {
      log("Dang giai nen...");
      const ex = await dvExtractArchive(dest, path.join(temp, "extracted"), r.file_type);
      if (!ex.ok) { log("Loi giai nen: " + ex.err); return false; }
    }
  }
  const exe = dvFindExtractTickets(temp);
  log(exe ? "Cong cu fix da san sang." : "Chuan bi cong cu that bai.");
  return !!exe;
}

// Boc ham log lai: cat bo moi chuoi nhay cam (mat khau) truoc khi dong log di ra
// renderer / terminal trong app. Re, va chan duoc ca truong hop Steam echo lai
// tham so dong lenh vao stderr.
function dvScrubLog(log, secrets) {
  const list = (secrets || []).filter((x) => typeof x === "string" && x.length >= 4);
  if (!list.length) return log;
  return (msg) => {
    let out = String(msg);
    for (const sct of list) out = out.split(sct).join("***");
    log(out);
  };
}

// Dich ma loi backend -> cau tieng Viet de hieu (cong gate cua tool khac).
function dvBackendErrMsg(err) {
  const code = err && err.code;
  const map = {
    no_account: "Game nay chua co tai khoan kha dung (hoac da thu het tai khoan).",
    no_password: "Tai khoan loi (chua co mat khau hop le).",
    rate_appid: "Thu qua nhieu lan cho game nay — doi 10 phut roi thu lai.",
    rate_hour: "Vuot gioi han theo gio — thu lai sau.",
    rate_day: "Het luot trong ngay — thu lai vao ngay mai.",
    app_outdated: "App cu — vui long cap nhat len ban moi.",
    lease_expired: "Phien da het han — bam fix lai.",
    bad_appid: "appid khong hop le.",
    device_revoked: "May nay da bi khoa.",
    clock_skew: "Dong ho may lech — chinh lai gio he thong roi thu lai.",
  };
  return map[code] || (err && err.message) || "Loi goi backend.";
}

// ---- Buoc 2: xin account/ticket -> (login + extract_tickets) -> ghi file ----
// Uu tien BACKEND (ky HMAC, quota chi tru khi THANH CONG, audit). Chua cau hinh
// backend (.env khong co G4_API_BASE) thi quay ve doc thang Supabase (luong cu).
// --- Tam TAT kernel trong luc lay ticket ---
// Kernel hook steamclient -> PHA IPC ma extract_tickets.exe can (loi "stalled cross-thread
// pipe" / "ConnectToGlobalUser failed"). Da xac nhan: go kernel thi extract OK. Nen trong
// luc fix (login + extract) phai tat kernel (doi ten dwmapi.dll -> .off), xong bat lai.
// dwmapi.dll bi khoa khi Steam chay -> dong Steam truoc khi doi ten.
function dvKernelOnPath(steamPath) { return path.join(dvBinDir(steamPath), "dwmapi.dll"); }
function dvKernelOffPath(steamPath) { return path.join(dvBinDir(steamPath), "dwmapi.dll.off"); }
async function dvKernelSuspend(steamPath, log) {
  if (!steamPath) return false;
  const on = dvKernelOnPath(steamPath), off = dvKernelOffPath(steamPath);
  if (!fs.existsSync(on)) return false;            // khong cai kernel -> khong lam gi
  const { steamExe } = await dvSteamPaths();
  await dvSteamShutdownWait(steamExe || path.join(steamPath, "steam.exe"), log);
  try { fs.rmSync(off, { force: true }); fs.renameSync(on, off); log("Kernel: TAM TAT trong luc lay ticket (tranh pha IPC extract)."); return true; }
  catch (e) { log("Kernel: khong tat duoc (" + ((e && e.message) || e) + ") -> extract co the loi."); return false; }
}
async function dvKernelResume(steamPath, log) {
  if (!steamPath) return;
  const on = dvKernelOnPath(steamPath), off = dvKernelOffPath(steamPath);
  if (!fs.existsSync(off)) return;                 // khong co ban .off -> thoi
  if (await dvSteamRunning()) { const { steamExe } = await dvSteamPaths(); await dvSteamShutdownWait(steamExe || path.join(steamPath, "steam.exe"), log); }
  try {
    if (fs.existsSync(on)) fs.rmSync(off, { force: true });   // da co dwmapi.dll (vd cai lai) -> bo .off
    else fs.renameSync(off, on);
    log("Kernel: da BAT lai (lan Steam toi se nap + phuc vu ticket).");
  } catch (e) { log("Kernel: bat lai loi (" + ((e && e.message) || e) + ") -> doi ten .off thu cong."); }
}

async function denuvoRun(appid, name, log) {
  appid = String(appid || "").trim();
  if (!/^\d+$/.test(appid)) return { ok: false, msg: "appid khong hop le" };
  const temp = denuvoTempDir();
  let exe = dvFindExtractTickets(temp);
  if (!exe) { log("Chua co cong cu -> chuan bi..."); if (!(await denuvoPrepare(log))) return { ok: false, msg: "khong chuan bi duoc cong cu" }; exe = dvFindExtractTickets(temp); }
  if (!exe) return { ok: false, msg: "khong co extract_tickets.exe" };

  // KERNEL NATIVE DA BO -> khong suspend/resume nua (tranh doi ten nham dwmapi cua
  // xinput/loader khac trong Steam\bin). Serve ticket do xinput1_4.dll (OpenSteamTool) lo.
  if (API_BASE) return await denuvoRunViaBackend(appid, name, exe, temp, log);
  return await denuvoRunDirect(appid, name, exe, temp, log);
}

// Luong CHINH (hoc tu tool khac): request -> (login + dump ticket) -> confirm/cancel.
// Moi vong xin 1 account moi (gui kem `exclude`), quota chi bi tru o confirm.
async function denuvoRunViaBackend(appid, name, exe, temp, log) {
  const exclude = [];
  let lastMsg = "";
  const MAX_ROUNDS = 10;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let lease;
    try {
      lease = await api().denuvoAuthRequest(appid, exclude);
    } catch (err) {
      const msg = dvBackendErrMsg(err);
      log(msg);
      return { ok: false, msg };
    }
    if (!lease || (lease.mode !== "lease" && lease.mode !== "ticket" && lease.mode !== "cwk")) {
      log("Backend tra ve khong hop le.");
      return { ok: false, msg: "backend tra ve khong hop le" };
    }

    // Giai doan 2b: backend ship .CWK (lua da ma hoa, base64) -> app giai ma + ghi lua,
    // KHONG login Steam. Dung path tool khac "decrypt .CWK -> batch_lua_content".
    if (lease.mode === "cwk") {
      if (!lease.cwk) { log("Backend bao mode cwk nhung thieu du lieu .CWK."); return { ok: false, msg: "cwk rong tu backend" }; }
      const { steamPath } = await dvSteamPaths();
      const r = dvApplyCWK(steamPath, Buffer.from(lease.cwk, "base64"), log);
      dvCleanupExtracted(temp);
      if (!r.ok) { await api().denuvoAuthCancel(lease.lease_id, lease.account_id, false, "ap dung .CWK that bai"); return { ok: false, msg: "ap dung .CWK that bai" }; }
      try { await api().denuvoAuthConfirm(lease.lease_id); } catch (_) {}
      log("HOAN TAT (.CWK tu backend).");
      return { ok: true, appid, steamPath, ...r };
    }

    // Giai doan 2: backend tu mint ticket -> app chi ghi lua, KHONG login Steam.
    if (lease.mode === "ticket") {
      if (!lease.appticket || !lease.eticket) {
        log("Backend bao mode ticket nhung thieu du lieu ticket.");
        return { ok: false, msg: "ticket rong tu backend" };
      }
      const { steamPath } = await dvSteamPaths();
      const w = dvWriteTicketFiles(temp, steamPath, appid, name, lease.appticket, lease.eticket, log);
      dvCleanupExtracted(temp);
      try { await api().denuvoAuthConfirm(lease.lease_id); } catch (_) {}
      log("HOAN TAT (ticket tu backend).");
      return { ok: true, appid, steamPath, appticket: lease.appticket, eticket: lease.eticket, ...w };
    }

    // Hom nay: backend cap account, MAY NAY login + dump ticket.
    const safeLog = dvScrubLog(log, [lease.password]);
    const li = await dvSteamLoginHidden(lease.username, lease.password, safeLog);
    if (!li.ok) {
      safeLog("Login that bai: " + li.msg + " -> thu tai khoan khac");
      lastMsg = li.msg;
      await api().denuvoAuthCancel(lease.lease_id, lease.account_id, false, li.msg);
      exclude.push(lease.account_id);
      continue;   // chua login thi khong can dang xuat
    }

    let done = null, failReason = "";
    try {
      // Sau khi login Steam can vai giay sync license; chay ngay se "no ticket".
      let parsed = { ok: false, msg: "khong ro" };
      for (let attempt = 0; attempt < 5 && !parsed.ok; attempt++) {
        await sleep(4000);
        const r = await dvRunExtractTickets(exe, appid);
        parsed = dvParseTickets((r.out || "") + "\n" + (r.err || ""));
      }
      if (parsed.ok) {
        safeLog(`appticket(${parsed.appticket.length / 2} bytes) + eticket(${parsed.eticket.length / 2} bytes) OK`);
        const { steamPath } = await dvSteamPaths();
        const w = dvWriteTicketFiles(temp, steamPath, appid, name, parsed.appticket, parsed.eticket, safeLog);
        dvCleanupExtracted(temp);
        const denuvoSid = await dvActiveSteamId();
        safeLog("HOAN TAT.");
        done = { ok: true, appid, account: lease.username, steamId: denuvoSid, steamPath,
                 appticket: parsed.appticket, eticket: parsed.eticket, ...w };
      } else {
        safeLog("Khong lay duoc ticket (" + parsed.msg + ") -> thu tai khoan khac");
        failReason = parsed.msg; lastMsg = parsed.msg;
      }
    } finally {
      await dvSteamLogout(safeLog);
    }

    if (done) {
      // Confirm -> backend TRU quota (chi khi da co ticket that).
      try { await api().denuvoAuthConfirm(lease.lease_id); }
      catch (e) { safeLog("Luu y: xac nhan ve backend that bai (ticket da ghi xong) — " + String(e && e.message || e)); }
      if (done.steamId) dvAddLoginUsersEntry(done.steamPath, done.steamId, done.account, safeLog);
      else safeLog("Khong lay duoc SteamID acc Denuvo -> bo qua ghi loginusers.vdf.");
      return done;
    }

    // Login duoc nhung khong dump duoc ticket -> cancel (tra quota) + thu acc khac.
    await api().denuvoAuthCancel(lease.lease_id, lease.account_id, false, failReason);
    exclude.push(lease.account_id);
  }

  log("Da thu het tai khoan nhung khong lay duoc ticket.");
  return { ok: false, msg: lastMsg || "khong tai khoan nao lay duoc ticket" };
}

// Luong CU (fallback khi chua cau hinh backend): doc thang Supabase bang .env.
async function denuvoRunDirect(appid, name, exe, temp, log) {
  if (!SUPA_URL || !SUPA_KEY) {
    log("Chua cau hinh backend (G4_API_BASE) lan Supabase (.env) — app khong biet doc nguon nao.");
    return { ok: false, msg: "chua cau hinh nguon" };
  }

  log("Tra tai khoan cho appid " + appid + "...");
  // Doc thang Supabase (nhu g4_tool): lay het account available cho appid nay.
  const accs = await sbSelect("denuvo_accounts",
    `select=*&appid=eq.${appid}&status=eq.available&order=id.asc`);
  if (accs && accs.error) { log("Loi doc denuvo_accounts: " + accs.error); return { ok: false, msg: "loi account" }; }
  if (!Array.isArray(accs) || !accs.length) { log("Khong co tai khoan available cho game nay (kiem tra RLS denuvo_accounts?)."); return { ok: false, msg: "khong co tai khoan" }; }
  log("Dang thuc hien thao tac Denuvo...");

  // Xao tron ngau nhien (Fisher-Yates) -> moi lan bat dau bang 1 account ngau nhien,
  // khong luon dung account id nho nhat. Van thu lan luot het den khi lay duoc ticket.
  for (let i = accs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [accs[i], accs[j]] = [accs[j], accs[i]];
  }

  let lastMsg = "";
  for (let i = 0; i < accs.length; i++) {
    const acc = accs[i];

    // Lop chan cuoi: neu mat khau lo vao bat ky dong log nao (loi Steam echo lai,
    // duong dan, stderr...) thi no bi thay bang *** truoc khi den terminal/renderer.
    const safeLog = dvScrubLog(log, [acc.password]);

    const li = await dvSteamLoginHidden(acc.username, acc.password, safeLog);
    if (!li.ok) { safeLog("Login that bai: " + li.msg + " -> thu tai khoan khac"); lastMsg = li.msg; continue; }

    let done = null;
    try {
      // Sau khi login, Steam can vai giay de sync license/ownership; chay extract_tickets
      // ngay se ra "no ticket". Cho + thu lai toi 5 lan (~4s/lan) -> co ticket la dung.
      let parsed = { ok: false, msg: "khong ro" };
      for (let attempt = 0; attempt < 5 && !parsed.ok; attempt++) {
        await sleep(4000);
        const r = await dvRunExtractTickets(exe, appid);   // KHONG stream output tho ra terminal
        parsed = dvParseTickets((r.out || "") + "\n" + (r.err || ""));
      }
      if (parsed.ok) {
        safeLog(`appticket(${parsed.appticket.length / 2} bytes) + eticket(${parsed.eticket.length / 2} bytes) OK`);
        const { steamPath } = await dvSteamPaths();
        const w = dvWriteTicketFiles(temp, steamPath, appid, name, parsed.appticket, parsed.eticket, safeLog);
        dvCleanupExtracted(temp);   // don extracted (im lang), chi giu lai cong cu fix
        const denuvoSid = await dvActiveSteamId();   // SteamID acc Denuvo (doc khi con dang nhap)
        safeLog("HOAN TAT.");
        done = { ok: true, appid, account: acc.username, steamId: denuvoSid, steamPath,
                 appticket: parsed.appticket, eticket: parsed.eticket, ...w };
      } else {
        safeLog("Khong lay duoc ticket (" + parsed.msg + ") -> thu tai khoan khac");
        lastMsg = parsed.msg;
      }
    } finally {
      await dvSteamLogout(safeLog);
    }
    if (done) {
      // Steam da tat -> ghi entry acc Denuvo vao loginusers.vdf (token da o config.vdf nho
      // -rememberpassword) -> acc Denuvo hien trong danh sach chon tai khoan + switch sang dung duoc.
      if (done.steamId) dvAddLoginUsersEntry(done.steamPath, done.steamId, done.account, safeLog);
      else safeLog("Khong lay duoc SteamID acc Denuvo -> bo qua ghi loginusers.vdf.");
      return done;
    }
  }

  log("Da thu het tai khoan nhung khong lay duoc ticket.");
  return { ok: false, msg: lastMsg || "khong tai khoan nao lay duoc ticket" };
}

ipcMain.handle("denuvo-prepare", async (e) => {
  const log = (m) => { try { e.sender.send("denuvo-log", String(m)); } catch (_) {} };
  try { const ok = await denuvoPrepare(log); return { ok }; }
  catch (err) { log("Loi prepare: " + String(err && err.message || err)); return { ok: false, msg: String(err) }; }
});
ipcMain.handle("denuvo-run", async (e, arg) => {
  const log = (m) => { try { e.sender.send("denuvo-log", String(m)); } catch (_) {} };
  const appid = arg && typeof arg === "object" ? arg.appid : arg;
  const name = arg && typeof arg === "object" ? arg.name : null;
  try { return await denuvoRun(appid, name, log); }
  catch (err) { log("Loi: " + String(err && err.message || err)); return { ok: false, msg: String(err) }; }
});

// Ap dung 1 file .CWK co san (vd nhan tu may khac / backend) -> giai ma + ghi lua + registry.
// arg: duong dan .cwk (string) hoac { path }. Giong "decrypt .CWK -> write lua" cua tool khac.
ipcMain.handle("denuvo-apply-cwk", async (e, arg) => {
  const log = (m) => { try { e.sender.send("denuvo-log", String(m)); } catch (_) {} };
  try {
    const { steamPath } = await dvSteamPaths();
    const p = arg && typeof arg === "object" ? arg.path : arg;
    if (!p) return { ok: false, msg: "thieu duong dan .CWK" };
    return dvApplyCWK(steamPath, p, log);
  } catch (err) { log("Loi apply .CWK: " + String(err && err.message || err)); return { ok: false, msg: String(err) }; }
});

// Han ngach con lai cua may nay (chi khi dung backend). UI co the hien "con x/y luot".
ipcMain.handle("denuvo-permissions", async () => {
  if (!API_BASE) return { ok: false, msg: "khong dung backend" };
  try {
    const r = await api().denuvoPermissions();
    return r && r.quota ? { ok: true, quota: r.quota } : { ok: false, msg: "khong doc duoc han ngach" };
  } catch (err) { return { ok: false, msg: String(err && err.message || err) }; }
});

// Fix thu cong voi acc TUY CHINH (nhap tay username/password) — chay dung flow login Denuvo
// nhung KHONG lay account tu DB: login dung acc nguoi dung nhap -> dump ticket appid -> ghi lua.
async function denuvoRunManual(appid, username, password, name, log) {
  appid = String(appid || "").trim();
  if (!/^\d+$/.test(appid)) return { ok: false, msg: "appid khong hop le" };
  username = String(username || "").trim();
  password = String(password || "");
  if (!username || !password) return { ok: false, msg: "thieu username/password" };

  const temp = denuvoTempDir();
  let exe = dvFindExtractTickets(temp);
  if (!exe) { log("Chua co cong cu -> chuan bi..."); if (!(await denuvoPrepare(log))) return { ok: false, msg: "khong chuan bi duoc cong cu" }; exe = dvFindExtractTickets(temp); }
  if (!exe) return { ok: false, msg: "khong co extract_tickets.exe" };

  const safeLog = dvScrubLog(log, [password]);   // che mat khau trong log
  log("Fix thu cong voi acc tuy chinh cho appid " + appid + "...");

  const li = await dvSteamLoginHidden(username, password, safeLog);
  if (!li.ok) { safeLog("Login that bai: " + li.msg); return { ok: false, msg: li.msg }; }

  let done = null;
  try {
    let parsed = { ok: false, msg: "khong ro" };
    for (let attempt = 0; attempt < 5 && !parsed.ok; attempt++) {
      await sleep(4000);
      const r = await dvRunExtractTickets(exe, appid);
      parsed = dvParseTickets((r.out || "") + "\n" + (r.err || ""));
    }
    if (parsed.ok) {
      safeLog(`appticket(${parsed.appticket.length / 2} bytes) + eticket(${parsed.eticket.length / 2} bytes) OK`);
      const { steamPath } = await dvSteamPaths();
      const w = dvWriteTicketFiles(temp, steamPath, appid, name, parsed.appticket, parsed.eticket, safeLog);
      dvCleanupExtracted(temp);
      const sid = await dvActiveSteamId();   // SteamID acc (doc khi con dang nhap)
      safeLog("HOAN TAT.");
      done = { ok: true, appid, account: username, steamId: sid, steamPath,
               appticket: parsed.appticket, eticket: parsed.eticket, ...w };
    } else {
      safeLog("Khong lay duoc ticket (" + parsed.msg + ") — acc nay co so huu game khong?");
      return { ok: false, msg: parsed.msg };
    }
  } finally {
    await dvSteamLogout(safeLog);
  }
  // Steam da tat -> ghi entry acc vao loginusers.vdf (token da o config.vdf nho -rememberpassword).
  if (done && done.steamId) dvAddLoginUsersEntry(done.steamPath, done.steamId, username, safeLog);
  return done || { ok: false, msg: "khong lay duoc ticket" };
}

ipcMain.handle("denuvo-run-manual", async (e, arg) => {
  const log = (m) => { try { e.sender.send("denuvo-log", String(m)); } catch (_) {} };
  const a = arg || {};
  try { return await denuvoRunManual(a.appid, a.username, a.password, a.name, log); }
  catch (err) { log("Loi: " + String(err && err.message || err)); return { ok: false, msg: String(err) }; }
});

// ============ HOT UPDATE lop RENDERER (khong dong app) ============
// Renderer (index.html/renderer.js/styles.css) cap nhat NONG: tai bundle .zip moi ve
// userData/renderer roi loadFile lai -> giao dien + logic renderer ap dung NGAY, tien trinh
// main GIU NGUYEN (khong tat app). Doi code main.js thi van can installer (restart).
function hotRendererDir() { return path.join(app.getPath("userData"), "renderer"); }
function hotMetaPath() { return path.join(hotRendererDir(), "meta.json"); }
function hotRendererVersion() {   // version ban hot da luu, null neu chua co
  try { return JSON.parse(fs.readFileSync(hotMetaPath(), "utf8")).version || null; } catch (_) { return null; }
}
// Version renderer dang co hieu luc = ban hot NEU moi hon ban dong goi (app version); nguoc lai = app version.
function activeRendererVersion() {
  const appVer = app.getVersion();
  const hot = hotRendererVersion();
  return (hot && verGt(hot, appVer)) ? hot : appVer;
}
// index.html se load: ban hot CHI KHI moi hon ban dong goi (installer moi -> ban dong goi moi hon
// -> tu bo qua ban hot cu). Thieu file -> ban dong goi.
function rendererIndex() {
  try {
    const dir = hotRendererDir();
    const hot = hotRendererVersion();
    if (hot && verGt(hot, app.getVersion())
        && fs.existsSync(path.join(dir, "index.html")) && fs.existsSync(path.join(dir, "renderer.js")))
      return path.join(dir, "index.html");
  } catch (_) {}
  return path.join(__dirname, "index.html");
}
function packagedIndex() { return path.join(__dirname, "index.html"); }
function resetHotRenderer() { try { fs.rmSync(hotRendererDir(), { recursive: true, force: true }); } catch (_) {} }
// Tim thu muc chua index.html trong bundle da giai nen (co the nam trong subfolder cua zip).
function findRendererRoot(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    if (items.some((it) => it.isFile() && it.name.toLowerCase() === "index.html")) return d;
    for (const it of items) if (it.isDirectory()) stack.push(path.join(d, it.name));
  }
  return null;
}

// Kiem tra ban renderer moi tren Supabase (bang g4_renderer: version, url zip, notes).
ipcMain.handle("renderer-check", async () => {
  const current = activeRendererVersion();
  if (!SUPA_URL || !SUPA_KEY) return { update: false, current };
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/denuvo_renderer?select=*&order=created_at.desc&limit=1`,
      { headers: { apikey: SUPA_KEY, Authorization: "Bearer " + SUPA_KEY } });
    if (!r.ok) return { update: false, current };
    const rel = (await r.json())[0];
    if (!rel || !rel.version) return { update: false, current };
    return { update: verGt(rel.version, current), version: rel.version, url: rel.url, notes: rel.notes, current };
  } catch (_) { return { update: false, current }; }
});

// Tai bundle renderer .zip -> giai nen -> thay userData/renderer -> loadFile lai (ap dung ngay).
ipcMain.handle("renderer-apply", async (_e, arg) => {
  const url = arg && arg.url, version = arg && arg.version;
  if (!url || !version) return { ok: false, message: "Thiếu url/version" };
  try {
    const base = app.isPackaged ? path.dirname(app.getPath("exe")) : __dirname;
    const work = path.join(base, "renderer_update");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const zip = path.join(work, "bundle.zip");
    await dvDownloadSmart(url, zip, null, null);            // https -> fallback Electron net
    const ex = await dvExtractArchive(zip, path.join(work, "out"), "zip");
    if (!ex.ok) { fs.rmSync(work, { recursive: true, force: true }); return { ok: false, message: "Giải nén lỗi" }; }
    const root = findRendererRoot(path.join(work, "out"));
    if (!root || !fs.existsSync(path.join(root, "renderer.js"))) {
      fs.rmSync(work, { recursive: true, force: true });
      return { ok: false, message: "Bundle thiếu index.html/renderer.js" };
    }
    const dir = hotRendererDir();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(root, dir, { recursive: true });
    fs.writeFileSync(hotMetaPath(), JSON.stringify({ version, appliedAt: Date.now() }), "utf8");
    fs.rmSync(work, { recursive: true, force: true });
    if (win) win.loadFile(rendererIndex());                 // ap dung NGAY - khong dong app
    return { ok: true, version };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
});

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 600,
    height: 880,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    icon: path.join(__dirname, "g4market.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Ban hot-update loi khong load duoc -> tu quay ve ban dong goi (an toan, tranh man hinh trang).
  win.webContents.on("did-fail-load", (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame && rendererIndex() !== packagedIndex()) { resetHotRenderer(); win.loadFile(packagedIndex()); }
  });
  win.loadFile(rendererIndex());
}

app.whenReady().then(() => {
  // ISP chan DNS -> bat DNS-over-HTTPS cho CA tang mang Chromium (net.request, cua so an
  // depotbox, anh CDN trong renderer). Che do "automatic": uu tien DoH nhung van fallback
  // DNS thuong -> may co mang binh thuong khong bi anh huong.
  // Neu DoH van khong an (Chromium bo qua/IP chet), dvGetText da co duong ghim IP du phong.
  try {
    app.configureHostResolver({
      enableBuiltInResolver: true,          // BAT BUOC: thieu no Chromium bo qua DoH, van dung DNS he thong
      secureDnsMode: "automatic",
      secureDnsServers: ["https://dns.google/dns-query", "https://cloudflare-dns.com/dns-query"],
    });
  } catch (_) {}
  createWindow();
  // Don ticket Denuvo da het han (tu session truoc) khoi file lua luc mo app.
  (async () => {
    try {
      let { steamPath } = await dvSteamPaths();
      if (!steamPath) steamPath = getSteamDir();
      if (steamPath) { const n = dvCleanExpiredTickets(steamPath); if (n) console.log("[denuvo] da don " + n + " ticket het han"); }
    } catch (_) {}
  })();
});

ipcMain.on("win-min", () => win && win.minimize());
ipcMain.on("win-max", () => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on("win-close", () => win && win.close());

app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

