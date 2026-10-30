/* Redio Life colour themes. Loaded in <head> so the chosen colours are there before the page draws.
   The picker itself is wired up in app.js. "auto" is the classic walnut radio, following the phone's light or dark mode. */
const THEMES = [
  ['auto', 'Match my phone'], ['midnight', 'Midnight'], ['green', 'Naija Green'], ['sunset', 'Lagos Sunset'],
  ['teal', 'Afrobeat Teal'], ['ember', 'Ember Red'], ['lime', 'Lime Night'], ['sand', 'Soft Sand'], ['light', 'Clean Light'],
];
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice && choice !== 'auto' && THEMES.some(([k]) => k === choice)) root.dataset.theme = choice;
  else delete root.dataset.theme;
  const bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.content = getComputedStyle(root).getPropertyValue('--walnut-dark').trim() || '#3B2414';
}
try { applyTheme(JSON.parse(localStorage.getItem('redio-theme') || '"auto"')); } catch (e) { applyTheme('auto'); }
