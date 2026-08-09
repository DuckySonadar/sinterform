/* Check that every primitive is the distance function it claims to be.
 *
 *     node check-primitives.mjs
 *
 * A primitive that returns the wrong sign, or the right sign and the wrong
 * magnitude, fails in two very different ways. The wrong sign is loud -- the
 * shape is inside out and you see it immediately. The wrong magnitude is
 * quiet: the picture looks right, and the raymarcher overshoots thin features
 * somewhere else in the scene, because `map()` is one fold and a bad step
 * estimate from any shape shortens the step for every ray.
 *
 * So each primitive is checked for the properties a sphere trace actually
 * depends on:
 *
 *   interior   the shape is not empty
 *   bounds     `ext` really does contain it -- a short box silently crops
 *              the STL, which is the slowest of all of these to notice
 *   lipschitz  |f(a) - f(b)| <= |a - b|, so a step of f never crosses the
 *              surface. This is the one the marcher rests on.
 *   eikonal    |grad f| == 1, i.e. it is a true distance and not merely a
 *              safe under-estimate. Primitives that only promise the bound
 *              are marked `exact: false` and are excused this one.
 *
 * Exit code is 0 or 1, so it can be a CI step.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const mod = { exports: {} };
new Function('module', readFileSync(join(HERE, 'sinterform.js'), 'utf8'))(mod);
const SF = mod.exports;

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};

// deterministic, so a failure is reproducible
let seed = 0x2f6e2b1;
const rnd = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed |= 0;
  return (seed >>> 0) / 4294967296;
};
const span = (h) => (rnd() * 2 - 1) * h;

const SKIP = new Set(['plane', 'field']);   // infinite; needs a baked grid
let worstEver = 0, worstWho = '';

for (const key of SF.PRIM_KEYS) {
  if (SKIP.has(key)) continue;
  const P = SF.PRIMS[key];
  const d = P.def.slice();
  const round = P.round ? 1.5 : 0;
  const f = (x, y, z) => P.js([x, y, z], d, round, { fi: 0 });
  const E = P.ext(d).map(v => v + round);
  const R = Math.max(E[0], E[1], E[2]);
  console.log(`\n${P.name}  dims ${JSON.stringify(d)}${round ? ` round ${round}` : ''}`);

  // ---- 1. it encloses something ----------------------------------------
  let lo = Infinity;
  for (let i = 0; i < 12000; i++)
    lo = Math.min(lo, f(span(E[0]), span(E[1]), span(E[2])));
  ok(lo < -0.2, `has an interior (deepest sample ${lo.toFixed(3)} mm)`);

  // ---- 2. ext() actually contains the solid ------------------------------
  // Sample a shell just outside the declared box; nothing solid may be there.
  let escaped = 0, worst = 0;
  for (let i = 0; i < 20000; i++) {
    const ax = Math.floor(rnd() * 3), sgn = rnd() < 0.5 ? -1 : 1;
    const p = [span(E[0] * 1.6), span(E[1] * 1.6), span(E[2] * 1.6)];
    p[ax] = sgn * (E[ax] + 0.05 + rnd() * R);          // outside on one axis
    const v = f(p[0], p[1], p[2]);
    if (v < 0) { escaped++; worst = Math.min(worst, v); }
  }
  ok(escaped === 0, `ext() [${E.map(v => v.toFixed(1))}] contains the solid`
    + (escaped ? ` — ${escaped} solid samples outside it, by ${(-worst).toFixed(2)} mm` : ''));

  // ---- 3. 1-Lipschitz: a step of f can never cross the surface -----------
  let lipBad = 0, lipWorst = 1;
  for (let i = 0; i < 40000; i++) {
    const a = [span(R * 2), span(R * 2), span(R * 2)];
    const b = [a[0] + span(R), a[1] + span(R), a[2] + span(R)];
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (dist < 1e-6) continue;
    const ratio = Math.abs(f(...b) - f(...a)) / dist;
    if (ratio > lipWorst) lipWorst = ratio;
    if (ratio > 1.002) lipBad++;
  }
  if (lipWorst > worstEver) { worstEver = lipWorst; worstWho = P.name; }
  if (P.exact === false)
    // A bound may exceed 1 -- that is what makes it a bound. It may not do so
    // by more than the marcher's step factor allows, which is the real limit.
    ok(lipWorst <= 1.35, `Lipschitz ${lipWorst.toFixed(4)} — a bound, within `
      + `the ${(1 / 1.35).toFixed(2)} step budget`);
  else
    ok(lipBad === 0, `1-Lipschitz (worst |df|/|dp| = ${lipWorst.toFixed(4)})`
      + (lipBad ? ` — ${lipBad} violations` : ''));

  // ---- 4. eikonal: it is a true distance, not just a safe bound ----------
  // The medial axis and the edges are genuinely non-differentiable, so a
  // small fraction of samples legitimately miss; the bar is the bulk.
  const h = 1e-3;
  let good = 0, tried = 0;
  for (let i = 0; i < 20000; i++) {
    const p = [span(R * 1.8), span(R * 1.8), span(R * 1.8)];
    const g = Math.hypot(
      f(p[0] + h, p[1], p[2]) - f(p[0] - h, p[1], p[2]),
      f(p[0], p[1] + h, p[2]) - f(p[0], p[1] - h, p[2]),
      f(p[0], p[1], p[2] + h) - f(p[0], p[1], p[2] - h)) / (2 * h);
    tried++;
    if (Math.abs(g - 1) < 0.02) good++;
  }
  const pct = 100 * good / tried;
  if (P.exact === false)
    ok(true, `exact: false — bound only, eikonal holds at ${pct.toFixed(1)}% (not required)`);
  else
    ok(pct > 96, `|grad f| = 1 at ${pct.toFixed(1)}% of samples`);
}

// The number a raymarcher needs: step by more than this fraction of the
// reported distance and the loosest primitive in the set can let a ray
// through a thin feature.
console.log(`\nloosest primitive: ${worstWho} at ${worstEver.toFixed(4)}`
  + `  →  max safe raymarch step ${(1 / worstEver).toFixed(3)}`);

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
