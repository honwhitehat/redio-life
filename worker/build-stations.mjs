// Builds src/stations.json from the site's stations.js, so the counter only accepts real Redio Life
// stations and uses its own names for them. Wrangler runs this before every `dev` and `deploy`.
// The ids must match how app.js numbers stations (see addStation there).
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../stations.js', import.meta.url), 'utf8');
const { LAGOS_FM, LAGOS_ONLINE, NIGERIA } = vm.runInNewContext(`${src}\n;({ LAGOS_FM, LAGOS_ONLINE, NIGERIA })`);

const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const place = s => s.page === 'lagos' ? 'Lagos' : [s.city, s.state].filter((x, i, a) => x && a.indexOf(x) === i).join(', ') || 'Nigeria';
const out = {}, ids = new Set();
function add(s, base) {
  let id = base, n = 2;
  while (ids.has(id)) id = `${base}-${n++}`;
  ids.add(id);
  out[id] = [s.name, place(s)];
}
LAGOS_FM.forEach(s => add({ ...s, page: 'lagos' }, 'lagos:' + s.f.toFixed(1)));
LAGOS_ONLINE.forEach(s => add({ ...s, page: 'lagos' }, 'lagos-online:' + slug(s.name)));
NIGERIA.forEach(s => add({ ...s, page: 'nigeria' }, (slug(s.state) || 'ng') + ':' + slug(s.name)));

writeFileSync(new URL('./src/stations.json', import.meta.url), JSON.stringify(out));
console.log(`stations.json: ${Object.keys(out).length} stations`);
