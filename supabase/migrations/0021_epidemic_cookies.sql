-- Auth de session Epidemic par COOKIES (le MCP les accepte ; renouvelable, contrairement au JWT qui expire).
-- Stocké chiffré, partagé entre chaînes (voir SHARED_ACCOUNT).
alter table channels add column if not exists epidemic_cookies text;
