-- Mode de planification de publication : 'auto' (fenêtre horaire + warm-up) ou 'fixed' (créneaux fixés à la main).
-- publish_times accepte désormais des créneaux « HH:MM » (exact) ou « HH:MM-HH:MM » (fourchette).
alter table channels add column if not exists publish_schedule_mode text;
