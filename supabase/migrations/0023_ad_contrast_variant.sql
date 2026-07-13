-- Variantes de contraste pour une pub : 2 assets partageant le même `variant_group` (nom libre choisi
-- par l'utilisateur) sont considérés comme la MÊME pub, déclinée pour un fond clair et un fond sombre.
-- `contrast_variant` indique pour quel fond CETTE version est prévue : 'for_light_bg' | 'for_dark_bg'.
-- Au moment de générer la vidéo, la luminance du fond choisi est mesurée -> la variante la plus lisible
-- (le meilleur contraste) est sélectionnée automatiquement.
alter table assets add column if not exists variant_group text;
alter table assets add column if not exists contrast_variant text;
