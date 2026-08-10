/* SinterForm sketch3d - a constrained 3D sketcher
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * `sketch.js`, one dimension up. Points, lines, elliptical arcs and NURBS in
 * space, the constraints that hold them together, and the same
 * Levenberg-Marquardt solver reporting the same degrees of freedom. No DOM,
 * no GL, no storage, no dependency on any other file here -- including on
 * sketch.js, which it deliberately does not extend. Two dimensions and three
 * are different enough that a shared file would be a pile of `if (is3d)`.
 *
 * ----------------------------------------------------------------------
 * What survives the lift, unchanged
 * ----------------------------------------------------------------------
 * The one idea. A constraint that touches a curve has to know *where* it
 * touches, that location is not knowable in advance, so a contact parameter
 * is a solver variable like any x or y. `perpendicular` still takes any two
 * direction sources and still does not care which is which -- line to line,
 * line to a spline's tangent, spline to spline, in space now.
 *
 * The variable vector, the entity slices, the LM step the caller drives, the
 * rank-based degree-of-freedom report, the coincidence walk that finds loops.
 *
 * ----------------------------------------------------------------------
 * What changes, and none of it is cosmetic
 * ----------------------------------------------------------------------
 * 1. VECTOR CONDITIONS ARE RANK-DEFICIENT BY CONSTRUCTION. In the plane,
 *    "parallel" is one scalar: the cross product. In space the cross product
 *    is a vector, and setting it to zero is three rows that can only ever
 *    have rank two -- two directions in space differ by two angles, not
 *    three. There is no way to write it as two rows without choosing a frame
 *    perpendicular to one of them, and no way to choose that frame smoothly
 *    everywhere (you cannot comb a sphere). So the rows stay, and each
 *    constraint declares the rank it generically carries alongside the rows
 *    it writes. `redundant` counts against the declared ranks, so it means
 *    what it meant in 2D -- constraints saying something already said --
 *    rather than counting the third row of every parallel. A sketcher that
 *    skips this tells people their sketch is over-constrained when it is not.
 *
 * 2. AN ARC CARRIES A FRAME. In the plane an ellipse needs one angle; in
 *    space it needs three, so an arc owns rx, ry, three Euler angles and its
 *    two extents: seven numbers rather than five. The angles are applied
 *    Rz.Ry.Rx, matching `sinterform.js`, but in radians, matching `sketch.js`.
 *
 * 3. ANGLES ARE UNSIGNED. A signed angle needs an axis to be signed about,
 *    and in space there is no distinguished one. `angle` measures the
 *    unsigned angle between two directions, in [0, pi].
 *
 * 4. A CLOSED LOOP DOES NOT BOUND ANYTHING. In the plane it bounds an area
 *    and `sdf2d` is the distance to it. In space a closed loop bounds an
 *    area only if it is *planar*, which is a property to be measured (or
 *    constrained -- see `planar`), and a wireframe bounds no volume at all.
 *    So there is no argument-free `sdf3d` in this file. There is `profile()`,
 *    which groups planar loops into faces with a plane apiece; `extrude`,
 *    which turns one of those faces into an exact solid along its own normal;
 *    and `wire`, which gives the drawn curves a radius. Anything else would
 *    be a shape nobody asked for.
 *
 * ----------------------------------------------------------------------
 * References
 * ----------------------------------------------------------------------
 * Unchanged from 2D:
 *
 *   { p: id }             a point entity
 *   { e: id }             a whole entity -- a line's direction, an arc's
 *                         centre, a curve's size
 *   { e: id, t: paramId } a location on an entity at a solved parameter:
 *                         both a position and a tangent
 *   { e: id, end: 0|1 }   a curve's *drawn* end -- also both
 *
 * A bare integer means { e: id }.
 */
(function (root) {
"use strict";

// ======================================================================
// three-vectors
// ======================================================================
// Plain arrays. Allocation is not the bottleneck here -- the Jacobian is
// central differences, so every residual is evaluated 2n times, and the cost
// of that dwarfs the cost of the arrays it makes.
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1],
                          a[2] * b[0] - a[0] * b[2],
                          a[0] * b[1] - a[1] * b[0]];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const unit3 = (a) => { const l = len3(a) || 1e-300; return [a[0] / l, a[1] / l, a[2] / l]; };
const triple = (a, b, c) => dot3(cross3(a, b), c);
// Any unit vector perpendicular to n. The branch is fine here because nothing
// differentiates this -- it builds a drawing basis, never a residual.
function perpTo(n) {
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit3(cross3(n, a));
}

// The frame an arc is drawn in: the columns of Rz(az).Ry(ay).Rx(ax), which is
// the rotation order `sinterform.js` uses so a sketch and a shape rotated by
// the same three numbers agree. Returns [u, v, normal].
function frameOf(ax, ay, az) {
  const ca = Math.cos(ax), sa = Math.sin(ax);
  const cb = Math.cos(ay), sb = Math.sin(ay);
  const cc = Math.cos(az), sc = Math.sin(az);
  return [
    [cc * cb, sc * cb, -sb],
    [cc * sb * sa - sc * ca, sc * sb * sa + cc * ca, cb * sa],
    [cc * sb * ca + sc * sa, sc * sb * ca - cc * sa, cb * ca]
  ];
}

