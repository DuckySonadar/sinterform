/* SinterForm sweep - a profile dragged along a sketch path
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * Takes a path -- any polyline, so anything sketch.js or sketch3d.js can
 * sample, open or closed, flat or through space -- and a 2D profile, and drags
 * the second along the first at a scale that may vary as it goes. Out comes a
 * 3D signed distance function.
 *
 * A path point may be [x, y] or [x, y, z]. Two-coordinate points sit at
 * `opts.z`, which is what this file used to assume of all of them.
 *
 * ----------------------------------------------------------------------
 * One dimension up: the profile's orientation stops being obvious
 * ----------------------------------------------------------------------
 * In the XY plane there is nothing to decide. The profile's v axis is +Z and
 * its u axis is the path's normal, and that is the only frame there is.
 *
 * In space there is no distinguished up, and worse, there is no continuous
 * choice to be made pointwise: any rule of the form "take the normal" breaks
 * where the path is straight, and the Frenet frame -- the textbook answer --
 * flips its normal through 180 degrees at every inflection. Sweep a rectangle
 * along an S-bend with it and the section turns over halfway along.
 *
 * So the frame is not chosen at each point, it is *carried*: start with one
 * frame, and at every joint rotate it by the smallest rotation that takes the
 * old tangent onto the new one. That is the rotation-minimising frame, it is
 * defined wherever the tangent is, and it does not twist unless the path makes
 * it.
 *
 * The price is that a closed path in space need not bring the frame back to
 * where it started -- it comes back rotated by the solid angle the tangent
 * swept out, which is a fact about the sphere and not something to be fixed by
 * being careful. So the residue is measured and spread along the path instead,
 * which trades a seam nobody asked for against a twist of a few degrees over
 * the whole loop. `f.holonomy` reports what it was. A closed *flat* path has
 * none, so nothing here changes what this file did before.
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

// ======================================================================
// vectors, only as much as carrying a frame needs
// ======================================================================
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1],
                          a[2] * b[0] - a[0] * b[2],
                          a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const unit3 = (a) => { const l = len3(a) || 1e-300; return [a[0] / l, a[1] / l, a[2] / l]; };
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Rodrigues, for a unit axis.
function turn(v, k, th) {
  const c = Math.cos(th), s = Math.sin(th);
  const kv = cross3(k, v), d = dot3(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d,
          v[1] * c + kv[1] * s + k[1] * d,
          v[2] * c + kv[2] * s + k[2] * d];
}

// The smallest rotation taking t0 onto t1, applied to a frame. This is the
// whole of the rotation-minimising frame: no normal is ever computed, so
// there is nothing to flip at an inflection and nothing to be undefined where
// the path runs straight.
function transport(U, V, t0, t1) {
  const ax = cross3(t0, t1), s = len3(ax), c = dot3(t0, t1);
  if (s < 1e-12) {
    // Parallel, or a doubling-back. A reversal has no axis to speak of -- any
    // one perpendicular to the tangent turns it -- and it is a capped end of
    // the material anyway, so keep u and flip v, which stays right-handed.
    return c > 0 ? [U, V] : [U, [-V[0], -V[1], -V[2]]];
  }
  const k = [ax[0] / s, ax[1] / s, ax[2] / s];
  const th = Math.atan2(s, c);
  return [turn(U, k, th), turn(V, k, th)];
}

// (u, v, t) right-handed, so u x v = t and t x u = v. In the XY plane with
// v = +Z this gives u = (-ty, tx, 0), which is exactly the frame this file
// used before there was a choice to make.
function firstFrame(t, up) {
  for (const cand of [up, [0, 0, 1], [1, 0, 0], [0, 1, 0]]) {
    const d = dot3(cand, t);
    const v = [cand[0] - t[0] * d, cand[1] - t[1] * d, cand[2] - t[2] * d];
    if (len3(v) > 1e-9) { const V = unit3(v); return [cross3(V, t), V]; }
  }
  return [[1, 0, 0], [0, 1, 0]];   // unreachable: t cannot be parallel to all three
}

// Rotate a frame about its own tangent. Turning the frame by w turns a fixed
// point's coordinates in it by -w, which is what the evaluator undoes.
function spin(U, V, w) {
  const c = Math.cos(w), s = Math.sin(w);
  return [[U[0] * c + V[0] * s, U[1] * c + V[1] * s, U[2] * c + V[2] * s],
          [V[0] * c - U[0] * s, V[1] * c - U[1] * s, V[2] * c - U[2] * s]];
}

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
 *   path      [[x, y], ...] or [[x, y, z], ...] in mm. From sketch.sample(id),
 *             sketch3d.sample(id), or a profile loop from either.
 *   profile   (u, v) -> mm. u across the path, v up. Optional `.radius`.
 *   opts.closed   join the last point back to the first
 *   opts.scale    a number, a function of t in [0, 1] by arc length, or an
 *                 array of one factor per path point
 *   opts.z        the height two-coordinate path points sit at (default 0)
 *   opts.up       which way the profile's v axis leans at the start of the
 *                 path, as far as the tangent allows (default +Z)
 *   opts.twist    radians of roll about the path, as a number over the whole
 *                 path or a function of t in [0, 1]
 *   opts.closeFrame  on a closed path, spread the frame's holonomy along it so
 *                 the section joins up (default true)
 *   opts.join     'round' (default) or 'miter' at sharp corners
 *   opts.miterLimit  how far a miter may run on, in profile radii (default 4)
 *
 * Returns f(x, y, z) -> mm, carrying .bounds, .arcLength, .segments, .frames
 * and .holonomy.
 */
