/* Redio Life: Lagos corner plus stations across Nigeria, as a grid. The station list lives in stations.js.
   Lagos stations without a link are looked up in the free Radio Browser directory (radio-browser.info);
   found links are cached on the phone for a week. You can also paste your own link for any Lagos station. */
const MIN = 88, MAX = 108;
const REGIONS = [
  ['South West', ['Oyo', 'Ogun', 'Osun', 'Ondo', 'Ekiti']],
  ['South South', ['Rivers', 'Delta', 'Edo', 'Akwa Ibom', 'Cross River', 'Bayelsa']],
  ['South East', ['Anambra', 'Imo', 'Abia', 'Enugu', 'Ebonyi']],
  ['North Central', ['FCT Abuja', 'Plateau', 'Kwara', 'Niger', 'Benue', 'Kogi', 'Nasarawa']],
  ['North West', ['Kano', 'Kaduna', 'Katsina', 'Kebbi', 'Sokoto', 'Zamfara', 'Jigawa']],
  ['North East', ['Bauchi', 'Gombe', 'Adamawa', 'Yobe', 'Borno', 'Taraba']],
];
const API = ['de1', 'de2', 'fi1', 'nl1', 'at1'].map(h => `https://${h}.api.radio-browser.info`);
const OTHER_CITIES = /abuja|kano|port ?harcourt|\bph\b|ibadan|onitsha|enugu|benin|uyo|kaduna|ilorin|osogbo|akure|abeokuta|ekiti|jos|calabar|owerri|warri/i;
const DEAD = ['lunar.citrus3.com:8124', 'edge.mixlr.com/channel/twrez'];   // listed in the directory but checked dead
const $ = id => document.getElementById(id);
function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const fm = s => s.f ? `${s.f.toFixed(1)} FM` : 'Online';
const place = s => s.page === 'lagos' ? 'Lagos' : [s.city, s.state].filter((x, i, a) => x && a.indexOf(x) === i).join(', ') || 'Nigeria';

/* ---------- All stations, each with an id ---------- */
const STATIONS = [];
const ids = new Set();
function addStation(s) {
  let id = s.id, n = 2;
  while (ids.has(id)) id = `${s.id}-${n++}`;
  ids.add(id);
  Object.assign(s, { id, links: s.links || [], urls: [], ui: 0, url: '' });
  s.q = [s.name, ...(s.f ? [String(s.f)] : [])];
  STATIONS.push(s);
  return s;
}
LAGOS_FM.forEach(s => addStation({ ...s, page: 'lagos', id: 'lagos:' + s.f.toFixed(1) }));
LAGOS_ONLINE.forEach(s => addStation({ ...s, page: 'lagos', online: true, id: 'lagos-online:' + slug(s.name) }));
NIGERIA.forEach(s => addStation({ ...s, page: 'nigeria', id: (slug(s.state) || 'ng') + ':' + slug(s.name) }));
const lagosFM = s => s.page === 'lagos' && !s.online;
const byF = f => STATIONS.find(s => lagosFM(s) && Math.abs(s.f - f) < .05);
const byId = id => STATIONS.find(s => s.id === id);

