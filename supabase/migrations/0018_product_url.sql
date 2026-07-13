-- Site web du produit promu : analysé pour ancrer la stratégie SEO sur le vrai produit (mix reach × produit).
alter table channels add column if not exists product_url text;
