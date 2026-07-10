// Client MCP minimal pour le serveur Epidemic Sound (transport "Streamable HTTP").
// Sans dependance : JSON-RPC 2.0 sur POST, gestion SSE + Mcp-Session-Id.
// Auth : Bearer EPIDEMIC_JWT (token de compte, scope MCP).

const MCP_URL = () => process.env.EPIDEMIC_MCP_URL || 'https://www.epidemicsound.com/a/mcp-service/mcp';

let sessionId = null;
let nextId = 1;
let initialized = false;

function parseSSE(text) {
  let last = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try {
      const obj = JSON.parse(data);
      if (obj && obj.jsonrpc && (obj.result !== undefined || obj.error !== undefined)) last = obj;
    } catch {}
  }
  return last;
}

async function rpc(method, params, { notification = false } = {}) {
  const body = notification
    ? { jsonrpc: '2.0', method, params: params || {} }
    : { jsonrpc: '2.0', id: nextId++, method, params: params || {} };
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${process.env.EPIDEMIC_JWT}`
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(MCP_URL(), { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (notification) { await res.text().catch(() => {}); return null; }

  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status} ${raw.slice(0, 300)}`);

  let payload;
  if (ct.includes('text/event-stream')) payload = parseSSE(raw);
  else { try { payload = JSON.parse(raw); } catch { payload = null; } }

  if (!payload) throw new Error(`MCP ${method}: reponse illisible (${ct}): ${raw.slice(0, 200)}`);
  if (payload.error) throw new Error(`MCP ${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

export async function ensureInit() {
  if (initialized) return;
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'music-youtube-video', version: '0.1.0' }
  });
  await rpc('notifications/initialized', {}, { notification: true });
  initialized = true;
}

export async function listTools() {
  await ensureInit();
  return rpc('tools/list', {});
}

// Renvoie le resultat brut MCP { content: [...], structuredContent?, isError? }
export async function callToolRaw(name, args) {
  await ensureInit();
  return rpc('tools/call', { name, arguments: args || {} });
}

// Confort : extrait le texte concatene des blocs "text" du resultat.
export async function callTool(name, args) {
  const result = await callToolRaw(name, args);
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  try { return JSON.parse(text); } catch { return text; }
}

export function resetSession() { sessionId = null; initialized = false; nextId = 1; }
