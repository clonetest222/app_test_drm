# RE "kernel" CaigamerUnlockerQ — và cách tối ưu only_denuvo cho hợp xinput1_4.dll

> Viết cho: chính bạn (dev only_denuvo) — tài liệu tham chiếu khi code.
> Nguồn: dịch ngược (REA + phân tích tĩnh) bản CaigamerUnlockerQ đã cài trên máy này,
> ngày 2026-10-30. Mọi RVA/sig/URL dưới đây là *quan sát được*, không phải mã nguồn gốc.

## 0. TL;DR

- CaigamerUnlockerQ là app **Python 3.14 + PySide6, đóng gói bằng Nuitka** (compile ra native,
  không có bytecode để decompile; chuỗi literal thì giữ nguyên nên đọc được kiến trúc).
- "Kernel" **không phải** kernel OS. Nó là **gói native tải từ xa** (`kernel.zip`) gồm
  `dwmapi.dll` (proxy) + `CaigamerQ.dll` (lõi) + bộ `*.toml` (pattern/ipc theo từng phiên bản
  `steamclient64.dll`). Lõi dùng **Microsoft Detours** hook thẳng steamclient trong RAM.
- Cùng mục tiêu như **SteamTools/xinput1_4.dll** của bạn (giả sở hữu + nạp ticket Denuvo),
  nhưng CaigamerQ tự viết toàn bộ, còn bạn ghép SteamTools (bên thứ 3) + bộ trích ticket.
- Điểm bạn tối ưu được **mà vẫn giữ nguyên xinput1_4.dll**: thay cả `steam.exe -login` +
  `extract_tickets.exe` bằng **lấy ticket in-process qua Steam CM** (`steam-user` của Node),
  rồi ghi đúng `denuvo_g4play.lua` như hiện tại. Nhanh hơn, không phá phiên Steam của user,
  xử lý được Steam Guard, bỏ được 1 .exe đi kèm.

---

## 1. Đóng gói & nhận dạng

| Hạng mục | Quan sát |
|---|---|
| Vỏ exe | `CaigamerUnlockerQ.exe` 96 MB, PE x64, SHA-256 `6995ca19…`. **Nuitka standalone** (chuỗi `Nuitka`, `__compiled__`, `onefile`). KHÔNG phải PyInstaller (không có cookie PYZ). |
| Runtime | Python 3.13/3.14, PySide6 (Qt6), gevent, pycryptodome, cryptography, numpy/scipy. |
| Module .py (Nuitka giữ tên) | `settings_interface.py`, `download_utils.py`, `dll_utils.py`, `denuvo_games_interface.py`, `manage_games_interface.py`, `card_activation_interface.py`. |
| Ngôn ngữ log/UI | Tiếng Trung ("内核"=kernel, "下载"=tải, "解压"=giải nén, "D加密"=Denuvo). |
| Ký số | Certum EV (cevcsca2021). |

Lấy source Python thì vô ích (đã compile sang C). Tất cả giá trị ở dưới lấy từ **chuỗi literal
còn nguyên trong exe** + **file kernel đã tải về đĩa** + **app.log**.

---

## 2. "Kernel" là gì — vòng đời

Từ `app.log` (`C:\Program Files (x86)\Steam\config\CaigamerUnlockerQ\app.log`):

```
[kernel.zip 强制更新 (直链1/3)] 开始下载:
  https://1825581727.cdn.123clouddisk.com/1825581727/CaigamerUnlockerQ/1025/kernel.zip
  -> C:\Program Files (x86)\Steam\config\CaigamerUnlockerQ\kernel.zip
  status=200, content_length=3504277, content_type=application/zip
[DLL] kernel.zip 已解压到缓存目录
[DLL] 内核文件已部署到 Steam 目录
[内核] 已保存选中的内核ID: CaigamerQ
[内核] 已保存内核 CaigamerQ 版本: 26102501
```

- **CDN**: 123clouddisk (netđĩa TQ), có **3 direct link dự phòng** (`直链1/3`). Thêm host CDN ảnh
  `shared.cdn.queniuqe.com` (+ `*.steamstatic.com`) cho ảnh game.
- **Phiên bản kernel**: chuỗi ngày `26102501` (2026-10-25 build 01). Check qua API
  `/api/version_info/kernel_notify_config`, `/api/cw_version_info/latest`.
