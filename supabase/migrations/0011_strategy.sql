-- Phase 2 : stratégie de la chaîne + playbook d'inspiration.
alter table channels add column if not exists objective text;            -- objectif de la chaîne (2e personne, émotion visée...)
alter table channels add column if not exists product_desc text;         -- description du produit à promouvoir (Compaatible)
alter table channels add column if not exists affiliate_url text;        -- lien d'affiliation mis en avant dans la description
alter table channels add column if not exists affiliate_label text;      -- libellé du lien (CTA)
alter table channels add column if not exists inspiration_urls jsonb not null default '[]'::jsonb; -- chaînes YouTube d'inspiration
alter table channels add column if not exists playbook jsonb;            -- patterns extraits (titres/miniatures/hooks)
alter table channels add column if not exists playbook_updated_at timestamptz;
