# Au Bon Moment — Studio · Plan d'exécution

> Outil d'automatisation qui, **chaque jour**, crée une vidéo playlist de musique d'amour (~90 min), la soumet à **validation humaine**, puis la publie sur YouTube — au service de l'acquisition **Compaatible**.

Repo cible : `github.com/georgescold/music-youtube-video` · Backend : Railway (env `georgescold`) · DB : Supabase.

---

## 0. Principe directeur

- **YouTube = canal d'acquisition** pour Compaatible (pas un business de vues). On optimise portée + trafic app.
- **L'humain valide avant publication.** Rien ne part en public sans un clic de confirmation. (S'aligne aussi sur la contrainte YouTube : les uploads API sont forcés en privé tant que le projet n'a pas passé l'audit.)
- **Déterministe là où ça compte** (download, montage, upload = testable, fiable) ; **Claude** pour le créatif (curation, titre, description).
- **Zéro secret dans le repo.** Tout en `.env` (git-ignoré) local + variables Railway en prod.

---

## 1. Identité visuelle — système Bestdwell (repris tel quel)

⚠️ **Historique de la correction (2026-07-09)** : V1 "salle de contrôle au crépuscule" (dark + rose framboise + serif romantique) reprenait sans le vouloir la direction artistique du projet *Madame Cupidon* — rejetée. V2 : identité "SaaS épuré" générique (bleu indigo) de mon cru — correcte en esprit mais pas la bonne référence. **V3 (définitive)** : l'utilisateur a demandé de reprendre **le système de design réel du projet [Enzdo/BestDwell](https://github.com/Enzdo/BestDwell)** — pas de fichier `design.md` dans ce repo, la source de vérité est `apps/site/src/styles/global.css` (commentée comme telle), avec une version simplifiée dans `apps/admin/app/globals.css` (leur propre panneau admin). **C'est cette version admin — sans les animations/trames du site marketing — qui a été reprise ici**, car notre outil est de même nature (panneau d'ops interne).

- **Police** : **Manrope** partout (titres et corps — leur système n'a pas de serif du tout ; même leur `--font-serif` pointe vers Manrope). Chargée via Google Fonts (poids 400/500/600/700).
- **Palette — "monochrome chaud", aucun accent coloré** (citation de leur CSS : *"la couleur vient des photos"* — nous n'avons pas de photos, donc palette 100 % neutre) :
  - `--color-paper: #ffffff` (fond de page/cartes) · `--color-soft: #faf8f4` · `--color-soft2: #f2efe9` (zones récessées : vignettes, fond d'auth)
  - `--color-ink: #181715` (texte + **seule couleur "d'accent"** — les actions primaires sont en encre pleine, pas en couleur vive)
  - `--color-mut: #6e6a62` · `--color-mut2: #a6a199` (texte atténué)
  - `--color-rule: #ece9e3` · `--color-rule2: #dedad2` (filets/bordures)
  - Pas de dark mode : leur système fixe `color-scheme: light` sans variante sombre — choix délibéré, repris tel quel.
- **Composants** : boutons/pills `border-radius: 100px` (sélection active = fond `--color-ink` plein, texte papier ; inactif = contour `--color-rule2`) · `.tnum` (`font-variant-numeric: tabular-nums`) pour les chiffres alignés (tailles, dates).
- **Ce qu'on N'a PAS repris** (délibérément, absent de leur propre panneau admin) : la trame quadrillée "blueprint" avec `+` aux intersections, les animations de reveal au scroll (`rise`, `pop`, `radar-scan`…), le cadre `.frame`/`.sec` — tout ça sert leur site marketing/produit consommateur, pas un outil d'ops.
- **Layout** : barre du haut minimale (nom + déconnexion), titre de page fonctionnel, cartes à bordure fine sur fond papier, hiérarchie par taille/poids de police plutôt que par la couleur.
  - **Assets** (fait) : dépôt par glisser-déposer, liste avec aperçu/suppression.
  - **Chansons de référence** (fait) : ajout par lien Spotify (titre auto-récupéré via oEmbed), tags de mood, activer/désactiver, suppression.
  - **Vidéo du jour / file** (à faire) : statut, preview privée YouTube, validation.
  - **Réglages** (à faire) : heure de publication, fond par défaut, base UTM.
- **Ton** : sobre, direct, fonctionnel. Pas d'emoji, pas de dégradé, pas de flourish de marque dans l'outil.

---

## 2. Architecture — un seul service Node (comme reddit-warmup)

```
 music-youtube-video (1 service Railway, 1 process Node toujours actif)
    │
    ├─ Scheduler en mémoire (setTimeout, fenêtre horaire Europe/Paris)
    │     └─ déclenche le pipeline 1×/jour
    │
    ├─ pipeline.mjs — étapes déterministes
    │    ├─ 1. Curation     ─► Claude CLI + Epidemic MCP (search-by-reference + mood/BPM → ~25 titres)
    │    ├─ 2. Download     ─► Epidemic MCP (download_music_track) → MP3 locaux (tmp)
    │    ├─ 3. Montage      ─► FFmpeg (fond + audio concaténé + banderole Compaatible) → MP4 + miniature + tracklist
    │    ├─ 4. Métadonnées  ─► Claude CLI (titre optimisé + description + tags)
    │    ├─ 5. Upload       ─► YouTube API (brouillon PRIVÉ) + miniature
    │    └─ 6. État         ─► Supabase (statut = pending_review) + notification Discord
    │
    └─ panel-server.mjs — sert l'API + le panneau (HTML/JS vanilla, sans framework)
          └─ l'humain revoit (aperçu privé intégré) → Valider ─► YouTube passe en PUBLIC
```

**Changement vs la V1 de ce plan** : après lecture de `reddit-warmup`, on adopte son archi éprouvée — **un seul service Railway**, un seul process Node, scheduler en mémoire (pas de cron séparé), panneau HTML/JS vanilla servi par le même process (pas de Next.js/Vercel : inutile pour un outil interne mono-utilisateur, et ça évite un 2ᵉ fournisseur cloud). On garde **Supabase** (déjà provisionné) plutôt que des fichiers JSON sur volume : le modèle de données (vidéos ↔ pistes ↔ chansons de référence) est relationnel, et Supabase Studio donne une vue/édition gratuite sans rien coder.

Le **MP4 lourd ne va pas en base** : il vit sur YouTube (brouillon privé) ; le panneau le prévisualise via le lien privé. Supabase ne stocke que métadonnées + miniature + liens.

---

## 3. Stack technique

| Élément | Choix | Raison |
|---|---|---|
| Runtime | **Node.js 22 + ESM (.mjs), sans framework** | identique à `reddit-warmup` — zéro build step, déploiement trivial |
| Service | **1 seul process** : panneau HTTP + scheduler + pipeline | reprend `panel-server.mjs` : sert l'UI, expose l'API, arme le run quotidien en mémoire |
| Raisonnement créatif | **Claude Code CLI** (`CLAUDE_CODE_OAUTH_TOKEN`, headless, forfait) | module `claude.mjs` copié/adapté de `reddit-warmup` (spawn, alias de modèle, contournement Windows) |
| Accès musique | **Epidemic MCP** (`/a/mcp-service/mcp`, Bearer) | ton token Pro est scopé MCP |
| Montage | **FFmpeg** (binaire, via `child_process`) | image+audio = léger, rapide, déterministe |
| Base de données | **Supabase (Postgres)** — remplace le JSON-sur-volume de `reddit-warmup` | modèle relationnel (vidéos/pistes/réf.) + Studio gratuit ; déjà provisionné |
| Panneau | **HTML/JS vanilla** (`panel.html`), servi par le même process | pas de Next.js/Vercel : inutile pour un outil mono-utilisateur, un seul fournisseur à gérer |
| Hébergement | **Railway, 1 seul service** | réplique exactement `reddit-warmup` (Dockerfile + railway.json) |
| Notifications | **Discord webhook** (`notify.mjs` adapté) | même pattern que `reddit-warmup` |
| Auth panneau | **email + mot de passe + cookie signé (HMAC)**, 1ᵉʳ compte = propriétaire | pattern exact de `reddit-warmup`, suffisant pour un outil perso |
| CI | **GitHub Actions** (lint + tests) | garde-fou "zéro bug" |

> Repris tel quel de `reddit-warmup` (lu le 2026-07-09) : Dockerfile (`node:22-slim` + `@anthropic-ai/claude-code` épinglé), `railway.json` (builder Dockerfile, restart `ON_FAILURE`), le module `claude.mjs` (spawn + contournement Windows + `--no-session-persistence`), le forçage `TZ=Europe/Paris` (Railway tourne en UTC par défaut), et le seed de données via variable d'env pour ne jamais committer de données sensibles.

---

## 4. Modèle de données (Supabase)

```
videos
  id (uuid, pk) · created_at · status (enum) · scheduled_for
  theme · mood · reference_song_ids (uuid[])
  title · description · tags (text[]) · utm_url
  duration_sec · background_asset · banner_asset
  youtube_video_id · youtube_url · thumbnail_url
  error · attempts

video_tracks               (tracklist détaillée par vidéo)
  id · video_id (fk) · epidemic_track_id · title · artist
  position · start_sec · length_sec

reference_songs            (les "seeds" de style)
  id · spotify_url · title · artist · mood_tags (text[]) · active (bool) · added_at

settings                   (config, 1 ligne)
  daily_publish_time · timezone · target_duration_sec
  default_background · default_banner · utm_base · channel_id

run_logs                   (observabilité)
  id · video_id · step · status · message · created_at

assets                      (pubs/fonds déposés par l'utilisateur via le panneau — ajouté le 2026-07-09)
  id · kind (ad_banner_16x9|ad_clip_9x16|background_image|other)
  filename · storage_path · mime_type · size_bytes · active · uploaded_at · notes
  → fichiers dans le bucket Supabase Storage "assets" (privé, 50 Mo/fichier max, plafond tier gratuit)
```

`status` ∈ `queued · curating · downloading · rendering · uploading · pending_review · approved · published · rejected · failed`.
Sécurité : RLS activé, service_role côté worker uniquement, anon key côté dashboard (lecture + actions via API protégée).

---

## 5. Le pipeline quotidien (étapes)

1. **Choix du thème** — rotation de mood (ou file `queued`), à partir des `reference_songs` actives + `Titres idées.txt`.
2. **Curation** — Claude + Epidemic MCP : `search-by-reference` sur les réfs Spotify + filtres `mood/BPM/instrumental`, assemble ~25 titres pour viser la durée cible (~90 min), variété garantie, pas de doublon.
3. **Download** — `download_music_track` (MP3 haute qualité) → dossier temp.
4. **Audio** — concat FFmpeg avec micro-crossfades ; calcul des timestamps de tracklist.
5. **Vidéo** — fond (image en boucle) + audio + **banderole Compaatible** (overlay discret) → MP4 1080p ; génère la miniature.
6. **Métadonnées** — Claude : titre optimisé (patterns de `Titres idées.txt`), description (hook + tracklist horodatée + lien Compaatible UTM + mots-clés + hashtags), tags.
7. **Upload brouillon** — YouTube `videos.insert` en **privé** (upload résumable) + `thumbnails.set`.
8. **État + notif** — Supabase `pending_review` ; notification (dashboard / e-mail / Discord).
9. **Validation humaine** — dashboard → *Valider* → `videos.update` en `public` (ou planifié) → `published`. *Rejeter* → `rejected` (option : régénérer).

---

## 6. Intégration pub Compaatible — ⚠️ point à trancher

**L'asset actuel** (`Compaatible pub/VID_20260709_122618.mp4`) est **9:16 vertical, 60 s, avec voix off**. C'est un format **Short/Reels**, pas une banderole pour une vidéo **16:9** de 90 min :
- son audio (voix) **entrerait en conflit** avec la musique ;
- en 16:9 il apparaîtrait pillarboxé (bandes noires) ou minuscule.

**Décisions proposées :**
- **In-video (long-format)** : utiliser une **banderole horizontale discrète** — logo + « Rien n'est un hasard · compaatible.app » en lower-third ou coin, statique ou légère boucle, **sans audio**. → *Je peux la générer à partir de la marque Compaatible si tu valides.*
- **Le clip vertical 60 s** → parfait pour la **stratégie Shorts** (découpés/dédiés) et le cross-post Reels/TikTok. On le réutilise là, pas dans le long-format.

---

## 7. Structure du repo

```
music-youtube-video/
├─ src/
│  ├─ panel-server.mjs      # sert panel.html + API + scheduler en mémoire (cœur, comme reddit-warmup)
│  ├─ panel.html            # dashboard vanilla JS (identité visuelle §1)
│  ├─ pipeline.mjs          # orchestration des 6 étapes + gestion d'état
│  ├─ steps/                # curate.mjs, download.mjs, render.mjs, metadata.mjs, upload.mjs
│  ├─ services/             # epidemicMcp.mjs, youtube.mjs, supabase.mjs, ffmpeg.mjs
│  ├─ claude.mjs            # adapté de reddit-warmup (spawn CLI, --no-session-persistence)
│  └─ notify.mjs            # alertes Discord (adapté)
├─ test/                    # unit + integration (mocks)
├─ supabase/
│  └─ migrations/           # schema.sql versionné (§4)
├─ .github/workflows/ci.yml
├─ Dockerfile               # node:22-slim + claude-code épinglé (comme reddit-warmup)
├─ railway.json
├─ .env.example             # (committé, sans valeurs)
└─ PLAN.md · README.md
```

---

## 8. Exécution par phases (chaque phase a un « Definition of Done » testé)

- [ ] **Phase 0 — Preuve locale (0 cloud, 0 post)**
  - Brancher Epidemic MCP, valider le **download réel** (non-preview) via le token Pro.
  - Curation → download → FFmpeg → **1 vraie vidéo MP4 finie** + titre/description, en local.
  - *DoD :* une vidéo lisible de bout en bout, audio propre, banderole visible, tracklist correcte.
- [x] **Phase 1 — Supabase** *(schéma appliqué le 2026-07-09 : `videos`, `video_tracks`, `reference_songs`, `settings`, `run_logs`, RLS activé)*
  - Migrations (tables §4) ✅ · client worker (service_role) — à faire · seed `settings` ✅ (1 ligne par défaut) + réf. Spotify — en attente des liens.
  - *DoD :* CRUD testé, RLS en place.
- [~] **Phase 2 — Upload brouillon + validation**
  - YouTube OAuth (refresh token) ✅ · `services/youtube.mjs` (upload résumable, miniature, suppression) ✅ **testé en conditions réelles** (upload d'un clip synthétique en privé, vérifié, supprimé proprement — chaîne laissée intacte).
  - Dashboard : écran de validation (aperçu + édition + Valider/Rejeter) — à faire.
  - *DoD :* une vidéo test uploadée en privé ✅ · validée depuis l'UI — à faire · passée en public — à faire.
- [ ] **Phase 3 — Cloud (Railway, 1 service)**
  - Réplique infra `reddit-warmup` à l'identique (Dockerfile, railway.json, scheduler en mémoire Europe/Paris), Claude CLI en conteneur, secrets Railway.
  - Push sur `github.com/georgescold/music-youtube-video`.
  - *DoD :* un run quotidien automatique (sans cron externe) produit un brouillon sans intervention.
- [ ] **Phase 4 — Durcissement**
  - **Refresh OAuth Epidemic** (le JWT 30 j expire ~2026-08-07), retries/backoff, alertes d'échec, audit API YouTube (auto-public).
  - *DoD :* résiste à une panne d'API (reprise propre), aucun secret expiré ne bloque en silence.
- [ ] **Phase 5 — Frontend soigné**
  - Historique, stats UTM (PostHog), gestion multi-mood, polish identité visuelle §1.

---

## 9. Stratégie « zéro bug »

- **Tests unitaires** : logique pure (calcul timestamps, ciblage de durée, formatage titre/description, construction UTM).
- **Tests d'intégration mockés** : Epidemic / YouTube / Supabase simulés → on teste l'orchestration sans taper les vraies API.
- **Vérif d'intégration réelle, isolée** avant tout chaînage : (a) download Epidemic OK, (b) upload YouTube OK sur une vidéo test, (c) CRUD Supabase OK.
- **Mode `--dry-run`** : pipeline complet sans publier (par défaut on ne fait que du privé).
- **Idempotence + état** : chaque étape écrit son statut ; reprise possible ; un échec est visible au dashboard, jamais perdu en silence.
- **CI** : lint + `tsc --noEmit` + tests bloquants avant déploiement.
- **Vérif finale** : run complet observé (skill `verify`) avant go-live.

---

## 10. Risques & contraintes (réalistes)

1. **Token Epidemic 30 j** (expire ~2026-08-07) → refresh OAuth requis (Phase 4). Ne bloque pas le dev.
2. **Upload API YouTube forcé privé** jusqu'à l'audit du projet API → cohérent avec « valider avant public » ; auto-public total = après audit.
3. **Fichier 90 min lourd (~1-3 Go)** → on ne le stocke pas en base ; rendu éphémère sur le worker, upload direct YouTube. Dimensionner le conteneur Railway.
4. **Asset pub vertical** (§6) → besoin d'une banderole 16:9 pour le long-format.
5. **Licence Epidemic** : usage playlist confirmé OK (Pro). Valider que le download via MCP est couvert pour cet usage.

---

## 11. État actuel (2026-07-09)

- ✅ Secrets sécurisés dans `.env` git-ignoré (Epidemic MCP, Claude CLI, Supabase, clé API YouTube).
- ✅ **Base Supabase créée** : projet `music-youtube-video`, ref `hbkjgelcqzfmvnfwsxni`, eu-central-1, ACTIVE (schéma pas encore appliqué).
- ✅ **`gh` installé ET déjà authentifié** (compte `georgescold`, scopes repo/workflow) → accès confirmé à `reddit-warmup` + push possible vers `music-youtube-video`.
- ✅ **`reddit-warmup` lu et analysé** → a fait revoir la stack (§2-3-7) : 1 seul service Node/Railway, panneau vanilla, scheduler en mémoire, Supabase à la place du JSON-sur-volume.
- ✅ Clé API YouTube testée (lecture seule) : chaîne trouvée, `channel_id = UCFTSnorznQNfnxMMzq0jY7Q`.
- ✅ ffmpeg / node / claude CLI / railway CLI présents.
- ✅ Asset pub analysé (9:16, 60 s → Shorts, pas adapté au 16:9 long-format).
- ✅ **Schéma Supabase appliqué** (6 tables + RLS, via l'API Management — voir §4).
- ✅ **OAuth YouTube COMPLET ET VÉRIFIÉ** : app passée en publishing status "In production" (plus de limite 7 jours) · refresh token obtenu et confirmé fonctionnel par un vrai appel `channels.list?mine=true` → retourne bien "Rien n'est un hasard." / `UCFTSnorznQNfnxMMzq0jY7Q`, scopes `youtube` + `youtube.upload` accordés. **L'upload vidéo est débloqué.**
- ✅ Vercel CLI confirmé connecté (`loysb2b-4098`), dispo si besoin futur — décision d'usage public différée (architecture actuelle ne bloque aucun scénario).
- ✅ **Panneau de contrôle** (identité Bestdwell, voir §1) : `package.json`, `src/panel-server.mjs`, `src/services/supabase.mjs`, `src/panel.html`, `src/references.html`. Bucket Storage privé `assets` (50 Mo/fichier max) + tables `assets`/`reference_songs`. Deux écrans fonctionnels et **testés de bout en bout par appels HTTP directs** (les outils navigateur claude-in-chrome se sont déconnectés en cours de session — tests via script, pas visuels, à revalider à l'œil dès que le navigateur revient) :
  - **Assets** : glisser-déposer, 4 types, aperçu signé, suppression.
  - **Chansons de référence** : ajout par lien Spotify + auto-fetch du titre (oEmbed), tags de mood, activer/désactiver, suppression, validation des URLs invalides.
  - Tourne actuellement en local sur `http://127.0.0.1:8770` (redémarré depuis, un `git status` a confirmé qu'aucun repo git n'existe encore ici).
- ✅ **`services/youtube.mjs`** (upload résumable, miniature, changement de statut, suppression) — **testé en conditions réelles** : upload d'un clip synthétique (3s, généré par ffmpeg, aucun contenu réel) en `private`, vérifié existant via l'API, supprimé, ré-vérifié absent (0 résultat). La chaîne ne garde aucune trace de ce test.
- ℹ️ Réfs Spotify réelles, image de fond et bannière pub : toujours à déposer par l'utilisateur via le panneau (l'écran existe, en attente de contenu).
- ✅ **Projet Railway créé** (feu vert donné explicitement) : `music-youtube-video`, workspace `georgescold` (id `fa774c03-9dfc-4774-9893-7f20db09795b`), projet id `556766e8-0739-4e83-a6dc-c454d40b72ef`, environnement `production` par défaut. Dossier local lié (`railway status` confirme). **Aucun service/déploiement encore** — pas de code poussé, pas de variables configurées, rien d'exposé publiquement.
- ⏸️ **Toujours volontairement non entamé** : déploiement effectif (exposerait le panneau + ses vrais secrets sur internet) et push GitHub (action visible) — en attente d'un feu vert explicite séparé avant d'y toucher.

### Prochaines actions
1. **Toi** : dire si je configure les variables d'environnement Railway maintenant (secrets déjà dans `.env` local) et/ou si j'initialise + pousse le repo git · sinon, réfs Spotify + image de fond + bannière pub via le panneau (`http://127.0.0.1:8770`).
2. **Moi** : `services/epidemicMcp.mjs` + `services/ffmpeg.mjs` (rendu) · assembler `pipeline.mjs` · écran "Vidéo du jour" (validation) — puis Phase 0 réelle dès que des réfs Spotify existent.
