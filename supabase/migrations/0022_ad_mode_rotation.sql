-- Mode d'affichage par asset publicitaire : 'periodic' (fenêtres intro/fréquence/outro, existant)
-- ou 'constant' (overlay permanent sur toute la durée de la vidéo).
alter table assets add column if not exists ad_mode text default 'periodic';
-- Curseur de rotation des pubs ponctuelles entre vidéos (change l'ordre/le sous-ensemble affiché).
alter table channels add column if not exists ad_cursor integer default 0;
-- Trace TOUTES les pubs (constantes + ponctuelles) réellement utilisées dans le rendu (comme background_asset_ids).
alter table videos add column if not exists banner_asset_ids jsonb;
