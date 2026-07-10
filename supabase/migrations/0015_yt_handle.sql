-- Handle YouTube de la chaîne (@...), récupéré depuis l'API, pour la signature de description dynamique.
alter table channels add column if not exists yt_handle text;
