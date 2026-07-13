-- Articles de blog du produit (découverts via sitemap) : [{url, title}]. Servent aux liens
-- « À lire aussi » insérés dans les descriptions, matchés au thème de chaque vidéo.
alter table channels add column if not exists blog_articles jsonb;
alter table channels add column if not exists blog_articles_updated_at timestamptz;
