/* Redio Life dashboard: reads /api/stats from the stats counter in worker/ and draws it.
   The dashboard key is kept on this device only, so you don't have to type it each time. */
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} },
};
const API = new URLSearchParams(location.search).get('api') || '/api/stats';   // ?api= is for trying it against a local copy
let key = store.get('redio-dash-key', ''), days = +store.get('redio-dash-days', 7) || 7;
let dailyM = store.get('redio-dash-daily', 'visitors'), hourM = store.get('redio-dash-hour', 'listen');
let data = null, timer = 0;

const fmt = n => Math.round(n).toLocaleString('en-NG');
const hrs = s => s >= 36000 ? fmt(s / 3600) : (s / 3600).toFixed(1).replace(/\.0$/, '');
const ago = t => { const d = Math.round(Date.now() / 1000 - t); return d < 5 ? 'just now' : `${d}s ago`; };
const dayName = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const COUNTRY = (() => { try { const n = new Intl.DisplayNames(['en'], { type: 'region' }); return c => (c && c !== '??' ? n.of(c) : 'Unknown'); } catch (e) { return c => c; } })();
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

/* ---------- Signing in ---------- */
function showLogin(msg) {
  clearTimeout(timer);
  $('dash').hidden = true; $('login').hidden = false; $('keyMsg').textContent = msg || '';
  $('key').focus();
}
$('keyForm').addEventListener('submit', e => {
  e.preventDefault();
  key = $('key').value.trim(); $('key').value = '';
  store.set('redio-dash-key', key);
  load();
});
$('logout').addEventListener('click', () => { key = ''; store.set('redio-dash-key', ''); showLogin(); });

async function load() {
  clearTimeout(timer);
  if (!key) return showLogin();
  try {
    const r = await fetch(`${API}?days=${days}`, { headers: { Authorization: `Bearer ${key}` }, cache: 'no-store' });
    if (r.status === 401) { store.set('redio-dash-key', ''); key = ''; return showLogin('That key didn’t work. Check it and try again.'); }
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
    $('login').hidden = true; $('dash').hidden = false;
    draw();
  } catch (e) {
    if (!data) return showLogin('Couldn’t reach the stats counter. Check your connection and try again.');
    $('updated').textContent = `Couldn’t refresh (${e.message || 'offline'}); showing numbers from ${ago(data.at)}`;
  }
  timer = setTimeout(load, 20000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && key) load(); });

/* ---------- Toggles ---------- */
function seg(id, attr, value, onPick) {
  const box = $(id);
  box.querySelectorAll('button').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset[attr] === String(value));
    b.onclick = () => onPick(b.dataset[attr]);
  });
}
function toggles() {
  seg('range', 'days', days, v => { days = +v; store.set('redio-dash-days', v); load(); });
  seg('dailyPick', 'm', dailyM, v => { dailyM = v; store.set('redio-dash-daily', v); draw(); });
  seg('hourPick', 'm', hourM, v => { hourM = v; store.set('redio-dash-hour', v); draw(); });
}

