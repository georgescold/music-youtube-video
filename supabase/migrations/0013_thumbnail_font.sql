-- Choix de la police de la miniature + choix d'écrire (ou non) le titre dessus.
alter table channels add column if not exists thumbnail_font text not null default 'playfair'; -- 'playfair' | 'inter' | 'cormorant'
alter table channels add column if not exists thumbnail_text boolean not null default true;     -- écrire le titre sur la miniature
