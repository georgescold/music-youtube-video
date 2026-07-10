# Au Bon Moment — Studio (`music-youtube-video`)

Outil interne qui génère **chaque jour** une vidéo playlist de musique d'amour (~90 min),
la soumet à **validation humaine**, puis la publie sur la chaîne YouTube *Au Bon Moment* —
au service de l'acquisition **Compaatible**.

## Fonctionnement

1. **Curation** — recherche de morceaux dans le catalogue Epidemic Sound (via son serveur MCP),
   orientée par les *chansons de référence* Spotify configurées dans le panneau.
2. **Montage** — téléchargement MP3 HQ (licence Pro), concaténation + fond + bannière → MP4 (FFmpeg).
3. **Métadonnées** — titre et description optimisés SEO générés par le CLI Claude (forfait).
4. **Upload** — publication en **brouillon privé** sur YouTube (API Data v3, OAuth).
5. **Validation** — relecture dans le panneau, puis passage en public d'un clic.

Un planificateur interne lance l'étape 1→4 une fois par jour ; rien n'est publié sans validation.

## Stack

- Node 22, ESM, **sans framework** — un seul service (panneau HTTP + API + planificateur).
- Base : **Supabase** (Postgres + Storage pour les assets).
- Rendu : **FFmpeg**. Curation/description : **Claude Code CLI**. Musique : **Epidemic Sound MCP**.
- Hébergement : **Railway** (Dockerfile).

## Écrans du panneau

- **Vidéos** — génère, relit, valide/publie ou rejette.
- **Assets** — dépose bannières / clips / images de fond.
- **Chansons de référence** — colle des liens Spotify pour orienter le style.

## Configuration (variables d'environnement)

Voir `.env.example`. Les secrets ne sont jamais commités ; en production ils vivent dans
les variables Railway.

## Développement local

```bash
cp .env.example .env   # puis remplir les valeurs
node src/panel-server.mjs
# http://127.0.0.1:8770
```
