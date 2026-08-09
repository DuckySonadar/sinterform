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

// ======================================================================
console.log('\n--- the public surface: nothing here reaches into S.x ---');
{
  const S = new Sketch();
  const c = S.point(2, -3);
  const ar = S.arc(c, 12, 7, 0.4, 0, Math.PI);
  const g = S.get(ar);
  ok(g.kind === 'arc' && g.rx === 12 && g.ry === 7 && Math.abs(g.phi - 0.4) < 1e-12,
     'get() returns an arc without anyone knowing the variable layout');
  ok(g.centre[0] === 2 && g.centre[1] === -3, 'and resolves its centre');
  ok(g.circular === false, 'and says whether it is a circle');
  S.set(ar, { ry: 12 });
  ok(S.get(ar).circular === true, 'set() writes back, and the snapshot follows');

  const p = S.get(c);
  ok(p.x === 2 && p.y === -3 && p.fixed === false, 'points read back too');
  S.set(c, { x: 40, fixed: true });
  const p2 = S.get(c);
  ok(p2.x === 40 && p2.fixed === true, 'and take a position and a pin');

  // a snapshot must be safe to hand straight back
  const snap = S.get(ar);
  snap.rx = 5;
  ok(S.get(ar).rx === 12, 'snapshots are copies, not windows into the sketch');
  S.set(ar, snap);
  ok(S.get(ar).rx === 5, 'and can be handed back');
}
{
  const S = new Sketch();
  const a = S.point(0, 0), b = S.point(10, 0);
  const ln = S.line(a, b);
  const t = S.tangentAt(ln, 0.5), nrm = S.normalAt(ln, 0.5);
  near(Math.hypot(t[0], t[1]), 1, 1e-12, 'tangentAt is a unit vector');
  near(dot(t, nrm), 0, 1e-12, 'and normalAt is square to it');
  near(Math.hypot(nrm[0], nrm[1]), 1, 1e-12, 'and is a unit vector too');
  const d = S.dirOf({ e: ln }), P = S.posOf({ p: a });
  ok(d[0] === 10 && d[1] === 0 && P[0] === 0, 'dirOf and posOf resolve refs');
}
{
  const S = new Sketch();
  const a = S.point(0, 0, { fixed: true }), b = S.point(9, 2);
  const ln = S.line(a, b);
  const c1 = S.constrain('horizontal', { e: ln });
  const c2 = S.constrain('distance', { p: a }, { p: b }, 20);
  ok(S.constraints().length === 2, 'constraints() lists them');
  ok(S.constraints()[0].id !== S.constraints()[1].id, 'each has its own id');
  ok(S.constraintsOn(b).length === 1,
     `constraintsOn() finds what mentions a point (${S.constraintsOn(b).length})`);
  ok(S.dropConstraint(c1) && S.constraints().length === 1, 'dropConstraint removes one');
  ok(!S.dropConstraint(c1), 'and says so when there is nothing to remove');
  void c2;
}
{
  // diagnose must agree with solve, without having moved anything
  const S = new Sketch();
  const a = S.point(0, 0, { fixed: true }), b = S.point(7, 3);
  const ln = S.line(a, b);
  S.constrain('horizontal', { e: ln });
  S.constrain('distance', { p: a }, { p: b }, 20);
  const before = S.get(b);
  const d = S.diagnose();
  const after = S.get(b);
  ok(after.x === before.x && after.y === before.y, 'diagnose() moves nothing');
  ok(d.dof === 0 && d.equations === 2 && d.rank === 2,
     `and reports the same shape as a solve (dof ${d.dof}, rank ${d.rank})`);
  ok(!d.converged, 'and knows the sketch does not hold yet');
  const r = S.solve();
  ok(r.converged && r.dof === d.dof, 'the solve agrees on the count');
}
{
  // dropping an entity takes its dependants and its constraints with it
  const S = new Sketch();
  const a = S.point(0, 0), b = S.point(10, 0), c = S.point(10, 10);
  const l1 = S.line(a, b), l2 = S.line(b, c);
  S.constrain('perpendicular', { e: l1 }, { e: l2 });
  ok(S.entities().length === 5, 'five entities to start');
  S.dropEntity(b);
  ok(S.get(b).dead === true, 'the point is retired');
  ok(S.get(l1).dead === true && S.get(l2).dead === true,
     'and both lines that used it went with it');
  ok(S.constraints().length === 0, 'and the constraint between them is gone');
  ok(S.entities().length === 2, `entities() hides the dead (${S.entities().length} left)`);
  ok(S.diagnose().dof === 4, 'and the retired variables leave the dof count');
}

