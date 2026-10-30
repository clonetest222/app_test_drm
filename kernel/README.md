# g4market kernel (native) — proxy dwmapi.dll + hook steamclient, ăn `.CWK`

Kernel riêng cho g4market, cùng kỹ thuật với CaigamerQ: một `dwmapi.dll` giả được Steam
nạp vào `steam.exe`, hook `steamclient64.dll` để báo "đã sở hữu" và nạp **ticket thật**
(do only_denuvo dump ra, đóng gói trong file `.CWK`).

> **Nguồn ticket vẫn là only_denuvo** (dump bằng `extract_tickets` từ account thật) — kernel
> KHÔNG tự mint. Kernel chỉ là **kênh nạp** thứ 3 (cạnh registry + lua).

## Thành phần

```
kernel/
├─ src/
│  ├─ dllmain.cpp         proxy dwmapi + bootstrap thread
│  ├─ dwmapi_forwards.h   (tự sinh) forward Dwm* -> System32\dwmapi that
│  ├─ resolver.hpp        tìm steamclient64.dll -> sha256 -> nạp toml -> resolve RVA/sig/vtable
│  ├─ hooks.cpp/.hpp      MinHook: hook CheckAppOwnership + điểm nạp ticket
│  ├─ cwk.hpp             đọc ticket từ .CWK (AES-256-GCM) VÀ denuvo_g4play.lua — cùng 1 parser lua
│  ├─ crypto.hpp          SHA-256 + AES-GCM (BCrypt, không phụ thuộc ngoài)
│  └─ toml.hpp            parser toml tối giản cho format steam-monitor
├─ data/pattern/<hash>.toml   RVA+sig theo bản steamclient  (sync từ steam-monitor)
├─ data/ipc/<hash>.toml       vtable IPC theo bản steamclient
├─ tools/sync_steam_monitor.ps1   tải toml đúng bản steamclient trên máy
└─ CMakeLists.txt
```

Dữ liệu pattern/ipc lấy từ repo **kasakigaming/steam-monitor** (nhánh `pattern`, `ipc`) — tên file
= `sha256(steamclient64.dll)`, nên luôn khớp đúng bản Steam đang chạy, bền với update.

## Build

Cần: **Visual Studio 2022** (MSVC x64) + **CMake** + mạng (lần đầu kéo MinHook).

```powershell
cd kernel
cmake -S . -B build -A x64
cmake --build build --config Release
# -> build\Release\dwmapi.dll  (và bản copy ở dist\dwmapi.dll)
```

## Triển khai (ĐÃ TEST THẬT — **1 file duy nhất**, chú ý chỗ `bin\`)