function along(path, profile, opts) {
  opts = opts || {};
  const closed = !!opts.closed;
  const z0 = opts.z || 0;
  const R = profileRadius(profile);

  // ---- drop repeated points, or a zero-length segment makes a NaN tangent --
  // A two-coordinate point sits at z0, which is what every point used to be.
  const pts = [];
  for (const p of path) {
    const q = [p[0], p[1], p.length > 2 ? p[2] : z0];
    const last = pts[pts.length - 1];
    if (last && dist3(last, q) < 1e-12) continue;
    pts.push(q);
  }
  if (closed && pts.length > 1 && dist3(pts[0], pts[pts.length - 1]) < 1e-12) pts.pop();
  if (pts.length < 2) throw new Error('a sweep needs at least two distinct path points');

  // ---- arc length, so `scale` can be a function of how far along you are ---
  const n = pts.length;
  const last = closed ? n : n - 1;
  const cum = [0];
  for (let i = 0; i < last; i++) cum.push(cum[i] + dist3(pts[i], pts[(i + 1) % n]));
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
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = len3(d);
    tan.push([d[0] / L, d[1] / L, d[2] / L, L]);
  }

  // ---- carry a frame along the path ------------------------------------
  // Started from `up`, then rotated at each joint by the smallest rotation
  // that takes one tangent onto the next. Re-orthogonalised as it goes, since
  // a few thousand small rotations otherwise drift off the unit sphere.
  const frames = [];
  {
    let [U, V] = firstFrame(tan[0], opts.up || [0, 0, 1]);
    frames.push([U, V]);
    for (let i = 1; i < tan.length; i++) {
      [U, V] = transport(U, V, tan[i - 1], tan[i]);
      V = unit3([V[0] - tan[i][0] * dot3(V, tan[i]),
                 V[1] - tan[i][1] * dot3(V, tan[i]),
                 V[2] - tan[i][2] * dot3(V, tan[i])]);
      U = cross3(V, tan[i]);
      frames.push([U, V]);
    }
  }

  // How far the frame fails to come back to itself, going the whole way round.
  // A flat closed path has none of this; one that leaves the plane generally
  // does, and no choice of starting frame removes it -- it is the area the
  // tangent traced on the sphere. Spread along the path it becomes a twist of
  // a few degrees; left alone it is a seam at one station.
  let holonomy = 0;
  if (closed && tan.length > 1) {
    const [Ue] = transport(frames[tan.length - 1][0], frames[tan.length - 1][1],
                           tan[tan.length - 1], tan[0]);
    const [U0, V0] = frames[0];
    holonomy = Math.atan2(dot3(Ue, V0), dot3(Ue, U0));
  }
  const closeFrame = opts.closeFrame === undefined ? true : !!opts.closeFrame;
  const twistAt = (s) => {
    const t = total ? s / total : 0;
    let w = 0;
    if (typeof opts.twist === 'number') w += opts.twist * t;
    else if (typeof opts.twist === 'function') w += opts.twist(t);
    if (closed && closeFrame) w -= holonomy * t;
    return w;
  };
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
  const dotOf = (i, j) => dot3(tan[i], tan[j]);
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
  let sMax = 0, rolled = false;
  for (let i = 0; i < last; i++) {
    const a = pts[i];
    const T = tan[i], L = T[3];
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
    // The frame this segment carries, rolled to where the twist has got to.
    // w0 is baked into the frame and costs nothing; only what is left to turn
    // *within* the segment has to be undone per sample, and below a ten
    // thousandth of a radian across one segment that is not worth two trig
    // calls a sample, so it is folded into the frame as well.
    const w0 = twistAt(cum[i]);
    let dw = twistAt(cum[i + 1]) - w0;
    if (Math.abs(w0) > 1e-12 || Math.abs(dw) > 1e-12) rolled = true;
    const [U, V] = spin(frames[i][0], frames[i][1], Math.abs(dw) < 1e-4 ? w0 + dw / 2 : w0);
    if (Math.abs(dw) < 1e-4) dw = 0;
    // The surface of a tapered sweep is slanted by this much, and the
    // profile's distance is measured across the sweep rather than square to
    // that slant. Dividing by the secant puts it back to a safe bound. A twist
    // slants it the same way, at right angles to the taper, so the two go in
    // together.
    const sHi = Math.max(sA, sB);
    const slope = L > 0 ? R * Math.abs(sB - sA) / L : 0;
    const roll = L > 0 ? R * sHi * Math.abs(dw) / L : 0;

    // The turn at the far end: which axis the path turns about, and how far.
    //
    // In the plane there was nothing to work out -- every turn is about +Z,
    // which is the section's own v axis. In space a path turns about whatever
    // is perpendicular to both tangents, and a circular profile cannot tell
    // you whether the join got it right, because a circle revolves into the
    // same solid whichever way you spin it.
    //
    // The axis is held as its components in this segment's frame, which is
    // exactly (cos, sin) of its angle there; the turn as its own cosine and
    // sine, which the cross and the dot hand over for nothing. So the
    // evaluator does all of this without a single trig call. In the XY plane
    // the axis comes out (0, ±1) exactly, and the arithmetic reduces term for
    // term to what this file did before.
    const kk = cross3(T, tan[ni]);
    const kl = len3(kk);
    // straight, or doubling straight back: no turn to sweep the section
    // through, and the neighbour covers that ground anyway
    const kB = kl < 1e-9 ? [0, 1] : [dot3(kk, U) / kl, dot3(kk, V) / kl];

    seg.push({ ax: a[0], ay: a[1], az: a[2],
               tx: T[0], ty: T[1], tz: T[2],
               ux: U[0], uy: U[1], uz: U[2],
               vx: V[0], vy: V[1], vz: V[2],
               k1u: kB[0], k1v: kB[1],
               turnC: dot3(T, tan[ni]), turnS: kl,
               round1: !capB, reach1: R * sB,
               L, sA, sB, capA, capB, e0, e1, dw,
               taper: Math.sqrt(1 + slope * slope + roll * roll) });
  }

  const f = function (x, y, z) {
    let best = Infinity;
    for (let i = 0; i < seg.length; i++) {
      const S = seg[i];
      const px = x - S.ax, py = y - S.ay, pz = z - S.az;
      // where along this segment, and how far past its ends
      const proj = px * S.tx + py * S.ty + pz * S.tz;
      const t = proj < 0 ? 0 : proj > S.L ? 1 : proj / S.L;
      // outside this segment's own span, and which end that is
      // a miter runs each segment on past its joint; a round join does not
      const oStart = -(proj + S.e0), oEnd = proj - (S.L + S.e1);
      const atA = oStart > oEnd;
      const out = atA ? oStart : oEnd;
      const capThis = atA ? S.capA : S.capB;
      const capped = Math.max(S.capA ? oStart : -1e30, S.capB ? oEnd : -1e30);
      const s = S.sA + (S.sB - S.sA) * t;
      // across the path and up it, in the frame this segment carries. For a
      // path in the XY plane that frame is (-ty, tx, 0) and +Z, so these are
      // the two lines this file had before, spelt in three coordinates.
      const u0 = px * S.ux + py * S.uy + pz * S.uz;
      const v0 = px * S.vx + py * S.vy + pz * S.vz;
      // whatever roll is left to do inside this segment, undone on the point
      let u = u0, v = v0;
      if (S.dw) {
        const a = S.dw * t, ca = Math.cos(a), sa = Math.sin(a);
        u = u0 * ca + v0 * sa;
        v = v0 * ca - u0 * sa;
      }
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
      // Radially *about the axis the path turns about*, which is the part that
      // stops being obvious in space. A revolution leaves the coordinate along
      // its axis alone and radialises the other two, so the section is swept
      // through the corner in the plane the corner actually turns in. In the
      // XY plane that axis is always +Z, which is the section's own v, so this
      // reduces to radialising (u, out) and leaving v -- the two lines that
      // were here before. Out of the plane it is some other direction in the
      // section, and revolving about v instead sweeps the section through a
      // plane the path never turns in: material bunched at the corner in a
      // shape with no relation to the turn, and a wedge left unfilled beside
      // it. A circular profile cannot show it, because a circle revolves into
      // the same solid whichever way you spin it.
      //
      // Rounding takes the nearer side rather than the side u happens to be
      // on. Choosing by sign(u) is discontinuous across the path centreline,
      // which costs nothing for a profile symmetric about it and jumps by
      // the whole width of the profile for one that is not -- a flange, a
      // lip, anything one-sided. For those the wedge gets filled on both
      // sides, which is a hair of extra material in a whisker-wide gap, and
      // continuous everywhere.
      // Past the end, the answer is the distance to this segment's own material
      // ending flat there, capped or not: out along the axis if the point is
      // within the section, the hypotenuse if it is not. Both are exact, and
      // neither depends on what happens at the joint -- the fill is its own
      // term below. Capping only ever went wrong *inside* the span, where two
      // abutting prisms would both read zero on their shared face; that is what
      // `capped` guards, and it still excludes a rounded end.
      let raw;
      if (out > 0) raw = d2 <= 0 ? out : Math.hypot(d2, out);
      else raw = Math.max(d2, capped);
      const d = raw / S.taper;
      if (d < best) best = d;

      // The rounded joint at the far end: the section swept through the turn,
      // as a term of its own rather than as something this segment answers for
      // past its end.
      //
      // Both halves of that mattered. Gating it on being past the end is what
      // the plane could get away with, because there the section revolves about
      // its own v axis and the fill it adds inside the span is material the
      // prism already has. Out of the plane the axis tilts, the sweep swings
      // the section's *width* into v, and the fill reaches past the prism's
      // face at stations well short of the joint -- ground that two prisms
      // both call empty, so the material goes missing and the sweep pinches in
      // where it should be fullest.
      //
      // And it has to stop at the turn. Revolving the whole way round is what
      // the plane did, harmlessly, because the extra was inside the prisms;
      // out of the plane it hangs a lobe of section-width material off every
      // joint, which on a sampled curve is a row of blisters down the sweep.
      // So the point's angle about the axis is clamped into the turn, which
      // takes only the turn's cosine and sine -- and those are the dot and the
      // cross that gave the axis in the first place.
      //
      // One term per joint, taken from the segment that ends there. The other
      // side's section is this one turned about the same axis, so either sweeps
      // out the same solid.
      if (S.round1) {
        const oJ = proj - S.L;                       // signed, either side of it
        // It lives within a profile radius of the joint, so it can never report
        // less than that far away -- less the taper, which divides the answer
        // down and so has to be allowed for here too, or a term that would have
        // won gets skipped and the field steps where it should be smooth.
        if (Math.hypot(u0, v0, oJ) - S.reach1 < best * S.taper) {
          let uj = u0, vj = v0;
          if (S.dw) {                                // rolled to the joint, t = 1
            const ca = Math.cos(S.dw), sa = Math.sin(S.dw);
            uj = u0 * ca + v0 * sa;
            vj = v0 * ca - u0 * sa;
          }
          const ku = S.k1u, kv = S.k1v, sJ = S.sB;
          const pk = uj * ku + vj * kv;      // along the turn axis: untouched
          const pm = vj * ku - uj * kv;      // across it, in the section plane
          // where the point sits in the turn, clamped to it
          let beta, off;
          if (oJ < 0) { beta = pm; off = oJ; }                     // short of it
          else if (pm * S.turnS - oJ * S.turnC >= 0) {             // within it
            beta = Math.hypot(pm, oJ); off = 0;
          } else {                                                 // past it
            beta = pm * S.turnC + oJ * S.turnS;
            off = oJ * S.turnC - pm * S.turnS;
          }
          const p2 = profile((pk * ku - beta * kv) / sJ,
                             (pk * kv + beta * ku) / sJ) * sJ;
          // inside the turn the section is a solid slice and carries its own
          // depth; outside it the sweep has ended and the swept sheet is the
          // nearest thing, at whatever the offset is
          const c = (off === 0 ? p2 : Math.hypot(Math.max(p2, 0), Math.abs(off))) / S.taper;
          if (c < best) best = c;
        }
      }
    }
    return best;
  };

  // ---- bounds ----------------------------------------------------------
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let i = 0; i < 3; i++) {
      if (p[i] < lo[i]) lo[i] = p[i];
      if (p[i] > hi[i]) hi[i] = p[i];
    }
  const reach = R * sMax;
  f.bounds = { lo: lo.map(c => c - reach), hi: hi.map(c => c + reach) };
  f.seg = seg;
  f.arcLength = total;
  f.segments = seg.length;
  f.radius = R;
  f.holonomy = holonomy;
  // The frame each segment carries, for anything that wants to draw it or to
  // check that it is not turning over where the path bends.
  f.frames = seg.map((S, i) => ({ p: pts[i], t: [S.tx, S.ty, S.tz],
                                  u: [S.ux, S.uy, S.uz], v: [S.vx, S.vy, S.vz] }));
  // A twist slants the surface the same way a varying scale does, so it costs
  // the same claim: a safe bound rather than a distance.
  // Whether it rolls, not whether anything was passed: `twist: 0` is not a
  // twist, and a closed path whose holonomy came out zero has nothing to spread.
  f.exact = (opts.scale === undefined || typeof opts.scale === 'number') && !rolled;
  return f;
}