/* ---------- Bar chart (one measure, so one colour and one axis) ---------- */
function niceMax(v, whole) {
  if (v <= 0 || (whole && v <= 4)) return 4;
  const p = 10 ** Math.floor(Math.log10(v)), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
function bars(box, items, { label, tip, every = 1, whole = true }) {
  box.textContent = '';
  const W = Math.max(260, box.clientWidth || 640), H = W < 420 ? 160 : 200, L = 40, B = 24, T = 8, n = items.length;
  const max = niceMax(Math.max(...items.map(i => i.v), 0), whole);
  const step = (W - L) / n, bw = Math.max(2, Math.min(36, step - 2));
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  const mk = (tag, attrs, parent = svg) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  for (let g = 0; g <= 4; g++) {
    const y = T + (H - T - B) * (1 - g / 4);
    mk('line', { class: 'gridline', x1: L, x2: W, y1: y, y2: y });
    const t = mk('text', { class: 'axis', x: L - 6, y: y + 4, 'text-anchor': 'end' }); t.textContent = whole || max >= 40 ? fmt(max * g / 4) : String(+(max * g / 4).toFixed(2));
  }
  const tipEl = el('div', 'tip');
  items.forEach((it, i) => {
    const x = L + i * step + (step - bw) / 2, h = (H - T - B) * it.v / max, y = H - B - h;
    const g = mk('g', {});
    const r = Math.min(4, bw / 2, h);
    // Rounded top, square bottom on the baseline
    mk('path', { class: 'b', d: h <= 0 ? '' : `M${x},${H - B}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${H - B}Z` }, g);
    const hitBox = mk('rect', { class: 'hit', x: L + i * step, y: T, width: step, height: H - T - B }, g);
    g.insertBefore(hitBox, g.firstChild);
    g.addEventListener('pointerenter', () => {
      tipEl.textContent = tip(it);
      tipEl.style.left = `${clamp(x + bw / 2, 60, W - 60)}px`; tipEl.style.top = `${Math.max(y, T + 30)}px`;
      tipEl.classList.add('show');
    });
    g.addEventListener('pointerleave', () => tipEl.classList.remove('show'));
    if (i % every === 0) { const t = mk('text', { class: 'axis', x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' }); t.textContent = it.label; }
  });
  box.append(svg, tipEl);
}

/* ---------- Lists with a little meter ---------- */
function list(box, rows, { value = r => r.n, show = r => fmt(r.n), name = r => r.k, place = () => '', empty = 'Nothing yet', head } = {}) {
  box.textContent = '';
  if (!rows.length) return box.appendChild(el('p', 'empty', empty));
  const max = Math.max(...rows.map(value), 1), t = el('table');
  if (head) { const tr = el('tr'); [head[0], '', head[1]].forEach((h, i) => { const th = el('th', i === 2 ? 'n' : '', h); if (i === 1) th.appendChild(el('span', 'sr', 'Share')); tr.appendChild(th); }); t.appendChild(el('thead')).appendChild(tr); }
  const tb = t.appendChild(el('tbody'));
  rows.forEach(r => {
    const tr = el('tr'), nm = el('td', 'name', name(r)), m = el('td'), meter = el('div', 'meter'), bar = el('i');
    if (place(r)) nm.appendChild(el('small', '', place(r)));
    bar.style.width = `${Math.max(2, 100 * value(r) / max)}%`;
    meter.appendChild(bar); m.appendChild(meter);
    tr.append(nm, m, el('td', 'n', show(r)));
    tb.appendChild(tr);
  });
  box.appendChild(t);
}

/* ---------- The whole page ---------- */
function draw() {
  const d = data, today = days === 1, scope = today ? 'today' : `last ${days} days`;
  toggles();
  $('liveN').textContent = fmt(d.live.n);
  $('eye').classList.toggle('idle', !d.live.n);
  $('peak').textContent = `Most at once today: ${fmt(d.todayNums.peak)}`;
  $('visitorsLabel').textContent = today ? 'Visitors today' : 'Visitors';
  $('visitors').textContent = fmt(d.range.visitors);
  $('visits').textContent = today ? `${fmt(d.range.visits)} visits · ${fmt(d.allTime.users || 0)} users all time`
    : `Daily visitors added up, ${scope} · ${fmt(d.range.visits)} visits · ${fmt(d.allTime.users || 0)} users all time`;
  $('plays').textContent = fmt(d.range.plays);
  $('playsAll').textContent = `${scope} · ${fmt(d.allTime.plays)} all time`;
  $('hours').textContent = hrs(d.range.listen);
  $('hoursAll').textContent = `${scope} · ${hrs(d.allTime.listen)} all time`;

  const M = { visitors: ['visitors', v => fmt(v)], plays: ['plays', v => fmt(v)], listen: ['hours listened', v => hrs(v)], peak: ['most listening at once', v => fmt(v)] }[dailyM];
  const series = d.daily.map(x => ({ label: days > 14 ? dayName(x.day).replace(/^\w+ /, '') : dayName(x.day).split(' ').slice(0, 2).join(' '), day: x.day, v: dailyM === 'listen' ? x.listen / 3600 : x[dailyM], raw: x[dailyM] }));
  bars($('daily'), series, { label: `${M[0]} per day`, whole: dailyM !== 'listen', every: days > 60 ? 14 : days > 14 ? 7 : 1, tip: x => `${dayName(x.day)}: ${M[1](x.raw)} ${M[0]}` });
  const dt = $('dailyTable'); dt.textContent = '';
  const t = el('table'), hr = el('tr');
  ['Day', 'Visitors', 'Visits', 'Plays', 'Hours', 'Peak'].forEach((h, i) => hr.appendChild(el('th', i ? 'n' : '', h)));
  t.appendChild(el('thead')).appendChild(hr);
  const tb = t.appendChild(el('tbody'));
  [...d.daily].reverse().forEach(x => { const tr = el('tr'); [dayName(x.day), fmt(x.visitors), fmt(x.visits), fmt(x.plays), hrs(x.listen), fmt(x.peak)].forEach((v, i) => tr.appendChild(el('td', i ? 'n' : '', v))); tb.appendChild(tr); });
  dt.appendChild(t);

  const H = hourM === 'listen' ? d.listenHours.map(s => s / 3600) : d.playHours;
  bars($('hoursChart'), H.map((v, h) => ({ label: String(h).padStart(2, '0'), h, v })), {
    label: `${hourM === 'listen' ? 'Hours listened' : 'Plays'} by hour of day`, every: 3, whole: hourM !== 'listen',
    tip: x => `${String(x.h).padStart(2, '0')}:00–${String(x.h).padStart(2, '0')}:59 · ${hourM === 'listen' ? hrs(x.v * 3600) + ' hours' : fmt(x.v) + ' plays'}`,
  });

  const station = { name: r => r.name, place: r => r.place };
  list($('liveList'), d.live.stations, { ...station, empty: 'Nobody is listening right now', head: ['Station', 'Listeners'] });
  list($('topPlays'), d.topPlays, { ...station, head: ['Station', 'Plays'] });
  list($('topListen'), d.topListen, { ...station, show: r => `${hrs(r.n)} h`, head: ['Station', 'Hours'] });
  list($('states'), d.states, { empty: 'No visitors from Nigeria yet', head: ['State', 'Visitors'] });
  list($('countries'), d.countries, { name: r => COUNTRY(r.k), head: ['Country', 'Visitors'] });
  list($('devices'), d.devices, { head: ['Device', 'Visitors'] });
  list($('sources'), d.sources, { head: ['Came from', 'Visits'] });
  list($('stay'), d.stay.some(r => r.n) ? d.stay : [], { head: ['Stayed for', 'Listens'] });
  list($('fails'), d.fails, { ...station, show: r => `${fmt(r.n)}×`, empty: 'No failed streams. All good.', head: ['Station', 'Failed'] });
  $('fails').querySelectorAll('td.n').forEach(td => td.classList.add('down'));
  $('updated').textContent = `Updated ${new Date(d.at * 1000).toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' })} Lagos time`;
}

let lastW = 0;
addEventListener('resize', () => { const w = $('daily').clientWidth; if (data && w !== lastW) { lastW = w; draw(); } });
load();
