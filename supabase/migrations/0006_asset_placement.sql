-- Placement PAR pub : chaque asset "ad" a sa propre position/taille sur l'écran (fractions 0..1).
-- Réglé au moment de l'import, modifiable ensuite. La fréquence/durée reste au niveau de la chaîne.
alter table assets add column if not exists placement jsonb;