// ======================================================================
console.log('\n--- a document survives a round trip ---');
{
  const S = new Sketch();
  const c1 = S.point(0, 0, { fixed: true }), c2 = S.point(38, 4);
  const a1 = S.arc(c1, 8, 8, 0, Math.PI / 2, 3 * Math.PI / 2);
  const a2 = S.arc(c2, 6, 6, 0, -Math.PI / 2, Math.PI / 2);
  const t1 = S.point(0, 8), t2 = S.point(38, 10);
  const top = S.line(t1, t2);
  const cs = [S.point(60, 0), S.point(70, 20), S.point(88, -6), S.point(100, 10)];
  const nb = S.nurbs(cs, { degree: 3, weights: [1, 2, 1, 1.5] });
  S.constrain('circular', { e: a1 });
  S.constrain('circular', { e: a2 });
  S.constrain('equal', { e: a1 }, { e: a2 });
  S.constrain('radius', { e: a1 }, undefined, 8);
  S.constrain('distance', { p: c1 }, { p: c2 }, 38);
  S.constrain('horizontal', { e: S.line(c1, c2) });
  S.constrain('tangent', { e: top }, { e: a1 });
  S.constrain('tangent', { e: top }, { e: a2 });
  const r1 = S.solve({ maxIter: 400 });

  const doc = JSON.parse(JSON.stringify(S.toJSON()));
  const T = Sketch.fromJSON(doc);

  ok(T.ents.length === S.ents.length,
     `same entity count, so ids still mean the same thing (${T.ents.length})`);
  ok(T.constraints().length === S.constraints().length,
     'same constraint count — tangency did not mint a second set of parameters');

  let worst = 0;
  for (const e of S.ents) {
    if (e.k !== 'point') continue;
    const A = S.get(e.id), B = T.get(e.id);
    worst = Math.max(worst, Math.abs(A.x - B.x), Math.abs(A.y - B.y));
  }
  near(worst, 0, 1e-12, 'every point came back where it was');

  const d = T.diagnose();
  ok(d.converged, 'the restored sketch is already satisfied — no re-solve needed');
  ok(d.dof === r1.dof && d.rank === r1.rank,
     `and has the same dof and rank (${d.dof}, ${d.rank})`);

  // the spline has to survive weights, degree and its domain
  const gs = S.get(nb), gt = T.get(nb);
  ok(JSON.stringify(gs.weights) === JSON.stringify(gt.weights)
     && gs.degree === gt.degree && gs.closed === gt.closed,
     'the spline kept its weights, degree and closedness');
  let sw = 0;
  for (let u = 0; u <= 1.0001; u += 0.05) {
    const p = S.evalAt(S.x, nb, Math.min(u, 1)), q = T.evalAt(T.x, nb, Math.min(u, 1));
    sw = Math.max(sw, Math.hypot(p.p[0] - q.p[0], p.p[1] - q.p[1]));
  }
  near(sw, 0, 1e-12, 'and traces the identical curve');

  // and solving the restored one changes nothing
  const r2 = T.solve({ maxIter: 400 });
  ok(r2.converged && r2.iterations === 0,
     `re-solving a restored sketch is a no-op (${r2.iterations} iterations)`);
}
{
  const S = new Sketch();
  S.point(0, 0);
  ok(S.toJSON().sinterSketch === 1, 'documents carry a version');
  let threw = false;
  try { Sketch.fromJSON({ entities: [], constraints: [] }); } catch { threw = true; }
  ok(threw, 'and an unversioned one is refused rather than half-read');
}

// ======================================================================
console.log('\n--- profiles: a solved sketch is not yet something you can extrude ---');

