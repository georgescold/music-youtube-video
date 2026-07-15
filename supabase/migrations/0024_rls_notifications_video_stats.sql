-- Sécurité (Supabase Security Advisor) : ces 2 tables étaient exposées publiquement en lecture/écriture
-- via l'API auto-générée (PostgREST), RLS n'étant pas activé. Le serveur applicatif utilise exclusivement
-- la clé service_role (qui contourne toujours RLS), donc ce fix n'a aucun impact fonctionnel sur l'app —
-- il bloque uniquement l'accès public via la clé anon, qui n'est utilisée nulle part dans ce projet.
alter table public.video_stats enable row level security;
alter table public.notifications enable row level security;
