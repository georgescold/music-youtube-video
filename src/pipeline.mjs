// Orchestration : reference_songs + assets (Supabase) -> curation -> download -> montage
// -> metadonnees (Claude) -> upload YouTube (brouillon prive) -> etat en base.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dbSelect, dbInsert, dbPatch, storageSign } from './services/supabase.mjs';
import { curatePlaylist, durationSec } from './steps/curate.mjs';
import { downloadAll } from './steps/download.mjs';
import { concatAudio, renderVideo, buildTracklist, probeDuration, generateDefaultBackground, renderThumbnail } from './services/ffmpeg.mjs';
import { generateMetadata } from './steps/metadata.mjs';
import { selectBackgrounds } from './steps/selectBackgrounds.mjs';
import { uploadVideo, setPrivacyStatus, setThumbnail } from './services/youtube.mjs';
import { getActiveChannel, updateChannel } from './services/channels.mjs';
import { sendDiscord, COLORS } from './services/notify.mjs';

const MOODS = ['romantique et doux', 'romantique nostalgique', 'romantique piano', 'romantique nuit', 'romantique acoustique'];

async function fetchAssetFile(asset, dir) {
  const url = await storageSign('assets', asset.storage_path, 600);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const ext = (asset.filename.split('.').pop() || 'bin').toLowerCase();
  const path = join(dir, 'asset-' + asset.id + '.' + ext);
  writeFileSync(path, buf);
  return { path, isVideo: (asset.mime_type || '').startsWith('video') };
}

