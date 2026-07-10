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

export function createEpidemicClient(jwt, url) {
  let sessionId = null, nextId = 1, initialized = false;

  async function rpc(method, params, { notification = false } = {}) {
    const token = jwt || process.env.EPIDEMIC_JWT;
    const endpoint = url || process.env.EPIDEMIC_MCP_URL || DEFAULT_URL;
    const body = notification ? { jsonrpc: '2.0', method, params: params || {} } : { jsonrpc: '2.0', id: nextId++, method, params: params || {} };
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Authorization': `Bearer ${token}` };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (notification) { await res.text().catch(() => {}); return null; }

    const ct = res.headers.get('content-type') || '';
    const raw = await res.text();
    if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status} ${raw.slice(0, 300)}`);
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

// Client par défaut (lazy) basé sur l'env — pour la compat mono-tenant existante.
let _default;
function def() { return (_default ||= createEpidemicClient()); }
export const listTools = (...a) => def().listTools(...a);
export const callTool = (...a) => def().callTool(...a);
export const callToolRaw = (...a) => def().callToolRaw(...a);
export function resetSession() { _default = undefined; }
