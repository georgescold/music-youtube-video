-- Palette d'émotions dérivée des exemples ; chaque vidéo est ancrée sur UNE émotion (rotation sans répétition).
alter table channels add column if not exists emotion_palette jsonb not null default '[]'::jsonb; -- [{name, description, keywords[]}]
alter table channels add column if not exists emotion_cursor integer not null default 0;          -- position de rotation
alter table channels add column if not exists emotion_palette_updated_at timestamptz;
alter table videos add column if not exists emotion text;                                          -- émotion de la vidéo
