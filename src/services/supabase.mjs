// Client REST/Storage minimal pour Supabase — sans dependance externe (fetch natif Node 22).

function base() { return process.env.SUPABASE_URL; }
function serviceKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY; }
function headers(extra = {}) {
  const k = serviceKey();
  return { Authorization: `Bearer ${k}`, apikey: k, ...extra };
}

export async function dbSelect(table, query = '') {
  const r = await fetch(`${base()}/rest/v1/${table}${query}`, { headers: headers() });
  if (!r.ok) throw new Error(`select ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function dbInsert(table, rows) {
  const r = await fetch(`${base()}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`insert ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function dbPatch(table, match, patch) {
  const r = await fetch(`${base()}/rest/v1/${table}?${match}`, {
    method: 'PATCH',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error(`patch ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function dbDelete(table, match) {
  const r = await fetch(`${base()}/rest/v1/${table}?${match}`, { method: 'DELETE', headers: headers() });
  if (!r.ok) throw new Error(`delete ${table}: ${r.status} ${await r.text()}`);
}

export async function storageUpload(bucket, path, buffer, contentType) {
  const r = await fetch(`${base()}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': contentType || 'application/octet-stream' }),
    body: buffer
  });
  if (!r.ok) throw new Error(`upload ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function storageSign(bucket, path, expiresIn = 3600) {
  const r = await fetch(`${base()}/storage/v1/object/sign/${bucket}/${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn })
  });
  if (!r.ok) throw new Error(`sign ${path}: ${r.status} ${await r.text()}`);
  const { signedURL } = await r.json();
  return `${base()}/storage/v1${signedURL}`;
}

export async function storageDelete(bucket, paths) {
  const r = await fetch(`${base()}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: paths })
  });
  if (!r.ok) throw new Error(`delete storage: ${r.status} ${await r.text()}`);
}
