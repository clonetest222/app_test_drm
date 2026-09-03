// ============================================================================
//  G4play Denuvo Manage — CAU NOI TOI BACKEND DENO
//
//  Truoc day main.js cam SUPABASE_PUBLISHABLE_KEY va GET thang bang
//  denuvo_accounts => ai giai nen app.asar (30 giay) cung dump duoc TOAN BO
//  username/password Steam dang plaintext.
//
//  Bay gio app KHONG con key Supabase nao. Moi thu cham vao credential deu:
//    1. duoc ky HMAC bang device_secret rieng cua may nay (cap luc dang ky),
//    2. tra ve trong phong bi AES-256-GCM voi khoa dan xuat tu chinh request do,
//    3. bi rate-limit + ghi audit o backend, va co the khoa rieng tung may.
//
//  Gioi han that su (noi thang): app chay tren may nguoi dung thi cuoi cung
//  van phai cam mat khau cua DUNG game dang fix de goi `steam.exe -login`.
//  Cai ban va nay chan duoc la: dump ca kho tai khoan, ro ri khi lo key/DB,
//  va lam moi lan lay credential deu co dau vet. Muon triet de thi backend
//  phai tu lay ticket (xem mode "ticket" trong backend/src/routes/denuvo.ts).
// ============================================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile } = require("child_process");
const { app, safeStorage, net } = require("electron");

// ------------------------------------------------------------------ tien ich
const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randHex = (n) => crypto.randomBytes(n).toString("hex");

function execOut(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", windowsHide: true, timeout: timeout || 5000 },
      (err, out) => resolve(err ? "" : String(out || "")));
  });
}

// ---------------------------------------------------- van tay may (fingerprint)
// MachineGuid (on dinh qua ca cai lai app) + hostname + serial o dia he thong.
// Chi de backend nhan ra "cung mot may" -> cap lai secret, va de khoa rieng may xau.
let _fpCache = null;
async function machineFingerprint() {
  if (_fpCache) return _fpCache;
  let guid = "";
  try {
    const out = await execOut("reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
    if (m) guid = m[1];
  } catch (_) {}
  let vol = "";
  try {
    const out = await execOut("cmd", ["/c", "vol", process.env.SystemDrive || "C:"]);
    const m = out.match(/([0-9A-F]{4}-[0-9A-F]{4})/i);
    if (m) vol = m[1];
  } catch (_) {}
  _fpCache = sha256Hex("g4play|" + guid + "|" + os.hostname() + "|" + vol + "|" + os.userInfo().username);
  return _fpCache;
}

// -------------------------------------------------- luu device_secret tren may
// Uu tien Electron safeStorage (Windows = DPAPI, gan voi tai khoan Windows —
// chep file sang may khac la vo dung). Khong co thi luu tho.
function devicePath() { return path.join(app.getPath("userData"), "g4_device.json"); }

function saveDevice(id, secret) {
  let payload;
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      payload = { v: 2, id: id, dpapi: safeStorage.encryptString(secret).toString("base64") };
    } else {
      payload = { v: 1, id: id, raw: secret };
    }
  } catch (_) { payload = { v: 1, id: id, raw: secret }; }
  try {
    fs.writeFileSync(devicePath(), JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  } catch (_) {}
}

function loadDevice() {
  try {
    const j = JSON.parse(fs.readFileSync(devicePath(), "utf8"));
    if (!j || !j.id) return null;
    if (j.dpapi) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
      return { id: j.id, secret: safeStorage.decryptString(Buffer.from(j.dpapi, "base64")) };
    }
    return j.raw ? { id: j.id, secret: j.raw } : null;
  } catch (_) { return null; }
}

// -------------------------------------------------------- HTTP (Electron net)
// Dung net.request (stack Chromium) de an theo DoH da bat trong main.js — may bi
// ISP chan DNS van goi duoc backend.
function httpJson(method, url, opts) {
  const o = opts || {};
  const headers = o.headers || {};
  const body = o.body == null ? null : o.body;
  const timeoutMs = o.timeoutMs || 20000;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = net.request({ method: method, url: url, redirect: "follow" });
    } catch (e) { return finish({ ok: false, error: String(e) }); }

    for (const k of Object.keys(headers)) req.setHeader(k, headers[k]);
    if (body != null) req.setHeader("Content-Type", "application/json");

    const timer = setTimeout(() => {
      try { req.abort(); } catch (_) {}
      finish({ ok: false, error: "timeout" });
    }, timeoutMs);

    req.on("response", (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c.toString("utf8"); });
      res.on("end", () => {
        clearTimeout(timer);
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: json, raw: buf });
      });
      res.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: String(e) }); });
    });
    req.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: String(e) }); });
    if (body != null) req.write(body);
    req.end();
  });
}