/* ---------- Your stations, your links, favourites ---------- */
function customStation(c) {
  return addStation({ f: c.f, name: c.name, page: 'lagos', custom: true, id: 'custom:' + c.f.toFixed(1), url: '' , _url: c.url || '' });
}
(store.get('starlite-custom', []) || []).forEach(c => {
  const f = Math.round(+c.f * 10) / 10;
  if (f >= MIN && f <= MAX && c.name && !byF(f)) { const s = customStation({ f, name: String(c.name).slice(0, 40), url: c.url }); s.url = s._url; s.urls = s.url ? [s.url] : []; }
});
// Your links: keyed by station id now; older ones were keyed by Lagos frequency
const linkStore = store.get('starlite-links-v2', null) || Object.fromEntries(Object.entries(store.get('starlite-links', {})).map(([f, u]) => [(byF(+f) || {}).id, u]).filter(([id]) => id));
STATIONS.forEach(s => { if (!s.custom && typeof linkStore[s.id] === 'string') s.url = linkStore[s.id]; });
function saveCustom() {
  store.set('starlite-custom', STATIONS.filter(s => s.custom).map(s => ({ f: s.f, name: s.name, url: s.url })));
  store.set('starlite-links-v2', Object.fromEntries(STATIONS.filter(s => !s.custom && s.url).map(s => [s.id, s.url])));
}
// Favourites are station ids; older ones were Lagos frequencies (and before that, the preset buttons)
let favs = store.get('starlite-favs', null);
if (!Array.isArray(favs)) favs = store.get('starlite-presets-v2', []) || [];
favs = [...new Set(favs.map(v => typeof v === 'number' ? (byF(v) || {}).id : v).filter(id => id && byId(id)))];
store.set('starlite-favs', favs);
const isFav = s => favs.includes(s.id);
function toggleFav(s) {
  favs = isFav(s) ? favs.filter(id => id !== s.id) : [...favs, s.id];
  store.set('starlite-favs', favs);
  if (navigator.vibrate) navigator.vibrate(20);
  toast(isFav(s) ? `${s.name} added to Favourites` : `${s.name} removed from Favourites`);
  render();
}

/* ---------- Finding streams for Lagos stations without a link ---------- */
async function apiGet(path) {
  for (const base of API) {
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
      if (r.ok) return await r.json();
    } catch (e) {}
  }
  return [];
}
function score(st, s, term) {
  const n = (st.name || '').toLowerCase(), state = (st.state || '').toLowerCase();
  if (!n.includes(s.custom ? term.toLowerCase() : term.toLowerCase().split(' ')[0])) return -99;
  // A bare frequency only counts for a Lagos station or one with the right name, not 92.9 in another city
  if (/^[\d.]+$/.test(term) && !(state.includes('lagos') || n.includes('lagos') || n.includes(s.name.toLowerCase().split(' ')[0]))) return -99;
  let p = 0;
  if (state.includes('lagos') || n.includes('lagos')) p += 4;
  if (s.f && n.includes(String(s.f))) p += 4;
  if (OTHER_CITIES.test(n) || OTHER_CITIES.test(state)) p -= 6;
  if (st.lastcheckok === 1) p += 2;
  p += Math.min(3, Math.log10((st.votes || 0) + 1));
  return p;
}
const known = s => s.url ? [s.url, ...s.links.filter(u => u !== s.url)] : s.links;   // your own link goes first
async function lookup(s) {
  if (s.url || s.links.length) { s.urls = known(s); s.ui = 0; s.dead = false; return; }
  const found = [];
  for (const term of s.q) {
    const list = await apiGet(`/json/stations/search?name=${encodeURIComponent(term)}&countrycode=NG&hidebroken=true&limit=25`);
    list.forEach(st => found.push({ st, p: score(st, s, term) }));
  }
  found.sort((a, b) => b.p - a.p);
  const urls = [];
  for (const { st, p } of found) {
    if (p < 1) continue;
    for (const u of [st.url_resolved, st.url]) {
      if (!u || urls.includes(u)) continue;
      if (location.protocol === 'https:' && u.startsWith('http:')) continue; // phones block http streams on https pages
      if (DEAD.some(d => u.includes(d))) continue;
      urls.push(u);
    }
  }
  s.urls = urls.slice(0, 4); s.ui = 0; s.dead = false;
}
let streamCache = { t: 0, urls: {} };
function saveStreamCache() {
  streamCache.urls = Object.fromEntries(STATIONS.filter(s => lagosFM(s) && !s.links.length && !s.url).map(s => [s.id, s.urls]));
  store.set('starlite-streams-v5', streamCache);
}
async function findStreams() {
  streamCache = store.get('starlite-streams-v5', streamCache);
  const fresh = Date.now() - streamCache.t < 7 * 864e5;
  if (!fresh) streamCache.t = Date.now();
  STATIONS.forEach(s => { if (s.url || s.links.length) s.urls = known(s); });   // these are ready straight away
  render();
  await Promise.all(STATIONS.filter(s => lagosFM(s) && !s.urls.length).map(async s => {
    const cached = fresh && streamCache.urls[s.id];
    if (cached) s.urls = cached; else await lookup(s);
  }));
  saveStreamCache();
  render();
}

