-- ============================================================================
--  TUY CHON — day la thu DUY NHAT vá lo hong cu. Khong chay cung khong sao,
--  backend van hoat dong; nhung lo hong thi van mo.
--
--  Lo hong: app 1.0.0 dong goi publishable key va doc thang denuvo_accounts.
--  Key do nam trong app -> ai giai nen app.asar cung dump duoc ca kho tai khoan
--  Steam. File nay cat dut duong do.
--
--  ---------------------------------------------------------------------------
--  DIEU KIEN BAT BUOC TRUOC KHI CHAY
--  ---------------------------------------------------------------------------
--  Backend phai dang dung SERVICE KEY, khong phai publishable key. Vi file nay
--  thu hoi quyen cua `anon`, ma publishable key CHINH LA `anon` -> chay khi
--  backend con dung key do la backend chet cung, app bao "chua co tai khoan
--  kha dung" voi moi game.
--
--    1. Supabase > Project Settings > API Keys > Secret keys  -> copy sb_secret_...
--       (hoac tab Legacy API keys > service_role)
--    2. Deno Deploy > Settings > Environment Variables:
--         SUPABASE_SERVICE_ROLE_KEY = key vua copy
--       -> redeploy
--    3. curl https://<project>.deno.dev/health
--       PHAI thay:  "bao_mat": "da khoa anon"
--       Con thay:   "CHUA VA XONG"  -> DUNG chay file nay.
--    4. Luc do moi chay file nay.
--
--  Backend khong tao bang nao trong Supabase (state nam o Deno KV), nen file
--  nay chi dung toi 2 bang co san.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. denuvo_accounts: xoa SACH moi policy -> anon doc duoc 0 dong
-- ---------------------------------------------------------------------------
alter table public.denuvo_accounts enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'denuvo_accounts'
  loop
    execute format('drop policy %I on public.denuvo_accounts', p.policyname);
  end loop;
end $$;
revoke all on public.denuvo_accounts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. denuvo_requirement: nguon tai cong cu fix, cung khong can public
-- ---------------------------------------------------------------------------
alter table public.denuvo_requirement enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'denuvo_requirement'
  loop
    execute format('drop policy %I on public.denuvo_requirement', p.policyname);
  end loop;
end $$;
revoke all on public.denuvo_requirement from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Xac nhan: ca 2 truy van duoi PHAI tra ve 0 dong
-- ---------------------------------------------------------------------------
select tablename, policyname, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('denuvo_accounts', 'denuvo_requirement');

select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and table_name in ('denuvo_accounts', 'denuvo_requirement');

-- ---------------------------------------------------------------------------
-- LUU Y: 2 bang nay dung chung voi app g4_tool. Sau khi chay file nay,
-- g4_tool se KHONG doc duoc chung nua neu no van dung publishable key.
-- ---------------------------------------------------------------------------
