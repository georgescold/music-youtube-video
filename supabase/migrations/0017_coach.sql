-- CRON intelligent : collecte de stats + décisions (warm-up + optimisation du reach).
create table if not exists video_stats (
  id uuid primary key default gen_random_uuid(),
  video_id uuid references videos(id) on delete cascade,
  youtube_video_id text,
  channel_id uuid,
  captured_at timestamptz not null default now(),
  views integer, likes integer, comments integer,
  impressions integer, ctr real, avg_view_pct real, avg_view_sec real, watch_time_min real
);
create index if not exists idx_video_stats_video on video_stats (video_id, captured_at desc);
create index if not exists idx_video_stats_channel on video_stats (channel_id, captured_at desc);

alter table channels add column if not exists coach_enabled boolean not null default false; -- CRON intelligent (analyse + décisions)
alter table channels add column if not exists max_posts_per_day integer not null default 1;  -- plafond de cadence (warm-up monte jusqu'à ce max)
alter table channels add column if not exists coach_state jsonb;                              -- insights + pondérations apprises
alter table channels add column if not exists coach_updated_at timestamptz;

alter table videos add column if not exists published_at timestamptz; -- horodatage de publication (pour analyser les créneaux)
