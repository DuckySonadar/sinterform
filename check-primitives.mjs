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

// `profile` reads its outline from the document rather than from its dims, so
// it needs one side-loaded before the loop reaches it. A cross with a square
// hole is the useful shape here: reentrant corners exercise the sign test and
// the medial axis, and the hole exercises the even-odd rule. Its extent is
// exactly the primitive's default dims, so `ext` is tight rather than
// generous -- a short box would show up in the bounds check.
SF.profiles = [{ name: 'test cross', loops: [
  [[-10, -4], [-4, -4], [-4, -10], [4, -10], [4, -4], [10, -4],
   [10, 4], [4, 4], [4, 10], [-4, 10], [-4, 4], [-10, 4]],
  [[-2.5, -2.5], [2.5, -2.5], [2.5, 2.5], [-2.5, 2.5]]
] }];

// `wire` reads its path from the document too. An L with a taper along it:
// the corner exercises the shared-endpoint sphere that fills a joint, and the
// varying radius exercises the round cone, which is the whole reason this
// primitive is not just a chain of capsules. Its extent matches the default
// dims so `ext` is tight.
const TEST_WIRE = [[[-14, 0, 0, 4], [0, 0, 0, 2.5], [0, 14, 0, 1]]];
SF.wires = [{ name: 'test L', lines: TEST_WIRE }];

// A primitive whose shape lives on the document has dims that are purely its
// bounds, so the side-loaded data decides them rather than `def`. Using `def`
// here would test the default shape's box against the test shape's geometry,
// which is a failure with nothing wrong behind it.
// `sweep` too, and its data has to come from sweep.js, which is the file that
// knows about transport and corners. A path through space with a rectangular
// section, tapered and twisted, so the frame, the taper divisor and the corner
// term are all in play rather than a straight tube.
const SW = (() => {
  const m = { exports: {} };
  new Function('module', readFileSync(join(HERE, 'sweep.js'), 'utf8'))(m);
  return m.exports;
})();
const SWPATH = [];
for (let i = 0; i <= 24; i++) {
  const t = i / 24 * Math.PI * 1.3;
  SWPATH.push([22 * Math.cos(t), 22 * Math.sin(t), 7 * Math.sin(2 * t)]);
}
const PACKED = SW.pack(SWPATH, { kind: 'rect', a: 8, b: 4, c: 1 },
                       { scale: (t) => 1 + 0.8 * t, twist: 1.1 });
SF.sweeps = [PACKED.sweep];

// `construct` reads its skeleton from the document too, and its data has to
// come from construct.js, which is the file that knows about connector trees.
// A rig turned well off-axis, with one mass of each kind on it and a child of a
// turned parent, so the quaternion composition, the cull and all four arms of
// the kind dispatch are in play -- and so that `ext` is tested against a *posed*
// box rather than an axis-aligned one, which is the case a rig can get wrong.
const CN = (() => {
  const m = { exports: {} };
  new Function('module', readFileSync(join(HERE, 'construct.js'), 'utf8'))(m);
  return m.exports;
})();
const RIG = CN.pack({ name: 'test rig', joints: [
  { name: 'root', offset: [0, 0, -10],
    mass: { kind: 'bone', len: 18, r0: 4, r1: 3, k: 0 } },
  { name: 'chest', parent: 'root', offset: [0, 0, 14], rot: [0, 12, 0],
    mass: { kind: 'ellipsoid', half: [7, 4.5, 6], offset: [0, 0, 1], k: 3 } },
  { name: 'head', parent: 'chest', offset: [0, 0, 9], rot: [8, 0, 20],
    mass: { kind: 'sphere', r: 4.5, k: 2 } },
  { name: 'armL', parent: 'chest', offset: [3, 0, 4], rot: [0, 62, 15],
    mass: { kind: 'bone', len: 13, r0: 2.4, r1: 1.5, k: 2.5 } },
  { name: 'handL', parent: 'armL', offset: [0, 0, 13], rot: [0, 25, 0],
    mass: { kind: 'box', half: [2.6, 1.2, 3.4], round: 0.9, k: 1.5 } },
  { name: 'armR', parent: 'chest', offset: [-3, 0, 4], rot: [0, -62, -15],
    mass: { kind: 'bone', len: 13, r0: 2.4, r1: 1.5, k: 2.5 } }
] });
SF.constructs = [RIG.construct];