export async function runPipeline({ targetSec, dryRun = false, dayIndex = 0, log = () => {} } = {}) {
  const channel = await getActiveChannel();
  const chanFilter = channel ? `&channel_id=eq.${channel.id}` : '';
  const references = await dbSelect('reference_songs', '?active=eq.true' + chanFilter);
  const assets = await dbSelect('assets', '?active=eq.true' + chanFilter);
  const backgroundAssets = assets.filter(a => a.kind === 'background');
  const adAssets = assets.filter(a => a.kind === 'ad');

  // Durée cible : tirée au hasard dans la fourchette [min, max] de la chaîne (arrondie à la minute).
  const tMin = channel?.target_min_sec ?? channel?.target_duration_sec ?? 5400;
  const tMax = channel?.target_max_sec ?? channel?.target_duration_sec ?? tMin;
  const lo = Math.min(tMin, tMax), hi = Math.max(tMin, tMax);
  const randomTarget = (Math.floor(lo / 60) + Math.floor(Math.random() * (Math.floor(hi / 60) - Math.floor(lo / 60) + 1))) * 60;
  const target = targetSec || randomTarget;

  // Émotion de la vidéo : rotation sans répétition dans la palette dérivée (couvre toute la palette avant de recommencer).
  const palette = Array.isArray(channel?.emotion_palette) ? channel.emotion_palette : [];
  let emotion = null;
  if (palette.length) {
    const idx = (channel.emotion_cursor || 0) % palette.length;
    emotion = palette[idx];
    // On avance le curseur tout de suite (même si le run échoue) pour ne pas rester bloqué sur une émotion.
    await updateChannel(channel.id, { emotion_cursor: idx + 1 }).catch(() => {});
  }
  const mood = emotion?.name || MOODS[dayIndex % MOODS.length];

  const [video] = await dbInsert('videos', [{
    status: 'curating', mood, theme: mood, emotion: emotion?.name || null, channel_id: channel?.id || null,
    reference_song_ids: references.map(r => r.id)
  }]);
  const vid = video.id;
  const setStatus = (status, extra = {}) => dbPatch('videos', `id=eq.${vid}`, { status, ...extra });
  const logStep = (step, status, message = null) => { log(`[${step}] ${status}${message ? ' — ' + message : ''}`); return dbInsert('run_logs', [{ video_id: vid, step, status, message }]).catch(() => {}); };

  const workDir = join(tmpdir(), 'abm-' + vid);
  mkdirSync(workDir, { recursive: true });

  try {
    // 1. Curation
    await logStep('curate', 'start');
    if (emotion) await logStep('emotion', 'ok', emotion.name);
    const curation = await curatePlaylist({
      references: references.map(r => ({ spotify_url: r.spotify_url, title: r.title, mood_tags: r.mood_tags })),
      targetSec: target, moodHint: mood, emotion, log
    });
    const { tracks, totalSec } = curation;
    if (!tracks.length) throw new Error('curation vide (aucune chanson de référence exploitable)');
    await logStep('curate', 'ok', `${tracks.length} morceaux, ${Math.round(totalSec / 60)} min`);

    // 2. Download
    await setStatus('downloading');
    await logStep('download', 'start');
    const withPaths = await downloadAll(tracks, join(workDir, 'audio'), log);
    await logStep('download', 'ok');

    // 3. Montage
    await setStatus('rendering');
    await logStep('render', 'start');
    const audioPath = concatAudio(withPaths.map(t => t.path), join(workDir, 'mix.mp3'));
    const tracklist = buildTracklist(withPaths);

    // Sélection des fonds : jamais réutilisés avant `reuse_gap` vidéos ; mode single/diaporama configurable.
    const bgVideoAssets = backgroundAssets.filter(a => (a.mime_type || '').startsWith('video'));
    const bgImageAssets = backgroundAssets.filter(a => !(a.mime_type || '').startsWith('video'));
    let chosenBgAssets = backgroundAssets;
    if (bgImageAssets.length) {
      const sel = await selectBackgrounds({
        channelId: channel?.id, pool: bgImageAssets,
        mode: channel?.background_mode || 'slideshow',
        count: channel?.slideshow_count ?? 0,
        gap: channel?.reuse_gap ?? 30
      });
      chosenBgAssets = [...bgVideoAssets, ...sel.chosen];
      if (sel.warning) {
        await logStep('background', 'warn', sel.warning);
        if (channel?.discord_webhook) sendDiscord(channel.discord_webhook, { title: '⚠️ Fonds', description: sel.warning, color: COLORS.warn }).catch(() => {});
      }
    }
    const backgrounds = [];
    for (const a of chosenBgAssets) backgrounds.push(await fetchAssetFile(a, workDir));
    const ads = [];
    for (const a of adAssets) ads.push({ ...(await fetchAssetFile(a, workDir)), placement: a.placement });
    const outPath = join(workDir, 'video.mp4');
    renderVideo({
      backgrounds, ads, audioPath, outPath, log,
      adFrequencyMin: channel?.ad_frequency_min ?? 10,
      adDurationSec: channel?.ad_duration_sec ?? 8,
      adIntro: channel?.ad_intro !== false,
      adOutro: channel?.ad_outro !== false,
      placement: channel?.ad_placement
    });
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
    // Titres déjà utilisés sur la chaîne -> jamais réutiliser le même.
    const prior = await dbSelect('videos', `?title=not.is.null${chanFilter}&select=title&order=created_at.desc&limit=200`).catch(() => []);
    const avoidTitles = prior.map(v => v.title).filter(Boolean);
    const strategy = {
      objective: channel?.objective, product_desc: channel?.product_desc,
      affiliate_url: channel?.affiliate_url, affiliate_label: channel?.affiliate_label,
      playbook: channel?.playbook
    };
    const meta = await generateMetadata({ tracklist, mood, utmUrl, avoidTitles, strategy, emotion, channelHandle: channel?.yt_handle || '', channelName: channel?.name || '', log });
    await logStep('metadata', 'ok', meta.title);

    // 6. Upload YouTube (brouillon prive)
    let youtubeId = null, youtubeUrl = null;
    if (!dryRun) {
      await setStatus('uploading');
      await logStep('upload', 'start');
      const uploaded = await uploadVideo({
        filePath: outPath, title: meta.title, description: meta.description,
        tags: meta.tags, privacyStatus: 'private'
      });
      youtubeId = uploaded.id;
      youtubeUrl = 'https://www.youtube.com/watch?v=' + youtubeId;
      await logStep('upload', 'ok', youtubeId);
    } else {
      await logStep('upload', 'skip', 'dry-run');
    }

    // 6b. Miniature : image de fond de la vidéo + titre en texte (police embarquée). Activable par chaîne.
    let thumbnailUrl = null;
    const thumbImagePath = backgrounds.find(b => !b.isVideo)?.path || null;
    if (!dryRun && youtubeId && channel?.thumbnail_enabled !== false && thumbImagePath) {
      try {
        const thumbPath = join(workDir, 'thumbnail.jpg');
        renderThumbnail({
          imagePath: thumbImagePath, title: meta.title, outPath: thumbPath, workDir, log,
          font: channel?.thumbnail_font || 'playfair',
          withText: channel?.thumbnail_text !== false
        });
        await setThumbnail(youtubeId, thumbPath);
        thumbnailUrl = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
        await logStep('thumbnail', 'ok');
      } catch (e) { await logStep('thumbnail', 'warn', e.message); }
    }

    // Mode de publication : "auto" -> passe la vidéo en public ; sinon -> brouillon à valider.
    let finalStatus = 'pending_review';
    if (!dryRun && youtubeId && channel?.publish_mode === 'auto') {
      try { await setPrivacyStatus(youtubeId, 'public'); finalStatus = 'published'; await logStep('publish', 'ok', 'public (auto)'); }
      catch (e) { await logStep('publish', 'warn', e.message); }
    }

    await setStatus(finalStatus, {
      title: meta.title, description: meta.description, tags: meta.tags,
      duration_sec: durSec, utm_url: utmUrl, theme: curation.understanding || mood,
      youtube_video_id: youtubeId, youtube_url: youtubeUrl, thumbnail_url: thumbnailUrl,
      background_asset: chosenBgAssets[0]?.id || null, banner_asset: adAssets[0]?.id || null,
      background_asset_ids: chosenBgAssets.map(a => a.id)
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
    await setStatus('failed', { error: String(e.message || e) }).catch(() => {});
    await logStep('error', 'fail', String(e.message || e));
    if (channel?.discord_webhook) sendDiscord(channel.discord_webhook, { title: '❌ Échec de génération vidéo', description: String(e.message || e).slice(0, 800), color: COLORS.error }).catch(() => {});
    throw e;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

function hmsToSec(stamp) {
  const p = stamp.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
