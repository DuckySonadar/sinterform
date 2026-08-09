/* SinterForm sketch - a constrained 2D sketcher
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lines, elliptical arcs and NURBS, plus the constraints that hold them
 * together. No DOM, no GL, no storage -- same charter as the rest of the
 * kernel, and it runs under node, which is how it is tested.
 *
 * ----------------------------------------------------------------------
 * The one idea worth knowing before reading any of this
 * ----------------------------------------------------------------------
 * A constraint that touches a curve needs to know *where* on the curve it
 * touches, and that location is not knowable in advance -- it moves as the
 * sketch solves. "Perpendicular to this spline" is not a complete sentence;
 * "perpendicular to this spline's tangent, at the point where they meet" is,
 * and the meeting point is an unknown like any other.
 *
 * So a contact parameter is a solver variable here, exactly like an x or a y.
 * That one decision is why `perpendicular` in this file takes any two
 * direction sources -- a line, or a tangent at a parameter -- and does not
 * care which is which. Line to line, line to arc, arc to spline, spline to
 * spline all go through the same three lines of code.
 *
 * Sketchers that keep the contact point implicit cannot do that. They end up
 * offering perpendicular between two lines, special-casing "perpendicular to
 * a circle" as "passes through the centre", and leaving splines out.
 *
 * ----------------------------------------------------------------------
 * References
 * ----------------------------------------------------------------------
 * A `ref` names something a constraint can talk about:
 *
 *   { p: id }            a point entity
 *   { e: id }            a whole entity -- a line's direction, an arc's
 *                        centre, a curve's size
 *   { e: id, t: paramId} a location on an entity, at a solved parameter:
 *                        both a position and a tangent direction
 *
 * Anything that has a direction is a *direction source*: { e: lineId } or
 * { e: anyId, t }. Anything that has a position is a *point source*:
 * { p: id } or { e: anyId, t }.
 */