- **Cache + deploy**: tải `kernel.zip` về `Steam\config\CaigamerUnlockerQ\`, giải nén, rồi
  **copy file vào thư mục Steam** (DLL-hijack point). `ensure_dwmapi_dll` đảm bảo proxy có mặt.
- Hàm liên quan (tên trong exe): `get_kernel_list`, `get_kernel_download_url`,
  `get_kernel_filename`, `all_kernels_exist`, `get_local_kernel_versions`, `do_kernel_auto_init`.

### Cây file kernel đã tải (trên máy này)

```
C:\Program Files (x86)\Steam\CaigamerQ.dll                 ← lõi, copy ra root Steam (điểm nạp)
C:\Program Files (x86)\Steam\config\CaigamerUnlockerQ\
├─ bin\dwmapi.dll             (126 KB)  proxy DLL-hijack
├─ CaigamerQ.dll              (3.2 MB)  lõi (Detours, packed)
├─ CaigamerQ.EosBridge.dll    (67 KB)   .NET, Epic Online Services (game EOS/Ubisoft)
├─ CaigamerQ\
│  ├─ pattern\steamclient\<sha256 của steamclient64.dll>.toml   (~22 bản)
│  ├─ pattern\steamui\<hash>.toml
│  └─ ipc\steamclient\<hash>.toml
└─ app.log
```

---

## 3. Cơ chế lõi (CaigamerQ.dll) — RE thật kĩ

### 3.1 Nạp (injection) — so với xinput1_4.dll của bạn

`bin\dwmapi.dll` (SHA-256 `127e5980…`, 609 proc, 366 chuỗi) là **proxy DLL-hijack**. Chuỗi
quan sát: `CaigamerQ.dll`, `steam.exe`, `\dwmapi.dll`, `mscoree.dll`, `LoadLibraryA/W/ExW`.
Luồng: Steam nạp `dwmapi.dll` từ thư mục của nó → proxy forward sang dwmapi hệ thống (để DWM
vẫn chạy) → kiểm tra đang trong `steam.exe` → `LoadLibrary("CaigamerQ.dll")`.

→ **Giống hệt kỹ thuật xinput1_4.dll của SteamTools**, chỉ khác tên DLL bị hijack
(`dwmapi.dll` vs `xinput1_4.dll` — cả hai đều là DLL Steam nạp sẵn). **Không cần đổi gì ở đây.**

### 3.2 Lõi CaigamerQ.dll (SHA-256 `efe30211…`)

- 6567 proc, **chỉ 20 chuỗi plaintext** → **chuỗi bị mã hoá/giải mã lúc chạy**.
- Section `.=El`, `.q9"`, `.>]"` tên ngẫu nhiên, entropy cao (1.7 MB + 3.2 MB) → **bị pack/bảo vệ
  (kiểu VMProtect)**. Decompile sâu tốn kém và không ra source sạch → không cần: cơ chế đã lộ
  đủ qua các file `.toml` + tên hàm hook.
- Section **`.detourc` / `.detourd`** → dùng **Microsoft Detours** để đặt hook.

### 3.3 Định vị hàm theo phiên bản — `pattern\steamclient\<hash>.toml`

File do `tools/resolve_patterns.py` sinh. Mỗi file ứng với **một bản `steamclient64.dll`**
(tên = sha256 của bản đó) → **bền với update Steam**: Steam đổi bản nào thì đã có sẵn pattern bản đó.

```toml
[layout]
package_info_offset = "0x1300"
netpacket_cubdata = "0x18"
netpacket_pubdata = "0x10"

