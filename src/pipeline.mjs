// Orchestration : reference_songs + assets (Supabase) -> curation -> download -> montage
// -> metadonnees (Claude) -> upload YouTube (brouillon prive) -> etat en base.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dbSelect, dbInsert, dbPatch, storageSign } from './services/supabase.mjs';
import { curatePlaylist, durationSec } from './steps/curate.mjs';
import { downloadAll } from './steps/download.mjs';
import { concatAudio, renderVideo, buildTracklist, probeDuration, generateDefaultBackground } from './services/ffmpeg.mjs';
import { generateMetadata } from './steps/metadata.mjs';
import { uploadVideo } from './services/youtube.mjs';
import { getActiveChannel } from './services/channels.mjs';

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

  const target = targetSec || channel?.target_duration_sec || 5400;
  const mood = MOODS[dayIndex % MOODS.length];

  const [video] = await dbInsert('videos', [{
    status: 'curating', mood, theme: mood, channel_id: channel?.id || null,
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
    const curation = await curatePlaylist({
      references: references.map(r => ({ spotify_url: r.spotify_url, title: r.title, mood_tags: r.mood_tags })),
      targetSec: target, moodHint: mood, log
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
    const backgrounds = [];
    for (const a of backgroundAssets) backgrounds.push(await fetchAssetFile(a, workDir));
    const ads = [];
    for (const a of adAssets) ads.push(await fetchAssetFile(a, workDir));
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
    const meta = await generateMetadata({ tracklist, mood, utmUrl, log });
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

    await setStatus('pending_review', {
      title: meta.title, description: meta.description, tags: meta.tags,
      duration_sec: durSec, utm_url: utmUrl, theme: curation.understanding || mood,
      youtube_video_id: youtubeId, youtube_url: youtubeUrl,
      background_asset: bgAsset?.id || null, banner_asset: bannerAsset?.id || null
    });
    await logStep('done', 'ok');
    return { videoId: vid, youtubeId, title: meta.title };
  } catch (e) {
    await setStatus('failed', { error: String(e.message || e) }).catch(() => {});
    await logStep('error', 'fail', String(e.message || e));
    throw e;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

function hmsToSec(stamp) {
  const p = stamp.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
