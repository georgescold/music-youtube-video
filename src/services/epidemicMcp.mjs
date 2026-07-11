// Client MCP Epidemic Sound (transport "Streamable HTTP", JSON-RPC 2.0 + SSE + Mcp-Session-Id).
// Multi-tenant : createEpidemicClient(jwt) crée un client isolé (sa propre session) pour une chaîne donnée.
// Un client par défaut (lazy, basé sur EPIDEMIC_JWT de l'env) reste exporté pour la compat mono-tenant.

const DEFAULT_URL = 'https://www.epidemicsound.com/a/mcp-service/mcp';

function parseSSE(text) {
  let last = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try { const obj = JSON.parse(data); if (obj && obj.jsonrpc && (obj.result !== undefined || obj.error !== undefined)) last = obj; } catch {}
  }
  return last;
}

// Convertit des cookies (chaîne "name=value; …", array Playwright/JSON, ou Netscape) en Map name->value
// pour le domaine epidemicsound.com. Robuste aux différents formats d'export/stockage.
export function cookiesToJar(cookies) {
  const jar = new Map();
  if (!cookies) return jar;
  if (typeof cookies === 'string') {
    const s = cookies.trim();
    if (s.startsWith('[')) { try { return cookiesToJar(JSON.parse(s)); } catch { return jar; } }
    if (s.includes('\t') || s.startsWith('#')) { // Netscape
      for (const l of s.split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const f = l.split('\t'); if (f.length >= 7 && f[0].includes('epidemicsound.com')) jar.set(f[5], f.slice(6).join('\t')); }
      return jar;
    }
    for (const part of s.split(';')) { const i = part.indexOf('='); if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim()); } // en-tête Cookie
    return jar;
  }
  if (Array.isArray(cookies)) { for (const c of cookies) if (c?.name && (!c.domain || String(c.domain).includes('epidemicsound.com'))) jar.set(c.name, c.value); }
  return jar;
}

// auth : soit une chaîne (JWT, rétro-compat), soit { jwt, cookies }. Les cookies priment (auth de session,
// renouvelable, prouvée fonctionnelle) ; sinon on retombe sur le Bearer JWT.
export function createEpidemicClient(auth, url) {
  const opts = (auth && typeof auth === 'object') ? auth : { jwt: auth };
  let sessionId = null, nextId = 1, initialized = false;
  const jar = cookiesToJar(opts.cookies); // pot à cookies : absorbe les Set-Cookie (affinité load-balancer)
  const useCookies = jar.size > 0;

  function absorbSetCookie(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of list) { const seg = line.split(';')[0]; const i = seg.indexOf('='); if (i > 0) jar.set(seg.slice(0, i).trim(), seg.slice(i + 1).trim()); }
  }

  async function rpc(method, params, { notification = false } = {}) {
    const token = opts.jwt || process.env.EPIDEMIC_JWT;
    const endpoint = url || process.env.EPIDEMIC_MCP_URL || DEFAULT_URL;
    const body = notification ? { jsonrpc: '2.0', method, params: params || {} } : { jsonrpc: '2.0', id: nextId++, method, params: params || {} };
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (useCookies) headers['Cookie'] = [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
    else headers['Authorization'] = `Bearer ${token}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (useCookies) absorbSetCookie(res);
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (notification) { await res.text().catch(() => {}); return null; }

    const ct = res.headers.get('content-type') || '';
    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(`MCP ${method}: HTTP ${res.status} ${raw.slice(0, 300)}`);
      if (res.status === 401 || res.status === 403) err.code = 'EPIDEMIC_AUTH';
      throw err;
    }
    const payload = ct.includes('text/event-stream') ? parseSSE(raw) : (() => { try { return JSON.parse(raw); } catch { return null; } })();
    if (!payload) throw new Error(`MCP ${method}: réponse illisible (${ct}): ${raw.slice(0, 200)}`);
    if (payload.error) throw new Error(`MCP ${method}: ${JSON.stringify(payload.error)}`);
    return payload.result;
  }

  async function ensureInit() {
    if (initialized) return;
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'music-youtube-video', version: '0.1.0' } });
    await rpc('notifications/initialized', {}, { notification: true });
    initialized = true;
  }
  async function listTools() { await ensureInit(); return rpc('tools/list', {}); }
  async function callToolRaw(name, args) { await ensureInit(); return rpc('tools/call', { name, arguments: args || {} }); }
  async function callTool(name, args) {
    const result = await callToolRaw(name, args);
    if (result?.structuredContent) return result.structuredContent;
    const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    try { return JSON.parse(text); } catch { return text; }
  }
  return { listTools, callTool, callToolRaw, ensureInit };
}

// Message clair + détection d'une erreur d'authentification Epidemic (jeton expiré / session fermée).
export const EPIDEMIC_AUTH_MESSAGE = 'Epidemic Sound : jeton refusé (401). Le jeton a expiré ou la session Epidemic a été fermée. Va dans Paramètres → Epidemic Sound et colle un jeton frais, puis relance.';
export function isEpidemicAuthError(e) {
  return e?.code === 'EPIDEMIC_AUTH' || /HTTP 40[13]\b/.test(String(e?.message || ''));
}

// Client par défaut (lazy) basé sur l'env — pour la compat mono-tenant existante.
let _default;
function def() { return (_default ||= createEpidemicClient()); }
export const listTools = (...a) => def().listTools(...a);
export const callTool = (...a) => def().callTool(...a);
export const callToolRaw = (...a) => def().callToolRaw(...a);
export function resetSession() { _default = undefined; }
