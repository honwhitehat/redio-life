/* Redio Life stats: counts visits, plays and who's listening right now, for dashboard.html.
   Runs as a Cloudflare Worker on radio.cybergistplanet.com/api/*. Everything is kept in one
   Durable Object with its own small SQLite database.

   No cookies, and no IP addresses are stored. A visitor is told apart for one day only, by a hash
   of their IP address, browser and that day's date mixed with a secret (the same idea Plausible uses),
   so nobody can be followed from one day to the next.

   Against fake numbers: only stations in stations.js are counted, under their own names; each
   connection (by the same daily hash of its IP address) gets a limited number of events a minute,
   live listeners and new visitors a day, set well above what a busy shared mobile connection needs.
   Anything past a limit is quietly ignored, so the radio itself never notices. */
import { DurableObject } from 'cloudflare:workers';
import STATIONS from './stations.json';   // built from ../stations.js by build-stations.mjs

const BEAT = 60;        // the app checks in every 60 seconds while a station plays
const LIVE = 150;       // seconds without a check-in before a listener stops counting as live
const KEEP_DAYS = 400;  // daily numbers older than this are deleted
const STAY = [[60, 'Under 1 min'], [300, '1–5 min'], [900, '5–15 min'], [3600, '15–60 min'], [Infinity, 'Over 1 hour']];
// Per connection (IP address). Mobile networks in Nigeria put many phones behind one address, so these are generous.
const LIMIT = {
  perMinute: 60,       // events a minute; one listener sends about 1
  live: 25,            // listeners at once
  newVisitors: 300,    // new visitors a day
  perVisitor: 2000,    // events a day from one visitor
  keyTries: 20,        // wrong dashboard keys an hour, then that connection is locked out for the hour
};
// Dashboard sign-in: the key is only ever sent to /api/login. What the browser keeps is a random session
// token in a cookie scripts can't read (HttpOnly), sent only over HTTPS to /api/ on this site.
const SESSION = '__Secure-redio-dash', SESSION_SECS = 7 * 86400, MAX_SESSIONS = 20;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CUSTOM = 'custom', UNLISTED = 'unlisted';
const NAMES = { [CUSTOM]: ['Stations people added', ''], [UNLISTED]: ['Stations not in the counter’s list yet', 'Redeploy the counter'] };

// Nigeria is on WAT (UTC+1) all year, so days and hours are Lagos time
const lagos = t => new Date(t * 1000 + 3600e3).toISOString();
const dayOf = t => lagos(t).slice(0, 10);
const hourOf = t => lagos(t).slice(11, 13);
const now = () => Math.floor(Date.now() / 1000);

function device(ua) {
  if (/; wv\)/.test(ua) && /Android/.test(ua)) return 'Android app';
  if (/Android/.test(ua)) return 'Android browser';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone / iPad';
  if (/bot|crawl|spider|preview|curl|wget|python|httpclient|okhttp|go-http|node-fetch|axios/i.test(ua) || !/Mozilla/.test(ua)) return 'Bot';
  return 'Computer';
}

async function sha256(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...h].map(b => b.toString(16).padStart(2, '0')).join('');
}
const sessionCookie = req => ((req.headers.get('Cookie') || '').split(/;\s*/).find(c => c.startsWith(SESSION + '=')) || '').slice(SESSION.length + 1);
const setCookie = (token, secs) => `${SESSION}=${token}; Path=/api/; Max-Age=${secs}; HttpOnly; Secure; SameSite=Strict`;
const newToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');

