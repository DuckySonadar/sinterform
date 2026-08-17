/* SinterForm constructs - a shape assembled on a skeleton of connectors
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * A `construct` is the kernel's fourth slotted primitive: its shape is a list
 * of items on the document rather than three dims on the node. This file is
 * where that list comes from, and it stands in the same relation to the
 * `construct` primitive that sweep.js stands in to `sweep` -- it constructs,
 * the kernel evaluates, and the two halves meet at a flat array of numbers.
 *
 * The skeleton is a tree of **connectors**. A connector is a joint: a parent,
 * an offset in the parent's frame, a rest rotation, a pose rotation, and the
 * masses it wears. That is the object an animation keyframes -- you rotate a
 * joint, not a bone -- and since every bone has exactly one proximal joint,
 * making the joint the object costs nothing and gives the keyframe an owner.
 *
 * `mass` is one mass or a list of them, and the distinction matters more than
 * it looks. How many places a body bends and how many primitives it takes to
 * look like a body are two different counts: an arm articulates at the
 * shoulder, the elbow and the wrist and nowhere else, but a shoulder wears a
 * humerus, a deltoid, a biceps and a triceps. Forcing them to be one count
 * means inventing child connectors with zero offsets to carry the extra
 * shapes -- and then the skeleton is full of things that do not articulate,
 * and anything walking `joints` to build an animation has to know which
 * entries are real.
 *
 * The tree is walked **here**, once, and never by the evaluator. `pack()`
 * composes each connector's transform down the chain and emits one item per
 * mass carrying its own resolved frame, so the primitive sees a flat list and
 * has no hierarchy, no recursion and no dynamic indexing in it. That is the
 * same division sweep.js already makes -- the frame is carried, not computed --
 * and for the same reason: transport is a global property of the skeleton and
 * an SDF is local.
 *
 * What it buys is the thing this is for. Posing is a repack: twenty joints of
 * quaternion composition, microseconds, and the topology does not change -- so
 * the shader is compiled once per skeleton and a new pose is a uniform upload.
 * Animation is that, per frame.
 *
 * ## Rigid motions only
 *
 * Every connector transform is a rotation and a translation. There is no scale
 * anywhere in this file, and `pack()` refuses one rather than letting it
 * through, because a scaled frame does not preserve distance: the primitive
 * would go on returning numbers, the raymarcher would go on stepping by them,
 * and it would overshoot. A mass that wants to be bigger says so in its own
 * dims, which is a different thing entirely -- the dims are the shape, the
 * frame is only where the shape is.
 *
 * That constraint is what keeps a construct 1-Lipschitz: rigid frames, exact
 * masses, folded with `smin`.
 *
 * ## Why an SDF rig is not a skinned mesh
 *
 * There are no weights here and no skin to bind. The join between two masses
 * *is* `smin`, evaluated at the sample, so a rotated joint deforms correctly by
 * construction -- no candy-wrapper twist, no interpenetration at the elbow, and
 * the result is watertight and printable at any pose, which is the whole reason
 * to rig a solid this way instead of a surface.
 *
 * Same rule as the kernel: nothing here may spell a literal closing script
 * tag, because this gets inlined into HTML too.
 */
(function (root) {
"use strict";

const RAD = Math.PI / 180;

// ------------------------------------------------------------ quaternions ---
// A frame is carried as a unit quaternion rather than a 3x3 because the item
// pays for it twice: four floats instead of nine in whatever uniform block the
// consumer packs, and slerp between keyframes when this grows a timeline.

// Hamilton product. `qmul(a, b)` is a applied *after* b, matching the way the
// kernel composes Euler angles.
function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

function qconj(q) { return [-q[0], -q[1], -q[2], q[3]]; }

// v rotated by q: v + 2w(qv x v) + 2 qv x (qv x v).
function qrot(q, v) {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]);
  const ty = 2 * (q[2] * v[0] - q[0] * v[2]);
  const tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + q[1] * tz - q[2] * ty,
    v[1] + q[3] * ty + q[2] * tx - q[0] * tz,
    v[2] + q[3] * tz + q[0] * ty - q[1] * tx
  ];
}

// Euler degrees to a quaternion, in the kernel's convention: Rz*Ry*Rx, so the
// x rotation happens first. A rig that hands angles to a connector and angles
// to a node must mean the same thing by them.
function qfromEuler(e) {
  const x = (e[0] || 0) * RAD * 0.5, y = (e[1] || 0) * RAD * 0.5,
        z = (e[2] || 0) * RAD * 0.5;
  const qx = [Math.sin(x), 0, 0, Math.cos(x)];
  const qy = [0, Math.sin(y), 0, Math.cos(y)];
  const qz = [0, 0, Math.sin(z), Math.cos(z)];
  return qmul(qz, qmul(qy, qx));
}

