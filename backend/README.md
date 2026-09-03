# G4play Denuvo Manage — Backend (Deno)

Backend này tồn tại vì **một lý do duy nhất**: app Electron không được phép cầm key đọc thẳng
bảng `denuvo_accounts` nữa.

| | Trước | Sau |
|---|---|---|
| Key trong app | `SUPABASE_PUBLISHABLE_KEY` | không có key nào |
| Lấy account | `GET /rest/v1/denuvo_accounts?...` → **cả bảng, plaintext** | `POST /v1/denuvo/ticket` → **1 account cho 1 appid** |
| Mật khẩu trong DB | plaintext | **vẫn plaintext** — nhưng `anon` không đọc nổi 1 dòng |
| Ai lấy cái gì | không biết | `denuvo_lease_log` ghi đủ |
| Chặn kẻ lạm dụng | không thể | revoke device + rate limit |

> Giải nén `app.asar` mất đúng 30 giây (`npx asar extract`). Mọi thứ nằm trong app đều
> coi như công khai. Đó là tiền đề của toàn bộ thiết kế dưới đây.

---

## 1. Chuẩn bị (làm 1 lần)

### 1.1 Chạy SQL

Supabase → SQL Editor → chạy [`../sql/01_bang_moi.sql`](../sql/01_bang_moi.sql).

File này **chỉ thêm**, không xoá policy nào: 3 bảng backend cần (`denuvo_devices`, `denuvo_nonce`,
`denuvo_lease_log`) + vài cột phụ cho `denuvo_accounts`. Chạy xong app 1.0.0 vẫn hoạt động y như cũ.

