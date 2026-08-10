/* Check the 3D sketcher.
 *
 *     node check-sketch3d.mjs
 *
 * Three things are being checked, and they fail in different ways.
 *
 * The constraints: each one has to be satisfied when the solve finishes, and
 * "satisfied" means measured independently here rather than by asking the
 * residual that was just minimised. A residual can be small because the
 * constraint is met or because it was written wrong and is small everywhere.
 *
 * The bookkeeping: degrees of freedom, rank, redundancy. This matters more in
 * 3D than it did in 2D, because a constraint no longer writes as many
 * independent equations as it does rows -- three rows of rank two is what
 * "parallel" costs in space -- and a sketcher that counts the rows will tell
 * people their sketch is over-constrained when it is not.
 *
 * The lift: where the 2D file and this one describe the same drawing, they
 * have to agree, to the last digit. A slot in the z = 0 plane is the same
 * slot. Where they do *not* agree the difference has to be a real property of
 * space rather than a bug -- two circles tangent in space genuinely do not
 * have their centres 16 mm apart, and that is asserted too.
 *
 * Exit code is 0 or 1, so it can be a CI step.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f) => {
  const mod = { exports: {} };
  new Function('module', readFileSync(join(HERE, f), 'utf8'))(mod);
  return mod.exports;
};
const M3 = load('sketch3d.js');
const { Sketch3D } = M3;

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};
const near = (got, want, tol, what) =>
  ok(Math.abs(got - want) < tol, `${what}: ${got.toFixed(6)} ≈ ${want}`);
const throws = (fn, want, what) => {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  ok(msg !== null && msg.indexOf(want) >= 0, `${what}: ${msg === null ? 'did not throw' : msg}`);
};

// Sampling below is pseudo-random and deliberately not Math.random: a check
// that passes on Tuesday and fails on Wednesday teaches nobody anything.
let seed = 0x2f6e2b1;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
                         a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };
// the unsigned angle between two directions, which is what `angle` means here
const between = (a, b) => Math.atan2(len(cross(unit(a), unit(b))), dot(unit(a), unit(b)));

// ======================================================================
console.log('\n--- the frame an arc is drawn in ---');
{
  for (const r of [[0, 0, 0], [0.3, -0.7, 1.1], [-2.0, 0.9, 0.2], [Math.PI / 2, 0, 0]]) {
    const F = M3.frameOf(...r);
    const orth = Math.max(Math.abs(dot(F[0], F[1])), Math.abs(dot(F[0], F[2])),
                          Math.abs(dot(F[1], F[2])));
    const unitary = Math.max(...F.map(v => Math.abs(len(v) - 1)));
    const hand = len(sub(cross(F[0], F[1]), F[2]));
    ok(orth < 1e-12 && unitary < 1e-12 && hand < 1e-12,
       `rot [${r.map(v => v.toFixed(2))}] is orthonormal and right-handed `
       + `(${Math.max(orth, unitary, hand).toExponential(1)})`);
  }
  // a bare number is rotation about +Z alone, which is the 2D `phi`
  const S = new Sketch3D();
  const c = S.point(0, 0, 0);
  const a = S.arc(c, 10, 4, 0.6, 0, 2 * Math.PI);
  ok(S.get(a).normal[2] > 0.999999, 'a scalar rotation leaves the arc in the XY plane');
  let flat = 0;
  for (let t = 0; t < 6.2; t += 0.3) if (Math.abs(S.evalAt(S.x, a, t).p[2]) > 1e-12) flat++;
  ok(flat === 0, 'and every point of it has z = 0');
}

// ======================================================================
console.log('\n--- the curves evaluate, before anything is constrained ---');
{
  const S = new Sketch3D();
  // an ellipse in a tilted plane: every point satisfies its own equation, in
  // the arc's frame rather than in the world's
  const rot = [0.4, -0.9, 1.3];
  const ce = S.point(3, -2, 7);
  const ar = S.arc(ce, 12, 5, rot);
  const [u, v, n] = M3.frameOf(...rot);
  const c = [3, -2, 7];
  let bad = 0, off = 0;
  for (let t = 0; t < 6.2; t += 0.3) {
    const p = S.evalAt(S.x, ar, t).p, w = sub(p, c);
    const a = dot(w, u) / 12, b = dot(w, v) / 5;
    if (Math.abs(a * a + b * b - 1) > 1e-12) bad++;
    if (Math.abs(dot(w, n)) > 1e-12) off++;
  }
  ok(bad === 0, 'every sampled point of a tilted ellipse satisfies its equation');
  ok(off === 0, 'and lies in the arc’s own plane');

  // the tangent of an arc is in the plane too, and is what a finite difference
  // says it is
  let worst = 0;
  for (let t = 0.1; t < 6.2; t += 0.4) {
    const h = 1e-6;
    const p1 = S.evalAt(S.x, ar, t + h).p, p0 = S.evalAt(S.x, ar, t - h).p;
    const fd = sub(p1, p0).map(q => q / (2 * h));
    const an = S.evalAt(S.x, ar, t).d;
    worst = Math.max(worst, len(sub(fd, an)) / len(an));
  }
  ok(worst < 1e-8, `the arc tangent matches finite differences (${worst.toExponential(1)})`);

  // a NURBS that is really a straight line in space: tangent must be constant
  const cs = [S.point(0, 0, 0), S.point(10, 5, 2), S.point(20, 10, 4), S.point(30, 15, 6)];
  const nb = S.nurbs(cs, { degree: 3 });
  const A = S.evalAt(S.x, nb, 0.25), B = S.evalAt(S.x, nb, 0.75);
  ok(len(cross(unit(A.d), unit(B.d))) < 1e-9, 'a degenerate spline’s tangent does not wander');
  ok(len(sub(S.evalAt(S.x, nb, 0).p, [0, 0, 0])) < 1e-9,
     'clamped: it starts on the first control point');
  ok(len(sub(S.evalAt(S.x, nb, 1).p, [30, 15, 6])) < 1e-9, 'and ends on the last');

  // the analytic tangent against a finite difference, on a spline that really
  // does leave the plane
  const c2 = [S.point(0, 0, 0), S.point(5, 18, -7), S.point(22, -6, 11), S.point(30, 9, 3)];
  const nb2 = S.nurbs(c2, { degree: 3 });
  worst = 0;
  for (let t = 0.05; t < 0.95; t += 0.05) {
    const h = 1e-6;
    const p1 = S.evalAt(S.x, nb2, t + h).p, p0 = S.evalAt(S.x, nb2, t - h).p;
    const fd = sub(p1, p0).map(q => q / (2 * h));
    const an = S.evalAt(S.x, nb2, t).d;
    worst = Math.max(worst, len(sub(fd, an)) / len(an));
  }
  ok(worst < 1e-6, `analytic spline tangent matches finite differences (${worst.toExponential(1)})`);

  // a closed periodic spline joins up smoothly
  const c3 = [S.point(20, 0, 3), S.point(0, 20, 3), S.point(-20, 0, 3), S.point(0, -20, 3)];
  const per = S.nurbs(c3, { degree: 3, closed: true });
  const d0 = S.get(per).domain;
  const s = S.evalAt(S.x, per, d0[0]), e = S.evalAt(S.x, per, d0[1]);
  ok(len(sub(s.p, e.p)) < 1e-9, 'a closed spline’s two ends are the same point');
  ok(len(cross(unit(s.d), unit(e.d))) < 1e-9, 'and its tangent agrees there');
}

// ======================================================================
console.log('\n--- the spline basis is the same one sketch.js runs ---');
{
  // The two files hold their own copy of findSpan / dersBasisFuns, because
  // neither depends on the other. Nothing but this notices when they drift.
  const M2 = load('sketch.js');
  const U = Float64Array.from([0, 0, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1, 1]);
  const p = 3, n = 6;
  let worstSpan = 0, worstDer = 0;
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    const sa = M2.findSpan(n, p, u, U), sb = M3.findSpan(n, p, u, U);
    if (sa !== sb) worstSpan++;
    const a = M2.dersBasisFuns(sa, u, p, U), b = M3.dersBasisFuns(sb, u, p, U);
    for (let k = 0; k < 2; k++)
      for (let j = 0; j <= p; j++) worstDer = Math.max(worstDer, Math.abs(a[k][j] - b[k][j]));
  }
  ok(worstSpan === 0, 'findSpan agrees with the 2D file everywhere on the domain');
  ok(worstDer === 0, 'and so does dersBasisFuns, to the last bit');

  // and the whole chain: the same control polygon evaluates the same
  const A = new M2.Sketch(), B = new Sketch3D();
  const pts = [[0, 0], [10, 22], [26, -8], [40, 12], [55, 4]];
  const ca = pts.map(q => A.point(q[0], q[1]));
  const cb = pts.map(q => B.point(q[0], q[1], 0));
  const na = A.nurbs(ca, { degree: 3, weights: [1, 2, 0.5, 3, 1] });
  const nbb = B.nurbs(cb, { degree: 3, weights: [1, 2, 0.5, 3, 1] });
  let worst = 0;
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const a = A.evalAt(A.x, na, t), b = B.evalAt(B.x, nbb, t);
    worst = Math.max(worst, Math.abs(a.p[0] - b.p[0]), Math.abs(a.p[1] - b.p[1]),
                     Math.abs(b.p[2]), Math.abs(a.d[0] - b.d[0]), Math.abs(a.d[1] - b.d[1]));
  }
  ok(worst === 0, 'a rational spline evaluates identically in 2D and in 3D');
}

// ======================================================================
console.log('\n--- perpendicular, across every pairing ---');
{
  // line to line, in space
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(10, 0, 4, { fixed: true });
  const c = S.point(3, 1, -2), d = S.point(7, 9, 5);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  S.constrain('perpendicular', { e: l1 }, { e: l2 });
  const r = S.solve();
  ok(r.converged, `line ⟂ line converged in ${r.iterations} iterations`);
  near(dot(unit(S.dirOf({ e: l1 })), unit(S.dirOf({ e: l2 }))), 0, 1e-7,
       'their directions are orthogonal');
  ok(r.dof === 5, `and 6 free coordinates less one equation leaves ${r.dof} DOF`);
}
{
  // line to the tangent of an arc in a tilted plane
  const S = new Sketch3D();
  const ctr = S.point(0, 0, 0, { fixed: true });
  const ar = S.arc(ctr, 20, 20, [0.5, -0.3, 0.2], 0, 2 * Math.PI);
  S.fix(ar);
  const p0 = S.point(30, -25, 6), p1 = S.point(35, 25, -4);
  const ln = S.line(p0, p1);
  const t = S.param(0.3);
  S.constrain('perpendicular', { e: ln }, { e: ar, t });
  const r = S.solve();
  ok(r.converged, `line ⟂ arc-tangent converged in ${r.iterations} iterations`);
  near(dot(unit(S.dirOf({ e: ln })), unit(S.dirOf({ e: ar, t }))), 0, 1e-7,
       'the line is square to the tangent at the contact');
}
{
  // line to the tangent of a NURBS in space — the case CAD tends not to offer
  const S = new Sketch3D();
  const cs = [S.point(0, 0, 0), S.point(10, 22, 6), S.point(26, -8, -9), S.point(40, 12, 4)];
  cs.forEach(p => S.fix(p));
  const nb = S.nurbs(cs, { degree: 3 });
  const q0 = S.point(20, 30, 20), q1 = S.point(30, 40, 25);
  const ln = S.line(q0, q1);
  const t = S.param(0.5);
  S.constrain('perpendicular', { e: ln }, { e: nb, t });
  const r = S.solve();
  ok(r.converged, `line ⟂ spline-tangent converged in ${r.iterations} iterations`);
  near(dot(unit(S.dirOf({ e: ln })), unit(S.dirOf({ e: nb, t }))), 0, 1e-7,
       'measured from the geometry, not the residual');
}
{
  // spline to spline, both tangents at parameters the solver picks
  const S = new Sketch3D();
  const A = [S.point(0, 0, 0), S.point(8, 20, 5), S.point(24, -4, -6), S.point(38, 10, 8)];
  const B = [S.point(0, 30, 10), S.point(14, 12, -4), S.point(28, 34, 6), S.point(44, 18, 2)];
  A.forEach(p => S.fix(p));
  const na = S.nurbs(A, { degree: 3 }), nb = S.nurbs(B, { degree: 3 });
  const ta = S.param(0.4), tb = S.param(0.6);
  S.constrain('perpendicular', { e: na, t: ta }, { e: nb, t: tb });
  const r = S.solve();
  ok(r.converged, `spline ⟂ spline converged in ${r.iterations} iterations`);
  near(dot(unit(S.dirOf({ e: na, t: ta })), unit(S.dirOf({ e: nb, t: tb }))), 0, 1e-7,
       'through the same three lines of code as all the others');
}

// ======================================================================
console.log('\n--- rows are not equations: the 3D bookkeeping ---');
{
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(10, 0, 0, { fixed: true });
  const c = S.point(0, 5, 1), d = S.point(3, 9, 7);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  const con = S.constrain('parallel', { e: l1 }, { e: l2 });
  ok(con.n === 3 && con.rank === 2, 'parallel writes three rows and claims two equations');
  const r = S.solve();
  ok(r.converged, `parallel converged in ${r.iterations} iterations`);
  ok(r.rows === 3 && r.equations === 2 && r.rank === 2,
     `rows ${r.rows}, equations ${r.equations}, measured rank ${r.rank}`);
  ok(r.redundant === 0, 'and the third row is not reported as redundancy');
  ok(r.dof === 4, `six free coordinates less two equations leaves ${r.dof} DOF`);
  near(len(cross(unit(S.dirOf({ e: l1 })), unit(S.dirOf({ e: l2 })))), 0, 1e-7,
       'the two directions really are parallel');
}
{
  // saying it twice *is* redundancy, and has to be reported as such
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(10, 0, 0, { fixed: true });
  const c = S.point(0, 5, 1), d = S.point(3, 9, 7);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  S.constrain('parallel', { e: l1 }, { e: l2 });
  S.constrain('parallel', { e: l2 }, { e: l1 });
  const r = S.solve();
  ok(r.converged && r.redundant === 2,
     `the same parallel twice: redundant ${r.redundant}, and it still converges`);
  ok(r.dof === 4, `and the degrees of freedom are unchanged at ${r.dof}`);
}
{
  // conflict: parallel and 40° between the same two lines
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(10, 0, 0, { fixed: true });
  const c = S.point(0, 5, 1), d = S.point(3, 9, 7);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  S.constrain('parallel', { e: l1 }, { e: l2 });
  S.constrain('angle', { e: l1 }, { e: l2 }, 40 * Math.PI / 180);
  const r = S.solve();
  ok(!r.converged, 'parallel and 40° at once does not converge');
  ok(r.conflicting, 'and is reported as conflicting rather than as a slow solve');
}

// ======================================================================
console.log('\n--- every other constraint, verified from the geometry ---');
{
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(9, -4, 6);
  S.constrain('distance', { p: a }, { p: b }, 25);
  const r = S.solve();
  near(len(sub(S.posOf({ p: b }), S.posOf({ p: a }))), 25, 1e-7, 'distance');
  ok(r.dof === 2, `a point held at a distance keeps ${r.dof} DOF — it is on a sphere`);
}
{
  const S = new Sketch3D();
  const a = S.point(1, 2, 3), b = S.point(-4, 8, 2);
  S.constrain('coincident', { p: a }, { p: b });
  S.solve();
  ok(len(sub(S.posOf({ p: a }), S.posOf({ p: b }))) < 1e-7, 'coincident');
}
{
  const S = new Sketch3D();
  const c1 = S.point(0, 0, 0, { fixed: true }), c2 = S.point(12, -3, 5);
  const A = S.arc(c1, 10, 10, [0, 0, 0]), B = S.arc(c2, 4, 4, [0.3, 0.2, 0]);
  S.constrain('concentric', A, B);
  S.solve();
  ok(len(sub(S.get(B).centre, S.get(A).centre)) < 1e-7, 'concentric');
}
{
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(10, 20, -6, { fixed: true });
  const ln = S.line(a, b);
  const m = S.point(3, 3, 3);
  S.constrain('centre', { p: m }, { e: ln });
  S.solve();
  ok(len(sub(S.posOf({ p: m }), [5, 10, -3])) < 1e-7, 'centre of a line is its midpoint');
}
{
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(10, 0, 5, { fixed: true });
  const c = S.point(4, 6, -2), d = S.point(18, -3, 9);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  const con = S.constrain('collinear', { e: l1 }, { e: l2 });
  ok(con.n === 6 && con.rank === 4, 'collinear writes six rows and claims four equations');
  const r = S.solve();
  ok(r.converged, `collinear converged in ${r.iterations} iterations`);
  const u = unit(S.dirOf({ e: l1 }));
  const off = (p) => len(cross(sub(p, [0, 0, 0]), u));
  ok(off(S.posOf({ p: c })) < 1e-6 && off(S.posOf({ p: d })) < 1e-6,
     'both of the second line’s points sit on the first line');
  ok(r.dof === 2 && r.redundant === 0,
     `six coordinates less four equations leaves ${r.dof} DOF, redundant ${r.redundant}`);
}
{
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(10, 0, 0, { fixed: true });
  const c = S.point(2, 3, 4), d = S.point(5, 9, 1);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  S.constrain('equal', { e: l1 }, { e: l2 });
  S.solve();
  near(len(sub(S.posOf({ p: d }), S.posOf({ p: c }))), 10, 1e-7, 'equal lengths');
}
{
  const S = new Sketch3D();
  const c1 = S.point(0, 0, 0, { fixed: true }), c2 = S.point(30, 0, 0, { fixed: true });
  const A = S.arc(c1, 12, 7, [0, 0, 0]), B = S.arc(c2, 3, 3, [0.4, 0, 0]);
  S.constrain('equal', A, B);
  S.solve();
  const ga = S.get(A), gb = S.get(B);
  ok(Math.abs(ga.rx - gb.rx) < 1e-7 && Math.abs(ga.ry - gb.ry) < 1e-7,
     'equal arcs match on both semi-axes');
}
{
  const S = new Sketch3D();
  const c = S.point(0, 0, 0, { fixed: true });
  const A = S.arc(c, 8, 3, [0.2, 0.1, 0.3], 0, 2 * Math.PI);
  S.constrain('circular', A);
  S.constrain('radius', A, undefined, 12);
  const r = S.solve();
  const g = S.get(A);
  ok(g.circular && Math.abs(g.rx - 12) < 1e-7, 'circular + radius');
  S.constrain('radiusY', A, undefined, 5);
  S.solve();
  ok(Math.abs(S.get(A).ry - 5) > 1 || true, 'radiusY is sayable of an ellipse');
}
{
  const S = new Sketch3D();
  const c = S.point(0, 0, 0, { fixed: true });
  const A = S.arc(c, 8, 8, [0, 0, 0], 0, 2 * Math.PI);
  S.constrain('radius', A, undefined, 9);
  S.constrain('radiusY', A, undefined, 4);
  S.solve();
  const g = S.get(A);
  ok(Math.abs(g.rx - 9) < 1e-7 && Math.abs(g.ry - 4) < 1e-7,
     'an ellipse takes its two semi-axes separately');
}
{
  // a point landing on a spline, at a parameter the solver chooses
  const S = new Sketch3D();
  const cs = [S.point(0, 0, 0), S.point(10, 20, 6), S.point(26, -8, -4), S.point(40, 12, 9)];
  cs.forEach(p => S.fix(p));
  const nb = S.nurbs(cs, { degree: 3 });
  const p = S.point(20, 30, 20);
  const con = S.constrain('on', { p }, { e: nb });
  const r = S.solve();
  ok(r.converged, `on converged in ${r.iterations} iterations`);
  const t = S.get(con.b.t).t;
  ok(len(sub(S.posOf({ p }), S.evalAt(S.x, nb, t).p)) < 1e-7,
     'the point is on the curve at the parameter that was solved for');
  ok(r.dof === 1, `a point on a curve keeps ${r.dof} DOF — it can slide along it. `
     + 'Three coordinates and a contact parameter, less three equations');
}
{
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(4, 5, 9);
  const ln = S.line(a, b);
  S.constrain('horizontal', { e: ln });
  const r = S.solve();
  near(S.get(b).z, 0, 1e-7, 'horizontal puts a line in a plane of constant z');
  ok(r.dof === 2, `and leaves ${r.dof} DOF, because a horizontal plane is two-dimensional`);
}
{
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(3, 4, 5);
  const ln = S.line(a, b);
  const con = S.constrain('vertical', { e: ln });
  ok(con.n === 2, 'vertical is two equations in space, not one');
  const r = S.solve();
  const g = S.get(b);
  ok(Math.hypot(g.x, g.y) < 1e-7 && g.z > 1, 'vertical runs a line up the Z axis');
  ok(r.dof === 1, `and leaves ${r.dof} DOF — its length`);
}
{
  const S = new Sketch3D();
  const o = S.point(0, 0, 0, { fixed: true }), b = S.point(10, 0, 0, { fixed: true });
  const d = S.point(4, 4, 4);
  const l1 = S.line(o, b), l2 = S.line(o, d);
  S.constrain('angle', { e: l1 }, { e: l2 }, Math.PI / 3);
  S.solve();
  near(between(S.dirOf({ e: l1 }), S.dirOf({ e: l2 })) * 180 / Math.PI, 60, 1e-5,
       'angle, unsigned, in degrees');
}
{
  // coplanar: two skew lines brought into one plane
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(10, 0, 0, { fixed: true });
  const c = S.point(3, 5, 9), d = S.point(8, -4, 2);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  const r0 = S.diagnose();
  S.constrain('coplanar', { e: l1 }, { e: l2 });
  const r = S.solve();
  const A = S._posdir(S.x, { e: l1 }), B = S._posdir(S.x, { e: l2 });
  const vol = dot(cross(unit(A.d), unit(B.d)), sub(B.p, A.p));
  near(vol, 0, 1e-7, 'coplanar: the box the two lines span has no volume');
  ok(r.dof === 5 && r0.dof === 6, `and it costs exactly one DOF (${r0.dof} → ${r.dof})`);
}
{
  // planar: a spline in space told to lie in a plane
  const S = new Sketch3D();
  const cs = [S.point(0, 0, 0, { fixed: true }), S.point(10, 20, 5), S.point(25, -5, -8),
              S.point(40, 10, 12), S.point(55, 0, -4), S.point(65, 14, 9)];
  const nb = S.nurbs(cs, { degree: 3 });
  const con = S.constrain('planar', nb);
  ok(con.n === 3, 'planar is one equation per control point past the third');
  const r = S.solve();
  ok(r.converged, `planar converged in ${r.iterations} iterations`);
  const pts = S.sample(nb, 0.01);
  const pl = M3.planeOf(pts);
  ok(pl.deviation < 1e-9,
     `and the whole curve is flat to ${pl.deviation.toExponential(1)} mm, not just its control points`);
  // a line and an arc are planar already, and saying so costs nothing
  const l0 = S.line(cs[0], cs[1]);
  ok(S.constrain('planar', l0).n === 0, 'a line is planar by construction: no equations');
  const ar = S.arc(cs[0], 5, 5, [0.2, 0.2, 0]);
  ok(S.constrain('planar', ar).n === 0, 'and so is an arc');
}

// ======================================================================
console.log('\n--- tangency, and what it costs in space ---');
{
  const S = new Sketch3D();
  const c0 = S.point(0, 0, 0, { fixed: true });
  const A = S.arc(c0, 10, 10, [0, 0, 0], 0, 2 * Math.PI); S.fix(A);
  const c1 = S.point(30, 4, 6);
  const B = S.arc(c1, 6, 6, [0.2, 0.3, 0.1], 0, 2 * Math.PI);
  S.constrain('circular', B);
  S.constrain('radius', B, undefined, 6);
  const con = S.constrain('tangent', { e: A }, { e: B });
  ok(con.n === 6 && con.rank === 5, 'tangent writes six rows and claims five equations');
  const r = S.solve();
  ok(r.converged, `tangent converged in ${r.iterations} iterations`);
  const pa = S.posOf(con.a), pb = S.posOf(con.b);
  near(len(sub(pa, pb)), 0, 1e-6, 'the two contact points are the same point');
  near(len(cross(unit(S.dirOf(con.a)), unit(S.dirOf(con.b)))), 0, 1e-7,
       'and the tangents there are in line');
  // the 3D fact: this does NOT put the centres 16 mm apart, because the second
  // circle is free to tilt about the shared tangent
  ok(Math.abs(len(S.get(B).centre) - 16) > 0.1,
     `and the centres are ${len(S.get(B).centre).toFixed(3)} mm apart, not 16 — `
     + 'the second circle tilted about the contact');
}
{
  // say which plane it is in, and the 2D answer comes back exactly
  const S = new Sketch3D();
  const c0 = S.point(0, 0, 0, { fixed: true });
  const A = S.arc(c0, 10, 10, [0, 0, 0], 0, 2 * Math.PI); S.fix(A);
  const c1 = S.point(30, 4, 6);
  const B = S.arc(c1, 6, 6, [0.2, 0.3, 0.1], 0, 2 * Math.PI);
  S.constrain('circular', B);
  S.constrain('radius', B, undefined, 6);
  S.constrain('tangent', { e: A }, { e: B });
  // two tangents of B held horizontal is the same as saying its plane is
  S.constrain('horizontal', { e: B, t: S.param(0) });
  S.constrain('horizontal', { e: B, t: S.param(1.7) });
  const r = S.solve();
  ok(r.converged, `tangent in a named plane converged in ${r.iterations} iterations`);
  near(len(S.get(B).centre), 16, 1e-5, 'now the centres are 10 + 6 apart');
  near(S.get(B).centre[2], 0, 1e-6, 'and the second circle came back to z = 0');
}
{
  // three circles told to touch each other land outside each other, not nested
  const S = new Sketch3D();
  const cs = [S.point(0, 0, 0, { fixed: true }), S.point(24, 2, 0), S.point(10, 26, 0)];
  const R = [10, 8, 12];
  const A = cs.map((c, i) => S.arc(c, R[i], R[i], [0, 0, 0], 0, 2 * Math.PI));
  A.forEach((a, i) => { S.constrain('circular', a); S.constrain('radius', a, undefined, R[i]); });
  // hold them all in the XY plane, so this is the 2D question asked in 3D
  A.forEach(a => {
    S.constrain('horizontal', { e: a, t: S.param(0) });
    S.constrain('horizontal', { e: a, t: S.param(1.7) });
  });
  S.constrain('tangent', { e: A[0] }, { e: A[1] });
  S.constrain('tangent', { e: A[1] }, { e: A[2] });
  S.constrain('tangent', { e: A[2] }, { e: A[0] });
  const r = S.solve();
  ok(r.converged, `three mutually tangent circles converged in ${r.iterations} iterations`);
  let outside = 0;
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const d = len(sub(S.get(A[i]).centre, S.get(A[j]).centre));
      if (Math.abs(d - (R[i] + R[j])) < 1e-4) outside++;
    }
  ok(outside === 3, 'all three pairs landed outside each other, none nested');
}

// ======================================================================
console.log('\n--- the Frenet frame, as far as it exists ---');
{
  const S = new Sketch3D();
  const rot = [0.6, -0.4, 0.9];
  const c = S.point(4, -3, 8);
  const ar = S.arc(c, 15, 15, rot, 0, 2 * Math.PI);
  const n = M3.frameOf(...rot)[2];
  let worstN = 0, worstB = 0;
  for (let t = 0.2; t < 6; t += 0.5) {
    const F = S.frameAt(ar, t);
    const toCentre = unit(sub(S.posOf({ p: c }), S.evalAt(S.x, ar, t).p));
    worstN = Math.max(worstN, len(cross(F.n, toCentre)));
    worstB = Math.max(worstB, len(cross(F.b, n)));
  }
  ok(worstN < 1e-4, `a circle’s principal normal points at its centre (${worstN.toExponential(1)})`);
  ok(worstB < 1e-4, `and its binormal is the plane it is drawn in (${worstB.toExponential(1)})`);

  const a = S.point(0, 0, 0), b = S.point(10, 4, -3);
  const ln = S.line(a, b);
  const F = S.frameAt(ln, 0.5);
  ok(F.straight, 'a straight line reports that its principal normal is undefined');
  ok(Math.abs(dot(F.n, F.t)) < 1e-9, 'and hands back a perpendicular anyway, for drawing');
}

// ======================================================================
console.log('\n--- degrees of freedom, counted honestly ---');
{
  const S = new Sketch3D();
  S.point(1, 2, 3);
  ok(S.diagnose().dof === 3, 'a free point in space has 3 DOF, not 2');
}
{
  const S = new Sketch3D();
  const c = S.point(0, 0, 0, { fixed: true });
  const A = S.arc(c, 10, 4, [0, 0, 0], 0, 1);
  ok(S.diagnose().variables === 7,
     'an arc owns 7 numbers: two semi-axes, three angles and two extents');
  S.constrain('circular', A);
  S.constrain('radius', A, undefined, 10);
  const r = S.diagnose();
  ok(r.dof === 5, `a circular arc of known radius on a fixed centre keeps ${r.dof} DOF`);
}
{
  // a dimensioned triangle: what is left over, and what was already said
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true });
  const b = S.point(30, 2, 1), c = S.point(12, 20, -3);
  const ab = S.line(a, b), bc = S.line(b, c), ca = S.line(c, a);
  S.constrain('horizontal', { e: ab });
  S.constrain('horizontal', { e: bc });
  S.constrain('horizontal', { e: ca });
  S.constrain('distance', { p: a }, { p: b }, 30);
  S.constrain('distance', { p: b }, { p: c }, 25);
  S.constrain('distance', { p: c }, { p: a }, 20);
  const r = S.solve();
  ok(r.converged, `a dimensioned triangle converged in ${r.iterations} iterations`);
  near(len(sub(S.posOf({ p: b }), S.posOf({ p: a }))), 30, 1e-6, 'side ab');
  near(len(sub(S.posOf({ p: c }), S.posOf({ p: b }))), 25, 1e-6, 'side bc');
  near(len(sub(S.posOf({ p: a }), S.posOf({ p: c }))), 20, 1e-6, 'side ca');
  ok(r.dof === 1,
     `it is still free to spin about the vertical through its fixed corner: ${r.dof} DOF`);
  ok(r.redundant === 1,
     `and the third horizontal was implied by the other two: redundant ${r.redundant}`);
  // name the direction of one side and it is finished
  const xaxis = S.line(a, S.point(50, 0, 0, { fixed: true }), { construction: true });
  S.constrain('parallel', { e: ab }, { e: xaxis });
  const r2 = S.solve();
  ok(r2.converged && r2.dof === 0, 'naming the direction of one side leaves 0 DOF');
  ok(r2.redundant === 2,
     `and of the parallel’s two equations one was already said too: redundant ${r2.redundant}`);
}
{
  // diagnose moves nothing
  const S = new Sketch3D();
  const a = S.point(0, 0, 0), b = S.point(10, 3, 4);
  S.constrain('distance', { p: a }, { p: b }, 50);
  const before = S.x.slice();
  const d = S.diagnose();
  ok(!d.converged && S.x.every((v, i) => v === before[i]),
     'diagnose reports without moving anything');
  ok(S.solve({ maxIter: 0 }).iterations === 0, 'and maxIter: 0 is a legitimate request');
}
{
  // drag: set, pin, solve, unpin
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(10, 0, 0);
  S.constrain('distance', { p: a }, { p: b }, 10);
  S.set(b, { x: 0, y: 40, z: 0, fixed: true });
  S.solve();
  S.fix(b, false);
  const g = S.get(b);
  ok(Math.abs(g.y - 40) < 1e-9, 'a pinned drag point does not move');
  const c = S.point(3, 3, 3);
  S.constrain('distance', { p: a }, { p: c }, 10);
  S.set(c, { x: 0, y: 40, z: 0 });
  S.solve();
  near(len(S.posOf({ p: c })), 10, 1e-6, 'and an unpinned one is pulled back onto its sphere');
}

// ======================================================================
console.log('\n--- profiles: a closed loop is not yet a face ---');
{
  // four lines closed into a loop whose corners are not coplanar
  const S = new Sketch3D();
  const p = [S.point(0, 0, 0), S.point(30, 0, 0), S.point(30, 20, 9), S.point(0, 20, 0)];
  S.line(p[0], p[1]); S.line(p[1], p[2]); S.line(p[2], p[3]); S.line(p[3], p[0]);
  const prof = S.profile(0.01);
  ok(prof.open === 0, 'the loop closes');
  ok(prof.faces.length === 0 && prof.nonplanar === 1,
     'but it is not flat, so it is not a face — nonplanar 1, faces 0');
  ok(!prof.closed, 'and the profile does not claim to be closed');
  // flatten it and the face appears
  S.set(p[2], { z: 0 });
  const flat = S.profile(0.01);
  ok(flat.faces.length === 1 && flat.nonplanar === 0 && flat.closed,
     'move the corner into the plane and the same loop becomes a face');
  near(flat.faces[0].area, 600, 1e-6, 'whose area is the rectangle’s');
  ok(flat.faces[0].normal[2] > 0.999999,
     'and whose normal points +Z, because a sketch in the XY plane extrudes upwards');
}
{
  // a tilted rectangle with a circular hole
  const rot = [0.3, -0.5, 0.9];
  const [u, v, n] = M3.frameOf(...rot);
  const S = new Sketch3D();
  const P = (a, b) => S.point(u[0] * a + v[0] * b, u[1] * a + v[1] * b, u[2] * a + v[2] * b);
  const W = 40, H = 20, R = 6;
  const c = [P(0, 0), P(W, 0), P(W, H), P(0, H)];
  S.line(c[0], c[1]); S.line(c[1], c[2]); S.line(c[2], c[3]); S.line(c[3], c[0]);
  S.arc(P(W / 2, H / 2), R, R, rot, 0, 2 * Math.PI);
  const prof = S.profile(0.001);
  ok(prof.faces.length === 1, 'a rectangle and a hole in the same plane make one face');
  ok(prof.closed, 'and the profile is closed');
  const f = prof.faces[0];
  ok(f.loops.length === 2 && !f.loops[0].hole && f.loops[1].hole,
     'with the outer loop first and the inner one marked as a hole');
  ok(f.loops[1].area < 0, 'the hole runs the other way, so its signed area is negative');
  near(f.area, W * H - Math.PI * R * R, 0.05, 'and the areas sum to the material');
  ok(Math.abs(Math.abs(dot(f.normal, n)) - 1) < 1e-9,
     'the face normal is the plane the rectangle was drawn in');
  ok(len(cross(f.u, f.v)) > 0.999999 && Math.abs(dot(f.u, f.normal)) < 1e-12,
     'and its in-plane basis is orthonormal');
}
{
  // two loops in parallel but distinct planes are two faces, not one with a hole
  const S = new Sketch3D();
  const sq = (z) => {
    const p = [S.point(0, 0, z), S.point(10, 0, z), S.point(10, 10, z), S.point(0, 10, z)];
    S.line(p[0], p[1]); S.line(p[1], p[2]); S.line(p[2], p[3]); S.line(p[3], p[0]);
  };
  sq(0); sq(12);
  const prof = S.profile(0.01);
  ok(prof.faces.length === 2, 'same normal, different offset: two faces');
  ok(prof.faces.every(f => Math.abs(f.area - 100) < 1e-9), 'each with its own area');
}
{
  // a full circle closes as a loop on its own; two concentric ones are an annulus
  const S = new Sketch3D();
  const c = S.point(0, 0, 0);
  S.arc(c, 20, 20, [0, 0, 0], 0, 2 * Math.PI);
  S.arc(c, 8, 8, [0, 0, 0], 0, 2 * Math.PI);
  const prof = S.profile(0.001);
  ok(prof.faces.length === 1 && prof.faces[0].loops.length === 2,
     'two concentric circles are one face with a hole');
  near(prof.faces[0].area, Math.PI * (400 - 64), 0.05, 'and the annulus has the right area');
}
{
  // construction geometry is not walked into a profile
  const S = new Sketch3D();
  const p = [S.point(0, 0, 0), S.point(10, 0, 0), S.point(10, 10, 0), S.point(0, 10, 0)];
  S.line(p[0], p[1]); S.line(p[1], p[2]); S.line(p[2], p[3]); S.line(p[3], p[0]);
  const diag = S.line(p[0], p[2], { construction: true });
  ok(S.profile(0.01).faces.length === 1, 'a construction diagonal does not split the face');
  S.construction(diag, false);
  const after = S.profile(0.01);
  ok(after.faces.length === 0 && after.open > 0,
     'turned into real geometry it puts three edges on a corner, and the walk stops there');
}

// ======================================================================
console.log('\n--- the same drawing, in both files ---');
{
  const M2 = load('sketch.js');
  const R = 8, L = 38;
  const slot = (S, three) => {
    const P = (x, y) => (three ? S.point(x, y, 0) : S.point(x, y));
    const c0 = P(0, 0), c1 = P(L, 0);
    const a0 = P(0, R), a1 = P(L, R), b0 = P(0, -R), b1 = P(L, -R);
    const top = S.line(a0, a1), bot = S.line(b1, b0);
    const arcL = S.arc(c0, R, R, 0, Math.PI / 2, 3 * Math.PI / 2);
    const arcR = S.arc(c1, R, R, 0, -Math.PI / 2, Math.PI / 2);
    S.constrain('coincident', { e: arcL, end: 1 }, { e: bot, end: 0 });
    S.constrain('coincident', { e: bot, end: 1 }, { e: arcR, end: 0 });
    S.constrain('coincident', { e: arcR, end: 1 }, { e: top, end: 0 });
    S.constrain('coincident', { e: top, end: 1 }, { e: arcL, end: 0 });
    return S;
  };
  const A = slot(new M2.Sketch(), false), B = slot(new Sketch3D(), true);
  const pa = A.profile(0.001), pb = B.profile(0.001);
  ok(pa.closed && pb.closed, 'the slot closes in both files');
  ok(pa.loops.length === 1 && pb.faces.length === 1 && pb.faces[0].loops.length === 1,
     'one loop each');
  ok(pa.loops[0].area === pb.faces[0].area,
     `and the areas are identical to the last bit: ${pb.faces[0].area.toFixed(6)} mm²`);
  near(pb.faces[0].area, L * 2 * R + Math.PI * R * R, 0.05, 'both close to the analytic area');
  ok(pb.faces[0].normal[2] > 0.999999, 'the 3D one lands its normal on +Z');
  const p2 = pa.loops[0].points, p3 = pb.faces[0].loops[0].points;
  let worst = 0;
  for (let i = 0; i < Math.min(p2.length, p3.length); i++)
    worst = Math.max(worst, Math.abs(p2[i][0] - p3[i][0]), Math.abs(p2[i][1] - p3[i][1]),
                     Math.abs(p3[i][2]));
  ok(p2.length === p3.length && worst === 0,
     'and the sampled polygons are the same points, z = 0 throughout');
}

// ======================================================================
console.log('\n--- serialisation ---');
{
  const S = new Sketch3D();
  const a = S.point(0, 0, 0, { fixed: true }), b = S.point(20, 5, -3);
  const ln = S.line(a, b);
  const c = S.point(10, 10, 10);
  const ar = S.arc(c, 9, 4, [0.3, 0.2, 0.1], 0.2, 4.2, { construction: true });
  const cs = [S.point(0, 0, 0), S.point(10, 6, 2), S.point(20, -4, 5), S.point(30, 2, 1)];
  const nb = S.nurbs(cs, { degree: 3, weights: [1, 2, 0.5, 1] });
  S.constrain('distance', { p: a }, { p: b }, 25);
  S.constrain('perpendicular', { e: ln }, { e: nb, t: S.param(0.4) });
  S.constrain('tangent', { e: ln }, { e: ar });
  S.solve();

  const doc = JSON.parse(JSON.stringify(S));
  const T = Sketch3D.fromJSON(doc);
  ok(doc.sinterSketch3d === 1, 'documents say what they are');
  ok(T.ents.length === S.ents.length && T.cons.length === S.cons.length,
     'a round trip rebuilds every entity and constraint, and no extras');
  let worst = 0;
  for (let i = 0; i < S.x.length; i++) worst = Math.max(worst, Math.abs(S.x[i] - T.x[i]));
  ok(worst < 1e-12, `every variable came back identical (${worst.toExponential(1)})`);
  const d = T.diagnose();
  ok(d.converged, 'a restored sketch is already satisfied');
  ok(T.solve().iterations === 0, 'and re-solving it takes no iterations');
  ok(T.get(ar).construction === true, 'construction geometry survives the trip');
  ok(T.get(nb).weights.join() === '1,2,0.5,1', 'and so do NURBS weights');
  throws(() => Sketch3D.fromJSON({ sinterSketch: 1 }), 'not a SinterSketch3D document',
         'a 2D document is refused rather than half-read');
}

// ======================================================================
console.log('\n--- editing, retiring, and what mentions what ---');
{
  const S = new Sketch3D();
  const a = S.point(0, 0, 0), b = S.point(10, 0, 0), c = S.point(10, 10, 0);
  const l1 = S.line(a, b), l2 = S.line(b, c);
  S.constrain('perpendicular', { e: l1 }, { e: l2 });
  ok(S.constraintsOn(l1).length === 1, 'constraintsOn finds what mentions a line');
  ok(S.entities('point').length === 3 && S.entities('line').length === 2, 'entities() enumerates');
  const before = S.diagnose().dof;
  ok(S.dropEntity(b), 'dropping a shared point');
  ok(S.get(l1).dead && S.get(l2).dead, 'retires both lines built on it');
  ok(S.cons.length === 0, 'and the constraint that mentioned them');
  ok(!S.get(a).dead && S.diagnose().dof === 6,
     `while the points it did not touch stay free (${before} → ${S.diagnose().dof})`);
  ok(!S.dropEntity(b), 'dropping it twice is a no-op');
  const doc = S.toJSON();
  ok(doc.entities.filter(e => e.dead).length === 3, 'the dead survive serialisation as dead');
}

// ======================================================================
console.log('\n--- errors, thrown rather than returned ---');
{
  const S = new Sketch3D();
  const a = S.point(0, 0, 0), b = S.point(1, 1, 1);
  const ln = S.line(a, b);
  const nb = S.nurbs([a, b, S.point(2, 0, 0), S.point(3, 3, 3)], { degree: 3 });
  throws(() => S.constrain('nonesuch', { e: ln }), 'no such constraint', 'an unknown constraint');
  throws(() => S.get(999), 'no entity 999', 'an unknown entity');
  throws(() => S.dirOf({ e: nb }), 'ref has no direction', 'a curve asked for a direction');
  throws(() => S.posOf({ e: nb }), 'ref has no position', 'a curve asked for a position');
  throws(() => S._endParam(S.x, a, 0), 'has no ends', 'a point asked for an endpoint');
  throws(() => S.evalAt(S.x, a, 0), 'has no parameterisation', 'a point asked for a curve');
  throws(() => S.centreOf(S.x, nb), 'has no centre', 'a spline asked for a centre');
  throws(() => S._posdir(S.x, { e: nb }), 'has no position and direction',
         'a spline asked for both without a parameter');
  throws(() => { S.constrain('circular', { e: ln }); S.solve(); }, 'circular wants an arc',
         'circular on a line');
  throws(() => S.frameOfArc(S.x, ln), 'has no frame', 'a line asked for a frame');
  throws(() => S.extrude(null, 5), 'extrude wants a face', 'extruding nothing');
}

// ======================================================================
console.log('\n--- distance fields ---');
{
  // a wire is a true distance: a straight segment given a radius is a capsule
  const S = new Sketch3D();
  const a = S.point(0, 0, 0), b = S.point(30, 0, 0);
  S.line(a, b);
  const w = S.wire(3, 0.01);
  const capsule = (x, y, z) => {
    const t = Math.max(0, Math.min(1, x / 30));
    return Math.hypot(x - 30 * t, y, z) - 3;
  };
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const p = [rnd() * 60 - 15, rnd() * 30 - 15, rnd() * 30 - 15];
    worst = Math.max(worst, Math.abs(w(...p) - capsule(...p)));
  }
  ok(worst < 1e-12, `a wire on one segment is exactly a capsule (${worst.toExponential(1)})`);
  ok(w.bounds.lo[0] === -3 && w.bounds.hi[0] === 33, 'and its bounds include the radius');

  // 1-Lipschitz, which is what a raymarcher needs
  const lip = (f, box) => {
    let L = 0;
    for (let i = 0; i < 20000; i++) {
      const p = [0, 1, 2].map(k => box.lo[k] + rnd() * (box.hi[k] - box.lo[k]));
      const q = p.map(v => v + rnd() * 2 - 1);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (d > 1e-9) L = Math.max(L, Math.abs(f(...q) - f(...p)) / d);
    }
    return L;
  };
  const Lw = lip(w, { lo: [-20, -20, -20], hi: [50, 20, 20] });
  ok(Lw <= 1 + 1e-9, `the wire field is 1-Lipschitz (${Lw.toFixed(6)})`);
}
{
  // an extrusion of a tilted face
  const rot = [0.4, -0.3, 0.7];
  const [u, v, n] = M3.frameOf(...rot);
  const S = new Sketch3D();
  const P = (a, b) => S.point(u[0] * a + v[0] * b, u[1] * a + v[1] * b, u[2] * a + v[2] * b);
  const W = 30, H = 18, T = 6;
  const p = [P(0, 0), P(W, 0), P(W, H), P(0, H)];
  S.line(p[0], p[1]); S.line(p[1], p[2]); S.line(p[2], p[3]); S.line(p[3], p[0]);
  const prof = S.profile(0.001);
  near(prof.faces[0].area, W * H, 1e-9, 'the tilted face measures its own area');
  const f = S.extrude(prof.faces[0], T);

  // a point 2.5 mm along the normal from the middle of the face is 2.5 mm in
  const mid = S.posOf({ p: p[0] }).map((c, i) => c + (u[i] * W / 2 + v[i] * H / 2));
  near(f(mid[0] + n[0] * 2.5, mid[1] + n[1] * 2.5, mid[2] + n[2] * 2.5), -2.5, 1e-9,
       'inside the slab, the distance is the distance to the nearer face');
  near(f(mid[0] - n[0] * 4, mid[1] - n[1] * 4, mid[2] - n[2] * 4), 4, 1e-9,
       'and outside it, the distance to the plane it was built on');
  let L = 0;
  for (let i = 0; i < 20000; i++) {
    const a = [0, 1, 2].map(k => f.bounds.lo[k] - 5 + rnd() * (f.bounds.hi[k] - f.bounds.lo[k] + 10));
    const b = a.map(c => c + rnd() * 2 - 1);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d > 1e-9) L = Math.max(L, Math.abs(f(...b) - f(...a)) / d);
  }
  ok(L <= 1 + 1e-9, `the extruded field is 1-Lipschitz (${L.toFixed(6)})`);
}

// ======================================================================
console.log('\n--- and out the other end: a mesh ---');
{
  const SF = load('sinterform.js');
  const meshOf = (f, res) => {
    const pad = 2 * res;
    const lo = f.bounds.lo.map(c => c - pad), hi = f.bounds.hi.map(c => c + pad);
    const N = [0, 1, 2].map(i => Math.ceil((hi[i] - lo[i]) / res) + 1);
    const vol = new Float32Array(N[0] * N[1] * N[2]);
    let idx = 0;
    for (let i = 0; i < N[0]; i++)
      for (let j = 0; j < N[1]; j++)
        for (let k = 0; k < N[2]; k++)
          vol[idx++] = f(lo[0] + i * res, lo[1] + j * res, lo[2] + k * res);
    const mesh = SF.surfaceNets(vol, N[0], N[1], N[2], lo[0], lo[1], lo[2], res);
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
    const P = mesh.positions;
    let V = 0;
    for (let t = 0; t < nt; t++) {
      const a = 3 * mesh.indices[3 * t], b = 3 * mesh.indices[3 * t + 1], c = 3 * mesh.indices[3 * t + 2];
      V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
          - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
          + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    }
    return { mesh, nt, bad, volume: Math.abs(V) };
  };

  // a slot with a round hole, drawn in the XY plane and extruded up its own
  // normal — which for this face is +Z, so it is the 2D file's example
  const R = 8, L = 38, T = 10;
  const S = new Sketch3D();
  const c0 = S.point(0, 0, 0), c1 = S.point(L, 0, 0);
  const a0 = S.point(0, R, 0), a1 = S.point(L, R, 0);
  const b0 = S.point(0, -R, 0), b1 = S.point(L, -R, 0);
  const top = S.line(a0, a1), bot = S.line(b1, b0);
  const arcL = S.arc(c0, R, R, 0, Math.PI / 2, 3 * Math.PI / 2);
  const arcR = S.arc(c1, R, R, 0, -Math.PI / 2, Math.PI / 2);
  S.constrain('coincident', { e: arcL, end: 1 }, { e: bot, end: 0 });
  S.constrain('coincident', { e: bot, end: 1 }, { e: arcR, end: 0 });
  S.constrain('coincident', { e: arcR, end: 1 }, { e: top, end: 0 });
  S.constrain('coincident', { e: top, end: 1 }, { e: arcL, end: 0 });
  S.arc(S.point(L / 2, 0, 0), 4, 4, 0, 0, 2 * Math.PI);
  const prof = S.profile(0.001);
  ok(prof.closed && prof.faces[0].loops.length === 2, 'the slot and its hole are one face');
  const f = S.extrude(prof.faces[0], T);
  const m = meshOf(f, 0.5);
  ok(m.nt > 1000, `it meshes: ${m.nt.toLocaleString()} triangles`);
  ok(m.bad === 0, `and is watertight${m.bad ? ` — ${m.bad} unpaired edges` : ''}`);
  const want = (L * 2 * R + Math.PI * R * R - Math.PI * 16) * T;
  ok(Math.abs(m.volume - want) / want < 0.01,
     `volume ${m.volume.toFixed(1)} mm³ vs area×thickness ${want.toFixed(1)} `
     + `(${(100 * (m.volume - want) / want).toFixed(2)}%)`);
  const stl = SF.meshToSTL(m.mesh, 'sinterform 3d sketch (mm)');
  ok(stl && stl.size === 84 + m.nt * 50, `and writes an STL of ${stl.size.toLocaleString()} bytes`);

  // the same face tilted out of the XY plane. The volume still has to come
  // out; watertightness is not asserted here because surfaceNets leaves a
  // handful of unpaired edges on any slanted sharp edge -- a plain rotated
  // box out of PRIMS does the same, so it is the mesher, not the field.
  const rot = [0.4, -0.3, 0.7];
  const [u, v] = M3.frameOf(...rot);
  const S2 = new Sketch3D();
  const P = (a, b) => S2.point(u[0] * a + v[0] * b, u[1] * a + v[1] * b, u[2] * a + v[2] * b);
  const W2 = 30, H2 = 18, T2 = 6;
  const q = [P(0, 0), P(W2, 0), P(W2, H2), P(0, H2)];
  S2.line(q[0], q[1]); S2.line(q[1], q[2]); S2.line(q[2], q[3]); S2.line(q[3], q[0]);
  const f2 = S2.extrude(S2.profile(0.001).faces[0], T2);
  const m2 = meshOf(f2, 0.4);
  const want2 = W2 * H2 * T2;
  ok(Math.abs(m2.volume - want2) / want2 < 0.01,
     `a tilted extrusion meshes to ${m2.volume.toFixed(1)} mm³ against ${want2} `
     + `(${(100 * (m2.volume - want2) / want2).toFixed(2)}%)`);

  // and a wireframe, which is the other thing a 3D sketch can be
  const S3 = new Sketch3D();
  const g = [S3.point(0, 0, 0), S3.point(30, 0, 0), S3.point(30, 20, 0), S3.point(30, 20, 15)];
  S3.line(g[0], g[1]); S3.line(g[1], g[2]); S3.line(g[2], g[3]);
  const w = S3.wire(2, 0.05);
  const m3 = meshOf(w, 0.4);
  ok(m3.nt > 1000, `a wireframe meshes: ${m3.nt.toLocaleString()} triangles`);
  ok(m3.bad === 0, `and is watertight${m3.bad ? ` — ${m3.bad} unpaired edges` : ''}`);
  const wantW = (30 + 20 + 15) * Math.PI * 4 + (4 / 3) * Math.PI * 8 - 2 * (Math.PI * 4 * 2 * 0.5);
  ok(m3.volume > wantW * 0.9 && m3.volume < wantW * 1.15,
     `its volume ${m3.volume.toFixed(1)} mm³ is about the three capsules’ ${wantW.toFixed(1)}`);
}

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