const DIMS = { wire: SF.wireExtent(TEST_WIRE), sweep: PACKED.node.d,
               construct: RIG.node.d };

// The right triangle carries its hypotenuse and land in the round slot rather
// than a rounding, so `round ? 1.5 : 0` would only ever test the bare straight
// one. Each is a run of its own: straight, the ellipse, a parabola, and a
// hyperbola tight enough into the corner to crowd the polygon's points, then
// each kind again with a land, and a land so wide it leaves only a rectangle.
const TRI = (n) => SF.roundSlot(Object.assign({ t: 'tri' }, n));
const SLOTS = { tri: [
  TRI({}), TRI({ hyp: 'ellipse' }), TRI({ hyp: 'conic', rho: 0.5 }),
  TRI({ hyp: 'conic', rho: 0.85 }), TRI({ land: 3 }), TRI({ hyp: 'ellipse', land: 2.5 }),
  TRI({ hyp: 'conic', rho: 0.7, land: 4 }), TRI({ hyp: 'conic', rho: 0.5, land: 40 })
] };

let worstEver = 0, worstWho = '';

const RUNS = [];
for (const key of SF.PRIM_KEYS) {
  if (SKIP.has(key)) continue;
  const P = SF.PRIMS[key];
  for (const slot of SLOTS[key] || [P.round ? 1.5 : 0]) RUNS.push([key, slot]);
}

for (const [key, round] of RUNS) {
  const P = SF.PRIMS[key];
  const d = (DIMS[key] || P.def).slice();
  const f = (x, y, z) => P.js([x, y, z], d, round, { fi: 0 });
  const E = P.ext(d).map(v => v + (P.round ? round : 0));
  const R = Math.max(E[0], E[1], E[2]);
  console.log(`\n${P.name}  dims ${JSON.stringify(d)}`
    + (round ? ` ${P.round ? 'round' : 'slot'} ${+round.toFixed(4)}` : ''));

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

// ---- the triangle's curve is the conic it says it is ----------------------
// The four checks above would pass for any polygon at all. This one holds the
// outline to the curve: points on the true conic must read as surface, to
// within the chord sag pTri's comment promises, and the ellipse has to be the
// quarter ellipse centred on the box's far corner -- that is the whole claim
// behind offering it by name. Checked at the largest legs the dims allow,
// where the sag is worst.
{
  console.log('\nRight triangle  hypotenuse against the true curve');
  const P = SF.PRIMS.tri, X = 160, Y = 110, d = [X, Y, 10];
  // rho travels to the shader in thousandths (see triSlot), so these are
  // values it can carry exactly; the ellipse has its own exact code and is
  // checked by name below. A rho with more places is rounded, which at these
  // legs moves the shoulder by up to 0.05 mm.
  for (const rho of [0.414, 0.25, 0.5, 0.85]) {
    const w = rho / (1 - rho);
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      const t = i / 2000, u = 1 - t, den = u * u + 2 * w * t * u + t * t;
      const v = P.js([X * u * u / den - X / 2, Y * t * t / den - Y / 2, 0], d,
                     TRI({ hyp: 'conic', rho }), {});
      worst = Math.max(worst, Math.abs(v));
    }
    ok(worst < 0.06, `rho ${rho.toFixed(4)}: conic within ${worst.toFixed(4)} mm of the surface`);
  }
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const a = Math.PI * (1 + 0.5 * i / 2000);       // the quarter facing the corner
    const v = P.js([X / 2 + X * Math.cos(a), Y / 2 + Y * Math.sin(a), 0], d,
                   SF.roundSlot({ t: 'tri', hyp: 'ellipse' }), {});
    worst = Math.max(worst, Math.abs(v));
  }
  ok(worst < 0.06, `hyp 'ellipse' is the quarter ellipse to ${worst.toFixed(4)} mm`);
  const rh = (n) => SF.triRho(Object.assign({ t: 'tri' }, n));
  ok(rh({}) === 0 && rh({ hyp: 'line', rho: 0.7 }) === 0 && rh({ hyp: 'conic', rho: 0.7 }) === 0.7
     && rh({ hyp: 'conic', rho: 2 }) === SF.TRI_RHO_MAX && rh({ hyp: 'conic' }) === 0,
     'triRho: only a conic reads rho, and it is clamped');
}

