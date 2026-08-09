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

Sketch.prototype.line = function (a, b) {
  const e = { k: KIND.LINE, id: this.ents.length, a, b };
  this.ents.push(e);
  return e.id;
};

// Elliptical arc. rx == ry is a circular arc; t0/t1 spanning 2pi is a full
// ellipse. `phi` tilts it. t is the eccentric parameter, not the polar angle.
Sketch.prototype.arc = function (c, rx, ry, phi, t0, t1, o) {
  const f = !!(o && o.fixed);
  const e = {
    k: KIND.ARC, id: this.ents.length, c,
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
              n: m - 1, base: ctrl.slice() };
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
Sketch.prototype._pos = function (x, r) {
  if (r.p !== undefined) return this.ptOf(x, r.p);
  if (r.e !== undefined && r.t !== undefined)
    return this.evalAt(x, r.e, x[this.ents[r.t].v]).p;
  if (r.e !== undefined && this.ents[r.e].k === KIND.POINT) return this.ptOf(x, r.e);
  throw new Error('ref has no position — a curve needs a parameter: {e, t}');
};

Sketch.prototype._dir = function (x, r) {
  if (r.e !== undefined && r.t !== undefined)
    return this.evalAt(x, r.e, x[this.ents[r.t].v]).d;
  if (r.e !== undefined && this.ents[r.e].k === KIND.LINE) {
    const e = this.ents[r.e];
    const a = this.ptOf(x, e.a), b = this.ptOf(x, e.b);
    return [b[0] - a[0], b[1] - a[1]];
  }
  throw new Error('ref has no direction — a curve needs a parameter: {e, t}');
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
  const c = { kind, a: A, b: B, v,
              n: typeof C.n === 'function' ? C.n(this, A, B) : C.n, f: C.f };
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

// Levenberg-Marquardt. Gauss-Newton alone walks off a cliff the moment a
// sketch is near-singular, which is most of the interesting ones.
Sketch.prototype.solve = function (opts) {
  opts = opts || {};
  const tol = opts.tol || 1e-9;
  const maxIter = opts.maxIter || 200;
  const free = this._free();
  const n = free.length;
  const m = this.cons.reduce((s, c) => s + c.n, 0);
  const x = Float64Array.from(this.x);
  const r = new Float64Array(m), r2 = new Float64Array(m);
  const J = new Float64Array(m * n);
  const A = new Float64Array(n * n), g = new Float64Array(n), step = new Float64Array(n);

  if (!m) return this._report(x, free, J, 0, 0, 0, true);

  const norm = (v) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s); };
  this.residuals(x, r);
  let f = norm(r), lambda = 1e-3, iter = 0;

  const plus = new Float64Array(m);
  for (; iter < maxIter && f > tol; iter++) {
    this._jac(x, free, J, m, r2, plus);
    // normal equations
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
      this.residuals(trial, r2);
      const f2 = norm(r2);
      if (f2 < f) {
        x.set(trial); r.set(r2); f = f2;
        lambda = Math.max(lambda / 3, 1e-12);
        accepted = true;
      } else lambda *= 8;
    }
    if (!accepted) break;
  }

  for (let i = 0; i < x.length; i++) this.x[i] = x[i];
  // The rank has to be read at the solution, not from whatever the last
  // iteration left behind -- and there may have been no iterations at all,
  // if the sketch was already satisfied when it arrived.
  this._jac(x, free, J, m, r2, plus);
  return this._report(x, free, J, m, f, iter, f <= Math.max(tol, 1e-7));
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

const SinterSketch = { Sketch, CONSTRAINTS, KIND, findSpan, dersBasisFuns, rankOf };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterSketch;
root.SinterSketch = SinterSketch;
})(typeof self !== 'undefined' ? self : globalThis);
