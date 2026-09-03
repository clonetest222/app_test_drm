# Tính năng Denuvo (quét + fix ticket) — G4play Denuvo Manage

> Bản standalone: app này **chỉ có** tính năng Denuvo (+ tab Cài đặt + cập nhật).
> Khác bản trong g4_tool: đọc `.lua` ở **cả `config\stplug-in` lẫn `config\lua`**, và tab Denuvo
> là tab mặc định (mở app là quét luôn). Xem [README.md](../README.md).

Quét thư viện để phát hiện game có **Denuvo / DRM bên thứ ba**, và **fix** game Denuvo bằng cách
lấy *ownership ticket* từ một tài khoản Steam thật (sở hữu game) rồi ghi vào **`g4_tool.lua`**.

Vào bằng **tab "Denuvo"** (`data-tab="denuvo"`). Khi mở tab, `renderer.js: loadDenuvo()` chạy
`runDenuvoScan()` + `prepareDenuvoTool()`. Toàn bộ logic nặng chạy ở **main.js (Node)** — renderer
bị CSP/CORS chặn nên không tự gọi store/Supabase được. Log stream về renderer qua kênh `denuvo-log`.

## 1. Quét (phát hiện Denuvo/DRM)

Luồng trong `renderer.js: runDenuvoScan()`:

1. `window.denuvo.installed()` → gom appid từ **MỌI file `.lua`** trong **cả hai** thư mục
   `config/stplug-in` **và** `config/lua` nếu có (`main.js: denuvoInstalledAppids` + `luaDirs`),
   **loại trừ `nomore.lua`** (file cũ chỉ chứa ticket, không có `addappid`). Chỉ lấy dòng
   `addappid` **đầu mỗi block** = game chính, nên DLC/depot bị bỏ ngay từ bước này.
2. `window.denuvo.gamesOnly(appids)` → **lọc chỉ game chính** (`main.js: denuvoGamesOnly`):
   - Dùng `appdetails?filters=basic`: `type=game` → mảng **`dlc[]`** liệt kê DLC con → loại hết.
     Nếu là DLC → lấy game gốc (`fullgame`) để loại sibling.
   - Nhờ vậy nhiều appid chỉ tốn ~vài request thay vì check từng cái.
   - Lọc lỗi/không ra kết quả → fallback quét hết `appids`.
3. Mỗi game chính → `window.denuvo.check(appid)` (`main.js: denuvoCheck`), chạy **song song giới
   hạn 3** (`mapLimit`, tránh Steam chặn 403/429):
   - Tải trang store (kèm cookie qua **age-gate**), trích **mọi** `<div class="DRM_notice">` bằng
     hàm đếm div cân bằng (`dvExtractBalancedDiv` — DRM_notice có div lồng nhau).
   - Cờ `denuvo` = có "Denuvo" trong DRM_notice / `Denuvo Anti-tamper` trong trang. Kèm tên game.
4. Render **card**: chỉ hiện game **Denuvo** (bỏ game sạch + DRM khác cho gọn), badge "Denuvo",
   viền đỏ. Tiêu đề tab hiện tiến độ `Denuvo — đang quét x/n` rồi `Denuvo (số game)`.
   - Nếu có lỗi → báo ở footer, phân biệt bị Steam chặn (`403/429/timeout`) để nhắc thử lại sau.
- Nút **"🛠 Fix thủ công"** mở modal nhập appid để kiểm tra + fix tay; **"⟳ Quét lại"** quét lại.

## 2. Fix (lấy ticket Denuvo)

### 2a. Chuẩn bị công cụ — `denuvoPrepare(log)` (chạy khi vào tab, 1 lần)
1. Nếu đã có `extract_tickets.exe` trong `temp` → xong luôn (không tải lại).
2. `GET /v1/denuvo/requirement` (qua backend, đã ký) → `url`, `file_type`, `zip_rar`.
3. Tải file (`dvDownloadFile`): link Google Drive → **tự vượt cảnh báo "không quét virus được"**
   (đọc form ẩn confirm token cho file lớn).