// Composition of many rotations drifts off the unit sphere in the last bits,
// and a non-unit quaternion is a scale -- exactly the thing this file refuses
// elsewhere -- so every composed frame is renormalised before it is used.
function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 1e-12)) return [0, 0, 0, 1];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// ------------------------------------------------------------------ masses --
// What a connector wears. `kind` crosses into the shader as a number, the way
// a sweep's section does, and the branch folds away because it arrives at the
// unroller as a literal.
//
// Every mass is stated in its connector's frame and every one of them is a
// primitive the library already believes in -- a round cone, an ellipsoid, a
// sphere, a rounded box. They are written out again in the construct's own
// GLSL rather than called, because the generator seeds a primitive's source
// with `smin` and its own helpers and nothing else; `sweep` writes out its
// sections for the same reason.
const MASS_KINDS = { bone: 0, ellipsoid: 1, sphere: 2, box: 3 };

// dims and the tip slot, per kind. `tip` is the second radius of a bone and
// the corner rounding of a box; the kinds that have neither leave it zero.
function massData(m) {
  const kind = MASS_KINDS[m && m.kind];
  if (kind === undefined)
    throw new Error("a connector's mass wants {kind: 'bone'|'ellipsoid'|'sphere'|'box'}");
  const h = m.half || [0, 0, 0];
  switch (kind) {
    case 0: {
      const r0 = num(m.r0, 'bone r0'), r1 = m.r1 === undefined ? r0 : num(m.r1, 'bone r1');
      const len = num(m.len, 'bone len');
      if (r0 <= 0 || r1 <= 0 || len <= 0)
        throw new Error('a bone wants len > 0 and radii > 0');
      // `aspect` is the cross-section's second radius as a ratio of the first,
      // so 1 is a round bone and anything else is an elliptical one. It rides
      // in the dim a bone has no other use for.
      const asp = m.aspect === undefined ? 1 : num(m.aspect, 'bone aspect');
      if (asp <= 0) throw new Error('a bone wants aspect > 0');
      return { kind, dims: [r0, asp, len], tip: r1 };
    }
    case 1:
      if (!(h[0] > 0 && h[1] > 0 && h[2] > 0))
        throw new Error('an ellipsoid mass wants half: [a, b, c], all > 0');
      return { kind, dims: [h[0], h[1], h[2]], tip: 0 };
    case 2: {
      const r = num(m.r, 'sphere r');
      if (r <= 0) throw new Error('a sphere mass wants r > 0');
      return { kind, dims: [r, 0, 0], tip: 0 };
    }
    default: {
      if (!(h[0] > 0 && h[1] > 0 && h[2] > 0))
        throw new Error('a box mass wants half: [a, b, c], all > 0');
      const rd = Math.max(m.round || 0, 0);
      return { kind, dims: [h[0], h[1], h[2]], tip: Math.min(rd, Math.min(h[0], Math.min(h[1], h[2]))) };
    }
  }
}

// What a connector wears, as a list. One mass or many: a joint is an
// articulation and the flesh on it is however many primitives that flesh
// takes, which are two different counts and should not be forced to be one.
//
// Hanging a second shape off a joint used to mean inventing a child connector
// with a zero offset to carry it -- which put things in the skeleton that do
// not articulate, so iterating `joints` to build an animation found a deltoid
// and a biceps among the shoulders. The skeleton is the topology; this is the
// geometry, and the two are now counted separately.
function massList(j) {
  const m = j.mass;
  if (m === undefined || m === null) return [];
  return Array.isArray(m) ? m.filter(x => x !== undefined && x !== null) : [m];
}

function num(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new Error(`${what} must be a finite number`);
  return v;
}

// The bounding sphere a mass occupies in its own frame: centre offset along
// the local axis, and a radius. This is what the primitive's cull test reads,
// and it is read before anything else in the item -- a connector that cannot
// win is answered without its frame ever being touched.
function massBall(md) {
  const [a, b, c] = md.dims;
  switch (md.kind) {
    // an elliptical bone reaches `aspect` times its radius on the second axis,
    // so the ball has to allow for whichever axis is the wider one
    case 0: return { c: [0, 0, c * 0.5],
                     r: c * 0.5 + Math.max(a, md.tip) * Math.max(b, 1) };
    case 1: return { c: [0, 0, 0], r: Math.max(a, Math.max(b, c)) };
    case 2: return { c: [0, 0, 0], r: a };
    default: return { c: [0, 0, 0], r: Math.hypot(a, b, c) };
  }
}