// ---- the land: square tips, and the curve moved in to meet them ------------
// With a land w the tips must end in faces at right angles to the legs, w
// tall, and the conic must run between (X, w) and (w, Y). Checked as the
// claims they are: points on each end face read as surface, a hair inside a
// face is solid and a hair outside it is not, the corner where face meets
// curve is a right angle (the face's normal is along the leg all the way up),
// and points on the moved conic read as surface.
{
  console.log('\nRight triangle  the land');
  const P = SF.PRIMS.tri, X = 120, Y = 70, d = [X, Y, 10], land = 6.5;
  const at = (x, y, slot) => P.js([x - X / 2, y - Y / 2, 0], d, slot, {});
  for (const [name, n] of [['straight', {}], ['ellipse', { hyp: 'ellipse' }],
                           ['conic 0.8', { hyp: 'conic', rho: 0.8 }]]) {
    const slot = TRI(Object.assign({ land }, n));
    let face = 0, side = 0;
    for (let i = 0; i <= 200; i++) {
      const y = land * i / 200;
      face = Math.max(face, Math.abs(at(X, y, slot)), Math.abs(at(y, Y, slot)));
      if (i > 2 && i < 198) {
        // just inside the face is solid, just outside is not, on both tips
        if (!(at(X - 0.05, y, slot) < 0 && at(X + 0.05, y, slot) > 0)) side++;
        if (!(at(y, Y - 0.05, slot) < 0 && at(y, Y + 0.05, slot) > 0)) side++;
      }
    }
    ok(face < 1e-9 && side === 0, `${name}: both tips end in a square face ${land} mm tall`
       + (side ? ` — ${side} samples on the wrong side` : ''));
    // the face's own normal at the very top of it, where it meets the curve
    const h = 1e-4, y = land - 0.02;
    const gx = (at(X + h, y, slot) - at(X - h, y, slot)) / (2 * h);
    const gy = (at(X, y + h, slot) - at(X, y - h, slot)) / (2 * h);
    ok(Math.abs(gx - 1) < 1e-3 && Math.abs(gy) < 1e-3,
       `${name}: the face is square to the leg up to the curve (normal ${gx.toFixed(4)}, ${gy.toFixed(4)})`);
  }
  for (const rho of [0.414, 0.6]) {
    const w = rho / (1 - rho), cx = X - land, cy = Y - land;
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      const t = i / 2000, u = 1 - t, den = u * u + 2 * w * t * u + t * t;
      worst = Math.max(worst, Math.abs(at(land + cx * u * u / den, land + cy * t * t / den,
                                          TRI({ hyp: 'conic', rho, land }))));
    }
    ok(worst < 0.06, `rho ${rho.toFixed(4)} with land: the curve runs (X, w) to (w, Y), `
       + `within ${worst.toFixed(4)} mm`);
  }
  // the packing: what goes in comes out, and the ellipse stays exact
  ok(TRI({ land: 163.83, hyp: 'ellipse' }) < 2 ** 24 && TRI({ land: 1e9 }) === TRI({ land: 163.83 })
     && TRI({ land: 0.004 }) === 0 && TRI({ land: 12.34, hyp: 'conic', rho: 0.567 }) === 1234 * 1024 + 567,
     'triSlot: land to 0.01 mm and rho to 0.001, one exact integer, clamped');
  // a land as wide as the short leg leaves the rectangle it says
  const rect = TRI({ hyp: 'conic', rho: 0.5, land: Y });
  ok(Math.abs(at(X, Y * 0.99, rect)) < 1e-9 && at(X - 1, Y - 1, rect) < 0,
     'a land the width of the short leg leaves a full rectangle');
}

// The number a raymarcher needs: step by more than this fraction of the
// reported distance and the loosest primitive in the set can let a ray
// through a thin feature.
console.log(`\nloosest primitive: ${worstWho} at ${worstEver.toFixed(4)}`
  + `  →  max safe raymarch step ${(1 / worstEver).toFixed(3)}`);

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