/* Sweep along a sketch entity, or along one of its profile loops.
 *
 *   fromSketch(S, { entity: id })      one curve, open unless it closes itself
 *   fromSketch(S, { loop: 0 })         a closed loop from S.profile()
 *   fromSketch(S, { face: 0 })         a 3D sketch's face, outer loop
 *   fromSketch(S, { face: 0, loop: 1 })   and its hole
 *
 * `S` is a Sketch or a Sketch3D -- nothing here knows which, it asks for
 * samples and gets points with two coordinates or three. The two sketchers
 * report a profile differently, though: one hands back loops, the other faces
 * with loops in them, and that is the one thing this has to know.
 *
 * Everything else is `along`'s.
 */
function loopsOf(prof, where) {
  if (prof.loops) {                          // a 2D sketch: loops, no faces
    if (where.face !== undefined)
      throw new Error('{ face } wants a 3D sketch — this one has loops, not faces');
    return prof.loops;
  }
  const faces = prof.faces || [];
  if (where.face === undefined) {
    const all = [];
    for (const f of faces) for (const l of f.loops) all.push(l);
    return all;
  }
  const f = faces[where.face];
  if (!f) throw new Error(`no face ${where.face} — the sketch has ${faces.length}`);
  return f.loops;
}

function fromSketch(S, where, profile, opts) {
  opts = Object.assign({}, opts);
  let path;
  if (where.entity !== undefined) {
    path = S.sample(where.entity, opts.tol || 0.05);
    if (opts.closed === undefined)
      opts.closed = dist3(pad(path[0]), pad(path[path.length - 1])) < 1e-6;
  } else if (where.loop !== undefined || where.face !== undefined) {
    const loops = loopsOf(S.profile(opts.tol || 0.05), where);
    const i = where.loop === undefined ? 0 : where.loop;
    const l = loops[i];
    if (!l) throw new Error(`no loop ${i} — there are ${loops.length}`);
    path = l.points;
    if (opts.closed === undefined) opts.closed = true;
  } else {
    throw new Error('fromSketch wants { entity }, { loop } or { face }');
  }
  return along(path, profile, opts);
}
const pad = (p) => (p.length > 2 ? p : [p[0], p[1], 0]);

