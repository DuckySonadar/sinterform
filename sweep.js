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
    seg.push({ ax: a[0], ay: a[1], az: a[2],
               tx: T[0], ty: T[1], tz: T[2],
               ux: U[0], uy: U[1], uz: U[2],
               vx: V[0], vy: V[1], vz: V[2],
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
      const out = oStart > oEnd ? oStart : oEnd;
      const capThis = oStart > oEnd ? S.capA : S.capB;
      const capped = Math.max(S.capA ? oStart : -1e30, S.capB ? oEnd : -1e30);
      const s = S.sA + (S.sB - S.sA) * t;
      // across the path and up it, in the frame this segment carries. For a
      // path in the XY plane that frame is (-ty, tx, 0) and +Z, so these are
      // the two lines this file had before, spelt in three coordinates.
      let u = px * S.ux + py * S.uy + pz * S.uz;
      let v = px * S.vx + py * S.vy + pz * S.vz;
      // whatever roll is left to do inside this segment, undone on the point
      if (S.dw) {
        const a = S.dw * t, ca = Math.cos(a), sa = Math.sin(a);
        const u2 = u * ca + v * sa;
        v = v * ca - u * sa;
        u = u2;
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
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let i = 0; i < 3; i++) {
      if (p[i] < lo[i]) lo[i] = p[i];
      if (p[i] > hi[i]) hi[i] = p[i];
    }
  const reach = R * sMax;
  f.bounds = { lo: lo.map(c => c - reach), hi: hi.map(c => c + reach) };
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

const SinterSweep = { along, fromSketch, PROFILES, profileRadius };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterSweep;
root.SinterSweep = SinterSweep;
})(typeof self !== 'undefined' ? self : globalThis);