// ======================================================================
// dense linear algebra, only as much as a Gauss-Newton step needs
// ======================================================================
// Solve A x = b for symmetric A, in place, partial pivoting. Returns false
// if it is too near singular to trust -- the caller answers that with more
// damping rather than by believing the result.
function solveInPlace(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c, best = Math.abs(A[c * n + c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(A[r * n + c]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-14) return false;
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t;
      }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    const d = A[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * b[k];
    b[r] = s / A[r * n + r];
  }
  return true;
}

// Numerical rank by row echelon. This is what turns "the solve finished" into
// "and here is how many degrees of freedom are left". In 3D it carries more
// weight than it did in 2D, because the rows a constraint writes and the rank
// it carries are no longer the same number.
function rankOf(M, rows, cols, tol) {
  const A = Float64Array.from(M);
  let rank = 0;
  for (let c = 0; c < cols && rank < rows; c++) {
    let piv = rank, best = Math.abs(A[rank * cols + c]);
    for (let r = rank + 1; r < rows; r++) {
      const v = Math.abs(A[r * cols + c]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < tol) continue;
    if (piv !== rank)
      for (let k = 0; k < cols; k++) {
        const t = A[rank * cols + k];
        A[rank * cols + k] = A[piv * cols + k]; A[piv * cols + k] = t;
      }
    const d = A[rank * cols + c];
    for (let r = rank + 1; r < rows; r++) {
      const f = A[r * cols + c] / d;
      if (!f) continue;
      for (let k = c; k < cols; k++) A[r * cols + k] -= f * A[rank * cols + k];
    }
    rank++;
  }
  return rank;
}

// ======================================================================
// B-spline basis and its first derivative
// ======================================================================
// The NURBS Book's findSpan / dersBasisFuns. Dimension-free -- the basis does
// not know how many coordinates a control point has -- so this is character
// for character what `sketch.js` runs, and `check-sketch3d.mjs` asserts the
// two files still agree on it rather than trusting that they do.
function findSpan(n, p, u, U) {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let lo = p, hi = n + 1, mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid; else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

// ders[k][j] = d^k/du^k of the j-th non-zero basis function, k = 0..1.
// The NURBS Book A2.3, stopped at the first derivative because that is all a
// tangent needs.
function dersBasisFuns(i, u, p, U) {
  const ndu = [];
  for (let j = 0; j <= p; j++) ndu.push(new Float64Array(p + 1));
  const a = [new Float64Array(p + 2), new Float64Array(p + 2)];
  const ders = [new Float64Array(p + 1), new Float64Array(p + 1)];
  const left = new Float64Array(p + 1), right = new Float64Array(p + 1);
  const safe = (v) => (Math.abs(v) < 1e-300 ? 1e-300 : v);

  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[i + 1 - j];
    right[j] = U[i + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[r][j - 1] / safe(ndu[j][r]);
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];

  for (let r = 0; r <= p; r++) {
    let s1 = 0, s2 = 1;
    a[0][0] = 1;
    const k = 1, rk = r - k, pk = p - k;
    let d = 0;
    if (r >= k) {
      a[s2][0] = a[s1][0] / safe(ndu[pk + 1][rk]);
      d = a[s2][0] * ndu[rk][pk];
    }
    const j1 = rk >= -1 ? 1 : -rk;
    const j2 = r - 1 <= pk ? k - 1 : p - r;
    for (let j = j1; j <= j2; j++) {
      a[s2][j] = (a[s1][j] - a[s1][j - 1]) / safe(ndu[pk + 1][rk + j]);
      d += a[s2][j] * ndu[rk + j][pk];
    }
    if (r <= pk) {
      a[s2][k] = -a[s1][k - 1] / safe(ndu[pk + 1][r]);
      d += a[s2][k] * ndu[r][pk];
    }
    ders[1][r] = d * p;
    const t = s1; s1 = s2; s2 = t;
  }
  return ders;
}

// ======================================================================
// entities
// ======================================================================
// Every solvable number lives in one flat array. An entity owns a slice of it
// and nothing else owns anything, which is what lets the solver be completely
// ignorant of what a "line" is.
const KIND = { POINT: 'point', LINE: 'line', ARC: 'arc', NURBS: 'nurbs', PARAM: 'param' };

function Sketch3D(opts) {
  this.ents = [];
  this.cons = [];
  this.x = [];              // the variable vector
  this.fixed = [];          // parallel to x: true means the solver may not move it
  // Angular residuals are dimensionless and positional ones are millimetres.
  // Mixing them in one least-squares makes the conditioning depend on how big
  // the sketch happens to be, so the dimensionless ones are multiplied up to
  // millimetres by this. It is a scale, not a tolerance.
  this.scale = (opts && opts.scale) || 10;
  this._maxRows = 1;
}

Sketch3D.prototype._var = function (v, fixed) {
  this.x.push(v);
  this.fixed.push(!!fixed);
  return this.x.length - 1;
};

Sketch3D.prototype.point = function (x, y, z, o) {
  const f = !!(o && o.fixed);
  const e = { k: KIND.POINT, id: this.ents.length,
              vx: this._var(x, f), vy: this._var(y, f), vz: this._var(z, f) };
  this.ents.push(e);
  return e.id;
};

// A free scalar: a contact parameter, or anything else you want solved.
Sketch3D.prototype.param = function (v, o) {
  const e = { k: KIND.PARAM, id: this.ents.length, v: this._var(v, !!(o && o.fixed)) };
  this.ents.push(e);
  return e.id;
};

Sketch3D.prototype.line = function (a, b, o) {
  const e = { k: KIND.LINE, id: this.ents.length, a, b,
              construction: !!(o && o.construction) };
  this.ents.push(e);
  return e.id;
};

// Elliptical arc in a plane of its own. `rot` is the plane: three Euler
// angles in radians, applied Rz.Ry.Rx, taking the XY plane to the arc's. A
// bare number means rotation about +Z alone, which is exactly the 2D `phi` --
// so a planar sketch written for `sketch.js` lifts across unchanged and stays
// in the z = 0 plane.
//
// rx == ry is a circular arc; t0/t1 spanning 2pi is a full ellipse. t is the
// eccentric parameter, not the polar angle.
//
// A circular arc carries one degree of freedom that changes nothing: turn the
// frame about the arc's own normal by theta and slide t0 and t1 by -theta, and
// the curve drawn is identical, because rx*cos(t)*u + ry*sin(t)*v with rx == ry
// is a rotation and the two turns cancel. `dof` therefore reads one high for
// every circular arc in a sketch. An ellipse has no such freedom -- turning an
// ellipse's frame turns the ellipse.
Sketch3D.prototype.arc = function (c, rx, ry, rot, t0, t1, o) {
  const f = !!(o && o.fixed);
  const R = rot === undefined || rot === null ? [0, 0, 0]
          : typeof rot === 'number' ? [0, 0, rot] : rot;
  const e = {
    k: KIND.ARC, id: this.ents.length, c,
    construction: !!(o && o.construction),
    vrx: this._var(rx, f), vry: this._var(ry === undefined ? rx : ry, f),
    vax: this._var(R[0] || 0, f), vay: this._var(R[1] || 0, f), vaz: this._var(R[2] || 0, f),
    vt0: this._var(t0 === undefined ? 0 : t0, f),
    vt1: this._var(t1 === undefined ? 2 * Math.PI : t1, f)
  };
  this.ents.push(e);
  return e.id;
};

// Control points are point entities, so the solver can move them and they can
// carry constraints of their own. Weights are data, not variables: letting a
// solver drive weights is a good way to reach a singular curve nobody asked
// for.
//
// A spline in space is not planar unless something says so -- see the
// `planar` constraint, which is the one that gets it back to something a
// profile can be made of.
Sketch3D.prototype.nurbs = function (ctrl, o) {
  o = o || {};
  const p = Math.max(1, Math.min(o.degree === undefined ? 3 : o.degree, ctrl.length - 1));
  const closed = !!o.closed;
  const w = o.weights && o.weights.length === ctrl.length
    ? o.weights.slice() : ctrl.map(() => 1);
  const cp = closed ? ctrl.concat(ctrl.slice(0, p)) : ctrl.slice();
  const ww = closed ? w.concat(w.slice(0, p)) : w.slice();
  const m = cp.length;
  const U = new Float64Array(m + p + 1);
  if (closed) for (let i = 0; i < U.length; i++) U[i] = (i - p) / ctrl.length;
  else {
    for (let i = 0; i < p; i++) U[i] = 0;
    for (let i = 0; i <= m - p; i++) U[p + i] = i / (m - p);
    for (let i = 0; i < p; i++) U[m + 1 + i] = 1;
  }
  const e = { k: KIND.NURBS, id: this.ents.length, ctrl: cp, w: ww, p, U, closed,
              n: m - 1, base: ctrl.slice(), baseW: w.slice(),
              construction: !!o.construction };
  this.ents.push(e);
  return e.id;
};

Sketch3D.prototype.fix = function (id, on) {
  const e = this.ents[id];
  const set = (v) => { this.fixed[v] = on === undefined ? true : !!on; };
  if (e.k === KIND.POINT) { set(e.vx); set(e.vy); set(e.vz); }
  else if (e.k === KIND.PARAM) set(e.v);
  else if (e.k === KIND.ARC) {
    set(e.vrx); set(e.vry); set(e.vax); set(e.vay); set(e.vaz); set(e.vt0); set(e.vt1);
    this.fix(e.c, on);
  } else if (e.k === KIND.LINE) { this.fix(e.a, on); this.fix(e.b, on); }
  else if (e.k === KIND.NURBS) e.base.forEach(c => this.fix(c, on));
  return id;
};

// Scaffolding: geometry that constrains the drawing without being part of it.
// A centreline, an axis to measure an angle against, a construction plane's
// three edges -- and a profile must not walk into one.
Sketch3D.prototype.construction = function (id, on) {
  const e = this.ents[id];
  if (!e) throw new Error(`no entity ${id}`);
  e.construction = on === undefined ? true : !!on;
  return id;
};

// ======================================================================
// evaluation — position and tangent, from one entry point
// ======================================================================
Sketch3D.prototype.ptOf = function (x, id) {
  const e = this.ents[id];
  return [x[e.vx], x[e.vy], x[e.vz]];
};

// The arc's own frame, as [u, v, normal]. Public because anything drawing an
// arc needs it and nothing should be reading `vax` out of the variable vector
// to get it.
Sketch3D.prototype.frameOfArc = function (x, id) {
  const e = this.ents[id];
  if (e.k !== KIND.ARC) throw new Error(`entity ${id} (${e.k}) has no frame`);
  return frameOf(x[e.vax], x[e.vay], x[e.vaz]);
};

// Position and first derivative of entity `id` at parameter t.
Sketch3D.prototype.evalAt = function (x, id, t) {
  const e = this.ents[id];
  if (e.k === KIND.LINE) {
    const a = this.ptOf(x, e.a), b = this.ptOf(x, e.b);
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
                 a[2] + (b[2] - a[2]) * t],
             d: [b[0] - a[0], b[1] - a[1], b[2] - a[2]] };
  }
  if (e.k === KIND.ARC) {
    const c = this.ptOf(x, e.c);
    const rx = x[e.vrx], ry = x[e.vry];
    const F = frameOf(x[e.vax], x[e.vay], x[e.vaz]);
    const u = F[0], v = F[1];
    const ct = Math.cos(t), st = Math.sin(t);
    const a = rx * ct, b = ry * st, da = -rx * st, db = ry * ct;
    return { p: [c[0] + u[0] * a + v[0] * b,
                 c[1] + u[1] * a + v[1] * b,
                 c[2] + u[2] * a + v[2] * b],
             d: [u[0] * da + v[0] * db, u[1] * da + v[1] * db, u[2] * da + v[2] * db] };
  }
  if (e.k === KIND.NURBS) {
    const p = e.p, U = e.U, n = e.n;
    const u = Math.min(Math.max(t, U[p]), U[n + 1]);
    const span = findSpan(n, p, u, U);
    const N = dersBasisFuns(span, u, p, U);
    let ax = 0, ay = 0, az = 0, aw = 0, bx = 0, by = 0, bz = 0, bw = 0;
    for (let j = 0; j <= p; j++) {
      const idx = span - p + j;
      const P = this.ptOf(x, e.ctrl[idx]), w = e.w[idx];
      const n0 = N[0][j], n1 = N[1][j];
      ax += n0 * w * P[0]; ay += n0 * w * P[1]; az += n0 * w * P[2]; aw += n0 * w;
      bx += n1 * w * P[0]; by += n1 * w * P[1]; bz += n1 * w * P[2]; bw += n1 * w;
    }
    const W = aw || 1e-300;
    return { p: [ax / W, ay / W, az / W],
             d: [(bx * W - ax * bw) / (W * W),
                 (by * W - ay * bw) / (W * W),
                 (bz * W - az * bw) / (W * W)] };
  }
  throw new Error(`entity ${id} (${e.k}) has no parameterisation`);
};

// The centre of a thing. An arc's centre point; a line's midpoint, because
// that is what someone means when they drop a centre mark on a line.
Sketch3D.prototype.centreOf = function (x, id) {
  const e = this.ents[id];
  if (e.k === KIND.ARC) return this.ptOf(x, e.c);
  if (e.k === KIND.LINE) {
    const a = this.ptOf(x, e.a), b = this.ptOf(x, e.b);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  }
  if (e.k === KIND.POINT) return this.ptOf(x, id);
  throw new Error(`entity ${id} (${e.k}) has no centre`);
};

// ---- resolving refs ---------------------------------------------------
Sketch3D.prototype.tangentAt = function (id, t) {
  return unit3(this.evalAt(this.x, id, t).d);
};

// The Frenet frame, as far as it exists. The principal normal comes from
// differencing the unit tangent, because a second derivative is not something
// this file computes analytically -- and unlike a tangent it never goes into
// a residual, so finite differences are honest here.
//
// Where the curve is straight the curvature is zero and the principal normal
// is genuinely undefined; an arbitrary perpendicular comes back instead,
// which is what a drawing needs and what a calculation must not trust.
Sketch3D.prototype.frameAt = function (id, t) {
  const T = this.tangentAt(id, t);
  const [u0, u1] = this._range(id);
  const h = Math.max(1e-5, Math.abs(u1 - u0) * 1e-4);
  const hi = this.tangentAt(id, t + h), lo = this.tangentAt(id, t - h);
  let n = sub3(hi, lo);
  const along = dot3(n, T);
  n = [n[0] - along * T[0], n[1] - along * T[1], n[2] - along * T[2]];
  const straight = len3(n) < 1e-9;
  const N = straight ? perpTo(T) : unit3(n);
  return { t: T, n: N, b: cross3(T, N), straight };
};
Sketch3D.prototype.normalAt = function (id, t) { return this.frameAt(id, t).n; };
Sketch3D.prototype.binormalAt = function (id, t) { return this.frameAt(id, t).b; };

// Resolve a ref to a position or a direction, against the current solution.
// These are the two questions the constraints themselves ask, so anything
// built on this file will want to ask them too -- to draw a glyph where a
// constraint bites, or to check one independently.
Sketch3D.prototype.posOf = function (r) { return this._pos(this.x, r); };
Sketch3D.prototype.dirOf = function (r) { return this._dir(this.x, r); };

// The parameter at a curve's drawn end. A contact parameter is a variable the
// solver moves; this is where the curve *stops being drawn*, which is a
// different thing and is what a profile is built out of.
Sketch3D.prototype._endParam = function (x, id, end) {
  const e = this.ents[id];
  if (e.k === KIND.LINE) return end ? 1 : 0;
  if (e.k === KIND.ARC) return end ? x[e.vt1] : x[e.vt0];
  if (e.k === KIND.NURBS) return end ? e.U[e.n + 1] : e.U[e.p];
  throw new Error(`entity ${id} (${e.k}) has no ends`);
};

Sketch3D.prototype._pos = function (x, r) {
  if (r.p !== undefined) return this.ptOf(x, r.p);
  if (r.e !== undefined && r.t !== undefined)
    return this.evalAt(x, r.e, x[this.ents[r.t].v]).p;
  if (r.e !== undefined && r.end !== undefined)
    return this.evalAt(x, r.e, this._endParam(x, r.e, r.end)).p;
  if (r.e !== undefined && this.ents[r.e].k === KIND.POINT) return this.ptOf(x, r.e);
  throw new Error('ref has no position — a curve needs {t} or {end}');
};

Sketch3D.prototype._dir = function (x, r) {
  if (r.e !== undefined && r.t !== undefined)
    return this.evalAt(x, r.e, x[this.ents[r.t].v]).d;
  if (r.e !== undefined && r.end !== undefined)
    return this.evalAt(x, r.e, this._endParam(x, r.e, r.end)).d;
  if (r.e !== undefined && this.ents[r.e].k === KIND.LINE) {
    const e = this.ents[r.e];
    const a = this.ptOf(x, e.a), b = this.ptOf(x, e.b);
    return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  }
  throw new Error('ref has no direction — a curve needs {t} or {end}');
};

// Both at once, from one ref. `collinear` and `coplanar` are statements about
// a line in space -- a point on it and a direction along it -- and asking for
// the two separately would reject `{ e: lineId }`, which has a position only
// by the convention that a line starts at its first point.
Sketch3D.prototype._posdir = function (x, r) {
  if (r.e !== undefined && (r.t !== undefined || r.end !== undefined)) {
    const t = r.t !== undefined ? x[this.ents[r.t].v] : this._endParam(x, r.e, r.end);
    return this.evalAt(x, r.e, t);
  }
  if (r.e !== undefined && this.ents[r.e].k === KIND.LINE) {
    const e = this.ents[r.e];
    const a = this.ptOf(x, e.a), b = this.ptOf(x, e.b);
    return { p: a, d: [b[0] - a[0], b[1] - a[1], b[2] - a[2]] };
  }
  throw new Error('ref has no position and direction — a line, or a curve with {t} or {end}');
};

// ======================================================================
// constraints
// ======================================================================
// Each returns its residuals, which are zero exactly when it is satisfied.
// Angular ones are normalised and scaled to millimetres so that one badly
// conditioned row cannot dominate the least-squares.
//
// `n` is how many rows the constraint writes. `rank` is how many of them are
// independent in a generic configuration, and defaults to `n`. They differ
// wherever a condition is naturally a vector -- see the header. Both may be
// functions of (S, a, b).
const CONSTRAINTS = {
  // two locations are the same point
  coincident: { n: 3, f(S, x, c, out) {
    const a = S._pos(x, c.a), b = S._pos(x, c.b);
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  } },

  // two curves share a centre
  concentric: { n: 3, f(S, x, c, out) {
    const a = S.centreOf(x, c.a.e), b = S.centreOf(x, c.b.e);
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  } },

  // a point sits at a thing's centre (an arc's centre, a line's midpoint)
  centre: { n: 3, f(S, x, c, out) {
    const p = S._pos(x, c.a), q = S.centreOf(x, c.b.e);
    out[0] = p[0] - q[0]; out[1] = p[1] - q[1]; out[2] = p[2] - q[2];
  } },

  // Two lines lying on one infinite line: parallel (two angles, written as
  // three rows) and the second's start displaced from the first's by nothing
  // across that direction (two more, again three rows). Rank four out of six,
  // which is what "the same line in space" is worth.
  collinear: { n: 6, rank: 4, f(S, x, c, out) {
    const A = S._posdir(x, c.a), B = S._posdir(x, c.b);
    const u1 = unit3(A.d), u2 = unit3(B.d);
    const cr = cross3(u1, u2);
    out[0] = cr[0] * S.scale; out[1] = cr[1] * S.scale; out[2] = cr[2] * S.scale;
    // |w x u1| is the perpendicular distance from B's point to A's line, in mm
    const off = cross3(sub3(B.p, A.p), u1);
    out[3] = off[0]; out[4] = off[1]; out[5] = off[2];
  } },

  // Three rows, rank two: two directions in space differ by two angles, and
  // the cross product cannot be written in fewer rows without picking a frame
  // perpendicular to one of them, which cannot be done smoothly everywhere.
  parallel: { n: 3, rank: 2, f(S, x, c, out) {
    const d1 = unit3(S._dir(x, c.a)), d2 = unit3(S._dir(x, c.b));
    const cr = cross3(d1, d2);
    out[0] = cr[0] * S.scale; out[1] = cr[1] * S.scale; out[2] = cr[2] * S.scale;
  } },

  // The headline, and the one thing that does not get harder in 3D: a right
  // angle is one number in any dimension. Both sides are direction sources,
  // and a direction source is a line or a tangent. Nothing here knows which.
  perpendicular: { n: 1, f(S, x, c, out) {
    const d1 = unit3(S._dir(x, c.a)), d2 = unit3(S._dir(x, c.b));
    out[0] = dot3(d1, d2) * S.scale;
  } },

  // touching, with tangents in line: three positional rows and three parallel
  // ones of rank two. Five independent equations against the two contact
  // parameters it introduces, so it removes three degrees of freedom -- in
  // the plane the same statement was worth one, because two curves in a plane
  // already meet and two in space do not.
  tangent: { n: 6, rank: 5, f(S, x, c, out) {
    const A = S.evalAt(x, c.a.e, x[S.ents[c.a.t].v]);
    const B = S.evalAt(x, c.b.e, x[S.ents[c.b.t].v]);
    out[0] = A.p[0] - B.p[0];
    out[1] = A.p[1] - B.p[1];
    out[2] = A.p[2] - B.p[2];
    const cr = cross3(unit3(A.d), unit3(B.d));
    out[3] = cr[0] * S.scale; out[4] = cr[1] * S.scale; out[5] = cr[2] * S.scale;
  } },

  // lines: equal length (one equation). arcs: equal semi-axes (two), because
  // two ellipses being "equal" is a statement about both axes.
  equal: { n: (S, a, b) => (S.ents[a.e].k === KIND.ARC && S.ents[b.e].k === KIND.ARC ? 2 : 1),
    f(S, x, c, out) {
    const ea = S.ents[c.a.e], eb = S.ents[c.b.e];
    if (ea.k === KIND.LINE && eb.k === KIND.LINE) {
      const a0 = S.ptOf(x, ea.a), a1 = S.ptOf(x, ea.b);
      const b0 = S.ptOf(x, eb.a), b1 = S.ptOf(x, eb.b);
      out[0] = len3(sub3(a1, a0)) - len3(sub3(b1, b0));
      return;
    }
    if (ea.k === KIND.ARC && eb.k === KIND.ARC) {
      out[0] = x[ea.vrx] - x[eb.vrx];
      out[1] = x[ea.vry] - x[eb.vry];
      return;
    }
    throw new Error('equal wants two lines or two arcs');
  } },

  // When every arc is elliptical, "this one is a circle" is something that
  // has to be sayable. Leave it out and a tangency will quietly find its
  // answer by squashing the arc instead of moving it.
  circular: { n: 1, f(S, x, c, out) {
    const e = S.ents[c.a.e];
    if (e.k !== KIND.ARC) throw new Error('circular wants an arc');
    out[0] = x[e.vrx] - x[e.vry];
  } },

  // dimensional, because a sketch that cannot be given a size is a drawing
  distance: { n: 1, f(S, x, c, out) {
    const a = S._pos(x, c.a), b = S._pos(x, c.b);
    out[0] = len3(sub3(b, a)) - c.v;
  } },
  radius: { n: 1, f(S, x, c, out) {
    out[0] = x[S.ents[c.a.e].vrx] - c.v;
  } },
  // An ellipse has two semi-axes; `radius` only ever reached the first.
  radiusY: { n: 1, f(S, x, c, out) {
    out[0] = x[S.ents[c.a.e].vry] - c.v;
  } },

  // Unsigned, in [0, pi]. A signed angle needs an axis to be signed about and
  // space does not supply one; asking for a negative angle here is asking for
  // something that cannot be satisfied. atan2 of the cross against the dot
  // rather than acos of the dot, which loses its resolution near 0 and pi --
  // exactly where a sketch is most likely to sit.
  //
  // The unsigned angle has a kink at 0 and at pi, where |cross| turns around:
  // the value is right but the derivative is not, and the solver reads
  // derivatives. Say `parallel` and `perpendicular` for those two; they are
  // smooth, and they are what someone meant anyway.
  angle: { n: 1, f(S, x, c, out) {
    const d1 = unit3(S._dir(x, c.a)), d2 = unit3(S._dir(x, c.b));
    out[0] = (Math.atan2(len3(cross3(d1, d2)), dot3(d1, d2)) - c.v) * S.scale;
  } },

  // point stays on a curve, without pinning where. Three rows against the one
  // contact parameter it introduces: in space, landing a point on a curve is
  // worth two degrees of freedom.
  on: { n: 3, f(S, x, c, out) {
    const p = S._pos(x, c.a);
    const q = S.evalAt(x, c.b.e, x[S.ents[c.b.t].v]).p;
    out[0] = p[0] - q[0]; out[1] = p[1] - q[1]; out[2] = p[2] - q[2];
  } },

  // In the plane these were the two axes. Here the build plate is the fixed
  // thing -- +Z up, z = 0 the plate -- so `horizontal` means the direction
  // lies in a horizontal plane (one equation) and `vertical` means it runs up
  // the Z axis (two, being a direction in space pinned to an axis).
  horizontal: { n: 1, f(S, x, c, out) {
    const d = unit3(S._dir(x, c.a));
    out[0] = d[2] * S.scale;
  } },
  vertical: { n: 2, f(S, x, c, out) {
    const d = unit3(S._dir(x, c.a));
    out[0] = d[0] * S.scale; out[1] = d[1] * S.scale;
  } },

  // 3D only: two lines share a plane -- they meet, or they are parallel. One
  // equation, and it is the volume of the box they span, in millimetres, so
  // it reads as a distance rather than as a determinant.
  coplanar: { n: 1, f(S, x, c, out) {
    const A = S._posdir(x, c.a), B = S._posdir(x, c.b);
    out[0] = triple(unit3(A.d), unit3(B.d), sub3(B.p, A.p));
  } },

  // 3D only, and the one that gets a spline back to something extrudable: its
  // control points all lie in one plane, so the curve does. Rows: one per
  // control point past the third, since three points always share a plane.
  // Lines and arcs are planar by construction and cost nothing to say it of.
  //
  // The plane comes from the first three control points, and the divisor is
  // what stops that being a trap. Divide by |e1||e2| -- the obvious choice --
  // and the residual is an area ratio rather than a distance, which a solver
  // can drive to zero by making e1 and e2 parallel instead of by flattening
  // anything. It will, too: it is the cheaper direction, and it arrives at
  // `converged` with the curve millimetres out of plane and the constraint
  // evaporated, because a degenerate reference triangle satisfies every row
  // for free.
  //
  // Dividing by |e1 x e2| makes each row the honest out-of-plane distance in
  // millimetres, and collapsing the triangle then costs rather than pays. The
  // second term keeps the divisor away from zero, so three collinear control
  // points give a large residual instead of a division by one.
  planar: { n: (S, a) => Math.max(0, planarCount(S, a)),
    f(S, x, c, out) {
    const e = S.ents[c.a.e];
    if (e.k !== KIND.NURBS) return;
    const P = e.base.map(id => S.ptOf(x, id));
    const e1 = sub3(P[1], P[0]), e2 = sub3(P[2], P[0]);
    const n = cross3(e1, e2);
    const s = len3(n) + 1e-3 * len3(e1) * len3(e2);
    for (let i = 3; i < P.length; i++) out[i - 3] = dot3(n, sub3(P[i], P[0])) / s;
  } }
};

function planarCount(S, a) {
  const e = S.ents[a.e];
  if (!e) throw new Error(`no entity ${a.e}`);
  if (e.k === KIND.NURBS) return e.base.length - 3;
  if (e.k === KIND.LINE || e.k === KIND.ARC) return 0;   // planar already
  throw new Error('planar wants a curve');
}

// The parameter range worth searching, and a point that stands for the whole
// entity when nothing better is known.
Sketch3D.prototype._range = function (id) {
  const e = this.ents[id];
  if (e.k === KIND.LINE) return [0, 1];
  if (e.k === KIND.ARC) return [this.x[e.vt0], this.x[e.vt1]];
  if (e.k === KIND.NURBS) return [e.U[e.p], e.U[e.n + 1]];
  return [0, 1];
};

Sketch3D.prototype._repr = function (id) {
  const e = this.ents[id];
  if (e.k === KIND.POINT) return this.ptOf(this.x, id);
  if (e.k === KIND.ARC) return this.ptOf(this.x, e.c);
  const [u0, u1] = this._range(id);
  return this.evalAt(this.x, id, (u0 + u1) / 2).p;
};

// Coarse closest-point-on-entity search. Coarse is the right word: it only
// has to land in the right basin, and the solver refines from there.
Sketch3D.prototype._closestParam = function (id, target) {
  const [u0, u1] = this._range(id);
  let best = u0, bd = Infinity;
  for (let i = 0; i <= 64; i++) {
    const t = u0 + (u1 - u0) * i / 64;
    const p = this.evalAt(this.x, id, t).p;
    const d = (p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2 + (p[2] - target[2]) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
};

// Tangency needs a contact parameter on each side. If the caller did not
// supply one, make it -- and hand back the id, so it shows up in the
// degree-of-freedom count rather than hiding there.
//
// Where those parameters *start* decides which answer comes back. Tangency is
// two-valued for a pair of circles -- side by side, or nested -- and both
// satisfy "touching, with tangents in line" exactly. Aiming each contact at
// the other entity, then refining once against where that landed, picks the
// basin someone drawing it would have meant. It is still two-valued; this
// only chooses the near answer.
Sketch3D.prototype._tangentParams = function (A, B) {
  const needA = A.t === undefined && this.ents[A.e].k !== KIND.POINT;
  const needB = B.t === undefined && this.ents[B.e].k !== KIND.POINT;
  let tA = needA ? this._closestParam(A.e, this._repr(B.e)) : null;
  let tB = needB
    ? this._closestParam(B.e, needA ? this.evalAt(this.x, A.e, tA).p : this._repr(A.e))
    : null;
  if (needA && needB) tA = this._closestParam(A.e, this.evalAt(this.x, B.e, tB).p);
  return [needA ? { e: A.e, t: this.param(tA) } : A,
          needB ? { e: B.e, t: this.param(tB) } : B];
};

Sketch3D.prototype._needParam = function (r, target) {
  if (r.t !== undefined || r.p !== undefined) return r;
  const e = this.ents[r.e];
  if (e.k === KIND.POINT) return r;
  const [u0, u1] = this._range(r.e);
  const t = target ? this._closestParam(r.e, target) : (u0 + u1) / 2;
  return { e: r.e, t: this.param(t) };
};

Sketch3D.prototype.constrain = function (kind, a, b, v) {
  const C = CONSTRAINTS[kind];
  if (!C) throw new Error(`no such constraint: ${kind}`);
  const norm = (r) => (typeof r === 'number' ? { e: r } : r);
  let A = norm(a), B = b === undefined ? undefined : norm(b);
  if (kind === 'tangent') [A, B] = this._tangentParams(A, B);
  if (kind === 'on') B = this._needParam(B, A.p !== undefined ? this.ptOf(this.x, A.p) : null);
  return this.addConstraint(kind, A, B, v);
};

// The same thing with nothing inferred: refs are taken exactly as given, and
// no contact parameters are invented. `constrain` is the ergonomic door; this
// is the one deserialisation comes through, because a round trip must not
// quietly mint a second set of parameters for a tangency that already has
// them.
Sketch3D.prototype.addConstraint = function (kind, a, b, v) {
  const C = CONSTRAINTS[kind];
  if (!C) throw new Error(`no such constraint: ${kind}`);
  const n = typeof C.n === 'function' ? C.n(this, a, b) : C.n;
  const rank = C.rank === undefined ? n
             : typeof C.rank === 'function' ? C.rank(this, a, b) : C.rank;
  const c = { kind, a, b, v, id: this._cid = (this._cid || 0) + 1, n, rank, f: C.f };
  this.cons.push(c);
  if (n > this._maxRows) this._maxRows = n;
  return c;
};

// ======================================================================
// the solve
// ======================================================================
// How many residual rows the constraints write, and how many independent
// equations they generically carry. In 2D these were one number; here they
// are two, and telling them apart is what keeps `redundant` meaningful.
Sketch3D.prototype.rows = function () { return this.cons.reduce((s, c) => s + c.n, 0); };
Sketch3D.prototype.equations = function () { return this.cons.reduce((s, c) => s + c.rank, 0); };

Sketch3D.prototype.residuals = function (x, out) {
  let k = 0;
  if (!this._tmp || this._tmp.length < this._maxRows)
    this._tmp = new Float64Array(Math.max(this._maxRows, 8));
  const tmp = this._tmp;
  for (const c of this.cons) {
    tmp.fill(0, 0, c.n);
    c.f(this, x, c, tmp);
    for (let i = 0; i < c.n; i++) out[k++] = tmp[i];
  }
  return k;
};

Sketch3D.prototype._free = function () {
  const idx = [];
  for (let i = 0; i < this.x.length; i++) if (!this.fixed[i]) idx.push(i);
  return idx;
};

// Levenberg-Marquardt, one iteration at a time. Gauss-Newton alone walks off a
// cliff the moment a sketch is near-singular, which in 3D is not "most of the
// interesting ones" but very nearly all of them: every vector-valued
// constraint contributes a dependent row by construction.
//
// The loop belongs to the caller. `solver()` hands back something that can be
// advanced one step, and `solve()` below is nothing but a `while` around it --
// which is the right way round for a kernel: it should be *called*, not run.
// Each accepted step writes back to the sketch, so a consumer can read the
// geometry between steps and draw it settling.
Sketch3D.prototype.solver = function (opts) {
  opts = opts || {};
  const S = this;
  const tol = opts.tol || 1e-9;
  const maxIter = opts.maxIter === undefined ? 200 : opts.maxIter;
  const free = S._free();
  const n = free.length;
  const m = S.rows();
  const x = Float64Array.from(S.x);
  const r = new Float64Array(m), r2 = new Float64Array(m), plus = new Float64Array(m);
  const J = new Float64Array(m * n);
  const A = new Float64Array(n * n), g = new Float64Array(n), step = new Float64Array(n);
  const norm = (v) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s); };

  let f = 0, lambda = 1e-3, iter = 0, done = !m, stalled = false;
  if (m) { S.residuals(x, r); f = norm(r); }

  const flush = () => { for (let i = 0; i < x.length; i++) S.x[i] = x[i]; };
  const state = () => ({ done, stalled, iteration: iter, residual: f,
                         converged: f <= Math.max(tol, 1e-7) });

  return {
    // One Levenberg-Marquardt iteration: a Jacobian, a normal-equation solve,
    // and however many damping attempts it takes to find a step that helps.
    // That search is bounded and is part of one step, not a loop of its own.
    step() {
      if (done) return state();
      if (f <= tol || iter >= maxIter) { done = true; return state(); }
      S._jac(x, free, J, m, r2, plus);
      for (let i = 0; i < n; i++) {
        g[i] = 0;
        for (let k = 0; k < m; k++) g[i] -= J[k * n + i] * r[k];
        for (let j = 0; j <= i; j++) {
          let s = 0;
          for (let k = 0; k < m; k++) s += J[k * n + i] * J[k * n + j];
          A[i * n + j] = A[j * n + i] = s;
        }
      }
      // Damp isotropically -- lambda * max(diag), not Marquardt's lambda *
      // diag(J'J). Per-coordinate damping is the textbook choice and the wrong
      // one here: a sketch is nearly always rank-deficient, and scaling the
      // damping by each diagonal entry means the directions with the least
      // curvature get the least damping, so the step runs furthest exactly
      // where it knows least. One number for the whole matrix keeps the step
      // near the minimum-norm Newton step.
      let dmax = 0;
      for (let i = 0; i < n; i++) dmax = Math.max(dmax, A[i * n + i]);
      if (!(dmax > 0)) dmax = 1;
      let accepted = false;
      for (let attempt = 0; attempt < 12 && !accepted; attempt++) {
        const Ad = Float64Array.from(A);
        for (let i = 0; i < n; i++) Ad[i * n + i] += lambda * dmax;
        step.set(g);
        if (!solveInPlace(Ad, step, n)) { lambda *= 8; continue; }
        const trial = Float64Array.from(x);
        for (let j = 0; j < n; j++) trial[free[j]] += step[j];
        S.residuals(trial, r2);
        const f2 = norm(r2);
        if (f2 < f) {
          x.set(trial); r.set(r2); f = f2;
          lambda = Math.max(lambda / 3, 1e-12);
          accepted = true;
        } else lambda *= 8;
      }
      if (!accepted) { done = true; stalled = true; return state(); }
      iter++;
      flush();
      if (f <= tol || iter >= maxIter) done = true;
      return state();
    },

    // The full diagnosis, from wherever the stepping got to. Honest about a
    // solve that was stopped early: `converged` will say so.
    report() {
      flush();
      if (m && n) S._jac(x, free, J, m, r2, plus);
      return S._report(x, free, J, m, f, iter, f <= Math.max(tol, 1e-7));
    },

    get state() { return state(); }
  };
};

// Run it to completion. This is the convenience, not the primitive -- anything
// with a frame budget should drive `solver()` itself.
Sketch3D.prototype.solve = function (opts) {
  const run = this.solver(opts);
  while (!run.step().done) { /* the caller's loop, kept short */ }
  return run.report();
};

// Central differences. The residuals contain atan2 and normalised cross
// products; one-sided differences on those lose more than they save.
Sketch3D.prototype._jac = function (x, free, J, m, scratch, plus) {
  const n = free.length;
  for (let j = 0; j < n; j++) {
    const v = free[j], h = 1e-7 * Math.max(1, Math.abs(x[v]));
    const save = x[v];
    x[v] = save + h; this.residuals(x, plus);
    x[v] = save - h; this.residuals(x, scratch);
    for (let i = 0; i < m; i++) J[i * n + j] = (plus[i] - scratch[i]) / (2 * h);
    x[v] = save;
  }
};

Sketch3D.prototype._report = function (x, free, J, m, f, iter, converged) {
  const n = free.length;
  const rank = m && n ? rankOf(J, m, n, 1e-8) : 0;
  const eq = this.equations();
  // Redundancy is measured against the equations the constraints *claim*, not
  // against the rows they write. Three rows of rank two are not a constraint
  // repeating itself; they are how a vector equation is spelt.
  const redundant = Math.max(0, eq - rank);
  return {
    converged,
    residual: f,
    iterations: iter,
    variables: n,          // free variables, contact parameters included
    equations: eq,         // independent equations the constraints carry
    rows: m,               // residual rows, which is not the same number
    rank,
    dof: n - rank,         // 0 means fully constrained
    redundant,             // constraints that said something already said
    // Converged with leftover equations means they agreed. Not converged means
    // they did not, and that is the honest word for it.
    conflicting: !converged && redundant > 0
  };
};

// ======================================================================
// sampling — what the rest of the kernel will want
// ======================================================================
// Polyline per entity. Arcs get enough segments for the sagitta to fall under
// `tol`; splines get a fixed density, which is honest about being a guess.
Sketch3D.prototype.sample = function (id, tol) {
  tol = tol || 0.05;
  const e = this.ents[id], x = this.x, out = [];
  if (e.k === KIND.LINE) return [this.ptOf(x, e.a), this.ptOf(x, e.b)];
  if (e.k === KIND.ARC) {
    const rmax = Math.max(x[e.vrx], x[e.vry]);
    const t0 = x[e.vt0], t1 = x[e.vt1], sweep = Math.abs(t1 - t0);
    // sagitta = r(1 - cos(dtheta/2)); solve for dtheta
    const dth = 2 * Math.acos(Math.max(1 - tol / Math.max(rmax, 1e-6), -1));
    const n = Math.max(2, Math.ceil(sweep / Math.max(dth, 1e-3)));
    for (let i = 0; i <= n; i++) out.push(this.evalAt(x, id, t0 + (t1 - t0) * i / n).p);
    return out;
  }
  if (e.k === KIND.NURBS) {
    const n = Math.max(16, e.base.length * 12);
    const u0 = e.U[e.p], u1 = e.U[e.n + 1];
    for (let i = 0; i <= n; i++) out.push(this.evalAt(x, id, u0 + (u1 - u0) * i / n).p);
    return out;
  }
  return out;
};

// Axis-aligned bounds of everything drawn, in mm. Construction geometry is
// scaffolding and does not count towards the size of the thing.
Sketch3D.prototype.bounds = function (tol) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const e of this.ents) {
    if (e.dead || e.construction || CURVE_KINDS.indexOf(e.k) < 0) continue;
    for (const p of this.sample(e.id, tol)) {
      any = true;
      for (let i = 0; i < 3; i++) {
        if (p[i] < lo[i]) lo[i] = p[i];
        if (p[i] > hi[i]) hi[i] = p[i];
      }
    }
  }
  return any ? { lo, hi } : null;
};