// The same sweep as *data*: the packed segments the kernel's `sweep` primitive
// evaluates, so a sweep can be a node in a plan rather than a closure a caller
// has to sample itself.
//
// Everything here is construction -- parallel transport, holonomy, the corner
// axis, the taper -- which is this file's job. Evaluation is the kernel's, and
// the two halves meet at this array. `along()` already worked all of it out;
// this only lays it out in the order the primitive's intrinsics read.
//
// The section has to become data too, which is the one thing a closure cannot
// do: `kind` 0 circle, 1 rect, 2 halfCircle, with up to three parameters. A
// caller-supplied function still works in `along()` and still meshes, it just
// cannot cross into a shader.
//
// Except by being drawn. `kind` 3 is a *sketch*: `a` is a profile slot, and
// the outline in it is the same one the `profile` primitive extrudes, read by
// the same polygonSDF. A section is a 2D shape and the repository already had
// 2D shapes; this is that one, not a second kind of drawing.
//
// The 2D distance itself arrives as `section.fn`, because that function
// belongs to whoever owns the outline -- sketch.js and the kernel each have a
// polygonSDF, and a third copy here would be a third thing to keep in step.
// Sketch.prototype.section hands back both halves already paired up. Only
// along() calls it; the slot is what crosses into a shader.
const SECTION_KINDS = { circle: 0, rect: 1, halfCircle: 2, polygon: 3 };
const STRIDE = 31;

