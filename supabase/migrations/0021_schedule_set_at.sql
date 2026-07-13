-- Horodatage du (re)réglage du planning : le cerveau ne rattrape pas les créneaux déjà passés à cet instant.
alter table channels add column if not exists schedule_set_at timestamptz;