// ======================================================================
// reading and editing a sketch from outside
// ======================================================================
// Everything solvable lives in one flat array, and where each entity's numbers
// sit in it is nobody else's business. These are the accessors that make that
// true -- without them the first thing anyone writes is `S.x[S.ents[id].vrx]`,
// and then the layout can never change again.

// A plain snapshot. No live references into the sketch: change it freely.
Sketch3D.prototype.get = function (id) {
  const e = this.ents[id];
  if (!e) throw new Error(`no entity ${id}`);
  const F = (v) => this.fixed[v];
  switch (e.k) {
    case KIND.POINT:
      return { id, kind: e.k, dead: !!e.dead,
               x: this.x[e.vx], y: this.x[e.vy], z: this.x[e.vz],
               fixed: F(e.vx) && F(e.vy) && F(e.vz) };
    case KIND.PARAM:
      return { id, kind: e.k, dead: !!e.dead, t: this.x[e.v], fixed: F(e.v) };
    case KIND.LINE:
      return { id, kind: e.k, dead: !!e.dead, construction: !!e.construction, a: e.a, b: e.b,
               from: this.ptOf(this.x, e.a), to: this.ptOf(this.x, e.b) };
    case KIND.ARC: {
      const F3 = frameOf(this.x[e.vax], this.x[e.vay], this.x[e.vaz]);
      return { id, kind: e.k, dead: !!e.dead, construction: !!e.construction, c: e.c,
               centre: this.ptOf(this.x, e.c),
               rx: this.x[e.vrx], ry: this.x[e.vry],
               rot: [this.x[e.vax], this.x[e.vay], this.x[e.vaz]],
               u: F3[0], v: F3[1], normal: F3[2],
               t0: this.x[e.vt0], t1: this.x[e.vt1],
               circular: Math.abs(this.x[e.vrx] - this.x[e.vry]) < 1e-9 };
    }
    case KIND.NURBS:
      return { id, kind: e.k, dead: !!e.dead, construction: !!e.construction, ctrl: e.base.slice(),
               weights: e.baseW.slice(), degree: e.p, closed: e.closed,
               domain: [e.U[e.p], e.U[e.n + 1]] };
    default:
      return { id, kind: e.k, dead: !!e.dead };
  }
};

