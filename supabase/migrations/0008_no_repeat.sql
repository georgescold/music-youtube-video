-- Règle anti-répétition : jamais 2× la même image de fond avant 30 vidéos ; jamais 2× le même titre.
-- Mode de fond configurable par chaîne (une image fixe / diaporama).

alter table channels add column if not exists background_mode text not null default 'slideshow'; -- 'single' | 'slideshow'
alter table channels add column if not exists slideshow_count integer not null default 0;         -- 0 = toutes les images éligibles
alter table channels add column if not exists reuse_gap integer not null default 30;               -- nb de vidéos avant de pouvoir réutiliser un fond

-- Traçabilité des fonds réellement utilisés par vidéo (pour la déduplication).
alter table videos add column if not exists background_asset_ids jsonb not null default '[]'::jsonb;

-- Recherche rapide des titres/fonds récents par chaîne.
create index if not exists idx_videos_channel_created on videos (channel_id, created_at desc);