// A closed slot, built the way a profile has to be built: ends constrained
// together, and tangency stated AT those shared ends rather than at contact
// points the solver invents.
function slot(R, L) {
  const S = new Sketch();
  const c1 = S.point(0, 0, { fixed: true }), c2 = S.point(L, 0, { fixed: true });
  const a1 = S.arc(c1, R, R, 0, Math.PI / 2, 3 * Math.PI / 2);
  const a2 = S.arc(c2, R, R, 0, -Math.PI / 2, Math.PI / 2);
  const p4 = S.point(1, -R + 1), p3 = S.point(L - 1, -R - 1);
  const p2 = S.point(L + 1, R + 1), p1 = S.point(-1, R - 1);
  const bot = S.line(p4, p3), top = S.line(p2, p1);
  S.constrain('circular', { e: a1 }); S.constrain('circular', { e: a2 });
  S.constrain('radius', { e: a1 }, undefined, R);
  S.constrain('radius', { e: a2 }, undefined, R);
  S.constrain('coincident', { e: a1, end: 1 }, { e: bot, end: 0 });
  S.constrain('coincident', { e: bot, end: 1 }, { e: a2, end: 0 });
  S.constrain('coincident', { e: a2, end: 1 }, { e: top, end: 0 });
  S.constrain('coincident', { e: top, end: 1 }, { e: a1, end: 0 });
  S.constrain('parallel', { e: a1, end: 1 }, { e: bot });
  S.constrain('parallel', { e: bot, end: 1 }, { e: a2, end: 0 });
  S.constrain('parallel', { e: a2, end: 1 }, { e: top });
  S.constrain('parallel', { e: top, end: 1 }, { e: a1, end: 0 });
  return { S, r: S.solve({ maxIter: 600 }), ids: { a1, a2, top, bot } };
}
{
  const R = 8, L = 38;
  const { S, r } = slot(R, L);
  ok(r.converged, `the slot solves (${r.equations} equations, ${r.variables} variables)`);
  const prof = S.profile(0.005);
  ok(prof.closed && prof.loops.length === 1 && prof.open === 0,
     `one closed loop, nothing left dangling (${prof.loops.length} loops, ${prof.open} open)`);
  ok(prof.loops[0].entities.length === 4, 'walked through all four curves');

  // area must converge on the analytic stadium, and do it linearly in tol —
  // which is what says the sampling is a chord approximation and not a bug
  const want = L * 2 * R + Math.PI * R * R;
  const errs = [0.02, 0.005, 0.001].map(t => Math.abs(Math.abs(S.profile(t).loops[0].area) - want));
  ok(errs[0] > errs[1] && errs[1] > errs[2],
     `area converges as the sampling refines (${errs.map(e => e.toExponential(1)).join(' → ')})`);
  ok(errs[2] < 0.05, `and reaches the analytic stadium ${want.toFixed(3)} mm² (err ${errs[2].toExponential(1)})`);

  // and the loop must come back anticlockwise, or every hole test is inverted
  ok(prof.loops[0].area > 0, 'the outer loop is oriented anticlockwise');
}
{
  const R = 8, L = 38;
  const { S } = slot(R, L);
  const f = S.sdf2d(0.001);
  near(f(L / 2, 0), -R, 0.01, 'the middle of the slot is one radius deep');
  near(f(0, 0), -R, 0.01, 'so is the centre of an end cap');
  near(f(L / 2, 20), 20 - R, 0.01, 'a point above it is outside by the right amount');
  near(f(-R - 5, 0), 5, 0.01, 'and one beyond the cap too');
  near(f(L / 2, R), 0, 0.01, 'the flank is the zero level set');

  // it feeds a raymarcher, so it has to be 1-Lipschitz
  let worst = 0;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 20000; i++) {
    const ax = rnd() * 100 - 30, ay = rnd() * 80 - 40;
    const bx = ax + rnd() * 8 - 4, by = ay + rnd() * 8 - 4;
    const d = Math.hypot(bx - ax, by - ay);
    if (d < 1e-9) continue;
    worst = Math.max(worst, Math.abs(f(bx, by) - f(ax, ay)) / d);
  }
  ok(worst <= 1.002, `the 2D field is 1-Lipschitz (worst ${worst.toFixed(4)})`);
}
{
  // a hole: two concentric full circles. A full circle's two ends are the
  // same point, so it closes as a loop on its own.
  const S = new Sketch();
  const c = S.point(0, 0, { fixed: true });
  const outer = S.arc(c, 20, 20, 0, 0, 2 * Math.PI);
  const inner = S.arc(c, 8, 8, 0, 0, 2 * Math.PI);
  S.fix(outer); S.fix(inner);
  const prof = S.profile(0.002);
  ok(prof.closed && prof.loops.length === 2,
     `an annulus reads as two closed loops (${prof.loops.length})`);
  ok(Math.abs(prof.loops[0].area) > Math.abs(prof.loops[1].area),
     'biggest loop first, so the outer boundary is loop 0');
  const f = S.sdf2d(0.002);
  ok(f(14, 0) < 0, 'the ring is solid');
  ok(f(0, 0) > 0, 'the hole is not');
  near(f(0, 0), 8, 0.01, 'and the middle of the hole is 8 mm from material');
  near(f(14, 0), -6, 0.01, 'the ring is deepest midway between the two radii');
  near(Math.abs(prof.loops[0].area) - Math.abs(prof.loops[1].area),
       Math.PI * (400 - 64), 0.5, 'outer minus inner is the annulus area');
  void inner;
}
{
  // an unfinished profile has to say so rather than quietly extrude wrong
  const S = new Sketch();
  const a = S.point(0, 0), b = S.point(20, 0), c = S.point(20, 15);
  S.line(a, b); S.line(b, c);
  const prof = S.profile();
  ok(!prof.closed && prof.open === 1 && prof.loops.length === 0,
     `two joined lines are an open chain, not a profile (open ${prof.open})`);
}