// Write values back. This is how a drag works: set the point, fix it, solve,
// unfix it. Silently ignores fields an entity does not have, so a snapshot
// from get() can be handed straight back.
Sketch3D.prototype.set = function (id, vals) {
  const e = this.ents[id];
  if (!e) throw new Error(`no entity ${id}`);
  const put = (slot, v) => { if (typeof v === 'number') this.x[slot] = v; };
  if (e.k === KIND.POINT) { put(e.vx, vals.x); put(e.vy, vals.y); put(e.vz, vals.z); }
  else if (e.k === KIND.PARAM) put(e.v, vals.t);
  else if (e.k === KIND.ARC) {
    put(e.vrx, vals.rx); put(e.vry, vals.ry);
    const R = typeof vals.rot === 'number' ? [undefined, undefined, vals.rot] : vals.rot;
    if (R) { put(e.vax, R[0]); put(e.vay, R[1]); put(e.vaz, R[2]); }
    put(e.vt0, vals.t0); put(e.vt1, vals.t1);
  }
  if (vals.fixed !== undefined) this.fix(id, vals.fixed);
  return id;
};

Sketch3D.prototype.entities = function (kind) {
  const out = [];
  for (const e of this.ents)
    if (!e.dead && (!kind || e.k === kind)) out.push(this.get(e.id));
  return out;
};

