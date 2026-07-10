-- Assets deposes par l'utilisateur (pubs Compaatible, fonds video, etc.) via le panneau.

create table assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('ad_banner_16x9', 'ad_clip_9x16', 'background_image', 'other')),
  filename text not null,
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  active boolean not null default true,
  uploaded_at timestamptz not null default now(),
  notes text
);

create index on assets (kind);
alter table assets enable row level security;