/* ---------- Playing ---------- */
const player = new Audio();
player.preload = 'none';
let on = false, sel = null, current = null, status = '', volume = .6;
let page = store.get('starlite-page', 'lagos') === 'nigeria' ? 'nigeria' : 'lagos';
{
  const saved = store.get('starlite-live', null);
  if (saved) {
    volume = clamp(+saved.v, 0, 1); if (isNaN(volume)) volume = .6;
    sel = (saved.id && byId(saved.id)) || (typeof saved.f === 'number' && byF(saved.f)) || null;
  }
}
function saveLive() { store.set('starlite-live', { id: sel ? sel.id : null, v: volume }); }
const playable = s => s.urls.length > 0;

function connect(s) {
  current = s;
  if (!s) { player.pause(); player.removeAttribute('src'); player.load(); status = ''; update(); return; }
  status = 'connecting';
  player.src = s.urls[s.ui % s.urls.length];
  player.volume = volume * volume;
  player.play().catch(() => {});
  setMediaSession(s);
  update();
}
player.addEventListener('playing', () => { if (current) { status = 'playing'; update(); } });
player.addEventListener('waiting', () => { if (current) { status = 'buffering'; update(); } });
player.addEventListener('error', () => {
  if (!current || !player.getAttribute('src')) return;
  const s = current; s.ui++;
  if (s.ui < s.urls.length) connect(s);            // try the next link for this station
  else { s.dead = true; status = 'unavailable'; update(); }
});

function play(s) {
  if (!s) return;
  if (!playable(s)) return lagosFM(s) ? openSheet(s) : toast(`${s.name} isn't streaming right now`);
  sel = s; on = true; s.dead = false; s.ui = 0;
  connect(s); saveLive();
}
function off() { on = false; stopScan(); connect(null); applyUpdate(); }
// ◀ ▶ and Scan move through the stations on the page the current station is on, in the order shown
function order(p) {
  const list = STATIONS.filter(s => s.page === p && playable(s));
  if (p === 'lagos') return [...list.filter(s => !s.online).sort((a, b) => a.f - b.f), ...list.filter(s => s.online).sort(byName)];
  const rank = st => { const i = REGIONS.findIndex(([, ss]) => ss.includes(st)); return i < 0 ? 99 : i * 10 + REGIONS[i][1].indexOf(st); };
  return list.sort((a, b) => rank(a.state) - rank(b.state) || (a.state || '').localeCompare(b.state || '') || (a.f || 999) - (b.f || 999) || byName(a, b));
}
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
function step(dir) {
  const list = order(sel ? sel.page : page);
  if (!list.length) return;
  const i = list.indexOf(sel);
  play(list[((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir + list.length) % list.length]);
}

function setMediaSession(s) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: s.name, artist: `${s.f ? fm(s) + ' · ' : ''}${place(s)}`, album: 'Redio Life' });
}
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('nexttrack', () => { stopScan(); step(1); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { stopScan(); step(-1); });
  navigator.mediaSession.setActionHandler('pause', () => { if (on) off(); });
  navigator.mediaSession.setActionHandler('play', () => { if (!on) play(sel || order(page)[0]); });
}

/* ---------- Now-playing panel ---------- */
const radio = $('radio'), eye = $('eye'), powerBtn = $('power'), scanBtn = $('scan'), volKnob = $('volKnob');
function update() {
  radio.dataset.on = on;
  powerBtn.setAttribute('aria-pressed', on);
  $('nowName').textContent = sel ? sel.name : 'Pick a station';
  const where = sel ? `${sel.f ? fm(sel) + ' · ' : ''}${place(sel)}` : '';
  $('nowLine').textContent = !on ? (sel ? `${where} · off` : 'Off')
    : status === 'playing' ? `${where} · live`
    : status === 'buffering' ? `${where} · buffering…`
    : status === 'unavailable' ? `${where} · stream is down right now`
    : `${where} · connecting…`;
  eye.style.setProperty('--gap', (status === 'playing' ? 6 : status === 'unavailable' ? 120 : 70) + 'deg');
  volKnob.style.transform = `rotate(${-135 + volume * 270}deg)`;
  volKnob.setAttribute('aria-valuenow', Math.round(volume * 100));
  player.volume = volume * volume;
  markTiles();
}