4. Nếu `zip_rar` → giải nén vào `temp/extracted` (`dvExtractArchive`):
   - `.rar` → **7-Zip / WinRAR** (`7z.exe` / `UnRAR.exe` — cần có trên máy).
   - `.zip` → `Expand-Archive` (có sẵn Windows).
5. Tìm `extract_tickets.exe` trong `temp` (`dvFindExtractTickets`, quét đệ quy).

> `temp` = `denuvoTempDir()`: bản đóng gói → `<thư mục .exe>\temp`; dev → `<__dirname>\temp`.

### 2b. Chạy fix — `denuvoRun(appid, name)` (click 1 card Denuvo)
1. Chưa có công cụ → gọi `denuvoPrepare` trước.
2. **Xin credential từ backend Deno** — `api().denuvoTicket(appid, tried)` →
   `POST /v1/denuvo/ticket` (đã ký HMAC). Backend trả **đúng 1 account** trong phong bì
   AES-256-GCM riêng cho request đó. App **không** còn đọc bảng `denuvo_accounts`, và mật khẩu
   không hiện ra ở dạng đọc được trên đường truyền (xem [security.md](security.md)).
3. **Vòng lặp tối đa 6 lượt**, mỗi lượt xin 1 account mới (gửi kèm `exclude` = các
   `account_id` đã hỏng để backend không cấp lại), đến khi lấy được ticket:
   - `dvSteamLoginHidden(user, pass)`:
     - **Đóng hẳn Steam** (`-shutdown`, chờ `steam.exe` thoát, không thì `taskkill /F`).
       *Bắt buộc — Steam còn chạy thì `-login` bị bỏ qua.*
     - `steam.exe -silent -login <user> <pass>` (**không** ghi registry — code hiện tại đọc
       `logs/connection_log.txt` để biết login xong chưa, chạy được cả khi máy chưa từng login).
     - ⚠️ Mật khẩu nằm trên **command line** của `steam.exe` → tiến trình khác trên cùng máy đọc
       được. Steam bắt buộc như vậy; xem [security.md](security.md) §3.
   - `dvRunExtractTickets(exe, appid)` (ẩn, `windowsHide`, tự gửi Enter cho "Press Enter to exit").
   - `dvParseTickets()` đọc hex dump → `appticket` (184 byte) + `eticket` (143 byte).
     - Lỗi: `GetAppOwnershipTicketData returned no ticket...` hoặc `appticket:null / eticket:null`.
   - Được ticket → ghi file (2c) + dọn temp (2d), **dừng**. Lỗi → account tiếp theo.
4. Sau mỗi account (được hay lỗi) đều **đăng xuất** (`dvSteamLogout`, đóng hẳn Steam) **và
   báo kết quả về backend** (`POST /v1/denuvo/ticket/result`) → account login lỗi 5 lần liên
   tiếp tự bị `status='blocked'`, và audit log biết máy nào đã lấy credential nào.
5. Mọi dòng log trong vòng lặp đi qua `dvScrubLog()` — mật khẩu bị thay bằng `***` trước khi
   ra terminal trong app.
6. Nếu backend trả `mode:"ticket"` (backend tự lấy ticket, giai đoạn 2) thì app ghi thẳng file,
   **bỏ qua toàn bộ bước đăng nhập Steam** — máy người dùng không bao giờ thấy mật khẩu.

### 2c. Ghi kết quả — `dvWriteTicketFiles()`
- `tickets.txt` (trong `temp`, tạm — bị xóa ngay ở bước 2d).
- **`g4_tool.lua`** — chọn thư mục bằng `dvTicketLuaPath()`: ưu tiên thư mục (`config\stplug-in`
  hoặc `config\lua`) **đang chứa chính appid đó**, rồi tới thư mục đang có `g4_tool.lua`, cuối cùng
  mặc định `config\stplug-in`. Ghi theo **block** (ngăn cách
  `\r\n--\r\n`, cùng định dạng với block game share), ghi đè block ticket cũ cùng appid:
  ```lua
  --denuvo appid={appid} created={ms} createdAt="{yyyy-mm-dd hh:mm:ss}" name={tên}
  setAppTicket({appid}, "{hex}")
  setETicket({appid}, "{hex}")
  ```
  > Ticket dùng **chung file** `g4_tool.lua` với block game (khác app active_app dùng `nomore.lua`).
  > Block ticket không có `addappid` nên không bị tính là game khi liệt kê thư viện.
  > `created=<ms>` để tính hết hạn.

