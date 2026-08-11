/* Hold the SinterForm seam.
 *
 *     node check-kernel.mjs [path]
 *
 * With no argument it checks `sinterform.js` next to this file. Given a path
 * ending in .html it pulls the kernel out of the `<script id="sinterform">`
 * block instead, which is how MetaMeld checks the file its build produced --
 * the assertions live here, in the kernel's own repository, and its consumer
 * borrows them rather than keeping a second copy that can drift.
 *
 * What the kernel is for is being liftable: it does not touch the DOM, the GL
 * context, storage, or any application's state. That property is invisible --
 * nothing breaks the day someone reaches across it, and the application keeps
 * working right up until the moment the kernel is lifted out and does not.
 *
 * So it is checked. This refuses the kernel if it names anything
 * browser-shaped, runs it under node with no DOM at all, and asks it for some
 * geometry whose answer is known.
 *
 * Exit code is 0 or 1, so it can be a CI step.
 */
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = process.argv[2] ? process.argv[2] : join(HERE, 'sinterform.js');
const OPEN = '<script id="sinterform">';
const CLOSE = '</' + 'script>';

// Things the kernel may not name. `document` and `window` are the obvious
// ones; `gl.` and `localStorage` are the ones that crept in last time.
const FORBIDDEN = [
  /\bdocument\s*\./, /\bwindow\s*\./, /\blocalStorage\b/, /\bgetElementById\b/,
  /\baddEventListener\b/, /\bgl\s*\./, /\brequestAnimationFrame\b/,
  /\bnavigator\s*\./, /\bfetch\s*\(/, /\balert\s*\(/, /\bprompt\s*\(/
];

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};

const src = readFileSync(TARGET, 'utf8');
let kernel = src;
if (TARGET.endsWith('.html')) {
  const a = src.indexOf(OPEN);
  if (a < 0) { console.error(`no ${OPEN} in ${TARGET}`); process.exit(1); }
  const b = src.indexOf(CLOSE, a);
  if (b < 0) { console.error(`unterminated ${OPEN} in ${TARGET}`); process.exit(1); }
  kernel = src.slice(src.indexOf('\n', a) + 1, b);
}

console.log(`SinterForm kernel — ${kernel.split('\n').length} lines of `
  + `${relative(process.cwd(), TARGET) || TARGET}\n`);

// ---- 1. the seam holds ------------------------------------------------
// Comments are stripped first: the header talks *about* the DOM, and a
// checker that cannot tell prose from code is a checker nobody keeps.
const code = kernel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const re of FORBIDDEN) {
  const hit = code.match(re);
  ok(!hit, `kernel does not use ${re.source.replace(/\\b|\\s\*/g, '')}`
      + (hit ? ` — found ${JSON.stringify(hit[0])}` : ''));
}
// It also has to survive being inlined into one script element. A stray
// closing tag -- even inside a comment -- ends the element early and takes
// the whole page down with it.
ok(!kernel.includes(CLOSE), 'kernel contains no closing script tag');

// ---- 2. it runs with no browser at all --------------------------------
// Two things get evaluated here, and which one depends on the target. A bare
// sinterform.js is one module. The built HTML is sinterform.js *and* glsl.js
// spliced into one script element, and both end with `module.exports = ...`,
// so under node the second would simply overwrite the first. That is not a
// bug in the build -- in a browser each attaches to its own global and both
// survive -- but it does mean the namespace has to be read the way a browser
// reads it, off the global, rather than off module.exports.
const mod = { exports: {} };
const globals = {};
try {
  new Function('module', 'self', kernel)(mod, globals);
} catch (e) {
  console.log(`  FAIL  kernel throws under node: ${e.message}`);
  process.exit(1);
}
const SF = globals.SinterForm;
ok(typeof SF === 'object' && SF && SF.PRIMS, 'kernel exports a SinterForm namespace');
if (!TARGET.endsWith('.html'))
  ok(mod.exports === SF, 'and the node require() path returns the same object');
else
  ok(globals.SinterFormGLSL && globals.SinterFormGLSL.KEYS,
     'the built file carries the GLSL module alongside the kernel');
if (!SF || !SF.PRIMS) { console.log('\ncannot continue without a namespace'); process.exit(1); }

// The shader half lives in glsl.js now. It gets inlined into the same HTML,
// so it carries the same closing-tag hazard -- and it is the likelier of the
// two to acquire one, being full of shader source pasted in from elsewhere.
// Checking it here rather than in check-glsl.mjs is deliberate: that one needs
// a browser and is allowed to skip, and this hazard must never go unchecked.
if (!TARGET.endsWith('.html')) {
  const g = readFileSync(join(HERE, 'glsl.js'), 'utf8');
  ok(!g.includes(CLOSE), 'glsl.js contains no closing script tag either');
  const gmod = { exports: {} };
  let threw = null;
  try { new Function('module', g)(gmod); } catch (e) { threw = e; }
  ok(!threw, `glsl.js runs under node${threw ? ` — ${threw.message}` : ''}`);
  const GL = gmod.exports || {};
  ok(GL.KEYS && GL.KEYS.length === SF.PRIM_KEYS.length,
     `and covers all ${SF.PRIM_KEYS.length} primitives the kernel registers`
     + (GL.KEYS ? ` (${GL.KEYS.length})` : ''));
  ok(SF.PRIM_KEYS.every(k2 => GL.GLSL && GL.GLSL[k2]),
     'with no primitive present in one file and missing from the other');
}

// ---- 3. it computes the geometry it is supposed to --------------------
const node = (over) => Object.assign(
  { t: 'sphere', on: true, op: 'add', k: 0, b: 0, tg: null, fi: 0,
    p: [0, 0, 0], r: [0, 0, 0], d: [10, 0, 0], round: 0,
    mx: false, my: false, mz: false }, over);

const near = (got, want, tol, what) =>
  ok(Math.abs(got - want) < tol, `${what}: ${got.toFixed(4)} ≈ ${want}`);

const sphere = [{ id: 0, nodes: [node({})] }];
near(SF.sceneSDF(sphere, 0, 0, 0), -10, 1e-6, 'centre of a r=10 sphere is -10');
near(SF.sceneSDF(sphere, 10, 0, 0), 0, 1e-6, 'its surface is 0');
near(SF.sceneSDF(sphere, 25, 0, 0), 15, 1e-6, '15 mm outside is 15');

// a hard cut has to remove material; a blended one has to round the seam
const cut = [{ id: 0, nodes: [node({}), node({ op: 'cut', p: [10, 0, 0], d: [6, 0, 0] })] }];
ok(SF.sceneSDF(cut, 9, 0, 0) > 0, 'a cut sphere is empty where the cutter was');
ok(SF.sceneSDF(cut, -9, 0, 0) < 0, 'and still solid on the far side');

// two bodies meet in a plain min and never blend into each other
const two = [{ id: 0, nodes: [node({})] },
             { id: 1, nodes: [node({ b: 1, p: [40, 0, 0] })] }];
near(SF.sceneSDF(two, 20, 0, 0), 10, 1e-6, 'the gap between two bodies is unblended');

// the mesher and the exporter still produce something of the right shape
// {lo, hi} in mm, not {x0, x1} -- checked because I guessed wrong once
const B = SF.sceneBounds([node({})]);
ok(B && B.lo && B.hi, 'sceneBounds returns a {lo, hi} box');
near(B.lo[0], -10, 1e-6, 'the box of a r=10 sphere starts at -10');
near(B.hi[2], 10, 1e-6, 'and ends at +10');
ok(SF.sceneBounds([node({ op: 'cut' })]) === null,
   'a scene with nothing added has no bounds');
ok(SF.PRIM_KEYS.length >= 8, `${SF.PRIM_KEYS.length} primitives registered`);
ok(typeof SF.surfaceNets === 'function' && typeof SF.meshToSTL === 'function',
   'mesher and STL writer are exported');

// Which way the triangles face.
//
// This is the one that hid for a long time, because nothing downstream falls
// over when it is wrong. A slicer flood-fills orientation itself, so the
// prints came out; the viewer builds its vertex normals straight from the
// winding, so it lit every surface from the side facing away and looked
// merely odd; and every volume in these suites is measured through an
// absolute value, which is exactly the sort of abs() that swallows a sign
// nobody is checking.
//
// The test is against the distance field itself rather than against a
// particular shape: the gradient of a signed distance points *out* of the
// solid everywhere, so the triangles must too.
{
  const R = 10, res = 0.7, pad = 2 * res;   // `sphere` above is r = 10
  const lo = [-R - pad, -R - pad, -R - pad], hi = [R + pad, R + pad, R + pad];
  const n = [0, 1, 2].map(i => Math.ceil((hi[i] - lo[i]) / res) + 1);
  const vol = new Float32Array(n[0] * n[1] * n[2]);
  let w = 0;
  for (let i = 0; i < n[0]; i++)
    for (let j = 0; j < n[1]; j++)
      for (let k = 0; k < n[2]; k++)
        vol[w++] = SF.sceneSDF(sphere, lo[0] + i * res, lo[1] + j * res, lo[2] + k * res);
  const mesh = SF.surfaceNets(vol, n[0], n[1], n[2], lo[0], lo[1], lo[2], res);
  const P = mesh.positions, I = mesh.indices, nt = I.length / 3;
  const grad = (x, y, z) => {
    const h = 1e-4, f = (a, b, c) => SF.sceneSDF(sphere, a, b, c);
    return [f(x + h, y, z) - f(x - h, y, z),
            f(x, y + h, z) - f(x, y - h, z),
            f(x, y, z + h) - f(x, y, z - h)];
  };
  let against = 0, V = 0, stlWrong = 0;
  const normals = [];
  for (let t = 0; t < nt; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    normals.push([nx, ny, nz]);
    const g = grad((P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3,
                   (P[a + 2] + P[b + 2] + P[c + 2]) / 3);
    if (nx * g[0] + ny * g[1] + nz * g[2] <= 0) against++;
    V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
        - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
        + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  ok(nt > 500 && against === 0,
     `every one of ${nt.toLocaleString()} triangles is wound to face out of the solid`);
  ok(V > 0, `so the signed volume comes out positive: ${V.toFixed(0)} mm³ `
     + `(a r=${R} sphere holds ${(4 / 3 * Math.PI * R ** 3).toFixed(0)})`);

  // and the STL agrees with itself: the facet normal it writes is the one its
  // own three vertices imply, which is what the format asks for
  const bytes = new DataView(await SF.meshToSTL(mesh, 'winding check').arrayBuffer());
  for (let t = 0; t < nt; t++) {
    const o = 84 + t * 50;
    const fn = [bytes.getFloat32(o, true), bytes.getFloat32(o + 4, true),
                bytes.getFloat32(o + 8, true)];
    const m = normals[t], L = Math.hypot(m[0], m[1], m[2]) || 1;
    if (fn[0] * m[0] / L + fn[1] * m[1] / L + fn[2] * m[2] / L < 0.99) stlWrong++;
  }
  ok(stlWrong === 0, 'and the STL writes a facet normal that matches its own winding');
}

// `fields` is a getter/setter pair, not a value. The application replaces the
// whole array on load and on import; if the kernel handed out a copied
// reference the two would drift, and the symptom -- a baked shape rendering
// as the one you opened before -- is slow to trace back to here.
const desc = Object.getOwnPropertyDescriptor(SF, 'fields');
ok(desc && typeof desc.get === 'function' && typeof desc.set === 'function',
   'fields is exported as a live accessor, not a copied reference');
const probe = [{ name: 'probe' }];
SF.fields = probe;
ok(SF.fields === probe, 'and assigning to it is visible through the kernel');
SF.fields = [];

// ======================================================================
// The generated block is current
// ======================================================================
// The JS twins are derived from the GLSL, not written beside it. That only
// holds if the committed file is what the generator produces -- otherwise
// someone edits a twin by hand, it works, and the derivation is a fiction
// until the next regeneration silently reverts their fix.
//
// The same holds for the unrolled GLSL that glsl.js hands the shader: it is
// generated from the same rolled source as the JS twin, so a hand edit there
// would be a second definition of the shape.
//
// This runs the generator in --check mode, which rewrites nothing and exits
// non-zero if either file is stale.
{
  const r = spawnSync(process.execPath, [join(HERE, 'build-twins.mjs'), '--check'],
                      { encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  ok(r.status === 0, `the generated code is current`
    + (r.status === 0 ? ` — ${out}` : `\n        ${out}`));
}

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