async function hash(...parts) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|'))));
  return [...h.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {   // compares two secrets without leaking how much of them matched
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

// Object.hasOwn, so ids like "constructor" or "__proto__" can't reach built-in object properties
const station = id => id === CUSTOM ? CUSTOM : Object.hasOwn(STATIONS, id) ? id : UNLISTED;
const nameOf = id => Object.hasOwn(NAMES, id) ? NAMES[id] : Object.hasOwn(STATIONS, id) ? STATIONS[id] : [String(id), ''];
const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url), t = now(), day = dayOf(t);
    const stats = env.STATS.get(env.STATS.idFromName('redio-life'));
    const ip = req.headers.get('CF-Connecting-IP') || '', ua = req.headers.get('User-Agent') || '';
    // Without the secret, the daily hashes could be worked back to IP addresses, so count nothing
    if (!env.SALT || env.SALT.length < 16) return reply({ error: 'Counter not set up' }, 503);
    const iph = await hash(env.SALT, day, ip);

    const origins = (env.ORIGINS || '').split(',').map(s => s.trim());
    const fromSite = origins.includes(req.headers.get('Origin'));
    // Tied to the current key, so changing DASH_KEY signs every device out
    const keyver = env.DASH_KEY ? (await sha256('keyver|' + env.DASH_KEY)).slice(0, 24) : '';

    if (url.pathname === '/api/hit' && req.method === 'POST') {
      if (!fromSite) return reply(null, 403);
      const size = +req.headers.get('Content-Length');   // the app always sends one; this stops huge or endless bodies
      if (!size || size > 512) return reply(null, 413);
      let b;
      try { b = JSON.parse((await req.text()).slice(0, 512)); } catch (e) { return reply(null, 400); }
      if (!b || !['visit', 'play', 'beat', 'stop', 'fail'].includes(b.t)) return reply(null, 400);
      const sid = UUID4.test(b.sid) ? b.sid : '';   // the app makes a fresh UUID v4 each time it opens
      if (!sid || device(ua) === 'Bot') return reply(null, 204);
      const ref = String(b.ref || '').toLowerCase().replace(/^www\./, '');
      const cf = req.cf || {};
      await stats.hit({
        t: b.t, at: t, sid, iph, id: b.id ? station(String(b.id)) : '', first: b.first === 1,
        ref: /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(ref) && ref.length <= 60 ? ref : '',
        vh: await hash(env.SALT, day, ip, ua), device: device(ua),
        country: /^[A-Z]{2}$/.test(cf.country || '') ? cf.country : '',
        region: String(cf.region || '').slice(0, 40),
      });
      return reply(null, 204);   // also when a limit was hit, so the app carries on as normal
    }

    // The two numbers the radio shows to everyone. Cached for 30 seconds, so the counter stays light.
    if (url.pathname === '/api/public' && req.method === 'GET') {
      const cache = caches.default, cacheKey = new Request(url.origin + '/api/public');
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      const res = new Response(JSON.stringify(await stats.publicNums()), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30', 'X-Robots-Tag': 'noindex' },
      });
      await cache.put(cacheKey, res.clone());
      return res;
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!fromSite) return reply(null, 403);
      const size = +req.headers.get('Content-Length');
      if (!size || size > 512) return reply(null, 413);
      let key = '';
      try { key = String(JSON.parse(await req.text()).key || ''); } catch (e) { return reply(null, 400); }
      const ok = !!env.DASH_KEY && same(key, env.DASH_KEY);
      if (!(await stats.login(iph, ok, t))) return reply({ error: 'Too many wrong keys. Try again in an hour.' }, 429);
      if (!ok) return reply({ error: 'Wrong dashboard key' }, 401);
      const token = newToken();
      await stats.startSession(await sha256(token), keyver, t + SESSION_SECS);
      return new Response(null, { status: 204, headers: { 'Set-Cookie': setCookie(token, SESSION_SECS), 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      if (!fromSite) return reply(null, 403);
      const token = sessionCookie(req);
      if (token) await stats.endSession(await sha256(token));
      return new Response(null, { status: 204, headers: { 'Set-Cookie': setCookie('', 0), 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const token = sessionCookie(req);
      if (!token || !keyver || !(await stats.checkSession(await sha256(token), keyver, t)))
        return new Response(JSON.stringify({ error: 'Please sign in' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': setCookie('', 0) } });
      const days = Math.min(KEEP_DAYS, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 7));
      return reply(await stats.stats(days));
    }

    return reply({ error: 'Not found' }, 404);
  },
};

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Version 2 added the limits. Everything before it was testing before launch, so it starts afresh.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (th TEXT PRIMARY KEY, keyver TEXT, until INTEGER);`);
    if ((this.q(`SELECT v FROM meta WHERE k = 'version'`)[0] || { v: 1 }).v < 2) {
      this.sql.exec(`DROP TABLE IF EXISTS live; DROP TABLE IF EXISTS counts; DROP TABLE IF EXISTS visitors; DROP TABLE IF EXISTS stations;
        CREATE TABLE live (sid TEXT PRIMARY KEY, iph TEXT, station TEXT, started INTEGER, seen INTEGER);
        CREATE INDEX live_iph ON live (iph);
        CREATE TABLE counts (day TEXT, metric TEXT, k TEXT, n INTEGER, PRIMARY KEY (day, metric, k));
        CREATE TABLE visitors (day TEXT, vh TEXT, hits INTEGER, PRIMARY KEY (day, vh));
        CREATE TABLE limits (k TEXT PRIMARY KEY, n INTEGER, until INTEGER);
        INSERT OR REPLACE INTO meta VALUES ('version', 2);`);
    }
  }

  q(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  add(day, metric, k, n = 1) {
    if (!n) return;
    this.sql.exec(`INSERT INTO counts VALUES (?, ?, ?, ?) ON CONFLICT (day, metric, k) DO UPDATE SET n = n + excluded.n`, day, metric, k, n);
  }
  max(day, metric, n) {
    this.sql.exec(`INSERT INTO counts VALUES (?, ?, '', ?) ON CONFLICT (day, metric, k) DO UPDATE SET n = max(n, excluded.n)`, day, metric, n);
  }
  // Counts one more against a limit that lasts until `until`, and returns the new count
  bump(k, until) {
    return this.sql.exec(`INSERT INTO limits VALUES (?, 1, ?) ON CONFLICT (k) DO UPDATE SET n = n + 1 RETURNING n`, k, until).one().n;
  }

  // Adds the listening time since the listener's last check-in; with end, also closes their session
  listened(row, t, end) {
    const secs = Math.max(0, Math.min(t - row.seen, 2 * BEAT)), day = dayOf(t);
    this.add(day, 'listen', row.station, secs);
    this.add(day, 'listen_hour', hourOf(t), secs);
    this.add('total', 'listen', '', secs);
    if (!end) return;
    const stay = row.seen + Math.min(t - row.seen, 2 * BEAT) - row.started;
    this.add(dayOf(row.started), 'stay', STAY.find(([s]) => stay < s)[1]);
    this.sql.exec(`DELETE FROM live WHERE sid = ?`, row.sid);
  }
  // Starts counting a listener, unless their connection already has too many
  listen(sid, iph, id, t) {
    if (this.q(`SELECT count(*) AS n FROM live WHERE iph = ?`, iph)[0].n >= LIMIT.live) return false;
    this.sql.exec(`INSERT INTO live VALUES (?, ?, ?, ?, ?)`, sid, iph, id, t, t);
    return true;
  }

  // Closes the sessions of listeners who stopped checking in, and clears out old data
  sweep(t) {
    for (const row of this.q(`SELECT * FROM live WHERE seen < ?`, t - LIVE)) this.listened({ ...row }, row.seen, true);
    this.sql.exec(`DELETE FROM counts WHERE day < ?`, dayOf(t - KEEP_DAYS * 86400));
    this.sql.exec(`DELETE FROM visitors WHERE day < ?`, dayOf(t - 86400));
    this.sql.exec(`DELETE FROM limits WHERE until < ?`, t);
    this.sql.exec(`DELETE FROM sessions WHERE until < ?`, t);
  }

  // Dashboard sessions are kept as a hash of the token, so the database alone can't sign anyone in
  async startSession(th, keyver, until) {
    this.sql.exec(`INSERT INTO sessions VALUES (?, ?, ?)`, th, keyver, until);
    this.sql.exec(`DELETE FROM sessions WHERE th NOT IN (SELECT th FROM sessions ORDER BY until DESC LIMIT ?)`, MAX_SESSIONS);
  }
  async endSession(th) { this.sql.exec(`DELETE FROM sessions WHERE th = ?`, th); }
  async checkSession(th, keyver, t) {
    const row = this.q(`SELECT * FROM sessions WHERE th = ?`, th)[0];
    return !!row && row.keyver === keyver && row.until > t;
  }

  async login(iph, ok, t) {
    const k = `key:${iph}:${Math.floor(t / 3600)}`;
    const tries = (this.q(`SELECT n FROM limits WHERE k = ?`, k)[0] || { n: 0 }).n;
    if (tries >= LIMIT.keyTries) return false;
    if (!ok) this.bump(k, t + 3600);
    return true;
  }

  async hit(h) {
    const { at: t, sid, iph } = h, day = dayOf(t);
    if (this.bump(`min:${iph}:${Math.floor(t / 60)}`, t + 60) > LIMIT.perMinute) return;
    this.sql.exec(`INSERT INTO visitors VALUES (?, ?, 1) ON CONFLICT (day, vh) DO UPDATE SET hits = hits + 1`, day, h.vh);
    const [{ hits }] = this.q(`SELECT hits FROM visitors WHERE day = ? AND vh = ?`, day, h.vh);
    if (hits > LIMIT.perVisitor) return;
    if (hits === 1) {   // first time today for this visitor
      if (this.bump(`new:${iph}:${day}`, t + 2 * 86400) > LIMIT.newVisitors) return;
      this.add(day, 'visitors', '');
      this.add(day, 'device', h.device);
      this.add(day, 'country', h.country || '??');
      if (h.country === 'NG' && h.region) this.add(day, 'state', h.region);
      this.add('total', 'visitors', '');
    }
    const row = this.q(`SELECT * FROM live WHERE sid = ?`, sid)[0];

    if (h.t === 'visit') {
      this.add(day, 'visits', '');
      if (h.first && hits === 1) { this.add(day, 'users', ''); this.add('total', 'users', ''); }   // a phone's first ever visit
      this.add(day, 'visit_hour', hourOf(t));
      this.add(day, 'source', h.ref || 'Direct / app');
      this.add('total', 'visits', '');
    } else if (h.t === 'play' && h.id) {
      if (row) this.listened(row, t, true);   // they switched station
      if (!this.listen(sid, iph, h.id, t)) return;
      this.add(day, 'plays', h.id);
      this.add(day, 'play_hour', hourOf(t));
      this.add('total', 'plays', '');
      this.max(day, 'peak', this.q(`SELECT count(*) AS n FROM live WHERE seen >= ?`, t - LIVE)[0].n);
    } else if (h.t === 'beat' && h.id) {
      if (row && row.station === h.id) { this.listened(row, t); this.sql.exec(`UPDATE live SET seen = ? WHERE sid = ?`, t, sid); }
      else {   // e.g. a listener whose session timed out while the phone had no signal
        if (row) this.listened(row, t, true);
        this.listen(sid, iph, h.id, t);
      }
    } else if (h.t === 'stop' && row) {
      this.listened(row, t, true);
    } else if (h.t === 'fail' && h.id) {
      this.add(day, 'fails', h.id);
    }
    if (Math.random() < 0.05) this.sweep(t);
  }

  async publicNums() {
    const t = now();
    return {
      live: this.q(`SELECT count(*) AS n FROM live WHERE seen >= ?`, t - LIVE)[0].n,
      users: (this.q(`SELECT n FROM counts WHERE day = 'total' AND metric = 'users'`)[0] || { n: 0 }).n,
    };
  }

  async stats(days) {
    const t = now(), today = dayOf(t);
    this.sweep(t);
    const from = dayOf(t - (days - 1) * 86400);
    const named = rows => rows.map(r => { const [name, place] = nameOf(r.k); return { id: r.k, name, place, n: r.n }; });
    const sum = metric => this.q(`SELECT coalesce(sum(n), 0) AS n FROM counts WHERE metric = ? AND day >= ? AND day <= ?`, metric, from, today)[0].n;
    const by = (metric, limit = 50) => this.q(`SELECT k, sum(n) AS n FROM counts WHERE metric = ? AND day >= ? AND day <= ? GROUP BY k ORDER BY n DESC LIMIT ?`, metric, from, today, limit);
    const total = metric => (this.q(`SELECT n FROM counts WHERE day = 'total' AND metric = ?`, metric)[0] || { n: 0 }).n;

    const daily = {};
    for (let i = days - 1; i >= 0; i--) daily[dayOf(t - i * 86400)] = { visitors: 0, visits: 0, plays: 0, listen: 0, peak: 0 };
    for (const r of this.q(`SELECT day, metric, sum(n) AS n FROM counts WHERE day >= ? AND day <= ? AND metric IN ('visitors', 'visits', 'plays', 'listen', 'peak') GROUP BY day, metric`, from, today))
      if (daily[r.day]) daily[r.day][r.metric] = r.n;

    const hours = metric => { const h = Array(24).fill(0); by(metric, 24).forEach(r => { h[+r.k] = r.n; }); return h; };
    const stay = by('stay', 10);
    return {
      at: t, days, today,
      live: { n: this.q(`SELECT count(*) AS n FROM live`)[0].n, stations: named(this.q(`SELECT station AS k, count(*) AS n FROM live GROUP BY station ORDER BY n DESC`)) },
      todayNums: { ...daily[today] },
      range: { visitors: sum('visitors'), visits: sum('visits'), plays: sum('plays'), listen: sum('listen') },
      allTime: { users: total('users'), visitors: total('visitors'), visits: total('visits'), plays: total('plays'), listen: total('listen') },
      daily: Object.entries(daily).map(([day, v]) => ({ day, ...v })),
      topPlays: named(by('plays', 25)), topListen: named(by('listen', 25)), fails: named(by('fails', 25)),
      playHours: hours('play_hour'), listenHours: hours('listen_hour'),
      states: by('state', 40), countries: by('country', 20), devices: by('device', 10), sources: by('source', 15),
      stay: STAY.map(([, label]) => ({ k: label, n: (stay.find(r => r.k === label) || { n: 0 }).n })),
    };
  }
}
