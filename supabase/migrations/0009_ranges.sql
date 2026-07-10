-- Durée cible et heure de génération deviennent des FOURCHETTES : l'algorithme tire au hasard à chaque vidéo.

-- Durée cible : min/max en secondes (initialisés depuis l'ancienne valeur fixe).
alter table channels add column if not exists target_min_sec integer;
alter table channels add column if not exists target_max_sec integer;
update channels set target_min_sec = coalesce(target_min_sec, target_duration_sec, 5400),
                    target_max_sec = coalesce(target_max_sec, target_duration_sec, 5400);

-- Fenêtre horaire de génération : début/fin (initialisés depuis l'ancienne heure fixe).
alter table channels add column if not exists publish_time_start text;
alter table channels add column if not exists publish_time_end text;
update channels set publish_time_start = coalesce(publish_time_start, to_char(daily_publish_time, 'HH24:MI'), '18:00'),
                    publish_time_end   = coalesce(publish_time_end,   to_char(daily_publish_time, 'HH24:MI'), '18:00');
