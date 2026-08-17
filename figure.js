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

// Radii and masses, as fractions of stature, for a mid-range adult. `build`
// multiplies these and never the table above.
//
// A mass is `[halfX, halfY, halfZ]` for an ellipsoid or a box, or a radius for
// a bone, and `at` is the height its centre sits at. `aspect` on a bone is its
// cross-section's second radius as a ratio of the first: limbs are not round,
// and a figure built from circular bones reads as tubing however good its
// proportions are. Local +Y on a limb is the sagittal axis, so an aspect under
// one is a limb flattened front-to-back.
const GIRTH = {
  // ---- trunk. Five masses, not one: the silhouette of a body is the run of
  // curves between them, and it is the first thing missing when a figure reads
  // as a doll. Widths and depths are separate everywhere because a trunk is
  // half again as wide as it is deep and nothing about it is a circle.
  // The pelvis is wider than the thigh tops and sits above them. Matched to
  // them it is not a hip -- the widest part of the figure becomes the legs,
  // the silhouette runs dead flat from mid-thigh to the iliac crest, and the
  // only thing left of a waist is a step where the flat ends.
  pelvisHalf:  [0.1015, 0.0545, 0.0720], pelvisAt:  0.545, pelvisBack: 0.0060,
  gluteHalf:   [0.0530, 0.0520, 0.0530], gluteAt:   0.500,
    gluteBack: 0.0330, gluteOut:  0.0430,
  waistHalf:   [0.0615, 0.0425, 0.0720], waistAt:   0.650,
  bellyHalf:   [0.0565, 0.0400, 0.0500], bellyAt:   0.612, bellyFwd: 0.0090,
  thoraxHalf:  [0.0880, 0.0555, 0.0740], thoraxAt:  0.746,
  // The sternum is the flat of the chest and sits proud of the rib cage; the
  // pectorals are the two masses across it. Together they are what stops the
  // front of a thorax ellipsoid reading as a barrel.
  sternumHalf: [0.0610, 0.0300, 0.0620], sternumAt: 0.742, sternumFwd: 0.0270,
  pecHalf:     [0.0510, 0.0200, 0.0280], pecAt:     0.757,
    pecFwd:    0.0260, pecOut:   0.0400,
  // The latissimus fans up the side of the rib cage and is most of what makes
  // a back read as a back rather than as the other side of a chest.
  latHalf:     [0.0255, 0.0450, 0.0620], latAt:     0.733, latOut: 0.0620,
  // The scapulae stand off the back of the rib cage and the trapezius runs
  // from the neck out over them. Both are back masses, and a back with
  // neither is the smooth reverse of a chest.
  scapHalf:    [0.0330, 0.0230, 0.0420], scapAt:    0.770,
    scapBack:  0.0355, scapOut:  0.0420,
  trapHalf:    [0.0620, 0.0260, 0.0320], trapAt:    0.795, trapBack: 0.0090,
  bustHalf:    [0.0440, 0.0350, 0.0410], bustAt:    0.752, bustFwd: 0.0300,
  // The shoulder girdle, as one capsule from acromion to acromion. Without it
  // the arms hang off nothing: a thorax ellipsoid is at its widest around the
  // nipple line and has tapered nearly to a point by the time it reaches
  // shoulder height, so the deltoids end up floating a hand's breadth clear of
  // the body. This is the mass a clavicle and a trapezius actually put there,
  // and it is why a figure built from a torso and two arms never looks right.
  // It stops short of the acromion rather than reaching it: a capsule ending
  // *at* the shoulder joint puts its spherical cap out past the arm and above
  // the shoulder line, and the figure wears epaulettes. Ending inboard lets
  // the deltoid be the outermost thing at the shoulder, which is what a
  // deltoid is, and the trapezius fairs into it.
  yokeR:       0.0280, yokeAsp: 0.85, yokeAt: 0.788, yokeSpan: 0.78,

  // ---- neck and head. A head is not an egg. A cranium is nearly a sphere and
  // the face hangs off the front of it, so two masses: the skull, and a jaw
  // that reaches down to the chin and forward to the brow.
  neckBase:    0.0330, neckTop: 0.0300, neckAsp: 1.10, neckFwd: 0.0060,
  craniumHalf: [0.0445, 0.0480, 0.0450], craniumAt: 0.955, craniumBack: 0.0060,
  jawHalf:     [0.0370, 0.0450, 0.0360], jawAt:     0.906, jawFwd: 0.0100,

  // ---- arms. The deltoid is a football capping the shoulder rather than a
  // ball on top of it, so it is an ellipsoid running a third of the way down
  // the arm. The biceps and the forearm's flexor bulge are the other two
  // masses that make an arm taper the way an arm tapers -- thickest a third of
  // the way along each segment, not at the joint.
  deltoidHalf: [0.0285, 0.0300, 0.0450], deltoidAt: 0.0500,
  // The bone starts *below* the joint it hangs from. A round cone beginning
  // at the acromion caps it with a hemisphere of its own radius, which stands
  // proud of the shoulder line and gives the figure a pair of wings; the
  // deltoid is what covers a shoulder, so the humerus starts under it. The
  // joint itself does not move -- the elbow is still one upper-arm length
  // down -- only the flesh does.
  upperArm0:   0.0265, upperArm1:  0.0205, upperArmAsp: 0.95, upperArmDrop: 0.030,
  bicepsHalf:  [0.0235, 0.0270, 0.0450], bicepsAt: 0.34, bicepsFwd: 0.0060,
  tricepHalf:  [0.0225, 0.0250, 0.0480], tricepAt: 0.30, tricepBack: 0.0075,
  forearm0:    0.0215, forearm1:   0.0130, forearmAsp: 0.86,
  flexorHalf:  [0.0205, 0.0225, 0.0430], flexorAt: 0.24,
  // A mannequin's hand is a mitten, but a mitten with a palm, a thumb and a
  // taper is a hand and a rounded slab is not. The palm is a flattened bone
  // widening to the knuckles, the fingers a block that narrows and thins.
  palmR0:      0.0150, palmR1: 0.0195, palmAsp: 0.48, palmLen: 0.0400,
  fingerHalf:  [0.0195, 0.0088, 0.0330],
  thumbR0:     0.0090, thumbR1: 0.0072, thumbLen: 0.0290, thumbOut: 20,

  // ---- legs. The quadriceps sits high and in front, the calf high and
  // behind, and between them they are most of the reason a leg is not two
  // cones. A gastrocnemius left out is the single most visible omission on a
  // figure: the back of the shank goes straight from knee to ankle and the
  // whole leg reads as a chair leg.
  thigh0:      0.0450, thigh1: 0.0315, thighAsp: 1.02,
  quadHalf:    [0.0400, 0.0330, 0.0800], quadAt: 0.34, quadFwd: 0.0080,
  hamHalf:     [0.0360, 0.0310, 0.0800], hamAt: 0.30, hamBack: 0.0090,
  shank0:      0.0300, shank1: 0.0180, shankAsp: 0.94,
  calfHalf:    [0.0290, 0.0330, 0.0610], calfAt: 0.27, calfBack: 0.0110,
  // The shin's crest and the Achilles: the front of a shank is a flat plane
  // over bone and the back of it narrows to a tendon, and the pair of them
  // are why an ankle is the thinnest part of a leg from the side.
  shinHalf:    [0.0200, 0.0230, 0.0700], shinAt: 0.45, shinFwd: 0.0090,
  achilHalf:   [0.0150, 0.0170, 0.0330], achilAt: 0.90, achilBack: 0.0080,
  // The foot as a tapered bone laid forward, with the heel a mass of its own:
  // a rounded box has no arch, no heel and no toe taper, and reads as a ski.
  footR0:      0.0195, footR1: 0.0250, footAsp: 0.70, footLen: 0.1050,
  footBack:    0.0300, heelHalf: [0.0250, 0.0300, 0.0230], heelAt: 0.0230
};