// --------------------------------------------------------- mo phong bi ma hoa
// Doi xung voi seal() + deriveResponseKey() ben backend/src/crypto.ts.
function openSealed(secret, nonce, deviceId, box) {
  const key = Buffer.from(crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(nonce, "utf8"),
    Buffer.from("g4play-denuvo-response-v1", "utf8"),
    32,
  ));
  const data = Buffer.from(box.ct, "base64");
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(0, data.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  d.setAAD(Buffer.from("resp:" + deviceId + ":" + nonce, "utf8"));
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

// ============================================================== lop API chinh
class G4Api {
  constructor(o) {
    o = o || {};
    this.base = String(o.baseUrl || "").replace(/\/+$/, "");
    this.enrollToken = o.enrollToken || "";
    this.appVersion = o.appVersion || "0.0.0";
    this.device = null;
  }

  get configured() { return !!this.base; }

  /** Dang ky may nay voi backend (lan dau, hoac khi secret cu khong con dung). */
  async register() {
    const fingerprint = await machineFingerprint();
    const r = await httpJson("POST", this.base + "/v1/device/register", {
      headers: { "X-G4-Enroll": this.enrollToken },
      body: JSON.stringify({ fingerprint: fingerprint, app_version: this.appVersion, platform: process.platform }),
    });
    if (!r.ok || !r.json || !r.json.device_id) {
      const msg = (r.json && r.json.message) || r.error || ("HTTP " + r.status);
      throw new Error("Dang ky thiet bi that bai: " + msg);
    }
    this.device = { id: r.json.device_id, secret: r.json.device_secret };
    saveDevice(this.device.id, this.device.secret);
    return this.device;
  }

  async ensureDevice() {
    if (this.device) return this.device;
    this.device = loadDevice();
    if (!this.device) this.device = await this.register();
    return this.device;
  }

  /** Goi endpoint da ky. Secret hong / thiet bi la -> tu dang ky lai 1 lan roi thu lai. */
  async signed(method, endpoint, payload, _retried) {
    const dev = await this.ensureDevice();
    const bodyText = payload === undefined || payload === null ? "" : JSON.stringify(payload);
    const ts = String(Date.now());
    const nonce = randHex(16);
    const canonical = [method, endpoint, ts, nonce, sha256Hex(bodyText)].join("\n");
    const sig = crypto.createHmac("sha256", dev.secret).update(canonical).digest("hex");

    const r = await httpJson(method, this.base + endpoint, {
      headers: { "X-G4-Device": dev.id, "X-G4-Ts": ts, "X-G4-Nonce": nonce, "X-G4-Sig": sig },
      body: method === "GET" ? null : bodyText,
    });

    if (r.status === 401 && r.json && ["unknown_device", "bad_sig"].indexOf(r.json.code) >= 0 && !_retried) {
      this.device = null;
      try { fs.unlinkSync(devicePath()); } catch (_) {}
      await this.register();
      return await this.signed(method, endpoint, payload, true);
    }
    if (!r.ok) {
      const err = new Error((r.json && r.json.message) || r.error || ("HTTP " + r.status));
      err.code = (r.json && r.json.code) || "http_error";
      err.status = r.status;
      throw err;
    }
    // Payload nhay cam -> nam trong phong bi ma hoa; con lai tra thang.
    if (r.json && r.json.enc === 1) return openSealed(dev.secret, nonce, dev.id, r.json);
    return r.json;
  }

  // ---------------------------------------------------------------- endpoint
  /** Muon 1 tai khoan cho appid. `exclude` = cac account_id da thu that bai. */
  denuvoTicket(appid, exclude) {
    return this.signed("POST", "/v1/denuvo/ticket",
      { appid: String(appid), exclude: exclude || [], app_version: this.appVersion });
  }

  /** Bao ket qua ve backend -> account hong tu bi chan, va audit co that. */
  async denuvoResult(accountId, okFlag, reason) {
    try {
      await this.signed("POST", "/v1/denuvo/ticket/result", {
        account_id: accountId,
        ok: !!okFlag,
        reason: String(reason || "").slice(0, 200),
      });
    } catch (_) { /* bao ket qua that bai khong duoc lam hong luong fix */ }
  }

  denuvoRequirement() { return this.signed("GET", "/v1/denuvo/requirement", null); }

  /** Cap nhat: khong nhay cam nen khong ky, nhung van qua backend
   *  (app khong con cam key Supabase nao het). */
  async update(kind) {
    const r = await httpJson("GET", this.base + "/v1/update/" + kind);
    return r.ok && r.json && r.json.found ? r.json : null;
  }
}

module.exports = { G4Api, machineFingerprint };
