/* Check that meshing on the GPU produces the same solid as meshing in JS.
 *
 *     node check-glmesh.mjs
 *
 * `glmesh.js` moves the expensive half of meshing -- one SDF evaluation per
 * grid corner -- onto the GPU, and leaves surfaceNets where it is. That is
 * only worth having if the two paths agree, and "agree" has to mean more than
 * "both produced triangles": a grid indexed wrongly, a slab boundary off by a
 * row, or a uniform packed into the wrong float all produce a mesh.
 *
 * So the grids themselves are compared sample for sample, before any meshing,
 * which localises a fault to the sampler rather than to the mesher. Then the
 * meshes are compared on the things a wrong grid would move: triangle count,
 * watertightness, and enclosed volume.
 *
 * Needs Playwright and a browser. The kernel does not depend on either and
 * neither does glmesh.js -- it needs a WebGL2 context, which a browser is one
 * way to have. Skips and exits 0 when they are absent, unless --require.
 */
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQUIRE = process.argv.includes('--require');

const load = (f) => {
  const m = { exports: {} };
  new Function('module', readFileSync(join(HERE, f), 'utf8'))(m);
  return m.exports;
};
const SF = load('sinterform.js');

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};

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
  const msg = 'check-glmesh: Playwright not found — GPU meshing NOT checked.';
  if (REQUIRE) { console.error(msg); process.exit(1); }
  console.log(`${msg}\n  npm i playwright   (then re-run; --require makes this fatal)`);
  process.exit(0);
}

const N = (t, o) => Object.assign({
  t, on: true, op: 'add', k: 0, b: 0, fi: 0, round: 0,
  mx: false, my: false, mz: false,
  p: [0, 0, 0], r: [0, 0, 0], d: SF.PRIMS[t].def.slice()
}, o);

// Scenes chosen for what they would break. The boolean one exercises the fold
// and the blend; the rotated one exercises invRot, which is the most likely
// thing to be transcribed differently between two shader assemblies; the
// profile one puts a compiled-in outline through the GPU path, which nothing
// else here does.
const SCENES = {
  'a box and a sphere, blended': [{ id: 0, nodes: [
    N('box', { p: [-6, 0, 0], d: [30, 22, 16], round: 2, k: 4 }),
    N('sphere', { p: [10, 0, 4], d: [11, 0, 0], k: 4 })
  ] }],
  'cut and rotated': [{ id: 0, nodes: [
    N('cylinder', { r: [22, -35, 40], d: [14, 40, 0] }),
    N('box', { op: 'cut', p: [4, 3, 6], r: [10, 20, 30], d: [16, 16, 16], round: 1 })
  ] }],
  'two bodies': [
    { id: 0, nodes: [N('torus', { p: [-14, 0, 0], d: [12, 4, 0], k: 3 })] },
    { id: 1, nodes: [N('octa', { p: [16, 0, 0], d: [14, 0, 0] })] }
  ],
  'a profile, default outline': [{ id: 0, nodes: [
    N('profile', { d: [10, 10, 6], r: [0, 25, 15] })
  ] }]
};

const RES = 0.55;