// Blend radii, as fractions of stature. These are what make the figure a body
// rather than a bag of parts, and they are roughly a third of the smaller
// radius at each joint -- enough to fill the crease, not enough to swallow the
// landmark. They scale with `build`, because a blend is a girth.
//
// One caution that belongs to the construct rather than to this file: a node
// folds every mass with `smin` against the *running* distance, so a radius
// blends with everything already found and not only with the neighbour it was
// meant for. A generous blend on the thigh fills the hip crease and also fuses
// the two thighs to each other further down the leg than they should be. The
// lever is the radius, which is why the ones between masses that sit near
// their opposite number -- thighs, glutes, pectorals -- are the small ones.
const BLEND = {
  pelvis: 0.000, glute: 0.030, waist: 0.030, belly: 0.024, thorax: 0.030,
  sternum: 0.026, pec: 0.020, lat: 0.024, bust: 0.024, yoke: 0.022,
  neck: 0.013, cranium: 0.010, jaw: 0.012,
  scap: 0.020, trap: 0.026,
  deltoid: 0.020, upperArm: 0.012, biceps: 0.016, tricep: 0.016,
  forearm: 0.010, flexor: 0.013, palm: 0.009, finger: 0.007, thumb: 0.006,
  thigh: 0.016, quad: 0.018, ham: 0.018, shank: 0.011, calf: 0.014,
  shin: 0.012, achil: 0.008,
  foot: 0.010, heel: 0.012
};

