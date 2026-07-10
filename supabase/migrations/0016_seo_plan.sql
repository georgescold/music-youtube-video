-- Plan SEO durable par chaîne + suivi des hashtags par vidéo (pour la rotation/variété).
alter table channels add column if not exists seo_plan jsonb;                 -- {niche_summary, pillars[], primary_keywords[], secondary_keywords[], hashtag_pool[], title_conventions[], cta_ideas[]}
alter table channels add column if not exists seo_plan_updated_at timestamptz;
alter table videos add column if not exists hashtags text[] not null default '{}';
