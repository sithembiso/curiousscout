/* ==========================================================================
   StarTube server — a Cloudflare Worker that lets kids share videos safely.

   The rules, because the audience is 3 to 10 years old:

   * NOTHING is public until a grown-up approves it. Every upload lands in a
     review queue that only the holder of ADMIN_KEY can see.
   * No accounts, no names, no messages. Channels are made-up names picked
     from word lists on the device; titles and descriptions are checked for
     links, emails and phone numbers on the way in (and then by a person).
   * No comments between children — only a handful of emoji "cheers".
   * One report hides a video at once, until a grown-up looks at it again.
   * Rate limits per connection, keyed by a salted hash of the IP address —
     the address itself is never stored.

   Storage: R2 bucket VIDEOS (the files and their thumbnails), D1 database DB
   (everything else; see schema.sql). Secrets: ADMIN_KEY. Vars:
   ALLOWED_ORIGINS (comma-separated, or *). Setup steps are in README.md.

   It also keeps the site-wide play counter (see "plays" below), because it
   already has a database — that part has nothing to do with videos.
   ========================================================================== */

const MAX_VIDEO = 95 * 1024 * 1024;      // Workers accept request bodies up to 100 MB
const MAX_THUMB = 300 * 1024;
const MAX_SECONDS = 5 * 60;
const UPLOADS_PER_DAY = 3;               // per connection
const REPORTS_PER_DAY = 10;
const CHEERS_PER_DAY = 200;
const PLAYS_PER_DAY = 100;               // per connection, all games together — a school shares one address
const MAX_GAMES = 100;                   // stops anyone filling the plays table with made-up game names
const CHEERS = ['star', 'clap', 'laugh', 'heart', 'rocket'];
const TYPES = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };

/* ------------------------------------------------------------- helpers */

function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const ok = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Token, Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});
const fail = (status, error) => json({ error }, status);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two secrets without leaking how much of them matched. */
async function sameSecret(a, b) {
  if (!a || !b) return false;
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

function isAdmin(req, env) {
  const h = req.headers.get('Authorization') || '';
  return sameSecret(h.replace(/^Bearer\s+/i, ''), env.ADMIN_KEY);
}

const randomId = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const today = () => new Date().toISOString().slice(0, 10);

/** Count one more of `what` for this connection today; false once over `max`. */
async function underLimit(req, env, what, max) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const key = what + ':' + today() + ':' + (await sha256((env.HASH_SALT || env.ADMIN_KEY || '') + ip)).slice(0, 32);
  const row = await env.DB.prepare(
    'INSERT INTO limits (k, n, day) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(key, today()).first();
  return row.n <= max;
}

/** Text a child typed: trimmed, short, and with no way to reach anyone. */
function cleanText(s, max) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  if (/(https?:|www\.|\.(com|net|org|co|io|za|uk|tv|me)\b)/i.test(s)) return { bad: 'Please leave out links.' };
  if (/[^\s@]+@[^\s@]+/.test(s)) return { bad: 'Please leave out email addresses.' };
  if ((s.match(/\d/g) || []).length >= 7) return { bad: 'Please leave out phone numbers.' };
  return { text: s };
}

/** Channel names come from the app's word lists: two words and a number. */
const CHANNEL_RE = /^[A-Z][a-z]+ [A-Z][a-z]+ \d{1,3}$/;

const publicFields = 'id, title, descr, channel, dur, created, views, cheers';

/* ------------------------------------------------------------- routes */

