# G4play Denuvo Manage — Backend (Deno)

Backend này tồn tại vì một lý do: app Electron không được phép cầm key đọc thẳng bảng
`denuvo_accounts` nữa.

| | Trước | Sau |
|---|---|---|
| Key trong app | `SUPABASE_PUBLISHABLE_KEY` | không có key nào |
| Lấy account | `GET /rest/v1/denuvo_accounts` → **cả bảng, plaintext** | `POST /v1/denuvo/ticket` → **1 account cho 1 appid** |
| Đường truyền | JSON trần | phong bì AES-256-GCM riêng từng request |
| Ai lấy cái gì | không biết | audit log trong Deno KV |
| Chặn kẻ lạm dụng | không thể | rate limit + revoke từng máy |

> Giải nén `app.asar` mất đúng 30 giây (`npx asar extract`). Mọi thứ nằm trong app đều coi như
> công khai. Đó là tiền đề của toàn bộ thiết kế dưới đây.

---

## 1. Cài đặt: 2 biến, không SQL

Backend cần **đúng 2 biến môi trường**:

```
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY      (hoặc SERVICE_ROLE / SECRET / SUPABASE_KEY)
```

Không phải chạy lệnh SQL nào, không tạo bảng nào, không sinh khoá nào.

**Vì sao được vậy:** state của backend (thiết bị, nonce, cooldown, audit, khoá mã hoá, admin
token) nằm trong **Deno KV** — có sẵn trên Deno Deploy, `Deno.openKv()` không cần cấu hình.
Supabase chỉ còn được **ĐỌC**: `denuvo_accounts`, `denuvo_requirement`, `denuvo_releases`,
`denuvo_renderer` — đúng những bảng app 1.0.0 vẫn đọc, nên publishable key là đủ.

### Deploy lên dash.deno.com

1. **New Project** → Deploy from GitHub → chọn repo
2. **App directory**: `./backend` ← bắt buộc
3. **Entrypoint**: `main.ts` (tính từ App directory, nên KHÔNG phải `backend/main.ts`)
4. **Install command**: để trống — Deno không cần `npm install`
5. **Environment Variables**: 2 biến ở trên
6. Deploy

#### Nếu quên đặt App directory

Deno Deploy đọc `package.json` ở **gốc repo** (của app Electron), thấy `"main": "main.js"`,
rồi chạy nhầm file đó:

```
at file:///app/src/main.js:12:61
ReferenceError: require is not defined
Warm up (Failed)
```

Không phải lỗi code — chỉ là trỏ sai entrypoint.

### Lần chạy đầu: chép ADMIN_TOKEN

Backend tự sinh khoá mã hoá + admin token rồi lưu vào KV. **Admin token chỉ in ra log đúng
một lần:**

```
ADMIN_TOKEN vua duoc sinh va luu vao Deno KV. CHEP LAI NGAY:

    3e1bfd844b30a972c6d882db20f375ad35f911aaa597638b71aafd88a5717e62
```

Mất thì đặt biến `ADMIN_TOKEN` thủ công — nó đè lên giá trị tự sinh.

### Nối app vào

Lấy URL `https://<project>.deno.dev` → điền `G4_API_BASE` trong [`../.env`](../.env).

Kiểm tra toàn bộ chuỗi ký (dùng đúng thuật toán trong `api.js`):

```bash
deno task e2e https://<project>.deno.dev
```

10 phép thử: đăng ký thiết bị, xoay khoá, chặn request không ký, chặn replay, chặn chữ ký sai,
chặn sửa body, chặn lệch đồng hồ, chặn admin không token.

---

## 2. Quản lý tài khoản

Vẫn thêm/sửa thẳng trong **Supabase Table Editor** như trước — cột `password` plaintext,
không đổi gì. Backend chỉ đọc.

Đối soát qua API (không bao giờ trả mật khẩu):

```bash
curl -H "X-G4-Admin: <ADMIN_TOKEN>" https://<project>.deno.dev/v1/admin/accounts
```

