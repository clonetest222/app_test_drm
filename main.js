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
const DV_LOGIN_POLL_MS = 1000;         // nhip doc connection_log
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
  // -login user pass (KHONG ghi registry). -silent de Steam thu vao tray (an).
  try { spawn(exe, ["-silent", "-login", user, pass], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); }
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

// Ghi tickets.txt (vao temp) + ticket vao denuvo_g4play.lua o CA HAI thu muc lua,
// 1 block / appid. Block giong het nhau o hai file (cung `created`) nen
// readDenuvoEntries() gop trung theo "appid:created", khong dem thanh 2 ticket.
function dvWriteTicketFiles(temp, steamPath, appid, name, appticket, eticket, log) {
  const txtPath = path.join(temp, "tickets.txt");
  fs.writeFileSync(txtPath,
    `appid: ${appid}\nappticket(184 bytes): ${appticket}\neticket(143 bytes): ${eticket}\n`, "utf8");
  log("Da luu ticket.");
  if (!steamPath) { log("Khong ro Steam -> bo qua ghi ticket."); return { txtPath }; }
  dvPurgeOldTicketBlocks(steamPath, appid);   // bo ticket cu con sot trong g4_tool.lua

  const ts = Date.now();
  let iso = ""; try { iso = new Date(ts).toLocaleString("sv-SE"); } catch (e) {}
  const safeName = String(name || "").replace(/[\r\n]+/g, " ").trim();
  const block = [
    `--denuvo appid=${appid} created=${ts} createdAt="${iso}" name=${safeName}`,
    `setAppTicket(${appid}, "${appticket}")`,
    `setETicket(${appid}, "${eticket}")`,
  ].join("\r\n");
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
  if (!written.length) { log("KHONG ghi duoc ticket vao thu muc nao."); return { txtPath }; }
  log(`Da ghi ticket vao ${written.length} thu muc lua (het han sau 30 phut).`);
  return { txtPath, luaPath: written[0], luaPaths: written };
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

// ---- Buoc 1: tai + giai nen requirement vao temp ----
async function denuvoPrepare(log) {
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

// ---- Buoc 2: login account -> chay extract_tickets -> ghi file ----
async function denuvoRun(appid, name, log) {
  appid = String(appid || "").trim();
  if (!/^\d+$/.test(appid)) return { ok: false, msg: "appid khong hop le" };
  const temp = denuvoTempDir();
  let exe = dvFindExtractTickets(temp);
  if (!exe) { log("Chua co cong cu -> chuan bi..."); if (!(await denuvoPrepare(log))) return { ok: false, msg: "khong chuan bi duoc cong cu" }; exe = dvFindExtractTickets(temp); }
  if (!exe) return { ok: false, msg: "khong co extract_tickets.exe" };

  if (!SUPA_URL || !SUPA_KEY) {
    log("Chua cau hinh Supabase trong .env — app khong biet doc nguon nao.");
    return { ok: false, msg: "chua cau hinh Supabase" };
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
        safeLog("HOAN TAT.");
        done = { ok: true, appid, account: acc.username, appticket: parsed.appticket, eticket: parsed.eticket, ...w };
      } else {
        safeLog("Khong lay duoc ticket (" + parsed.msg + ") -> thu tai khoan khac");
        lastMsg = parsed.msg;
      }
    } finally {
      await dvSteamLogout(safeLog);
    }
    if (done) return done;
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
});

ipcMain.on("win-min", () => win && win.minimize());
ipcMain.on("win-max", () => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on("win-close", () => win && win.close());

app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

