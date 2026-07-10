-- Schema initial : pipeline de generation/validation des videos YouTube (Au Bon Moment).

create type video_status as enum (
  'queued', 'curating', 'downloading', 'rendering', 'uploading',
  'pending_review', 'approved', 'published', 'rejected', 'failed'
);

-- Chansons de reference (seeds de style, via Spotify)
create table reference_songs (
  id uuid primary key default gen_random_uuid(),
  spotify_url text not null,
  title text,
  artist text,
  mood_tags text[] not null default '{}',
  active boolean not null default true,
  added_at timestamptz not null default now()
);

-- Reglages globaux (une seule ligne)
create table settings (
  id boolean primary key default true check (id),
  daily_publish_time time not null default '18:00',
  timezone text not null default 'Europe/Paris',
  target_duration_sec integer not null default 5400,
  default_background text,
  default_banner text,
  utm_base text,
  channel_id text
);
insert into settings (id) values (true);

-- Videos generees par le pipeline
create table videos (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status video_status not null default 'queued',
  scheduled_for timestamptz,
  theme text,
  mood text,
  reference_song_ids uuid[] not null default '{}',
  title text,
  description text,
  tags text[] not null default '{}',
  utm_url text,
  duration_sec integer,
  background_asset text,
  banner_asset text,
  youtube_video_id text,
  youtube_url text,
  thumbnail_url text,
  error text,
  attempts integer not null default 0
);

-- Tracklist detaillee par video
create table video_tracks (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  epidemic_track_id text not null,
  title text,
  artist text,
  position integer not null,
  start_sec integer not null,
  length_sec integer not null
);

-- Journal d'observabilite par etape du pipeline
create table run_logs (
  id uuid primary key default gen_random_uuid(),
  video_id uuid references videos(id) on delete cascade,
  step text not null,
  status text not null,
  message text,
  created_at timestamptz not null default now()
);

create index on video_tracks (video_id);
create index on run_logs (video_id);
create index on videos (status);

-- RLS active partout ; aucune policy publique -- seul le service_role (backend) accede aux donnees.
alter table videos enable row level security;
alter table video_tracks enable row level security;
alter table reference_songs enable row level security;
alter table settings enable row level security;
alter table run_logs enable row level security;
