/* SinterForm sweep - a profile dragged along a sketch path
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * Takes a path in the XY plane -- any polyline, so anything sketch.js can
 * sample, open or closed -- and a 2D profile, and drags the second along the
 * first at a scale that may vary as it goes. Out comes a 3D signed distance
 * function.
 *
 * ----------------------------------------------------------------------
 * Why self-intersection is fine, and what that costs
 * ----------------------------------------------------------------------
 * A swept solid is the *union* of the profile placed at every point of the
 * path. Union is `min`, and `min` does not care how many times a point is
 * covered: covered once is negative, covered five times is still negative,
 * and the more negative of two negatives is the one further inside. A path
 * that crosses itself, or doubles back, or coils, is not a special case --
 * it is the ordinary case with more terms in the min.
 *
 * That is only true of the union definition, and it is worth being precise
 * about, because it is not how sweeps are usually written. The cheap way is
 * to find the *nearest* point on the path, build a frame there, and evaluate
 * the profile in it. That is one lookup instead of a loop, and it is wrong in
 * exactly the two places that matter: where the sweep crosses itself, because
 * the nearest path point is not the one whose profile actually covers you;
 * and on curves tighter than the profile is wide, where the inside of the
 * bend folds through itself. Both produce a surface with bites taken out of
 * it, which reads as a meshing bug and is not one.
 *
 * So this takes the union, over every segment, every time. The cost is O(path
 * segments) per sample rather than O(1). For a mesher that is affordable and
 * for a raymarcher it is the thing to watch.
 *
 * ----------------------------------------------------------------------
 * What is exact, and what is not
 * ----------------------------------------------------------------------
 * At constant scale the result is a true distance wherever the profile is:
 * each segment contributes an exact swept prism, and a min of exact distances
 * is exact outside the union and a safe under-estimate inside it, which is
 * the direction a sphere trace needs.
 *
 * Varying the scale breaks that, and no amount of care puts it back. A
 * tapered surface is slanted, and the profile's own distance is measured
 * across the sweep rather than perpendicular to that slant, so it
 * over-estimates by the secant of the taper angle. Dividing it back out --
 * which is what `taper` below does -- restores a safe bound rather than an
 * exact distance. check-sweep.mjs measures the Lipschitz constant that
 * results, because a bound whose looseness nobody has measured is a bound
 * nobody should be stepping along.
 */