/* ---------- Station grid ---------- */
const tiles = new Map();   // station -> [tile elements]
function tile(s) {
  const t = document.createElement('div'), b = document.createElement('button'), star = document.createElement('button');
  t.className = 'tile'; b.className = 'play'; star.className = 'star';
  const top = document.createElement('b'), nm = document.createElement('span'), eq = document.createElement('div');
  top.textContent = s.f ? s.f.toFixed(1) : s.page === 'nigeria' && s.city ? s.city : 'Online';
  if (!s.f) top.className = 'word';
  nm.textContent = s.name;
  b.title = `${s.name} · ${s.f ? fm(s) + ' · ' : ''}${place(s)}`;
  eq.className = 'eq'; eq.innerHTML = '<i></i><i></i><i></i>';
  b.append(top, nm, eq);
  b.addEventListener('click', () => { stopScan(); if (on && sel === s) off(); else play(s); });
  b.addEventListener('contextmenu', e => { e.preventDefault(); if (playable(s)) toggleFav(s); });   // long-press on phones
  star.addEventListener('click', () => toggleFav(s));
  if (playable(s)) t.append(b, star); else { t.classList.add('nostream'); t.append(b); }
  if (!tiles.has(s)) tiles.set(s, []);
  tiles.get(s).push(t);
  return t;
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function grid(list) { const g = el('div', 'grid'); list.forEach(s => g.appendChild(tile(s))); return g; }
function group(title, count, list, cls = 'group-title') {
  const sec = el('section'), h = el('h2', cls, title);
  if (count !== undefined) h.appendChild(el('small', '', count));
  sec.append(h, grid(list));
  return sec;
}
function render() {
  tiles.clear();
  const box = $('pageBox'); box.textContent = '';
  const q = $('find').value.trim().toLowerCase();
  $('tabLagos').setAttribute('aria-selected', page === 'lagos');
  $('tabNigeria').setAttribute('aria-selected', page === 'nigeria');
  const favList = favs.map(byId).filter(s => s && playable(s));
  $('favBox').hidden = !favList.length || !!q;
  const fg = $('favGrid'); fg.textContent = ''; favList.forEach(s => fg.appendChild(tile(s)));
  $('favCount').textContent = favList.length;

  if (q) {   // search covers every station on both pages
    const hits = STATIONS.filter(s => playable(s) &&
      [s.name, s.city, s.state, s.f ? s.f.toFixed(1) : '', s.page === 'lagos' ? 'lagos' : ''].some(x => x && x.toLowerCase().includes(q)));
    const live = hits.filter(playable);
    box.appendChild(group('Search results', `${live.length} found`, [...order('lagos'), ...order('nigeria')].filter(s => live.includes(s))));
    if (!hits.length) box.appendChild(el('p', 'empty', `Nothing matches “${$('find').value.trim()}”`));
  } else if (page === 'lagos') {
    const fmList = order('lagos').filter(s => !s.online), online = order('lagos').filter(s => s.online);
    box.appendChild(group('Lagos FM', `${fmList.length} stations`, fmList));
    if (!fmList.length) box.lastChild.querySelector('.grid').appendChild(el('p', 'empty', 'Finding stations…'));
    if (online.length) box.appendChild(group('Lagos online stations', `${online.length}`, online));
  } else {
    const all = order('nigeria');
    REGIONS.forEach(([region, states]) => {
      const inRegion = all.filter(s => states.includes(s.state));
      if (!inRegion.length) return;
      const sec = el('section'), h = el('h2', 'region-title', region);
      h.appendChild(el('small', '', `${inRegion.length} stations`));
      sec.appendChild(h);
      states.forEach(st => {
        const list = inRegion.filter(s => s.state === st);
        if (list.length) { sec.appendChild(el('h3', 'state-title', `${st} · ${list.length}`)); sec.appendChild(grid(list)); }
      });
      box.appendChild(sec);
    });
    const rest = all.filter(s => !REGIONS.some(([, ss]) => ss.includes(s.state)));
    if (rest.length) box.appendChild(group('Nationwide & online', `${rest.length} stations`, rest, 'region-title'));
  }
  markTiles();
}
function markTiles() {
  tiles.forEach((els, s) => els.forEach(t => {
    const isCur = sel === s && on;
    t.classList.toggle('current', isCur);
    t.classList.toggle('live', isCur && status === 'playing');
    t.classList.toggle('down', !!s.dead);
    const b = t.querySelector('.play'), star = t.querySelector('.star');
    b.setAttribute('aria-pressed', isCur);
    b.setAttribute('aria-label', playable(s) ? `${s.name}, ${s.f ? fm(s) + ', ' : ''}${place(s)}${isCur ? ', playing. Tap to switch off' : ''}` : `${s.name} ${fm(s)}, no online stream yet. Tap to add its link`);
    if (star) { star.textContent = isFav(s) ? '★' : '☆'; star.setAttribute('aria-pressed', isFav(s)); star.setAttribute('aria-label', `${isFav(s) ? 'Remove' : 'Add'} ${s.name} ${isFav(s) ? 'from' : 'to'} Favourites`); }
  }));
}
$('find').addEventListener('input', render);
function setPage(p) { page = p; store.set('starlite-page', p); render(); }
$('tabLagos').addEventListener('click', () => setPage('lagos'));
$('tabNigeria').addEventListener('click', () => setPage('nigeria'));

/* ---------- Buttons and volume ---------- */
let scanning = false, scanTimer = 0;
function stopScan() {
  if (!scanning) return;
  scanning = false; clearTimeout(scanTimer);
  scanBtn.setAttribute('aria-pressed', 'false'); scanBtn.textContent = 'Scan';
}
function scanStep() { if (!scanning) return; step(1); scanTimer = setTimeout(scanStep, 12000); }
scanBtn.addEventListener('click', () => {
  if (scanning) return stopScan();
  scanning = true; scanBtn.setAttribute('aria-pressed', 'true'); scanBtn.textContent = 'Stop scan';
  scanStep();
});
$('next').addEventListener('click', () => { stopScan(); step(1); });
$('prev').addEventListener('click', () => { stopScan(); step(-1); });
powerBtn.addEventListener('click', () => { stopScan(); if (on) off(); else play(sel && playable(sel) ? sel : order(page)[0]); });

function knobDrag(el, onDelta) {
  let last = null;
  const ang = e => { const r = el.getBoundingClientRect(); return Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2) * 180 / Math.PI; };
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); last = ang(e); });
  el.addEventListener('pointermove', e => {
    if (last === null) return;
    const a = ang(e); let d = a - last;
    if (d > 180) d -= 360; if (d < -180) d += 360;
    last = a; onDelta(d);
  });
  const end = () => { last = null; saveLive(); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
knobDrag(volKnob, d => { volume = clamp(volume + d / 270, 0, 1); update(); });
volKnob.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { volume = clamp(volume + .05, 0, 1); update(); saveLive(); e.preventDefault(); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { volume = clamp(volume - .05, 0, 1); update(); saveLive(); e.preventDefault(); }
});