// Rest is the anatomical position -- arms straight down, feet together --
// because that is the position the table was measured in, and a landmark that
// only lands where the canon says it does in one pose is a landmark that can
// be checked. Everything else is a pose on top of it.
//
// `spine` is the standing S: a pelvis tipped forward, a lumbar hollow above
// it, a thoracic curve back and a neck that brings the head over the feet
// again. A trunk built as one straight column is the other half of why a
// figure reads as a doll -- the first is a torso of one mass, and this is a
// spine of no curve.
const POSES = {
  anatomical: { armLift: 0,  legSpread: 0,   elbow: 0,  wrist: 0, spine: 1 },
  a:          { armLift: 12, legSpread: 3.5, elbow: 5,  wrist: 0, spine: 1 },
  relaxed:    { armLift: 8,  legSpread: 3,   elbow: 15, wrist: 4, spine: 1 },
  t:          { armLift: 90, legSpread: 3.5, elbow: 0,  wrist: 0, spine: 1 }
};

// The curve itself, in degrees about the frontal axis, applied at each link of
// the trunk. They sum to zero, so the head ends up over the feet however much
// `spine` scales them.
const SPINE = { pelvis: 7, lumbar: -10, thorax: 6, neck: -3 };

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const RAD = Math.PI / 180;

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
  // girth is also multiplied by build. Helpers so neither rule has to be
  // remembered at each use.
  const L = (f) => f * H;
  const G = (f) => f * H * build;
  const G3 = (a) => [G(a[0]), G(a[1]), G(a[2])];

  // `figure` moves the silhouette and adds one pair of masses. The bust
  // arrives only in the upper half of the range, so a mid setting is an
  // androgynous form rather than half of one.
  const shoulderHalf = L(lerp(CANON.biacromial, CANON.biacromial * 0.92, fig) / 2);
  const hipWiden = lerp(1, 1.13, fig);
  const gluteFull = lerp(1, 1.12, fig);
  const waistNarrow = lerp(1, 0.86, fig);
  const bust = Math.max(0, (fig - 0.35) / 0.65);

  // Standing on the plate would put the whole figure above z = 0, and a
  // primitive's dims are half-extents about its *own* origin -- so a figure
  // built at ground level declares a box twice as tall as it needs. It is
  // built centred instead, and the caller stands it up by moving the node.
  // The sagittal shift is the same argument on the other axis: toes reach
  // further forward than buttocks reach back, so the middle of the figure is
  // not the middle of its box unless it is put there.
  const frontmost = L(GIRTH.footLen) - L(GIRTH.footBack) + G(GIRTH.footR1);
  const backmost = Math.max(G(GIRTH.gluteHalf[1]) + L(GIRTH.gluteBack),
                            G(GIRTH.thoraxHalf[1]), G(GIRTH.craniumHalf[1]));
  const yMid = (frontmost - backmost) / 2;

  const joints = [];
  const add = (j) => { joints.push(j); return j; };

  // How far the trunk has leaned by the time it reaches each link, stated up
  // front rather than accumulated as the rig is built: two things need it and
  // neither of them is written next to the link it belongs to.
  //
  // A rise stated as a height has to be divided by the cosine of the tilt it
  // is climbing at, or every landmark above it drifts down. The angles are
  // small and the correction is under a percent -- but the canon is checked to
  // four thousandths of stature, which is less than that.
  //
  // And a limb must undo the lean of whatever it hangs from. Arms and legs are
  // vertical in the anatomical position however the spine is curved, so the
  // shoulder and the hip cancel the trunk's tilt rather than inheriting it. A
  // leg that inherits seven degrees of pelvic tilt swings its foot four inches
  // forward and takes the figure's whole sagittal box with it.
  const tiltP = SPINE.pelvis * P.spine;
  const tiltL = (SPINE.pelvis + SPINE.lumbar) * P.spine;
  const tiltT = (SPINE.pelvis + SPINE.lumbar + SPINE.thorax) * P.spine;
  const rise = (f, t) => L(f) / Math.cos((t || 0) * RAD);
  const bend = (deg) => [deg * P.spine, 0, 0];

  // ---- trunk -------------------------------------------------------------
  // The whole trunk is four joints. Everything else it wears is flesh on those
  // joints rather than a joint of its own -- a glute does not articulate, and
  // putting it in the skeleton would mean anything walking `joints` to build an
  // animation had to know which entries were real.
  add({ name: 'pelvis', offset: [0, -yMid, L(CANON.hip) - H / 2], rot: bend(SPINE.pelvis),
        mass: [
          { kind: 'ellipsoid',
            half: [G(GIRTH.pelvisHalf[0]) * hipWiden, G(GIRTH.pelvisHalf[1]),
                   G(GIRTH.pelvisHalf[2])],
            offset: [0, -L(GIRTH.pelvisBack), rise(GIRTH.pelvisAt - CANON.hip, tiltP)],
            k: G(BLEND.pelvis) },
          // Two glutes rather than one mass, because the cleft between them is
          // the shape: one ellipsoid across the back of the pelvis is a shelf.
          ...[1, -1].map(side => ({ kind: 'ellipsoid',
            half: [G(GIRTH.gluteHalf[0]), G(GIRTH.gluteHalf[1]) * gluteFull,
                   G(GIRTH.gluteHalf[2])],
            offset: [side * L(GIRTH.gluteOut), -L(GIRTH.gluteBack),
                     rise(GIRTH.gluteAt - CANON.hip, tiltP)],
            k: G(BLEND.glute) }))
        ] });

  add({ name: 'lumbar', parent: 'pelvis', offset: [0, 0, rise(0.075, tiltP)],
        rot: bend(SPINE.lumbar),
        mass: [
          { kind: 'ellipsoid',
            half: [G(GIRTH.waistHalf[0]) * waistNarrow,
                   G(GIRTH.waistHalf[1]) * waistNarrow, G(GIRTH.waistHalf[2])],
            offset: [0, 0, rise(GIRTH.waistAt - CANON.hip - 0.075, tiltL)],
            k: G(BLEND.waist) },
          { kind: 'ellipsoid',
            half: [G(GIRTH.bellyHalf[0]) * waistNarrow, G(GIRTH.bellyHalf[1]),
                   G(GIRTH.bellyHalf[2])],
            offset: [0, L(GIRTH.bellyFwd), rise(GIRTH.bellyAt - CANON.hip - 0.075, tiltL)],
            k: G(BLEND.belly) }
        ] });

  const shoulderX = shoulderHalf * 0.92;
  const yokeX = shoulderX * GIRTH.yokeSpan;
  const upZ = (f) => rise(f - CANON.hip - 0.150, tiltT);
  add({ name: 'thorax', parent: 'lumbar', offset: [0, 0, rise(0.075, tiltL)],
        rot: bend(SPINE.thorax),
        mass: [
          { kind: 'ellipsoid', half: G3(GIRTH.thoraxHalf),
            offset: [0, 0, upZ(GIRTH.thoraxAt)], k: G(BLEND.thorax) },
          { kind: 'ellipsoid', half: G3(GIRTH.sternumHalf),
            offset: [0, L(GIRTH.sternumFwd), upZ(GIRTH.sternumAt)], k: G(BLEND.sternum) },
          ...[1, -1].flatMap(side => [
            { kind: 'ellipsoid', half: G3(GIRTH.pecHalf),
              offset: [side * L(GIRTH.pecOut), L(GIRTH.pecFwd), upZ(GIRTH.pecAt)],
              k: G(BLEND.pec) },
            { kind: 'ellipsoid', half: G3(GIRTH.latHalf),
              offset: [side * L(GIRTH.latOut), 0, upZ(GIRTH.latAt)], k: G(BLEND.lat) },
            { kind: 'ellipsoid', half: G3(GIRTH.scapHalf),
              offset: [side * L(GIRTH.scapOut), -L(GIRTH.scapBack), upZ(GIRTH.scapAt)],
              k: G(BLEND.scap) },
            ...(bust > 0 ? [{ kind: 'ellipsoid',
              half: [G(GIRTH.bustHalf[0]) * bust, G(GIRTH.bustHalf[1]) * bust,
                     G(GIRTH.bustHalf[2]) * bust],
              offset: [side * L(0.043), L(GIRTH.bustFwd), upZ(GIRTH.bustAt)],
              k: G(BLEND.bust) }] : [])
          ]),
          // A capsule laid across the top of the thorax, so the deltoids are
          // near its ends and everything from sternum to arm is one blended run.
          { kind: 'bone', len: 2 * yokeX, aspect: GIRTH.yokeAsp,
            r0: G(GIRTH.yokeR), r1: G(GIRTH.yokeR), rot: [0, 90, 0],
            offset: [-yokeX, 0, upZ(GIRTH.yokeAt)], k: G(BLEND.yoke) },
          // the trapezius over the top of it, which is the slope from neck to
          // shoulder seen from behind
          { kind: 'ellipsoid', half: G3(GIRTH.trapHalf),
            offset: [0, -L(GIRTH.trapBack), upZ(GIRTH.trapAt)], k: G(BLEND.trap) }
        ] });

  // ---- neck and head -----------------------------------------------------
  add({ name: 'neck', parent: 'thorax',
        offset: [0, L(GIRTH.neckFwd), upZ(CANON.shoulder)], rot: bend(SPINE.neck),
        mass: { kind: 'bone', len: L(CANON.chin - CANON.shoulder) * 1.15,
                r0: G(GIRTH.neckBase), r1: G(GIRTH.neckTop),
                aspect: GIRTH.neckAsp, k: G(BLEND.neck) } });

  add({ name: 'head', parent: 'neck', offset: [0, 0, L(CANON.chin - CANON.shoulder)],
        mass: [
          { kind: 'ellipsoid', half: G3(GIRTH.craniumHalf),
            offset: [0, -L(GIRTH.craniumBack), L(GIRTH.craniumAt - CANON.chin)],
            k: G(BLEND.cranium) },
          { kind: 'ellipsoid', half: G3(GIRTH.jawHalf),
            offset: [0, L(GIRTH.jawFwd), L(GIRTH.jawAt - CANON.chin)], k: G(BLEND.jaw) }
        ] });

  // ---- arms --------------------------------------------------------------
  // A limb connector's rest rotation aims its own +Z down the segment, so
  // every offset below it is [0, 0, length] and every pose angle is read in
  // the joint's own frame: `armLift` about local Y swings the arm out to the
  // side, `elbow` about local X flexes it forward. That is why the rest
  // rotation is 180 about X -- it points +Z at the floor and leaves the
  // figure's left at +X, which makes the two rules above true rather than
  // approximately true. On a limb, local +Y is then the sagittal axis, which
  // is the one a cross-section aspect flattens.
  //
  // Three joints an arm, and the muscles ride on them: an arm articulates at
  // the shoulder, the elbow and the wrist and nowhere else, however many
  // shapes it takes to make one look like an arm.
  const upper = L(CANON.upperArm), fore = L(CANON.forearm);
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    add({ name: `shoulder.${s}`, parent: 'thorax',
          // at the acromion's own height, because that is where the canon
          // measures the upper arm *from* -- 0.818 less 0.186 is the elbow at
          // 0.632, and the table says 0.630. Dropping the joint to its true
          // centre below the acromion would be more correct about the shoulder
          // and less correct about everything hanging off it.
          offset: [side * shoulderX, 0, upZ(CANON.shoulder)],
          rot: [180 - tiltT, 0, 0], pose: [0, side * P.armLift, 0],
          mass: [
            { kind: 'bone', len: upper - L(GIRTH.upperArmDrop),
              aspect: GIRTH.upperArmAsp, offset: [0, 0, L(GIRTH.upperArmDrop)],
              r0: G(GIRTH.upperArm0), r1: G(GIRTH.upperArm1), k: G(BLEND.upperArm) },
            // the deltoid caps the shoulder rather than sitting on it: an
            // ellipsoid running a third of the way down the arm, which is the
            // shape that reads as a shoulder from any angle
            { kind: 'ellipsoid', half: G3(GIRTH.deltoidHalf),
              offset: [0, 0, L(GIRTH.deltoidAt)], k: G(BLEND.deltoid) },
            { kind: 'ellipsoid', half: G3(GIRTH.bicepsHalf),
              offset: [0, -L(GIRTH.bicepsFwd), upper * GIRTH.bicepsAt],
              k: G(BLEND.biceps) },
            // and the triceps behind it, lower: an upper arm with only a
            // biceps is round from behind and reads as a sausage
            { kind: 'ellipsoid', half: G3(GIRTH.tricepHalf),
              offset: [0, L(GIRTH.tricepBack), upper * GIRTH.tricepAt],
              k: G(BLEND.tricep) }
          ] });

    add({ name: `elbow.${s}`, parent: `shoulder.${s}`, offset: [0, 0, upper],
          pose: [P.elbow, 0, 0],
          mass: [
            { kind: 'bone', len: fore, aspect: GIRTH.forearmAsp,
              r0: G(GIRTH.forearm0), r1: G(GIRTH.forearm1), k: G(BLEND.forearm) },
            { kind: 'ellipsoid', half: G3(GIRTH.flexorHalf),
              offset: [0, 0, fore * GIRTH.flexorAt], k: G(BLEND.flexor) }
          ] });

    add({ name: `wrist.${s}`, parent: `elbow.${s}`, offset: [0, 0, fore],
          pose: [P.wrist, 0, 0],
          mass: [
            // A mannequin's hand is a mitten, but a mitten with a palm, a thumb
            // and a taper is a hand and a rounded slab is not.
            { kind: 'bone', len: L(GIRTH.palmLen), aspect: GIRTH.palmAsp,
              r0: G(GIRTH.palmR0), r1: G(GIRTH.palmR1), k: G(BLEND.palm) },
            { kind: 'box', half: G3(GIRTH.fingerHalf),
              round: G(GIRTH.fingerHalf[1]) * 0.9,
              offset: [0, 0, L(GIRTH.palmLen) + G(GIRTH.fingerHalf[2])],
              k: G(BLEND.finger) },
            { kind: 'bone', len: L(GIRTH.thumbLen),
              r0: G(GIRTH.thumbR0), r1: G(GIRTH.thumbR1), rot: [0, side * GIRTH.thumbOut, 0],
              offset: [side * G(GIRTH.palmR1) * 0.7, 0, L(GIRTH.palmLen) * 0.45],
              k: G(BLEND.thumb) }
          ] });
  }

  // ---- legs --------------------------------------------------------------
  const thigh = L(CANON.thigh), shank = L(CANON.shank);
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    add({ name: `hip.${s}`, parent: 'pelvis', offset: [side * L(0.048), 0, 0],
          rot: [180 - tiltP, 0, 0], pose: [0, side * P.legSpread, 0],
          mass: [
            { kind: 'bone', len: thigh, aspect: GIRTH.thighAsp,
              r0: G(GIRTH.thigh0), r1: G(GIRTH.thigh1), k: G(BLEND.thigh) },
            { kind: 'ellipsoid', half: G3(GIRTH.quadHalf),
              offset: [0, -L(GIRTH.quadFwd), thigh * GIRTH.quadAt], k: G(BLEND.quad) },
            // the hamstring behind and higher, which is what gives a thigh its
            // taper: thickest at the top and behind, not down the middle
            { kind: 'ellipsoid', half: G3(GIRTH.hamHalf),
              offset: [0, L(GIRTH.hamBack), thigh * GIRTH.hamAt], k: G(BLEND.ham) }
          ] });

    add({ name: `knee.${s}`, parent: `hip.${s}`, offset: [0, 0, thigh],
          mass: [
            { kind: 'bone', len: shank, aspect: GIRTH.shankAsp,
              r0: G(GIRTH.shank0), r1: G(GIRTH.shank1), k: G(BLEND.shank) },
            // The gastrocnemius: high, behind, and the single most visible mass
            // on a leg. Left out, the back of the shank runs straight from knee
            // to ankle and the whole leg reads as a chair leg.
            { kind: 'ellipsoid', half: G3(GIRTH.calfHalf),
              offset: [0, L(GIRTH.calfBack), shank * GIRTH.calfAt], k: G(BLEND.calf) },
            { kind: 'ellipsoid', half: G3(GIRTH.shinHalf),
              offset: [0, -L(GIRTH.shinFwd), shank * GIRTH.shinAt], k: G(BLEND.shin) },
            { kind: 'ellipsoid', half: G3(GIRTH.achilHalf),
              offset: [0, L(GIRTH.achilBack), shank * GIRTH.achilAt], k: G(BLEND.achil) }
          ] });

    // The ankle's frame still points +Z at the floor, so the foot's own
    // rotation lays its axis along the world's +Y -- the way the figure faces
    // -- and its offset is stated in the ankle's frame, where forward is -Y
    // and down is +Z.
    add({ name: `ankle.${s}`, parent: `knee.${s}`, offset: [0, 0, shank],
          mass: [
            { kind: 'bone', len: L(GIRTH.footLen), aspect: GIRTH.footAsp,
              r0: G(GIRTH.footR0), r1: G(GIRTH.footR1), rot: [90, 0, 0],
              offset: [0, L(GIRTH.footBack),
                       L(CANON.ankle) - G(GIRTH.footR1) * GIRTH.footAsp],
              k: G(BLEND.foot) },
            { kind: 'ellipsoid', half: G3(GIRTH.heelHalf), rot: [180, 0, 0],
              offset: [0, L(GIRTH.footBack), L(CANON.ankle) - L(GIRTH.heelAt)],
              k: G(BLEND.heel) }
          ] });
  }

  return { name: o.name || 'mannequin', joints,
           // what the caller needs to put it on the plate, and what it was
           // built from, so a consumer does not have to guess either back
           height: H, build, figure: fig, pose: P, ground: -H / 2 };
}

const SinterFigure = { mannequin, CANON, GIRTH, BLEND, POSES, SPINE };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterFigure;
root.SinterFigure = SinterFigure;
})(typeof self !== 'undefined' ? self : globalThis);
