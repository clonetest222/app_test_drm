# Mô hình bảo mật — G4play Denuvo Manage

Tài liệu này ghi lại **cái gì bị chặn, cái gì không**, để sau này không ai phải đoán.

## 1. Lỗ hổng đã vá

Bản cũ (`G4 Denuvo Tool` 1.0.0) đóng gói `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` trong
`.env`, và `main.js` gọi thẳng:

```
GET /rest/v1/denuvo_accounts?select=*&appid=eq.<x>&status=eq.available
```

Bảng `denuvo_accounts` có policy cho `anon` đọc, cột `password` là **plain text**.

Lỗ hổng **không phải** ở chỗ lưu plaintext — mà ở chỗ *ai đọc được nó*. Bản vá tấn công đúng
chỗ đó: cột `password` giữ nguyên plaintext, nhưng `anon` mất sạch quyền đọc.

Hệ quả: bất kỳ ai cài app đều lấy được toàn bộ kho tài khoản Steam trong 3 bước —

```
npx asar extract app.asar out    # lấy .env
curl -H "apikey: <key>" "https://<proj>.supabase.co/rest/v1/denuvo_accounts?select=*"
```

Không cần kỹ năng gì, không để lại dấu vết, không cách nào biết ai đã làm.

## 2. Kiến trúc sau khi vá

```
  ┌─────────────────────────┐        request đã ký HMAC          ┌──────────────────────┐
  │  App Electron           │  ───────────────────────────────►  │  Backend Deno        │
  │  (máy người dùng)       │                                    │  (Deno Deploy)       │
  │                         │  ◄───────────────────────────────  │                      │
  │  • KHÔNG có key Supabase│      phong bì AES-256-GCM          │  • service_role key  │
  │  • device_secret (DPAPI)│      (khoá riêng từng request)     │  • rate limit/audit  │
  └─────────────────────────┘                                    └──────────┬───────────┘
                                                                            │ service_role
                                                                 ┌──────────▼───────────┐
                                                                 │  Supabase            │
                                                                 │  password: plaintext │
                                                                 │  anon: 0 quyền đọc   │
                                                                 └──────────────────────┘
```

### Các lớp

| Lớp | Chặn cái gì |
|---|---|
| RLS đóng hoàn toàn | anon/publishable key không đọc nổi 1 dòng nào của `denuvo_accounts` |
| Chỉ backend đọc DB | app không có key nào; `service_role` chỉ nằm trong env của Deno Deploy |
| `maskAccount()` | endpoint quản trị chỉ trả `co_mat_khau: true/false`, không bao giờ trả mật khẩu |
| Ký HMAC theo device | không có `device_secret` thì không gọi được endpoint nào |
| Nonce dùng 1 lần | bắt được request cũ cũng không phát lại được |
| Timestamp ±2 phút | thu hẹp cửa sổ tấn công |
| Phong bì response | bắt gói tin / proxy TLS (Fiddler + root CA tự cài) chỉ thấy base64 — **đây là lớp giữ cho plaintext không lộ khi đi qua API** |
| Rate limit | 1 máy không hút được kho tài khoản (4/10 phút/game, 12/giờ, 40/ngày) |
| Audit log | mỗi lần phát credential đều có `device_id` + IP + thời điểm |
| Revoke device | phát hiện máy nào rò rỉ ⇒ khoá riêng máy đó |
| Cooldown account | Steam không khoá tài khoản vì login dồn dập |
| Tự chặn account hỏng | 5 lần login lỗi liên tiếp ⇒ `status='blocked'` |
| `dvScrubLog()` | mật khẩu không lọt vào log/terminal trong app |
| `safeStorage` (DPAPI) | copy `g4_device.json` sang máy khác là vô dụng |

### Lưu device_secret

`%APPDATA%\G4play Denuvo Manage\g4_device.json`, mã hoá bằng Electron `safeStorage`
(Windows = DPAPI, gắn với tài khoản Windows). Mất file ⇒ app tự đăng ký lại, backend
nhận ra cùng fingerprint máy nên cấp lại secret mới thay vì tạo device mới.

