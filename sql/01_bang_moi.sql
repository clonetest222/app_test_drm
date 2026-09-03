-- ============================================================================
--  BUOC 1 — BAT BUOC. Chay truoc khi deploy backend.
--
--  File nay CHI THEM, khong xoa gi:
--    * 3 bang moi backend can (devices / nonce / lease_log)
--    * vai cot phu cho denuvo_accounts (cooldown, dem loi...)
--
--  KHONG dung den policy nao dang co. Sau khi chay, moi thu van chay y nhu cu,
--  app 1.0.0 van hoat dong binh thuong.
--
--  Che do tam thoi: backend dung key `anon` (publishable) -> nen 3 bang moi
--  phai mo quyen cho anon thi backend moi ghi duoc. Day la TAM THOI.
--
--  Khi nao san sang khoa han: chay 02_khoa_anon.sql (can secret key cho backend).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. denuvo_accounts: chi THEM cot, giu nguyen `password` plaintext va moi policy
-- ---------------------------------------------------------------------------
alter table public.denuvo_accounts
  add column if not exists password_enc   text,        -- tuy chon, chi dung neu bat ENCRYPT_AT_REST
  add column if not exists password_iv    text,
  add column if not exists enc_ver        smallint,
  add column if not exists fail_count     int default 0,
  add column if not exists last_used_at   timestamptz,
  add column if not exists cooldown_until timestamptz,
  add column if not exists note           text;

create index if not exists denuvo_accounts_appid_idx
  on public.denuvo_accounts (appid, status);

-- ---------------------------------------------------------------------------
-- 2. denuvo_devices: moi cai dat app = 1 device, co secret rieng de ky request
-- ---------------------------------------------------------------------------
create table if not exists public.denuvo_devices (
  id            uuid primary key default gen_random_uuid(),
  fingerprint   text not null unique,      -- sha256(MachineGuid + hostname + volume serial)
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

-- ---------------------------------------------------------------------------
-- 3. denuvo_nonce: chong replay request da ky
-- ---------------------------------------------------------------------------
create table if not exists public.denuvo_nonce (
  nonce      text primary key,
  device_id  uuid,
  seen_at    timestamptz not null default now()
);
create index if not exists denuvo_nonce_seen_idx on public.denuvo_nonce (seen_at);

-- ---------------------------------------------------------------------------
-- 4. denuvo_lease_log: AUDIT - ai lay credential nao, luc nao, ket qua ra sao
-- ---------------------------------------------------------------------------
create table if not exists public.denuvo_lease_log (
  id          bigint generated always as identity primary key,
  device_id   uuid,
  account_id  bigint,
  appid       text,
  ip          text,
  result      text,                      -- issued | ok | login_fail | no_account | no_password
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists denuvo_lease_log_dev_idx on public.denuvo_lease_log (device_id, created_at desc);
create index if not exists denuvo_lease_log_acc_idx on public.denuvo_lease_log (account_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Bang cap nhat app (khong chua bi mat)
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
-- 6. TAM THOI: mo quyen anon tren 3 bang moi, de backend dung key publishable
--    van ghi duoc. 02_khoa_anon.sql se thu hoi het.
--
--    Trong giai doan nay, ai co publishable key deu co the ghi rac vao 3 bang
--    nay (gia device, xoa dau vet audit). Chap nhan tam, vi lo hong lon hon
--    (dump denuvo_accounts) van dang mo san.
-- ---------------------------------------------------------------------------
alter table public.denuvo_devices   enable row level security;
alter table public.denuvo_nonce     enable row level security;
alter table public.denuvo_lease_log enable row level security;

drop policy if exists "tam anon denuvo_devices" on public.denuvo_devices;
create policy "tam anon denuvo_devices" on public.denuvo_devices
  for all to anon using (true) with check (true);

drop policy if exists "tam anon denuvo_nonce" on public.denuvo_nonce;
create policy "tam anon denuvo_nonce" on public.denuvo_nonce
  for all to anon using (true) with check (true);

drop policy if exists "tam anon denuvo_lease_log" on public.denuvo_lease_log;
create policy "tam anon denuvo_lease_log" on public.denuvo_lease_log
  for all to anon using (true) with check (true);

-- Backend con phai UPDATE denuvo_accounts (cooldown, dem loi). Voi key anon
-- thi can policy update. Chi them neu bang dang co policy cho anon san.
drop policy if exists "tam anon update denuvo_accounts" on public.denuvo_accounts;
create policy "tam anon update denuvo_accounts" on public.denuvo_accounts
  for update to anon using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 7. Don rac dinh ky
-- ---------------------------------------------------------------------------
create or replace function public.denuvo_gc() returns void language sql as $$
  delete from public.denuvo_nonce     where seen_at    < now() - interval '10 minutes';
  delete from public.denuvo_lease_log where created_at < now() - interval '90 days';
$$;
