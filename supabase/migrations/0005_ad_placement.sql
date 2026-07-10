-- Placement manuel des pubs : position + taille en fractions de l'écran (0..1), résolution-indépendant.
-- + choix des moments d'affichage (début / fin, en plus de la fréquence périodique).
alter table channels add column if not exists ad_placement jsonb not null default '{"x":0.68,"y":0.55,"w":0.28,"h":0.40}';
alter table channels add column if not exists ad_intro boolean not null default true;
alter table channels add column if not exists ad_outro boolean not null default true;