Sketch3D.prototype.constraints = function () {
  return this.cons.map(c => ({ id: c.id, kind: c.kind, a: c.a, b: c.b,
                               value: c.v, rows: c.n, equations: c.rank }));
};

// Which constraints mention an entity -- what a UI needs to grey out a delete,
// or to explain why something will not move.
Sketch3D.prototype.constraintsOn = function (id) {
  const hits = (r) => !!r && (r.p === id || r.e === id || r.t === id);
  return this.cons.filter(c => hits(c.a) || hits(c.b))
                  .map(c => ({ id: c.id, kind: c.kind }));
};

Sketch3D.prototype.dropConstraint = function (ref) {
  const id = typeof ref === 'object' ? ref.id : ref;
  const before = this.cons.length;
  this.cons = this.cons.filter(c => c.id !== id);
  return this.cons.length < before;
};

// Pin only the numbers this entity owns. `fix` deliberately reaches through to
// an entity's points, because pinning a line means pinning its ends -- but
// retiring one must not, or dropping a line would pin the points it happened
// to share with the lines still standing.
Sketch3D.prototype._pinOwn = function (id) {
  const e = this.ents[id];
  const set = (v) => { this.fixed[v] = true; };
  if (e.k === KIND.POINT) { set(e.vx); set(e.vy); set(e.vz); }
  else if (e.k === KIND.PARAM) set(e.v);
  else if (e.k === KIND.ARC) {
    set(e.vrx); set(e.vry); set(e.vax); set(e.vay); set(e.vaz); set(e.vt0); set(e.vt1);
  }
};

