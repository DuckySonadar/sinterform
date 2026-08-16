/* SinterForm figures - the human body as a rig
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * A mannequin, as a skeleton of connectors for `construct.js` to pack.
 *
 * It is not a primitive, and that is the point. A primitive gets three dims
 * and a round slot -- twelve floats for the whole node -- and a body needs
 * thirty numbers before it has been posed at all. So the figure is *content*:
 * a table of proportions and a tree of joints, handed to a mechanism that
 * already knows how to turn those into a solid. Height, build, figure and
 * every joint angle are parameters of this function rather than of a node,
 * which is the ceiling the construct was built to get over.
 *
 * Nothing here knows about GLSL, uniforms, meshing or the kernel. It returns a
 * plain object; `SinterConstruct.pack` turns that into geometry, exactly as
 * `sweep.js` turns a path into segments. The two files do not import each
 * other, and no file in this repository imports another.
 *
 *   const rig = SinterFigure.mannequin({ height: 1750 });
 *   const { construct, node } = SinterConstruct.pack(rig);
 *   SinterForm.constructs = [construct];
 *   node.p[2] = 1750 / 2;                    // stand it on the plate
 *
 * ## The proportions are somebody else's
 *
 * `CANON` is the standard biomechanical table -- Drillis & Contini's segment
 * lengths and landmark heights as fractions of stature, the ones Winter's
 * *Biomechanics and Motor Control of Human Movement* tabulates and every gait
 * lab uses. They are stated as fractions because that is how they were
 * measured, and because it makes the one real scaling rule automatic: a figure
 * is one number tall and everything else follows from it.
 *
 * The artist's canon agrees. A head is 0.130 of stature here, which is 7.7
 * heads to a body -- the 7.5-head figure life drawing teaches, and not the
 * 8-head one fashion illustration uses, which is a stylisation rather than a
 * measurement.
 *
 * Girths are not in that table in a form this can use -- they are published as
 * circumferences on populations -- so `GIRTH` is radii for a mid-range adult,
 * also as fractions of stature, and `build` scales them. Lengths never scale
 * with build: a heavier figure is not a taller one.
 *
 * ## What "mannequin" rules out
 *
 * A shop-window mannequin, or an artist's lay figure: correct proportions and
 * correct masses -- deltoid, thorax, glute, calf -- and no features. No face,
 * no fingers or toes, no anatomy below the waist and none on the chest beyond
 * the form itself. `figure` shifts shoulder-to-hip ratio, waist and bust as
 * *shapes*, the way a dress form does, and there is nothing else there to find.
 *
 * Same rule as the kernel: nothing here may spell a literal closing script
 * tag, because this gets inlined into HTML too.
 */