### 2d. Dọn dẹp — `dvCleanupExtracted()` (âm thầm, không log)
- Xóa `temp/tickets.txt` (đã ghi vào lua rồi).
- Trong `temp/extracted` xóa mọi thứ **trừ `extract_tickets.exe`** (bỏ folder ticket theo appid +
  file `.bin/.txt` do công cụ sinh). Giữ công cụ để lần sau không phải tải lại.

### Terminal trong app
Thay cho cửa sổ cmd: log toàn luồng stream về renderer qua kênh **`denuvo-log`**, hiện ở modal
`#denuvo-term-modal`. Dòng log tô màu theo từ khoá (lỗi = đỏ, hoàn tất/ok = xanh).

## 3. Hết hạn 30 phút + popup
- Mỗi ticket chỉ hiệu lực **30 phút** (`DENUVO_TTL_MS`).
- `window.denuvo.expiry()` → `readDenuvoEntries()` đọc `g4_tool.lua` ở **cả 2 thư mục** (`stplug-in`
  + `lua`, gộp trùng theo `appid:created`), so `now - created > 30 phút`
  (dựa giờ tạo nên tắt/mở lại app vẫn biết).
- Renderer kiểm tra lúc mở app + mỗi 60s → game hết hạn hiện **popup góc phải**:
  *"Denuvo của {tên game} đã hết hiệu lực, vui lòng add lại."* (click → mở tab Denuvo).

## 4. IPC / cầu nối (`window.denuvo` — [preload.js](../preload.js))

| Hàm | Channel | Ý nghĩa |
|-----|---------|---------|
| `check(appid)` | `denuvo-check` | DRM/Denuvo của 1 appid (đọc store) |
| `installed()` | `denuvo-installed` | gom appid từ mọi file `.lua` ở `stplug-in` + `lua` (trừ `nomore.lua`) |
| `gamesOnly(appids)` | `denuvo-games-only` | lọc DLC → chỉ game chính (qua appdetails) |
| `prepare()` | `denuvo-prepare` | tải + giải nén công cụ fix vào `temp` |
| `run(appid, name)` | `denuvo-run` | xin credential từ backend → login → lấy ticket → ghi `g4_tool.lua` |
| `expiry()` | `denuvo-expiry` | danh sách ticket + còn hạn/hết hạn |
| `onLog(cb)` | on `denuvo-log` | nhận từng dòng log (terminal trong app) |

## 5. Bảng Supabase (chỉ backend đọc — app không có key)

| Bảng | Cột | Ý nghĩa |
|------|-----|---------|
| `denuvo_requirement` | `url`, `file_type` (direct/zip/rar), `zip_rar` | nguồn tải công cụ fix |
| `denuvo_accounts` | `id`, `appid`, `username`, `password`, `status`, `fail_count`, `cooldown_until` | account Steam sở hữu game — `password` **plaintext như trước**, nhưng `anon` không đọc được |

Backend **không tạo bảng nào** trong Supabase và **không ghi gì** vào đó. Thiết bị, nonce,
cooldown, đếm lỗi và audit log nằm trong **Deno KV** — xem [backend/src/kv.ts](../backend/src/kv.ts)
và bảng "Dữ liệu nằm ở đâu" trong [backend/README.md](../backend/README.md).

## 6. Lưu ý quan trọng

- ✅ **Bảo mật**: đã vá ở 1.1.0 — app không còn key Supabase, credential đi qua backend Deno
  ([backend/](../backend/)) với mã hoá tại DB + ký HMAC + rate limit + audit.
  Chặn được gì và **không** chặn được gì: [security.md](security.md).
- ⚠️ **Đăng nhập ẩn** chỉ chạy khi account đã **từng đăng nhập máy này** (token cached) **và tắt
  Steam Guard / máy đã uỷ quyền** — lần đầu từ máy mới Steam luôn đòi mã email (app không nhập được).
