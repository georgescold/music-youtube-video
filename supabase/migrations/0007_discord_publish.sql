-- Webhook Discord par chaîne + mode de publication (brouillon+validation OU auto-publish).
alter table channels add column if not exists discord_webhook text;
alter table channels add column if not exists publish_mode text not null default 'review'; -- 'review' | 'auto'