## 3. Cái KHÔNG được chặn (chấp nhận có ý thức)

1. **Ai đọc được DB thì đọc được mật khẩu.** Cột `password` là plaintext, nên `service_role`
   key bị lộ / backup Supabase bị lộ / tài khoản Supabase bị chiếm ⇒ lộ toàn bộ kho.
   Đây là cái giá của việc giữ plaintext, đổi lại vận hành đơn giản (nhập tay trên Table Editor,
   không sợ mất khoá là mất hết).
   *Giảm nhẹ:* `service_role` key chỉ nằm trong env của Deno Deploy, không đâu khác; bật 2FA
   cho tài khoản Supabase; đừng share backup.
   *Muốn bỏ hẳn rủi ro này:* đặt `ENCRYPT_AT_REST=true` rồi `deno task migrate`. Tuỳ chọn,
   mặc định tắt.
2. **Người dùng hợp lệ vẫn thấy mật khẩu game họ đang fix.** `steam.exe -login <user> <pass>`
   chạy trên máy họ — không tránh được, chừng nào việc login còn diễn ra tại máy khách.
3. **Mật khẩu nằm trên command line của `steam.exe`.** Process Explorer / Task Manager (cột
   Command line) đọc được. Steam bắt buộc như vậy, không có API thay thế.
4. **`ENROLL_TOKEN` nằm trong app** ⇒ rút ra được. Nó chỉ là rào cản tốc độ; phòng thủ thật
   là rate limit + audit + revoke.
5. **Người quyết tâm vẫn tự động hoá được** việc gọi API bằng device_secret rút từ máy họ —
   nhưng bị giới hạn 40 lần/ngày và mỗi lần đều có tên trong log.

### Đường triệt để

Chuyển sang `mode: "ticket"`: backend tự giữ phiên Steam, tự lấy ownership ticket, app chỉ nhận
`appticket` + `eticket`. Máy người dùng **không bao giờ** thấy mật khẩu, và cũng không bị đăng
xuất tài khoản Steam của chính họ.

Protocol và nhánh xử lý trong app **đã viết sẵn** (`denuvoRun` trong `main.js`, `mode === "ticket"`).
Bật lên chỉ cần sửa backend, **không phải phát hành app mới**.

## 4. Việc phải làm khi phát hành

- [ ] Chạy `sql/01_bang_moi.sql` (bắt buộc — tạo bảng backend cần, không đụng policy)
- [ ] `deno task keygen` → điền biến môi trường trên dash.deno.com (entrypoint `backend/main.ts`)
- [ ] Đặt `SUPABASE_SERVICE_ROLE_KEY`, kiểm tra `/health` báo `"da khoa anon"`
- [ ] Chạy `sql/02_khoa_anon.sql` — **đây mới là bước vá lỗ hổng**, làm sau bước trên
- [ ] Chạy `sql/03_kiem_tra.sql` — **truy vấn số 1 phải trả về 0 dòng** (không còn policy
      `anon` nào trên `denuvo_accounts` / `denuvo_requirement`). Đây là bước xác nhận lỗ hổng
      đã đóng; các truy vấn còn lại chỉ để đối chiếu.
- [ ] Điền `G4_API_BASE` + `G4_ENROLL_TOKEN` vào `.env` của app
- [ ] Build thử, fix 1 game thật cho chạy hết luồng
- [ ] **Đổi mật khẩu Steam của tất cả account trong DB** — chúng đã ở trong tầm với của bất kỳ
      ai từng cài bản 1.0.0. Bản vá chặn từ nay về sau, không cứu được cái đã lộ.
- [ ] Xoá `.env.bak` sau khi đã chép `SUPABASE_URL` sang backend
- [ ] Kiểm tra `g4_tool` (app cũ): `sql/01` khoá `anon` khỏi 2 bảng dùng chung, nếu nó vẫn đọc
      bằng publishable key thì sẽ hỏng
