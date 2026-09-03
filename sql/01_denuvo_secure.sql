-- ============================================================================
--  G4play Denuvo Manage — SCHEMA BAO MAT (chay trong Supabase SQL Editor)
--
--  Van de cu:  policy cho `anon` DOC duoc denuvo_accounts, ma app lai dong goi
--              publishable key trong .env => bat ky ai giai nen app.asar (30 giay)
--              deu dump duoc TOAN BO tai khoan Steam.
--
--              Van de KHONG phai o chuyen luu plaintext, ma o chuyen AI DOC DUOC.
--
--  Sau khi chay file nay:
--   * anon KHONG con doc duoc bang nao chua credential.
--   * cot `password` GIU NGUYEN plaintext - ban van nhap tay nhu truoc.
--   * app khong con key nao de goi Supabase; moi thu di qua backend Deno.
--   * backend chi nha ra 1 account cho 1 appid, trong phong bi AES-256-GCM,
--     kem device ky HMAC + rate limit + audit log + khoa duoc tung may.
--
--  Thu tu chay:  01_denuvo_secure.sql  ->  02_kiem_tra_ma_hoa.sql (kiem tra lai)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. denuvo_accounts: GIU NGUYEN cot `password` plaintext.
--
--    Ban van them/sua account thang trong Supabase Table Editor nhu truoc.
--    Cai thay doi that su nam o duoi: KHOA anon khoi bang nay. Tu gio chi
--    service_role (backend Deno) doc duoc, va backend chi nha ra dung 1 account
--    cho dung 1 appid, trong phong bi ma hoa.
--
--    3 cot password_enc/password_iv/enc_ver la TUY CHON - chi dung khi sau nay
--    ban bat ENCRYPT_AT_REST=true. De trong cung khong sao.
-- ---------------------------------------------------------------------------
alter table public.denuvo_accounts
  add column if not exists password_enc  text,        -- tuy chon: base64 ciphertext AES-256-GCM
  add column if not exists password_iv   text,        -- tuy chon: base64 IV 12 byte
  add column if not exists enc_ver       smallint,    -- tuy chon: phien ban lop ma hoa
  add column if not exists fail_count    int  default 0,
  add column if not exists last_used_at  timestamptz,
  add column if not exists cooldown_until timestamptz,
  add column if not exists note          text;

create index if not exists denuvo_accounts_appid_idx
  on public.denuvo_accounts (appid, status);

alter table public.denuvo_accounts enable row level security;

-- XOA moi policy cu (bat ke ten) tren bang account - khong de sot policy anon.
-- DAY LA DONG QUAN TRONG NHAT CA FILE: no cat dut duong ma app cu dump ca bang.
do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'denuvo_accounts'
  loop
    execute format('drop policy %I on public.denuvo_accounts', p.policyname);
  end loop;
end $$;

-- Khong tao policy nao => voi RLS bat, anon/authenticated doc duoc 0 dong.
-- Chi service_role (backend Deno) di xuyen duoc RLS.
revoke all on public.denuvo_accounts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. denuvo_requirement: nguon tai cong cu fix — cung khoa anon
--    (link tai cong cu khong phai bi mat lon, nhung khong co ly do de public)
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
-- 3. denuvo_devices: moi cai dat app = 1 device, co secret rieng de ky request
-- ---------------------------------------------------------------------------
create table if not exists public.denuvo_devices (
  id            uuid primary key default gen_random_uuid(),
  fingerprint   text not null unique,      -- sha256(MachineGuid + volume serial)
  secret_enc    text not null,             -- AES-256-GCM cua device_secret
  secret_iv     text not null,
  app_version   text,
  platform      text,
  revoked       boolean not null default false,
  revoke_reason text,
  lease_count   int not null default 0,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  last_ip       text
);
alter table public.denuvo_devices enable row level security;
revoke all on public.denuvo_devices from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. denuvo_nonce: chong replay request da ky (TTL 5 phut)
-- ---------------------------------------------------------------------------
create table if not exists public.denuvo_nonce (
  nonce      text primary key,
  device_id  uuid,
  seen_at    timestamptz not null default now()
);
create index if not exists denuvo_nonce_seen_idx on public.denuvo_nonce (seen_at);
alter table public.denuvo_nonce enable row level security;
revoke all on public.denuvo_nonce from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. denuvo_lease_log: AUDIT — ai lay credential nao, luc nao, ket qua ra sao.
--    Dung de rate limit VA de truy nguoi lam ro ri tai khoan.
-- ---------------------------------------------------------------------------
create table if not exists public.denuvo_lease_log (
  id          bigint generated always as identity primary key,
  device_id   uuid,
  account_id  bigint,
  appid       text,
  ip          text,
  result      text,                      -- issued | ok | login_fail | no_ticket | expired
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists denuvo_lease_log_dev_idx  on public.denuvo_lease_log (device_id, created_at desc);
create index if not exists denuvo_lease_log_acc_idx  on public.denuvo_lease_log (account_id, created_at desc);
alter table public.denuvo_lease_log enable row level security;
revoke all on public.denuvo_lease_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Bang cap nhat: van cho anon doc (khong chua bi mat) — nhung app moi
--    doc qua backend, giu policy nay chi de tuong thich ban cu.
-- ---------------------------------------------------------------------------
create table if not exists public.denuvo_releases (
  id bigint generated always as identity primary key,
  version text not null, url text not null, notes text,
  mandatory boolean default false, created_at timestamptz default now()
);
create table if not exists public.denuvo_renderer (
  id bigint generated always as identity primary key,
  version text not null, url text not null, notes text,
  created_at timestamptz default now()
);
alter table public.denuvo_releases enable row level security;
alter table public.denuvo_renderer enable row level security;
drop policy if exists "anon read denuvo_releases" on public.denuvo_releases;
create policy "anon read denuvo_releases" on public.denuvo_releases for select to anon using (true);
drop policy if exists "anon read denuvo_renderer" on public.denuvo_renderer;
create policy "anon read denuvo_renderer" on public.denuvo_renderer for select to anon using (true);

-- ---------------------------------------------------------------------------
-- 7. Don rac dinh ky (goi tay hoac pg_cron)
-- ---------------------------------------------------------------------------
create or replace function public.denuvo_gc() returns void language sql as $$
  delete from public.denuvo_nonce     where seen_at   < now() - interval '10 minutes';
  delete from public.denuvo_lease_log where created_at < now() - interval '90 days';
$$;