// Half-extents of a mass in its own frame, resolved onto world axes through
// the frame's rotation. Exact for all four kinds rather than falling back on
// the bounding sphere, because these become the node's dims and a loose box is
// a bigger mesh grid for every sample the mesher takes.
function massExtent(md, q) {
  const [a, b, c] = md.dims;
  // rows of the local->world rotation: row[k][i] is how much local axis i
  // contributes to world axis k
  const e0 = qrot(q, [1, 0, 0]), e1 = qrot(q, [0, 1, 0]), e2 = qrot(q, [0, 0, 1]);
  const row = (k) => [e0[k], e1[k], e2[k]];
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const R = row(k);
    if (md.kind === 1) {
      // a rotated ellipsoid's silhouette on an axis is the norm of the scaled row
      out[k] = Math.hypot(R[0] * a, R[1] * b, R[2] * c);
    } else if (md.kind === 3) {
      out[k] = Math.abs(R[0]) * a + Math.abs(R[1]) * b + Math.abs(R[2]) * c;
    } else if (md.kind === 2) {
      out[k] = a;
    } else {
      // A bone is the convex hull of its two end caps, and a hull's support
      // function is the greater of theirs -- so its box is the union of their
      // boxes, exactly. The caps are ellipsoids of semi-axes (r, r*aspect, r),
      // and the extent is measured about the point between them, so it is
      // *half* the length that projects onto the axis. Using the whole length,
      // or the tip's radius rather than the larger one, leaves a box that
      // still contains the solid and is loose by centimetres -- which no
      // containment check would ever notice.
      const cap = (r) => Math.hypot(R[0] * r, R[1] * r * b, R[2] * r);
      out[k] = Math.abs(R[2]) * c * 0.5 + Math.max(cap(a), cap(md.tip));
    }
  }
  return out;
}

// The centre a mass's extent is measured about, in its own frame -- zero for
// everything but a bone, whose two balls straddle the axis.
function massCentre(md) {
  return md.kind === 0 ? [0, 0, md.dims[2] * 0.5] : [0, 0, 0];
}

// -------------------------------------------------------------------- pack --
// The item layout, in the order the primitive reads it: the four the cull test
// needs first, then the frame, then the shape. The same order is written down
// in build-twins.mjs's intrinsic table and comes out of the unroller as the
// ITEM macro's parameters -- one layout said three times, and check-glsl runs
// both ends of it on the same data.
//
//   0..2   cull centre, construct space
//   3      cull radius, blend margin already in it
//   4..6   the mass's own origin, construct space
//   7..9   inverse frame rotation, imaginary part
//   10     inverse frame rotation, real part
//   11..13 the mass's dims
//   14..16 kind, tip, blend radius
//
// The rotation is stored **inverted**, because the shader wants local = R' (p -
// o) and inverting a unit quaternion is a sign flip: done once here rather than
// once per sample per item.
const STRIDE = 17;

// The most a polynomial smin can push the surface out past the union of the two
// shapes it folds, as a fraction of the blend radius. `k*h*(1 - h)` peaks at
// h = 0.5. Bounds have to allow for it or a blended joint pokes out of the box.
const SMIN_BULGE = 0.25;

