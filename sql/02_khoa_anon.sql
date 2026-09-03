-- ============================================================================
--  BUOC 2 — DAY MOI LA THU VA LO HONG. Chay khi da san sang.
--
--  DIEU KIEN TRUOC KHI CHAY:
--    backend phai co SUPABASE_SERVICE_ROLE_KEY (hoac SUPABASE_SECRET_KEY).
--    Lay o Supabase > Project Settings > API Keys > Secret keys (sb_secret_...)
--    hoac tab Legacy API keys > service_role.
--
--  CHAY KHI CHUA DAT KEY DO = BACKEND CHET NGAY: no dang dung key `anon`, ma
--  file nay thu hoi het quyen cua anon. App se bao "chua co tai khoan kha dung"
--  voi moi game. Kiem tra truoc bang:
--
--      curl https://<project>.deno.dev/health
--
--  Phai thay "bao_mat": "da khoa anon" thi moi dung. Neu con thay
--  "CHUA VA XONG - dang dung key anon" thi DUNG chay file nay.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. denuvo_accounts: xoa SACH moi policy, ke ca policy tam o buoc 1.
--    Day la dong cat dut duong ma app 1.0.0 dump ca bang mat khau Steam.
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
-- 3. Thu hoi quyen tam tren 3 bang cua backend
--    (khong con ai ngoai service_role ghi duoc -> khong gia device, khong xoa
--     duoc dau vet audit)
-- ---------------------------------------------------------------------------
drop policy if exists "tam anon denuvo_devices"   on public.denuvo_devices;
drop policy if exists "tam anon denuvo_nonce"     on public.denuvo_nonce;
drop policy if exists "tam anon denuvo_lease_log" on public.denuvo_lease_log;

revoke all on public.denuvo_devices   from anon, authenticated;
revoke all on public.denuvo_nonce     from anon, authenticated;
revoke all on public.denuvo_lease_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Xac nhan: ca 2 truy van duoi PHAI tra ve 0 dong
-- ---------------------------------------------------------------------------
select tablename, policyname, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('denuvo_accounts', 'denuvo_requirement',
                    'denuvo_devices', 'denuvo_nonce', 'denuvo_lease_log');

select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and table_name in ('denuvo_accounts', 'denuvo_requirement',
                     'denuvo_devices', 'denuvo_nonce', 'denuvo_lease_log');
