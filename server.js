import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HAS_PUBLIC = fs.existsSync(path.join(ROOT, 'public', 'index.html'));
const PUBLIC = HAS_PUBLIC ? path.join(ROOT, 'public') : ROOT;
// When the files sit flat in one folder, don't serve the server's own files
const HIDDEN = HAS_PUBLIC ? new Set() : new Set(['server.js', 'package.json', 'package-lock.json', 'readme.md', '.gitignore', '.env']);
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_DIR = process.env.DATA_DIR || VOLUME || path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'list.json');
const PORT = process.env.PORT || 3000;
const PASSCODE = process.env.PASSCODE || '';
const TOKEN = PASSCODE ? crypto.createHash('sha256').update(PASSCODE).digest('hex').slice(0, 32) : '';

/* ── state ─────────────────────────────────────────────── */
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!VOLUME) {
  console.warn('⚠  NO VOLUME ATTACHED — saving to ' + FILE + ', which is erased on every redeploy.');
  console.warn('⚠  Attach a volume to this service to keep the list.');
} else if (!DATA_DIR.startsWith(VOLUME)) {
  console.warn(`⚠  Volume is mounted at ${VOLUME} but DATA_DIR is ${DATA_DIR} — the list is being saved OUTSIDE the volume and will be erased on redeploy.`);
} else {
  console.log(`✓ Volume mounted at ${VOLUME} — the list persists across deploys.`);
}
let state = { rev: 0, names: { a: 'Me', b: 'You' }, items: [] };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  console.log(`Loaded ${state.items.length} items from ${FILE}`);
} catch {
  console.log(`No list yet — starting fresh at ${FILE}`);
}

let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const tmp = FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state), err => {
      if (err) return console.error('Write failed:', err.message);
      fs.rename(tmp, FILE, e => e && console.error('Rename failed:', e.message));
    });
  }, 250);
}
process.on('SIGTERM', () => {
  try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch {}
  process.exit(0);
});

/* ── ops ───────────────────────────────────────────────── */
const str = (v, n) => String(v ?? '').slice(0, n);
const WHO = new Set(['a', 'b', 'both']);

