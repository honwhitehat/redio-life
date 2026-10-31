/* Redio Life colour themes. Loaded in <head> so the chosen colours are there before the page draws.
   The picker itself is wired up in app.js. "classic" is the walnut radio everyone starts with;
   "auto" follows the phone: Day or Night. */
const THEMES = [
  ['classic', 'Redio Life classic'], ['auto', 'Match my phone'], ['day', 'Day'], ['night', 'Night'],
  ['green', 'Naija Green'], ['hacker', 'Hacker Green'], ['blue', 'Classic Blue'], ['sunset', 'Lagos Sunset'],
];
const OLD_THEMES = { light: 'day', midnight: 'night' };   // renamed; other removed themes fall back to classic
function applyTheme(choice) {
  const root = document.documentElement;
  choice = OLD_THEMES[choice] || choice;
  if (!THEMES.some(([k]) => k === choice)) choice = 'classic';
  if (choice === 'auto') choice = matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day';
  if (choice === 'classic') delete root.dataset.theme; else root.dataset.theme = choice;
  const bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.content = getComputedStyle(root).getPropertyValue('--walnut-dark').trim() || '#3B2414';
}
try { applyTheme(JSON.parse(localStorage.getItem('redio-theme') || '"classic"')); } catch (e) { applyTheme('classic'); }