function pack(path, section, opts) {
  const kind = SECTION_KINDS[section && section.kind];
  if (kind === undefined)
    throw new Error("sweep.pack wants a section {kind: 'circle'|'rect'|'halfCircle'|'polygon'}");
  if (kind === 3 && typeof section.fn !== 'function')
    throw new Error('a polygon section wants section.fn, the outline\'s own 2D '
                  + 'distance -- Sketch.prototype.section returns it with the slot');
  const a = section.a === undefined ? (kind === 3 ? 0 : 1) : section.a;
  const b = section.b === undefined ? 0 : section.b;
  const c = section.c === undefined ? 0 : section.c;
  const profile = kind === 0 ? PROFILES.circle(a)
                : kind === 1 ? PROFILES.rect(a, b, c)
                : kind === 2 ? PROFILES.halfCircle(a)
                :              section.fn;
  const f = along(path, profile, opts);
  const S = f.seg;
  const segs = new Float64Array(S.length * STRIDE);
  S.forEach((g, i) => {
    const o = i * STRIDE;
    segs[o] = g.ax; segs[o + 1] = g.ay; segs[o + 2] = g.az;
    segs[o + 3] = g.tx; segs[o + 4] = g.ty; segs[o + 5] = g.tz;
    segs[o + 6] = g.ux; segs[o + 7] = g.uy; segs[o + 8] = g.uz;
    segs[o + 9] = g.vx; segs[o + 10] = g.vy; segs[o + 11] = g.vz;
    segs[o + 12] = g.k1u; segs[o + 13] = g.k1v;
    segs[o + 14] = g.turnC; segs[o + 15] = g.turnS;
    segs[o + 16] = g.L; segs[o + 17] = g.sA; segs[o + 18] = g.sB;
    segs[o + 19] = g.e0; segs[o + 20] = g.e1;
    segs[o + 21] = g.dw; segs[o + 22] = g.taper; segs[o + 23] = g.reach1;
    segs[o + 24] = g.capA ? 1 : 0; segs[o + 25] = g.capB ? 1 : 0;
    segs[o + 26] = g.round1 ? 1 : 0;
    segs[o + 27] = kind; segs[o + 28] = a; segs[o + 29] = b; segs[o + 30] = c;
  });
  const h = [0, 1, 2].map(k => Math.max(Math.abs(f.bounds.lo[k]), Math.abs(f.bounds.hi[k])));
  return {
    sweep: { name: (opts && opts.name) || 'sweep', segs, kind, sect: [a, b, c] },
    node: { t: 'sweep', on: true, op: 'add', k: 0, b: 0, round: 0,
            mx: false, my: false, mz: false,
            p: [0, 0, 0], r: [0, 0, 0], d: h, fi: (opts && opts.fi) || 0 },
    f
  };
}

const SinterSweep = { along, fromSketch, PROFILES, profileRadius,
                      pack, SECTION_KINDS, STRIDE };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterSweep;
root.SinterSweep = SinterSweep;
})(typeof self !== 'undefined' ? self : globalThis);