{
  // construction geometry constrains without being part of the drawing
  const S = new Sketch();
  const c = S.point(0, 0, { fixed: true });
  S.fix(S.arc(c, 20, 20, 0, 0, 2 * Math.PI));
  const a = S.point(-40, 0), b = S.point(40, 0);
  const axis = S.line(a, b, { construction: true });
  ok(S.get(axis).construction === true, 'a line can be marked construction');
  const prof = S.profile(0.01);
  ok(prof.closed && prof.loops.length === 1,
     `and is not walked into a loop (${prof.loops.length} loop, not 2)`);
  const S2 = Sketch.fromJSON(JSON.parse(JSON.stringify(S.toJSON())));
  ok(S2.get(axis).construction === true, 'and the flag survives a round trip');
  ok(S2.profile(0.01).loops.length === 1, 'so the restored profile matches');
  S.construction(axis, false);
  ok(S.profile(0.01).open === 1,
     'clearing the flag lets the line back in — as an open chain');
}
{
  // an ellipse has two semi-axes and both must be dimensionable
  const S = new Sketch();
  const c = S.point(0, 0, { fixed: true });
  const e = S.arc(c, 5, 5, 0, 0, 2 * Math.PI);
  S.constrain('radius', { e }, undefined, 14);
  S.constrain('radiusY', { e }, undefined, 6);
  const r = S.solve();
  ok(r.converged, 'radius and radiusY solve together');
  const g = S.get(e);
  ok(Math.abs(g.rx - 14) < 1e-9 && Math.abs(g.ry - 6) < 1e-9,
     `both semi-axes took (${g.rx.toFixed(3)}, ${g.ry.toFixed(3)})`);
  ok(g.circular === false, 'and it knows it is not a circle');
}
{
  // holes must come back clockwise, so the signed areas sum to the material
  const S = new Sketch();
  const c = S.point(0, 0, { fixed: true });
  const c2 = S.point(13, 0, { fixed: true });   // clear of the other hole
  S.fix(S.arc(c, 20, 20, 0, 0, 2 * Math.PI));       // outer
  S.fix(S.arc(c, 8, 8, 0, 0, 2 * Math.PI));         // hole
  S.fix(S.arc(c2, 3, 3, 0, 0, 2 * Math.PI));        // another hole
  const prof = S.profile(0.001);
  ok(prof.loops.length === 3, 'three loops');
  ok(prof.loops[0].area > 0 && !prof.loops[0].hole, 'the outer runs anticlockwise');
  ok(prof.loops[1].area < 0 && prof.loops[1].hole
     && prof.loops[2].area < 0 && prof.loops[2].hole,
     'and both holes run clockwise');
  const net = prof.loops.reduce((s, l) => s + l.area, 0);
  near(net, Math.PI * (400 - 64 - 9), 0.2, 'so the signed areas sum to the material');
  // and the sign convention has to agree with what the field says is solid
  const f = S.sdf2d(0.001);
  ok(f(9, 0) < 0 && f(0, 0) > 0 && f(13, 0) > 0,
     'the field agrees with the orientation about what is solid');
}

