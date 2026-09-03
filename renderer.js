const $ = (s) => document.querySelector(s);

// Anh bia game tren card Denuvo (giong ban day du): anh doc truoc, roi fallback hero/header.
const CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps";
const COVER_KINDS = ["library_600x900.jpg", "library_hero.jpg", "header.jpg"];
function makeImg(appid, kinds) {
  const img = document.createElement("img");
  const urls = kinds.map((k) => `${CDN}/${appid}/${k}`);
  let i = 0; img.src = urls[0];
  img.onerror = () => { i++; if (i < urls.length) img.src = urls[i]; else img.remove(); };
  return img;
}

// ---- Nut cua so (ca macOS dots lan Windows buttons, theo data-win) ----
document.querySelectorAll("[data-win]").forEach((el) => {
  el.onclick = () => {
    const a = el.dataset.win;
    if (a === "min") window.g4.winMin();
    else if (a === "close") window.g4.winClose();
    else if (a === "max") window.g4.winMax();
  };
});

// ---- Trang thai footer ----
function setStatus(text) { $("#status-text").textContent = text; }

// ---- Tabs -> chuyen panel (ban Denuvo chi con 2 tab) ----
const PANELS = { denuvo: "panel-denuvo", settings: "panel-settings" };
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    for (const [k, id] of Object.entries(PANELS)) $("#" + id).classList.toggle("hidden", k !== which);
    if (which === "settings") loadSettings();
    if (which === "denuvo") loadDenuvo();
  };
});

// ============ TAB CAI DAT ============
async function loadSettings() {
  const v = await window.g4.appVersion();
  $("#app-version").textContent = "v" + v;
  loadSteamPath();
  loadLuaDirs();
}

// Cho biet app dang doc .lua o thu muc nao (config\stplug-in va/hoac config\lua).
async function loadLuaDirs() {
  const el = $("#lua-dirs");
  if (!el || !window.g4.luaDirs) return;
  const dirs = (await window.g4.luaDirs()) || [];
  el.textContent = dirs.length
    ? "Đang đọc .lua ở: " + dirs.map((d) => d.split(/[\\/]/).slice(-2).join("\\")).join("  •  ")
    : "Chưa thấy thư mục config\\stplug-in hoặc config\\lua";
}

// Hien duong dan thu muc Steam hien tai (registry hoac backup thu cong).
async function loadSteamPath() {
  const el = $("#steam-path");
  if (!el) return;
  const r = await window.g4.getSteamPath();
  if (r && r.path) el.textContent = r.path + (r.manual ? "  (thủ công)" : "");
  else el.textContent = "Không tìm thấy Steam";
}
$("#btn-set-steam").onclick = async () => {
  const r = await window.g4.setSteamPathManual();
  if (!r || r.status === "canceled") return;
  const el = $("#steam-path");
  if (r.ok) el.textContent = r.path + "  (thủ công)";
  else el.textContent = r.message || "Thư mục chưa đúng — phải là nơi có steam.exe";
};

