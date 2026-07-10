-- Deux catégories d'assets claires : "background" (fond) et "ad" (publicité).
-- Le type (image / vidéo / animation) est déduit du mime_type, pas du kind.
alter table assets drop constraint if exists assets_kind_check;
update assets set kind = 'background' where kind = 'background_image';
update assets set kind = 'ad' where kind in ('ad_banner_16x9', 'ad_clip_9x16');
alter table assets add constraint assets_kind_check check (kind in ('background', 'ad', 'other'));

-- Réglages d'apparition des pubs, par chaîne.
alter table channels add column if not exists ad_frequency_min integer not null default 10;
alter table channels add column if not exists ad_duration_sec integer not null default 8;
