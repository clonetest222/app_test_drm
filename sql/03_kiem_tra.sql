-- ============================================================================
--  KIEM TRA - chay luc nao cung duoc.
--  File nay CHI DOC - khong xoa, khong sua gi het.
--
--  Quyet dinh cua du an: cot `password` GIU NGUYEN plaintext, ban van nhap tay
--  tren Supabase Table Editor nhu truoc. Bao ve nam o TANG TRUY CAP:
--    - anon co 0 quyen doc bang SAU KHI chay 02_khoa_anon.sql
--      (truy van so 1 duoi day xac nhan - truoc do no se con tra ve dong)
--    - app khong con key Supabase nao
--    - backend chi nha ra 1 account cho 1 appid, trong phong bi ma hoa
--    - khong endpoint nao tra mat khau ra dang doc duoc, ke ca /v1/admin/*
-- ============================================================================

-- 1. QUAN TRONG NHAT: anon con policy nao tren 2 bang nhay cam khong?
--    PHAI TRA VE 0 DONG. Con dong nao la lo hong cu van con.
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('denuvo_accounts', 'denuvo_requirement');

-- 2. RLS da bat chua? ca 2 dong phai co rowsecurity = true
select relname as bang, relrowsecurity as rls_bat
from pg_class
where relname in ('denuvo_accounts', 'denuvo_requirement');

-- 3. Dong nao khong co mat khau nao ca -> app se bo qua khi fix
select count(*) as thieu_mat_khau
from public.denuvo_accounts
where coalesce(password, '') = '' and password_enc is null;

-- 4. Tong quan tung dong (KHONG hien mat khau)
select
  id,
  appid,
  username,
  status,
  (coalesce(password, '') <> '' or password_enc is not null) as co_mat_khau,
  (password_enc is not null) as da_ma_hoa,
  fail_count,
  cooldown_until,
  last_used_at
from public.denuvo_accounts
order by appid, id;

-- 5. Audit: ai da lay credential gan day
select l.created_at, l.device_id, l.appid, l.account_id, l.result, l.reason, l.ip
from public.denuvo_lease_log l
order by l.created_at desc
limit 50;

-- 6. Thiet bi dang hoat dong
select id, app_version, revoked, lease_count, last_seen_at, last_ip
from public.denuvo_devices
order by last_seen_at desc nulls last
limit 50;


-- ============================================================================
--  ==> TUY CHON (khong bat buoc, mac dinh KHONG lam):
--      neu sau nay muon ma hoa mat khau tai DB thay vi plaintext:
--
--        1. sao luu DB (Supabase > Database > Backups)
--        2. dat ENCRYPT_AT_REST=true tren backend
--        3. cd backend && deno task migrate            (tao password_enc, giu plaintext)
--        4. chay lai truy van so 4 o tren de doi chieu
--        5. muon bo han plaintext: deno task migrate --wipe-plaintext
--           roi bo comment dong duoi
--
--      Nho: mat CRED_ENC_KEY sau buoc 5 = mat sach mat khau, khong khoi phuc duoc.
-- ============================================================================
-- alter table public.denuvo_accounts drop column password;