// Entity ids are indices, so an entity cannot be spliced out without
// invalidating every id after it. It is retired instead: its variables are
// pinned so they leave the degree-of-freedom count, everything that referred
// to it is dropped, and the id stays burnt. Round-trip through toJSON to
// compact.
Sketch3D.prototype.dropEntity = function (id) {
  const e = this.ents[id];
  if (!e || e.dead) return false;
  e.dead = true;
  this._pinOwn(id);
  for (const c of this.constraintsOn(id)) this.dropConstraint(c.id);
  for (const other of this.ents) {
    if (other.dead) continue;
    const uses = (other.k === KIND.LINE && (other.a === id || other.b === id))
      || (other.k === KIND.ARC && other.c === id)
      || (other.k === KIND.NURBS && other.base.indexOf(id) >= 0);
    if (uses) this.dropEntity(other.id);
  }
  return true;
};

// The report, without moving anything. Use it to show a live degree-of-freedom
// count while someone is still drawing.
Sketch3D.prototype.diagnose = function () {
  const free = this._free(), n = free.length;
  const m = this.rows();
  const x = Float64Array.from(this.x);
  const r = new Float64Array(m), scratch = new Float64Array(m), plus = new Float64Array(m);
  const J = new Float64Array(m * n);
  this.residuals(x, r);
  let f = 0;
  for (let i = 0; i < m; i++) f += r[i] * r[i];
  f = Math.sqrt(f);
  if (m && n) this._jac(x, free, J, m, scratch, plus);
  return this._report(x, free, J, m, f, 0, f <= 1e-7);
};

