/* Check that a construct is the rig it was declared to be.
 *
 *     node check-construct.mjs
 *
 * `check-primitives` already asks whether the primitive is a distance function
 * and `check-glsl` already asks whether its two twins agree. Neither of them
 * can ask the question this file exists for, because both take the packed items
 * as given: **is the packing what the skeleton said?**
 *
 * That is where a rig goes wrong. Every failure mode here is quiet -- a
 * rotation composed in the other order, a pose applied before its rest instead
 * of after, an offset resolved in the child's frame instead of the parent's, a
 * quaternion stored the right way round and applied the wrong way. All of them
 * draw a solid, and a solid that is watertight, printable and slightly wrong.
 *
 * So the checks are:
 *
 *   layout      one mass alone is exactly the library primitive it is made of,
 *               which is the only thing holding construct.js's copy of a round
 *               cone against the one in `wire` that it was copied from
 *   frames      a turned connector agrees with the kernel's own invRot on the
 *               same Euler angles, so the quaternion path cannot mean a
 *               different rotation than the rest of the kernel does
 *   chains      a child follows its parent, and posing by t is declaring at
 *               rest + t -- the two properties an animation rests on
 *   rigid       a scaled connector is refused rather than quietly ruining the
 *               distance
 *   cull        culling changes the cost and never the answer
 *   bounds      `ext` still contains the solid after the rig is posed, which
 *               is the one thing about a construct that moves its box
 *
 * Exit code is 0 or 1, so it can be a CI step.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f) => {
  const m = { exports: {} };
  new Function('module', readFileSync(join(HERE, f), 'utf8'))(m);
  return m.exports;
};
const SF = load('sinterform.js');
const CN = load('construct.js');

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};

let seed = 0x51ed270b;
const rnd = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed |= 0;
  return (seed >>> 0) / 4294967296;
};
const span = (h) => (rnd() * 2 - 1) * h;
const RAD = Math.PI / 180;

// Evaluate a construct that has been put in slot 0.
const at = (p) => SF.PRIMS.construct.js(p, [1, 1, 1], 0, { fi: 0 });
const put = (joints) => {
  const packed = CN.pack({ name: 'check', joints });
  SF.constructs = [packed.construct];
  return packed;
};
// worst |a - b| over n random points in a box
const worst = (f, g, h, n) => {
  let w = 0;
  for (let i = 0; i < n; i++) {
    const p = [span(h[0]), span(h[1]), span(h[2])];
    w = Math.max(w, Math.abs(f(p) - g(p)));
  }
  return w;
};

// ---------------------------------------------------------------- layout ----
// A construct's masses are the library's own primitives written out a second
// time, because the generator seeds a primitive's source with `smin` and its
// own helpers and nothing else -- so a construct cannot *call* pBox, and
// `sweep` writes out its sections for the same reason. A second copy is a
// second thing to keep in step, and this is what keeps it: one unblended mass,
// at rest, against the primitive it was copied from, on the same points.
console.log('\none mass alone is the primitive it is made of');
{
  const R = 6.5;
  put([{ name: 'j', mass: { kind: 'sphere', r: R, k: 0 } }]);
  ok(worst(at, (p) => Math.hypot(p[0], p[1], p[2]) - R, [20, 20, 20], 4000) < 1e-12,
     'sphere: exactly length(p) - r');
}
{
  // The one that is deliberately not equal. An ellipsoid mass is iq's bound
  // clamped from below by its own bounding sphere -- the cull needs that, see
  // below -- so it agrees with `pEllip` near the shape and is *greater* far
  // away, where iq's bound falls behind. Both statements are worth making:
  // greater is a tightening and can only ever be safe, and the surface itself
  // has to be exactly where it was or the clamp is not a clamp, it is a shape.
  const h = [7, 4, 5.5];
  put([{ name: 'j', mass: { kind: 'ellipsoid', half: h, k: 0 } }]);
  const iq = (p) => SF.PRIMS.ellipsoid.js(p, [2 * h[0], 2 * h[1], 2 * h[2]], 0, {});
  let below = 0, near = 0, worstNear = 0;
  for (let i = 0; i < 6000; i++) {
    const p = [span(22), span(22), span(22)];
    const a = at(p), b = iq(p);
    if (a < b - 1e-12) below++;
    if (Math.abs(b) < 3) { near++; worstNear = Math.max(worstNear, Math.abs(a - b)); }
  }
  ok(below === 0, 'ellipsoid: never below pEllip — the clamp only tightens');
  ok(near > 200 && worstNear < 1e-12,
     `ellipsoid: and equal to it within 3 mm of the surface `
     + `(${near} points, worst ${worstNear.toExponential(2)})`);

  // the surface is where it was: points on the exact ellipsoid read zero
  let onSurf = 0;
  for (let i = 0; i < 3000; i++) {
    const u = span(1), t = rnd() * 2 * Math.PI, s = Math.sqrt(1 - u * u);
    const p = [h[0] * s * Math.cos(t), h[1] * s * Math.sin(t), h[2] * u];
    onSurf = Math.max(onSurf, Math.abs(at(p)));
  }
  ok(onSurf < 1e-9, `ellipsoid: and its surface is unmoved (worst ${onSurf.toExponential(2)} mm)`);
}
{
  const h = [5, 3, 6], rd = 1.1;
  put([{ name: 'j', mass: { kind: 'box', half: h, round: rd, k: 0 } }]);
  const w = worst(at, (p) => SF.PRIMS.box.js(p, [2 * h[0], 2 * h[1], 2 * h[2]], rd, {}),
                  [20, 20, 22], 4000);
  ok(w < 1e-12, `box: exactly pBox, rounding through the same slot (worst ${w.toExponential(2)})`);
}
{
  // The one worth the most: a bone is iq's round cone, and so is every segment
  // of a wire. If these two ever stop agreeing, one of them has been edited.
  const len = 22, r0 = 5, r1 = 2;
  put([{ name: 'j', mass: { kind: 'bone', len, r0, r1, k: 0 } }]);
  SF.wires = [{ name: 'same bone', lines: [[[0, 0, 0, r0], [0, 0, len, r1]]] }];
  const w = worst(at, (p) => SF.PRIMS.wire.js(p, [1, 1, 1], 0, { fi: 0 }),
                  [26, 26, 34], 6000);
  ok(w < 1e-12, `bone: exactly a wire's round cone, same ends, same radii (worst ${w.toExponential(2)})`);

  // An elliptical bone is that same round cone measured in a squashed space,
  // with the answer scaled back by the smaller of the two axes -- which is
  // what keeps it 1-Lipschitz and what makes it a bound rather than a
  // distance. Both halves of that are checked here: it agrees with the
  // construction everywhere, and it never over-reports.
  for (const asp of [0.55, 1.8]) {
    put([{ name: 'j', mass: { kind: 'bone', len: 24, r0: 5, r1: 3, aspect: asp, k: 0 } }]);
    SF.wires = [{ name: 'round twin', lines: [[[0, 0, 0, 5], [0, 0, 24, 3]]] }];
    const ref = (p) => SF.PRIMS.wire.js([p[0], p[1] / asp, p[2]], [1, 1, 1], 0, { fi: 0 })
                       * Math.min(asp, 1);
    // Like the ellipsoid, an anisotropic bone is a bound rather than a
    // distance, so it is clamped from below by its own bounding sphere. That
    // clamp beats the squashed cone by the whole factor 1/aspect off the ends,
    // right up to the surface -- which is the bound being loose, not the shape
    // being different. So the claim to make is about the *solid*: identical
    // sign everywhere, never under the cone, and equal wherever it is inside.
    let below = 0, wrongSide = 0, inside = 0, worstIn = 0;
    for (let i = 0; i < 8000; i++) {
      // biased onto the bone rather than over the whole neighbourhood, or a
      // thin one gets a handful of interior samples and the interior claim is
      // made on nothing
      const p = [span(9), span(9), span(21) + 11];
      const a = at(p), b = ref(p);
      if (a < b - 1e-12) below++;
      if ((a < 0) !== (b < 0)) wrongSide++;
      if (b < 0) { inside++; worstIn = Math.max(worstIn, Math.abs(a - b)); }
    }
    ok(wrongSide === 0 && inside > 200,
       `bone: aspect ${asp} encloses exactly that cone squashed `
       + `(${inside} interior points, no disagreement of side)`);
    ok(below === 0 && worstIn < 1e-12,
       `  and never reports under it, and is it exactly within the solid `
       + `(worst ${worstIn.toExponential(2)})`);

    // the surface really is an ellipse of that ratio, measured on the solid
    put([{ name: 'j', mass: { kind: 'bone', len: 24, r0: 5, r1: 5, aspect: asp, k: 0 } }]);
    const reach = (ax) => {
      let lo = 0, hi = 40;
      for (let i = 0; i < 60; i++) {
        const m = (lo + hi) / 2;
        const p = [0, 0, 12];
        p[ax] = m;
        if (at(p) < 0) lo = m; else hi = m;
      }
      return lo;
    };
    const rx = reach(0), ry = reach(1);
    ok(Math.abs(ry / rx - asp) < 1e-6,
       `and its section is ${rx.toFixed(2)} by ${ry.toFixed(2)} mm, a ratio of `
       + `${(ry / rx).toFixed(3)}`);
  }

  // and the degenerate one, where one ball swallows the other and there is no
  // tangent cone between them -- reachable by tapering a short bone hard
  put([{ name: 'j', mass: { kind: 'bone', len: 2, r0: 9, r1: 1, k: 0 } }]);
  SF.wires = [{ name: 'swallowed', lines: [[[0, 0, 0, 9], [0, 0, 2, 1]]] }];
  const w2 = worst(at, (p) => SF.PRIMS.wire.js(p, [1, 1, 1], 0, { fi: 0 }),
                   [24, 24, 24], 4000);
  ok(w2 < 1e-12, `bone: and where one ball swallows the other (worst ${w2.toExponential(2)})`);
}

// ---------------------------------------------------------------- frames ----
// The kernel turns a node with `invRot` on Euler degrees applied Rz*Ry*Rx.
// A connector turns with a quaternion. They have to mean the same thing by the
// same three numbers, or a rig assembled from measured angles is assembled
// wrong -- and wrong in a way that still looks like a body.
console.log('\na turned connector means what the kernel means by a rotation');
{
  const h = [6, 3, 4.5];
  for (const e of [[0, 40, 0], [25, 0, 0], [0, 0, -70], [18, -33, 51]]) {
    put([{ name: 'j', rot: e, mass: { kind: 'box', half: h, k: 0 } }]);
    const out = [0, 0, 0];
    const ref = (p) => {
      SF.invRot(p[0], p[1], p[2], [e[0] * RAD, e[1] * RAD, e[2] * RAD], out);
      return SF.PRIMS.box.js(out, [2 * h[0], 2 * h[1], 2 * h[2]], 0, {});
    };
    const w = worst(at, ref, [20, 20, 20], 3000);
    ok(w < 1e-9, `rot ${JSON.stringify(e)}: agrees with invRot (worst ${w.toExponential(2)})`);
  }
}

// ---------------------------------------------------------------- chains ----
console.log('\na chain composes, and a pose is a repack');
{
  // Posing a connector by t is the same shape as declaring it at rest + t.
  // This is the property an animation is: if it fails, a keyframe means
  // something different from the rig it keyframes.
  const arm = (rest, pose) => [
    { name: 'a', offset: [0, 0, -8], rot: [0, 15, 0],
      mass: { kind: 'bone', len: 16, r0: 3, r1: 2.4, k: 0 } },
    { name: 'b', parent: 'a', offset: [0, 0, 16], rot: rest, pose,
      mass: { kind: 'bone', len: 14, r0: 2.4, r1: 1.8, k: 0 } }
  ];
  put(arm([0, 20, 0], [0, 35, 0]));
  const posed = [];
  const pts = [];
  for (let i = 0; i < 3000; i++) pts.push([span(30), span(30), span(34)]);
  for (const p of pts) posed.push(at(p));
  put(arm([0, 55, 0], [0, 0, 0]));
  let w = 0;
  pts.forEach((p, i) => { w = Math.max(w, Math.abs(at(p) - posed[i])); });
  ok(w < 1e-12, `rest 20 + pose 35 is rest 55 (worst ${w.toExponential(2)})`);
}
{
  // A child follows its parent. Turning the root has to carry the tip with it,
  // which is the difference between a skeleton and a list of shapes.
  const rig = (rootPose) => [
    { name: 'root', pose: rootPose, mass: { kind: 'sphere', r: 4, k: 0 } },
    { name: 'tip', parent: 'root', offset: [0, 0, 20],
      mass: { kind: 'sphere', r: 3, k: 0 } }
  ];
  const packed = put(rig([0, 90, 0]));
  const tip = packed.world[1].p;
  ok(Math.hypot(tip[0] - 20, tip[1], tip[2]) < 1e-9,
     `a 90 deg turn at the root puts the tip at +X: [${tip.map(v => v.toFixed(3))}]`);

  // and the mass really is there, not merely recorded as there
  ok(Math.abs(at([20, 0, 0]) + 3) < 1e-9, 'and the solid is there too, 3 mm deep');
}
{
  // Declaring a parent after its child is a rig nobody meant to write, and a
  // forward pass cannot resolve it -- so it is refused rather than silently
  // treated as a root.
  let threw = false;
  try {
    CN.pack({ joints: [
      { name: 'child', parent: 'parent', mass: { kind: 'sphere', r: 3 } },
      { name: 'parent', mass: { kind: 'sphere', r: 3 } }
    ] });
  } catch (e) { threw = /declared before its child|not an earlier/.test(e.message); }
  ok(threw, 'a child declared before its parent is refused');
}

// ----------------------------------------------------------------- rigid ----
// The invariant the whole primitive rests on. A scaled frame does not preserve
// distance: the primitive would go on returning numbers and the marcher would
// go on stepping by them, straight through a surface. Size belongs in the
// mass's own dims, which is a different thing.
console.log('\nevery connector transform is a rigid motion');
{
  for (const [what, joints] of [
    ['a scaled connector', [{ name: 'j', scale: 2, mass: { kind: 'sphere', r: 4 } }]],
    ['a scaled mass', [{ name: 'j', mass: { kind: 'sphere', r: 4, scale: 2 } }]]
  ]) {
    let threw = false;
    try { CN.pack({ joints }); } catch (e) { threw = /rigid motion/.test(e.message); }
    ok(threw, `${what} is refused`);
  }
  // and the composed frames really are unit, which is the same statement
  // arrived at from the other side -- drift here is a slow scale
  const packed = put([
    { name: 'a', rot: [12, 34, 56], mass: { kind: 'sphere', r: 3 } },
    { name: 'b', parent: 'a', rot: [78, -23, 41], pose: [5, 5, 5], offset: [0, 0, 9],
      mass: { kind: 'sphere', r: 2 } },
    { name: 'c', parent: 'b', rot: [-61, 17, -88], pose: [0, 30, 0], offset: [0, 0, 7],
      mass: { kind: 'sphere', r: 2 } }
  ]);
  let off = 0;
  for (const w of packed.world)
    off = Math.max(off, Math.abs(Math.hypot(w.q[0], w.q[1], w.q[2], w.q[3]) - 1));
  ok(off < 1e-12, `three composed frames stay unit (worst drift ${off.toExponential(2)})`);
}

// ------------------------------------------------------------------ cull ----
// The cull is an optimisation and has to be invisible. smin(best, dd, k) is
// best whenever dd >= best + k, and the k is already inside the radius
// construct.js packs -- so a culled connector cannot have changed the answer.
//
// The reference is the same evaluator run one item at a time. A construct with
// a single item cannot cull -- nothing has been found yet, so nothing can lose
// to it -- and smin(1e18, dd, k) is dd, so each run hands back exactly the
// distance that item contributed. Folding those in the same order with the
// same blend radii is the whole primitive with the skip taken out, and nothing
// else changed. Widening the cull radius instead would have been the obvious
// way to write this and the wrong one: the radius is also what clamps a mass
// to its own bounding sphere, so a rig-sized radius does not disable the cull,
// it disables the clamp and compares two different shapes.
console.log('\nculling changes the cost and not the answer');
{
  const joints = [
    { name: 'root', offset: [0, 0, -12],
      mass: { kind: 'bone', len: 20, r0: 4.5, r1: 3.4, k: 0 } },
    { name: 'chest', parent: 'root', offset: [0, 0, 16], rot: [0, 10, 0],
      mass: { kind: 'ellipsoid', half: [8, 5, 7], offset: [0, 0, 2], k: 3.5 } },
    { name: 'head', parent: 'chest', offset: [0, 0, 11], rot: [6, 0, 15],
      mass: { kind: 'sphere', r: 5, k: 2.5 } },
    { name: 'armL', parent: 'chest', offset: [4, 0, 5], rot: [0, 70, 10],
      mass: { kind: 'bone', len: 15, r0: 2.6, r1: 1.7, k: 3 } },
    { name: 'handL', parent: 'armL', offset: [0, 0, 15], rot: [0, 30, 0],
      mass: { kind: 'box', half: [3, 1.4, 3.8], round: 1, k: 2 } },
    { name: 'armR', parent: 'chest', offset: [-4, 0, 5], rot: [0, -70, -10],
      mass: { kind: 'bone', len: 15, r0: 2.6, r1: 1.7, k: 3 } }
  ];
  const packed = CN.pack({ name: 'culled', joints });
  const S = SF.CON_STRIDE;
  const items = packed.construct.items;
  const n = items.length / S;
  const single = [];
  for (let i = 0; i < n; i++)
    single.push({ name: `item ${i}`, items: items.slice(i * S, (i + 1) * S) });

  const d = packed.node.d;
  const pts = [];
  for (let i = 0; i < 6000; i++)
    pts.push([span(d[0] * 1.6), span(d[1] * 2.2), span(d[2] * 1.5)]);

  SF.constructs = [packed.construct];
  const culled = pts.map(at);

  const unculled = pts.map(() => 1e18);
  for (let i = 0; i < n; i++) {
    SF.constructs = [single[i]];
    const k = single[i].items[16];
    pts.forEach((p, j) => { unculled[j] = SF.smin(unculled[j], at(p), k); });
  }
  let w = 0;
  pts.forEach((p, j) => { w = Math.max(w, Math.abs(unculled[j] - culled[j])); });
  // Not bit-identical, and it cannot be: where the cull fires, the fold it
  // stood in for would have been smin(best, dd, k) with h landing exactly on
  // 1, and `mix(dd, best, 1.0) - 0.0` is `best` in arithmetic and best plus an
  // ulp or two in floating point. A millimetre of difference is a cull that is
  // wrong; this is the width of the number.
  ok(w < 1e-12, `identical over ${pts.length} points, ${n} connectors, `
    + `culled and not (worst ${w.toExponential(2)} mm)`);

  // and the cull is actually firing, or the line above proves nothing
  let skipped = 0, seen = 0;
  for (const p of pts) {
    let best = 1e18;
    for (let i = 0; i < n; i++) {
      const o = i * S;
      seen++;
      if (Math.hypot(p[0] - items[o], p[1] - items[o + 1], p[2] - items[o + 2])
          - items[o + 3] >= best) { skipped++; continue; }
      SF.constructs = [single[i]];
      best = SF.smin(best, at(p), items[o + 16]);
    }
  }
  ok(skipped > seen / 5, `and it skips most of the work: ${skipped} of ${seen} `
    + `connector visits answered by the cull test alone`);
}

// ---------------------------------------------------------------- bounds ----
// Posing is the one thing about a construct that moves its box, so `ext` has
// to be recomputed by the repack and has to still contain the solid -- blend
// bulge included, since smin pushes the surface out past the union of what it
// folds by up to k/4.
console.log('\nthe box still contains the solid at any pose');
{
  // the most a blend can push the surface past the union it folds, which is
  // what extentOf pads the box by -- taken from construct.js rather than
  // written down again here
  const BULGE = 4 * CN.SMIN_BULGE;                  // the largest k in the rig
  let bad = 0, escaped = 0, tightest = -Infinity;
  for (let trial = 0; trial < 24; trial++) {
    const a = () => [span(60), span(60), span(60)];
    const packed = put([
      { name: 'root', offset: [0, 0, -10], pose: a(),
        mass: { kind: 'bone', len: 18, r0: 4, r1: 3, k: 2 } },
      { name: 'chest', parent: 'root', offset: [0, 0, 14], pose: a(),
        mass: { kind: 'ellipsoid', half: [7, 4.5, 6], offset: [0, 0, 1], k: 4 } },
      { name: 'arm', parent: 'chest', offset: [3, 0, 4], pose: a(),
        mass: { kind: 'bone', len: 13, r0: 2.4, r1: 1.5, k: 3 } },
      { name: 'hand', parent: 'arm', offset: [0, 0, 13], pose: a(),
        mass: { kind: 'box', half: [2.6, 1.2, 3.4], round: 0.9, k: 2 } }
    ]);
    const E = SF.PRIMS.construct.ext(packed.node.d);
    const R = Math.max(E[0], E[1], E[2]);
    // a shell just outside the declared box: nothing solid may be out there
    for (let i = 0; i < 3000; i++) {
      const ax = Math.floor(rnd() * 3), sgn = rnd() < 0.5 ? -1 : 1;
      const p = [span(E[0] * 1.6), span(E[1] * 1.6), span(E[2] * 1.6)];
      p[ax] = sgn * (E[ax] + 0.02 + rnd() * R);
      if (at(p) < 0) { escaped++; }
    }
    // and it is not absurdly generous either: the solid has to come up to a
    // face somewhere. The bar allows the blend bulge, because that padding is
    // applied to all six faces and only earned on the ones a blend reaches --
    // paying for it per face would mean knowing which joint bulges which way,
    // which is a lot of arithmetic to save a millimetre on a mesh grid.
    let near = Infinity;
    for (let i = 0; i < 6000; i++) {
      const ax = Math.floor(rnd() * 3), sgn = rnd() < 0.5 ? -1 : 1;
      const p = [span(E[0]), span(E[1]), span(E[2])];
      p[ax] = sgn * E[ax];
      near = Math.min(near, at(p));
    }
    tightest = Math.max(tightest, near);
    if (!(near < BULGE + 1.5)) bad++;
  }
  ok(escaped === 0, `24 random poses, nothing solid outside ext()`);
  ok(bad === 0, `and the box stays tight against the solid on every one of `
    + `them (worst gap ${tightest.toFixed(3)} mm, bulge allowance `
    + `${BULGE.toFixed(2)})`);
}

// --------------------------------------------------------------- default ----
// The empty slot's armature is the one construct not built by this file: it is
// written out as raw floats in the kernel, because the kernel must not depend
// on construct.js any more than it depends on sweep.js. So its `def` is
// hand-written too, right beside it, and nothing else holds the two together
// -- check-primitives now tests a packed rig instead, and check-glsl compares
// the twins without ever asking what box either of them lives in.
console.log('\nthe empty slot draws its armature, inside the dims it declares');
{
  const d = SF.PRIMS.construct.def;
  const E = SF.PRIMS.construct.ext(d);
  const R = Math.max(E[0], E[1], E[2]);
  const empty = (p) => SF.PRIMS.construct.js(p, d, 0, { fi: 99 });

  let lo = Infinity;
  for (let i = 0; i < 20000; i++)
    lo = Math.min(lo, empty([span(E[0]), span(E[1]), span(E[2])]));
  ok(lo < -1, `it is a solid (deepest sample ${lo.toFixed(2)} mm)`);

  let escaped = 0;
  for (let i = 0; i < 40000; i++) {
    const ax = Math.floor(rnd() * 3), sgn = rnd() < 0.5 ? -1 : 1;
    const p = [span(E[0] * 1.5), span(E[1] * 1.5), span(E[2] * 1.5)];
    p[ax] = sgn * (E[ax] + 0.02 + rnd() * R);
    if (empty(p) < 0) escaped++;
  }
  ok(escaped === 0, `and def [${d}] contains it`);

  let near = Infinity;
  for (let i = 0; i < 40000; i++) {
    const ax = Math.floor(rnd() * 3), sgn = rnd() < 0.5 ? -1 : 1;
    const p = [span(E[0]), span(E[1]), span(E[2])];
    p[ax] = sgn * E[ax];
    near = Math.min(near, empty(p));
  }
  ok(near < 1.5, `and does not waste a box on it (closest approach to a face `
    + `${near.toFixed(3)} mm)`);

  // all four kinds are in it, which is what makes the viewer's
  // every-primitive scene a test of the kind dispatch rather than of one arm
  const S = SF.CON_STRIDE;
  const items = SF.slotItems('construct', undefined);
  const kinds = new Set();
  for (let o = 14; o < items.length; o += S) kinds.add(items[o]);
  ok(kinds.size === 4, `and it uses all four kinds (${[...kinds].sort().join(', ')})`);
}

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