Việc khoá `anon` — thứ thực sự vá lỗ hổng — nằm ở [`../sql/02_khoa_anon.sql`](../sql/02_khoa_anon.sql),
chạy sau, khi backend đã có secret key. Xem [§7](#7-hai-giai-đoạn).

### 1.2 Sinh khoá

```bash
cd backend
deno task keygen
```

In ra 3 giá trị. Ý nghĩa:

| Biến | Ai được biết | Mất thì sao |
|---|---|---|
| `CRED_ENC_KEY` | chỉ backend | ở chế độ mặc định chỉ dùng để mã hoá `device_secret` → app tự đăng ký lại, không mất gì. Chỉ khi bật `ENCRYPT_AT_REST` nó mới giữ mật khẩu. |
| `ENROLL_TOKEN` | backend **và** app | không sao — nó vốn không phải bí mật thật, chỉ là rào cản tốc độ |
| `ADMIN_TOKEN` | chỉ máy bạn | người khác thêm/xoá được account → đổi ngay |

Lấy thêm `SUPABASE_SERVICE_ROLE_KEY` ở Supabase → Project Settings → API.
**Là `service_role`, không phải `anon`/`publishable`.** Key này đi xuyên RLS, lộ nó = lộ cả DB.

### 1.3 Chạy thử ở máy

```bash
cp .env.example .env      # điền các giá trị vừa sinh
deno task dev             # http://localhost:8000
curl http://localhost:8000/health
```

### 1.4 Tài khoản: giữ nguyên cách bạn đang làm

**Không cần migrate gì cả.** Cột `password` trong `denuvo_accounts` vẫn là plaintext, bạn vẫn
thêm/sửa account thẳng trong Supabase Table Editor như trước.

Cái thay đổi là **ai đọc được nó**: sau `02_khoa_anon.sql`, `anon` có 0 quyền trên bảng này,
và app không còn key Supabase nào. Chỉ backend đọc được, và nó chỉ nhả ra 1 account cho 1 appid,
trong phong bì mã hoá.

Muốn thêm account qua API thay vì Table Editor:

```bash
curl -X POST https://<project>.deno.dev/v1/admin/accounts   -H "X-G4-Admin: <ADMIN_TOKEN>"   -H "Content-Type: application/json"   -d '{"appid":"1174180","username":"u","password":"p"}'
```

Hoặc hàng loạt: `deno task import accounts.json` (hoặc `.csv` cột `appid,username,password`).

> Mã hoá tại DB là **tuỳ chọn**, mặc định tắt. Nếu sau này muốn bật: đặt `ENCRYPT_AT_REST=true`
> rồi `deno task migrate`. Xem [§5](#5-đánh-đổi--nói-thẳng).

---

## 2. Deploy lên Deno Deploy (dash.deno.com)

### Cách A — link GitHub (khuyến nghị: push là tự deploy)

1. Push repo này lên GitHub (`.env` đã nằm trong `.gitignore`, kiểm tra lại cho chắc).
2. https://dash.deno.com → **New Project** → **Deploy from GitHub** → chọn repo.
3. **App directory**: `./backend`  ← **bắt buộc**, đừng bỏ qua
4. **Entrypoint**: `main.ts` (tính từ App directory, nên KHÔNG phải `backend/main.ts`)
5. **Settings → Environment Variables** — thêm đúng 5 biến bắt buộc:

   ```
   SUPABASE_URL
   SUPABASE_SERVICE_ROLE_KEY
   CRED_ENC_KEY
   ENROLL_TOKEN
   ADMIN_TOKEN
   ```

   (các biến `LIMIT_*`, `ACCOUNT_*`, `MIN_APP_VERSION` là tuỳ chọn — không đặt thì dùng mặc định
   trong [`src/config.ts`](src/config.ts))

6. Deploy xong lấy URL dạng `https://<project>.deno.dev` → dán vào `G4_API_BASE` trong
   [`../.env`](../.env) của app, và đặt `G4_ENROLL_TOKEN` **trùng** với `ENROLL_TOKEN`.

> Backend không dùng import map hay dependency ngoài nào — chỉ TypeScript + WebCrypto có sẵn.
> Deploy không cần build step, không cần `node_modules`.

#### Nếu quên đặt App directory

Deno Deploy sẽ đọc `package.json` ở **gốc repo** (của app Electron), thấy `"main": "main.js"`,
rồi chạy nhầm file đó. Log báo:

```
at file:///app/src/main.js:12:61
info: Deno supports CommonJS modules in .cjs files...
Warm up (Failed)
```

Đó không phải lỗi code — chỉ là trỏ sai entrypoint. Vào **Settings → App directory**
đặt `./backend`, **Entrypoint** đặt `main.ts`, rồi redeploy.

### Cách B — deployctl từ máy

```bash
deno install -Arf jsr:@deno/deployctl
cd backend
deployctl deploy --project=<ten-project> --entrypoint=main.ts --prod
```

### Kiểm tra sau khi deploy

```bash
curl https://<project>.deno.dev/health
curl -H "X-G4-Admin: <ADMIN_TOKEN>" https://<project>.deno.dev/v1/admin/health
```

`/v1/admin/health` trả về chế độ đang chạy, số account, số device đang hoạt động.
Trường `canh_bao` khác `null` nghĩa là có dòng **không có mật khẩu nào** — app sẽ bỏ qua dòng đó.

---

## 3. API

### Công khai

| Method | Path | Ghi chú |
|---|---|---|
| `GET` | `/health` | ping |
| `POST` | `/v1/device/register` | cần header `X-G4-Enroll`; trả `device_id` + `device_secret` |
| `GET` | `/v1/update/release` | phiên bản installer mới nhất |
| `GET` | `/v1/update/renderer` | phiên bản hot-update giao diện |

### Cần chữ ký device

| Method | Path | Ghi chú |
|---|---|---|
| `POST` | `/v1/denuvo/ticket` | `{appid, exclude[]}` → **1** account, trong phong bì mã hoá |
| `POST` | `/v1/denuvo/ticket/result` | `{account_id, ok, reason}` → audit + tự chặn account hỏng |
| `GET` | `/v1/denuvo/requirement` | nguồn tải `extract_tickets.exe` |

Chữ ký (app tự làm trong [`../api.js`](../api.js)):

```
X-G4-Device : <device_id>
X-G4-Ts     : <unix ms>            — lệch quá 2 phút là loại
X-G4-Nonce  : <32 hex>             — chỉ dùng được 1 lần (bảng denuvo_nonce)
X-G4-Sig    : hex HMAC-SHA256(device_secret, canonical)

canonical = METHOD \n PATH \n TS \n NONCE \n sha256hex(body)
```

Response nhạy cảm nằm trong `{enc:1, iv, ct}`, khoá = `HKDF(device_secret, salt=nonce)`.
Kẻ dựng proxy TLS (Fiddler/mitmproxy + cài root CA) giữa app và server **vẫn không đọc được**
username/password — họ chỉ thấy một khối base64.

### Quản trị (`X-G4-Admin: <ADMIN_TOKEN>`)

| Method | Path | Ghi chú |
|---|---|---|
| `POST` | `/v1/admin/accounts` | `{appid, username, password}` → thêm account |
| `GET` | `/v1/admin/accounts?appid=&limit=` | liệt kê account — **không bao giờ trả mật khẩu**, chỉ `co_mat_khau: true/false` |
| `POST` | `/v1/admin/devices/revoke` | `{device_id, reason}` — khoá 1 máy; `{device_id, unrevoke:true}` để mở lại |
| `GET` | `/v1/admin/audit?device=&appid=&limit=` | ai lấy credential nào, lúc nào |
| `GET` | `/v1/admin/health` | chế độ, số account, dòng thiếu mật khẩu |

Thêm account hàng loạt (không qua HTTP):

```bash
deno task import accounts.json     # hoặc accounts.csv: appid,username,password[,status]
```

Xoá file nguồn sau khi nhập cho gọn (ở chế độ mặc định thì DB vẫn có plaintext, nên nó
không phải bản duy nhất).

---

## 4. Rate limit & tự bảo vệ

Cấu hình qua biến môi trường ([`src/config.ts`](src/config.ts)), mặc định:

| Biến | Mặc định | Chặn điều gì |
|---|---|---|
| `LIMIT_DEVICE_APPID_10M` | 4 | 1 máy quay vòng account cho cùng 1 game |
| `LIMIT_DEVICE_HOUR` | 12 | 1 máy hút kho tài khoản |
| `LIMIT_DEVICE_DAY` | 40 | như trên, dài hạn |
| `ACCOUNT_COOLDOWN_SEC` | 90 | Steam khoá tạm vì login liên tục |
| `ACCOUNT_FAIL_BLOCK` | 5 | account chết vẫn bị phát mãi → tự `status='blocked'` |
| `LIMIT_ENROLL_IP_HOUR` | 6 | 1 IP đăng ký hàng loạt device giả |

Cooldown được đặt **ngay khi phát**, không đợi app báo kết quả — app tắt giữa chừng thì account
vẫn không bị xoay vòng liên tục.

---

## 5. Đánh đổi — nói thẳng

Mật khẩu vẫn nằm plaintext trong DB. Đó là lựa chọn có ý thức, và nó **có cái giá**.

### Chặn được (đây là lỗ hổng thật đã vá)

| | |
|---|---|
| Dump cả kho bằng key rút từ app | **hết** — app không còn key, `anon` có 0 quyền, mỗi lần chỉ 1 account cho 1 appid |
| Đọc mật khẩu khi bắt gói tin API | **hết** — payload nằm trong phong bì AES-256-GCM riêng cho từng request; proxy TLS chỉ thấy base64 |
| Lộ mật khẩu qua endpoint quản trị | **hết** — `maskAccount()` cắt sạch, có test tự động canh ([`src/leak_test.ts`](src/leak_test.ts)) |
| Lấy credential vô danh | **hết** — mọi lần đều có `device_id` + IP + thời điểm trong `denuvo_lease_log` |
| Gọi API bừa bãi | **hết** — ký HMAC, nonce dùng 1 lần, rate limit, revoke được từng máy |

### KHÔNG chặn được

1. **Ai đọc được DB thì đọc được mật khẩu.** `service_role` key, backup Supabase, hoặc tài khoản
   Supabase của bạn bị chiếm ⇒ lộ toàn bộ. Đây là cái giá của việc giữ plaintext.
   *Giảm nhẹ:* đừng để `service_role` key ở đâu ngoài biến môi trường của Deno Deploy; bật 2FA
   cho tài khoản Supabase.
   *Muốn bỏ hẳn rủi ro này:* `ENCRYPT_AT_REST=true` + `deno task migrate`. Không bắt buộc.
2. **Người dùng hợp lệ vẫn thấy mật khẩu game họ đang fix** nếu chịu khó debug app —
   `steam.exe -login <user> <pass>` chạy trên máy họ.
3. **Mật khẩu nằm trên command line của `steam.exe`** → Process Explorer đọc được. Steam bắt
   buộc vậy. `dvScrubLog()` chặn nó lọt vào log app, nhưng không chặn được Process Explorer.
4. **`ENROLL_TOKEN` nằm trong app** ⇒ rút ra được. Nó chỉ là rào cản tốc độ.
5. **Người quyết tâm vẫn tự động hoá được** việc gọi API bằng `device_secret` rút từ máy họ —
   nhưng bị chặn ở 40 lần/ngày và mỗi lần đều có tên trong audit log.

### Muốn triệt để: chuyển sang `mode: "ticket"`

Protocol **đã sẵn sàng** cho việc này. Backend tự giữ phiên Steam, tự lấy ownership ticket, và
trả về:

```json
{ "mode": "ticket", "appticket": "...", "eticket": "..." }
```

App đã xử lý nhánh này rồi (xem `denuvoRun` trong [`../main.js`](../main.js)) — bật lên
**không cần cập nhật app**. Khi đó máy người dùng không bao giờ thấy mật khẩu, và cũng không
bị đăng xuất tài khoản Steam của chính họ nữa.

---

## 6. Lệnh hay dùng

```bash
deno task dev        # chạy local, tự reload
deno task check      # type-check toàn bộ
deno task test       # 11 test: crypto + chống rò rỉ mật khẩu
deno task interop    # xác nhận Deno seal <-> Node open khớp nhau
deno task migrate    # TUỲ CHỌN: mã hoá tại DB (chỉ khi ENCRYPT_AT_REST=true)
deno task deploy     # deployctl (sửa --project cho đúng tên)
```

---

## 7. Hai giai đoạn

Backend chạy được ở **cả hai** chế độ key, và tự báo mình đang ở chế độ nào.

| | Giai đoạn 1 | Giai đoạn 2 |
|---|---|---|
| Key backend dùng | `SUPABASE_PUBLISHABLE_KEY` (= `anon`) | `SUPABASE_SERVICE_ROLE_KEY` |
| SQL đã chạy | `01_bang_moi.sql` | thêm `02_khoa_anon.sql` |
| `/health` báo | `"CHUA VA XONG"` | `"da khoa anon"` |
| Rate limit / audit / phong bì mã hoá | có | có |
| App 1.0.0 còn dump được kho tài khoản | **CÒN** | hết |
| Ai có publishable key ghi rác vào bảng audit | được | không |

Code tự chọn key theo thứ tự `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SECRET_KEY` →
`SUPABASE_PUBLISHABLE_KEY` → `SUPABASE_KEY`, và in cảnh báo lớn lúc khởi động nếu đang ở
giai đoạn 1 — để không ai tưởng nhầm là đã vá xong.

**Giai đoạn 1 không phải là đích đến.** Nó chỉ giúp lên sóng sớm và kiểm thử toàn bộ luồng.
Lỗ hổng thật sự — kho tài khoản Steam đọc được bằng key rút từ app đã phát hành — chỉ đóng
lại ở giai đoạn 2.

### Thứ tự bắt buộc khi chuyển sang giai đoạn 2

1. Đặt `SUPABASE_SERVICE_ROLE_KEY` trên Deno Deploy → redeploy
2. `curl .../health` → **phải** thấy `"bao_mat": "da khoa anon"`
3. Chỉ khi đó mới chạy `02_khoa_anon.sql`

Làm ngược lại (chạy SQL trước) thì backend bị khoá cùng với `anon`, app báo "chưa có tài khoản
khả dụng" với mọi game cho tới khi bạn đặt key.