// Kieu titlebar: Windows (nut vuong) vs macOS (cham). Mac default = tuy chinh (cham).
const TB_KEY = "g4_titlebar_style";
function applyTitlebar(style) {
  const w = $("#window");
  w.classList.toggle("tb-windows", style === "windows");
  w.classList.toggle("tb-macos", style === "macos");
  document.querySelectorAll("#titlebar-seg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.style === style));
  try { localStorage.setItem(TB_KEY, style); } catch (_) {}
}
document.querySelectorAll("#titlebar-seg .seg-btn").forEach((b) => { b.onclick = () => applyTitlebar(b.dataset.style); });

(async () => {
  let style = null;
  try { style = localStorage.getItem(TB_KEY); } catch (_) {}
  if (!style) {
    const plat = await window.g4.getPlatform();
    style = plat === "darwin" ? "macos" : "windows";   // mac -> custom dots, windows -> nut Windows
  }
  applyTitlebar(style);
})();

// ============ CẬP NHẬT (modal giữa màn hình, thanh % download) ============
let updateInfo = null;

// Đổ changelog (notes + link) vào 1 khung bất kỳ.
function fillChangelog(boxId, notesId, linkId, notes, url) {
  const cl = $("#" + boxId);
  if (notes || url) {
    cl.classList.remove("hidden");
    $("#" + notesId).textContent = notes || "";
    const link = $("#" + linkId);
    if (url) { link.href = url; link.classList.remove("hidden"); }
    else link.classList.add("hidden");
  } else cl.classList.add("hidden");
}

function openUpdateModal() {
  if (!updateInfo || !updateInfo.update) return;
  $("#um-ver").textContent = "v" + updateInfo.version;
  $("#um-sub").textContent = `Đang dùng v${updateInfo.current} — cập nhật để dùng bản mới nhất`;
  fillChangelog("um-changelog", "um-notes", "um-link", updateInfo.notes, updateInfo.url);
  $("#um-prog").classList.add("hidden");
  $("#um-folder").classList.add("hidden");
  $("#update-modal").classList.remove("hidden");
}

async function checkAppUpdate() {
  const r = await window.g4.checkUpdate();
  updateInfo = r;
  const sub = $("#update-sub"), btn = $("#btn-install-update");
  if (r && r.update) {
    sub.textContent = `Có bản mới v${r.version} (đang dùng v${r.current})`;
    btn.classList.remove("hidden");
    fillChangelog("changelog", "cl-notes", "cl-link", r.notes, r.url);
    $("#ub-ver").textContent = "v" + r.version;
    $("#update-banner").classList.remove("hidden");   // banner nhắc (sau khi đóng modal)
    openUpdateModal();                                 // modal giữa màn hình lúc mở app
  } else {
    sub.textContent = `Đã là bản mới nhất (v${(r && r.current) || ""})`;
    btn.classList.add("hidden");
    fillChangelog("changelog", "cl-notes", "cl-link", null, null);
  }
}

// Tải bản mới -> thanh % trong modal. KHÔNG cho đóng khi đang tải.
async function doInstallUpdate() {
  if (!updateInfo || !updateInfo.url) { setStatus("Không có link tải"); return; }
  const ib = $("#um-install");
  ib.disabled = true;
  $("#um-prog").classList.remove("hidden");
  $("#um-prog").classList.remove("done");
  $("#um-folder").classList.add("hidden");
  $("#um-fill").style.width = "0%"; $("#um-pct").textContent = "0%";
  $("#um-text").textContent = "Đang chuẩn bị tải...";
  const r = await window.g4.installUpdate(updateInfo.url);
  ib.disabled = false;
  if (r && r.ok) {
    $("#um-fill").style.width = "100%"; $("#um-pct").textContent = "100%";
    $("#um-text").textContent = "✓ Đã tải về folder 'update' — mở file đó để cài";
    $("#um-prog").classList.add("done");   // căn giữa khi xong (100%)
    $("#um-folder").classList.remove("hidden");
    window.g4.openUpdateFolder();
  } else {
    $("#um-prog").classList.add("hidden");
    setStatus("✗ " + ((r && r.message) || "Lỗi tải bản mới"));
  }
}
const _mb = (n) => (n / 1048576).toFixed(1);   // byte -> MB

$("#um-install").onclick = doInstallUpdate;
$("#um-folder").onclick = (e) => { e.preventDefault(); window.g4.openUpdateFolder(); };
// Bắt buộc cập nhật: không có nút đóng / "Để sau", bấm nền cũng không đóng.

// Cập nhật thanh % + kích thước file (MB) khi tải.
if (window.g4.onUpdateProgress) window.g4.onUpdateProgress((d) => {
  if (!d) return;
  if (d.stage === "download") {
    const p = d.pct >= 0 ? d.pct : 0;
    $("#um-fill").style.width = p + "%";
    $("#um-pct").textContent = p + "%";
    $("#um-text").textContent = d.total
      ? `Đang tải bản mới  ${_mb(d.received)} / ${_mb(d.total)} MB`
      : `Đang tải bản mới  ${_mb(d.received || 0)} MB...`;
  } else if (d.stage === "done") {
    $("#um-fill").style.width = "100%"; $("#um-pct").textContent = "100%";
    $("#um-prog").classList.add("done");
    $("#um-text").textContent = d.total
      ? `✓ Đã tải xong ${_mb(d.total)} MB vào folder 'update'`
      : "✓ Đã tải về folder 'update'";
  }
});

// Banner + nút trong Cài đặt đều mở modal.
$("#ub-close").onclick = () => $("#update-banner").classList.add("hidden");
$("#ub-goto").onclick = openUpdateModal;
$("#btn-install-update").onclick = openUpdateModal;

checkAppUpdate();

// ---- HOT UPDATE giao diện (renderer): tự kiểm tra + áp dụng NGAY khi mở app (không đóng app) ----
// Bundle renderer nhẹ (vài chục KB); main sẽ loadFile lại -> trang tự reload với bản mới.
(async () => {
  try {
    if (!window.g4.rendererCheckUpdate) return;
    const r = await window.g4.rendererCheckUpdate();
    if (r && r.update && r.url && r.version) {
      setStatus("Đang cập nhật giao diện...");
      await window.g4.rendererApply(r.url, r.version);   // xong -> cửa sổ tự reload sang bản mới
    }
  } catch (_) {}
})();

// ============ TAB DENUVO: quét Denuvo + fix (lấy ticket) ============
const dvGrid = $("#dv-grid");
let denuvoScanning = false;
let denuvoPrepared = false;

// Vào tab Denuvo: quét + chuẩn bị công cụ fix (tải/giải nén vào temp, 1 lần).
function loadDenuvo() {
  runDenuvoScan();
  prepareDenuvoTool();
}

async function prepareDenuvoTool() {
  if (denuvoPrepared) return;
  denuvoPrepared = true;
  setStatus("Denuvo: đang chuẩn bị công cụ fix...");
  const r = await window.denuvo.prepare();
  if (r && r.ok) setStatus("Denuvo: công cụ fix đã sẵn sàng.");
  else { denuvoPrepared = false; setStatus("Denuvo: chưa chuẩn bị được công cụ" + (r && r.msg ? " (" + r.msg + ")" : "")); }
}

// Chạy fn() song song nhưng giới hạn số request cùng lúc (tránh bị store chặn).
async function mapLimit(items, limit, fn, onEach) {
  const ret = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      ret[i] = await fn(items[i], i);
      if (onEach) onEach(ret[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return ret;
}

async function runDenuvoScan() {
  if (denuvoScanning) return;
  denuvoScanning = true;
  $("#dv-title").textContent = "Denuvo";
  dvGrid.innerHTML = '<div class="lib-empty">Đang đọc danh sách game đã thêm (mọi file .lua)...</div>';
  const appids = await window.denuvo.installed();   // gom appid từ MỌI file .lua trong stplug-in
  if (!Array.isArray(appids) || !appids.length) {
    denuvoScanning = false;
    $("#dv-title").textContent = "Denuvo (0)";
    dvGrid.innerHTML = '<div class="lib-empty">Chưa có game nào trong config/stplug-in.</div>';
    return;
  }
  // Lọc bỏ DLC -> chỉ quét game chính (main.js dùng appdetails để loại DLC con).
  $("#dv-title").textContent = "Denuvo — đang lọc DLC...";
  dvGrid.innerHTML = '<div class="lib-empty">Đang lọc DLC (chỉ giữ game chính)...</div>';
  let mains = [];
  try { mains = await window.denuvo.gamesOnly(appids); } catch (e) {}
  if (!Array.isArray(mains) || !mains.length) mains = appids;   // lọc lỗi -> quét hết
  const dlcCut = appids.length - mains.length;
  dvGrid.innerHTML = "";
  let done = 0, denuvoCount = 0, errCount = 0, lastErr = "";
  // Concurrency thấp (3) để tránh Steam chặn (403/429) khi quét nhiều game.
  let scanAborted = false;
  await mapLimit(mains, 3, (aid) => scanAborted ? { ok: false, error: "skip" } : window.denuvo.check(aid), (res) => {
    done++;
    if (res && res.ok) {
      // CHỈ lấy game Denuvo, bỏ game sạch + DRM khác để nhẹ & gọn.
      if (res.denuvo) { denuvoCount++; dvGrid.appendChild(denuvoCard(res)); }
    } else if (!res || res.error !== "skip") {
      errCount++; lastErr = (res && res.error) || "lỗi";
      // Steam chặn liên tục + chưa thấy game Denuvo nào -> dừng sớm (tránh quét cả trăm game vô ích).
      if (!scanAborted && denuvoCount === 0 && errCount >= 15 && /403|429|denied|age_gate|timeout|NAME_NOT_RESOLVED|DoH/i.test(lastErr)) scanAborted = true;
    }
    $("#dv-title").textContent = scanAborted
      ? `Denuvo — Steam đang chặn, dừng quét (${done}/${mains.length})`
      : `Denuvo — đang quét ${done}/${mains.length}`;
  });
  denuvoScanning = false;
  $("#dv-title").textContent = `Denuvo (${denuvoCount})${errCount ? ` — ${errCount} lỗi` : ""}`;
  if (errCount) {
    const blocked = /403|429|denied|age_gate|timeout|NAME_NOT_RESOLVED|DoH/i.test(lastErr);
    setStatus(`Denuvo: ${errCount}/${mains.length} game không kiểm tra được${blocked ? " — không truy cập được store Steam (mạng/DNS) — thử lại sau vài phút" : ` (${lastErr})`}`);
  }
  if (!dvGrid.children.length) {
    dvGrid.innerHTML = errCount
      ? `<div class="lib-empty">Không kiểm tra được ${errCount} game (${lastErr}).<br>Không vào được store Steam — mạng nhà mạng có thể đang chặn cả DNS-over-HTTPS.<br>Bấm "Quét lại" sau vài phút.</div>`
      : `<div class="lib-empty">Không có game Denuvo trong thư viện${dlcCut ? ` (đã bỏ qua ${dlcCut} DLC)` : ""}.</div>`;
  }
}

function denuvoCard(res) {
  const appid = (res && res.appid) || "?";
  const el = document.createElement("div");
  el.className = "gcard dv-card is-denuvo";
  el.dataset.appid = String(appid);
  el.title = (res && res.drm) || "Denuvo Anti-tamper";
  const cover = document.createElement("div"); cover.className = "gcover";
  const ph = document.createElement("span"); ph.className = "gph"; ph.textContent = "🎮";
  cover.appendChild(ph); cover.appendChild(makeImg(appid, COVER_KINDS));
  const badge = document.createElement("span"); badge.className = "dv-badge denuvo"; badge.textContent = "Denuvo";
  cover.appendChild(badge);
  const h = document.createElement("div"); h.className = "gname";
  h.textContent = (res && res.name) || ("App " + appid);
  const sub = document.createElement("div"); sub.className = "gsub"; sub.textContent = "appid " + appid;
  el.append(cover, h, sub);
  if (/^\d+$/.test(String(appid)))
    el.onclick = () => denuvoRunFlow(appid, (res && res.name) || `App ${appid}`);
  return el;
}

// ---- Nút "Quét lại" + modal "Fix Denuvo thủ công" ----
$("#dv-scan").onclick = () => runDenuvoScan();

const denuvoModal = $("#denuvo-modal");
let denuvoManualAppid = null;

function openDenuvoModal() {
  $("#denuvo-result").className = "dv-result"; $("#denuvo-result").textContent = "";
  $("#denuvo-fix-btn").disabled = true;
  denuvoManualAppid = null;
  denuvoModal.classList.remove("hidden");
  $("#denuvo-appid").focus();
}
function closeDenuvoModal() { denuvoModal.classList.add("hidden"); }

function setDenuvoResult(label, color, detail) {
  const out = $("#denuvo-result");
  out.className = "dv-result";
  out.innerHTML = `<b></b><div class="dv-result-sub"></div>`;
  const b = out.querySelector("b");
  b.textContent = label; b.style.color = color;
  out.querySelector(".dv-result-sub").textContent = detail || "";
}

$("#dv-fix-manual").onclick = openDenuvoModal;
$("#denuvo-modal-cancel").onclick = closeDenuvoModal;

$("#denuvo-check-btn").onclick = async () => {
  const appid = ($("#denuvo-appid").value || "").trim();
  if (!/^\d+$/.test(appid)) {
    setDenuvoResult("AppID phải là số", "#ff6b5e", "VD: 1245620");
    $("#denuvo-fix-btn").disabled = true;
    return;
  }
  const out = $("#denuvo-result");
  out.className = "dv-result"; out.textContent = "Đang kiểm tra trên store...";
  $("#denuvo-fix-btn").disabled = true;
  const res = await window.denuvo.check(appid);
  if (!res || !res.ok) {
    setDenuvoResult("Không kiểm tra được", "#ff6b5e", (res && res.error) || "không rõ");
    return;
  }
  denuvoManualAppid = appid;
  const nm = res.name ? `${res.name} (${appid})` : `App ${appid}`;
  if (res.denuvo) setDenuvoResult(`CÓ Denuvo — ${nm}`, "#ff6b5e", res.drm || "Denuvo Anti-tamper");
  else if (res.hasNotice) setDenuvoResult(`DRM bên thứ ba — ${nm}`, "#e8b007", res.drm);
  else setDenuvoResult(`Không thấy Denuvo/DRM — ${nm}`, "#36c275", "Không có DRM_notice trên store");
  $("#denuvo-fix-btn").disabled = false;   // cho phép fix thủ công dù kết quả
};

$("#denuvo-fix-btn").onclick = () => {
  const appid = denuvoManualAppid || ($("#denuvo-appid").value || "").trim();
  if (!/^\d+$/.test(appid)) return;
  closeDenuvoModal();
  denuvoRunFlow(appid, `App ${appid}`);
};

// ---- Terminal trong app + luồng fix Denuvo ----
const dvTermModal = $("#denuvo-term-modal");
const dvTermLog = $("#dvterm-log");
let dvTermWired = false;

function dvTermOpen(title) {
  $("#dvterm-title").textContent = title || "tiến trình";
  dvTermLog.innerHTML = "";
  dvTermModal.classList.remove("hidden");
  if (!dvTermWired) {
    dvTermWired = true;
    $("#dvterm-done").onclick = () => dvTermModal.classList.add("hidden");
    if (window.denuvo && window.denuvo.onLog) window.denuvo.onLog(dvTermLine);
  }
}
function dvTermLine(line) {
  const div = document.createElement("div");
  const low = String(line).toLowerCase();
  const cls = /loi|that bai|\[err\]|null|no ticket|khong /.test(low) ? " err"
            : /hoan tat|da ghi|san sang| ok$|da dang nhap/.test(low) ? " ok" : "";
  div.className = "ln" + cls;
  div.textContent = line;
  dvTermLog.appendChild(div);
  dvTermLog.scrollTop = dvTermLog.scrollHeight;
}

let denuvoRunning = false;
async function denuvoRunFlow(appid, name) {
  appid = String(appid);
  if (!/^\d+$/.test(appid)) return;
  if (denuvoRunning) { dvTermModal.classList.remove("hidden"); return; }
  denuvoRunning = true;
  dvTermOpen(`${name} (${appid})`);
  dvTermLine(`=== Bắt đầu fix Denuvo cho appid ${appid} ===`);
  let r;
  try { r = await window.denuvo.run(appid, name); }
  catch (e) { r = { ok: false, msg: String(e) }; }
  if (r && r.ok) {
    dvTermLine("=== THÀNH CÔNG (ticket có hiệu lực 30 phút) ===");
    denuvoDismissedToasts.delete(String(appid));
    const old = denuvoToastState.get(String(appid));
    if (old) { old.el.remove(); denuvoToastState.delete(String(appid)); }
    refreshDenuvoToasts();
  } else dvTermLine(`=== THẤT BẠI: ${(r && r.msg) || "không rõ"} ===`);
  denuvoRunning = false;
}

// ---- Popup góc phải: đếm ngược thời gian còn lại của ticket Denuvo (TTL 30 phút) ----
const denuvoDismissedToasts = new Set();
const denuvoToastState = new Map();

// Trạng thái toast HẾT HẠN đã thông báo (lưu localStorage) -> không nhắc mãi mỗi lần mở app.
//   key = "appid:created"; { opens: số lần mở app đã thấy hết hạn, done: đã ẩn vĩnh viễn }
//   - Lần mở #1 thấy hết hạn -> hiện thông báo 1 lần (nhắc add lại).
//   - Lần mở #2 trở đi        -> hiện + đếm ngược 30 phút rồi tự xóa, đánh dấu done.
//   - done = true             -> không bao giờ hiện lại (fix mới -> created mới -> key mới -> nhắc lại).
const DENUVO_EXP_KEY = "g4_denuvo_expired_state";
let denuvoExpState = {};
try { denuvoExpState = JSON.parse(localStorage.getItem(DENUVO_EXP_KEY) || "{}") || {}; } catch (_) {}
function saveDenuvoExpState() { try { localStorage.setItem(DENUVO_EXP_KEY, JSON.stringify(denuvoExpState)); } catch (_) {} }
const denuvoExpCounted = new Set();    // key đã tăng 'opens' trong phiên này (1 lần/phiên)
const denuvoExpDestruct = new Set();   // key đã hẹn xóa 30 phút

// Quyết định cho 1 ticket HẾT HẠN: "hide" | "show" | "destruct".
function denuvoExpiredPolicy(appid, created) {
  const key = appid + ":" + created;
  const st = denuvoExpState[key] || { opens: 0, done: false };
  denuvoExpState[key] = st;
  if (st.done) return "hide";
  if (!denuvoExpCounted.has(key)) {
    denuvoExpCounted.add(key);
    st.opens = (st.opens || 0) + 1;
    saveDenuvoExpState();
  }
  return st.opens >= 2 ? "destruct" : "show";
}
// Lần mở #2 trở đi: hẹn 30 phút rồi xóa toast + đánh dấu done (không hiện lại nữa).
function denuvoScheduleDestruct(appid, created) {
  const key = appid + ":" + created;
  if (denuvoExpDestruct.has(key)) return;
  denuvoExpDestruct.add(key);
  setTimeout(() => {
    const st = denuvoToastState.get(String(appid));
    if (st) { st.el.remove(); denuvoToastState.delete(String(appid)); }
    (denuvoExpState[key] = denuvoExpState[key] || {}).done = true;
    saveDenuvoExpState();
  }, 30 * 60 * 1000);
}

function dvFmtRemain(ms) {
  if (ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function updateDenuvoToast(appid) {
  const st = denuvoToastState.get(appid);
  if (!st) return;
  const nm = st.name || ("App " + appid);
  const remain = st.expireAt - Date.now();
  if (remain <= 0) {
    st.el.classList.add("expired");
    st.el.querySelector(".tt").textContent = "Denuvo hết hiệu lực";
    st.el.querySelector(".d").textContent = `Denuvo của ${nm} đã hết hiệu lực, vui lòng add lại.`;
  } else {
    st.el.classList.remove("expired");
    st.el.querySelector(".tt").textContent = "Denuvo còn hiệu lực";
    st.el.querySelector(".d").textContent = `${nm}: còn ${dvFmtRemain(remain)} trước khi hết hạn.`;
  }
}

function ensureDenuvoToast(appid, name, expireAt) {
  appid = String(appid);
  if (denuvoDismissedToasts.has(appid)) return;
  let st = denuvoToastState.get(appid);
  if (!st) {
    const wrap = $("#denuvo-toasts");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "dv-toast";
    el.dataset.appid = appid;
    el.innerHTML = `<span class="x">&times;</span>
      <div class="t"><span class="tt"></span></div>
      <div class="d"></div>`;
    el.querySelector(".x").onclick = (e) => {
      e.stopPropagation(); denuvoDismissedToasts.add(appid);
      el.remove(); denuvoToastState.delete(appid);
    };
    el.onclick = () => {   // bấm vào -> mở tab Denuvo để add lại
      document.querySelector('.tab[data-tab="denuvo"]').click();
    };
    wrap.appendChild(el);
    st = { el, name, expireAt };
    denuvoToastState.set(appid, st);
  } else { st.name = name; st.expireAt = expireAt; }
  updateDenuvoToast(appid);
}

async function refreshDenuvoToasts() {
  if (!window.denuvo || !window.denuvo.expiry) return;
  let entries;
  try { entries = await window.denuvo.expiry(); } catch (e) { return; }
  if (!Array.isArray(entries)) return;
  const seen = new Set();
  for (const en of entries) {
    const appid = String(en.appid);
    const expired = (en.expireAt - Date.now()) <= 0;
    if (expired) {
      const pol = denuvoExpiredPolicy(appid, en.created);
      if (pol === "hide") {   // đã thông báo đủ -> gỡ nếu đang hiện, không hiện lại
        const st = denuvoToastState.get(appid);
        if (st) { st.el.remove(); denuvoToastState.delete(appid); }
        continue;
      }
      seen.add(appid);
      ensureDenuvoToast(appid, en.name, en.expireAt);
      if (pol === "destruct") denuvoScheduleDestruct(appid, en.created);
    } else {
      seen.add(appid);
      ensureDenuvoToast(appid, en.name, en.expireAt);
    }
  }
  for (const [appid, st] of denuvoToastState) {
    if (!seen.has(appid)) { st.el.remove(); denuvoToastState.delete(appid); }
  }
}

setInterval(() => { for (const appid of denuvoToastState.keys()) updateDenuvoToast(appid); }, 1000);
refreshDenuvoToasts();
setInterval(refreshDenuvoToasts, 60000);


// Tab Denuvo la tab MAC DINH cua ban nay -> quet + chuan bi cong cu fix ngay khi mo app.
loadDenuvo();
