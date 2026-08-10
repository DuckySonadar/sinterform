/* Check the sweep.
 *
 *     node check-sweep.mjs
 *
 * Three things, and the third is the one worth writing down.
 *
 * That it is the right shape: a circle swept along a straight line is a
 * capsule, along a circle is a torus, along a line at rising scale is a cone.
 * All three have closed forms to compare against, so "looks about right" never
 * has to be the standard.
 *
 * That it is a usable distance: 1-Lipschitz at constant scale, and at variable
 * scale a bound whose looseness is measured rather than hoped at.
 *
 * That self-intersection is genuinely not a special case. The claim is that a
 * swept solid is the union of the profile over the path, union is min, and min
 * does not care how many times a point is covered. That is true -- of the
 * union. It is not true of the way sweeps are usually written, which attaches
 * the profile to the *nearest* path point, and the difference only shows up on
 * a path that crosses itself with a profile that is not round. So the naive
 * version is implemented here too, and pointed at the same geometry, so the
 * gap between them is a number rather than an argument.
 *
 * Exit code is 0 or 1, so it can be a CI step.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f) => { const m = { exports: {} };
  new Function('module', readFileSync(join(HERE, f), 'utf8'))(m); return m.exports; };
const SW = load('sweep.js');
const SF = load('sinterform.js');
const { Sketch } = load('sketch.js');
const M3 = load('sketch3d.js');
const { Sketch3D } = M3;
const P = SW.PROFILES;

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};
const near = (got, want, tol, what) =>
  ok(Math.abs(got - want) < tol, `${what}: ${got.toFixed(5)} ≈ ${want.toFixed(5)}`);

let seed = 0x5bf03635;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
                    seed |= 0; return (seed >>> 0) / 4294967296; };
const span = (h) => (rnd() * 2 - 1) * h;

const lipschitz = (f, R, N) => {
  let worst = 0;
  for (let i = 0; i < (N || 40000); i++) {
    const a = [span(R), span(R), span(R)];
    const b = [a[0] + span(R / 3), a[1] + span(R / 3), a[2] + span(R / 3)];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d < 1e-9) continue;
    worst = Math.max(worst, Math.abs(f(...b) - f(...a)) / d);
  }
  return worst;
};

// ======================================================================
console.log('\n--- shapes with closed forms to check against ---');
{
  // A circle along a straight line is a *cylinder*: a sweep caps its ends
  // with the profile, flat, which is what a sweep means. Rounded ends would
  // be a capsule and a different operation.
  const r = 6, L = 60;
  const f = SW.along([[-L / 2, 0], [L / 2, 0]], P.circle(r));
  const cyl = (x, y, z) => SF.PRIMS.cylinder.js([y, z, x], [r, L, 0], 0);
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const p = [span(60), span(30), span(30)];
    worst = Math.max(worst, Math.abs(f(...p) - cyl(...p)));
  }
  ok(worst < 1e-9, `a circle along a line is a cylinder, flat-capped `
    + `(worst ${worst.toExponential(1)} mm)`);
  ok(f.exact, 'and it says it is exact');
  near(lipschitz(f, 50), 1, 0.003, 'and 1-Lipschitz');
}
{
  // a circle along a circle is a torus, and the kernel has an exact one
  const R = 20, r = 5, N = 720;
  const path = [];
  for (let i = 0; i < N; i++)
    path.push([R * Math.cos(2 * Math.PI * i / N), R * Math.sin(2 * Math.PI * i / N)]);
  const f = SW.along(path, P.circle(r), { closed: true });
  const torus = (x, y, z) => SF.PRIMS.torus.js([x, y, z], [R, r, 0], 0);
  // the path is a polygon, so the sweep sits inside the true torus by the
  // sagitta -- which is the only difference there should be
  const sag = R * (1 - Math.cos(Math.PI / N));
  let worst = 0, wp = null;
  for (let i = 0; i < 20000; i++) {
    const p = [span(34), span(34), span(14)];
    const e = Math.abs(f(...p) - torus(...p));
    if (e > worst) { worst = e; wp = p; }
  }
  ok(worst < sag * 1.6, `a circle along a circle is a torus `
    + `(worst ${worst.toExponential(2)} mm, polygon sagitta ${sag.toExponential(2)})`);
  void wp;
  near(lipschitz(f, 30), 1, 0.003, 'and that is 1-Lipschitz too');
}
{
  // rising scale along a line is a cone; the exact one is in the kernel
  const r0 = 3, r1 = 15, L = 50;
  const f = SW.along([[-L / 2, 0], [L / 2, 0]], P.circle(1),
                     { scale: (t) => r0 + (r1 - r0) * t });
  // SinterForm's cone runs along +Z, so compare in its frame
  const cone = (x, y, z) => SF.PRIMS.cone.js([y, z, x], [r0, r1, L], 0);
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const p = [span(40), span(24), span(24)];
    worst = Math.max(worst, Math.abs(f(...p) - cone(...p)));
  }
  // The taper correction makes this a bound, not an equality -- so what is
  // being checked is that it is *close* and on the safe side, not that it
  // matches.
  ok(worst < 1.2, `rising scale along a line is a cone (worst gap ${worst.toFixed(3)} mm)`);
  ok(!f.exact, 'and it does not claim to be exact');
  // Which direction is safe depends on which side you are. Outside, a
  // marcher steps by the reported distance, so reporting *more* than the
  // truth lets it step through the surface -- that is the one that must
  // never happen. Inside, reporting less depth than the truth is merely
  // conservative, and the taper correction does exactly that.
  let unsafe = 0, shallow = 0, worstShallow = 0;
  for (let i = 0; i < 40000; i++) {
    const p = [span(40), span(24), span(24)];
    const a = f(...p), b = cone(...p);
    if (b > 0 && a > b + 1e-6) unsafe++;
    if (b < 0 && a > b) { shallow++; worstShallow = Math.max(worstShallow, a - b); }
  }
  ok(unsafe === 0, 'outside, it never reports further than the truth — a marcher cannot step through it');
  ok(worstShallow < 0.5, `inside, the taper correction under-reports depth by at most `
    + `${worstShallow.toFixed(3)} mm, which is the conservative direction`);
  const L2 = lipschitz(f, 34);
  ok(L2 <= 1.002, `the tapered field is still 1-Lipschitz (${L2.toFixed(4)})`);
}

// ======================================================================
console.log('\n--- self-intersection is not a special case ---');

// The way sweeps are usually written: find the nearest point on the path,
// build a frame there, evaluate the profile in it. One lookup, no loop.
function naive(path, profile, closed) {
  const n = path.length, last = closed ? n : n - 1;
  return (x, y, z) => {
    let bd = Infinity, bu = 0;
    for (let i = 0; i < last; i++) {
      const a = path[i], b = path[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy;
      let t = ((x - a[0]) * dx + (y - a[1]) * dy) / (L2 || 1e-30);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a[0] + dx * t, qy = a[1] + dy * t;
      const d = Math.hypot(x - qx, y - qy);
      if (d < bd) { bd = d; bu = (-(x - qx) * dy + (y - qy) * dx) / Math.sqrt(L2 || 1); }
    }
    return profile(bu, z);
  };
}

{
  // a path that crosses itself, and a profile that is not round -- which is
  // what it takes for the two formulations to part company
  const path = [[-50, 0], [50, 0], [50, 26], [0, 26], [0, -50]];
  // A profile that reaches out to one side only -- a flange, a lip, a bead
  // laid against something. This is what it takes for the two formulations
  // to part company: with a symmetric profile the nearest pass covers
  // whatever any pass covers, so they agree by accident. Make the profile
  // one-sided and the pass that covers you may not be the nearest one.
  const flange = Object.assign((u, v) => {
    const qu = Math.abs(u - 11) - 11, qv = Math.abs(v) - 2.5;
    return Math.hypot(Math.max(qu, 0), Math.max(qv, 0)) + Math.min(Math.max(qu, qv), 0);
  }, { radius: 23 });
  const f = SW.along(path, flange);
  const g = naive(path, flange, false);

  // every point of the path has to be inside its own sweep. This is the
  // property a fold or a bite would break, and it is cheap to check densely.
  let outside = 0, worstOn = 0;
  for (let i = 0; i < path.length - 1; i++)
    for (let s = 0; s <= 1; s += 0.002) {
      const x = path[i][0] + (path[i + 1][0] - path[i][0]) * s;
      const y = path[i][1] + (path[i + 1][1] - path[i][1]) * s;
      const d = f(x, y, 0);
      // the two ends of an open path sit on their own flat caps, where 0 is
      // the right answer, so the bar is "not outside" rather than "inside"
      if (d > 1e-9) outside++;
      worstOn = Math.max(worstOn, d);
    }
  ok(outside === 0, `every point along a self-crossing path is inside the sweep `
    + `(worst ${worstOn.toFixed(3)} mm)`);

  // and the union stays a usable distance across the crossing
  const Lz = lipschitz(f, 60);
  ok(Lz <= 1.002, `the union is 1-Lipschitz through the crossing (${Lz.toFixed(4)})`);

  // now the difference. Where the two disagree, the union is the one that
  // says "inside" -- the naive version misses material because it consults
  // only the nearest pass, and near a crossing that is the wrong pass.
  let unionOnly = 0, naiveOnly = 0, worstGap = 0;
  for (let i = 0; i < 200000; i++) {
    const p = [span(70), span(70), span(6)];
    const a = f(...p), b = g(...p);
    if (a < 0 && b >= 0) unionOnly++;
    if (b < 0 && a >= 0) naiveOnly++;
    worstGap = Math.max(worstGap, Math.abs(a - b));
  }
  ok(unionOnly > 0, `the naive nearest-point sweep loses material the union keeps `
    + `(${unionOnly} of 200,000 samples)`);
  // It gains some too, for a second and separate reason: consulting only the
  // nearest point leaves it with no end caps, so it runs on past the ends.
  ok(naiveOnly > 0, `and gains material past the ends it has no way to cap `
    + `(${naiveOnly})`);
  console.log(`  ..    worst disagreement ${worstGap.toFixed(2)} mm`);

  // the naive one is not even a distance function here, which is the other
  // half of the price
  const Ln = lipschitz(g, 60);
  ok(Ln > 1.05, `and it is not 1-Lipschitz (${Ln.toFixed(3)}), so a marcher can overshoot it`);
}
{
  // doubling back along the same line must give the same solid as going once
  const once = SW.along([[-30, 0], [30, 0]], P.rect(12, 6));
  const back = SW.along([[-30, 0], [30, 0], [-30, 0]], P.rect(12, 6));
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const p = [span(45), span(20), span(20)];
    worst = Math.max(worst, Math.abs(once(...p) - back(...p)));
  }
  ok(worst < 1e-9, `retracing a path changes nothing (worst ${worst.toExponential(1)} mm)`);
}

// ======================================================================
console.log('\n--- sharp corners: round and miter ---');
{
  const R = 6;
  const corner = (turn, join) => {
    const th = turn * Math.PI / 180;
    return SW.along([[-40, 0], [0, 0], [40 * Math.cos(th), 40 * Math.sin(th)]],
                    P.circle(R), { join });
  };
  // how far material reaches along the outward bisector of the corner
  const reach = (f, turn) => {
    const bis = turn * Math.PI / 360 - Math.PI / 2;
    let d = 0;
    for (let t = 0.01; t < R * 10; t += 0.01) {
      if (f(t * Math.cos(bis), t * Math.sin(bis), 0) < 0) d = t; else break;
    }
    return d;
  };
  let notch = 0;
  for (const turn of [15, 45, 90, 120, 150, 170]) {
    // A round join is the profile revolved about the vertex, so it reaches
    // exactly the profile's radius whatever the corner does.
    if (Math.abs(reach(corner(turn, 'round'), turn) - R) > 0.02) notch++;
  }
  ok(notch === 0, 'a round join reaches exactly the profile radius at every corner');
  // This is the one that was wrong: treating anything sharper than a right
  // angle as an end of the path left both segments capped flat and nothing
  // filling the wedge between them.
  ok(reach(corner(120, 'round'), 120) > R - 0.02
     && reach(corner(150, 'round'), 150) > R - 0.02,
     'and does not notch at corners sharper than a right angle');

  let off = 0;
  for (const turn of [15, 45, 90, 120]) {
    const want = R / Math.cos(turn * Math.PI / 360);   // where the outer edges meet
    if (Math.abs(reach(corner(turn, 'miter'), turn) - want) > 0.03) off++;
  }
  ok(off === 0, 'a miter join runs on to exactly where the outer edges meet, R/cos(turn/2)');

  // A miter runs away as the corner closes, so it has to be limited.
  const acute = 176;
  const unlimited = R / Math.cos(acute * Math.PI / 360);
  const th = acute * Math.PI / 180;
  const lim = SW.along([[-40, 0], [0, 0], [40 * Math.cos(th), 40 * Math.sin(th)]],
                       P.circle(R), { join: 'miter', miterLimit: 3 });
  const got = reach(lim, acute);
  ok(got < 3 * R + 0.5 && got > R,
     `and is limited: ${got.toFixed(1)} mm rather than the ${unlimited.toFixed(0)} mm `
     + `an unlimited miter wants (limit 3 radii, bevelled past it)`);

  // A straight joint has no corner to treat, so the two agree exactly.
  const straight = (join) => SW.along([[-30, 0], [0, 0], [30, 0]], P.circle(R), { join });
  let worst = 0;
  const a = straight('round'), b = straight('miter');
  for (let i = 0; i < 20000; i++) {
    const p = [span(45), span(20), span(20)];
    worst = Math.max(worst, Math.abs(a(...p) - b(...p)));
  }
  ok(worst < 1e-9, `on a straight joint the two joins are identical `
    + `(${worst.toExponential(1)} mm) — a miter costs nothing on a sampled curve`);
}
{
  // both joins have to survive being meshed
  const sq = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
  for (const join of ['round', 'miter']) {
    const f = SW.along(sq, P.rect(7, 9, 1), { closed: true, join });
    const res = 0.5, pad = 2 * res, B = f.bounds;
    const lo = B.lo.map(v => v - pad);
    const n = [0, 1, 2].map(i => Math.ceil((B.hi[i] - B.lo[i] + 2 * pad) / res) + 1);
    const vol = new Float32Array(n[0] * n[1] * n[2]);
    let k = 0;
    for (let i = 0; i < n[0]; i++)
      for (let j = 0; j < n[1]; j++)
        for (let m = 0; m < n[2]; m++)
          vol[k++] = f(lo[0] + i * res, lo[1] + j * res, lo[2] + m * res);
    const mesh = SF.surfaceNets(vol, n[0], n[1], n[2], lo[0], lo[1], lo[2], res);
    const nt = mesh.indices.length / 3;
    const edges = new Map();
    for (let t = 0; t < nt; t++) {
      const A = mesh.indices[3 * t], B2 = mesh.indices[3 * t + 1], C = mesh.indices[3 * t + 2];
      for (const [u, v] of [[A, B2], [B2, C], [C, A]]) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of edges.values()) if (v !== 2) bad++;
    ok(nt > 500 && bad === 0, `a ${join}-joined square frame meshes watertight `
      + `(${nt.toLocaleString()} triangles)`);
  }
}

// ======================================================================
console.log('\n--- open and closed paths, and sketches ---');
{
  const S = new Sketch();
  const c = S.point(0, 0, { fixed: true });
  const ring = S.arc(c, 22, 22, 0, 0, 2 * Math.PI);
  S.fix(ring);
  const f = SW.fromSketch(S, { entity: ring }, P.circle(4), { tol: 0.01 });
  ok(f.segments > 100, `a sketch arc sweeps (${f.segments} segments, ${f.arcLength.toFixed(1)} mm long)`);
  near(f(22, 0, 0), -4, 0.02, 'on the ring centreline it is one tube radius deep');
  near(f(0, 0, 0), 22 - 4, 0.02, 'and the hole in the middle is open');
  ok(f(30, 0, 0) > 0, 'outside is outside');
}
{
  // an open path has flat ends, not infinite ones
  const f = SW.along([[0, 0], [40, 0]], P.circle(5));
  ok(f(-8, 0, 0) > 0, 'an open sweep stops at its start');
  ok(f(48, 0, 0) > 0, 'and at its end');
  near(f(-1, 0, 0), 1, 1e-9, 'with a flat cap: 1 mm before it is 1 mm outside');
  near(f(1, 0, 0), -1, 1e-9, 'and 1 mm after it is 1 mm inside');
}
{
  // closed makes the last point join the first
  const sq = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
  const open = SW.along(sq, P.circle(3), { closed: false });
  const shut = SW.along(sq, P.circle(3), { closed: true });
  ok(open(-20, 0, 0) > 0 && shut(-20, 0, 0) < 0,
     'the closing segment is there only when asked for');
}
{
  // scale as an array, one factor per point
  const f = SW.along([[0, 0], [30, 0], [60, 0]], P.circle(1), { scale: [2, 6, 2] });
  near(f(0, 0, 0), 0, 1e-9, 'the start sits on its own flat cap');
  near(f(2, 0, 0), -2, 0.02, 'per-point scale takes just inside it');
  // the taper correction makes depth a bound, so this is close, not equal
  near(f(30, 0, 0), -6, 0.06, 'swells in the middle');
  near(f(58, 0, 0), -2, 0.02, 'and comes back');
}
{
  const f = SW.along([[0, 0], [50, 0]], P.circle(4), { scale: 2.5 });
  near(f(25, 0, 0), -10, 1e-9, 'a constant scale multiplies the profile');
  ok(f.exact, 'and stays exact');
}

// ======================================================================
console.log('\n--- bounds ---');
{
  const cases = [
    ['line', SW.along([[-20, -5], [30, 12]], P.circle(6))],
    ['ring', SW.along(Array.from({ length: 90 }, (_, i) =>
      [18 * Math.cos(i / 90 * 2 * Math.PI), 18 * Math.sin(i / 90 * 2 * Math.PI)]),
      P.rect(9, 7), { closed: true })],
    ['tapered', SW.along([[0, 0], [40, 0]], P.circle(2), { scale: (t) => 1 + 4 * t })]
  ];
  for (const [name, f] of cases) {
    const B = f.bounds;
    let escaped = 0;
    for (let i = 0; i < 60000; i++) {
      const ax = Math.floor(rnd() * 3), sgn = rnd() < 0.5 ? -1 : 1;
      const p = [B.lo[0] + rnd() * (B.hi[0] - B.lo[0]) * 1.6 - 0.3 * (B.hi[0] - B.lo[0]),
                 B.lo[1] + rnd() * (B.hi[1] - B.lo[1]) * 1.6 - 0.3 * (B.hi[1] - B.lo[1]),
                 B.lo[2] + rnd() * (B.hi[2] - B.lo[2]) * 1.6 - 0.3 * (B.hi[2] - B.lo[2])];
      p[ax] = sgn > 0 ? B.hi[ax] + 0.05 + rnd() * 10 : B.lo[ax] - 0.05 - rnd() * 10;
      if (f(...p) < 0) escaped++;
    }
    ok(escaped === 0, `${name}: bounds contain the solid`
      + (escaped ? ` — ${escaped} escaped` : ''));
  }
}

// ======================================================================
console.log('\n--- and it meshes ---');
{
  const R = 24, r = 6, N = 240;
  const path = Array.from({ length: N }, (_, i) =>
    [R * Math.cos(2 * Math.PI * i / N), R * Math.sin(2 * Math.PI * i / N)]);
  const f = SW.along(path, P.circle(r), { closed: true, z: 0 });
  const res = 0.6, pad = 2 * res, B = f.bounds;
  const lo = B.lo.map(v => v - pad);
  const n = [0, 1, 2].map(i => Math.ceil((B.hi[i] - B.lo[i] + 2 * pad) / res) + 1);
  const vol = new Float32Array(n[0] * n[1] * n[2]);
  let k = 0;
  for (let i = 0; i < n[0]; i++)
    for (let j = 0; j < n[1]; j++)
      for (let m = 0; m < n[2]; m++)
        vol[k++] = f(lo[0] + i * res, lo[1] + j * res, lo[2] + m * res);
  const mesh = SF.surfaceNets(vol, n[0], n[1], n[2], lo[0], lo[1], lo[2], res);
  const nt = mesh.indices.length / 3;
  const edges = new Map();
  for (let t = 0; t < nt; t++) {
    const a = mesh.indices[3 * t], b = mesh.indices[3 * t + 1], c = mesh.indices[3 * t + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let bad = 0;
  for (const v of edges.values()) if (v !== 2) bad++;
  ok(nt > 1000 && bad === 0, `a swept torus meshes watertight (${nt.toLocaleString()} triangles)`);
  const Pos = mesh.positions;
  let V = 0;
  for (let t = 0; t < nt; t++) {
    const a = 3 * mesh.indices[3 * t], b = 3 * mesh.indices[3 * t + 1], c = 3 * mesh.indices[3 * t + 2];
    V += (Pos[a] * (Pos[b + 1] * Pos[c + 2] - Pos[b + 2] * Pos[c + 1])
        - Pos[a + 1] * (Pos[b] * Pos[c + 2] - Pos[b + 2] * Pos[c])
        + Pos[a + 2] * (Pos[b] * Pos[c + 1] - Pos[b + 1] * Pos[c])) / 6;
  }
  const want = 2 * Math.PI * Math.PI * R * r * r;
  ok(Math.abs(Math.abs(V) - want) / want < 0.02,
     `volume ${Math.abs(V).toFixed(0)} mm³ vs 2π²Rr² = ${want.toFixed(0)} `
     + `(${(100 * (Math.abs(V) - want) / want).toFixed(2)}%)`);
}

// ======================================================================
console.log('\n--- a path through space ---');
// The path stops being flat, and the only thing that really changes is that
// the profile's orientation is no longer decided for it. Everything below is
// about that: that the shapes with closed forms still come out, that the
// frame is carried rather than computed, and that a flat path is untouched.
const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
                    a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2])
};
const unit3 = (a) => { const l = v3.len(a); return [a[0] / l, a[1] / l, a[2] / l]; };

{
  // a circle along a line that goes nowhere near an axis is still a cylinder
  const a = [-20, -8, 3], b = [26, 14, 31], r = 5;
  const f = SW.along([a, b], P.circle(r));
  const d = v3.sub(b, a), L = v3.len(d), T = unit3(d);
  let worst = 0;
  for (let i = 0; i < 6000; i++) {
    const p = [span(45), span(45), span(45)];
    const w = v3.sub(p, a);
    const proj = v3.dot(w, T);
    const perp = v3.len(v3.sub(w, [T[0] * proj, T[1] * proj, T[2] * proj]));
    const qa = perp - r, qb = Math.abs(proj - L / 2) - L / 2;
    const exact = Math.min(Math.max(qa, qb), 0)
                + Math.hypot(Math.max(qa, 0), Math.max(qb, 0));
    worst = Math.max(worst, Math.abs(f(...p) - exact));
  }
  ok(worst < 1e-9, `a circle along a slanted line is a capped cylinder about it `
     + `(worst ${worst.toExponential(1)} mm)`);
  ok(f.exact, 'and it says it is exact');
}
{
  // and a circle along a circle in a tilted plane is a torus in that plane
  const rot = [0.5, -0.35, 0.8], Rr = 26, r = 5, N = 400;
  const [u, v, nrm] = M3.frameOf(rot[0], rot[1], rot[2]);
  const path = [];
  for (let i = 0; i < N; i++) {
    const th = i / N * 2 * Math.PI, c = Rr * Math.cos(th), s = Rr * Math.sin(th);
    path.push([c * u[0] + s * v[0], c * u[1] + s * v[1], c * u[2] + s * v[2]]);
  }
  const f = SW.along(path, P.circle(r), { closed: true });
  const sag = Rr * (1 - Math.cos(Math.PI / N));
  let worst = 0;
  for (let i = 0; i < 6000; i++) {
    const p = [span(45), span(45), span(45)];
    const h = v3.dot(p, nrm);
    const inPlane = Math.hypot(v3.dot(p, u), v3.dot(p, v));
    worst = Math.max(worst, Math.abs(f(...p) - (Math.hypot(inPlane - Rr, h) - r)));
  }
  ok(worst < sag * 1.6, `a circle along a tilted circle is a torus in that plane `
     + `(worst ${worst.toFixed(4)} mm, sagitta ${sag.toFixed(4)})`);
  near(f.holonomy, 0, 1e-12, 'and a flat loop brings its frame back unturned');
}
{
  // The compatibility that matters: a flat path is what it always was. Same
  // points with a z on them, same answers — not nearly, exactly.
  const flat = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40 * 4;
    flat.push([12 * t - 20, 9 * Math.sin(t) + 0.4 * t * t]);
  }
  const lifted = flat.map(p => [p[0], p[1], 7]);
  const A = SW.along(flat, P.rect(9, 4, 1), { z: 7, scale: (t) => 1 + t });
  const B = SW.along(lifted, P.rect(9, 4, 1), { scale: (t) => 1 + t });
  let worst = 0, worstFrame = 0;
  for (let i = 0; i < 8000; i++) {
    const p = [span(50), span(40), span(30)];
    worst = Math.max(worst, Math.abs(A(...p) - B(...p)));
  }
  for (const fr of A.frames) worstFrame = Math.max(worstFrame, v3.len(v3.sub(fr.v, [0, 0, 1])));
  ok(worst === 0, 'a two-coordinate path and the same path with a z are the same sweep');
  ok(worstFrame < 1e-15, `and its frame keeps v on +Z the whole way `
     + `(${worstFrame.toExponential(1)}), which is the frame this had before`);
}
{
  // Why the frame is carried and not computed. The textbook answer is the
  // Frenet normal, and it turns over at an inflection: the curvature changes
  // sign and the normal follows it. Sweep anything that is not round with
  // that and the section flips halfway along.
  const tilt = 0.7, N = 160;
  const path = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N * 4 * Math.PI - 2 * Math.PI;
    const x = t * 5, y = 14 * Math.sin(t);
    path.push([x, y * Math.cos(tilt), y * Math.sin(tilt)]);   // an S-bend, tilted
  }
  const f = SW.along(path, P.rect(10, 3));
  // the Frenet normal, discretely: which way the tangent is turning
  let frenetFlips = 0, framesFlips = 0, worstStep = 0;
  const T = f.frames.map(fr => fr.t);
  let prevN = null;
  for (let i = 1; i < T.length; i++) {
    const dT = v3.sub(T[i], T[i - 1]);
    if (v3.len(dT) < 1e-9) continue;
    const n = unit3(dT);
    if (prevN && v3.dot(n, prevN) < 0) frenetFlips++;
    prevN = n;
  }
  // The frame may never turn further than the tangent made it: that is the
  // whole content of "rotation-minimising", and it is what a Frenet frame
  // breaks at an inflection, where the normal spins through 180° while the
  // tangent barely moves.
  let excess = 0;
  for (let i = 1; i < f.frames.length; i++) {
    const d = v3.dot(f.frames[i].u, f.frames[i - 1].u);
    if (d < 0) framesFlips++;
    const turned = Math.acos(Math.min(1, Math.max(-1, d)));
    const tangentTurned = Math.acos(Math.min(1, Math.max(-1, v3.dot(T[i], T[i - 1]))));
    worstStep = Math.max(worstStep, turned);
    excess = Math.max(excess, turned - tangentTurned);
  }
  ok(frenetFlips >= 2, `the Frenet normal turns over ${frenetFlips} times on an S-bend`);
  ok(framesFlips === 0, 'and the carried frame turns over none');
  ok(excess < 1e-9, `the frame never turns further than the tangent made it `
     + `(worst excess ${excess.toExponential(1)} rad over ${(worstStep * 180 / Math.PI).toFixed(1)}° joints)`);
  // the frame is a frame: orthonormal, right-handed, square to the path
  let bad = 0;
  for (const fr of f.frames) {
    const e = Math.max(Math.abs(v3.dot(fr.u, fr.v)), Math.abs(v3.dot(fr.u, fr.t)),
                       Math.abs(v3.dot(fr.v, fr.t)), Math.abs(v3.len(fr.u) - 1),
                       Math.abs(v3.len(fr.v) - 1),
                       v3.len(v3.sub(v3.cross(fr.u, fr.v), fr.t)));
    if (e > 1e-12) bad++;
  }
  ok(bad === 0, 'every frame is orthonormal, right-handed and square to the tangent');
}
{
  // A corner, checked against what a corner means.
  //
  // A round join is the section swept through the turn, so the honest way to
  // check one is to turn the same corner in a few hundred tiny steps and let
  // the union do it -- no join code involved at all. The two have to agree.
  //
  // In the plane they always did. In space the join has to revolve the section
  // about the axis the path actually turns about, and a circular profile
  // cannot tell you whether it does: a circle revolves into the same solid
  // whichever way you spin it. It takes a section with a long way and a short
  // way round to show it.
  // The fillet has to be *tangent* to both legs, or it is not a rounded corner
  // at all -- it is two more corners with an arc between them, and comparing
  // against that measures nothing. Getting this wrong made the join look far
  // worse than it was.
  const corner = (dirB, rho, steps) => {
    const L = 40, dA = [1, 0, 0], dB = unit3(dirB);
    const A = [-L, 0, 0], B = dB.map(c => c * L);
    if (!steps) return [A, [0, 0, 0], B];
    const tau = Math.acos(Math.max(-1, Math.min(1, v3.dot(dA, dB))));
    const P1 = dA.map(c => -c * rho * Math.tan(tau / 2));
    const bis = unit3(v3.sub(dB, dA));                       // into the turn
    const C = bis.map(c => c * rho / Math.cos(tau / 2));
    const k = unit3(v3.cross(dA, dB)), r1 = v3.sub(P1, C);
    const path = [A];
    for (let i = 0; i <= steps; i++) {
      const th = tau * i / steps, c = Math.cos(th), s = Math.sin(th);
      const kr = v3.cross(k, r1), kd = v3.dot(k, r1) * (1 - c);
      path.push([C[0] + r1[0] * c + kr[0] * s + k[0] * kd,
                 C[1] + r1[1] * c + kr[1] * s + k[1] * kd,
                 C[2] + r1[2] * c + kr[2] * s + k[2] * kd]);
    }
    path.push(B);
    return path;
  };
  // its own stream, so that adding this did not move every sample every other
  // block below draws
  let cs = 0x1d3f0a7b;
  const cspan = (h) => {
    cs ^= cs << 13; cs ^= cs >>> 17; cs ^= cs << 5; cs |= 0;
    return ((cs >>> 0) / 4294967296 * 2 - 1) * h;
  };
  const compare = (dirB, prof) => {
    const sharp = SW.along(corner(dirB), prof);
    const swept = SW.along(corner(dirB, 0.02, 160), prof);
    let worst = 0, lost = 0, invented = 0, over = 0;
    for (let i = 0; i < 40000; i++) {
      const p = [cspan(22), cspan(22), cspan(22)];
      const a = sharp(...p), b = swept(...p);
      worst = Math.max(worst, Math.abs(a - b));
      if (a > 0.05 && b < 0) lost++;
      if (a < 0 && b > 0.05) invented++;
      if (b > 0 && a > b + 1e-6) over = Math.max(over, a - b);
    }
    return { worst, lost, invented, over };
  };
  const turns = { 'in the XY plane': [0, 1, 0], 'up out of it': [0, 0, 1],
                  'up and across': [0, 0.6, 0.8] };
  for (const [name, dir] of Object.entries(turns)) {
    const c = compare(dir, P.circle(5));
    ok(c.worst < 0.05 && !c.lost && !c.invented,
       `a circle round a corner ${name} matches the filleted path `
       + `(worst ${c.worst.toFixed(3)} mm)`);
  }
  for (const [name, dir] of Object.entries(turns)) {
    // The two directions are not the same thing. Losing or inventing material
    // is the join being wrong about where the solid is. Reporting a shade less
    // distance than the truth is the conservative direction and costs a
    // marcher a step; reporting *more* is the one that lets it step through
    // the surface, and that is held tight.
    const r = compare(dir, P.rect(12, 5));
    ok(!r.lost && !r.invented && r.worst < 0.3,
       `and so does a 12×5 section, turning ${name} — no material lost or `
       + `invented, worst gap ${r.worst.toFixed(3)} mm`);
    ok(r.over < 0.05,
       `  and outside it never reports more than ${r.over.toFixed(3)} mm past the truth`);
  }
  // How far material reaches along the corner's outward bisector, which is the
  // same measurement the plane's corners are held to above -- now with the
  // bisector pointing wherever the turn leaves it.
  const R6 = 5;
  const reachAlong = (f, dirB) => {
    const b = unit3(v3.sub([1, 0, 0], dirB));
    let d = 0;
    for (let t = 0.01; t < R6 * 10; t += 0.01) {
      if (f(b[0] * t, b[1] * t, b[2] * t) < 0) d = t; else break;
    }
    return d;
  };
  let notch = 0, off = 0;
  for (const dir of Object.values(turns)) {
    const turn = Math.acos(Math.min(1, v3.dot([1, 0, 0], unit3(dir))));
    if (Math.abs(reachAlong(SW.along(corner(dir), P.circle(R6)), dir) - R6) > 0.02) notch++;
    // a miter needs no axis -- it runs each segment on and caps it flat -- so
    // it never had this to get wrong. Asserted rather than assumed.
    const want = R6 / Math.cos(turn / 2);
    if (Math.abs(reachAlong(SW.along(corner(dir), P.circle(R6), { join: 'miter' }), dir)
                 - want) > 0.03) off++;
  }
  ok(notch === 0, 'a round join reaches exactly the profile radius whichever way the '
     + 'corner turns, in the plane or out of it');
  ok(off === 0, 'and a miter still runs on to R/cos(turn/2) along the bisector');
}
{
  // A closed path in space need not bring its frame back. That is the sphere's
  // doing, not the code's: the frame comes back turned by the area the tangent
  // traced out, so a mirror-symmetric loop traces half a sphere and comes back
  // unturned, and one without that symmetry does not.
  const ring = (fn, n) => { const p = []; for (let i = 0; i < n; i++) p.push(fn(i / n * 2 * Math.PI)); return p; };
  const flat = ring((t) => [30 * Math.cos(t), 30 * Math.sin(t), 0], 240);
  const mirrored = ring((t) => [30 * Math.cos(t), 30 * Math.sin(t), 10 * Math.sin(2 * t)], 240);
  const asym = ring((t) => [30 * Math.cos(t) + 4 * Math.sin(2 * t),
                            26 * Math.sin(t) + 5 * Math.cos(3 * t + 1.1),
                            11 * Math.sin(t + 0.4) + 6 * Math.sin(2 * t + 2.2)], 240);
  near(SW.along(flat, P.rect(8, 3), { closed: true }).holonomy, 0, 1e-12,
       'a flat closed loop has no holonomy');
  near(SW.along(mirrored, P.rect(8, 3), { closed: true }).holonomy, 0, 1e-9,
       'nor does a saddle with a mirror plane');
  const spread = SW.along(asym, P.rect(10, 4), { closed: true });
  const seamed = SW.along(asym, P.rect(10, 4), { closed: true, closeFrame: false });
  ok(Math.abs(spread.holonomy) > 0.01,
     `a loop without that symmetry comes back turned by `
     + `${(spread.holonomy * 180 / Math.PI).toFixed(2)}°`);
  ok(spread.holonomy === seamed.holonomy, 'measured the same either way — it is the path’s, not a setting');

  // Carry the frame across the closing joint by hand and see what is left.
  const across = (f) => {
    const a = f.frames[f.frames.length - 1], b = f.frames[0];
    const ax = v3.cross(a.t, b.t), s = v3.len(ax), c = v3.dot(a.t, b.t);
    let u = a.u;
    if (s > 1e-12) {
      const k = [ax[0] / s, ax[1] / s, ax[2] / s], th = Math.atan2(s, c);
      const kv = v3.cross(k, u), d = v3.dot(k, u) * (1 - Math.cos(th));
      u = [u[0] * Math.cos(th) + kv[0] * Math.sin(th) + k[0] * d,
           u[1] * Math.cos(th) + kv[1] * Math.sin(th) + k[1] * d,
           u[2] * Math.cos(th) + kv[2] * Math.sin(th) + k[2] * d];
    }
    return Math.abs(Math.atan2(v3.dot(u, b.v), v3.dot(u, b.u)));
  };
  const perJoint = Math.abs(spread.holonomy) / spread.segments;
  ok(across(seamed) > 10 * perJoint,
     `left alone it is a seam at one station (${(across(seamed) * 180 / Math.PI).toFixed(3)}°)`);
  ok(across(spread) < 3 * perJoint,
     `spread along the path the seam is no worse than any other joint `
     + `(${(across(spread) * 180 / Math.PI).toFixed(3)}° against ${(perJoint * 180 / Math.PI).toFixed(3)}°)`);
  ok(!spread.exact && seamed.exact,
     'and spreading it is a twist, so that one stops claiming to be exact');
}
{
  // The scale varies in space exactly as it did in the plane -- it is a
  // property of how far along the path you are, and the path stopped being
  // flat, not the profile. Compared against the kernel's own cone, measured in
  // the frame of a line that points nowhere near an axis.
  const r0 = 3, r1 = 15, L = 50;
  const a = [-14, -9, 5], b = [12, 11, 43];
  const axis = unit3(v3.sub(b, a));
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const len = v3.len(v3.sub(b, a));
  const A = [a, [a[0] + axis[0] * L, a[1] + axis[1] * L, a[2] + axis[2] * L]];
  const m = [(A[0][0] + A[1][0]) / 2, (A[0][1] + A[1][1]) / 2, (A[0][2] + A[1][2]) / 2];
  void mid; void len;
  const f = SW.along(A, P.circle(1), { scale: (t) => r0 + (r1 - r0) * t });
  // the cone runs along +Z in its own frame, so measure the point in the
  // path's frame and hand that over
  const [U0, V0] = [f.frames[0].u, f.frames[0].v];
  const cone = (x, y, z) => {
    const w = [x - m[0], y - m[1], z - m[2]];
    return SF.PRIMS.cone.js([v3.dot(w, U0), v3.dot(w, V0), v3.dot(w, axis)], [r0, r1, L], 0);
  };
  let worst = 0, unsafe = 0, worstShallow = 0;
  for (let i = 0; i < 40000; i++) {
    const p = [m[0] + span(34), m[1] + span(34), m[2] + span(38)];
    const got = f(...p), truth = cone(...p);
    worst = Math.max(worst, Math.abs(got - truth));
    if (truth > 0 && got > truth + 1e-6) unsafe++;
    if (truth < 0 && got > truth) worstShallow = Math.max(worstShallow, got - truth);
  }
  ok(worst < 1.2, `rising scale along a slanted line is the kernel's cone, in that `
     + `direction (worst gap ${worst.toFixed(3)} mm)`);
  ok(unsafe === 0, 'outside, it never reports further than the truth — same as in the plane');
  ok(worstShallow < 0.5, `inside, it under-reports depth by at most `
     + `${worstShallow.toFixed(3)} mm, which is the conservative direction`);
  ok(!f.exact, 'and a tapered sweep through space does not claim to be exact');
  const L2 = lipschitz(f, 36, 30000);
  ok(L2 <= 1.002, `the tapered field is 1-Lipschitz off-axis too (${L2.toFixed(4)})`);
}
{
  // the same three ways of saying it, on a path that climbs
  const path = [], turns = 2.2, Rh = 15, pitch = 30;
  for (let i = 0; i <= 240; i++) {
    const t = i / 240 * turns * 2 * Math.PI;
    path.push([Rh * Math.cos(t), Rh * Math.sin(t), pitch * t / (2 * Math.PI)]);
  }
  const r = 3;
  const byFn = SW.along(path, P.circle(r), { scale: (t) => 0.5 + 1.8 * t });
  const byArr = SW.along(path, P.circle(r), { scale: path.map((_, i) => 0.5 + 1.8 * i / (path.length - 1)) });
  const flat = SW.along(path, P.circle(r), { scale: 1.7 });
  // on the path itself, the material is one scaled profile deep -- less the
  // taper's own conservatism, which is what makes this a bound
  let worstFn = 0, worstArr = 0;
  for (let i = 1; i < path.length - 1; i += 7) {
    const t = i / (path.length - 1), want = -r * (0.5 + 1.8 * t);
    worstFn = Math.max(worstFn, Math.abs(byFn(...path[i]) - want));
    worstArr = Math.max(worstArr, Math.abs(byArr(...path[i]) - want));
  }
  ok(worstFn < 0.1, `a tapered helix is its scaled profile deep all the way along `
     + `(worst ${worstFn.toFixed(4)} mm)`);
  ok(worstArr < 0.1, 'and one factor per path point says the same thing');
  ok(!byFn.exact && !byArr.exact && flat.exact,
     'a constant scale stays exact; a varying one does not');
  const grew = byFn.bounds.hi[2] - flat.bounds.hi[2];
  ok(grew > 0, `the bounds follow the largest scale, not the first (${grew.toFixed(1)} mm taller)`);
  const L3 = lipschitz(byFn, 55, 30000);
  ok(L3 <= 1.002, `and it stays 1-Lipschitz (${L3.toFixed(4)})`);

  // taper and twist at once: the two slants are at right angles and both are
  // divided out, so the bound survives having both
  const both = SW.along(path, P.rect(9, 4), { scale: (t) => 0.6 + 1.4 * t, twist: Math.PI });
  const L4 = lipschitz(both, 55, 30000);
  ok(L4 <= 1.002, `a sweep that tapers and twists at once is still 1-Lipschitz (${L4.toFixed(4)})`);
}
{
  // end to end: a tapered sweep along a path solved in space, meshed, and
  // measured against the volume a truncated cone has
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true });
  const b = S.point(30, 12, 26);
  const ln = S.line(a, b);
  S.constrain('distance', { p: a }, { p: b }, 50);
  ok(S.solve().converged, 'a dimensioned line in space solves');
  const r0 = 2.5, r1 = 8, len = 50;
  const f = SW.fromSketch(S, { entity: ln }, P.circle(1), { scale: (t) => r0 + (r1 - r0) * t });

  // The same solid out of the kernel, in the same slanted frame. It is here as
  // a control: a cone standing on +Z meshes watertight, and the same cone
  // tilted does not quite, because surfaceNets leaves a few unpaired edges
  // wherever a sharp edge crosses the grid at an angle. Meshing both says
  // whether that is the field's doing or the mesher's.
  const A0 = S.posOf({ p: a }), axis = unit3(v3.sub(S.posOf({ p: b }), A0));
  const mid = [A0[0] + axis[0] * len / 2, A0[1] + axis[1] * len / 2, A0[2] + axis[2] * len / 2];
  const [U0, V0] = [f.frames[0].u, f.frames[0].v];
  const cone = (x, y, z) => {
    const w = [x - mid[0], y - mid[1], z - mid[2]];
    return SF.PRIMS.cone.js([v3.dot(w, U0), v3.dot(w, V0), v3.dot(w, axis)], [r0, r1, len], 0);
  };

  const meshed = (g) => {
    const res = 0.55, pad = 2 * res;
    const lo = f.bounds.lo.map(c => c - pad), hi = f.bounds.hi.map(c => c + pad);
    const n = [0, 1, 2].map(i => Math.ceil((hi[i] - lo[i]) / res) + 1);
    const vol = new Float32Array(n[0] * n[1] * n[2]);
    let idx = 0;
    for (let i = 0; i < n[0]; i++)
      for (let j = 0; j < n[1]; j++)
        for (let k = 0; k < n[2]; k++)
          vol[idx++] = g(lo[0] + i * res, lo[1] + j * res, lo[2] + k * res);
    const mesh = SF.surfaceNets(vol, n[0], n[1], n[2], lo[0], lo[1], lo[2], res);
    const nt = mesh.indices.length / 3, edges = new Map();
    for (let t = 0; t < nt; t++) {
      const A = mesh.indices[3 * t], B = mesh.indices[3 * t + 1], C = mesh.indices[3 * t + 2];
      for (const [x, y] of [[A, B], [B, C], [C, A]]) {
        const key = x < y ? `${x}_${y}` : `${y}_${x}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const c of edges.values()) if (c !== 2) bad++;
    const Q = mesh.positions;
    let V = 0;
    for (let t = 0; t < nt; t++) {
      const x = 3 * mesh.indices[3 * t], y = 3 * mesh.indices[3 * t + 1], z = 3 * mesh.indices[3 * t + 2];
      V += (Q[x] * (Q[y + 1] * Q[z + 2] - Q[y + 2] * Q[z + 1])
          - Q[x + 1] * (Q[y] * Q[z + 2] - Q[y + 2] * Q[z])
          + Q[x + 2] * (Q[y] * Q[z + 1] - Q[y + 1] * Q[z])) / 6;
    }
    return { nt, bad, volume: Math.abs(V) };
  };
  const mine = meshed(f), theirs = meshed(cone);
  const want = Math.PI * len * (r0 * r0 + r0 * r1 + r1 * r1) / 3;
  ok(mine.nt > 1000, `the tapered sweep meshes (${mine.nt.toLocaleString()} triangles)`);
  ok(Math.abs(mine.volume - want) / want < 0.03,
     `and holds ${mine.volume.toFixed(0)} mm³ against πL(r0² + r0r1 + r1²)/3 = ${want.toFixed(0)}`);
  ok(Math.abs(mine.volume - theirs.volume) / want < 0.02,
     `within ${(100 * Math.abs(mine.volume - theirs.volume) / want).toFixed(2)}% of the kernel's `
     + 'own cone meshed in the same frame');
  ok(mine.bad <= theirs.bad + 2,
     `and no less watertight than that cone is — ${mine.bad} unpaired edges against its `
     + `${theirs.bad}, which is the mesher on a slanted sharp edge, not the field`);
}
{
  // Twist, which the frame makes almost free: roll the section as it goes.
  const turn = Math.PI / 2;
  const f = SW.along([[0, 0, 0], [60, 0, 0]], P.rect(14, 4), { twist: turn });
  // the section is 14 across and 4 up at the start, and turned a quarter at the end
  ok(f(2, 6, 0) < 0 && f(2, 0, 3) > 0, 'at the start the section lies flat');
  ok(f(58, 0, 6) < 0 && f(58, 3, 0) > 0, 'at the end it stands on edge');
  ok(!f.exact, 'a twisted sweep is a bound, not a distance — and says so');
  const L = lipschitz(f, 40, 30000);
  ok(L <= 1.002, `and the bound is still 1-Lipschitz (${L.toFixed(4)}), so a marcher holds`);
}
{
  // a helix: the case a flat sweep cannot express at all
  const path = [], turns = 2.5, Rh = 16, pitch = 34;
  for (let i = 0; i <= 300; i++) {
    const t = i / 300 * turns * 2 * Math.PI;
    path.push([Rh * Math.cos(t), Rh * Math.sin(t), pitch * t / (2 * Math.PI)]);
  }
  const r = 4;
  const f = SW.along(path, P.circle(r));
  const L = lipschitz(f, 60, 30000);
  ok(L <= 1.002, `a helical sweep is 1-Lipschitz (${L.toFixed(4)})`);
  // it meshes, and it holds about arc length x profile area
  const res = 0.9, pad = 2 * res;
  const lo = f.bounds.lo.map(c => c - pad), hi = f.bounds.hi.map(c => c + pad);
  const n = [0, 1, 2].map(i => Math.ceil((hi[i] - lo[i]) / res) + 1);
  const vol = new Float32Array(n[0] * n[1] * n[2]);
  let idx = 0;
  for (let i = 0; i < n[0]; i++)
    for (let j = 0; j < n[1]; j++)
      for (let k = 0; k < n[2]; k++)
        vol[idx++] = f(lo[0] + i * res, lo[1] + j * res, lo[2] + k * res);
  const mesh = SF.surfaceNets(vol, n[0], n[1], n[2], lo[0], lo[1], lo[2], res);
  const nt = mesh.indices.length / 3;
  const edges = new Map();
  for (let t = 0; t < nt; t++) {
    const A = mesh.indices[3 * t], B = mesh.indices[3 * t + 1], C = mesh.indices[3 * t + 2];
    for (const [x, y] of [[A, B], [B, C], [C, A]]) {
      const key = x < y ? `${x}_${y}` : `${y}_${x}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let bad = 0;
  for (const c of edges.values()) if (c !== 2) bad++;
  ok(nt > 1000 && bad === 0, `it meshes watertight (${nt.toLocaleString()} triangles)`);
  const Q = mesh.positions;
  let V = 0;
  for (let t = 0; t < nt; t++) {
    const a = 3 * mesh.indices[3 * t], b = 3 * mesh.indices[3 * t + 1], c = 3 * mesh.indices[3 * t + 2];
    V += (Q[a] * (Q[b + 1] * Q[c + 2] - Q[b + 2] * Q[c + 1])
        - Q[a + 1] * (Q[b] * Q[c + 2] - Q[b + 2] * Q[c])
        + Q[a + 2] * (Q[b] * Q[c + 1] - Q[b + 1] * Q[c])) / 6;
  }
  const want = f.arcLength * Math.PI * r * r + (4 / 3) * Math.PI * r * r * r - 2 * (Math.PI * r * r * r / 3);
  ok(Math.abs(Math.abs(V) - want) / want < 0.05,
     `and holds ${Math.abs(V).toFixed(0)} mm³ against arc length × πr² ≈ ${want.toFixed(0)}`);
  // and nothing escapes the bounds
  let escaped = 0;
  for (let i = 0; i < 20000; i++) {
    const p = [span(70), span(70), span(70)];
    if (f(...p) < 0 && [0, 1, 2].some(k => p[k] < f.bounds.lo[k] || p[k] > f.bounds.hi[k])) escaped++;
  }
  ok(escaped === 0, 'and its bounds contain it');
}

// ======================================================================
console.log('\n--- along a 3D sketch ---');
{
  // the same door sketch.js came through, one dimension up
  const S = new Sketch3D();
  const a = S.point(-30, -20, 2, { fixed: true }), b = S.point(4, -14, -3);
  const l1 = S.line(a, b);
  const cc = S.point(4, 2, 1);
  const el = S.arc(cc, 15, 11, [0.2, 0.1, 0], -Math.PI / 2, Math.PI / 2);
  const l2 = S.line(S.point(3, 20, 1), S.point(-14, 22, 18));
  S.constrain('coincident', { e: l1, end: 1 }, { e: el, end: 0 });
  S.constrain('parallel', { e: l1, end: 1 }, { e: el, end: 0 });
  S.constrain('coincident', { e: el, end: 1 }, { e: l2, end: 0 });
  S.constrain('circular', el);
  S.constrain('radius', el, undefined, 18);
  S.constrain('horizontal', { e: l1 });
  S.constrain('distance', { p: a }, { p: b }, 34);
  for (const t of [0, Math.PI / 2])
    S.constrain('horizontal', { e: el, t: S.param(t, { fixed: true }) });
  ok(S.solve().converged, 'a 3D sketch solves, and then it is a path');

  const f = SW.fromSketch(S, { entity: el }, P.rect(8, 3));
  ok(f.segments > 10 && f.arcLength > 40,
     `sweeping one of its arcs gives ${f.segments} segments over ${f.arcLength.toFixed(1)} mm`);
  const mid = S.evalAt(S.x, el, 0);
  ok(f(mid[0], mid[1], mid[2]) < 0 || f(...S.posOf({ e: el, t: S.param(0) })) < 0,
     'and the path itself is inside the material');

  // a spline in space, which is the shape a flat sweep has no way to express
  const cs = [S.point(-40, 30, 0), S.point(-10, 46, 18), S.point(24, 24, -6),
              S.point(48, 44, 20)];
  const nb = S.nurbs(cs, { degree: 3 });
  const g = SW.fromSketch(S, { entity: nb }, P.circle(4));
  ok(g.segments > 20, `and a NURBS in space sweeps too (${g.segments} segments)`);
  ok(!g.frames.some((fr, i) => i && v3.dot(fr.u, g.frames[i - 1].u) < 0),
     'without the section turning over anywhere along it');
}
{
  // a face's boundary, from the 3D profile
  const rot = [0.3, -0.4, 0.7], W = 40, H = 25;
  const S = new Sketch3D();
  const [u, v] = M3.frameOf(rot[0], rot[1], rot[2]);
  const at = (A, B) => S.point(u[0] * A + v[0] * B, u[1] * A + v[1] * B, u[2] * A + v[2] * B);
  const c = [at(0, 0), at(W, 0), at(W, H), at(0, H)];
  S.line(c[0], c[1]); S.line(c[1], c[2]); S.line(c[2], c[3]); S.line(c[3], c[0]);
  const f = SW.fromSketch(S, { face: 0 }, P.circle(3));
  near(f.arcLength, 2 * (W + H), 1e-6, 'a tilted face’s boundary sweeps at its own perimeter');
  near(f.holonomy, 0, 1e-12, 'and being flat, its frame comes back unturned');
  // the corners of the plate are inside the bead
  let outside = 0;
  for (const p of [c[0], c[1], c[2], c[3]].map(id => S.posOf({ p: id })))
    if (f(...p) > -2.9) outside++;
  ok(outside === 0, 'every corner of it is a bead radius deep in the material');

  // the two sketchers report a profile differently, and asking the wrong one
  // for a face has to say so rather than reading undefined
  const flat = new Sketch();
  const p0 = flat.point(0, 0), p1 = flat.point(20, 0), p2 = flat.point(20, 20), p3 = flat.point(0, 20);
  flat.line(p0, p1); flat.line(p1, p2); flat.line(p2, p3); flat.line(p3, p0);
  let msg = '';
  try { SW.fromSketch(flat, { face: 0 }, P.circle(2)); } catch (e) { msg = e.message; }
  ok(msg.indexOf('3D sketch') >= 0, `a 2D sketch asked for a face says so: ${msg}`);
  const l = SW.fromSketch(flat, { loop: 0 }, P.circle(2));
  near(l.arcLength, 80, 1e-6, 'and { loop } still means what it always did');
}

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
