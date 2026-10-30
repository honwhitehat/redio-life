/* Redio Life colour themes. Loaded in <head> so the chosen colours are there before the page draws.
   The picker itself is wired up in app.js. "classic" is the walnut radio everyone starts with;
   "auto" follows the phone: Clean Light by day, Midnight at night. */
const THEMES = [
  ['classic', 'Redio Life classic'], ['auto', 'Match my phone'], ['hacker', 'Hacker Green'], ['blue', 'Classic Blue'],
  ['social', 'Social Glow'], ['green', 'Naija Green'], ['sunset', 'Lagos Sunset'], ['teal', 'Afrobeat Teal'],
  ['ember', 'Ember Red'], ['lime', 'Lime Night'], ['midnight', 'Midnight'], ['sand', 'Soft Sand'], ['light', 'Clean Light'],
];
function applyTheme(choice) {
  const root = document.documentElement;
  if (!THEMES.some(([k]) => k === choice)) choice = 'classic';
  if (choice === 'auto') choice = matchMedia('(prefers-color-scheme: dark)').matches ? 'midnight' : 'light';
  if (choice === 'classic') delete root.dataset.theme; else root.dataset.theme = choice;
  const bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.content = getComputedStyle(root).getPropertyValue('--walnut-dark').trim() || '#3B2414';
}
try { applyTheme(JSON.parse(localStorage.getItem('redio-theme') || '"classic"')); } catch (e) { applyTheme('classic'); }