// Volume by the divergence theorem, plus two edge counts that are usually
// lumped together and should not be.
//
//   holes        an edge used by one triangle -- a boundary, a real gap, and
//                the thing that makes an STL unprintable
//   pinches      an edge used by more than two -- closed, but non-manifold,
//                which is what surface nets does where a feature is thinner
//                than a cell. Not a defect to fix here: it is the grid being
//                too coarse for the shape, and it slices correctly.
function measure(m) {
  const P = m.positions, I = m.indices, nt = I.length / 3;
  const edges = new Map();
  let V = 0;
  for (let t = 0; t < nt; t++) {
    const A = I[3 * t], B = I[3 * t + 1], C = I[3 * t + 2];
    for (const [x, y] of [[A, B], [B, C], [C, A]]) {
      const key = x < y ? `${x}_${y}` : `${y}_${x}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
    const a = 3 * A, b = 3 * B, c = 3 * C;
    V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
        - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
        + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  let holes = 0, pinches = 0;
  for (const v of edges.values()) { if (v < 2) holes++; else if (v > 2) pinches++; }
  return { nt, holes, pinches, volume: Math.abs(V) };
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
});
const page = await browser.newPage();
await page.goto('about:blank');
for (const f of ['sinterform.js', 'glsl.js', 'glmesh.js'])
  await page.addScriptTag({ content: readFileSync(join(HERE, f), 'utf8') });

console.log('SinterForm GPU meshing\n');

const got = await page.evaluate(({ scenes, res }) => {
  if (!SinterGLMesh.available()) return { error: 'no WebGL2 float target here' };
  const out = {};
  for (const [name, plan] of Object.entries(scenes)) {
    try {
      const sample = SinterGLMesh.sampler();
      // the grid, before any meshing: a fault in the sampler shows here rather
      // than being laundered through surfaceNets
      const nodes = [];
      for (const part of plan) for (const n of part.nodes) nodes.push(n);
      const B = SinterForm.sceneBounds(nodes);
      const pad = 2 * res;
      const lo = [B.lo[0] - pad, B.lo[1] - pad, B.lo[2] - pad];
      const n = [0, 1, 2].map(i => Math.ceil((B.hi[i] - B.lo[i] + 2 * pad) / res) + 1);
      const vol = new Float32Array(n[0] * n[1] * n[2]);
      const t0 = performance.now();
      sample(plan, lo, n, res, vol);
      const ms = performance.now() - t0;
      out[name] = { grid: Array.from(vol), lo, n, ms };
    } catch (e) { out[name] = { error: String(e.message || e) }; }
  }
  return { out };
}, { scenes: SCENES, res: RES });

await browser.close();

if (got.error) {
  const msg = `check-glmesh: ${got.error}`;
  if (REQUIRE) { console.error(msg); process.exit(1); }
  console.log(msg); process.exit(0);
}

for (const [name, plan] of Object.entries(SCENES)) {
  const R = got.out[name];
  console.log(`\n${name}`);
  if (!R || R.error) { ok(false, `the GPU sampler ran — ${R && R.error}`); continue; }

  // ---- 1. the grids, sample for sample -----------------------------------
  const { lo, n } = R;
  const jsVol = new Float32Array(n[0] * n[1] * n[2]);
  let k = 0;
  const t0 = Date.now();
  for (let i = 0; i < n[0]; i++)
    for (let j = 0; j < n[1]; j++)
      for (let m = 0; m < n[2]; m++)
        jsVol[k++] = SF.sceneSDF(plan, lo[0] + i * RES, lo[1] + j * RES, lo[2] + m * RES);
  const jsMs = Date.now() - t0;

  // The shader works in fp32 and, for any rotated shape, puts the Euler angles
  // through cos/sin -- which GLSL ES promises only to about 2^-11 relative.
  // At these coordinates that is a few thousandths of a millimetre, and it is
  // a property of the language rather than a difference of opinion about the
  // shape. The bar is set where that lands, two orders under anything this
  // prints.
  const BAR = 2e-2;
  let worst = 0, at = -1;
  for (let i = 0; i < jsVol.length; i++) {
    const e = Math.abs(jsVol[i] - R.grid[i]);
    if (e > worst) { worst = e; at = i; }
  }
  ok(worst < BAR, `the two grids agree over ${jsVol.length.toLocaleString()} `
    + `samples (worst ${worst.toExponential(2)} mm)`
    + (worst >= BAR ? ` — first at index ${at}` : ''));

  // A sign flip is the only thing that moves a vertex, so it is counted on its
  // own -- but a flip within the bar above is a coin toss at the surface, not
  // a disagreement about the shape. What would matter is a flip somewhere the
  // two grids are far apart, which is what this actually asserts.
  let flips = 0, deep = 0, deepest = 0;
  for (let i = 0; i < jsVol.length; i++) {
    if ((jsVol[i] < 0) === (R.grid[i] < 0)) continue;
    flips++;
    const d = Math.min(Math.abs(jsVol[i]), Math.abs(R.grid[i]));
    if (d > BAR) { deep++; deepest = Math.max(deepest, d); }
  }
  ok(deep === 0, `every sign difference is a sample within ${BAR} mm of the `
    + `surface (${flips} of ${jsVol.length.toLocaleString()})`
    + (deep ? ` — ${deep} are not, up to ${deepest.toFixed(3)} mm deep` : ''));

  // ---- 2. the meshes they produce ----------------------------------------
  const gpu = measure(SF.surfaceNets(new Float32Array(R.grid), n[0], n[1], n[2],
                                     lo[0], lo[1], lo[2], RES));
  const js = measure(SF.surfaceNets(jsVol, n[0], n[1], n[2],
                                    lo[0], lo[1], lo[2], RES));
  const dnt = Math.abs(gpu.nt - js.nt);
  ok(js.nt > 500 && dnt <= Math.max(8, js.nt * 2e-4),
     `the same mesh comes out: ${gpu.nt.toLocaleString()} triangles vs `
     + `${js.nt.toLocaleString()}${dnt ? ` (${dnt} from the flips above)` : ''}`);
  ok(gpu.holes === 0 && js.holes === 0, `neither has a hole in it`
    + (gpu.holes || js.holes ? ` — ${gpu.holes} / ${js.holes} boundary edges` : '')
    + (js.pinches ? ` (${js.pinches} non-manifold pinches, both, where the grid `
        + `is coarser than the feature)` : ''));
  const dv = Math.abs(gpu.volume - js.volume) / Math.max(js.volume, 1e-9);
  ok(dv < 1e-3, `and enclose the same volume: ${gpu.volume.toFixed(1)} mm³ `
    + `vs ${js.volume.toFixed(1)} (${(100 * dv).toFixed(4)}%)`);

  console.log(`        grid filled in ${R.ms.toFixed(0)} ms on the GPU, `
    + `${jsMs} ms in JS`);
}

// The one thing a caller has to be able to rely on: no context, no crash.
console.log('\nfalling back');
{
  const GM = load('glmesh.js');
  ok(typeof GM.available === 'function' && GM.available() === false,
     'available() is false in node, where there is no WebGL2 at all');
  const plan = SCENES['two bodies'];
  const m = SF.mesh(plan, { res: 1.2 });
  ok(m && m.indices.length > 0,
     `and SinterForm.mesh still meshes without it (${(m.indices.length / 3).toLocaleString()} triangles)`);
}

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
