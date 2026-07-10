-- Interrupteur du CRON quotidien par chaîne. Désactivé par défaut : rien ne se génère
-- automatiquement tant que l'utilisateur ne l'active pas explicitement.
alter table channels add column if not exists cron_enabled boolean not null default false;