> Đo thực tế trên máy này: **`steam.exe` nạp `dwmapi.dll` từ `<Steam>\bin\`, KHÔNG phải
> `<Steam>\` gốc.** Đặt ở gốc thì không bao giờ được nạp. (Đây cũng là slot CaigamerQ dùng.)

1. `powershell -ExecutionPolicy Bypass -File tools\sync_steam_monitor.ps1`
   → nạp `data\pattern\<hash>.toml` + `data\ipc\<hash>.toml` cho steamclient hiện tại.
2. Chép **DLL + data vào `<Steam>\bin\`** (cạnh các dll của Steam):
   - `<Steam>\bin\dwmapi.dll`   ← bản build của ta (**chỉ 1 file này**)
   - `<Steam>\bin\data\`        ← pattern + ipc + **layout** (resolver đọc cạnh DLL)
3. `cwk\` + ticket lua nằm ở **Steam root** (`<Steam>\cwk`, `<Steam>\config\lua`), KHÔNG ở
   `bin` — kernel tự lấy đúng Steam root từ thư mục `steam.exe` (không theo thư mục DLL).
4. Mở Steam → đọc **`<Steam>\bin\kernel.log`** (log nằm cạnh DLL) để xem bootstrap + hook.

> **Proxy dwmapi = 1 file duy nhất (không cần `dwmreal.dll`).** Vì proxy trùng tên `dwmapi.dll`
> nên không `LoadLibrary` thẳng `System32\dwmapi.dll` được (trùng basename → err 126). Cách giải:
> lúc chạy, `DllMain` **copy `System32\dwmapi.dll` ra 1 file temp tên khác** (`%TEMP%\g4d*.tmp`)
> rồi nạp bản copy, lấy địa chỉ mọi hàm vào `g_realProcs[]`; mỗi export là 1 **thunk** (MASM,
> `dwmapi_thunks.asm` + `dwmapi_proxy.def`) `jmp` thẳng tới hàm thật → DWM của Steam chạy bình
> thường. File temp tự dọn ở lần nạp sau (quét `g4d*.tmp`). Điền `g_realProcs` ngay trong
> `DllMain` nên không có race khi host gọi `Dwm*`.

> ✅ Đã chạy thật (1 file): `host=steam.exe`, `g_realProcs` điền xong trong DllMain, resolver khớp
> sha256 steamclient, resolved 24 hàm pattern + 3 ipc + 3 layout, hook `CheckAppOwnership`/
> `SpawnProcess`/`BuildSpawnEnvBlock`/`RequestEncryptedAppTicket` xong, `[boot] xong.` — Steam
> **không crash**.
> ⚠️ Bug đã sửa khi test: (1) `log.hpp` mở `ccs=UTF-8` rồi ghi bằng hàm narrow (`fputs`) →
> `__fastfail` **0xC0000409 sập cả `steam.exe`** → đổi sang `"ab"`; (2) forwarder theo full-path
> KHÔNG resolve (Windows không hỗ trợ) → loader loại DLL → chuyển sang thunk + copy-temp như trên.

### Build
Cần **VS2022 BuildTools** (có MASM `ml64` + Ninja). `cmake -S . -B build` rồi `cmake --build build`
(trong Developer prompt / sau `vcvars64.bat`). Project bật `ASM_MASM` cho `dwmapi_thunks.asm`.

> `.CWK` do only_denuvo tạo: `main.js: dvPackCWK` ghi `<Steam>\cwk\<appid>.cwk`. Seed AES phải
> trùng: `kernel/src/crypto.hpp CWK_SEED` ⇄ `main.js CWK_SEED`.
>
> **Nội dung `.CWK` = đúng block lua** (`setAppTicket/setETicket`, giống CaigamerQ
> `batch_lua_content`) chỉ khác là đã mã hoá. Nên kernel đọc được **cả** `.cwk` lẫn file
> `denuvo_g4play.lua` tRÒN (`config\lua` + `config\stplug-in`) bằng **cùng một parser**
> (`cwk.hpp: parseTicketLua`). Bên client cũng giải mã ngược được: `main.js: dvApplyCWK`
> (đúng path "decrypt .CWK → ghi lua" của CaigamerQ) — nhờ vậy `.CWK` dùng được **ngay cả
> khi chưa có kernel native**.

## TRẠNG THÁI (đọc kỹ)

**Đã xong & kiểm chứng (trừ compile):**
- Proxy dwmapi (forwarder tới System32), bootstrap chỉ chạy trong `steam.exe`.
- Resolver: sha256 steamclient → nạp toml → RVA + verify sig + địa chỉ hàm trong vtable IPC;
  **đọc thêm `[layout]`** (offset RE điền tay) từ `data/layout/<hash>.toml` — giữ qua resync.
- `.CWK`: envelope AES-256-GCM **đã test round-trip** (khớp); plaintext giờ = block lua,
  kernel nạp ticket từ **cả `.cwk` lẫn `denuvo_g4play.lua`** (cùng parser `parseTicketLua`).
- **`CheckAppOwnership` đã hook thật** (RVA riêng + sig verify): với appid có ticket →
  **dump `CAppOwnershipInfo` ra `kernel.log` để RE offset** + ép giá trị trả về = owned
  (targeted theo appid, tắt/chỉnh qua `[layout] own_force`). Có `owns_offset` thì set hẳn field.
- **Hook quan sát** `SpawnProcess` / `BuildSpawnEnvBlock` / `RequestEncryptedAppTicket`
  (pass-through, log đúng điểm chèn ticket + đường Denuvo). `GetEncryptedAppTicket` +
  `GetAppOwnershipTicketExtendedData` **dùng chung 1 stub IPC** (target_rva trùng) → **không**
  hook thẳng (tránh bắt nhầm).
- `sync_steam_monitor.ps1` đã chạy thật: tải đúng toml cho steamclient trên máy.

**CẦN BẠN LÀM (RE trên máy thật — mình không có MSVC/Steam/game để test):**
- Build bằng MSVC, chạy, xem `kernel.log`.
- **RE `owns_offset`** (việc duy nhất còn chặn `CheckAppOwnership` ép owned *thật sự*):
  mở Steam với 1 game Denuvo đã fix → đọc dòng `[RE] CAppOwnershipInfo(appid=...) N byte đầu`
  → so với 1 game **sở hữu thật**, tìm byte đổi `00→01` → điền `owns_offset` vào
  [`data/layout/<hash>.toml`](data/layout/) (bỏ dấu `#`) → mở lại Steam. Không cần recompile.
- Phục vụ `eticket` *qua IPC* còn `// >>> CAN HOAN THIEN`: cần RE marshalling
  (`IPCProcessMessage` dispatch theo `funcHash`). **Trong lúc đó eticket vẫn được phục vụ qua
  lua `setETicket` + registry** (SteamTools/xinput đọc) nên Denuvo vẫn qua — kernel là kênh bổ trợ.
- Nạp `appticket` lúc `SpawnProcess`/`BuildSpawnEnvBlock` (hiện mới hook quan sát).

## Lưu ý

- Chạy song song với `xinput1_4.dll`/SteamTools được (khác slot hijack). Ticket vẫn vào cả
  registry + lua + .CWK → phủ mọi loader.
- `CWK_SEED` chỉ là obfuscation, **không** phải bảo mật. Bảo mật thật ở backend (HMAC + quota).
- Hook steamclient dễ vỡ khi Denuvo/Steam đổi; giữ `data/` cập nhật qua steam-monitor.
