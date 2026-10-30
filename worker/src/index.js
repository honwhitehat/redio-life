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
import { connect } from 'cloudflare:sockets';
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
};
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CUSTOM = 'custom', UNLISTED = 'unlisted';
const NAMES = { [CUSTOM]: ['Stations people added', ''], [UNLISTED]: ['Other stations', ''] };

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

async function hash(...parts) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|'))));
  return [...h.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Object.hasOwn, so ids like "constructor" or "__proto__" can't reach built-in object properties
const station = id => id === CUSTOM ? CUSTOM : Object.hasOwn(STATIONS, id) ? id : UNLISTED;
const nameOf = id => Object.hasOwn(NAMES, id) ? NAMES[id] : Object.hasOwn(STATIONS, id) ? STATIONS[id] : [String(id), ''];
const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
});

/* ---------- Stream check: is each station actually on air? ----------
   Every 5 minutes the counter tests the stations it checked longest ago, about 15 at a time (the free plan
   allows 50 connections a run), so every station with a link is checked about every 2 hours. A station is
   working if any of its links answers like an audio stream; it's listed as down after 2 failed checks in a row. */
const CHECK_BUDGET = 45, CHECK_TIMEOUT = 8000, DOWN_AFTER = 2;
const FETCH_PORTS = new Set(['', '443', '8443', '2053', '2083', '2087', '2096']);   // ports a Worker's fetch() can reach over https
const AUDIO = /audio|ogg|mpegurl|octet-stream|aac|mpeg|mp2t|x-scpls/i;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timed out')), ms))]);

async function probe(link) {
  const u = new URL(link);
  if (FETCH_PORTS.has(u.port)) {
    const r = await fetch(link, { headers: { 'Icy-MetaData': '0', 'User-Agent': 'RedioLife-StreamCheck/1.0' }, redirect: 'follow', signal: AbortSignal.timeout(CHECK_TIMEOUT) });
    const type = r.headers.get('Content-Type') || '';
    try { await r.body?.cancel(); } catch (e) {}
    if (!r.ok) return [false, `HTTP ${r.status}`];
    return type && !AUDIO.test(type) ? [false, `not audio (${type.split(';')[0]})`] : [true, ''];
  }
  // Other ports (lots of Icecast and Shoutcast servers): a direct connection, asking for just the reply headers
  const sock = connect({ hostname: u.hostname, port: +u.port }, { secureTransport: u.protocol === 'https:' ? 'on' : 'off' });
  try {
    const w = sock.writable.getWriter();
    await w.write(new TextEncoder().encode(`GET ${u.pathname}${u.search} HTTP/1.0\r\nHost: ${u.host}\r\nIcy-MetaData: 0\r\nUser-Agent: RedioLife-StreamCheck/1.0\r\n\r\n`));
    const reader = sock.readable.getReader(), dec = new TextDecoder();
    let head = '';
    while (!head.includes('\r\n\r\n') && head.length < 4096) {
      const { value, done } = await withTimeout(reader.read(), CHECK_TIMEOUT);
      if (done) break;
      head += dec.decode(value, { stream: true });
    }
    const m = head.match(/^(?:HTTP\/1\.[01]|ICY) (\d{3})/), code = m ? +m[1] : 0;
    const type = (head.match(/\r\ncontent-type:\s*([^\r]+)/i) || [])[1] || '';
    if (!code) return [false, 'no answer'];
    if (code >= 400) return [false, `HTTP ${code}`];
    return code < 300 && type && !AUDIO.test(type) ? [false, `not audio (${type.split(';')[0]})`] : [true, ''];
  } finally { try { await sock.close(); } catch (e) {} }
}