[0x4B1B1D77]
name = "CheckAppOwnership"
rva  = "0x9DE130"
sig  = "48 8B C4 89 50 10 48 89 48 08 55 53 48 8D 68 D8 48 81 EC 18 01 00 00 48"
```

Danh sách hàm bị hook (toàn bộ trong 1 bản toml):

| Nhóm | Hàm | Mục đích |
|---|---|---|
| Sở hữu | `CheckAppOwnership`, `OptedInMask` | Báo "đã sở hữu" mọi appid mục tiêu |
| License/Package | `GetPackageInfo`, `GetOrAddAppData`, `GetAppDataFromAppInfo`, `LoadPackage`, `MarkLicenseAsChanged`, `ProcessPendingLicenseUpdates` | Chèn license/package giả vào bộ nhớ Steam |
| Depot | `LoadDepotDecryptionKey` | Cấp depot key để tải/giải mã file game |
| Launch | `BuildSpawnEnvBlock`, `SpawnProcess`, `BBuildAndAsyncSendFrame`, `BuildDepotDependency` | **Nhét ticket Denuvo vào tiến trình game lúc khởi chạy** |
| IPC/KV | `IPCProcessMessage`, `RecvPkt`, `SendCallbackToPipe`, `KeyValues_FindOrCreateKey`, `KeyValues_ReadAsBinary`, `ConfigStoreGetBinary` | Chặn IPC + đọc/ghi config Steam |

`BuildSpawnEnvBlock` + `CheckAppOwnership` là 2 hook then chốt cho Denuvo: game nhận được
app-ownership ticket hợp lệ của **tài khoản mượn** ngay lúc spawn → Denuvo chịu.

### 3.4 Lấy ticket in-process — `ipc\steamclient\<hash>.toml`

Thay vì `steam.exe -login` + trích ngoài, lõi gọi **chính vtable của Steam** trong process:

```toml
[IClientUser]                           # interface_id=1, vtable_rva=0x1327FC8
[IClientUser.GetAppOwnershipTicketExtendedData]  method_index=105
[IClientUser.RequestEncryptedAppTicket]          method_index=120
[IClientUser.GetEncryptedAppTicket]              method_index=121
[IClientUtils.GetAppID]                          method_index=19
```

→ Lõi **tự xin encrypted app ticket + ownership ticket qua IClientUser** bên trong Steam đang
chạy (đã đăng nhập tài khoản mượn), không cần công cụ ngoài. Đây đúng là
`setAppTicket`/`setETicket` mà bạn đang ghi ra lua.

### 3.5 EosBridge.dll

PE .NET nhỏ (67 KB), có chuỗi `EOS_` → cầu nối **Epic Online Services** cho game Denuvo bọc EOS
(nhiều game Ubisoft). only_denuvo hiện chưa đụng mảng này (tương ứng `/api/denuvo/ubisoft/*`).

---

## 4. Backend & xác thực CaigamerUnlockerQ (để đối chiếu)

- **Ký request** (giống only_denuvo): header `X-API-Key`, `X-Timestamp`, `X-Nonce`, `X-Signature`
  + `device_id` → HMAC theo thiết bị. → **Design auth của bạn đã ngang chuẩn, không cần sửa.**
- **Denuvo auth BẤT ĐỒNG BỘ**:
  `/api/denuvo/auth/request` → `/api/denuvo/auth/status` (poll) → `/api/denuvo/auth/confirm`
  (hoặc `/cancel`); kèm `/api/denuvo/permissions`. Có `_auth_challenge_count`,
  `_on_auth_data_received` → **xử lý Steam Guard/2FA**.
- **Bản Ubisoft**: `/api/denuvo/ubisoft-auth`, `/api/denuvo/ubisoft/request`.
- **Cấp phép theo thẻ, gắn thiết bị**: `/api/card_codes/{activate,verify,verify_and_use_quota,
  bind_device,unbind_device,use_quota,unlock_appids,increase_activation_count,check_lock_version}`
  → key gắn máy + **hạn ngạch kích hoạt**. (so sánh: only_denuvo mới có device + lease + rate-limit).
- **Logic nhạy cảm nằm trong kernel tải về** (`SecureAPIClient.bin`, `CardActivationInterface.bin`
  …), nên domain backend thật **không có trong exe** — xoay server/endpoint/key không cần phát hành
  lại exe. Đây là chiêu bảo vệ + kill-switch.

---

## 5. So sánh & ĐỀ XUẤT tối ưu only_denuvo (giữ nguyên xinput1_4.dll)

| Khâu | CaigamerUnlockerQ | only_denuvo hiện tại | Hành động |
|---|---|---|---|
| Nạp vào Steam | dwmapi.dll → CaigamerQ.dll (Detours, tự viết) | SteamTools / **xinput1_4.dll** (bên thứ 3) | **Giữ nguyên** |
| Giả sở hữu + inject ticket | CaigamerQ.dll hook steamclient | SteamTools đọc lua `setAppTicket/setETicket` | **Giữ nguyên** (vẫn nuôi bằng lua) |
| Lấy ticket | in-process qua `IClientUser` | `steam.exe -login` + `extract_tickets.exe` | **① Thay bằng `steam-user` (Node) in-process** |
| Server giữ mật khẩu | server-side, app không thấy pass | app vẫn cầm pass để login | **② Backend tự lấy ticket (phase-2 mode:ticket)** |
| Luồng auth | async request/status/confirm + Steam Guard | 1 POST đồng bộ trả lease | **③ Thêm async + nhánh Steam Guard** |
| Cấp phép | thẻ + quota gắn thiết bị | device + lease + rate-limit | **④ Thêm quota/activation-count** |
| Cập nhật file nạp | kernel.zip versioned, 3 mirror, hash theo bản steamclient | `denuvo_renderer` hot-update (renderer thôi) | **⑤ Hot-update cho bộ DLL/lua + nhiều mirror** |

### ① Lấy ticket in-process bằng `steam-user` — ƯU TIÊN 1 (hợp xinput1_4.dll nhất)

Thư viện Node `steam-user` (DoctorMcKay) ánh xạ đúng việc CaigamerQ làm qua `IClientUser`:

- `logOn({accountName, password, twoFactorCode / authCode})` → đăng nhập Steam CM in-process.
- `getAppOwnershipTicket(appid, cb)` → raw ownership ticket → hex cho **`setAppTicket`**.
- `getEncryptedAppTicket(appid, userData, cb)` → encrypted ticket → hex cho **`setETicket`**.
- Rồi ghi `denuvo_g4play.lua` **y như bây giờ** vào `config\stplug-in` + `config\lua`.

Lợi ích: không chạm phiên Steam của user, không cần Steam đang mở, nhanh hơn nhiều, bỏ được
`extract_tickets.exe`, và bắt được Steam Guard sạch sẽ (callback `steamGuard`).

Kết nối ③: khi `logOn` báo cần Guard → trả client trạng thái "need_guard" (async), nhận mã rồi
tiếp tục — đúng mô hình `/auth/request → status → confirm` của CaigamerQ.

### ② Phase-2 mode:ticket (đã chừa sẵn trong `backend/src/routes/denuvo.ts`)

Chạy `steam-user` **trên backend** (không phải Deno Deploy — xem lưu ý) → trả thẳng
`{ mode:"ticket", appticket, eticket }` trong phong bì mã hoá; app chỉ ghi lua, **không bao giờ
thấy mật khẩu**. ⚠️ `steam-user` cần TCP/UDP tới Steam CM → **không chạy được trên Deno Deploy**
(edge, không mở socket tuỳ ý). Phương án: tách 1 **ticket-worker** (VPS/Node riêng, hoặc máy
chủ nhà) mà backend Deno gọi nội bộ; Deno vẫn làm auth/quota/audit.

### ④ Quota gắn thiết bị

Thêm vào KV: `activationCount` theo `device_id`, trần theo thẻ (như `increase_activation_count`
+ `check_lock_version`). only_denuvo đã có `getAcctState`/`setAcctState` + rate-limit → mở rộng
sang per-device license là nhỏ.

### ⑤ Hot-update bộ nạp + nhiều mirror

Học `kernel.zip`: version hoá bộ `xinput1_4.dll`/SteamTools + lua-helper, tải có **nhiều mirror
dự phòng** và **so hash theo bản steamclient64.dll** trước khi deploy. g4_tool đã có
`download_requirement.updated_at`; only_denuvo nên có bảng tương tự cho bộ nạp Denuvo.

---

## 6. Việc KHÔNG nên làm

- **Đừng** thay xinput1_4.dll/SteamTools bằng CaigamerQ.dll: nó bị pack (VMProtect) + là bộ hook
  Detours tự viết cho steamclient — chép lại = dự án native lớn, dễ vỡ mỗi lần Steam update, và
  không "hợp xinput1_4.dll hiện tại" như yêu cầu.
- **Đừng** nhúng endpoint/secret thật vào app phát hành (CaigamerQ giấu trong kernel tải về là có
  lý do). only_denuvo đã đi đúng hướng: credential ra sau backend đã ký.

## 7. Thứ tự triển khai đề xuất

1. ① `steam-user` in-process (thay `steam.exe -login` + `extract_tickets.exe`) — thắng lớn, rủi ro thấp.
2. ③ nhánh Steam Guard trong luồng ① (nếu account có Guard).
3. ④ quota gắn thiết bị (nhỏ, trong KV).
4. ② phase-2 mode:ticket (cần ticket-worker riêng — hạ tầng).
5. ⑤ hot-update bộ nạp + mirror.
6. tạo lại 1 file dll mới và phù hợp hơn với bản
