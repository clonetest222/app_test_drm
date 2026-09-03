-- ============================================================
--  G4 Denuvo Tool — 2 bang cap nhat RIENG (tach khoi G4Market Tool).
--  Chay trong Supabase SQL Editor TRUOC khi phat hanh ban dau tien.
--  Vi sao rieng: neu dung chung g4_releases/g4_renderer, app Denuvo se tai
--  installer cua G4Market Tool va ghi de len chinh no.
-- ============================================================

-- 1. Ban cai dat (.exe) — phat ban moi = INSERT 1 dong version cao hon.
--    version : vd "1.1.0"   |   url : link tai G4Denuvo-Setup-x.x.x.exe
--    notes   : changelog, moi dong 1 muc (vd "- Sua loi A\n- Them B")
create table if not exists public.denuvo_releases (
  id          bigint generated always as identity primary key,
  version     text not null,
  url         text not null,
  notes       text,
  mandatory   boolean default false,
  created_at  timestamptz default now()
);

alter table public.denuvo_releases enable row level security;
drop policy if exists "anon read denuvo_releases" on public.denuvo_releases;
create policy "anon read denuvo_releases" on public.denuvo_releases
  for select to anon using (true);

-- 2. Hot-update lop giao dien (index.html + renderer.js + styles.css nen .zip).
--    App tu tai + ap dung NGAY khi mo, KHONG can cai lai installer.
--    version phai LON HON version trong package.json thi moi duoc ap dung.
create table if not exists public.denuvo_renderer (
  id          bigint generated always as identity primary key,
  version     text not null,
  url         text not null,          -- link .zip chua index.html/renderer.js/styles.css
  notes       text,
  created_at  timestamptz default now()
);

alter table public.denuvo_renderer enable row level security;
drop policy if exists "anon read denuvo_renderer" on public.denuvo_renderer;
create policy "anon read denuvo_renderer" on public.denuvo_renderer
  for select to anon using (true);

-- Ghi chu: 2 bang denuvo_requirement + denuvo_accounts DUNG CHUNG voi G4Market Tool,
-- khong can tao lai (app nay doc cung .env / cung project Supabase).