// ======================================================================
// serialisation
// ======================================================================
// A construction script rather than a memory dump: entity specs in creation
// order, then constraints with their refs already resolved. Replaying it
// rebuilds the same ids, which is what lets refs be plain numbers.
Sketch3D.prototype.toJSON = function () {
  return {
    sinterSketch3d: 1,
    scale: this.scale,
    entities: this.ents.map(e => {
      const g = this.get(e.id);
      switch (e.k) {
        case KIND.POINT: return { kind: e.k, x: g.x, y: g.y, z: g.z, fixed: g.fixed, dead: g.dead };
        case KIND.PARAM: return { kind: e.k, t: g.t, fixed: g.fixed, dead: g.dead };
        case KIND.LINE: return { kind: e.k, a: e.a, b: e.b, dead: g.dead,
                                 construction: g.construction };
        case KIND.ARC: return { kind: e.k, c: e.c, rx: g.rx, ry: g.ry, rot: g.rot,
                                t0: g.t0, t1: g.t1, construction: g.construction,
                                fixed: this.fixed[e.vrx], dead: g.dead };
        case KIND.NURBS: return { kind: e.k, ctrl: g.ctrl, weights: g.weights,
                                  degree: g.degree, closed: g.closed, dead: g.dead,
                                  construction: g.construction };
        default: return { kind: e.k, dead: g.dead };
      }
    }),
    constraints: this.cons.map(c => ({ kind: c.kind, a: c.a, b: c.b, value: c.v }))
  };
};

Sketch3D.fromJSON = function (o) {
  if (!o || o.sinterSketch3d !== 1)
    throw new Error('not a SinterSketch3D document (want sinterSketch3d: 1)');
  const S = new Sketch3D({ scale: o.scale });
  for (const s of o.entities) {
    let id;
    switch (s.kind) {
      case KIND.POINT: id = S.point(s.x, s.y, s.z, { fixed: s.fixed }); break;
      case KIND.PARAM: id = S.param(s.t, { fixed: s.fixed }); break;
      case KIND.LINE: id = S.line(s.a, s.b, { construction: s.construction }); break;
      case KIND.ARC: id = S.arc(s.c, s.rx, s.ry, s.rot, s.t0, s.t1,
                                { fixed: s.fixed, construction: s.construction }); break;
      case KIND.NURBS: id = S.nurbs(s.ctrl, { weights: s.weights, degree: s.degree,
                                              closed: s.closed,
                                              construction: s.construction }); break;
      default: throw new Error(`unknown entity kind: ${s.kind}`);
    }
    if (s.dead) S.ents[id].dead = true;
  }
  // addConstraint, not constrain: the refs are already resolved, and inferring
  // again here would mint a second set of contact parameters.
  for (const c of o.constraints) S.addConstraint(c.kind, c.a, c.b, c.value);
  return S;
};

// ======================================================================
// profiles — turning a solved sketch into something you can extrude
// ======================================================================
// A sketch that solves is not yet a profile, and in space there is a second
// thing to be true as well as the first.
//
// The first is the 2D one: curves that look joined on screen are four
// disconnected pieces in memory unless their ends are constrained together, so
// closing a profile is a modelling act rather than a rendering one.
//
// The second is new here: a closed loop bounds an area only if it is planar,
// and nothing about closing it makes it so. Three lines always are; four
// rarely are unless someone said so. So loops carry the plane they were found
// in, planarity is measured rather than assumed, and the ones that fail come
// back separately instead of being quietly flattened.

const CURVE_KINDS = [KIND.LINE, KIND.ARC, KIND.NURBS];

// Newell's normal: robust for a polygon that is only nearly planar, and its
// length is twice the area, which is the number the containment test wants.
function newell(poly) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx / 2, ny / 2, nz / 2];
}

// The plane of a closed polygon, and how far from it the polygon strays.
function planeOf(poly) {
  const n = newell(poly);
  const area = len3(n);
  if (!(area > 1e-12)) return null;               // degenerate: no plane at all
  // + 0 turns a -0 component into 0, so a normal reads [0, 0, 1] rather
  // than [-0, 0, 1] wherever one of these is shown to a person.
  const N = [n[0] / area + 0, n[1] / area + 0, n[2] / area + 0];
  let o = [0, 0, 0];
  for (const p of poly) { o[0] += p[0]; o[1] += p[1]; o[2] += p[2]; }
  o = [o[0] / poly.length, o[1] / poly.length, o[2] / poly.length];
  let dev = 0;
  for (const p of poly) dev = Math.max(dev, Math.abs(dot3(N, sub3(p, o))));
  return { origin: o, normal: N, area, deviation: dev };
}

// Which way a face's normal points is arbitrary -- a flat loop has two sides
// and nothing in the sketch prefers one. Arbitrary is fine; *unpredictable* is
// not, because `extrude` runs along it. So it is pinned to a convention: the
// first of z, y, x that is not zero comes out positive, which makes a sketch
// drawn in the XY plane extrude upwards, the way the rest of the kernel means
// +Z.
function orientNormal(n) {
  for (const i of [2, 1, 0])
    if (Math.abs(n[i]) > 1e-9) return n[i] > 0 ? n : n.map(v => (v === 0 ? 0 : -v));
  return n;
}

function pointInPoly(poly, p) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][1], yj = poly[j][1];
    if ((yi > p[1]) !== (yj > p[1])) {
      const xx = poly[i][0] + (p[1] - yi) / (yj - yi) * (poly[j][0] - poly[i][0]);
      if (p[0] < xx) inside = !inside;
    }
  }
  return inside;
}

function signedArea(poly) {
  let A = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    A += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return A / 2;
}

// Walk the coincidence graph and return the closed loops, each as an ordered
// list of { id, reversed }, grouped into the planes they lie in. Ends that
// touch within `tol` are the same node.
//
// `planeTol` is how far a loop may stray from flat and still count as a face.
// It is separate from `tol` because they answer different questions -- one is
// "do these two ends meet", the other "is this thing flat" -- and a sketch
// that wants the second answered generously usually does not want the first.
Sketch3D.prototype.loops = function (tol, planeTol) {
  tol = tol || 1e-6;
  planeTol = planeTol === undefined ? 1e-6 : planeTol;
  // Construction geometry is scaffolding: it constrains the drawing without
  // being part of it, so it must not be walked into a loop.
  const curves = this.ents.filter(e => !e.dead && !e.construction
                                    && CURVE_KINDS.indexOf(e.k) >= 0);
  // cluster endpoints
  const nodes = [];
  const nodeOf = (p) => {
    for (let i = 0; i < nodes.length; i++)
      if (len3(sub3(nodes[i], p)) <= tol) return i;
    nodes.push([p[0], p[1], p[2]]);
    return nodes.length - 1;
  };
  const arcs = curves.map(e => {
    const a = nodeOf(this._pos(this.x, { e: e.id, end: 0 }));
    const b = nodeOf(this._pos(this.x, { e: e.id, end: 1 }));
    return { id: e.id, a, b, used: false };
  });
  const at = nodes.map(() => []);
  arcs.forEach((s, i) => { at[s.a].push(i); at[s.b].push(i); });

  const chains = [], open = [];
  for (const seed of arcs) {
    if (seed.used) continue;
    // a loop needs every node it passes through to have exactly two edges
    const chain = [];
    let cur = seed, from = seed.a, closed = false;
    while (cur && !cur.used) {
      cur.used = true;
      const reversed = from !== cur.a;
      chain.push({ id: cur.id, reversed });
      const to = reversed ? cur.a : cur.b;
      if (to === seed.a) { closed = true; break; }
      const nextIdx = at[to].filter(i => !arcs[i].used);
      if (at[to].length !== 2 || nextIdx.length !== 1) break;
      from = to;
      cur = arcs[nextIdx[0]];
    }
    (closed ? chains : open).push(chain);
  }

  // Measure each loop's plane. The coarse sampling here is only ever used for
  // the plane and the *sign* of the area -- a caller that wants the magnitude
  // gets it from profile(), measured on the polygon it is actually handed.
  const loops = chains.map(entities => {
    const poly = this._loopPoints(entities, 0.05);
    const pl = planeOf(poly);
    return { entities, poly,
             origin: pl ? pl.origin : null, normal: pl ? pl.normal : null,
             area: pl ? pl.area : 0,
             planar: !!pl && pl.deviation <= planeTol,
             deviation: pl ? pl.deviation : Infinity,
             face: -1, hole: false };
  });
  // Biggest first, so the loop that defines a face's normal is its outer one.
  loops.sort((p, q) => q.area - p.area);

  // Group the planar loops into faces. Two loops share a face when their
  // planes are the same plane: parallel normals (either way round -- a hole
  // runs the other way) and no offset between them.
  const faces = [];
  for (const l of loops) {
    if (!l.planar) continue;
    let hit = -1;
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      if (Math.abs(dot3(f.normal, l.normal)) < 1 - 1e-6) continue;
      if (Math.abs(dot3(f.normal, sub3(l.origin, f.origin))) > Math.max(planeTol, 1e-9)) continue;
      hit = i; break;
    }
    if (hit < 0) {
      const N = orientNormal(l.normal);
      const u = perpTo(N);
      faces.push({ origin: l.origin, normal: N, u, v: cross3(N, u), loops: [] });
      hit = faces.length - 1;
    }
    l.face = hit;
    faces[hit].loops.push(l);
  }

  // Within a face, orient by containment rather than by whichever way the walk
  // happened to go: a loop inside an odd number of others is a hole and runs
  // clockwise about the face normal, so its signed area is negative and the
  // areas sum to the material. This is the same even-odd rule the face
  // distance uses, so the two cannot disagree.
  for (const f of faces) {
    const uv = f.loops.map(l => this._project(f, l.poly));
    f.loops.forEach((l, i) => {
      let depth = 0;
      for (let j = 0; j < f.loops.length; j++)
        if (j !== i && pointInPoly(uv[j], uv[i][0])) depth++;
      l.hole = (depth % 2) === 1;
      l.sign = signedArea(uv[i]);
      const want = l.hole ? -1 : 1;
      if (Math.sign(l.sign) !== want) {
        l.entities.reverse();
        for (const st of l.entities) st.reversed = !st.reversed;
        l.poly.reverse();
        l.sign = -l.sign;
      }
    });
  }
  for (const l of loops) delete l.poly;
  return { loops, open, faces: faces.map(f => ({ origin: f.origin, normal: f.normal,
                                                 u: f.u, v: f.v,
                                                 loops: f.loops.map(l => loops.indexOf(l)) })) };
};

