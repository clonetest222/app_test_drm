-- ============================================================================
--  Bang denuvo_kernel — nguon tai dwmapi.dll (kernel native) cho app only_denuvo.
--
--  App doc bang nay (publishable/anon key, giong denuvo_requirement), tai dwmapi.dll
--  ve <Steam>\bin\dwmapi.dll. Con pattern/ipc toml thi app tai THANG tu GitHub
--  kasakigaming/steam-monitor theo sha256 steamclient (khong nam trong bang nay).
--
--  Chay 1 lan trong Supabase SQL Editor, roi sua URL o cuoi file.
-- ============================================================================

create table if not exists denuvo_kernel (
  id         int primary key default 1,          -- chi dung 1 dong (id=1)
  url        text not null,                       -- link tai dwmapi.dll (GitHub release / Google Drive / direct)
  version    text,                                -- vd "1.0.0" — doi gia tri nay moi lan ra ban kernel moi => app tu cap nhat
  file_type  text default 'direct',               -- 'direct' (dung dll), 'zip' hoac 'rar' (goi co chua dwmapi.dll)
  updated_at timestamptz default now()
);

-- Cho anon/publishable key DOC (app dung key nay doc thang, giong cac bang khac).
alter table denuvo_kernel enable row level security;
drop policy if exists "anon read denuvo_kernel" on denuvo_kernel;
create policy "anon read denuvo_kernel" on denuvo_kernel for select to anon using (true);

-- ---- Dien nguon that: thay URL ben duoi ----
-- Vi du GitHub release asset (link truc tiep, file_type='direct'):
--   https://github.com/<owner>/<repo>/releases/download/v1.0.0/dwmapi.dll
-- Hoac goi zip chua dwmapi.dll (file_type='zip'):
--   https://github.com/<owner>/<repo>/releases/download/v1.0.0/g4kernel.zip
insert into denuvo_kernel (id, url, version, file_type)
values (1, 'https://REPLACE-ME/dwmapi.dll', '1.0.0', 'direct')
on conflict (id) do update
  set url = excluded.url, version = excluded.version,
      file_type = excluded.file_type, updated_at = now();