Trả về `co_mat_khau: true/false`, `fail_count`, `cooldown_until`, `bi_chan`.

---

## 3. API

### Công khai

| Method | Path | Ghi chú |
|---|---|---|
| `GET` | `/health` | ping + báo lỗ hổng đã đóng chưa |
| `POST` | `/v1/device/register` | trả `device_id` + `device_secret` |
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
X-G4-Ts     : <unix ms>       — lệch quá 2 phút là loại
X-G4-Nonce  : <32 hex>        — chỉ dùng được 1 lần (KV, TTL 5 phút)
X-G4-Sig    : hex HMAC-SHA256(device_secret, canonical)

canonical = METHOD \n PATH \n TS \n NONCE \n sha256hex(body)
```

Response nhạy cảm nằm trong `{enc:1, iv, ct}`, khoá = `HKDF(device_secret, salt=nonce)`.
Kẻ dựng proxy TLS (Fiddler/mitmproxy + root CA tự cài) **vẫn không đọc được** username/password
— họ chỉ thấy một khối base64.

### Quản trị (`X-G4-Admin: <ADMIN_TOKEN>`)

| Method | Path | Ghi chú |
|---|---|---|
| `GET` | `/v1/admin/accounts?appid=&limit=` | liệt kê account — **không bao giờ trả mật khẩu** |
| `POST` | `/v1/admin/accounts/reset` | `{account_id}` — gỡ chặn / xoá cooldown |
| `GET` | `/v1/admin/devices` | máy đã đăng ký |
| `POST` | `/v1/admin/devices/revoke` | `{device_id, reason}` — khoá 1 máy; `{unrevoke:true}` để mở |
| `GET` | `/v1/admin/audit?device=&appid=&limit=` | ai lấy credential nào, lúc nào |
| `GET` | `/v1/admin/health` | tổng quan |

---

## 4. Rate limit & tự bảo vệ

Bộ đếm nằm trong KV, khoá gắn với số hiệu cửa sổ thời gian + có TTL nên tự hết hạn.

| Biến | Mặc định | Chặn điều gì |
|---|---|---|
| `LIMIT_DEVICE_APPID_10M` | 4 | 1 máy quay vòng account cho cùng 1 game |
| `LIMIT_DEVICE_HOUR` | 12 | 1 máy hút kho tài khoản |
| `LIMIT_DEVICE_DAY` | 40 | như trên, dài hạn |
| `ACCOUNT_COOLDOWN_SEC` | 90 | Steam khoá tạm vì login liên tục |
| `ACCOUNT_FAIL_BLOCK` | 5 | account chết vẫn bị phát mãi → tự bỏ qua |
| `LIMIT_ENROLL_IP_HOUR` | 6 | 1 IP đăng ký hàng loạt device giả |
| `ENROLL_TOKEN` | *(trống)* | không đặt = bỏ qua kiểm tra khi đăng ký |

Cooldown đặt **ngay khi phát**, không đợi app báo kết quả — app tắt giữa chừng thì account vẫn
không bị xoay vòng liên tục.

`ACCOUNT_FAIL_BLOCK` chặn ở tầng KV, không sửa `status` trong Supabase (backend không có quyền
ghi). Gỡ chặn bằng `/v1/admin/accounts/reset`.

---

## 5. Hai giai đoạn — nói thẳng

Backend chạy được ở **cả hai** chế độ key và tự báo mình đang ở đâu.

| | Giai đoạn 1 (mặc định) | Giai đoạn 2 |
|---|---|---|
| Key backend dùng | `SUPABASE_PUBLISHABLE_KEY` (= `anon`) | `SUPABASE_SERVICE_ROLE_KEY` |
| SQL đã chạy | không có | `khoa_anon.sql` |
| `/health` báo | `"CHUA VA XONG"` | `"da khoa anon"` |
| Rate limit / audit / phong bì mã hoá | có | có |
| **App 1.0.0 còn dump được cả kho tài khoản** | **CÒN** | hết |

**Giai đoạn 1 không phải đích đến.** Nó cho bạn lên sóng với 2 biến và không đụng gì tới DB.
Nhưng lỗ hổng thật — kho tài khoản Steam đọc được bằng key rút từ app đã phát hành — chỉ đóng
lại ở giai đoạn 2.

### Chuyển sang giai đoạn 2 — đúng thứ tự

1. Supabase → Project Settings → API Keys → copy secret key (`sb_secret_...`)
2. Deno Deploy → thêm `SUPABASE_SERVICE_ROLE_KEY` → redeploy
3. `curl .../health` → **phải** thấy `"bao_mat": "da khoa anon"`
4. Chỉ khi đó mới chạy [`../sql/khoa_anon.sql`](../sql/khoa_anon.sql)

Làm ngược lại thì backend bị khoá cùng `anon`, app báo "chưa có tài khoản khả dụng" với mọi game.

### Cái vẫn không chặn được, kể cả ở giai đoạn 2

1. **Người dùng hợp lệ vẫn thấy mật khẩu game họ đang fix** nếu chịu khó debug app —
   `steam.exe -login <user> <pass>` chạy trên máy họ.
2. **Mật khẩu nằm trên command line của `steam.exe`** → Process Explorer đọc được. Steam bắt
   buộc vậy. `dvScrubLog()` chặn nó lọt vào log app, nhưng không chặn được Process Explorer.
3. **Ai đọc được DB thì đọc được mật khẩu** — cột `password` là plaintext.
4. **Người quyết tâm vẫn tự động hoá được** việc gọi API bằng `device_secret` rút từ máy họ —
   nhưng bị chặn ở 40 lần/ngày và mỗi lần đều có tên trong audit log.

### Muốn triệt để: `mode: "ticket"`

Backend tự giữ phiên Steam, tự lấy ownership ticket, trả về:

```json
{ "mode": "ticket", "appticket": "...", "eticket": "..." }
```

App **đã xử lý nhánh này rồi** (xem `denuvoRun` trong [`../main.js`](../main.js)) — bật lên
không cần phát hành app mới. Khi đó máy người dùng không bao giờ thấy mật khẩu, và cũng không
bị đăng xuất tài khoản Steam của chính họ.

---

## 6. Lệnh hay dùng

```bash
deno task dev        # chạy local (KV lưu ra file SQLite), tự reload
deno task check      # type-check toàn bộ
deno task test       # 11 test: crypto + chống rò rỉ mật khẩu
deno task interop    # xác nhận Deno seal <-> Node open khớp nhau
deno task e2e [url]  # 10 phép thử trên backend đang chạy
deno task deploy     # deployctl (sửa --project cho đúng tên)
```

## 7. Dữ liệu nằm ở đâu

| Thứ | Nơi lưu | Ghi chú |
|---|---|---|
| Tài khoản Steam | Supabase `denuvo_accounts` | chỉ đọc, plaintext như trước |
| Nguồn tải công cụ fix | Supabase `denuvo_requirement` | chỉ đọc |
| Phiên bản app | Supabase `denuvo_releases` / `denuvo_renderer` | chỉ đọc |
| Khoá mã hoá, admin token | Deno KV `["cfg",…]` | tự sinh lần đầu |
| Thiết bị đã đăng ký | Deno KV `["device",…]` | secret được mã hoá trước khi ghi |
| Nonce chống replay | Deno KV `["nonce",…]` | TTL 5 phút, tự xoá |
| Cooldown / đếm lỗi account | Deno KV `["acct",…]` | |
| Bộ đếm rate limit | Deno KV `["rate",…]` | TTL theo cửa sổ |
| Audit log | Deno KV `["lease",…]` | TTL 90 ngày |

KV mất dữ liệu thì backend vẫn chạy: app tự đăng ký lại thiết bị, cooldown/audit bắt đầu lại từ
đầu. Không có gì không khôi phục được.
