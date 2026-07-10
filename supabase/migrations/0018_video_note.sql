-- Note/alerte non bloquante sur une vidéo (ex : pas assez d'images de fond pour éviter les doublons).
alter table videos add column if not exists note text;