async function checkStreams(env) {
  const stats = env.STATS.get(env.STATS.idFromName('redio-life'));
  const results = [];
  let budget = CHECK_BUDGET - 2;   // two calls to the counter's database
  for (const id of await stats.dueStations(20)) {
    const links = STATIONS[id][2];
    if (budget < links.length * 2) break;   // a redirect costs a second connection
    let ok = false, detail = '';
    for (const link of links) {
      budget -= 2;
      for (let attempt = 0; attempt < 2; attempt++) {   // one retry, for a link that timed out
        try { [ok, detail] = await probe(link); } catch (e) { ok = false; detail = /timed? ?out|abort/i.test(String(e.message)) ? 'timed out' : String(e.message || e).slice(0, 60); }
        if (ok || detail !== 'timed out' || budget < 2) break;
        budget -= 2;
      }
      if (ok) break;
    }
    results.push({ id, ok, detail });
  }
  await stats.saveChecks(results, now());
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(checkStreams(env)); },

  async fetch(req, env) {
    const url = new URL(req.url), t = now(), day = dayOf(t);
    const stats = env.STATS.get(env.STATS.idFromName('redio-life'));
    const ip = req.headers.get('CF-Connecting-IP') || '', ua = req.headers.get('User-Agent') || '';
    // Without the secret, the daily hashes could be worked back to IP addresses, so count nothing
    if (!env.SALT || env.SALT.length < 16) return reply({ error: 'Counter not set up' }, 503);
    const iph = await hash(env.SALT, day, ip);

    const origins = (env.ORIGINS || '').split(',').map(s => s.trim());
    const fromSite = origins.includes(req.headers.get('Origin'));

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

    // Anyone can read these, so each answer is cached briefly and shared by everyone asking:
    // lots of visitors can't overload the counter or use up the free plan
    const cached = async (path, secs, make) => {
      const cache = caches.default, cacheKey = new Request(url.origin + path);
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      const res = new Response(JSON.stringify(await make()), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${secs}`, 'X-Robots-Tag': 'noindex' },
      });
      await cache.put(cacheKey, res.clone());
      return res;
    };

    // The two numbers the radio shows
    if (url.pathname === '/api/public' && req.method === 'GET') return cached('/api/public', 30, () => stats.publicNums());

    // The dashboard, open to everyone. Only the four ranges it offers, so there are just four answers to cache.
    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const days = [1, 7, 30, 90].includes(+url.searchParams.get('days')) ? +url.searchParams.get('days') : 7;
      return cached(`/api/stats?days=${days}`, 20, () => stats.stats(days));
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
      DROP TABLE IF EXISTS sessions;
      CREATE TABLE IF NOT EXISTS streams (id TEXT PRIMARY KEY, checked INTEGER, fails INTEGER, since INTEGER, detail TEXT);`);   // left from when the dashboard needed signing in
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

  // Stations with a link, those never checked first, then the ones checked longest ago
  async dueStations(n) {
    const checked = Object.fromEntries(this.q(`SELECT id, checked FROM streams`).map(r => [r.id, r.checked]));
    return Object.keys(STATIONS).filter(id => STATIONS[id][2].length)
      .sort((a, b) => (checked[a] || 0) - (checked[b] || 0)).slice(0, n);
  }
  async saveChecks(results, t) {
    for (const { id, ok, detail } of results) {
      const row = this.q(`SELECT * FROM streams WHERE id = ?`, id)[0];
      const fails = ok ? 0 : (row ? row.fails : 0) + 1;
      const since = ok ? 0 : (row && row.fails ? row.since : t);
      this.sql.exec(`INSERT OR REPLACE INTO streams VALUES (?, ?, ?, ?, ?)`, id, t, fails, since, detail);
    }
    this.sql.exec(`DELETE FROM streams WHERE id NOT IN (${Object.keys(STATIONS).map(() => '?').join(',')})`, ...Object.keys(STATIONS));
  }
  streamReport() {
    const withLinks = Object.keys(STATIONS).filter(id => STATIONS[id][2].length);
    const rows = this.q(`SELECT * FROM streams`);
    const down = rows.filter(r => r.fails >= DOWN_AFTER).sort((a, b) => a.since - b.since)
      .map(r => { const [name, place] = nameOf(r.id); return { id: r.id, name, place, since: r.since, checked: r.checked, detail: r.detail }; });
    return {
      down, checked: rows.length, total: withLinks.length, notChecked: Object.keys(STATIONS).length - withLinks.length,
      lastCheck: rows.reduce((m, r) => Math.max(m, r.checked), 0),
    };
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
      topPlays: named(by('plays', 25)), topListen: named(by('listen', 25)), streams: this.streamReport(),
      playHours: hours('play_hour'), listenHours: hours('listen_hour'),
      states: by('state', 40), countries: by('country', 20), sources: by('source', 15),
      stay: STAY.map(([, label]) => ({ k: label, n: (stay.find(r => r.k === label) || { n: 0 }).n })),
    };
  }
}
