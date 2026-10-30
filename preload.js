const { contextBridge, ipcRenderer } = require("electron");

// Ban Denuvo: chi con nut cua so + cai dat + cap nhat (khong co key / thu vien / share DLL).
contextBridge.exposeInMainWorld("g4", {
  winMin: () => ipcRenderer.send("win-min"),
  winMax: () => ipcRenderer.send("win-max"),
  winClose: () => ipcRenderer.send("win-close"),
  // Cai dat
  getSteamPath: () => ipcRenderer.invoke("steam-dir-get"),
  luaDirs: () => ipcRenderer.invoke("lua-dirs"),        // stplug-in / lua dang duoc doc
  setSteamPathManual: () => ipcRenderer.invoke("steam-dir-set-manual"),
  appVersion: () => ipcRenderer.invoke("app-version"),
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  // Cap nhat app + hot-update giao dien
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: (url) => ipcRenderer.invoke("install-update", url),
  openUpdateFolder: () => ipcRenderer.invoke("open-update-folder"),
  onUpdateProgress: (cb) => ipcRenderer.on("update-progress", (_e, d) => cb(d)),
  rendererCheckUpdate: () => ipcRenderer.invoke("renderer-check"),
  rendererApply: (url, version) => ipcRenderer.invoke("renderer-apply", { url, version }),
});

// Denuvo: quet store (Denuvo/DRM) + chuan bi cong cu fix + chay fix (login + extract_tickets).
contextBridge.exposeInMainWorld("denuvo", {
  check: (appid) => ipcRenderer.invoke("denuvo-check", appid),
  installed: () => ipcRenderer.invoke("denuvo-installed"),                 // appid tu moi file .lua
  gamesOnly: (appids) => ipcRenderer.invoke("denuvo-games-only", appids),  // loc DLC -> chi game chinh
  prepare: () => ipcRenderer.invoke("denuvo-prepare"),
  permissions: () => ipcRenderer.invoke("denuvo-permissions"),   // han ngach con lai (khi dung backend)
  run: (appid, name) => ipcRenderer.invoke("denuvo-run", { appid, name }),
  runManual: (appid, username, password, name) => ipcRenderer.invoke("denuvo-run-manual", { appid, username, password, name }),
  applyCwk: (path) => ipcRenderer.invoke("denuvo-apply-cwk", { path }),   // giai ma .CWK -> ghi lua+registry
  kernelInstall: () => ipcRenderer.invoke("denuvo-kernel-install"),       // tai + cai dwmapi.dll vao Steam\bin
  onLog: (cb) => ipcRenderer.on("denuvo-log", (_e, line) => cb(line)),
  expiry: () => ipcRenderer.invoke("denuvo-expiry"),   // ds ticket + con han/het han
  remove: (appid) => ipcRenderer.invoke("denuvo-remove", { appid }),   // xoa ticket 1 appid
  cleanExpired: () => ipcRenderer.invoke("denuvo-clean-expired"),      // don ticket het han
});