(function (root) {
"use strict";

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

// Numerical rank by row echelon. This is what turns "the solve finished"
// into "and here is how many degrees of freedom are left, and whether any of
// your constraints were saying the same thing twice".
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
// The NURBS Book's findSpan / dersBasisFuns, which is the reliable way to
// get a tangent out of a spline. Everything else here could be done with
// finite differences; a tangent that goes into a residual cannot, because
// the solver differentiates the residual again and the noise compounds.
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
// tangent needs. `a` is the two-row scratch the algorithm ping-pongs between.
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
// Every solvable number lives in one flat array. An entity owns a slice of
// it and nothing else owns anything, which is what lets the solver be
// completely ignorant of what a "line" is.
const KIND = { POINT: 'point', LINE: 'line', ARC: 'arc', NURBS: 'nurbs', PARAM: 'param' };

function Sketch(opts) {
  this.ents = [];
  this.cons = [];
  this.x = [];              // the variable vector
  this.fixed = [];          // parallel to x: true means the solver may not move it
  // Angular residuals are dimensionless and positional ones are millimetres.
  // Mixing them in one least-squares makes the conditioning depend on how big
  // the sketch happens to be, so the dimensionless ones are multiplied up to
  // millimetres by this. It is a scale, not a tolerance.
  this.scale = (opts && opts.scale) || 10;
}

Sketch.prototype._var = function (v, fixed) {
  this.x.push(v);
  this.fixed.push(!!fixed);
  return this.x.length - 1;
};

Sketch.prototype.point = function (x, y, o) {
  const f = !!(o && o.fixed);
  const e = { k: KIND.POINT, id: this.ents.length, vx: this._var(x, f), vy: this._var(y, f) };
  this.ents.push(e);
  return e.id;
};

// A free scalar: a contact parameter, or anything else you want solved.
Sketch.prototype.param = function (v, o) {
  const e = { k: KIND.PARAM, id: this.ents.length, v: this._var(v, !!(o && o.fixed)) };
  this.ents.push(e);
  return e.id;
};

Sketch.prototype.line = function (a, b, o) {
  const e = { k: KIND.LINE, id: this.ents.length, a, b,
              construction: !!(o && o.construction) };
  this.ents.push(e);
  return e.id;
};

// Elliptical arc. rx == ry is a circular arc; t0/t1 spanning 2pi is a full
// ellipse. `phi` tilts it. t is the eccentric parameter, not the polar angle.
Sketch.prototype.arc = function (c, rx, ry, phi, t0, t1, o) {
  const f = !!(o && o.fixed);
  const e = {
    k: KIND.ARC, id: this.ents.length, c,
    construction: !!(o && o.construction),
    vrx: this._var(rx, f), vry: this._var(ry === undefined ? rx : ry, f),
    vphi: this._var(phi || 0, f),
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
Sketch.prototype.nurbs = function (ctrl, o) {
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

Sketch.prototype.fix = function (id, on) {
  const e = this.ents[id];
  const set = (v) => { this.fixed[v] = on === undefined ? true : !!on; };
  if (e.k === KIND.POINT) { set(e.vx); set(e.vy); }
  else if (e.k === KIND.PARAM) set(e.v);
  else if (e.k === KIND.ARC) { set(e.vrx); set(e.vry); set(e.vphi); set(e.vt0); set(e.vt1); this.fix(e.c, on); }
  else if (e.k === KIND.LINE) { this.fix(e.a, on); this.fix(e.b, on); }
  else if (e.k === KIND.NURBS) e.base.forEach(c => this.fix(c, on));
  return id;
};

// Scaffolding: geometry that constrains the drawing without being part of it.
// A centreline, a bounding circle, an axis to measure an angle against --
// every sketcher needs them, and a profile must not walk into one.
Sketch.prototype.construction = function (id, on) {
  const e = this.ents[id];
  if (!e) throw new Error(`no entity ${id}`);
  e.construction = on === undefined ? true : !!on;
  return id;
};

// ======================================================================
// evaluation — position and tangent, from one entry point
// ======================================================================
Sketch.prototype.ptOf = function (x, id) {
  const e = this.ents[id];
  return [x[e.vx], x[e.vy]];
};

// Position and first derivative of entity `id` at parameter t.
Sketch.prototype.evalAt = function (x, id, t) {
  const e = this.ents[id];
  if (e.k === KIND.LINE) {
    const a = this.ptOf(x, e.a), b = this.ptOf(x, e.b);
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
             d: [b[0] - a[0], b[1] - a[1]] };
  }
  if (e.k === KIND.ARC) {
    const c = this.ptOf(x, e.c);
    const rx = x[e.vrx], ry = x[e.vry], ph = x[e.vphi];
    const C = Math.cos(ph), S = Math.sin(ph);
    const ct = Math.cos(t), st = Math.sin(t);
    const lx = rx * ct, ly = ry * st;
    const dx = -rx * st, dy = ry * ct;
    return { p: [c[0] + C * lx - S * ly, c[1] + S * lx + C * ly],
             d: [C * dx - S * dy, S * dx + C * dy] };
  }
  if (e.k === KIND.NURBS) {
    const p = e.p, U = e.U, n = e.n;
    const u = Math.min(Math.max(t, U[p]), U[n + 1]);
    const span = findSpan(n, p, u, U);
    const N = dersBasisFuns(span, u, p, U);
    let ax = 0, ay = 0, aw = 0, bx = 0, by = 0, bw = 0;
    for (let j = 0; j <= p; j++) {
      const idx = span - p + j;
      const P = this.ptOf(x, e.ctrl[idx]), w = e.w[idx];
      const n0 = N[0][j], n1 = N[1][j];
      ax += n0 * w * P[0]; ay += n0 * w * P[1]; aw += n0 * w;
      bx += n1 * w * P[0]; by += n1 * w * P[1]; bw += n1 * w;
    }
    const W = aw || 1e-300;
    return { p: [ax / W, ay / W],
             d: [(bx * W - ax * bw) / (W * W), (by * W - ay * bw) / (W * W)] };
  }
  throw new Error(`entity ${id} (${e.k}) has no parameterisation`);
};

// The centre of a thing. An arc's centre point; a line's midpoint, because
// that is what someone means when they drop a centre mark on a line.
Sketch.prototype.centreOf = function (x, id) {
  const e = this.ents[id];
  if (e.k === KIND.ARC) return this.ptOf(x, e.c);
  if (e.k === KIND.LINE) {
    const a = this.ptOf(x, e.a), b = this.ptOf(x, e.b);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  if (e.k === KIND.POINT) return this.ptOf(x, id);
  throw new Error(`entity ${id} (${e.k}) has no centre`);
};

// ---- resolving refs ---------------------------------------------------
// Unit tangent, and the normal that goes with it. `normalAt` is here because
// the constraint that motivated this file is easier to *check* than to state:
// a line perpendicular to a curve's tangent runs along its normal.
Sketch.prototype.tangentAt = function (id, t) {
  const d = this.evalAt(this.x, id, t).d;
  const l = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / l, d[1] / l];
};
Sketch.prototype.normalAt = function (id, t) {
  const u = this.tangentAt(id, t);
  return [-u[1], u[0]];
};

// Resolve a ref to a position or a direction, against the current solution.
// These are the two questions the constraints themselves ask, so anything
// built on this file will want to ask them too -- to draw a glyph where a
// constraint bites, or to check one independently.
Sketch.prototype.posOf = function (r) { return this._pos(this.x, r); };
Sketch.prototype.dirOf = function (r) { return this._dir(this.x, r); };

// The parameter at a curve's drawn end. A contact parameter is a variable the
// solver moves; this is where the curve *stops being drawn*, which is a
// different thing and is what a profile is built out of.
Sketch.prototype._endParam = function (x, id, end) {
  const e = this.ents[id];
  if (e.k === KIND.LINE) return end ? 1 : 0;
  if (e.k === KIND.ARC) return end ? x[e.vt1] : x[e.vt0];
  if (e.k === KIND.NURBS) return end ? e.U[e.n + 1] : e.U[e.p];
  throw new Error(`entity ${id} (${e.k}) has no ends`);
};

Sketch.prototype._pos = function (x, r) {
  if (r.p !== undefined) return this.ptOf(x, r.p);
  if (r.e !== undefined && r.t !== undefined)
    return this.evalAt(x, r.e, x[this.ents[r.t].v]).p;
  if (r.e !== undefined && r.end !== undefined)
    return this.evalAt(x, r.e, this._endParam(x, r.e, r.end)).p;
  if (r.e !== undefined && this.ents[r.e].k === KIND.POINT) return this.ptOf(x, r.e);
  throw new Error('ref has no position — a curve needs {t} or {end}');
};

Sketch.prototype._dir = function (x, r) {
  if (r.e !== undefined && r.t !== undefined)
    return this.evalAt(x, r.e, x[this.ents[r.t].v]).d;
  if (r.e !== undefined && r.end !== undefined)
    return this.evalAt(x, r.e, this._endParam(x, r.e, r.end)).d;
  if (r.e !== undefined && this.ents[r.e].k === KIND.LINE) {
    const e = this.ents[r.e];
    const a = this.ptOf(x, e.a), b = this.ptOf(x, e.b);
    return [b[0] - a[0], b[1] - a[1]];
  }
  throw new Error('ref has no direction — a curve needs {t} or {end}');
};

// ======================================================================
// constraints
// ======================================================================
// Each returns its residuals, which are zero exactly when it is satisfied.
// Angular ones are normalised and scaled to millimetres so that one badly
// conditioned row cannot dominate the least-squares.
const CONSTRAINTS = {
  // two locations are the same point
  coincident: { n: 2, f(S, x, c, out) {
    const a = S._pos(x, c.a), b = S._pos(x, c.b);
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1];
  } },

  // two curves share a centre
  concentric: { n: 2, f(S, x, c, out) {
    const a = S.centreOf(x, c.a.e), b = S.centreOf(x, c.b.e);
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1];
  } },

  // a point sits at a thing's centre (an arc's centre, a line's midpoint)
  centre: { n: 2, f(S, x, c, out) {
    const p = S._pos(x, c.a), q = S.centreOf(x, c.b.e);
    out[0] = p[0] - q[0]; out[1] = p[1] - q[1];
  } },

  // Two lines lying on one infinite line: same direction, and the second's
  // start displaced from the first's by nothing across that direction.
  collinear: { n: 2, f(S, x, c, out) {
    const ea = S.ents[c.a.e], eb = S.ents[c.b.e];
    if (ea.k !== KIND.LINE || eb.k !== KIND.LINE)
      throw new Error('collinear wants two lines');
    const p1 = S.ptOf(x, ea.a), q1 = S.ptOf(x, ea.b);
    const p2 = S.ptOf(x, eb.a), q2 = S.ptOf(x, eb.b);
    const d1 = [q1[0] - p1[0], q1[1] - p1[1]];
    const d2 = [q2[0] - p2[0], q2[1] - p2[1]];
    const l1 = Math.hypot(d1[0], d1[1]) || 1e-300;
    const l2 = Math.hypot(d2[0], d2[1]) || 1e-300;
    out[0] = (d1[0] * d2[1] - d1[1] * d2[0]) / (l1 * l2) * S.scale;
    out[1] = (d1[0] * (p2[1] - p1[1]) - d1[1] * (p2[0] - p1[0])) / l1;
  } },

  parallel: { n: 1, f(S, x, c, out) {
    const d1 = S._dir(x, c.a), d2 = S._dir(x, c.b);
    const l1 = Math.hypot(d1[0], d1[1]) || 1e-300;
    const l2 = Math.hypot(d2[0], d2[1]) || 1e-300;
    out[0] = (d1[0] * d2[1] - d1[1] * d2[0]) / (l1 * l2) * S.scale;
  } },

  // The headline. Both sides are direction sources, and a direction source is
  // a line or a tangent. Nothing here knows or cares which.
  perpendicular: { n: 1, f(S, x, c, out) {
    const d1 = S._dir(x, c.a), d2 = S._dir(x, c.b);
    const l1 = Math.hypot(d1[0], d1[1]) || 1e-300;
    const l2 = Math.hypot(d2[0], d2[1]) || 1e-300;
    out[0] = (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2) * S.scale;
  } },

  // touching, with tangents in line. Three residuals against the two contact
  // parameters it introduces, so it removes one degree of freedom -- which is
  // what tangency is worth.
  tangent: { n: 3, f(S, x, c, out) {
    const A = S.evalAt(x, c.a.e, x[S.ents[c.a.t].v]);
    const B = S.evalAt(x, c.b.e, x[S.ents[c.b.t].v]);
    out[0] = A.p[0] - B.p[0];
    out[1] = A.p[1] - B.p[1];
    const l1 = Math.hypot(A.d[0], A.d[1]) || 1e-300;
    const l2 = Math.hypot(B.d[0], B.d[1]) || 1e-300;
    out[2] = (A.d[0] * B.d[1] - A.d[1] * B.d[0]) / (l1 * l2) * S.scale;
  } },

  // lines: equal length (one equation). arcs: equal semi-axes (two), because
  // two ellipses being "equal" is a statement about both axes.
  equal: { n: (S, a, b) => (S.ents[a.e].k === KIND.ARC && S.ents[b.e].k === KIND.ARC ? 2 : 1),
    f(S, x, c, out) {
    const ea = S.ents[c.a.e], eb = S.ents[c.b.e];
    if (ea.k === KIND.LINE && eb.k === KIND.LINE) {
      const a0 = S.ptOf(x, ea.a), a1 = S.ptOf(x, ea.b);
      const b0 = S.ptOf(x, eb.a), b1 = S.ptOf(x, eb.b);
      out[0] = Math.hypot(a1[0] - a0[0], a1[1] - a0[1])
             - Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
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
  // answer by squashing the arc instead of moving it -- which is a correct
  // solve of a sketch nobody meant to draw.
  circular: { n: 1, f(S, x, c, out) {
    const e = S.ents[c.a.e];
    if (e.k !== KIND.ARC) throw new Error('circular wants an arc');
    out[0] = x[e.vrx] - x[e.vry];
  } },

  // dimensional, because a sketch that cannot be given a size is a drawing
  distance: { n: 1, f(S, x, c, out) {
    const a = S._pos(x, c.a), b = S._pos(x, c.b);
    out[0] = Math.hypot(b[0] - a[0], b[1] - a[1]) - c.v;
  } },
  radius: { n: 1, f(S, x, c, out) {
    out[0] = x[S.ents[c.a.e].vrx] - c.v;
  } },
  // An ellipse has two semi-axes; `radius` only ever reached the first.
  radiusY: { n: 1, f(S, x, c, out) {
    out[0] = x[S.ents[c.a.e].vry] - c.v;
  } },
  angle: { n: 1, f(S, x, c, out) {
    const d1 = S._dir(x, c.a), d2 = S._dir(x, c.b);
    const cr = d1[0] * d2[1] - d1[1] * d2[0], dt = d1[0] * d2[0] + d1[1] * d2[1];
    let a = Math.atan2(cr, dt) - c.v;
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    out[0] = a * S.scale;
  } },
  // point stays on a curve, without pinning where
  on: { n: 2, f(S, x, c, out) {
    const p = S._pos(x, c.a);
    const q = S.evalAt(x, c.b.e, x[S.ents[c.b.t].v]).p;
    out[0] = p[0] - q[0]; out[1] = p[1] - q[1];
  } },
  // horizontal / vertical, the two everyone reaches for first
  horizontal: { n: 1, f(S, x, c, out) {
    const d = S._dir(x, c.a);
    out[0] = d[1] / (Math.hypot(d[0], d[1]) || 1e-300) * S.scale;
  } },
  vertical: { n: 1, f(S, x, c, out) {
    const d = S._dir(x, c.a);
    out[0] = d[0] / (Math.hypot(d[0], d[1]) || 1e-300) * S.scale;
  } }
};

// The parameter range worth searching, and a point that stands for the whole
// entity when nothing better is known.
Sketch.prototype._range = function (id) {
  const e = this.ents[id];
  if (e.k === KIND.LINE) return [0, 1];
  if (e.k === KIND.ARC) return [this.x[e.vt0], this.x[e.vt1]];
  if (e.k === KIND.NURBS) return [e.U[e.p], e.U[e.n + 1]];
  return [0, 1];
};

Sketch.prototype._repr = function (id) {
  const e = this.ents[id];
  if (e.k === KIND.POINT) return this.ptOf(this.x, id);
  if (e.k === KIND.ARC) return this.ptOf(this.x, e.c);
  const [u0, u1] = this._range(id);
  return this.evalAt(this.x, id, (u0 + u1) / 2).p;
};

// Coarse closest-point-on-entity search. Coarse is the right word: it only
// has to land in the right basin, and the solver refines from there.
Sketch.prototype._closestParam = function (id, target) {
  const [u0, u1] = this._range(id);
  let best = u0, bd = Infinity;
  for (let i = 0; i <= 64; i++) {
    const t = u0 + (u1 - u0) * i / 64;
    const p = this.evalAt(this.x, id, t).p;
    const d = (p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
};

// Tangency needs a contact parameter on each side. If the caller did not
// supply one, make it -- and hand back the id, so it shows up in the
// degree-of-freedom count rather than hiding there.
//
// Where those parameters *start* decides which answer comes back, and this is
// the whole ball game. Tangency is two-valued for a pair of circles: one
// solution has them side by side, the other has the small one nested inside
// the large one, and both satisfy "touching, with tangents in line" exactly.
// Starting both parameters at zero puts every contact at its curve's
// rightmost point with both tangents pointing the same way, which is the
// nested basin -- so three circles asked to touch each other would reliably
// converge to three nested circles, from any starting layout.
//
// Aiming each contact at the other entity first, and then refining once
// against where that landed, picks the basin someone drawing it would have
// meant. It is still two-valued; this only chooses the near answer.
Sketch.prototype._tangentParams = function (A, B) {
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

Sketch.prototype._needParam = function (r, target) {
  if (r.t !== undefined || r.p !== undefined) return r;
  const e = this.ents[r.e];
  if (e.k === KIND.POINT) return r;
  const [u0, u1] = this._range(r.e);
  const t = target ? this._closestParam(r.e, target) : (u0 + u1) / 2;
  return { e: r.e, t: this.param(t) };
};

Sketch.prototype.constrain = function (kind, a, b, v) {
  const C = CONSTRAINTS[kind];
  if (!C) throw new Error(`no such constraint: ${kind}`);
  const norm = (r) => (typeof r === 'number' ? { e: r } : r);
  let A = norm(a), B = b === undefined ? undefined : norm(b);
  if (kind === 'tangent') [A, B] = this._tangentParams(A, B);
  if (kind === 'on') B = this._needParam(B, A.p !== undefined ? this.ptOf(this.x, A.p) : null);
  return this.addConstraint(kind, A, B, v);
};

// The same thing with nothing inferred: refs are taken exactly as given, and
// no contact parameters are invented. `constrain` is the ergonomic door;
// this is the one deserialisation comes through, because a round trip must
// not quietly mint a second set of parameters for a tangency that already
// has them.
Sketch.prototype.addConstraint = function (kind, a, b, v) {
  const C = CONSTRAINTS[kind];
  if (!C) throw new Error(`no such constraint: ${kind}`);
  const c = { kind, a, b, v, id: this._cid = (this._cid || 0) + 1,
              n: typeof C.n === 'function' ? C.n(this, a, b) : C.n, f: C.f };
  this.cons.push(c);
  return c;
};

// ======================================================================
// the solve
// ======================================================================
Sketch.prototype.residuals = function (x, out) {
  let k = 0;
  const tmp = [0, 0, 0];
  for (const c of this.cons) {
    tmp[0] = tmp[1] = tmp[2] = 0;
    c.f(this, x, c, tmp);
    for (let i = 0; i < c.n; i++) out[k++] = tmp[i];
  }
  return k;
};

Sketch.prototype._free = function () {
  const idx = [];
  for (let i = 0; i < this.x.length; i++) if (!this.fixed[i]) idx.push(i);
  return idx;
};

// Levenberg-Marquardt, one iteration at a time. Gauss-Newton alone walks off
// a cliff the moment a sketch is near-singular, which is most of the
// interesting ones.
//
// The loop belongs to the caller. `solver()` hands back something that can be
// advanced one step, and `solve()` below is nothing but a `while` around it --
// which is the right way round for a kernel: it should be *called*, not run.
// Owning the loop would mean owning the answers to questions that are not
// geometry's to answer. How long may this block for? May the user cancel it?
// Should the sketch be redrawn while it settles? A caller with a hand on the
// step can answer all three; one handed a function that returns when it feels
// like it can answer none.
//
// Each accepted step writes back to the sketch, so a consumer can read the
// geometry between steps and draw it.
Sketch.prototype.solver = function (opts) {
  opts = opts || {};
  const S = this;
  const tol = opts.tol || 1e-9;
  const maxIter = opts.maxIter === undefined ? 200 : opts.maxIter;
  const free = S._free();
  const n = free.length;
  const m = S.cons.reduce((s, c) => s + c.n, 0);
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
      // diag(J'J).
      //
      // Per-coordinate damping is the textbook choice and it is the wrong one
      // here. A sketch is nearly always rank-deficient (four coordinates, one
      // constraint), and scaling the damping by each diagonal entry means the
      // directions with the least curvature get the least damping, so the step
      // runs furthest exactly where it knows least. Asked to make two lines
      // perpendicular it would return a step that stretched one of them to
      // 500 mm instead of rotating it, and then converge linearly at a third
      // per iteration because the gradient weakens as the line grows.
      //
      // One number for the whole matrix keeps the step near the minimum-norm
      // Newton step, which solves that case exactly, in one iteration.
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
Sketch.prototype.solve = function (opts) {
  const run = this.solver(opts);
  while (!run.step().done) { /* the caller's loop, kept short */ }
  return run.report();
};

// Central differences. The residuals contain atan2 and normalised cross
// products; one-sided differences on those lose more than they save.
Sketch.prototype._jac = function (x, free, J, m, scratch, plus) {
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

Sketch.prototype._report = function (x, free, J, m, f, iter, converged) {
  const n = free.length;
  const rank = m && n ? rankOf(J, m, n, 1e-8) : 0;
  return {
    converged,
    residual: f,
    iterations: iter,
    variables: n,          // free variables, contact parameters included
    equations: m,
    rank,
    dof: n - rank,         // 0 means fully constrained
    redundant: m - rank,   // constraints that said something already said
    // Converged with leftover equations means they agreed. Not converged
    // means they did not, and that is the honest word for it.
    conflicting: !converged && m - rank > 0
  };
};

// ======================================================================
// sampling — what the rest of the kernel will want
// ======================================================================
// Polyline per entity. Arcs get enough segments for the sagitta to fall under
// `tol`; splines get a fixed density, which is honest about being a guess.
Sketch.prototype.sample = function (id, tol) {
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

// ======================================================================
// reading and editing a sketch from outside
// ======================================================================
// Everything solvable lives in one flat array, and where each entity's
// numbers sit in it is nobody else's business. These are the accessors that
// make that true -- without them the first thing anyone writes is
// `S.x[S.ents[id].vrx]`, and then the layout can never change again.

// A plain snapshot. No live references into the sketch: change it freely.
Sketch.prototype.get = function (id) {
  const e = this.ents[id];
  if (!e) throw new Error(`no entity ${id}`);
  const F = (v) => this.fixed[v];
  switch (e.k) {
    case KIND.POINT:
      return { id, kind: e.k, dead: !!e.dead, x: this.x[e.vx], y: this.x[e.vy],
               fixed: F(e.vx) && F(e.vy) };
    case KIND.PARAM:
      return { id, kind: e.k, dead: !!e.dead, t: this.x[e.v], fixed: F(e.v) };
    case KIND.LINE:
      return { id, kind: e.k, dead: !!e.dead, construction: !!e.construction, a: e.a, b: e.b,
               from: this.ptOf(this.x, e.a), to: this.ptOf(this.x, e.b) };
    case KIND.ARC:
      return { id, kind: e.k, dead: !!e.dead, construction: !!e.construction, c: e.c,
               centre: this.ptOf(this.x, e.c),
               rx: this.x[e.vrx], ry: this.x[e.vry], phi: this.x[e.vphi],
               t0: this.x[e.vt0], t1: this.x[e.vt1],
               circular: Math.abs(this.x[e.vrx] - this.x[e.vry]) < 1e-9 };
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
Sketch.prototype.set = function (id, vals) {
  const e = this.ents[id];
  if (!e) throw new Error(`no entity ${id}`);
  const put = (slot, v) => { if (typeof v === 'number') this.x[slot] = v; };
  if (e.k === KIND.POINT) { put(e.vx, vals.x); put(e.vy, vals.y); }
  else if (e.k === KIND.PARAM) put(e.v, vals.t);
  else if (e.k === KIND.ARC) {
    put(e.vrx, vals.rx); put(e.vry, vals.ry); put(e.vphi, vals.phi);
    put(e.vt0, vals.t0); put(e.vt1, vals.t1);
  }
  if (vals.fixed !== undefined) this.fix(id, vals.fixed);
  return id;
};

Sketch.prototype.entities = function (kind) {
  const out = [];
  for (const e of this.ents)
    if (!e.dead && (!kind || e.k === kind)) out.push(this.get(e.id));
  return out;
};

Sketch.prototype.constraints = function () {
  return this.cons.map(c => ({ id: c.id, kind: c.kind, a: c.a, b: c.b,
                               value: c.v, equations: c.n }));
};

// Which constraints mention an entity -- what a UI needs to grey out a
// delete, or to explain why something will not move.
Sketch.prototype.constraintsOn = function (id) {
  const hits = (r) => !!r && (r.p === id || r.e === id || r.t === id);
  return this.cons.filter(c => hits(c.a) || hits(c.b))
                  .map(c => ({ id: c.id, kind: c.kind }));
};

Sketch.prototype.dropConstraint = function (ref) {
  const id = typeof ref === 'object' ? ref.id : ref;
  const before = this.cons.length;
  this.cons = this.cons.filter(c => c.id !== id);
  return this.cons.length < before;
};

// Entity ids are indices, so an entity cannot be spliced out without
// invalidating every id after it. It is retired instead: its variables are
// pinned so they leave the degree-of-freedom count, everything that referred
// to it is dropped, and the id stays burnt. Round-trip through toJSON to
// compact.
// Pin only the numbers this entity owns. `fix` deliberately reaches through
// to an entity's points, because pinning a line means pinning its ends -- but
// retiring one must not, or dropping a line would pin the points it happened
// to share with the lines still standing.
Sketch.prototype._pinOwn = function (id) {
  const e = this.ents[id];
  const set = (v) => { this.fixed[v] = true; };
  if (e.k === KIND.POINT) { set(e.vx); set(e.vy); }
  else if (e.k === KIND.PARAM) set(e.v);
  else if (e.k === KIND.ARC) { set(e.vrx); set(e.vry); set(e.vphi); set(e.vt0); set(e.vt1); }
};

Sketch.prototype.dropEntity = function (id) {
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
Sketch.prototype.diagnose = function () {
  const free = this._free(), n = free.length;
  const m = this.cons.reduce((s, c) => s + c.n, 0);
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
Sketch.prototype.toJSON = function () {
  return {
    sinterSketch: 1,
    scale: this.scale,
    entities: this.ents.map(e => {
      const g = this.get(e.id);
      switch (e.k) {
        case KIND.POINT: return { kind: e.k, x: g.x, y: g.y, fixed: g.fixed, dead: g.dead };
        case KIND.PARAM: return { kind: e.k, t: g.t, fixed: g.fixed, dead: g.dead };
        case KIND.LINE: return { kind: e.k, a: e.a, b: e.b, dead: g.dead,
                                 construction: g.construction };
        case KIND.ARC: return { kind: e.k, c: e.c, rx: g.rx, ry: g.ry, phi: g.phi,
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

Sketch.fromJSON = function (o) {
  if (!o || o.sinterSketch !== 1)
    throw new Error('not a SinterSketch document (want sinterSketch: 1)');
  const S = new Sketch({ scale: o.scale });
  for (const s of o.entities) {
    let id;
    switch (s.kind) {
      case KIND.POINT: id = S.point(s.x, s.y, { fixed: s.fixed }); break;
      case KIND.PARAM: id = S.param(s.t, { fixed: s.fixed }); break;
      case KIND.LINE: id = S.line(s.a, s.b, { construction: s.construction }); break;
      case KIND.ARC: id = S.arc(s.c, s.rx, s.ry, s.phi, s.t0, s.t1,
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
// A sketch that solves is not yet a profile, and the difference is invisible
// when you draw it. Four curves that are mutually tangent look exactly like a
// closed slot on screen while being four disconnected pieces in memory: the
// lines run past where they touch, the arcs are drawn over whatever extent
// they were created with, and nothing says which end joins which.
//
// So closing a profile is a *modelling* act, not a rendering one. Constrain
// the ends together -- `coincident` between two `{e, end}` refs -- and then
// the loops fall out of which ends coincide.

const CURVE_KINDS = [KIND.LINE, KIND.ARC, KIND.NURBS];

// Walk the coincidence graph and return the closed loops, each as an ordered
// list of { id, reversed }. Ends that touch within `tol` are the same node.
Sketch.prototype.loops = function (tol) {
  tol = tol || 1e-6;
  // Construction geometry is scaffolding: it constrains the drawing without
  // being part of it, so it must not be walked into a loop.
  const curves = this.ents.filter(e => !e.dead && !e.construction
                                    && CURVE_KINDS.indexOf(e.k) >= 0);
  // cluster endpoints
  const nodes = [];
  const nodeOf = (p) => {
    for (let i = 0; i < nodes.length; i++)
      if (Math.hypot(nodes[i][0] - p[0], nodes[i][1] - p[1]) <= tol) return i;
    nodes.push([p[0], p[1]]);
    return nodes.length - 1;
  };
  const arcs = curves.map(e => {
    const a = nodeOf(this._pos(this.x, { e: e.id, end: 0 }));
    const b = nodeOf(this._pos(this.x, { e: e.id, end: 1 }));
    return { id: e.id, a, b, used: false };
  });
  const at = nodes.map(() => []);
  arcs.forEach((s, i) => { at[s.a].push(i); at[s.b].push(i); });

  const loops = [], open = [];
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
    (closed ? loops : open).push(chain);
  }
  // Orient: positive area is anticlockwise. Outer loops go anticlockwise,
  // holes clockwise, which is the convention the 2D distance below expects.
  // The coarse sampling here is only ever used for the *sign* -- a caller
  // that wants the magnitude gets it from profile(), measured on the polygon
  // it is actually handed.
  const out = loops.map(chain => ({ entities: chain, sign: signedArea(this._loopPoints(chain, 0.05)) }));
  out.sort((p, q) => Math.abs(q.sign) - Math.abs(p.sign));

  // Orient by containment, not by whichever way the walk happened to go: a
  // loop inside an odd number of others is a hole and runs clockwise, so its
  // signed area is negative and the areas sum to the material. This is the
  // same even-odd rule the 2D distance uses, so the two cannot disagree.
  const polys = out.map(l => this._loopPoints(l.entities, 0.05));
  out.forEach((l, i) => {
    let depth = 0;
    for (let j = 0; j < out.length; j++)
      if (j !== i && pointInPoly(polys[j], polys[i][0])) depth++;
    l.hole = (depth % 2) === 1;
    const want = l.hole ? -1 : 1;
    if (Math.sign(l.sign) !== want) {
      l.entities.reverse();
      for (const st of l.entities) st.reversed = !st.reversed;
      l.sign = -l.sign;
    }
  });
  return { loops: out, open };
};

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

Sketch.prototype._loopPoints = function (chain, tol) {
  const pts = [];
  for (const step of chain) {
    let seg = this.sample(step.id, tol);
    if (step.reversed) seg = seg.slice().reverse();
    for (const p of seg) {
      const last = pts[pts.length - 1];
      if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-9) continue;
      pts.push(p);
    }
  }
  const a = pts[0], b = pts[pts.length - 1];
  if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) pts.pop();
  return pts;
};

// Closed loops as polygons, biggest first. This is what feeds an extrude.
Sketch.prototype.profile = function (tol) {
  tol = tol === undefined ? 0.05 : tol;
  const { loops, open } = this.loops();
  return {
    loops: loops.map(l => {
      const points = this._loopPoints(l.entities, tol);
      return { points, area: signedArea(points), hole: l.hole, entities: l.entities };
    }),
    open: open.length,     // chains that did not close: an unfinished profile
    closed: open.length === 0 && loops.length > 0
  };
};

// ======================================================================
// 2D signed distance, so a profile can meet the rest of the kernel
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

// A closure over the sampled profile: (x, y) -> signed distance in mm.
// Sampled once, so moving the sketch afterwards does not change it.
Sketch.prototype.sdf2d = function (tol) {
  const prof = this.profile(tol);
  const polys = prof.loops.map(l => l.points);
  const f = (x, y) => polygonSDF(polys, x, y);
  f.loops = polys;
  f.closed = prof.closed;
  f.open = prof.open;
  return f;
};

const CONSTRAINT_KINDS = Object.keys(CONSTRAINTS);

const SinterSketch = { Sketch, CONSTRAINTS, CONSTRAINT_KINDS, KIND,
                       polygonSDF, findSpan, dersBasisFuns, rankOf };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterSketch;
root.SinterSketch = SinterSketch;
})(typeof self !== 'undefined' ? self : globalThis);
