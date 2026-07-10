-- Multi-tenant : une chaîne = un ensemble de credentials + réglages, appartenant à un utilisateur.
-- Les credentials sensibles (yt_client_secret, yt_refresh_token, epidemic_jwt, claude_token) sont
-- CHIFFRÉS au repos par l'application (AES-256-GCM) avant insertion.

create table channels (
  id uuid primary key default gen_random_uuid(),
  user_email text,                 -- propriétaire ; null = chaîne orpheline (à réclamer au 1er login)
  name text not null default 'Ma chaîne',
  is_active boolean not null default false,
  yt_client_id text,
  yt_client_secret text,           -- chiffré
  yt_refresh_token text,           -- chiffré
  yt_channel_id text,
  epidemic_jwt text,               -- chiffré
  claude_token text,               -- chiffré
  daily_publish_time time not null default '18:00',
  target_duration_sec integer not null default 5400,
  utm_base text default 'https://compaatible.app/',
  created_at timestamptz not null default now()
);
create index on channels (user_email);
alter table channels enable row level security;

-- Rattachement des données existantes à une chaîne (nullable le temps du backfill).
alter table videos add column channel_id uuid references channels(id) on delete cascade;
alter table reference_songs add column channel_id uuid references channels(id) on delete cascade;
alter table assets add column channel_id uuid references channels(id) on delete cascade;
create index on videos (channel_id);
create index on reference_songs (channel_id);
create index on assets (channel_id);
