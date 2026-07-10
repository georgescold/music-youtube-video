-- Miniature générée automatiquement (image de fond + titre en texte), activable par chaîne.
alter table channels add column if not exists thumbnail_enabled boolean not null default true;