function clean(raw = {}) {
  return {
    id: str(raw.id, 24) || crypto.randomUUID().slice(0, 12),
    url: /^https?:\/\//i.test(raw.url || '') ? str(raw.url, 2000) : '',
    title: str(raw.title, 200) || 'Untitled',
    note: str(raw.note, 1000),
    price: str(raw.price, 24),
    who: WHO.has(raw.who) ? raw.who : 'a',
    got: !!raw.got,
    group: str(raw.group, 60),
    color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? str(raw.color, 7) : '',
    ts: Number(raw.ts) || Date.now(),
    // Extra links for the same thing. Items saved before this existed get [].
    options: (Array.isArray(raw.options) ? raw.options : [])
      .slice(0, 20)
      .filter(o => o && /^https?:\/\//i.test(o.url || ''))
      .map(o => ({
        id: str(o.id, 24) || crypto.randomUUID().slice(0, 12),
        url: str(o.url, 2000),
        price: str(o.price, 24)
      }))
  };
}

function apply(op) {
  if (op.type === 'add') {
    if (state.items.length >= 500) throw new Error('List is full (500 items)');
    state.items.unshift(clean(op.item));
  } else if (op.type === 'restore') {
    state.items.splice(Math.max(0, Math.min(op.idx | 0, state.items.length)), 0, clean(op.item));
  } else if (op.type === 'update') {
    const i = state.items.findIndex(x => x.id === op.id);
    if (i > -1) state.items[i] = clean({ ...state.items[i], ...op.patch, id: state.items[i].id });
  } else if (op.type === 'delete') {
    state.items = state.items.filter(x => x.id !== op.id);
  } else if (op.type === 'reorder') {
    const ids = Array.isArray(op.ids) ? op.ids.map(x => str(x, 24)) : [];
    const left = new Map(state.items.map(i => [i.id, i]));
    const next = [];
    ids.forEach(id => { const it = left.get(id); if (it) { next.push(it); left.delete(id); } });
    left.forEach(it => next.push(it));   // anything the client didn't mention keeps its place at the end
    state.items = next;
  } else if (op.type === 'regroup') {
    const from = str(op.from, 60), to = str(op.to, 60);
    state.items.forEach(i => { if (i.group === from) i.group = to; });
  } else if (op.type === 'names') {
    state.names = { a: str(op.names?.a, 12) || 'Me', b: str(op.names?.b, 12) || 'You' };
  } else {
    throw new Error('Unknown op');
  }
  state.rev++;
  persist();
}

/* ── http ──────────────────────────────────────────────── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function authed(req) {
  if (!TOKEN) return true;
  const m = /(?:^|;\s*)wl=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function body(req) {
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => res(d));
    req.on('error', rej);
  });
}

const send = (res, code, type, data) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data); };
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));

const LOGIN = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wishlist</title>
<link href="https://fonts.googleapis.com/css2?family=Gloock&family=Karla:wght@400;700&display=swap" rel="stylesheet">
<style>body{background:#E4E7EC;color:#14161A;font-family:Karla,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
form{background:#FBFBFC;border:1.5px solid #14161A;border-radius:4px;padding:26px;width:100%;max-width:340px;box-shadow:0 8px 24px -18px rgba(0,0,0,.5)}
h1{font-family:Gloock,Georgia,serif;font-weight:400;font-size:44px;line-height:1;margin:0 0 8px;letter-spacing:-.02em}
p{margin:0 0 22px;font-size:11px;color:#6C7480;letter-spacing:.18em;text-transform:uppercase}
input{width:100%;font:inherit;font-size:16px;padding:11px 12px;border:1.5px solid #C5CBD4;border-radius:3px;background:#fff;margin:0 0 10px;display:block}
input:focus{outline:none;border-color:#1F4FD8}
button{width:100%;font:inherit;font-size:12px;letter-spacing:.14em;text-transform:uppercase;background:#14161A;color:#E4E7EC;border:0;border-radius:100px;padding:11px;cursor:pointer}
.err{color:#D2166B;font-size:13px;margin:-4px 0 12px;text-transform:none;letter-spacing:0}</style>
<form method="POST" action="/login"><h1>Wishlist</h1><p>Two people only</p>__ERR__
<input type="password" name="passcode" placeholder="Passcode" autofocus autocomplete="current-password">
<button>Open the list</button></form>`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (p === '/login' && req.method === 'POST') {
      const raw = await body(req);
      const given = new URLSearchParams(raw).get('passcode') || '';
      const ok = PASSCODE && crypto.timingSafeEqual(
        crypto.createHash('sha256').update(given).digest(),
        crypto.createHash('sha256').update(PASSCODE).digest()
      );
      if (!ok) return send(res, 401, TYPES['.html'], LOGIN.replace('__ERR__', '<div class="err">That passcode did not match. Try again.</div>'));
      const https = (req.headers['x-forwarded-proto'] || '').includes('https');
      res.writeHead(303, { Location: '/', 'Set-Cookie': `wl=${TOKEN}; HttpOnly; Path=/; SameSite=Lax;${https ? ' Secure;' : ''} Max-Age=31536000` });
      return res.end();
    }

    if (!authed(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'locked' });
      return send(res, 200, TYPES['.html'], LOGIN.replace('__ERR__', ''));
    }

    if (p === '/api/state') return json(res, 200, state);

    if (p === '/api/export') {
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="wishlist-backup-${stamp}.json"`,
        'Cache-Control': 'no-store'
      });
      return res.end(JSON.stringify(state, null, 2));
    }

    if (p === '/api/op' && req.method === 'POST') {
      apply(JSON.parse(await body(req)));
      return json(res, 200, state);
    }

    // static
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'text/plain', 'Nope');
    if (HIDDEN.has(path.basename(file).toLowerCase())) return send(res, 404, 'text/plain', 'Not found');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'text/plain', 'Not found');
      send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', data);
    });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`Wishlist running on :${PORT}`);
  if (!PASSCODE) console.warn('⚠  No PASSCODE set — anyone with the URL can read and edit the list.');
});