const toastEl = $('toast');
let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

/* ---------- Add a Lagos station, or paste a link for one ---------- */
const sheet = $('sheet'), inFreq = $('inFreq'), inName = $('inName'), inUrl = $('inUrl'), sheetMsg = $('sheetMsg');
function parseFreq(v) {
  const f = Math.round(parseFloat(String(v).replace(',', '.')) * 10) / 10;
  return f >= MIN && f <= MAX ? f : null;
}
function renderMine() {
  const mine = STATIONS.filter(s => s.custom || s.url).sort((a, b) => (a.f || 0) - (b.f || 0)), ul = $('mine');
  $('mineBox').hidden = !mine.length;
  ul.textContent = '';
  mine.forEach(s => {
    const li = document.createElement('li'), label = document.createElement('span'), del = document.createElement('button');
    label.textContent = `${s.f ? s.f.toFixed(1) + ' ' : ''}${s.name}${!s.custom ? ' · your link' : !s.urls.length ? ' · no stream yet' : ''}`;
    del.type = 'button'; del.textContent = 'Remove'; del.setAttribute('aria-label', s.custom ? `Remove ${s.name}` : `Remove your link for ${s.name}`);
    del.addEventListener('click', () => removeStation(s));
    li.append(label, del); ul.appendChild(li);
  });
}
function removeStation(s) {
  if (current === s) off();
  if (!s.custom) {   // built-in station: just drop your link
    s.url = ''; saveCustom(); renderMine();
    lookup(s).then(() => { saveStreamCache(); render(); });
    return toast(`Removed your link for ${s.name}`);
  }
  STATIONS.splice(STATIONS.indexOf(s), 1); ids.delete(s.id);
  if (sel === s) sel = null;
  favs = favs.filter(id => id !== s.id); store.set('starlite-favs', favs);
  saveCustom(); saveStreamCache(); renderMine(); render(); update();
  toast(`Removed ${s.name}`);
}
function openSheet(s) {
  inFreq.value = s ? s.f.toFixed(1) : ''; inName.value = s ? s.name : ''; inUrl.value = '';
  $('sheetTitle').textContent = s ? `Add a link for ${s.name}` : 'Add a Lagos station';
  sheetMsg.textContent = s ? `Paste the stream link for ${s.name} ${s.f.toFixed(1)} and tap Save.` : '';
  renderMine();
  sheet.showModal();
  (s ? inUrl : inFreq).focus();
}
$('addBtn').addEventListener('click', () => openSheet(null));
$('sheetCancel').addEventListener('click', () => sheet.close());
$('sheetForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = parseFreq(inFreq.value), say = (msg, el) => { sheetMsg.textContent = msg; el.focus(); };
  if (f === null) return say('Type a frequency between 88.0 and 108.0, like 101.1', inFreq);
  const name = inName.value.trim(), url = inUrl.value.trim();
  if (url && !/^https:\/\/\S+$/i.test(url)) return say(/^http:/i.test(url) ? 'Phones block http:// streams in apps and browsers. Find the https:// link for this station.' : 'A stream link starts with https://', inUrl);
  let s = byF(f);
  if (s && !s.custom) {
    if (!url) return say(`${s.name} is already on ${f.toFixed(1)}. Paste its stream link to use your own.`, inUrl);
    if (current === s) off();
    s.url = url; s.urls = known(s); s.ui = 0; s.dead = false;
    saveCustom(); sheet.close(); render(); play(s);
    return toast(`Using your stream link for ${s.name}`);
  }
  if (!name) return say('Give the station a name', inName);
  if (s) {   // same frequency as one of yours: update it
    if (current === s) off();
    s.name = name; s.url = url; s.q = [name, String(f)]; s.urls = url ? [url] : []; s.dead = false;
    toast(`Updated ${name} on ${f.toFixed(1)}`);
  } else {
    s = customStation({ f, name, url }); s.url = url; s.urls = url ? [url] : [];
    toast(url ? `Added ${name} on ${f.toFixed(1)}` : `Added ${name} · looking for its stream…`);
  }
  saveCustom(); sheet.close(); setPage('lagos');
  if (url) return play(s);
  lookup(s).then(() => {
    saveStreamCache(); render();
    if (s.urls.length) { toast(`Found a stream for ${s.name}`); play(s); }
    else toast(`No stream found for ${s.name}. Tap + Add again with its stream link to play it.`);
  });
});

render();
update();
findStreams();
/* Updates: check whenever the app comes back to the front, and switch to a new version once the radio is off */
let updateReady = false;
function applyUpdate() { if (updateReady && !on) location.reload(); }
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) { updateReady = true; applyUpdate(); } });
}
