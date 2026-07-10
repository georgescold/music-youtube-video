-- L'émotion (et donc le titre + la musique) est dérivée de l'IMAGE de fond de la vidéo.
-- true = analyse l'image (combo image↔titre↔musique) ; false = utilise la palette dérivée.
alter table channels add column if not exists emotion_from_image boolean not null default true;