function pack(rig, opts) {
  const joints = (rig && rig.joints) || [];
  if (!joints.length) throw new Error('a rig wants at least one connector in `joints`');

  // name -> index, filled as we go, so a parent must already have been seen.
  // Requiring parents first is what makes one forward pass enough, and it
  // makes the item order a property of the rig rather than of a traversal.
  const byName = new Map();
  const world = [];                       // resolved [pos, quat] per connector
  const items = [];

  joints.forEach((j, i) => {
    if (!j) throw new Error(`connector ${i} is empty`);
    const wears = massList(j);
    if ('scale' in j || wears.some(m => m && 'scale' in m))
      throw new Error(`connector ${j.name || i}: a connector transform is a rigid `
        + 'motion -- rotation and translation only. Size belongs in the mass\'s '
        + 'own dims, not in the frame: a scaled frame stops the primitive being '
        + 'a distance function and the raymarcher overshoots it.');

    let pi = -1;
    if (j.parent !== undefined && j.parent !== null && j.parent !== -1) {
      pi = typeof j.parent === 'number' ? j.parent
         : (byName.has(j.parent) ? byName.get(j.parent) : -2);
      if (pi === -2) throw new Error(`connector ${j.name || i}: no connector named `
        + `${JSON.stringify(j.parent)} -- a parent must be declared before its child`);
      if (!(pi >= 0 && pi < i)) throw new Error(`connector ${j.name || i}: parent `
        + `${j.parent} is not an earlier connector; rigs are declared parents first`);
    }

    const pPos = pi < 0 ? [0, 0, 0] : world[pi].p;
    const pRot = pi < 0 ? [0, 0, 0, 1] : world[pi].q;

    // offset is stated in the parent's frame; rest and pose both turn the
    // joint itself, rest first, so a pose angle always reads as "away from
    // rest" no matter how the skeleton was built.
    const off = j.offset || [0, 0, 0];
    const wp = add(pPos, qrot(pRot, off));
    const wq = qnorm(qmul(pRot, qmul(qfromEuler(j.rot || [0, 0, 0]),
                                     qfromEuler(j.pose || [0, 0, 0]))));
    world.push({ p: wp, q: wq });
    if (j.name) byName.set(j.name, i);

    // A connector with no mass is a pure articulation, which is a useful thing
    // to be: a clavicle or a spine link earns its place by what hangs below it.
    for (const one of wears) {
      let md;
      try { md = massData(one); }
      catch (e) { throw new Error(`connector ${j.name || i}: ${e.message}`); }
      const k = Math.max(one.k || 0, 0);
      // A mass may sit off the joint it hangs from -- a thorax is centred up
      // the spine, not at its base, and a deltoid caps a shoulder a hand's
      // width down the arm -- and that offset is resolved here, so the item's
      // origin is the mass's own and the pivot never reaches the shader.
      const mq = qnorm(qmul(wq, qfromEuler(one.rot || [0, 0, 0])));
      const mp = add(wp, qrot(wq, one.offset || [0, 0, 0]));
      const ball = massBall(md);
      const iq = qconj(mq);

      const o = items.length;
      for (let n = 0; n < STRIDE; n++) items.push(0);
      const bc = add(mp, qrot(mq, ball.c));
      items[o] = bc[0]; items[o + 1] = bc[1]; items[o + 2] = bc[2];
      items[o + 3] = ball.r + k;
      items[o + 4] = mp[0]; items[o + 5] = mp[1]; items[o + 6] = mp[2];
      items[o + 7] = iq[0]; items[o + 8] = iq[1]; items[o + 9] = iq[2];
      items[o + 10] = iq[3];
      items[o + 11] = md.dims[0]; items[o + 12] = md.dims[1]; items[o + 13] = md.dims[2];
      items[o + 14] = md.kind; items[o + 15] = md.tip; items[o + 16] = k;

      // stash what the extent pass needs, rather than unpacking the item again
      items._ = items._ || [];
      items._.push({ md, q: mq, p: mp, k });
    }
  });

  if (!items.length)
    throw new Error('a rig wants at least one connector carrying a mass');

  const d = extentOf(items._);
  delete items._;

  return {
    construct: { name: (rig && rig.name) || (opts && opts.name) || 'construct',
                 items: Float64Array.from(items) },
    node: { t: 'construct', on: true, op: 'add', k: 0, b: 0, round: 0,
            mx: false, my: false, mz: false,
            p: [0, 0, 0], r: [0, 0, 0], d, fi: (opts && opts.fi) || 0 },
    world
  };
}

// Half-extents of the whole construct: every mass's own box, placed, unioned,
// and then let out by the most a blend can push the surface past it.
function extentOf(masses) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let bulge = 0;
  for (const m of masses) {
    const c = add(m.p, qrot(m.q, massCentre(m.md)));
    const e = massExtent(m.md, m.q);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], c[k] - e[k]);
      hi[k] = Math.max(hi[k], c[k] + e[k]);
    }
    bulge = Math.max(bulge, m.k * SMIN_BULGE);
  }
  return [0, 1, 2].map(k => Math.max(Math.abs(lo[k]), Math.abs(hi[k])) + bulge);
}

function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }

const SinterConstruct = { pack, massList, MASS_KINDS, STRIDE, SMIN_BULGE,
                          qmul, qconj, qrot, qfromEuler, qnorm,
                          massData, massBall, massExtent, massCentre };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterConstruct;
root.SinterConstruct = SinterConstruct;
})(typeof self !== 'undefined' ? self : globalThis);
