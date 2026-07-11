// Orchestration : reference_songs + assets (Supabase) -> curation -> download -> montage
// -> metadonnees (Claude) -> upload YouTube (brouillon prive) -> etat en base.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dbSelect, dbInsert, dbPatch, dbDelete, storageSign } from './services/supabase.mjs';
import { curatePlaylist, durationSec } from './steps/curate.mjs';
import { downloadAll } from './steps/download.mjs';
import { concatAudio, renderVideo, buildTracklist, probeDuration, generateDefaultBackground, renderThumbnail } from './services/ffmpeg.mjs';
import { generateMetadata } from './steps/metadata.mjs';
import { selectBackgrounds } from './steps/selectBackgrounds.mjs';
import { uploadVideo, setPrivacyStatus, setThumbnail, deleteVideo } from './services/youtube.mjs';
import { getActiveChannel, updateChannel, channelCreds } from './services/channels.mjs';
import { analyzeImage } from './services/vision.mjs';
import { chooseEmotionIndex } from './steps/coach.mjs';
import { sendDiscord, COLORS } from './services/notify.mjs';
import { createEpidemicClient, isEpidemicAuthError, EPIDEMIC_AUTH_MESSAGE } from './services/epidemicMcp.mjs';

const MOODS = ['romantique et doux', 'romantique nostalgique', 'romantique piano', 'romantique nuit', 'romantique acoustique'];

async function fetchAssetFile(asset, dir) {
  const url = await storageSign('assets', asset.storage_path, 600);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const ext = (asset.filename.split('.').pop() || 'bin').toLowerCase();
  const path = join(dir, 'asset-' + asset.id + '.' + ext);
  writeFileSync(path, buf);
  return { path, isVideo: (asset.mime_type || '').startsWith('video') };
}

