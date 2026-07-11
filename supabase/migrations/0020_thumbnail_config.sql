-- Réglages de miniature éditables par vidéo (texte / police / position du texte).
alter table videos add column if not exists thumbnail_config jsonb; -- {text, font, posX, posY}