(function (root) {
"use strict";

// A 2D profile is any (u, v) -> signed distance, where u runs across the path
// and v runs up. These are here so the common cases need no ceremony.
const PROFILES = {
  circle: (r) => Object.assign((u, v) => Math.hypot(u, v) - r, { radius: r }),
  rect: (w, h, round) => {
    const rr = round || 0;
    const hw = Math.max(w / 2 - rr, 0), hh = Math.max(h / 2 - rr, 0);
    return Object.assign((u, v) => {
      const qu = Math.abs(u) - hw, qv = Math.abs(v) - hh;
      return Math.hypot(Math.max(qu, 0), Math.max(qv, 0))
           + Math.min(Math.max(qu, qv), 0) - rr;
    }, { radius: Math.hypot(w / 2, h / 2) });
  },
  // A profile that sits on the path rather than centred on it -- what a bead
  // laid on the plate looks like.
  halfCircle: (r) => Object.assign((u, v) => Math.max(Math.hypot(u, v) - r, -v),
                                   { radius: r })
};

// How far the profile reaches from the path. Needed for bounds and for the
// taper correction; measured rather than assumed if the profile did not say.
function profileRadius(profile) {
  if (typeof profile.radius === 'number') return profile.radius;
  let lo = 0, hi = 1;
  while (profile(hi, 0) < 0 && hi < 1e5) hi *= 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (profile(mid, 0) < 0 || profile(0, mid) < 0) lo = mid; else hi = mid;
  }
  return hi;
}

/* Build a sweep.
 *
 *   path      [[x, y], ...] in mm. From sketch.sample(id) or a profile loop.
 *   profile   (u, v) -> mm. u across the path, v up. Optional `.radius`.
 *   opts.closed   join the last point back to the first
 *   opts.scale    a number, a function of t in [0, 1] by arc length, or an
 *                 array of one factor per path point
 *   opts.z        the height the path sits at (default 0)
 *   opts.join     'round' (default) or 'miter' at sharp corners
 *   opts.miterLimit  how far a miter may run on, in profile radii (default 4)
 *
 * Returns f(x, y, z) -> mm, carrying .bounds, .arcLength and .segments.
 */
function along(path, profile, opts) {
  opts = opts || {};
  const closed = !!opts.closed;
  const z0 = opts.z || 0;
  const R = profileRadius(profile);

  // ---- drop repeated points, or a zero-length segment makes a NaN tangent --
  const pts = [];
  for (const p of path) {
    const last = pts[pts.length - 1];
    if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-12) continue;
    pts.push([p[0], p[1]]);
  }
  if (closed && pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-12) pts.pop();
  }
  if (pts.length < 2) throw new Error('a sweep needs at least two distinct path points');

  // ---- arc length, so `scale` can be a function of how far along you are ---
  const n = pts.length;
  const last = closed ? n : n - 1;
  const cum = [0];
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[last];

  const scaleAt = (i) => {
    const s = opts.scale;
    if (s === undefined) return 1;
    if (typeof s === 'number') return s;
    if (Array.isArray(s)) return s[Math.min(i, s.length - 1)];
    return s(total ? cum[Math.min(i, last)] / total : 0);
  };

  // ---- segments, precomputed -------------------------------------------
  const tan = [];
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    tan.push([dx / L, dy / L, L]);
  }
  // Does the path carry on through this joint, or double back on itself?
  //
  // A joint the path continues through is interior to the material: capping
  // it puts a face inside the solid. One the path reverses at is a real end,
  // and must be capped or the field reports the depth of the profile where
  // the surface is a hair away.
  //
  // Only a true reversal counts. Taking ninety degrees as the line -- which
  // this did at first -- leaves a notch at every corner sharper than that:
  // both segments cap flat, and nothing fills the wedge between them. On a
  // 120 degree corner with a 6 mm profile, material reached 0.05 mm past the
  // vertex instead of 6.
  const dotOf = (i, j) => tan[i][0] * tan[j][0] + tan[i][1] * tan[j][1];
  const reverses = (i, j) => dotOf(i, j) < -0.999999;

  // Sharp corners take one of the two usual joins.
  //
  //   round   the profile revolved about the vertex. The outer corner is
  //           rounded off at the profile's own radius.
  //   miter   both segments run on until their outer edges meet, giving a
  //           point. The run is R*tan(turn/2), which is zero on a straight
  //           joint -- so this costs nothing on a finely sampled curve and
  //           only bites where there is a real corner -- and runs away as
  //           the corner closes, hence the limit. Past it, this falls back
  //           to round rather than leaving anything unfilled.
  const join = opts.join === 'miter' ? 'miter' : 'round';
  const miterLimit = opts.miterLimit === undefined ? 4 : opts.miterLimit;
  const runOn = (i, j, s) => {
    if (join !== 'miter' || reverses(i, j)) return 0;
    const phi = Math.acos(Math.min(Math.max(dotOf(i, j), -1), 1));
    return Math.min(R * s * Math.tan(phi / 2), R * s * miterLimit);
  };

  const seg = [];
  let sMax = 0;
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    const sA = scaleAt(i), sB = scaleAt(i + 1);
    sMax = Math.max(sMax, sA, sB);
    // Cap only where the path really ends. A joint between two segments is
    // interior to the union, so capping there puts a face inside the solid,
    // and `min` of two abutting prisms reads zero on their shared face and
    // shallow near it -- wrong by the whole depth of the profile. The sign
    // stayed right, so it looked fine until a mesher interpolated a zero
    // crossing against those values and put the surface in the wrong place.
    const first = i === 0, lastSeg = i === last - 1;
    const pi = first ? last - 1 : i - 1, ni = lastSeg ? 0 : i + 1;
    const e0 = (!closed && first) ? 0 : runOn(pi, i, sA);
    const e1 = (!closed && lastSeg) ? 0 : runOn(i, ni, sB);
    // A mitered end is capped flat where it stops, which is what makes the
    // corner a point rather than a rounded nub. That face is buried inside
    // the neighbour it ran on into, so it is never the nearest boundary and
    // costs nothing -- unlike capping two segments that merely abut. Where
    // the miter limit clipped the run-on, the flat cap is the bevel.
    const capA = (!closed && first) || reverses(pi, i) || e0 > 1e-9;
    const capB = (!closed && lastSeg) || reverses(i, ni) || e1 > 1e-9;
    // The surface of a tapered sweep is slanted by this much, and the
    // profile's distance is measured across the sweep rather than square to
    // that slant. Dividing by the secant puts it back to a safe bound.
    const slope = L > 0 ? R * Math.abs(sB - sA) / L : 0;
    seg.push({ ax: a[0], ay: a[1], tx: dx / L, ty: dy / L, L, sA, sB, capA, capB,
               e0, e1, taper: Math.sqrt(1 + slope * slope) });
  }

  const f = function (x, y, z) {
    const v = z - z0;
    let best = Infinity;
    for (let i = 0; i < seg.length; i++) {
      const S = seg[i];
      const px = x - S.ax, py = y - S.ay;
      // where along this segment, and how far past its ends
      const proj = px * S.tx + py * S.ty;
      const t = proj < 0 ? 0 : proj > S.L ? 1 : proj / S.L;
      // outside this segment's own span, and which end that is
      // a miter runs each segment on past its joint; a round join does not
      const oStart = -(proj + S.e0), oEnd = proj - (S.L + S.e1);
      const out = oStart > oEnd ? oStart : oEnd;
      const capThis = oStart > oEnd ? S.capA : S.capB;
      const capped = Math.max(S.capA ? oStart : -1e30, S.capB ? oEnd : -1e30);
      const s = S.sA + (S.sB - S.sA) * t;
      // across the path, in the profile's own frame
      const u = -px * S.ty + py * S.tx;
      // a 2D distance scaled by s: profile(q/s)*s is exact for uniform s
      const d2 = s > 1e-9 ? profile(u / s, v / s) * s : Math.hypot(u, v);
      // Past the span, it matters a great deal which end this is.
      //
      // At a real end of the path the profile caps it flat, and the distance
      // is to that flat face.
      //
      // At a joint it must round instead. Two segments meeting at a convex
      // corner do not tile the space outside the corner -- there is a wedge
      // that is past the end of one and before the start of the other, and
      // both were answering with the distance along their own axis. On a
      // finely sampled curve that wedge is a whisker wide and the answer
      // inside it was wrong by the entire depth of the profile: a point 4.3
      // mm inside the tube read as 0.002 mm outside it. Thin positive spikes
      // at every vertex, which a mesher turns into holes.
      //
      // Rounding the join -- measuring the profile from the joint radially
      // rather than along the axis -- fills the wedge exactly, and for a
      // circular profile reproduces the capsule.
      //
      // Rounding takes the nearer side rather than the side u happens to be
      // on. Choosing by sign(u) is discontinuous across the path centreline,
      // which costs nothing for a profile symmetric about it and jumps by
      // the whole width of the profile for one that is not -- a flange, a
      // lip, anything one-sided. For those the wedge gets filled on both
      // sides, which is a hair of extra material in a whisker-wide gap, and
      // continuous everywhere.
      let raw;
      if (out > 0) {
        if (capThis) raw = d2 <= 0 ? out : Math.hypot(d2, out);
        else {
          const h = Math.hypot(u, out) / s;
          raw = Math.min(profile(h, v / s), profile(-h, v / s)) * s;
        }
      } else raw = Math.max(d2, capped);
      const d = raw / S.taper;
      if (d < best) best = d;
    }
    return best;
  };

  // ---- bounds ----------------------------------------------------------
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  const reach = R * sMax;
  f.bounds = { lo: [x0 - reach, y0 - reach, z0 - reach],
               hi: [x1 + reach, y1 + reach, z0 + reach] };
  f.arcLength = total;
  f.segments = seg.length;
  f.radius = R;
  f.exact = opts.scale === undefined || typeof opts.scale === 'number';
  return f;
}

/* Sweep along a sketch entity, or along one of its profile loops.
 *
 *   fromSketch(S, { entity: id })      one curve, open unless it closes itself
 *   fromSketch(S, { loop: 0 })         a closed loop from S.profile()
 *
 * Everything else is `along`'s.
 */
function fromSketch(S, where, profile, opts) {
  opts = Object.assign({}, opts);
  let path;
  if (where.entity !== undefined) {
    path = S.sample(where.entity, opts.tol || 0.05);
    if (opts.closed === undefined) {
      const a = path[0], b = path[path.length - 1];
      opts.closed = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
    }
  } else if (where.loop !== undefined) {
    const prof = S.profile(opts.tol || 0.05);
    const l = prof.loops[where.loop];
    if (!l) throw new Error(`no loop ${where.loop} — the sketch has ${prof.loops.length}`);
    path = l.points;
    if (opts.closed === undefined) opts.closed = true;
  } else {
    throw new Error('fromSketch wants { entity } or { loop }');
  }
  return along(path, profile, opts);
}

const SinterSweep = { along, fromSketch, PROFILES, profileRadius };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterSweep;
root.SinterSweep = SinterSweep;
})(typeof self !== 'undefined' ? self : globalThis);
