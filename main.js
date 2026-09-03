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

ipcMain.handle("check-update", async () => {
  const current = app.getVersion();
  if (!API_BASE) return { update: false, current };
  try {
    const rel = await api().update("release");
    if (!rel || !rel.version) return { update: false, current };
    return { update: verGt(rel.version, current), version: rel.version, url: rel.url, notes: rel.notes, current };
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

// Lay appid GAME CHINH tu MOI file .lua trong config\stplug-in. Moi file co the chia
// thanh nhieu block (phan tach bang dong chi co "--"); MOI block = 1 game + depot/DLC
// cua no, va dong addappid DAU TIEN cua block = game chinh. Chi lay dong dau moi block
// -> bo qua het depot/DLC -> it appid -> it request hon HAN (vd 18 appid -> 3 game).
// (nomore.lua la file ghi ticket cua chinh app, khong co addappid nen tu loai.)
function denuvoInstalledAppids() {
  const seen = new Set(), out = [];
  for (const dir of luaDirs()) {         // ca config\stplug-in lan config\lua
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.lua$/i.test(f) && !/^nomore\.lua$/i.test(f)); }
    catch (_) { continue; }
    for (const f of files) {
      let txt = "";
      try { txt = fs.readFileSync(path.join(dir, f), "utf8"); } catch (_) { continue; }
      for (const block of txt.split(/\r?\n\s*--\s*\r?\n/)) {
        const m = block.match(/addappid\s*\(\s*(\d+)/i);   // addappid dau block = game chinh
        if (m && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
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
async function dvSteamShutdownWait(steamExe, log, maxMs = 25000) {
  try { execFile(steamExe, ["-shutdown"], { windowsHide: true }); } catch (e) {}
  const n = Math.ceil(maxMs / 500);
  for (let i = 0; i < n; i++) { if (!(await dvSteamRunning())) return true; await sleep(500); }
  if (log) log("Steam khong tu thoat -> buoc dong...");
  try { execFile("taskkill", ["/IM", "steam.exe", "/F"], { windowsHide: true }); } catch (e) {}
  await sleep(1500);
  return !(await dvSteamRunning());
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
// Doc connection_log -> "ok" | { fail, reason } | "pending" (chi xet dong sau moc dang nhap).
function dvCheckLoginLog(logPath, fromTime) {
  let txt = "";
  try { txt = fs.readFileSync(logPath, "utf8"); } catch (e) { return "pending"; }
  let sawOK = false;
  for (const line of txt.split(/\r?\n/)) {
    const ts = dvParseLogTs(line);
    if (ts == null || ts < fromTime) continue;
    if (line.includes("[Logged On,")) return "ok";
    const res = dvParseLogonResult(line);
    if (res == null) continue;
    if (res === "OK") sawOK = true;
    else if (res === "processing complete") { if (sawOK) return "ok"; }
    else return { fail: true, reason: DV_LOGON_FAILURES[res] || res };
  }
  return "pending";
}

async function dvSteamLoginHidden(user, pass, log) {
  const { dir, exe } = await dvSteamDirExe();
  if (!exe) return { ok: false, msg: "Khong tim thay steam.exe" };
  // BAT BUOC dong han Steam cu truoc: neu con chay, -login se bam vao session cua acc cu.
  log("Dang dong Steam hien tai...");
  await dvSteamShutdownWait(exe, log);
  const logPath = dir ? path.join(dir, "logs", "connection_log.txt") : null;
  const fromTime = Date.now() - 2000;   // margin vi log chi co do phan giai giay
  log("Dang dang nhap tai khoan...");
  // -login user pass (KHONG ghi registry). -silent de Steam thu vao tray (an).
  try { spawn(exe, ["-silent", "-login", user, pass], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); }
  catch (e) { return { ok: false, msg: String(e) }; }
  const deadline = Date.now() + 120000;   // cho toi 2 phut
  while (Date.now() < deadline) {
    await sleep(1000);
    if (logPath) {
      const r = dvCheckLoginLog(logPath, fromTime);
      if (r === "ok") { log("Steam da dang nhap."); return { ok: true }; }
      if (r && r.fail) { log("Login that bai: " + r.reason); return { ok: false, msg: r.reason }; }
    } else if (await dvSteamRunning()) {   // khong ro thu muc log -> fallback: coi nhu OK khi Steam chay
      await sleep(4000); log("Steam da dang nhap."); return { ok: true };
    }
  }
  return { ok: false, msg: "Het thoi gian cho Steam dang nhap (tai khoan co the can uy quyen may nay / Steam Guard)" };
}
async function dvSteamLogout(log) {
  const { exe } = await dvSteamDirExe();
  if (!exe) return;
  log("Dang dang xuat tai khoan...");
  await dvSteamShutdownWait(exe, log, 15000);
  log("Da dang xuat tai khoan.");
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
function dvTicketLuaPath(steamPath, appid) {
  const all = LUA_SUBDIRS.map((p) => path.join(steamPath, ...p));
  const exist = all.filter(isDir);
  const hasAppid = exist.find((d) => {
    const re = new RegExp("addappid\\s*\\(\\s*" + appid + "\\b", "i");
    try {
      return fs.readdirSync(d).some((f) => /\.lua$/i.test(f) &&
        re.test(fs.readFileSync(path.join(d, f), "utf8")));
    } catch (_) { return false; }
  });
  const hasTicketFile = exist.find((d) => fs.existsSync(path.join(d, "g4_tool.lua")));
  const dir = hasAppid || hasTicketFile || all[0];
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "g4_tool.lua");
}

// Ghi tickets.txt (vao temp) + ticket vao g4_tool.lua (config\stplug-in hoac config\lua), 1 block / appid.
function dvWriteTicketFiles(temp, steamPath, appid, name, appticket, eticket, log) {
  const txtPath = path.join(temp, "tickets.txt");
  fs.writeFileSync(txtPath,
    `appid: ${appid}\nappticket(184 bytes): ${appticket}\neticket(143 bytes): ${eticket}\n`, "utf8");
  log("Da luu ticket.");
  if (!steamPath) { log("Khong ro Steam -> bo qua ghi ticket."); return { txtPath }; }
  const luaPath = dvTicketLuaPath(steamPath, appid);
  // Giu cac block khac, bo block ticket cu cua chinh appid nay (neu co) -> ghi lai.
  const blocks = readLuaBlocks(luaPath).filter(
    (b) => !new RegExp(`^--\\s*denuvo\\s+appid=${appid}\\b`).test(b));
  const ts = Date.now();
  let iso = ""; try { iso = new Date(ts).toLocaleString("sv-SE"); } catch (e) {}
  const safeName = String(name || "").replace(/[\r\n]+/g, " ").trim();
  const block = [
    `--denuvo appid=${appid} created=${ts} createdAt="${iso}" name=${safeName}`,
    `setAppTicket(${appid}, "${appticket}")`,
    `setETicket(${appid}, "${eticket}")`,
  ].join("\r\n");
  blocks.push(block);
  fs.writeFileSync(luaPath, blocks.join("\r\n--\r\n") + "\r\n", "utf8");
  log("Da ghi ticket (het han sau 30 phut).");
  return { txtPath, luaPath };
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
  for (const dir of luaDirsIn(steamPath)) {           // ticket co the nam o stplug-in hoac lua
    let cur = "";
    try { cur = fs.readFileSync(path.join(dir, "g4_tool.lua"), "utf8"); } catch (e) { continue; }
    const re = /--\s*denuvo\s+appid=(\d+)\s+created=(\d+)[^\r\n]*?\bname=([^\r\n]*)/gi;
    let m;
    while ((m = re.exec(cur))) {
      const created = parseInt(m[2], 10) || 0;
      const key = m[1] + ":" + created;
      if (seen.has(key)) continue;                    // cung ticket o 2 thu muc -> chi tinh 1
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
  if (!API_BASE) { log("Chua cau hinh G4_API_BASE trong .env."); return false; }
  let rows = [];
  try {
    const res = await api().denuvoRequirement();     // qua backend, khong doc thang Supabase
    rows = (res && res.rows) || [];
  } catch (e) {
    log("Khong lay duoc cau hinh fix: " + ((e && e.message) || e));
    return false;
  }
  if (!rows.length) { log("Khong lay duoc cau hinh fix."); return false; }
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

  if (!API_BASE) {
    log("Chua cau hinh G4_API_BASE trong .env — app khong biet goi backend nao.");
    return { ok: false, msg: "chua cau hinh backend" };
  }

  log("Dang xin quyen truy cap tai khoan cho appid " + appid + "...");

  // Backend cap TUNG tai khoan mot (khong con dump ca bang xuong may). Moi vong:
  //   xin lease -> login -> lay ticket -> bao ket qua ve backend.
  // `tried` gui len de backend khong cap lai account vua hong.
  const tried = [];
  let lastMsg = "";
  const MAX_ROUNDS = 6;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let lease = null;
    try {
      lease = await api().denuvoTicket(appid, tried);
    } catch (e) {
      const code = e && e.code;
      if (code === "no_account") {
        log(tried.length ? "Da thu het tai khoan kha dung cho game nay." : "Chua co tai khoan kha dung cho game nay.");
      } else if (code === "rate_appid" || code === "rate_hour" || code === "rate_day") {
        log("Bi gioi han: " + e.message);
      } else if (code === "device_revoked") {
        log("May nay da bi khoa: " + e.message);
      } else {
        log("Khong xin duoc tai khoan: " + ((e && e.message) || e));
      }
      lastMsg = (e && e.message) || String(e);
      break;
    }

    // Giai doan 2 (backend tu lay ticket): app KHONG bao gio thay mat khau.
    // Protocol da san sang, bat len chi can doi backend, khong phai cap nhat app.
    if (lease && lease.mode === "ticket" && lease.appticket && lease.eticket) {
      log("Backend tra ticket san — khong can dang nhap Steam tren may nay.");
      const { steamPath } = await dvSteamPaths();
      const w = dvWriteTicketFiles(temp, steamPath, appid, name, lease.appticket, lease.eticket, log);
      dvCleanupExtracted(temp);
      log("HOAN TAT.");
      return { ok: true, appid, account: "server", appticket: lease.appticket, eticket: lease.eticket, ...w };
    }

    if (!lease || lease.mode !== "lease" || !lease.username || !lease.password) {
      lastMsg = "phan hoi backend khong hop le";
      log("Phan hoi tu backend khong hop le.");
      break;
    }

    tried.push(lease.account_id);

    // Lop chan cuoi: neu mat khau lo vao bat ky dong log nao (loi Steam echo lai,
    // duong dan, stderr...) thi no bi thay bang *** truoc khi den terminal/renderer.
    const safeLog = dvScrubLog(log, [lease.password]);

    const li = await dvSteamLoginHidden(lease.username, lease.password, safeLog);
    if (!li.ok) {
      safeLog("Login that bai: " + li.msg + " -> thu tai khoan khac");
      lastMsg = li.msg;
      await api().denuvoResult(lease.account_id, false, "login: " + li.msg);
      continue;
    }

    let done = null;
    let failReason = "";
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
        done = { ok: true, appid, account: lease.username, appticket: parsed.appticket, eticket: parsed.eticket, ...w };
      } else {
        safeLog("Khong lay duoc ticket (" + parsed.msg + ") -> thu tai khoan khac");
        lastMsg = parsed.msg;
        failReason = "ticket: " + parsed.msg;
      }
    } finally {
      await dvSteamLogout(safeLog);
      // Bao ket qua ve backend -> account hong tu bi dem loi/chan, va co audit trail.
      await api().denuvoResult(lease.account_id, !!done, failReason);
    }
    if (done) return done;
  }

  log("Khong lay duoc ticket cho game nay.");
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
  if (!API_BASE) return { update: false, current };
  try {
    const rel = await api().update("renderer");
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

