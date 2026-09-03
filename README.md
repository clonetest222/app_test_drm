# G4play Denuvo Manage

Quét thư viện Steam để phát hiện game Denuvo, và fix bằng cách lấy *ownership ticket* từ tài
khoản thật rồi ghi vào `g4_tool.lua`.

Gồm 2 phần:

| Thư mục | Là gì | Chạy ở đâu |
|---|---|---|
| gốc repo | app Electron (giao diện + quét + fix) | máy người dùng |
| [`backend/`](backend/) | API Deno giữ credential + Deno KV giữ state | [Deno Deploy](https://dash.deno.com) |

---

## Chạy / build

```
run.bat                # hoặc: npm start
npm run dist           # -> installer\G4playDenuvoManage-Setup-1.1.0.exe

cd backend
deno task dev          # backend ở http://localhost:8000
```

Trước khi chạy lần đầu phải cấu hình backend — xem [backend/README.md](backend/README.md).

---

## Vì sao có backend (bản 1.1.0)

Bản 1.0.0 đóng gói key Supabase trong `.env` và đọc thẳng bảng `denuvo_accounts`, nơi mật khẩu
Steam lưu **plain text**. Giải nén `app.asar` mất 30 giây ⇒ ai cài app cũng dump được cả kho
tài khoản, không dấu vết.

Từ 1.1.0:

* app **không còn key Supabase nào**
* mỗi lần fix chỉ xin được **1 tài khoản cho đúng 1 appid**, request ký HMAC theo máy
* response nhạy cảm nằm trong **phong bì mã hoá riêng cho từng request** ⇒ bắt gói tin hay
  dựng proxy TLS cũng không đọc được mật khẩu
* endpoint quản trị **không bao giờ trả mật khẩu** (có test tự động canh)
* có rate limit, audit log, và khoá được từng máy

**Cột `password` vẫn plaintext như trước**, và **không có bảng SQL nào được tạo thêm** — thiết bị,
nonce, cooldown, audit đều nằm trong Deno KV. Supabase chỉ còn được ĐỌC.

Chi tiết + phần **không** chặn được: [specs/security.md](specs/security.md).

> ⚠️ Bản vá không cứu được cái đã lộ. Kho tài khoản đã nằm trong tầm với của mọi người từng
> cài bản 1.0.0 → **đổi mật khẩu Steam của tất cả account** trước khi phát hành.

---

## Thiết lập

Backend cần **đúng 2 biến môi trường** — chính 2 biến bạn đã có sẵn trên Deno Deploy.
Không chạy SQL, không tạo bảng, không sinh khoá.

1. Deno Deploy → **New Project** → Deploy from GitHub → repo này
2. **App directory** `./backend` · **Entrypoint** `main.ts` · **Install command** để trống
3. Environment Variables — giữ nguyên `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`
4. Deploy. (Tuỳ chọn, 1 click: **Databases** → gắn một KV database, để state sống qua restart.
   Không gắn cũng chạy.) Lần chạy đầu backend tự sinh khoá mã hoá + admin token.
   **Xem log lúc khởi động để chép `ADMIN_TOKEN`** — nó chỉ in ra một lần.
5. Lấy URL `.deno.dev` → điền `G4_API_BASE` trong [`.env`](.env) của app
6. Kiểm tra: `deno task e2e https://<project>.deno.dev`

Tài khoản Steam vẫn thêm/sửa thẳng trong Supabase Table Editor như trước — cột `password`
plaintext, không đổi gì.

### Vá lỗ hổng (tuỳ chọn, làm sau)

Bước trên cho bạn backend chạy được, có rate limit / audit / phong bì mã hoá. **Nhưng lỗ hổng
cũ vẫn mở**: publishable key nằm trong app 1.0.0 đã phát hành, `anon` vẫn đọc được cả bảng
mật khẩu. `/health` sẽ báo `"bao_mat": "CHUA VA XONG"`.

Đóng lại — **đúng thứ tự này**:

1. Supabase → Project Settings → API Keys → copy secret key (`sb_secret_...`)
2. Deno Deploy → thêm `SUPABASE_SERVICE_ROLE_KEY` = key đó → redeploy
3. `curl .../health` phải báo `"bao_mat": "da khoa anon"`
4. Chỉ khi đó mới chạy [`sql/khoa_anon.sql`](sql/khoa_anon.sql)

Làm ngược lại thì backend bị khoá cùng `anon`. Bước 3 là để chặn đúng chuyện đó.

## Hành vi đáng chú ý

1. **Đọc `.lua` ở CẢ hai thư mục**: `<Steam>\config\stplug-in` **và** `<Steam>\config\lua`.
   Tab Cài đặt hiện thư mục nào đang được đọc. Khi ghi ticket, app chọn thư mục **đang chứa
   chính appid đó**; không có thì chọn thư mục đang có `g4_tool.lua`; không nữa thì mặc định
   `config\stplug-in`.
2. **Bảng cập nhật riêng**: `denuvo_releases` / `denuvo_renderer` — app đọc qua backend
   (`/v1/update/release`, `/v1/update/renderer`), không đọc thẳng Supabase nữa.
   Backend **không ghi gì** vào Supabase — chỉ SELECT.
3. **Tab Denuvo là tab mặc định** — mở app là quét luôn + chuẩn bị công cụ fix.
4. **Nâng cấp tại chỗ**: `appId` giữ nguyên `com.g4market.denuvo` nên installer mới đè lên bản
   `G4 Denuvo Tool` đã cài, không tạo 2 app song song. `installer.nsh` đóng cả tên cũ lẫn tên mới.

## ⚠️ Điều kiện để fix Denuvo có tác dụng

Ticket ghi vào `g4_tool.lua` chỉ có tác dụng khi máy **đã có sẵn file share**
(`xinput1_4.dll` cạnh `steam.exe`). App này **không tự cài** file đó.

## Dùng chung với g4_tool

Cùng project Supabase, cùng 2 bảng `denuvo_requirement` + `denuvo_accounts`.
`temp\extracted\extract_tickets.exe` đã chép sẵn nên lần chạy đầu không phải tải lại.

> ⚠️ `sql/khoa_anon.sql` **khoá `anon` khỏi 2 bảng dùng chung này**. Nếu `g4_tool` vẫn
> đọc chúng bằng publishable key thì nó sẽ hỏng — phải cho `g4_tool` đi qua backend này luôn,
> hoặc tách bảng riêng cho từng app.

---

## Tài liệu

* [specs/denuvo.md](specs/denuvo.md) — luồng quét + fix chi tiết
* [specs/security.md](specs/security.md) — mô hình bảo mật, chặn được gì / không chặn được gì
* [backend/README.md](backend/README.md) — API, deploy lên dash.deno.com, vận hành
