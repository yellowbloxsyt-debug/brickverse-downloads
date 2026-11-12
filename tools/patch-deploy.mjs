// Deploys the files in a folder on top of the current live Firebase Hosting release,
// keeping every other live file (icons, downloads, privacy page) as it is.
// Usage (Cloud Shell): node tools/patch-deploy.mjs site [siteId]
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import crypto from 'node:crypto';
import path from 'node:path';

const dir = process.argv[2] || 'site';
const SITE = process.argv[3] || 'brickverse-d9c65';
const API = 'https://firebasehosting.googleapis.com/v1beta1';
const token = execSync('gcloud auth print-access-token').toString().trim();
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-goog-user-project': SITE };

async function call(method, url, body) {
  const r = await fetch(url.startsWith('http') ? url : API + '/' + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(method + ' ' + url + ' -> ' + r.status + ' ' + t);
  return t ? JSON.parse(t) : {};
}

function walk(d, base = d, out = []) {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p, base, out); else out.push(p);
  }
  return out;
}

const rel = await call('GET', `sites/${SITE}/releases?pageSize=1`);
const cur = rel.releases[0].version;
console.log('Live version:', cur.name);

const files = {};
let pageToken = '';
do {
  const r = await call('GET', `${cur.name}/files?pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`);
  for (const f of r.files || []) files[f.path] = f.hash;
  pageToken = r.nextPageToken || '';
} while (pageToken);
console.log('Keeping', Object.keys(files).length, 'live files');

const blobs = {};
for (const p of walk(dir)) {
  const urlPath = '/' + path.relative(dir, p).split(path.sep).join('/');
  const gz = gzipSync(readFileSync(p), { level: 9 });
  const hash = crypto.createHash('sha256').update(gz).digest('hex');
  files[urlPath] = hash; blobs[hash] = gz;
  console.log('New', urlPath, gz.length, 'bytes gz');
}

const ver = await call('POST', `sites/${SITE}/versions`, { config: cur.config || {} });
console.log('Created', ver.name);
const pop = await call('POST', `${ver.name}:populateFiles`, { files });
for (const h of pop.uploadRequiredHashes || []) {
  const r = await fetch(pop.uploadUrl + '/' + h, { method: 'POST', headers: { Authorization: H.Authorization, 'Content-Type': 'application/octet-stream', 'x-goog-user-project': SITE }, body: blobs[h] });
  if (!r.ok) throw new Error('upload ' + h + ' -> ' + r.status + ' ' + await r.text());
  console.log('Uploaded', h.slice(0, 10));
}
await call('PATCH', `${ver.name}?update_mask=status`, { status: 'FINALIZED' });
const out = await call('POST', `sites/${SITE}/releases?versionName=${ver.name}`, { message: 'patch deploy ' + dir });
console.log('RELEASED', out.name);