async function listPublic(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${publicFields} FROM videos WHERE status = 'public' ORDER BY approved DESC LIMIT 300`
  ).all();
  return json({ videos: results.map(v => ({ ...v, cheers: JSON.parse(v.cheers || '{}') })) });
}

async function createVideo(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return fail(400, 'Bad request'); }
  if (body.grownup !== true) return fail(400, 'A grown-up has to say yes first.');
  const title = cleanText(body.title, 90), descr = cleanText(body.descr, 400);
  if (title.bad || descr.bad) return fail(400, title.bad || descr.bad);
  if (!title.text) return fail(400, 'Your video needs a title.');
  if (!CHANNEL_RE.test(body.channel || '')) return fail(400, 'Bad channel name');
  const dur = Number(body.dur);
  if (!(dur > 0 && dur <= MAX_SECONDS + 1)) return fail(400, 'Videos can be up to 5 minutes long.');
  const ext = body.type in TYPES ? body.type : null;
  if (!ext) return fail(400, 'Use an MP4, WebM or MOV video.');
  const size = Number(body.size);
  if (!(size > 0 && size <= MAX_VIDEO)) return fail(400, 'That video is too big (95 MB max).');
  // The thumbnail arrives as a JPEG data URL made on the device.
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.thumb || '');
  if (!m) return fail(400, 'Bad thumbnail');
  const thumb = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
  if (thumb.length > MAX_THUMB || thumb[0] !== 0xff || thumb[1] !== 0xd8) return fail(400, 'Bad thumbnail');

  if (!(await underLimit(req, env, 'upload', UPLOADS_PER_DAY))) return fail(429, 'That\'s 3 videos today — come back tomorrow!');

  const id = randomId(10), token = randomId(24);
  await env.VIDEOS.put('thumb/' + id + '.jpg', thumb, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare(
    `INSERT INTO videos (id, title, descr, channel, dur, size, type, status, created, token_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'uploading', ?8, ?9)`
  ).bind(id, title.text, descr.text, body.channel, dur, size, ext, Date.now(), await sha256(token)).run();
  return json({ id, token });
}

/** The file itself, streamed straight into R2. */
async function putFile(req, env, id) {
  const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?1').bind(id).first();
  if (!v || v.status !== 'uploading') return fail(404, 'Not found');
  if (!(await sameSecret(await sha256(req.headers.get('X-Token') || ''), v.token_hash))) return fail(403, 'Not yours');
  const len = Number(req.headers.get('Content-Length'));
  if (!(len > 0 && len <= MAX_VIDEO) || !req.body) return fail(400, 'That video is too big (95 MB max).');
  const key = 'video/' + id + '.' + v.type;
  await env.VIDEOS.put(key, req.body, { httpMetadata: { contentType: TYPES[v.type] } });
  // Check it really is a video by its first bytes, not by what it claims.
  const head = await env.VIDEOS.get(key, { range: { offset: 0, length: 16 } });
  const b = new Uint8Array(await head.arrayBuffer());
  const isMp4 = b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;      // ....ftyp
  const isWebm = b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  if (!(v.type === 'webm' ? isWebm : isMp4)) {
    await removeVideo(env, v);
    return fail(400, 'That file isn\'t a video StarTube can play.');
  }
  await env.DB.prepare(`UPDATE videos SET status = 'pending' WHERE id = ?1`).bind(id).run();
  return json({ ok: true, status: 'pending' });
}

async function removeVideo(env, v) {
  await env.VIDEOS.delete(['video/' + v.id + '.' + v.type, 'thumb/' + v.id + '.jpg']);
  await env.DB.prepare('DELETE FROM videos WHERE id = ?1').bind(v.id).run();
}

/** Serve a file. Public videos to anyone; anything else only to the admin. */
async function serve(req, env, id, what) {
  const v = await env.DB.prepare('SELECT id, type, status FROM videos WHERE id = ?1').bind(id).first();
  if (!v) return fail(404, 'Not found');
  if (v.status !== 'public' && !(await isAdmin(req, env))) return fail(404, 'Not found');
  const key = what === 'thumb' ? 'thumb/' + id + '.jpg' : 'video/' + id + '.' + v.type;
  const range = req.headers.get('Range');
  const obj = await env.VIDEOS.get(key, range ? { range: req.headers } : {});
  if (!obj) return fail(404, 'Not found');
  const h = new Headers();
  h.set('Content-Type', what === 'thumb' ? 'image/jpeg' : TYPES[v.type]);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Disposition', 'inline');
  h.set('Accept-Ranges', 'bytes');
  h.set('Cache-Control', v.status === 'public' ? 'public, max-age=3600' : 'no-store');
  if (range && obj.range) {
    const start = obj.range.offset ?? 0, len = obj.range.length ?? (obj.size - start);
    h.set('Content-Range', `bytes ${start}-${start + len - 1}/${obj.size}`);
    h.set('Content-Length', String(len));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set('Content-Length', String(obj.size));
  return new Response(obj.body, { headers: h });
}

/** The uploader (holding the token) can see where their video is up to, or delete it. */
async function mine(req, env, id, del) {
  const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?1').bind(id).first();
  if (!v) return json({ status: 'gone' });
  if (!(await sameSecret(await sha256(req.headers.get('X-Token') || ''), v.token_hash))) return fail(403, 'Not yours');
  if (del) { await removeVideo(env, v); return json({ ok: true }); }
  return json({ status: v.status === 'reported' ? 'pending' : v.status, views: v.views, cheers: JSON.parse(v.cheers || '{}') });
}

async function view(env, id) {
  await env.DB.prepare(`UPDATE videos SET views = views + 1 WHERE id = ?1 AND status = 'public'`).bind(id).run();
  return json({ ok: true });
}

async function cheer(req, env, id) {
  let body; try { body = await req.json(); } catch (e) { return fail(400, 'Bad request'); }
  if (!CHEERS.includes(body.kind)) return fail(400, 'Bad cheer');
  if (!(await underLimit(req, env, 'cheer', CHEERS_PER_DAY))) return fail(429, 'Lots of cheering today!');
  await env.DB.prepare(
    `UPDATE videos SET cheers = json_set(cheers, '$.' || ?2, coalesce(json_extract(cheers, '$.' || ?2), 0) + 1)
     WHERE id = ?1 AND status = 'public'`
  ).bind(id, body.kind).run();
  return json({ ok: true });
}

/** One report is enough to take a video down until a grown-up checks it. */
async function report(req, env, id) {
  let body; try { body = await req.json(); } catch (e) { body = {}; }
  if (!(await underLimit(req, env, 'report', REPORTS_PER_DAY))) return fail(429, 'Thanks — we\'ve got your reports.');
  const why = cleanText(body.reason, 60).text || 'other';
  await env.DB.prepare(
    `UPDATE videos SET status = 'reported', reports = reports + 1, report_why = ?2 WHERE id = ?1 AND status = 'public'`
  ).bind(id, why).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------- plays */

/* The play counter for the whole CuriousScout site, shown on the landing page.
   analytics.js counts one play per visit, once a game has been open for a
   little while. Game names are the game's directory name, e.g. "math mine". */
const GAME_RE = /^[a-z0-9][a-z0-9 -]{0,39}$/;

async function listPlays(env) {
  const { results } = await env.DB.prepare('SELECT game, n FROM plays').all();
  const plays = {};
  let total = 0;
  for (const r of results) { plays[r.game] = r.n; total += r.n; }
  return new Response(JSON.stringify({ plays, total }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' }
  });
}

async function addPlay(req, env, game) {
  if (!GAME_RE.test(game)) return fail(400, 'Bad game');
  if (!(await underLimit(req, env, 'play', PLAYS_PER_DAY))) return json({ ok: true, counted: false });
  const known = await env.DB.prepare('SELECT 1 FROM plays WHERE game = ?1').bind(game).first();
  if (!known) {
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM plays').first();
    if (n >= MAX_GAMES) return fail(400, 'Bad game');
  }
  const row = await env.DB.prepare(
    'INSERT INTO plays (game, n) VALUES (?1, 1) ON CONFLICT(game) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(game).first();
  return json({ ok: true, counted: true, plays: row.n });
}

/* ------------------------------------------------------------- admin */

async function admin(req, env, path) {
  if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 12) return fail(503, 'Set an ADMIN_KEY secret (12+ characters) first.');
  if (!(await isAdmin(req, env))) return fail(401, 'Wrong key');
  if (path === 'queue' && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, title, descr, channel, dur, size, type, status, created, approved, views, reports, report_why
       FROM videos WHERE status IN ('pending', 'reported', 'public') ORDER BY created DESC LIMIT 500`
    ).all();
    return json({ videos: results });
  }
  const m = /^videos\/([a-z0-9]+)\/(approve|reject)$/.exec(path);
  if (m && req.method === 'POST') {
    const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?1').bind(m[1]).first();
    if (!v) return fail(404, 'Not found');
    if (m[2] === 'approve') {
      await env.DB.prepare(`UPDATE videos SET status = 'public', approved = ?2 WHERE id = ?1`).bind(v.id, Date.now()).run();
    } else {
      // Rejected videos are deleted outright: nothing is kept that a grown-up said no to.
      await removeVideo(env, v);
    }
    return json({ ok: true });
  }
  return fail(404, 'Not found');
}

