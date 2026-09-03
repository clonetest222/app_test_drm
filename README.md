# G4play Denuvo Manage

Quét thư viện Steam để phát hiện game Denuvo, và fix bằng cách lấy *ownership ticket* từ tài
khoản thật rồi ghi vào `g4_tool.lua`.

Gồm 2 phần:

| Thư mục | Là gì | Chạy ở đâu |
|---|---|---|
| gốc repo | app Electron (giao diện + quét + fix) | máy người dùng |
| [`backend/`](backend/) | API Deno giữ credential | [Deno Deploy](https://dash.deno.com) |

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
* `anon` bị khoá khỏi `denuvo_accounts` — key rút từ app đọc được **0 dòng**
* mỗi lần fix chỉ xin được **1 tài khoản cho đúng 1 appid**, request ký HMAC theo máy
* response nhạy cảm nằm trong **phong bì mã hoá riêng cho từng request** ⇒ bắt gói tin hay
  dựng proxy TLS cũng không đọc được mật khẩu
* endpoint quản trị **không bao giờ trả mật khẩu** (có test tự động canh)
* có rate limit, audit log, và khoá được từng máy

**Cột `password` vẫn là plaintext như trước** — bạn vẫn nhập tay trên Supabase Table Editor,
không phải migrate gì. Vấn đề cũ không nằm ở chỗ lưu plaintext, mà ở chỗ **ai đọc được nó**.

Chi tiết + phần **không** chặn được: [specs/security.md](specs/security.md).

> ⚠️ Bản vá không cứu được cái đã lộ. Kho tài khoản đã nằm trong tầm với của mọi người từng
> cài bản 1.0.0 → **đổi mật khẩu Steam của tất cả account** trước khi phát hành.

---

## Thiết lập lần đầu

Chia làm 2 giai đoạn để có thể lên sóng ngay mà chưa cần đụng tới key nhạy cảm.

### Giai đoạn 1 — chạy được (dùng lại env đang có)

1. Supabase SQL Editor → chạy [`sql/01_bang_moi.sql`](sql/01_bang_moi.sql)
   *(chỉ THÊM bảng/cột, không xoá policy nào — app 1.0.0 vẫn chạy bình thường)*
2. Deno Deploy → **App directory** `./backend`, **Entrypoint** `main.ts`, **Install command** để trống
3. Environment Variables — giữ nguyên `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` đang có,
   thêm 3 biến: `CRED_ENC_KEY`, `ENROLL_TOKEN`, `ADMIN_TOKEN` (`deno task keygen` sinh cho)
4. Điền [`.env`](.env) của app: `G4_API_BASE` + `G4_ENROLL_TOKEN` (trùng `ENROLL_TOKEN`)
5. Fix thử 1 game cho chạy hết luồng

Xong bước này backend chạy, có rate limit / audit / phong bì mã hoá. **Nhưng lỗ hổng cũ vẫn mở** —
`curl https://<project>.deno.dev/health` sẽ báo `"bao_mat": "CHUA VA XONG"`.

### Giai đoạn 2 — vá lỗ hổng

6. Supabase → **Project Settings → API Keys** → copy secret key (`sb_secret_...`)
   hoặc legacy `service_role`
7. Deno Deploy → thêm biến `SUPABASE_SERVICE_ROLE_KEY` = key đó → redeploy
8. `curl .../health` phải báo `"bao_mat": "da khoa anon"` **trước khi** làm bước 9
9. Supabase SQL Editor → chạy [`sql/02_khoa_anon.sql`](sql/02_khoa_anon.sql)
10. Chạy [`sql/03_kiem_tra.sql`](sql/03_kiem_tra.sql) — truy vấn số 1 phải trả về **0 dòng**

> ⚠️ Chạy bước 9 khi backend vẫn đang dùng publishable key thì backend chết ngay: nó bị khoá
> cùng với `anon`. Bước 8 là để tránh đúng chuyện đó.

Không có bước migrate: tài khoản giữ nguyên plaintext như đang có.

## Hành vi đáng chú ý

1. **Đọc `.lua` ở CẢ hai thư mục**: `<Steam>\config\stplug-in` **và** `<Steam>\config\lua`.
   Tab Cài đặt hiện thư mục nào đang được đọc. Khi ghi ticket, app chọn thư mục **đang chứa
   chính appid đó**; không có thì chọn thư mục đang có `g4_tool.lua`; không nữa thì mặc định
   `config\stplug-in`.
2. **Bảng cập nhật riêng**: `denuvo_releases` / `denuvo_renderer` — app đọc qua backend
   (`/v1/update/release`, `/v1/update/renderer`), không đọc thẳng Supabase nữa.
3. **Tab Denuvo là tab mặc định** — mở app là quét luôn + chuẩn bị công cụ fix.
4. **Nâng cấp tại chỗ**: `appId` giữ nguyên `com.g4market.denuvo` nên installer mới đè lên bản
   `G4 Denuvo Tool` đã cài, không tạo 2 app song song. `installer.nsh` đóng cả tên cũ lẫn tên mới.

## ⚠️ Điều kiện để fix Denuvo có tác dụng

Ticket ghi vào `g4_tool.lua` chỉ có tác dụng khi máy **đã có sẵn file share**
(`xinput1_4.dll` cạnh `steam.exe`). App này **không tự cài** file đó.

## Dùng chung với g4_tool

Cùng project Supabase, cùng 2 bảng `denuvo_requirement` + `denuvo_accounts`.
`temp\extracted\extract_tickets.exe` đã chép sẵn nên lần chạy đầu không phải tải lại.

> ⚠️ `sql/02_khoa_anon.sql` **khoá `anon` khỏi 2 bảng dùng chung này**. Nếu `g4_tool` vẫn
> đọc chúng bằng publishable key thì nó sẽ hỏng — phải cho `g4_tool` đi qua backend này luôn,
> hoặc tách bảng riêng cho từng app.

---

## Tài liệu

* [specs/denuvo.md](specs/denuvo.md) — luồng quét + fix chi tiết
* [specs/security.md](specs/security.md) — mô hình bảo mật, chặn được gì / không chặn được gì
* [backend/README.md](backend/README.md) — API, deploy lên dash.deno.com, vận hành
