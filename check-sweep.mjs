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

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