/* ------------------------------------------------------------- router */

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/^api\/?/, '');
  const m = /^videos\/([a-z0-9]{10})(?:\/([a-z]+))?$/.exec(path);
  if (path === '' || path === 'health') return json({ ok: true, service: 'startube' });
  if (path === 'videos' && req.method === 'GET') return listPublic(env);
  if (path === 'videos' && req.method === 'POST') return createVideo(req, env);
  if (path === 'plays' && req.method === 'GET') return listPlays(env);
  if (path.startsWith('plays/') && req.method === 'POST') {
    let game; try { game = decodeURIComponent(path.slice(6)); } catch (e) { return fail(400, 'Bad game'); }
    return addPlay(req, env, game);
  }
  if (path.startsWith('admin/')) return admin(req, env, path.slice(6));
  if (m) {
    const [, id, act] = m;
    if (act === 'file' && req.method === 'PUT') return putFile(req, env, id);
    if ((act === 'file' || act === 'thumb') && (req.method === 'GET' || req.method === 'HEAD')) return serve(req, env, id, act);
    if (act === 'mine' && req.method === 'GET') return mine(req, env, id, false);
    if (!act && req.method === 'DELETE') return mine(req, env, id, true);
    if (act === 'view' && req.method === 'POST') return view(env, id);
    if (act === 'cheer' && req.method === 'POST') return cheer(req, env, id);
    if (act === 'report' && req.method === 'POST') return report(req, env, id);
  }
  return fail(404, 'Not found');
}

export default {
  async fetch(req, env) {
    const c = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    let res;
    try { res = await handle(req, env); }
    catch (e) { console.error(e); res = fail(500, 'Something went wrong'); }
    res = new Response(res.body, res);
    for (const k in c) res.headers.set(k, c[k]);
    return res;
  },

  /* Once a day: forget yesterday's rate-limit counters, and clear away
     uploads that were started but never finished. */
  async scheduled(event, env) {
    await env.DB.prepare('DELETE FROM limits WHERE day < ?1').bind(today()).run();
    const { results } = await env.DB.prepare(
      `SELECT id, type FROM videos WHERE status = 'uploading' AND created < ?1`
    ).bind(Date.now() - 86400000).all();
    for (const v of results) await removeVideo(env, v);
  }
};