export async function runPipeline({ targetSec, dryRun = false, dayIndex = 0, titleOverride = '', backgroundAssetId = null, thumbnailAssetId = null, controller, log = () => {} } = {}) {
  const ck = () => { if (controller?.cancelled) throw new Error('cancelled'); }; // point d'annulation entre étapes
  const channel = await getActiveChannel();
  const chanFilter = channel ? `&channel_id=eq.${channel.id}` : '';
  const references = await dbSelect('reference_songs', '?active=eq.true' + chanFilter);
  const assets = await dbSelect('assets', '?active=eq.true' + chanFilter);
  // Sécurité : seuls les vrais médias (image/vidéo) sont utilisables au montage (ex : un .html importé par erreur ferait planter FFmpeg).
  const isMedia = a => /^(image|video)\//.test(a.mime_type || '');
  const backgroundAssets = assets.filter(a => a.kind === 'background' && isMedia(a));
  const adAssets = assets.filter(a => a.kind === 'ad' && isMedia(a));

  // Upload sur le compte YouTube DE LA CHAÎNE ACTIVE (pas le token d'env). Échec clair si pas connectée.
  const ytCreds = channelCreds(channel).youtube;
  if (!dryRun && !ytCreds?.refreshToken) {
    throw new Error("Cette chaîne n'a pas de compte YouTube connecté. Va dans Paramètres → YouTube et connecte SON compte (Refresh token via « ↻ Depuis YouTube » ou autorisation) avant de générer, sinon la vidéo partirait sur une autre chaîne.");
  }

  // Durée cible : tirée au hasard dans la fourchette [min, max] de la chaîne (arrondie à la minute).
  const tMin = channel?.target_min_sec ?? channel?.target_duration_sec ?? 5400;
  const tMax = channel?.target_max_sec ?? channel?.target_duration_sec ?? tMin;
  const lo = Math.min(tMin, tMax), hi = Math.max(tMin, tMax);
  const randomTarget = (Math.floor(lo / 60) + Math.floor(Math.random() * (Math.floor(hi / 60) - Math.floor(lo / 60) + 1))) * 60;
  const target = targetSec || randomTarget;

  const palette = Array.isArray(channel?.emotion_palette) ? channel.emotion_palette : [];

  const [video] = await dbInsert('videos', [{
    status: 'curating', channel_id: channel?.id || null,
    reference_song_ids: references.map(r => r.id)
  }]);
  const vid = video.id;
  const setStatus = (status, extra = {}) => dbPatch('videos', `id=eq.${vid}`, { status, ...extra });
  const logStep = (step, status, message = null) => { log(`[${step}] ${status}${message ? ' — ' + message : ''}`); return dbInsert('run_logs', [{ video_id: vid, step, status, message }]).catch(() => {}); };

  const workDir = join(tmpdir(), 'abm-' + vid);
  mkdirSync(workDir, { recursive: true });
  let youtubeId = null, youtubeUrl = null; // hoisté pour le nettoyage en cas d'annulation

  try {
    // 0. Fonds (anti-répétition) — choisis TÔT car l'image de fond pilote l'émotion.
    const bgVideoAssets = backgroundAssets.filter(a => (a.mime_type || '').startsWith('video'));
    const bgImageAssets = backgroundAssets.filter(a => !(a.mime_type || '').startsWith('video'));
    let chosenBgAssets = backgroundAssets;
    let bgWarning = null; // alerte "pas assez d'images" -> stockée sur la vidéo + Discord
    // Image imposée par l'utilisateur (miniature = image principale = pilote l'émotion). Sinon sélection auto.
    const forcedImg = backgroundAssetId ? bgImageAssets.find(a => a.id === backgroundAssetId) : null;
    if (backgroundAssetId && !forcedImg) await logStep('background', 'warn', 'image de miniature choisie introuvable — sélection auto');
    if (bgImageAssets.length) {
      const sel = await selectBackgrounds({
        channelId: channel?.id, pool: bgImageAssets,
        mode: channel?.background_mode || 'slideshow',
        count: channel?.slideshow_count ?? 0,
        gap: channel?.reuse_gap ?? 30
      });
      let chosen = sel.chosen;
      if (forcedImg) {
        // L'image choisie passe EN TÊTE (1re image => fond principal + base miniature + source d'émotion).
        chosen = (channel?.background_mode === 'single') ? [forcedImg] : [forcedImg, ...chosen.filter(a => a.id !== forcedImg.id)];
        await logStep('background', 'ok', 'miniature imposée : ' + (forcedImg.filename || forcedImg.id));
      } else if (sel.warning) {
        bgWarning = sel.warning;
        await logStep('background', 'warn', sel.warning);
        if (channel?.discord_webhook) sendDiscord(channel.discord_webhook, { title: '⚠️ Images de fond', description: sel.warning, color: COLORS.warn }).catch(() => {});
      }
      chosenBgAssets = [...bgVideoAssets, ...chosen];
    }
    const backgrounds = [];
    for (const a of chosenBgAssets) backgrounds.push(await fetchAssetFile(a, workDir));
    const primaryImagePath = backgrounds.find(b => !b.isVideo)?.path || null;
    ck();

    // Émotion : dérivée de l'IMAGE de fond (combo parfait image ↔ titre ↔ musique), sinon palette dérivée.
    let emotion = null;
    if (primaryImagePath && channel?.emotion_from_image !== false) {
      try {
        await logStep('vision', 'start', 'analyse de l\'image de fond');
        const va = await analyzeImage(primaryImagePath, { token: channelCreds(channel).claudeToken });
        if (va?.emotion) {
          emotion = {
            name: String(va.emotion).trim(),
            description: String(va.situation || '').trim(), // situation émotionnelle ressentie (jamais la scène visuelle)
            keywords: Array.isArray(va.mots_cles_musique) ? va.mots_cles_musique : []
          };
          await logStep('vision', 'ok', 'émotion de l\'image : ' + emotion.name);
        }
      } catch (e) { await logStep('vision', 'warn', e.message); }
    }
    if (!emotion && palette.length) { // repli : palette dérivée (rotation + coach)
      const choice = chooseEmotionIndex({ palette, cursor: channel.emotion_cursor || 0, coachState: channel.coach_state || null, rnd: Math.random() });
      emotion = palette[choice.index];
      await updateChannel(channel.id, { emotion_cursor: (channel.emotion_cursor || 0) + 1 }).catch(() => {});
      if (emotion) await logStep('emotion', 'ok', 'palette : ' + emotion.name);
    }
    const mood = emotion?.name || MOODS[dayIndex % MOODS.length];
    await setStatus('curating', { emotion: emotion?.name || null, mood, theme: mood });
    ck();

    // 1. Curation (pilotée par l'émotion)
    await logStep('curate', 'start');
    // Client Epidemic de la CHAÎNE (jeton stocké dans l'app), pas le token d'env — sinon coller un jeton frais
    // dans l'app ne corrigerait rien (le pipeline resterait sur EPIDEMIC_JWT d'env, potentiellement périmé).
    const epidemicClient = createEpidemicClient({ jwt: channelCreds(channel).epidemicJwt, cookies: channelCreds(channel).epidemicCookies });
    const curation = await curatePlaylist({
      references: references.map(r => ({ spotify_url: r.spotify_url, title: r.title, mood_tags: r.mood_tags })),
      targetSec: target, moodHint: mood, emotion, client: epidemicClient, controller, log
    });
    const { tracks, totalSec } = curation;
    if (!tracks.length) throw new Error('curation vide (aucune chanson de référence exploitable)');
    await logStep('curate', 'ok', `${tracks.length} morceaux, ${Math.round(totalSec / 60)} min`);
    ck();

    // 2. Download
    await setStatus('downloading');
    await logStep('download', 'start');
    const withPaths = await downloadAll(tracks, join(workDir, 'audio'), log, controller, epidemicClient);
    await logStep('download', 'ok');
    ck();

    // 3. Montage
    await setStatus('rendering');
    await logStep('render', 'start');
    const audioPath = await concatAudio(withPaths.map(t => t.path), join(workDir, 'mix.mp3'), { controller });
    const tracklist = buildTracklist(withPaths);
    const ads = [];
    for (const a of adAssets) ads.push({ ...(await fetchAssetFile(a, workDir)), placement: a.placement });
    const outPath = join(workDir, 'video.mp4');
    ck();
    await renderVideo({
      backgrounds, ads, audioPath, outPath, log, controller,
      adFrequencyMin: channel?.ad_frequency_min ?? 10,
      adDurationSec: channel?.ad_duration_sec ?? 8,
      adIntro: channel?.ad_intro !== false,
      adOutro: channel?.ad_outro !== false,
      placement: channel?.ad_placement
    });
    ck();
    const durSec = Math.round(probeDuration(outPath));
    await logStep('render', 'ok', `${Math.round(durSec / 60)} min · fonds:${backgrounds.length} · pubs:${ads.length}`);

    // 4. Tracklist en base
    await dbInsert('video_tracks', withPaths.map((t, i) => ({
      video_id: vid, epidemic_track_id: t.id, title: t.title,
      artist: (t.credits || []).find(c => c.role === 'MAIN_ARTIST')?.artist?.name || null,
      position: i, start_sec: tracklist[i] ? hmsToSec(tracklist[i].stamp) : 0, length_sec: durationSec(t)
    }))).catch(e => logStep('tracks', 'warn', e.message));

    // 5. Metadonnees
    await logStep('metadata', 'start');
    const utmBase = channel?.utm_base || 'https://compaatible.app/';
    const utmUrl = utmBase + (utmBase.includes('?') ? '&' : '?') + 'utm_source=youtube&utm_campaign=aubonmoment&utm_content=' + vid;
    // Historique de la chaîne : titres (dédup), liens internes (maillage), hashtags récents (rotation).
    const prior = await dbSelect('videos', `?title=not.is.null${chanFilter}&select=title,youtube_url,hashtags&order=created_at.desc&limit=200`).catch(() => []);
    const avoidTitles = prior.map(v => v.title).filter(Boolean);
    const internalLinks = prior.filter(v => v.youtube_url).slice(0, 3).map(v => ({ title: v.title, url: v.youtube_url }));
    const recentHashtags = prior.slice(0, 6).flatMap(v => Array.isArray(v.hashtags) ? v.hashtags : []);
    const strategy = {
      objective: channel?.objective, product_desc: channel?.product_desc,
      affiliate_url: channel?.affiliate_url, affiliate_label: channel?.affiliate_label,
      playbook: channel?.playbook
    };
    const meta = await generateMetadata({
      tracklist, mood, utmUrl, avoidTitles, strategy, emotion,
      seoPlan: channel?.seo_plan || null, recentHashtags, internalLinks,
      channelHandle: channel?.yt_handle || '', channelName: channel?.name || '', titleOverride, log
    });
    await logStep('metadata', 'ok', meta.title);

    // 6. Upload YouTube (brouillon prive) — dernier point d'annulation (après, la vidéo est en ligne).
    ck();
    if (!dryRun) {
      await setStatus('uploading');
      await logStep('upload', 'start');
      const uploaded = await uploadVideo({
        filePath: outPath, title: meta.title, description: meta.description,
        tags: meta.tags, privacyStatus: 'unlisted', creds: ytCreds
      });
      youtubeId = uploaded.id;
      youtubeUrl = 'https://www.youtube.com/watch?v=' + youtubeId;
      await logStep('upload', 'ok', youtubeId);
    } else {
      await logStep('upload', 'skip', 'dry-run');
    }

    // 6b. Miniature : image + titre en texte (police embarquée). Activable par chaîne.
    // Image de la miniature : celle CHOISIE par l'utilisateur (thumbnailAssetId, indépendante du fond) si fournie,
    // sinon la 1re image de fond de la vidéo.
    let thumbnailUrl = null;
    let thumbImagePath = backgrounds.find(b => !b.isVideo)?.path || null;
    if (thumbnailAssetId) {
      const tAsset = assets.find(a => a.id === thumbnailAssetId && a.kind === 'background' && (a.mime_type || '').startsWith('image'));
      if (tAsset) { try { thumbImagePath = (await fetchAssetFile(tAsset, workDir)).path; await logStep('thumbnail', 'ok', 'miniature imposée : ' + (tAsset.filename || tAsset.id)); } catch (e) { await logStep('thumbnail', 'warn', 'image miniature illisible : ' + e.message); } }
    }
    if (!dryRun && youtubeId && channel?.thumbnail_enabled !== false && thumbImagePath) {
      try {
        const thumbPath = join(workDir, 'thumbnail.jpg');
        renderThumbnail({
          imagePath: thumbImagePath, title: meta.title, outPath: thumbPath, workDir, log,
          font: channel?.thumbnail_font || 'playfair',
          withText: channel?.thumbnail_text !== false
        });
        await setThumbnail(youtubeId, thumbPath, ytCreds);
        thumbnailUrl = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
        await logStep('thumbnail', 'ok');
      } catch (e) { await logStep('thumbnail', 'warn', e.message); }
    }

    // Mode de publication : "auto" -> passe la vidéo en public ; sinon -> brouillon à valider.
    let finalStatus = 'pending_review';
    if (!dryRun && youtubeId && channel?.publish_mode === 'auto') {
      try { await setPrivacyStatus(youtubeId, 'public', ytCreds); finalStatus = 'published'; await logStep('publish', 'ok', 'public (auto)'); }
      catch (e) { await logStep('publish', 'warn', e.message); }
    }

    await setStatus(finalStatus, {
      title: meta.title, description: meta.description, tags: meta.tags, hashtags: meta.hashtags || [],
      duration_sec: durSec, utm_url: utmUrl, theme: curation.understanding || mood,
      youtube_video_id: youtubeId, youtube_url: youtubeUrl, thumbnail_url: thumbnailUrl,
      published_at: finalStatus === 'published' ? new Date().toISOString() : null,
      background_asset: chosenBgAssets[0]?.id || null, banner_asset: adAssets[0]?.id || null,
      background_asset_ids: chosenBgAssets.map(a => a.id), note: bgWarning
    });
    await logStep('done', 'ok');

    if (channel?.discord_webhook) {
      const published = finalStatus === 'published';
      sendDiscord(channel.discord_webhook, {
        title: published ? '✅ Vidéo publiée' : '📝 Nouveau brouillon à valider',
        description: `**${meta.title}**\n${youtubeUrl || '(dry-run)'}`,
        color: COLORS.ok, url: youtubeUrl || undefined
      }).catch(() => {});
    }
    return { videoId: vid, youtubeId, title: meta.title, status: finalStatus };
  } catch (e) {
    const cancelled = controller?.cancelled || /cancel/i.test(String(e.message || e));
    if (cancelled) {
      // Annulation demandée : on nettoie sans alerter comme un échec. Retire la vidéo YouTube si déjà uploadée.
      if (youtubeId) { await deleteVideo(youtubeId).catch(() => {}); }
      await dbDelete('videos', `id=eq.${vid}`).catch(() => setStatus('cancelled').catch(() => {}));
      await logStep('cancelled', 'ok', 'génération annulée par l\'utilisateur').catch(() => {});
    } else {
      // Jeton Epidemic refusé (401) : message clair + tag 'epidemic_auth' pour la reprise auto au save d'un jeton frais.
      const authErr = isEpidemicAuthError(e);
      const msg = authErr ? EPIDEMIC_AUTH_MESSAGE : String(e.message || e);
      await setStatus('failed', { error: msg, note: authErr ? 'epidemic_auth' : null }).catch(() => {});
      await logStep('error', 'fail', msg);
      if (channel?.discord_webhook) sendDiscord(channel.discord_webhook, { title: authErr ? '🔑 Epidemic déconnecté' : '❌ Échec de génération vidéo', description: msg.slice(0, 800), color: COLORS.error }).catch(() => {});
    }
    throw e;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

function hmsToSec(stamp) {
  const p = stamp.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