- ⚠️ Switch account sẽ **đăng xuất account Steam hiện tại** của người dùng (không tự đăng nhập lại
  account gốc vì không có mật khẩu).
- ⚠️ Giải nén `.rar` cần 7-Zip/WinRAR trên máy.
- Ticket ghi vào `g4_tool.lua`: khi **xóa game** trong tab Thư viện, block ticket (không có
  `addappid`) **không** bị xóa theo — nếu cần dọn ticket khi xóa game thì phải bổ sung riêng.

## 7. Hiệu năng
- Đọc registry/process bằng **`reg.exe` / `tasklist` async** (`execFile`), KHÔNG `execSync` → không
  chặn luồng chính.
- Lọc DLC trước khi quét DRM + concurrency 3 → giảm số trang store phải tải.

## 8. Vượt chặn DNS của ISP (không cần VPN)

Nhà mạng VN **đầu độc DNS** riêng `store.steampowered.com` → trả NXDOMAIN → mọi request quét
Denuvo lỗi `net::ERR_NAME_NOT_RESOLVED`. Đo thực tế: **chỉ DNS bị chặn**, IP và SNI thông hoàn
toàn (các host khác — `api.steamcmd.net`, `cdn.cloudflare.steamstatic.com`, `depotbox.org`,
Supabase — vẫn resolve bình thường).

**2 lớp xử lý, đều trong [main.js](../main.js):**

1. **DoH toàn cục** — `app.configureHostResolver({ enableBuiltInResolver: true,
   secureDnsMode: "automatic", secureDnsServers: [dns.google, cloudflare-dns] })` lúc `ready`.
   Áp cho cả tầng mạng Chromium (`net.request`, cửa sổ ẩn depotbox, ảnh CDN ở renderer).
   - `enableBuiltInResolver: true` là **bắt buộc** — thiếu nó Chromium bỏ qua DoH, vẫn hỏi DNS
     hệ thống (đã đo: y nguyên NXDOMAIN).
   - Chế độ `automatic` (không phải `secure`) để mạng cấm DoH vẫn fallback DNS thường.
   - Lớp này **chập chờn** (Chromium probe DoH bất đồng bộ, có request vẫn NXDOMAIN) → không
     được coi là lời giải chính.

2. **Ghim IP qua DoH — lớp gánh chính** (`dvDohResolve` / `dvGetTextViaIp` / `dvGetTextPinned`):
   hỏi IP thật qua DoH JSON API (`dns.google` → `8.8.8.8` → `cloudflare-dns.com` → `1.1.1.1`,
   endpoint IP để phòng khi tên miền DoH cũng bị chặn), rồi Node `https.request` nối **thẳng tới
   IP** với `servername` = tên miền thật (SNI đúng) + header `Host`.
   - Steam dùng Akamai nên **mỗi resolver trả IP khác nhau và có IP CHET từ VN**
     (đo được: Cloudflare trả `23.15.142.182` → timeout 100%; Google trả `23.53.210.94` → 200,
     ~0.25s). Nên phải thử lần lượt, **nhớ IP sống** (`dvIpCache`, TTL 10 phút) và bỏ IP chết.
   - IP không phải cuối danh sách chỉ chờ **6s** rồi đổi IP (IP chết bị drop gói, chờ đủ 15s rất phí).

**Đường đi trong `dvGetText`:** ưu tiên Electron `net` (fingerprint trình duyệt) → gặp
`ERR_NAME_NOT_RESOLVED`/`ENOTFOUND` thì bật cờ `dvDnsBlocked` (cả phiên đi thẳng đường ghim IP,
khỏi phí 3 lần retry mỗi appid) → lỗi mạng khác cũng thử ghim IP; server trả lỗi HTTP thật
(404…) thì trả luôn, không thử lại.

**Đo sau khi vá** (máy đang bị chặn DNS): trang store 0.5–0.7s/game, lần đầu ~1.5s (kèm DoH);
nếu IP đang ghim chết thì ~13s cho request đầu rồi tự đổi IP, sau đó 0.8s.
