import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

/* ---------- database bootstrap (runs once per server instance, idempotent) ---------- */

let readyPromise = null;
function db() {
  if (!readyPromise) readyPromise = bootstrap().catch((e) => { readyPromise = null; throw e; });
  return readyPromise;
}

async function bootstrap() {
  await sql`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL, exp TIMESTAMPTZ)`;
  await sql`CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, url TEXT NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT now(), expires TIMESTAMPTZ,
    clicks INTEGER NOT NULL DEFAULT 0, unique_ips INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true, countries JSONB)`;
  await sql`CREATE TABLE IF NOT EXISTS clicks (
    id BIGSERIAL PRIMARY KEY, link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    ip_hash TEXT NOT NULL, country TEXT, device TEXT, ua TEXT,
    created TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS clicks_link_idx ON clicks (link_id, created)`;
  await sql`CREATE INDEX IF NOT EXISTS clicks_country_idx ON clicks (country)`;
  await sql`CREATE TABLE IF NOT EXISTS ads (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, placement TEXT NOT NULL,
    code TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true)`;
  // Auto-generated secrets (JWT signing key + IP hashing salt) — zero .env needed
  await sql`INSERT INTO kv (k, v) VALUES ('secret', ${JSON.stringify({
    jwt: crypto.randomBytes(32).toString('hex'),
    salt: crypto.randomBytes(16).toString('hex'),
  })}::jsonb) ON CONFLICT (k) DO NOTHING`;
}

async function kvGet(k) { const r = await sql`SELECT v FROM kv WHERE k = ${k}`; return r.rows[0]?.v ?? null; }
async function kvSet(k, v, expSec) {
  if (expSec) await sql`INSERT INTO kv (k, v, exp) VALUES (${k}, ${JSON.stringify(v)}::jsonb, now() + (${expSec} * interval '1 second'))
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, exp = EXCLUDED.exp`;
  else await sql`INSERT INTO kv (k, v) VALUES (${k}, ${JSON.stringify(v)}::jsonb)
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, exp = null`;
}
// atomic single-use consume (one-time link tokens)
async function kvConsume(k) {
  const r = await sql`DELETE FROM kv WHERE k = ${k} RETURNING v, exp`;
  const row = r.rows[0];
  if (!row) return null;
  if (row.exp && new Date(row.exp) < new Date()) return null;
  return row.v;
}

/* ---------- crypto helpers (no external deps) ---------- */

