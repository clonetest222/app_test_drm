-- ============================================================================
--  KIEM TRA — chi doc, khong sua gi. Chay luc nao cung duoc.
--
--  Backend KHONG tao bang nao trong Supabase: thiet bi, nonce, cooldown, audit
--  deu nam trong Deno KV. Supabase chi con duoc DOC (denuvo_accounts,
--  denuvo_requirement, denuvo_releases, denuvo_renderer).
--
--  Nen o day chi con 2 thu dang kiem: tai khoan co du dung khong, va `anon`
--  con doc duoc bang mat khau khong.
-- ============================================================================

-- 1. Dong nao khong co mat khau -> backend se bo qua khi fix
select count(*) as thieu_mat_khau
from public.denuvo_accounts
where coalesce(password, '') = '';

-- 2. Tong quan tung dong (KHONG hien mat khau)
select
  id,
  appid,
  username,
  status,
  (coalesce(password, '') <> '') as co_mat_khau
from public.denuvo_accounts
order by appid, id;

-- 3. LO HONG CU con mo khong?
--    Con dong nao = `anon` (key nam trong app 1.0.0 da phat hanh) VAN doc duoc
--    ca bang mat khau Steam. Muon dong: chay khoa_anon.sql (doc ky dieu kien
--    trong file do truoc).
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('denuvo_accounts', 'denuvo_requirement');

-- 4. RLS da bat chua
select relname as bang, relrowsecurity as rls_bat
from pg_class
where relname in ('denuvo_accounts', 'denuvo_requirement');
