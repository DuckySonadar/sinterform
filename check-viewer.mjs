/* Check the viewer, and use it to check the two halves against each other.
 *
 *     node check-viewer.mjs [--require]
 *
 * The viewer draws every scene twice: once by running glsl.js on the GPU, once
 * by running the JS twins in sinterform.js through surfaceNets. Those are
 * meant to be the same shape, so their silhouettes are meant to be the same
 * silhouette -- and that is checkable, not just lookable-at.
 *
 * check-glsl.mjs already compares the two at sampled points, which is sharper
 * per-point but blind to everything around the sampling: a primitive whose
 * bounds are wrong, a boolean folded the wrong way, a rotation applied in the
 * other order. Those show up here, because they change the outline.
 *
 * It also just loads the page, which catches the ordinary breakages: a shader
 * that stopped compiling, a module that stopped attaching to its global.
 *
 * Needs Playwright and a browser. Without them it says so and exits 0, unless
 * --require, which is what CI should use.
 */
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQUIRE = process.argv.includes('--require');

let chromium;
for (const cand of [process.env.PLAYWRIGHT_MODULE,
                    join(HERE, 'node_modules/playwright/index.mjs'),
                    join(HERE, '..', 'node_modules/playwright/index.mjs'),
                    'playwright']) {
  if (!cand) continue;
  try {
    ({ chromium } = await import(cand.startsWith('/') ? pathToFileURL(cand).href : cand));
    break;
  } catch { /* next */ }
}
if (!chromium) {
  const msg = 'check-viewer: Playwright not found — the viewer was NOT loaded.';
  if (REQUIRE) { console.error(msg); process.exit(1); }
  console.log(`${msg}\n  npm i playwright   (then re-run; --require makes this fatal)`);
  process.exit(0);
}

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};

// Scenes worth cross-checking. Coarse mesh resolution keeps the run short;
// the silhouette is not sensitive to it at this size.
const SCENES = ['every primitive', 'booleans', 'two bodies, no blend across',
                'ice cream',
                // The two that arrive as a baked field rather than as
                // primitives, which is the only way a sketch can reach the
                // shader at all -- and the only scenes here that exercise the
                // field primitive on either side.
                'sketch 2D, extruded', 'sketch 3D, extruded'];
const RES = 0.9;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
});
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(pathToFileURL(join(HERE, 'viewer.html')).href);
await page.waitForFunction('window.__ready === true', { timeout: 30000 });
await page.waitForTimeout(800);

console.log('SinterForm viewer\n');
ok(errors.length === 0, `the page loads clean${errors.length ? ' — ' + errors.join(' | ') : ''}`);
ok(await page.evaluate('!!(window.SinterForm && window.SinterFormGLSL && window.SinterView)'),
   'all three modules attached to their globals');
ok(!(await page.textContent('#err')).trim(), 'no shader or mesh error reported');

// Turn a canvas screenshot into a silhouette mask, in the page, where there is
// an image decoder.
const maskOf = async (buf) => page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  // silhouette mode paints the solid white and everything else black
  const m = new Uint8Array(cv.width * cv.height);
  let n = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    if (d[i] > 127) { m[p] = 1; n++; }   // flat white where the solid is
  }
  return { mask: Array.from(m), w: cv.width, h: cv.height, n };
}, buf.toString('base64'));

// Compare silhouettes, not pictures: no ground, no shading, no tint. The two
// modes are different renderers, and every difference that is not geometry
// has to be taken out of the picture before the picture means anything.
await page.evaluate(() => window.__V.setFlat(true));
await page.evaluate((r) => {
  const el = document.getElementById('res');
  el.value = String(r);
  el.dispatchEvent(new Event('input'));
}, RES);

for (const scene of SCENES) {
  await page.selectOption('#scene', scene);
  await page.waitForTimeout(300);

  await page.evaluate(() => document.querySelector('#mode button[data-m="raymarch"]').click());
  await page.waitForTimeout(700);
  const A = await maskOf(await page.locator('#view').screenshot());

  await page.evaluate(() => document.querySelector('#mode button[data-m="mesh"]').click());
  await page.waitForTimeout(4000);
  const B = await maskOf(await page.locator('#view').screenshot());

  if (A.w !== B.w || A.h !== B.h) { ok(false, `${scene}: the two modes drew different sizes`); continue; }
  let inter = 0, union = 0;
  for (let i = 0; i < A.mask.length; i++) {
    const a = A.mask[i], b = B.mask[i];
    if (a && b) inter++;
    if (a || b) union++;
  }
  const iou = union ? inter / union : 0;
  ok(A.n > 2000, `${scene}: the raymarch drew something (${A.n.toLocaleString()} px)`);
  ok(B.n > 2000, `${scene}: and so did the mesh (${B.n.toLocaleString()} px)`);
  // A meshed surface sits up to half a cell inside the true one and its edges
  // are faceted, so the outlines are close rather than identical.
  ok(iou > 0.9, `${scene}: the two silhouettes agree (IoU ${iou.toFixed(4)})`);
}

const late = errors.slice();
ok(late.length === 0, `nothing broke while driving it${late.length ? ' — ' + late.join(' | ') : ''}`);

await browser.close();
console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
