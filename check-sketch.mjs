/* Check the 2D sketcher.
 *
 *     node check-sketch.mjs
 *
 * Two things are being checked, and they fail in different ways.
 *
 * The constraints: each one has to be satisfied when the solve finishes, and
 * "satisfied" means measured independently here rather than by asking the
 * residual that was just minimised. A residual can be small because the
 * constraint is met or because it was written wrong and is small everywhere.
 *
 * The bookkeeping: degrees of freedom, rank, redundancy. A sketcher that
 * solves but miscounts is worse than one that does not solve, because the UI
 * built on it will tell people their sketch is fully constrained when it is
 * free to move.
 *
 * Exit code is 0 or 1, so it can be a CI step.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const mod = { exports: {} };
new Function('module', readFileSync(join(HERE, 'sketch.js'), 'utf8'))(mod);
const { Sketch } = mod.exports;

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};
const near = (got, want, tol, what) =>
  ok(Math.abs(got - want) < tol, `${what}: ${got.toFixed(6)} ≈ ${want}`);

const unit = (d) => { const l = Math.hypot(d[0], d[1]); return [d[0] / l, d[1] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];

// ======================================================================
console.log('\n--- the curves evaluate, before anything is constrained ---');
{
  const S = new Sketch();
  // a NURBS that is really a straight line: tangent must be constant
  const c = [S.point(0, 0), S.point(10, 0), S.point(20, 0), S.point(30, 0)];
  const nb = S.nurbs(c, { degree: 3 });
  const a = S.evalAt(S.x, nb, 0.25), b = S.evalAt(S.x, nb, 0.75);
  near(a.p[1], 0, 1e-9, 'a degenerate spline stays on its line');
  ok(Math.abs(cross(unit(a.d), unit(b.d))) < 1e-9,
     'and its tangent does not wander');
  near(S.evalAt(S.x, nb, 0).p[0], 0, 1e-9, 'clamped: it starts on the first control point');
  near(S.evalAt(S.x, nb, 1).p[0], 30, 1e-9, 'and ends on the last');

  // the tangent from dersBasisFuns must match a finite difference
  const c2 = [S.point(0, 0), S.point(5, 18), S.point(22, -6), S.point(30, 9)];
  const nb2 = S.nurbs(c2, { degree: 3 });
  let worst = 0;
  for (let t = 0.05; t < 0.95; t += 0.05) {
    const h = 1e-6;
    const p1 = S.evalAt(S.x, nb2, t + h).p, p0 = S.evalAt(S.x, nb2, t - h).p;
    const fd = [(p1[0] - p0[0]) / (2 * h), (p1[1] - p0[1]) / (2 * h)];
    const an = S.evalAt(S.x, nb2, t).d;
    worst = Math.max(worst, Math.hypot(fd[0] - an[0], fd[1] - an[1]) / Math.hypot(...an));
  }
  ok(worst < 1e-6, `analytic spline tangent matches finite differences (${worst.toExponential(1)})`);

  // an ellipse: point at t must satisfy its own equation
  const ce = S.point(3, -2);
  const ar = S.arc(ce, 12, 5, 0.6);
  let bad = 0;
  for (let t = 0; t < 6.2; t += 0.3) {
    const p = S.evalAt(S.x, ar, t).p;
    const dx = p[0] - 3, dy = p[1] + 2;
    const C = Math.cos(0.6), Sn = Math.sin(0.6);
    const u = (C * dx + Sn * dy) / 12, v = (-Sn * dx + C * dy) / 5;
    if (Math.abs(u * u + v * v - 1) > 1e-9) bad++;
  }
  ok(bad === 0, 'every sampled point of a rotated ellipse satisfies its equation');
}

// ======================================================================
console.log('\n--- perpendicular, across every pairing ---');
{
  // line to line
  const S = new Sketch();
  const a = S.point(0, 0, { fixed: true }), b = S.point(10, 0, { fixed: true });
  const c = S.point(3, 1), d = S.point(7, 9);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  S.constrain('perpendicular', { e: l1 }, { e: l2 });
  const r = S.solve();
  ok(r.converged, `line ⟂ line converged in ${r.iterations} iterations`);
  near(dot(unit(S._dir(S.x, { e: l1 })), unit(S._dir(S.x, { e: l2 }))), 0, 1e-7,
       'their directions are orthogonal');
}
{
  // line to the tangent of an arc, at a contact point the solver picks
  const S = new Sketch();
  const ctr = S.point(0, 0, { fixed: true });
  const ar = S.arc(ctr, 20, 20, 0, 0, 2 * Math.PI);
  S.fix(ar);
  const p0 = S.point(30, -25), p1 = S.point(35, 25);
  const ln = S.line(p0, p1);
  const t = S.param(0.3);
  S.constrain('perpendicular', { e: ln }, { e: ar, t });
  const r = S.solve();
  ok(r.converged, `line ⟂ arc-tangent converged in ${r.iterations} iterations`);
  const dl = unit(S._dir(S.x, { e: ln })), da = unit(S._dir(S.x, { e: ar, t }));
  near(dot(dl, da), 0, 1e-7, 'the line is square to the tangent at the contact');
  // a line perpendicular to a circle's tangent is parallel to its radius —
  // an independent way of saying the same thing, so worth checking
  const cp = S.evalAt(S.x, ar, S.x[S.ents[t].v]).p;
  near(Math.abs(cross(unit(cp), dl)), 0, 1e-6,
       'and therefore runs along the radius');
}
{
  // line to the tangent of a NURBS — the case CAD tends not to offer
  const S = new Sketch();
  const cs = [S.point(0, 0), S.point(10, 22), S.point(26, -8), S.point(40, 12)];
  cs.forEach(p => S.fix(p));
  const nb = S.nurbs(cs, { degree: 3 });
  const q0 = S.point(20, -20), q1 = S.point(25, 20);
  const ln = S.line(q0, q1);
  const t = S.param(0.5);
  S.constrain('perpendicular', { e: ln }, { e: nb, t });
  const r = S.solve();
  ok(r.converged, `line ⟂ spline-tangent converged in ${r.iterations} iterations`);
  near(dot(unit(S._dir(S.x, { e: ln })), unit(S._dir(S.x, { e: nb, t }))), 0, 1e-7,
       'the line is square to the spline tangent');
}
{
  // spline tangent to spline tangent, which is the same three lines of code
  const S = new Sketch();
  const A = [S.point(0, 0), S.point(8, 16), S.point(24, -4), S.point(36, 10)];
  A.forEach(p => S.fix(p));
  const B = [S.point(0, 30), S.point(12, 40), S.point(28, 24), S.point(38, 34)];
  const na = S.nurbs(A, { degree: 3 }), nb = S.nurbs(B, { degree: 3 });
  const ta = S.param(0.4), tb = S.param(0.6);
  S.constrain('perpendicular', { e: na, t: ta }, { e: nb, t: tb });
  const r = S.solve();
  ok(r.converged, `spline ⟂ spline converged in ${r.iterations} iterations`);
  near(dot(unit(S._dir(S.x, { e: na, t: ta })), unit(S._dir(S.x, { e: nb, t: tb }))),
       0, 1e-7, 'two spline tangents, orthogonal');
}

// ======================================================================
console.log('\n--- the rest of the vocabulary ---');
{
  const S = new Sketch();
  const a = S.point(0, 0, { fixed: true }), b = S.point(10, 3);
  const c = S.point(40, 5), d = S.point(60, 30);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  S.constrain('parallel', { e: l1 }, { e: l2 });
  const r = S.solve();
  ok(r.converged, 'parallel converged');
  near(cross(unit(S._dir(S.x, { e: l1 })), unit(S._dir(S.x, { e: l2 }))), 0, 1e-7,
       'directions are parallel');
}
{
  const S = new Sketch();
  const a = S.point(0, 0, { fixed: true }), b = S.point(20, 0, { fixed: true });
  const c = S.point(35, 12), d = S.point(60, 20);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  S.constrain('collinear', { e: l1 }, { e: l2 });
  const r = S.solve();
  ok(r.converged, 'collinear converged');
  const P = S.ptOf(S.x, c), Q = S.ptOf(S.x, d);
  ok(Math.abs(P[1]) < 1e-7 && Math.abs(Q[1]) < 1e-7,
     `both endpoints landed on y = 0 (${P[1].toExponential(1)}, ${Q[1].toExponential(1)})`);
}
{
  const S = new Sketch();
  const c1 = S.point(0, 0, { fixed: true }), c2 = S.point(14, -9);
  const a1 = S.arc(c1, 10, 10), a2 = S.arc(c2, 4, 4);
  S.constrain('concentric', { e: a1 }, { e: a2 });
  const r = S.solve();
  ok(r.converged, 'concentric converged');
  const p = S.ptOf(S.x, c2);
  ok(Math.hypot(p[0], p[1]) < 1e-7, 'the second centre moved onto the first');
}
{
  const S = new Sketch();
  const a = S.point(-10, 4, { fixed: true }), b = S.point(10, 4, { fixed: true });
  const ln = S.line(a, b);
  const m = S.point(3, 9);
  S.constrain('centre', { p: m }, { e: ln });
  const r = S.solve();
  ok(r.converged, 'centre converged');
  const p = S.ptOf(S.x, m);
  ok(Math.hypot(p[0] - 0, p[1] - 4) < 1e-7,
     `the point sits at the line's midpoint (${p[0].toFixed(4)}, ${p[1].toFixed(4)})`);
}
{
  const S = new Sketch();
  const a = S.point(0, 0, { fixed: true }), b = S.point(12, 0, { fixed: true });
  const c = S.point(0, 20, { fixed: true }), d = S.point(0, 26);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  S.constrain('equal', { e: l1 }, { e: l2 });
  const r = S.solve();
  ok(r.converged, 'equal (lines) converged');
  const P = S.ptOf(S.x, c), Q = S.ptOf(S.x, d);
  near(Math.hypot(Q[0] - P[0], Q[1] - P[1]), 12, 1e-7, 'the second line matched length');
}
{
  const S = new Sketch();
  const c1 = S.point(0, 0, { fixed: true }), c2 = S.point(40, 0, { fixed: true });
  const a1 = S.arc(c1, 9, 5, 0); S.fix(a1);
  const a2 = S.arc(c2, 3, 2, 0);
  S.constrain('equal', { e: a1 }, { e: a2 });
  const r = S.solve();
  ok(r.converged, 'equal (arcs) converged');
  const e2 = S.ents[a2];
  ok(Math.abs(S.x[e2.vrx] - 9) < 1e-7 && Math.abs(S.x[e2.vry] - 5) < 1e-7,
     `both semi-axes matched (${S.x[e2.vrx].toFixed(4)}, ${S.x[e2.vry].toFixed(4)})`);
}
{
  const S = new Sketch();
  const a = S.point(0, 0, { fixed: true }), b = S.point(9, 2);
  const c = S.point(20, 20);
  const l1 = S.line(a, b), l2 = S.line(b, c);
  S.constrain('coincident', { p: b }, { p: b });   // trivially true
  S.constrain('perpendicular', { e: l1 }, { e: l2 });
  S.constrain('distance', { p: a }, { p: b }, 15);
  const r = S.solve();
  ok(r.converged, 'coincident + perpendicular + distance converged');
  const B = S.ptOf(S.x, b);
  near(Math.hypot(B[0], B[1]), 15, 1e-7, 'the dimension took');
}

// ======================================================================
console.log('\n--- tangency introduces its own contact points ---');
{
  // a line tangent to a circle: the distance from centre to line must be r
  const S = new Sketch();
  const ctr = S.point(0, 0, { fixed: true });
  const ar = S.arc(ctr, 15, 15); S.fix(ar);
  const p0 = S.point(-40, 22), p1 = S.point(40, 26);
  const ln = S.line(p0, p1);
  S.constrain('horizontal', { e: ln });
  const c = S.constrain('tangent', { e: ln }, { e: ar });
  const r = S.solve();
  ok(r.converged, `line tangent to circle converged in ${r.iterations} iterations`);
  const P = S.ptOf(S.x, p0), Q = S.ptOf(S.x, p1);
  const d = unit([Q[0] - P[0], Q[1] - P[1]]);
  const perpDist = Math.abs(cross(d, [-P[0], -P[1]]));
  near(perpDist, 15, 1e-6, 'the line stands off the centre by exactly the radius');
  ok(c.a.t !== undefined && c.b.t !== undefined,
     'tangency created the two contact parameters it needed');
}
{
  // two circles, externally tangent: centres end up r1 + r2 apart
  const S = new Sketch();
  const c1 = S.point(0, 0, { fixed: true }), c2 = S.point(40, 6);
  const a1 = S.arc(c1, 12, 12); S.fix(a1);
  const a2 = S.arc(c2, 7, 7);
  S.fix(S.ents[a2].c, false);
  const e2 = S.ents[a2];
  S.fixed[e2.vrx] = S.fixed[e2.vry] = true;
  S.constrain('horizontal', { e: S.line(c1, c2) });
  S.constrain('tangent', { e: a1 }, { e: a2 });
  const r = S.solve();
  ok(r.converged, `circle tangent to circle converged in ${r.iterations} iterations`);
  const p = S.ptOf(S.x, c2);
  const sep = Math.hypot(p[0], p[1]);
  near(sep, 19, 1e-5, 'centres are r1 + r2 apart — the outside solution');
}
{
  // Tangency is two-valued, and which value comes back is decided by where
  // the contact parameters start. Three circles told to touch each other
  // used to converge to three nested circles from any layout, because every
  // contact began at its curve's rightmost point. This is that regression.
  const want = { d12: 21, d23: 16, d13: 19 };   // outside: r_i + r_j
  let allOutside = true;
  for (const start of [[[30, 2], [15, 26]], [[25, 0], [12, 20]], [[40, 5], [20, 35]]]) {
    const S = new Sketch();
    const c1 = S.point(0, 0, { fixed: true });
    const c2 = S.point(start[0][0], start[0][1]), c3 = S.point(start[1][0], start[1][1]);
    const A = S.arc(c1, 12, 12), B = S.arc(c2, 9, 9), C = S.arc(c3, 7, 7);
    [A, B, C].forEach(a => S.constrain('circular', { e: a }));
    S.constrain('radius', { e: A }, undefined, 12);
    S.constrain('radius', { e: B }, undefined, 9);
    S.constrain('radius', { e: C }, undefined, 7);
    S.constrain('horizontal', { e: S.line(c1, c2) });
    S.constrain('tangent', { e: A }, { e: B });
    S.constrain('tangent', { e: B }, { e: C });
    S.constrain('tangent', { e: C }, { e: A });
    const r = S.solve({ maxIter: 400 });
    const p2 = S.ptOf(S.x, c2), p3 = S.ptOf(S.x, c3);
    const d12 = Math.hypot(p2[0], p2[1]);
    const d23 = Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
    const d13 = Math.hypot(p3[0], p3[1]);
    if (!r.converged || Math.abs(d12 - want.d12) > 1e-4
        || Math.abs(d23 - want.d23) > 1e-4 || Math.abs(d13 - want.d13) > 1e-4)
      allOutside = false;
  }
  ok(allOutside, 'three mutually tangent circles land outside each other, '
    + 'from every starting layout');
}

// ======================================================================
console.log('\n--- the bookkeeping ---');
{
  // a free line: 4 variables, nothing said about them
  const S = new Sketch();
  const a = S.point(0, 0), b = S.point(10, 0);
  S.line(a, b);
  const r = S.solve();
  ok(r.dof === 4, `an unconstrained line has ${r.dof} degrees of freedom (want 4)`);
}
{
  // pin one end, make it horizontal and 20 long: 1 left (which end it points)
  const S = new Sketch();
  const a = S.point(0, 0, { fixed: true }), b = S.point(7, 3);
  const ln = S.line(a, b);
  S.constrain('horizontal', { e: ln });
  S.constrain('distance', { p: a }, { p: b }, 20);
  const r = S.solve();
  ok(r.converged && r.dof === 0,
     `pinned, horizontal, dimensioned → dof ${r.dof}, rank ${r.rank}/${r.equations}`);
  near(Math.abs(S.ptOf(S.x, b)[0]), 20, 1e-7, 'and it is 20 long');
}
{
  // saying the same thing twice must be reported, not silently absorbed
  const S = new Sketch();
  const a = S.point(0, 0, { fixed: true }), b = S.point(10, 1);
  const c = S.point(0, 20, { fixed: true }), d = S.point(10, 21);
  const l1 = S.line(a, b), l2 = S.line(c, d);
  S.constrain('parallel', { e: l1 }, { e: l2 });
  S.constrain('parallel', { e: l2 }, { e: l1 });   // the same statement
  const r = S.solve();
  ok(r.converged, 'a duplicated constraint still solves');
  ok(r.redundant === 1,
     `and is reported redundant (${r.redundant} of ${r.equations} equations)`);
}
{
  // two statements that cannot both hold
  const S = new Sketch();
  const a = S.point(0, 0, { fixed: true }), b = S.point(10, 0);
  const ln = S.line(a, b);
  S.constrain('horizontal', { e: ln });
  S.constrain('vertical', { e: ln });
  const r = S.solve();
  ok(!r.converged && r.conflicting,
     `horizontal AND vertical is flagged conflicting (residual ${r.residual.toFixed(3)})`);
}

// ======================================================================
console.log('\n--- a whole sketch, of the kind someone would actually draw ---');
{
  // slot: two parallel sides, semicircular ends, tangent throughout
  const S = new Sketch();
  const c1 = S.point(0, 0, { fixed: true }), c2 = S.point(38, 4);
  const a1 = S.arc(c1, 8, 8, 0, Math.PI / 2, 3 * Math.PI / 2);
  const a2 = S.arc(c2, 6, 6, 0, -Math.PI / 2, Math.PI / 2);
  const t1 = S.point(0, 8), t2 = S.point(38, 10);
  const top = S.line(t1, t2);
  S.constrain('circular', { e: a1 });
  S.constrain('circular', { e: a2 });
  S.constrain('equal', { e: a1 }, { e: a2 });
  S.constrain('horizontal', { e: S.line(c1, c2) });
  S.constrain('distance', { p: c1 }, { p: c2 }, 38);
  S.constrain('radius', { e: a1 }, undefined, 8);
  S.constrain('tangent', { e: top }, { e: a1 });
  S.constrain('tangent', { e: top }, { e: a2 });
  const r = S.solve({ maxIter: 400 });
  ok(r.converged, `a slot outline converged in ${r.iterations} iterations `
    + `(${r.equations} equations, ${r.variables} variables, dof ${r.dof})`);
  const C2 = S.ptOf(S.x, c2);
  near(Math.hypot(C2[0] - 0, C2[1] - 0), 38, 1e-5, 'the centres are 38 apart');
  near(S.x[S.ents[a2].vrx], 8, 1e-5, 'the ends came out equal');
  // the tangent line must stand off both centres by the radius
  const P = S.ptOf(S.x, t1), Q = S.ptOf(S.x, t2);
  const d = unit([Q[0] - P[0], Q[1] - P[1]]);
  near(Math.abs(cross(d, [0 - P[0], 0 - P[1]])), 8, 1e-5, 'and clears the first end by 8');
  near(Math.abs(cross(d, [C2[0] - P[0], C2[1] - P[1]])), 8, 1e-5, 'and the second by 8');
}

// ======================================================================
console.log('\n--- sampling ---');
{
  const S = new Sketch();
  const c = S.point(0, 0);
  const ar = S.arc(c, 25, 25, 0, 0, 2 * Math.PI);
  for (const tol of [0.5, 0.05, 0.005]) {
    const pts = S.sample(ar, tol);
    let worst = 0;
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2, my = (pts[i - 1][1] + pts[i][1]) / 2;
      worst = Math.max(worst, 25 - Math.hypot(mx, my));   // sagitta
    }
    ok(worst <= tol * 1.05,
       `sampled at tol ${tol}: ${pts.length} points, worst sag ${worst.toFixed(5)} mm`);
  }
}

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