// A point in a face's plane, as the two in-plane coordinates. Out-of-plane
// error is dropped, which is exactly what the planarity check is for.
Sketch3D.prototype._project = function (face, poly) {
  return poly.map(p => {
    const w = sub3(p, face.origin);
    return [dot3(w, face.u), dot3(w, face.v)];
  });
};

Sketch3D.prototype._loopPoints = function (chain, tol) {
  const pts = [];
  for (const step of chain) {
    let seg = this.sample(step.id, tol);
    if (step.reversed) seg = seg.slice().reverse();
    for (const p of seg) {
      const last = pts[pts.length - 1];
      if (last && len3(sub3(last, p)) < 1e-9) continue;
      pts.push(p);
    }
  }
  const a = pts[0], b = pts[pts.length - 1];
  if (a && b && len3(sub3(a, b)) < 1e-9) pts.pop();
  return pts;
};

// Planar faces, biggest first: this is what feeds an extrude. Each face
// carries its plane, its loops as 3D polygons and as in-plane 2D ones, and
// the signed areas that sum to its material.
Sketch3D.prototype.profile = function (tol, planeTol) {
  tol = tol === undefined ? 0.05 : tol;
  const found = this.loops(1e-6, planeTol);
  const faces = found.faces.map(f => {
    const out = { origin: f.origin, normal: f.normal, u: f.u, v: f.v, loops: [], area: 0 };
    for (const li of f.loops) {
      const l = found.loops[li];
      const points = this._loopPoints(l.entities, tol);
      const uv = this._project(f, points);
      const area = signedArea(uv);
      out.loops.push({ points, uv, area, hole: l.hole, entities: l.entities });
      out.area += area;
    }
    return out;
  });
  faces.sort((p, q) => Math.abs(q.area) - Math.abs(p.area));
  const nonplanar = found.loops.filter(l => !l.planar).length;
  return {
    faces,
    open: found.open.length,     // chains that did not close: an unfinished profile
    nonplanar,                   // closed, but not flat: not a face either
    closed: found.open.length === 0 && nonplanar === 0 && faces.length > 0
  };
};

// ======================================================================
// distance fields, so a sketch can meet the rest of the kernel
// ======================================================================
// iq's polygon distance: nearest edge for the magnitude, a winding test for
// the sign. Holes come from the loops beyond the first -- a point inside an
// odd number of loops is solid. Exact, and 1-Lipschitz, which is what a
// raymarcher needs from anything it is handed.
function polygonSDF(loops, px, py) {
  let d = Infinity, inside = false;
  for (const poly of loops) {
    const n = poly.length;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ex = poly[j][0] - poly[i][0], ey = poly[j][1] - poly[i][1];
      const wx = px - poly[i][0], wy = py - poly[i][1];
      let t = (wx * ex + wy * ey) / (ex * ex + ey * ey + 1e-300);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const bx = wx - ex * t, by = wy - ey * t;
      const dd = bx * bx + by * by;
      if (dd < d) d = dd;
      const c1 = py >= poly[i][1], c2 = py < poly[j][1];
      if ((c1 && c2 && ex * wy > ey * wx) || (!c1 && !c2 && ex * wy < ey * wx))
        inside = !inside;
    }
  }
  return (inside ? -1 : 1) * Math.sqrt(d);
}

// A planar face given a thickness: the exact solid, in its own plane rather
// than in Z. Material runs from the plane along the face normal by `height`;
// a negative height goes the other way.
//
// This is the operator the 2D file left to its caller, and it is here because
// in space the direction is not obvious: an extrusion along Z of a face that
// is not in the XY plane is a shear, not an extrusion.
Sketch3D.prototype.extrude = function (face, height, tol) {
  if (typeof face === 'number') face = this.profile(tol).faces[face];
  if (!face || !face.loops || !face.loops.length)
    throw new Error('extrude wants a face from profile()');
  const polys = face.loops.map(l => l.uv);
  const o = face.origin, U = face.u, V = face.v, N = face.normal;
  const mid = height / 2, half = Math.abs(height) / 2;
  const f = (x, y, z) => {
    const wx = x - o[0], wy = y - o[1], wz = z - o[2];
    const a = polygonSDF(polys, wx * U[0] + wy * U[1] + wz * U[2],
                                wx * V[0] + wy * V[1] + wz * V[2]);
    const b = Math.abs(wx * N[0] + wy * N[1] + wz * N[2] - mid) - half;
    return Math.min(Math.max(a, b), 0) + Math.hypot(Math.max(a, 0), Math.max(b, 0));
  };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const l of face.loops)
    for (const p of l.points)
      for (const s of [0, height])
        for (let i = 0; i < 3; i++) {
          const c = p[i] + N[i] * s;
          if (c < lo[i]) lo[i] = c;
          if (c > hi[i]) hi[i] = c;
        }
  f.bounds = { lo, hi };
  f.area = face.area;
  f.exact = true;
  return f;
};

// Distance to a segment, which is all a wire is made of.
function segDist(a, b, px, py, pz) {
  const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
  const wx = px - a[0], wy = py - a[1], wz = pz - a[2];
  let t = (wx * ex + wy * ey + wz * ez) / (ex * ex + ey * ey + ez * ez + 1e-300);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(wx - ex * t, wy - ey * t, wz - ez * t);
}

// The drawn curves, given a radius: (x, y, z) -> signed distance in mm.
//
// There is no argument-free `sdf3d` in this file and that is deliberate. In
// the plane a closed profile *is* a region and its distance field needs
// nothing else; in space a wireframe has no interior, so the only honest
// solid it stands for is the one you get by giving it a thickness. Sampled
// once, so moving the sketch afterwards does not change it.
//
// Exact: the distance to a set of segments is a true distance, and
// subtracting a constant leaves it 1-Lipschitz.
Sketch3D.prototype.wire = function (radius, tol) {
  radius = radius === undefined ? 1 : radius;
  const segs = [];
  for (const e of this.ents) {
    if (e.dead || e.construction || CURVE_KINDS.indexOf(e.k) < 0) continue;
    const pts = this.sample(e.id, tol);
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
  }
  const f = (x, y, z) => {
    let d = Infinity;
    for (let i = 0; i < segs.length; i++) {
      const s = segDist(segs[i][0], segs[i][1], x, y, z);
      if (s < d) d = s;
    }
    return d - radius;
  };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const s of segs)
    for (const p of s)
      for (let i = 0; i < 3; i++) {
        if (p[i] - radius < lo[i]) lo[i] = p[i] - radius;
        if (p[i] + radius > hi[i]) hi[i] = p[i] + radius;
      }
  f.bounds = segs.length ? { lo, hi } : null;
  f.segments = segs.length;
  f.radius = radius;
  f.exact = true;
  return f;
};

const CONSTRAINT_KINDS = Object.keys(CONSTRAINTS);

const SinterSketch3D = { Sketch3D, Sketch: Sketch3D, CONSTRAINTS, CONSTRAINT_KINDS, KIND,
                         polygonSDF, planeOf, newell, frameOf, findSpan, dersBasisFuns,
                         rankOf };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterSketch3D;
root.SinterSketch3D = SinterSketch3D;
})(typeof self !== 'undefined' ? self : globalThis);
