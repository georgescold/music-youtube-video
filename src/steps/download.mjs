// Telechargement des morceaux selectionnes (MP3 HQ) via le MCP Epidemic.
import { callTool as defaultCallTool } from '../services/epidemicMcp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export async function downloadTrack(recording, dir, call = defaultCallTool) {
  const dl = await call('DownloadRecording', { id: recording.id, options: { fileType: 'MP3', stemType: 'FULL' } });
  const url = dl?.data?.recordingDownload?.assetUrl || dl?.recordingDownload?.assetUrl || dl?.assetUrl;
  if (!url) throw new Error('pas d assetUrl pour ' + recording.id);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const path = join(dir, recording.id + '.mp3');
  writeFileSync(path, buf);
  return path;
}

export async function downloadAll(recordings, dir, log = () => {}, controller = null, client = null) {
  mkdirSync(dir, { recursive: true });
  const call = client?.callTool || defaultCallTool;
  const out = [];
  for (let i = 0; i < recordings.length; i++) {
    if (controller?.cancelled) throw new Error('cancelled'); // annulation entre deux morceaux
    const rec = recordings[i];
    const path = await downloadTrack(rec, dir, call);
    out.push({ ...rec, path });
    log(`téléchargement ${i + 1}/${recordings.length} : ${rec.title}`);
  }
  return out;
}