(function (root) {
"use strict";

// Landmark heights above the sole and segment lengths, as fractions of
// stature. Drillis & Contini; the heights and the segments agree with each
// other to a thousandth, which is worth knowing because it means either can be
// used to place a joint and they will not drift apart.
const CANON = {
  vertex:      1.000,   // top of the head
  chin:        0.870,
  shoulder:    0.818,   // acromion
  nipple:      0.720,
  elbow:       0.630,
  hip:         0.530,   // greater trochanter
  wrist:       0.485,
  crotch:      0.485,
  knee:        0.285,
  ankle:       0.039,

  biacromial:  0.259,   // shoulder breadth, acromion to acromion
  biiliac:     0.191,   // hip breadth
  chestWidth:  0.174,
  footLength:  0.152,
  footBreadth: 0.055,

  upperArm:    0.186,   // shoulder to elbow
  forearm:     0.146,   // elbow to wrist
  hand:        0.108,   // wrist to fingertip
  thigh:       0.245,   // hip to knee
  shank:       0.246,   // knee to ankle
  headHeight:  0.130
};

// Radii, as fractions of stature, for a mid-range adult. `build` multiplies
// these and never the table above.
const GIRTH = {
  neckTop:     0.033, neckBase:    0.037,
  upperArm0:   0.0274, upperArm1:  0.0217,
  // the forearm's distal radius is the wrist, and a wrist is not round: 55 mm
  // across and 40 through on a 1750 mm figure. A circular section at the wider
  // of those leaves the hand looking stuck on rather than continued, so this
  // is nearer the narrower one and the blend does the rest.
  forearm0:    0.0229, forearm1:   0.0135,
  thigh0:      0.0490, thigh1:     0.0330,
  shank0:      0.0310, shank1:     0.0200,
  deltoid:     0.0330,
  handHalf:    [0.0210, 0.0100, 0.0540],
  headHalf:    [0.0435, 0.0560, 0.0655],
  // torso masses: half-extents and the height each is centred at
  // the pelvis sits back of the line of the trunk, which is the whole of the
  // glute as far as a mannequin is concerned: in profile a figure whose back
  // is one straight line from shoulder to thigh reads as a doll
  pelvisHalf:  [0.0955, 0.0570, 0.0580], pelvisAt:  0.545, pelvisBack: 0.0070,
  waistHalf:   [0.0780, 0.0500, 0.0550], waistAt:   0.645,
  thoraxHalf:  [0.0870, 0.0620, 0.0750], thoraxAt:  0.745,
  bustHalf:    [0.0450, 0.0360, 0.0420],
  // The shoulder girdle, as one capsule from acromion to acromion. Without it
  // the arms hang off nothing: a thorax ellipsoid is at its widest around the
  // nipple line and has tapered nearly to a point by the time it reaches
  // shoulder height, so the deltoids end up floating a hand's breadth clear of
  // the body. This is the mass a clavicle and a trapezius actually put there,
  // and it is why a figure built from a torso and two arms never looks right.
  yokeR:       0.0340, yokeAt:    0.800
};

// Blend radii, as fractions of stature. These are what make the figure a body
// rather than a bag of parts, and they are roughly a third of the smaller
// radius at each joint -- enough to fill the crease, not enough to swallow the
// landmark. They scale with `build`, because a blend is a girth.
const BLEND = {
  pelvis: 0.000, waist: 0.045, thorax: 0.045, bust: 0.030,
  neck:   0.018, head:  0.012, deltoid: 0.020, yoke: 0.030,
  upperArm: 0.012, forearm: 0.010, hand: 0.014,
  thigh:  0.018, shank: 0.012, foot: 0.008
};

// Rest is the anatomical position -- arms straight down, feet together --
// because that is the position the table was measured in, and a landmark that
// only lands where the canon says it does in one pose is a landmark that can
// be checked. Everything else is a pose on top of it.
const POSES = {
  anatomical: { armLift: 0,  legSpread: 0,   elbow: 0,  wrist: 0 },
  a:          { armLift: 12, legSpread: 3.5, elbow: 5,  wrist: 0 },
  relaxed:    { armLift: 8,  legSpread: 3,   elbow: 15, wrist: 4 },
  t:          { armLift: 90, legSpread: 3.5, elbow: 0,  wrist: 0 }
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

function mannequin(opts) {
  const o = opts || {};
  const H = o.height === undefined ? 1750 : o.height;
  if (!(H > 0)) throw new Error('mannequin wants a height in mm');
  const build = o.build === undefined ? 1 : o.build;
  if (!(build > 0)) throw new Error('build is a multiplier on girth, so it must be > 0');
  const fig = clamp(o.figure === undefined ? 0 : o.figure, 0, 1);

  const named = typeof o.pose === 'string' ? POSES[o.pose] : null;
  if (typeof o.pose === 'string' && !named)
    throw new Error(`no pose named ${JSON.stringify(o.pose)} — `
      + `try ${Object.keys(POSES).join(', ')}`);
  const P = Object.assign({}, POSES.a, named,
                          (o.pose && typeof o.pose === 'object') ? o.pose : {});

  // Everything is a fraction of stature until it goes into a joint, and a
  // girth is also multiplied by build. Two helpers so neither rule has to be
  // remembered at each use.
  const L = (f) => f * H;
  const G = (f) => f * H * build;
  const G3 = (a) => [G(a[0]), G(a[1]), G(a[2])];

  // `figure` moves three things and nothing else: the shoulders in, the hips
  // out, and the waist in. The bust arrives only in the upper half of the
  // range, so a mid setting is an androgynous form rather than half of one.
  const shoulderHalf = L(lerp(CANON.biacromial, CANON.biacromial * 0.92, fig) / 2);
  const hipWiden = lerp(1, 1.13, fig);
  const waistNarrow = lerp(1, 0.86, fig);
  const bust = Math.max(0, (fig - 0.35) / 0.65);

  // Standing on the plate would put the whole figure above z = 0, and a
  // primitive's dims are half-extents about its *own* origin -- so a figure
  // built at ground level declares a box twice as tall as it needs. It is
  // built centred instead, and the caller stands it up by moving the node.
  // The sagittal shift is the same argument on the other axis: toes reach
  // further forward than buttocks reach back, so the middle of the figure is
  // not the middle of its box unless it is put there.
  const footFwd = L(CANON.footLength / 2 - 0.030);
  const backmost = Math.max(G(GIRTH.pelvisHalf[1]) + L(GIRTH.pelvisBack),
                            G(GIRTH.waistHalf[1]), G(GIRTH.thoraxHalf[1]));
  const yMid = (footFwd + L(CANON.footLength / 2) - backmost) / 2;
  const Z = (f) => L(f) - H / 2;

  const joints = [];
  const add = (j) => { joints.push(j); return j; };

  // ---- torso ------------------------------------------------------------
  // Three masses up the trunk rather than one: a pelvis, a waist and a
  // thorax, with the blend between them doing the work a single ellipsoid
  // cannot. A body's silhouette is that pair of curves, and it is the first
  // thing missing when a figure reads as a doll.
  add({ name: 'pelvis', offset: [0, -yMid, Z(CANON.hip)],
        mass: { kind: 'ellipsoid',
                half: [G(GIRTH.pelvisHalf[0]) * hipWiden, G(GIRTH.pelvisHalf[1]),
                       G(GIRTH.pelvisHalf[2])],
                offset: [0, -L(GIRTH.pelvisBack), L(GIRTH.pelvisAt - CANON.hip)],
                k: G(BLEND.pelvis) } });

  add({ name: 'waist', parent: 'pelvis', offset: [0, 0, L(0.080)],
        mass: { kind: 'ellipsoid',
                half: [G(GIRTH.waistHalf[0]) * waistNarrow,
                       G(GIRTH.waistHalf[1]) * waistNarrow, G(GIRTH.waistHalf[2])],
                offset: [0, 0, L(GIRTH.waistAt - CANON.hip - 0.080)],
                k: G(BLEND.waist) } });

  add({ name: 'chest', parent: 'waist', offset: [0, 0, L(0.070)],
        mass: { kind: 'ellipsoid', half: G3(GIRTH.thoraxHalf),
                offset: [0, 0, L(GIRTH.thoraxAt - CANON.hip - 0.150)],
                k: G(BLEND.thorax) } });

  if (bust > 0)
    for (const side of [1, -1])
      add({ name: `bust.${side > 0 ? 'L' : 'R'}`, parent: 'chest',
            offset: [side * L(0.045), G(GIRTH.thoraxHalf[1]) * 0.55,
                     L(GIRTH.thoraxAt - CANON.hip - 0.150 - 0.010)],
            mass: { kind: 'ellipsoid',
                    half: [G(GIRTH.bustHalf[0]) * bust, G(GIRTH.bustHalf[1]) * bust,
                           G(GIRTH.bustHalf[2]) * bust],
                    k: G(BLEND.bust) } });

  // ---- the shoulder girdle ----------------------------------------------
  // A capsule laid across the top of the thorax, ending at each shoulder joint
  // -- so the deltoid balls are concentric with its ends and everything from
  // the sternum out to the arm is one blended run.
  const shoulderX = shoulderHalf * 0.92;
  add({ name: 'yoke', parent: 'chest',
        offset: [-shoulderX, 0, L(GIRTH.yokeAt - CANON.hip - 0.150)],
        rot: [0, 90, 0],                         // its own +Z laid along +X
        mass: { kind: 'bone', len: 2 * shoulderX,
                r0: G(GIRTH.yokeR), r1: G(GIRTH.yokeR), k: G(BLEND.yoke) } });

  // ---- neck and head ----------------------------------------------------
  add({ name: 'neck', parent: 'chest',
        offset: [0, 0, L(CANON.shoulder - CANON.hip - 0.150)],
        mass: { kind: 'bone', len: L(CANON.chin - CANON.shoulder),
                r0: G(GIRTH.neckBase), r1: G(GIRTH.neckTop), k: G(BLEND.neck) } });

  add({ name: 'head', parent: 'neck', offset: [0, 0, L(CANON.chin - CANON.shoulder)],
        mass: { kind: 'ellipsoid', half: G3(GIRTH.headHalf),
                // the head sits a little forward of the neck's axis, which is
                // most of what stops a figure reading as a post with a ball on
                offset: [0, L(0.006), L(CANON.vertex - CANON.chin) - G(GIRTH.headHalf[2])],
                k: G(BLEND.head) } });

  // ---- arms -------------------------------------------------------------
  // A limb connector's rest rotation aims its own +Z down the segment, so
  // every offset below it is [0, 0, length] and every pose angle is read in
  // the joint's own frame: `armLift` about local Y swings the arm out to the
  // side, `elbow` about local X flexes it forward. That is why the rest
  // rotation is 180 about X -- it points +Z at the floor and leaves the
  // figure's left at +X, which makes the two rules above true rather than
  // approximately true.
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    add({ name: `shoulder.${s}`, parent: 'chest',
          // at the acromion's own height, because that is where the canon
          // measures the upper arm *from* -- 0.818 less 0.186 is the elbow at
          // 0.632, and the table says 0.630. Dropping the joint to its true
          // centre below the acromion would be more correct about the shoulder
          // and less correct about everything hanging off it.
          offset: [side * shoulderX, 0,
                   L(CANON.shoulder - CANON.hip - 0.150)],
          rot: [180, 0, 0], pose: [0, side * P.armLift, 0],
          mass: { kind: 'bone', len: L(CANON.upperArm),
                  r0: G(GIRTH.upperArm0), r1: G(GIRTH.upperArm1),
                  k: G(BLEND.upperArm) } });

    // the deltoid is a mass on the shoulder joint, which is what a deltoid is
    add({ name: `deltoid.${s}`, parent: `shoulder.${s}`, offset: [0, 0, 0],
          mass: { kind: 'sphere', r: G(GIRTH.deltoid), k: G(BLEND.deltoid) } });

    add({ name: `elbow.${s}`, parent: `shoulder.${s}`, offset: [0, 0, L(CANON.upperArm)],
          pose: [P.elbow, 0, 0],
          mass: { kind: 'bone', len: L(CANON.forearm),
                  r0: G(GIRTH.forearm0), r1: G(GIRTH.forearm1),
                  k: G(BLEND.forearm) } });

    add({ name: `wrist.${s}`, parent: `elbow.${s}`, offset: [0, 0, L(CANON.forearm)],
          pose: [P.wrist, 0, 0],
          // A mitten, not a hand: a mannequin has no fingers, and a rounded
          // box at the right breadth and thickness reads as a hand at the
          // distance anyone looks at a figure from.
          mass: { kind: 'box', half: G3(GIRTH.handHalf),
                  round: G(GIRTH.handHalf[1]) * 0.85,
                  offset: [0, 0, G(GIRTH.handHalf[2])], k: G(BLEND.hand) } });
  }

  // ---- legs -------------------------------------------------------------
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    add({ name: `hip.${s}`, parent: 'pelvis', offset: [side * L(0.048), 0, 0],
          rot: [180, 0, 0], pose: [0, side * P.legSpread, 0],
          mass: { kind: 'bone', len: L(CANON.thigh),
                  r0: G(GIRTH.thigh0), r1: G(GIRTH.thigh1), k: G(BLEND.thigh) } });

    add({ name: `knee.${s}`, parent: `hip.${s}`, offset: [0, 0, L(CANON.thigh)],
          mass: { kind: 'bone', len: L(CANON.shank),
                  r0: G(GIRTH.shank0), r1: G(GIRTH.shank1), k: G(BLEND.shank) } });

    // The ankle's frame still points +Z at the floor, so the foot's own
    // rotation puts it back on the world's axes -- length along +Y, which is
    // the way the figure faces -- and its offset is stated in the ankle's
    // frame, where forward is -Y and down is +Z.
    const footHalfH = L(CANON.ankle) / 2;
    add({ name: `ankle.${s}`, parent: `knee.${s}`, offset: [0, 0, L(CANON.shank)],
          mass: { kind: 'box',
                  half: [L(CANON.footBreadth / 2), L(CANON.footLength / 2), footHalfH],
                  round: footHalfH * 0.7, rot: [180, 0, 0],
                  offset: [0, -footFwd, L(CANON.ankle) - footHalfH],
                  k: G(BLEND.foot) } });
  }

  return { name: o.name || 'mannequin', joints,
           // what the caller needs to put it on the plate, and what it was
           // built from, so a consumer does not have to guess either back
           height: H, build, figure: fig, pose: P, ground: -H / 2 };
}

const SinterFigure = { mannequin, CANON, GIRTH, BLEND, POSES };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterFigure;
root.SinterFigure = SinterFigure;
})(typeof self !== 'undefined' ? self : globalThis);