function signTok(obj, secret, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...obj, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyTok(token, secret) {
  if (!token || !secret) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null; } catch { return null; }
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!o.exp || o.exp < Date.now()) return null;
    return o;
  } catch { return null; }
}
function hashPassword(pw) {
  const s = crypto.randomBytes(16).toString('hex');
  return `${s}:${crypto.scryptSync(pw, s, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  try {
    const [s, h] = stored.split(':');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(crypto.scryptSync(pw, s, 64).toString('hex'), 'hex'));
  } catch { return false; }
}
function hashIp(salt, ipAddr) { return crypto.createHmac('sha256', salt).update(ipAddr || 'x').digest('hex').slice(0, 32); }

/* ---------- request helpers ---------- */

const j = (data, status = 200) => NextResponse.json(data, { status });
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
function ip(req) { const xf = req.headers.get('x-forwarded-for'); return (xf ? xf.split(',')[0] : '') || 'unknown'; }
function device(ua = '') {
  if (/iPad|Tablet|Silk|Kindle/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}
// Per-instance rate limiter (good baseline; a shared store like Upstash would be needed for multi-region)
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return true;
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}
async function sessionOk(req) {
  const tok = req.cookies.get('sl_auth')?.value;
  if (!tok) return false;
  const secret = await kvGet('secret');
  const payload = verifyTok(tok, secret?.jwt);
  return !!(payload && payload.a === 1);
}

/* ---------- settings ---------- */

const DEFAULTS = { seconds: 10, adblockGate: true, captchaProvider: 'TURNSTILE', captchaSite: '', captchaSecret: '' };
async function getSettings() { return { ...DEFAULTS, ...(await kvGet('settings')) }; }
const shapeSettings = (s) => ({ seconds: s.seconds, adblockGate: s.adblockGate, captchaProvider: s.captchaProvider, captchaSite: s.captchaSite, captchaSecretSet: !!s.captchaSecret });

/* ---------- router ---------- */

async function handle(req, path) {
  try { await db(); } catch (e) {
    if (/POSTGRES_URL|connection/i.test(String(e?.message || e))) {
      return j({ error: 'Database not connected. In Vercel: Project → Storage → Create Database (Neon Postgres) → Connect, then Redeploy.' }, 503);
    }
    throw e;
  }
  const [a, b, c] = path || [];
  const m = req.method;
  try {
    if (a === 'auth') return await authRoutes(req, m);
    if (a === 'gate' && b) {
      if (m === 'GET' && !c) return gateLoad(req, b);
      if (m === 'POST' && c === 'verify') return gateVerify(req, b);
    }
    if (a === 'go' && b && m === 'GET') return redeem(req, b);

    if (!(await sessionOk(req))) return j({ error: 'Not authorized' }, 401);

    if (a === 'links') {
      if (m === 'GET' && !b) return listLinks(req);
      if (m === 'POST' && !b) return createLink(req);
      if (m === 'DELETE' && b) { await sql`DELETE FROM links WHERE id = ${b}`; return j({ ok: true }); }
    }
    if (a === 'ads') {
      if (m === 'GET' && !b) return j({ ads: (await sql`SELECT * FROM ads ORDER BY name`).rows });
      if (m === 'POST' && !b) return createAd(req);
      if (m === 'PATCH' && b) {
        const body = await readJson(req);
        if (typeof body.active !== 'boolean') return j({ error: 'active must be true/false' }, 400);
        await sql`UPDATE ads SET active = ${body.active} WHERE id = ${b}`;
        return j({ ok: true });
      }
      if (m === 'DELETE' && b) { await sql`DELETE FROM ads WHERE id = ${b}`; return j({ ok: true }); }
    }
    if (a === 'settings' && !b) {
      if (m === 'GET') return j({ settings: shapeSettings(await getSettings()) });
      if (m === 'PUT') return putSettings(req);
    }
    if (a === 'analytics' && m === 'GET' && !b) return analytics(req);
    return j({ error: 'Not found' }, 404);
  } catch (e) {
    console.error(e);
    return j({ error: 'Server error' }, 500);
  }
}

export async function GET(req, ctx) { return handle(req, (await ctx.params).path); }
export async function POST(req, ctx) { return handle(req, (await ctx.params).path); }
export async function PUT(req, ctx) { return handle(req, (await ctx.params).path); }
export async function PATCH(req, ctx) { return handle(req, (await ctx.params).path); }
export async function DELETE(req, ctx) { return handle(req, (await ctx.params).path); }

/* ---------- auth (one admin, password claimed on first visit) ---------- */

async function authRoutes(req, m) {
  const secret = await kvGet('secret');
  if (m === 'GET') {
    return j({ claimed: !!(await kvGet('admin')), admin: await sessionOk(req) });
  }
  if (m === 'POST') {
    const body = await readJson(req);
    if (body.mode === 'claim') {
      if (await kvGet('admin')) return j({ error: 'Admin already set up. Use login.' }, 403);
      const pw = String(body.password || '');
      if (pw.length < 8) return j({ error: 'Password must be at least 8 characters' }, 400);
      await kvSet('admin', { hash: hashPassword(pw) });
      return withSession({ ok: true }, secret);
    }
    if (body.mode === 'login') {
      const admin = await kvGet('admin');
      if (!admin || !checkPassword(String(body.password || ''), admin.hash)) return j({ error: 'Wrong password' }, 401);
      return withSession({ ok: true }, secret);
    }
    if (body.mode === 'logout') {
      const res = j({ ok: true });
      res.cookies.set('sl_auth', '', { httpOnly: true, path: '/', maxAge: 0 });
      return res;
    }
  }
  return j({ error: 'Not found' }, 404);
}

function withSession(data, secret) {
  const res = NextResponse.json(data);
  res.cookies.set('sl_auth', signTok({ a: 1 }, secret.jwt, 30 * 864e5), {
    httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 30 * 86400,
  });
  return res;
}

/* ---------- links (admin) ---------- */

function urlError(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return 'Invalid URL'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'Only http/https URLs are allowed';
  const h = u.hostname.toLowerCase();
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\])/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
    return 'Private/loopback addresses are not allowed';
  }
  return null;
}

const ALPHA = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RESERVED_SLUGS = new Set(['api', 'admin', 'create', 'login', 'settings', 'analytics', '_next', 'ads.js', 'favicon.ico']);
async function genSlug() {
  for (let i = 0; i < 10; i++) {
    let s = '';
    for (const x of crypto.randomBytes(6)) s += ALPHA[x % ALPHA.length];
    if (RESERVED_SLUGS.has(s.toLowerCase())) continue;
    const ex = await sql`SELECT 1 FROM links WHERE slug = ${s}`;
    if (!ex.rows.length) return s;
  }
  throw new Error('Could not allocate slug');
}

async function listLinks() {
  const rows = (await sql`SELECT id, slug, url, created, expires, clicks, unique_ips, active, countries
    FROM links ORDER BY created DESC LIMIT 200`).rows;
  return j({ links: rows.map((r) => ({
    id: r.id, slug: r.slug, url: r.url, created: r.created, expires: r.expires,
    clicks: r.clicks, uniqueIps: r.unique_ips, active: r.active, countries: r.countries,
  })) });
}

async function createLink(req) {
  const body = await readJson(req);
  const err = urlError(body.url);
  if (err) return j({ error: err }, 400);
  const url = new URL(String(body.url)).toString();

  let slug;
  if (body.custom) {
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(String(body.custom))) return j({ error: 'Custom slug: 3–32 letters/numbers/dashes' }, 400);
    const ex = await sql`SELECT 1 FROM links WHERE slug = ${String(body.custom)}`;
    if (ex.rows.length) return j({ error: 'That slug is already taken' }, 409);
    slug = String(body.custom);
  } else {
    slug = await genSlug();
  }

  const days = body.days ? Math.min(3650, Math.max(1, parseInt(body.days, 10) || 0)) : 0;
  const expires = days ? new Date(Date.now() + days * 864e5) : null;
  const countries = Array.isArray(body.countries) && body.countries.length
    ? body.countries.filter((x) => /^[A-Z]{2}$/.test(String(x))).slice(0, 64) : null;
  const id = crypto.randomUUID();

  await sql`INSERT INTO links (id, slug, url, expires, countries)
    VALUES (${id}, ${slug}, ${url}, ${expires ? expires.toISOString() : null}, ${countries ? JSON.stringify(countries) : null}::jsonb)`;

  const origin = new URL(req.url).origin;
  return j({ ok: true, id, slug, shortUrl: `${origin}/${slug}` });
}

/* ---------- ads (admin) ---------- */

async function createAd(req) {
  const b = await readJson(req);
  if (!b.name || !b.code) return j({ error: 'Name and code are required' }, 400);
  if (!['banner', 'card', 'pop'].includes(b.placement)) return j({ error: 'Invalid placement' }, 400);
  if (String(b.code).length > 20000) return j({ error: 'Code too long' }, 400);
  await sql`INSERT INTO ads (id, name, placement, code) VALUES (${crypto.randomUUID()}, ${String(b.name).slice(0, 100)}, ${b.placement}, ${String(b.code)})`;
  return j({ ok: true });
}

/* ---------- settings (admin) ---------- */

async function putSettings(req) {
  const cur = await getSettings();
  const b = await readJson(req);
  const next = {
    seconds: Math.min(30, Math.max(5, parseInt(b.seconds ?? cur.seconds, 10) || 10)),
    adblockGate: typeof b.adblockGate === 'boolean' ? b.adblockGate : cur.adblockGate,
    captchaProvider: ['TURNSTILE', 'HCAPTCHA'].includes(b.captchaProvider) ? b.captchaProvider : cur.captchaProvider,
    captchaSite: typeof b.captchaSite === 'string' ? b.captchaSite.trim() : cur.captchaSite,
    captchaSecret: (typeof b.captchaSecret === 'string' && b.captchaSecret.trim() && !b.captchaSecret.includes('•'))
      ? b.captchaSecret.trim() : cur.captchaSecret,
  };
  await kvSet('settings', next);
  return j({ settings: shapeSettings(next) });
}

/* ---------- analytics (admin) ---------- */

async function analytics(req) {
  const days = Math.min(90, Math.max(1, parseInt(new URL(req.url).searchParams.get('days') || '30', 10)));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [t1, t2, t3, g, dv, dl] = await Promise.all([
    sql`SELECT count(*)::int AS c FROM clicks WHERE created >= ${since}::timestamptz`,
    sql`SELECT count(DISTINCT ip_hash)::int AS c FROM clicks WHERE created >= ${since}::timestamptz`,
    sql`SELECT count(*)::int AS c FROM links`,
    sql`SELECT country, count(*)::int AS c FROM clicks WHERE created >= ${since}::timestamptz GROUP BY country ORDER BY c DESC LIMIT 20`,
    sql`SELECT device, count(*)::int AS c FROM clicks WHERE created >= ${since}::timestamptz GROUP BY device ORDER BY c DESC`,
    sql`SELECT to_char(date_trunc('day', created), 'YYYY-MM-DD') AS day, count(*)::int AS c
        FROM clicks WHERE created >= ${since}::timestamptz GROUP BY 1 ORDER BY 1`,
  ]);
  return j({
    totals: { clicks: t1.rows[0].c, uniqueIps: t2.rows[0].c, links: t3.rows[0].c },
    geo: g.rows.map((r) => ({ country: r.country || 'Unknown', count: r.c })),
    devices: dv.rows.map((r) => ({ device: r.device || 'Unknown', count: r.c })),
    daily: dl.rows.map((r) => ({ day: r.day, count: r.c })),
  });
}

/* ---------- public gate flow ---------- */

async function gateLoad(req, slug) {
  const link = (await sql`SELECT id, active, expires, countries FROM links WHERE slug = ${slug}`).rows[0];
  if (!link || !link.active) return j({ error: 'Link not found' }, 404);
  if (link.expires && new Date(link.expires) < new Date()) return j({ error: 'This link has expired' }, 410);

  const country = req.headers.get('x-vercel-ip-country'); // provided by Vercel's edge, free
  if (Array.isArray(link.countries) && link.countries.length && !link.countries.includes(country)) {
    return j({ error: 'Link not found' }, 404); // targeting miss looks identical to a missing link
  }

  const secret = await kvGet('secret');
  const s = await getSettings();
  const rows = (await sql`SELECT placement, code FROM ads WHERE active = true`).rows;
  const pick = (p) => rows.find((r) => r.placement === p)?.code || null;

  // The destination URL is NEVER sent here — only a signed session token whose
  // issue-time proves when the countdown started (server-enforced).
  const token = signTok({ l: link.id, iat: Date.now() }, secret.jwt, 30 * 60e3);
  return j({
    ok: true, seconds: s.seconds, adblockGate: s.adblockGate,
    captcha: s.captchaSite && s.captchaSecret ? { provider: s.captchaProvider, site: s.captchaSite } : null,
    ads: { banner: pick('banner'), card: pick('card'), pop: pick('pop') },
    token,
  });
}

async function gateVerify(req, slug) {
  const addr = ip(req);
  if (limited(`v:${addr}`, 8, 60000)) return j({ error: 'Too many attempts. Slow down.' }, 429);

  const body = await readJson(req);
  const secret = await kvGet('secret');
  const t = verifyTok(String(body.token || ''), secret.jwt);
  if (!t || !t.l) return j({ error: 'Session expired — reload the page' }, 401);

  const link = (await sql`SELECT id, url, active, expires FROM links WHERE id = ${t.l}`).rows[0];
  if (!link || !link.active) return j({ error: 'Link not found' }, 404);
  if (link.expires && new Date(link.expires) < new Date()) return j({ error: 'This link has expired' }, 410);

  const s = await getSettings();
  // Server-side timer check against the signed token's issue time — the client
  // cannot skip this by editing the page.
  const elapsed = (Date.now() - t.iat) / 1000;
  if (elapsed < s.seconds - 1) return j({ error: 'Please wait for the countdown to finish' }, 425);

  if (s.captchaSite && s.captchaSecret) {
    const ok = await captchaOk(s, body.captcha, addr);
    if (!ok) return j({ error: 'Captcha verification failed' }, 400);
  }

  const id = crypto.randomUUID();
  await kvSet(`ot:${id}`, { l: link.id }, 120); // single-use, expires in 2 min
  return j({ redeem: id });
}

async function captchaOk(s, token, addr) {
  if (!token) return false;
  const ep = s.captchaProvider === 'HCAPTCHA'
    ? 'https://api.hcaptcha.com/siteverify'
    : 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  try {
    const r = await fetch(ep, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: s.captchaSecret, response: String(token), remoteip: addr || '' }),
    });
    const d = await r.json();
    return d.success === true;
  } catch { return false; }
}

async function redeem(req, id) {
  if (limited(`g:${ip(req)}`, 10, 60000)) return j({ error: 'Too many requests' }, 429);

  const v = await kvConsume(`ot:${id}`); // atomic single-use
  if (!v) return j({ error: 'Token invalid or already used' }, 409);

  const link = (await sql`SELECT id, url, active, expires FROM links WHERE id = ${v.l}`).rows[0];
  if (!link || !link.active) return j({ error: 'Link unavailable' }, 410);
  if (link.expires && new Date(link.expires) < new Date()) return j({ error: 'Link expired' }, 410);

  // Record the click: hashed IP (never raw), country, device, timestamp
  const addr = ip(req);
  const h = hashIp((await kvGet('secret')).salt, addr);
  const country = req.headers.get('x-vercel-ip-country');
  const ua = (req.headers.get('user-agent') || '').slice(0, 512);

  await sql`UPDATE links SET clicks = clicks + 1 WHERE id = ${link.id}`;
  const seen = await sql`SELECT 1 FROM clicks WHERE link_id = ${link.id} AND ip_hash = ${h} LIMIT 1`;
  if (!seen.rows.length) await sql`UPDATE links SET unique_ips = unique_ips + 1 WHERE id = ${link.id}`;
  await sql`INSERT INTO clicks (link_id, ip_hash, country, device, ua) VALUES (${link.id}, ${h}, ${country}, ${device(ua)}, ${ua})`;

  return j({ url: link.url });
}