// ======================================================================
console.log('\n--- and the whole way through to a solid ---');
{
  // sketch → profile → 2D field → extrude → mesh, using the SDF kernel's own
  // mesher. This is the join between the two modules, so it is the one that
  // proves they compose.
  const k = { exports: {} };
  new Function('module', readFileSync(join(HERE, 'sinterform.js'), 'utf8'))(k);
  const SF = k.exports;

  const R = 8, L = 38, H = 10;
  const { S } = slot(R, L);
  const f = S.sdf2d(0.001);
  // an extrusion is exact: the 2D distance against the slab, whichever is
  // nearer, and the corner handled by the usual min(max) form
  const solid = (x, y, z) => {
    const w = [f(x, y), Math.abs(z) - H / 2];
    return Math.min(Math.max(w[0], w[1]), 0) + Math.hypot(Math.max(w[0], 0), Math.max(w[1], 0));
  };

  const res = 0.5, pad = 2 * res;
  const lo = [-R - pad, -R - pad, -H / 2 - pad];
  const hi = [L + R + pad, R + pad, H / 2 + pad];
  const n = [0, 1, 2].map(i => Math.ceil((hi[i] - lo[i]) / res) + 1);
  const vol = new Float32Array(n[0] * n[1] * n[2]);
  let idx = 0;
  for (let i = 0; i < n[0]; i++)
    for (let j = 0; j < n[1]; j++)
      for (let kk = 0; kk < n[2]; kk++)
        vol[idx++] = solid(lo[0] + i * res, lo[1] + j * res, lo[2] + kk * res);
  const mesh = SF.surfaceNets(vol, n[0], n[1], n[2], lo[0], lo[1], lo[2], res);
  const nt = mesh.indices.length / 3;
  ok(nt > 1000, `the extruded slot meshes: ${nt.toLocaleString()} triangles`);

  // watertight?
  const edges = new Map();
  for (let t = 0; t < nt; t++) {
    const A = mesh.indices[3 * t], B = mesh.indices[3 * t + 1], C = mesh.indices[3 * t + 2];
    for (const [u, v] of [[A, B], [B, C], [C, A]]) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let bad = 0;
  for (const v of edges.values()) if (v !== 2) bad++;
  ok(bad === 0, `and is watertight${bad ? ` — ${bad} unpaired edges` : ''}`);

  // volume by the divergence theorem, against area × height
  const P = mesh.positions;
  let V = 0;
  for (let t = 0; t < nt; t++) {
    const a = 3 * mesh.indices[3 * t], b = 3 * mesh.indices[3 * t + 1], c = 3 * mesh.indices[3 * t + 2];
    V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
        - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
        + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  const wantV = (L * 2 * R + Math.PI * R * R) * H;
  ok(Math.abs(Math.abs(V) - wantV) / wantV < 0.01,
     `volume ${Math.abs(V).toFixed(1)} mm³ vs area×height ${wantV.toFixed(1)} `
     + `(${(100 * (Math.abs(V) - wantV) / wantV).toFixed(2)}%)`);

  const stl = SF.meshToSTL(mesh, 'sinterform extruded sketch (mm)');
  ok(stl && stl.size === 84 + nt * 50, `and writes an STL of ${stl.size.toLocaleString()} bytes`);
}

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
