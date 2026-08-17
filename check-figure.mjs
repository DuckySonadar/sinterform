/* Check that the mannequin is the figure the table says it is.
 *
 *     node check-figure.mjs
 *
 * `check-construct` asks whether a rig packs correctly. This asks whether
 * *this* rig is a body: whether the landmarks land where Drillis & Contini put
 * them, whether a figure asked for 1750 mm is 1750 mm tall, and whether it is
 * one solid rather than a torso with some parts near it.
 *
 * That last one is the reason this file exists. A figure whose arms are not
 * attached still meshes, still exports, still passes every check in the
 * repository, and looks fine in a thumbnail -- the first version here had a
 * hand's breadth of clear air between each deltoid and the chest, because a
 * thorax ellipsoid has tapered nearly to a point by the time it reaches
 * shoulder height and there was nothing spanning the gap. Nothing catches that
 * except asking the solid whether you can walk from one end of it to the other.
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
const FG = load('figure.js');

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};

const C = FG.CANON;

// Half-width of the *torso* at a height: the first place the solid ends going
// outward from the midline, found by scanning rather than by bisecting. A
// bisection assumes one crossing and there are three -- torso, air, arm -- so
// it converges on whichever surface it happens to bracket, which at shoulder
// height is the outside of the arm and at hip height, in the anatomical pose,
// is the back of the hand.
function across(F, z, y) {
  const step = F.H * 0.0005;
  if (F.at(0, y, z) >= 0) return null;
  let a = 0;
  for (let x = step; x < F.H * 0.4; x += step) {
    if (F.at(x, y, z) >= 0) {
      let lo = a, hi = x;
      for (let i = 0; i < 40; i++) {
        const m = (lo + hi) / 2;
        if (F.at(m, y, z) < 0) lo = m; else hi = m;
      }
      return lo;
    }
    a = x;
  }
  return null;
}

// A figure, packed and put in slot 0. `f(x, y, z)` measures it with z from the
// sole rather than from the node's centre, because every number in the canon
// is a height above the ground and comparing them to a centred coordinate is
// an invitation to be off by half a person.
function figure(opts) {
  const rig = FG.mannequin(opts);
  const packed = CN.pack(rig);
  SF.constructs = [packed.construct];
  const H = rig.height;
  return {
    rig, packed, H,
    // The document holds one construct at a time and `constructs` is a live
    // accessor, so two figures in scope at once are two figures sharing a
    // slot: whichever was packed last is the one every probe reads. Each
    // measurement puts its own back first, the way check-glsl's sweep cases do.
    at: (x, y, z) => {
      SF.constructs = [packed.construct];
      return SF.PRIMS.construct.js([x, y, z - H / 2], packed.node.d, 0, { fi: 0 });
    },
    joint: (name) => {
      const i = rig.joints.findIndex(j => j.name === name);
      if (i < 0) throw new Error(`no connector named ${name}`);
      const p = packed.world[i].p;
      return [p[0], p[1], p[2] + H / 2];
    }
  };
}

// ------------------------------------------------------------- landmarks ----
// The claim the whole file rests on, checked in the anatomical pose -- the
// position the table was measured in. A posed figure's elbow is not at elbow
// height and should not be.
console.log('\nthe landmarks are where the canon puts them');
{
  const H = 1750;
  const F = figure({ height: H, pose: 'anatomical' });
  // The canon is internally consistent to about a thousandth of stature: the
  // tabulated elbow height is 0.630 and shoulder-minus-upper-arm is 0.632, so
  // the bar is 0.004H -- 7 mm on this figure -- rather than zero. Tightening it
  // past the table's own agreement with itself would be measuring nothing.
  const bar = 0.004 * H;
  for (const [joint, height, what] of [
    ['neck', C.shoulder, 'acromion'],
    ['head', C.chin, 'chin'],
    ['elbow.L', C.elbow, 'elbow'],
    ['wrist.L', C.wrist, 'wrist'],
    ['hip.L', C.hip, 'greater trochanter'],
    ['knee.L', C.knee, 'knee'],
    ['ankle.L', C.ankle, 'ankle']
  ]) {
    const z = F.joint(joint)[2];
    ok(Math.abs(z - height * H) <= bar,
       `${what}: ${(z / H).toFixed(4)}H, canon ${height} (${(z - height * H).toFixed(1)} mm)`);
  }
}

// ---------------------------------------------------------------- stature ----
// Asked of the solid rather than of the skeleton: a figure can have every
// joint in the right place and still be the wrong height if a mass overhangs
// the last one.
console.log('\nit is as tall as it was asked to be');
{
  const H = 1750;
  const F = figure({ height: H, pose: 'anatomical' });
  const head = F.joint('head');
  // bisect down from above the vertex and up from below the sole
  const hit = (from, to, x, y) => {
    let a = from, b = to;
    for (let i = 0; i < 60; i++) {
      const m = (a + b) / 2;
      if (F.at(x, y, m) < 0) b = m; else a = m;
    }
    return (a + b) / 2;
  };
  const vertex = hit(H * 1.2, H * 0.95, 0, head[1]);
  const foot = F.joint('ankle.L');
  const sole = hit(-H * 0.2, H * 0.02, foot[0], foot[1] + 0.02 * H);
  ok(Math.abs(vertex - H) < 0.004 * H, `the vertex is at ${vertex.toFixed(1)} of ${H} mm`);
  ok(Math.abs(sole) < 0.004 * H, `and the sole is on z = 0 (${sole.toFixed(2)} mm)`);
}

// ------------------------------------------------------------ one solid -----
// Flood-fill the interior on a coarse grid and count the components. Anything
// that is not attached shows up here and nowhere else.
console.log('\nit is one solid, not a torso with parts near it');
{
  const H = 1000, cell = 5;
  for (const pose of ['anatomical', 'a', 't', 'relaxed']) {
    const F = figure({ height: H, pose });
    const d = F.packed.node.d;
    const n = [Math.ceil(2 * d[0] / cell) + 2, Math.ceil(2 * d[1] / cell) + 2,
               Math.ceil(2 * d[2] / cell) + 2];
    const idx = (i, j, k) => (k * n[1] + j) * n[0] + i;
    const solid = new Uint8Array(n[0] * n[1] * n[2]);
    let count = 0;
    for (let k = 0; k < n[2]; k++)
      for (let j = 0; j < n[1]; j++)
        for (let i = 0; i < n[0]; i++) {
          const x = -d[0] + (i - 0.5) * cell, y = -d[1] + (j - 0.5) * cell;
          const z = -d[2] + (k - 0.5) * cell + H / 2;
          if (F.at(x, y, z) < 0) { solid[idx(i, j, k)] = 1; count++; }
        }

    // six-connected flood fill from the first solid cell
    const seen = new Uint8Array(solid.length);
    let start = solid.indexOf(1), reached = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop();
      reached++;
      const i = c % n[0], j = Math.floor(c / n[0]) % n[1], k = Math.floor(c / (n[0] * n[1]));
      for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const a = i + di, b = j + dj, c2 = k + dk;
        if (a < 0 || b < 0 || c2 < 0 || a >= n[0] || b >= n[1] || c2 >= n[2]) continue;
        const e = idx(a, b, c2);
        if (solid[e] && !seen[e]) { seen[e] = 1; stack.push(e); }
      }
    }
    ok(reached === count, `pose '${pose}': one connected component `
      + `(${reached.toLocaleString()} of ${count.toLocaleString()} solid cells reached)`);
  }
}

// ------------------------------------------------- the masses are there -----
// Every mass in the table is there because leaving it out is visible, and none
// of the checks above would notice if one went. These are the shapes, asked of
// the solid: a calf behind the shank, a buttock behind the waist, a deltoid
// past the acromion, a limb that is not a circle in section, and a spine that
// curves. Delete any of them and exactly one line here goes red.
console.log('\nthe masses that make it a body are in it');
{
  const H = 1750;
  const F = figure({ height: H, pose: 'anatomical' });
  const step = H * 0.0005;
  // distance from an interior point to the first surface along a direction
  const exit = (p0, dir) => {
    if (F.at(p0[0], p0[1], p0[2]) >= 0) return null;
    for (let t = step; t < H * 0.5; t += step) {
      const q = [p0[0] + dir[0] * t, p0[1] + dir[1] * t, p0[2] + dir[2] * t];
      if (F.at(q[0], q[1], q[2]) >= 0) {
        let lo = t - step, hi = t;
        for (let i = 0; i < 40; i++) {
          const m = (lo + hi) / 2;
          const r = [p0[0] + dir[0] * m, p0[1] + dir[1] * m, p0[2] + dir[2] * m];
          if (F.at(r[0], r[1], r[2]) < 0) lo = m; else hi = m;
        }
        return lo;
      }
    }
    return null;
  };
  const back = [0, -1, 0], out = [1, 0, 0], fwd = [0, 1, 0];

  // the gastrocnemius: the back of the shank is much further back at calf
  // height than just above the ankle, or the leg is a chair leg
  const knee = F.joint('knee.L'), ankle = F.joint('ankle.L');
  const legY = knee[1], legX = knee[0];
  const calfZ = knee[2] - (knee[2] - ankle[2]) * 0.27;
  const thinZ = ankle[2] + (knee[2] - ankle[2]) * 0.10;
  const calfBack = exit([legX, legY, calfZ], back);
  const shinBack = exit([legX, legY, thinZ], back);
  ok(calfBack > shinBack * 1.5, `a calf: the shank reaches ${calfBack.toFixed(0)} mm `
    + `back at calf height and ${shinBack.toFixed(0)} mm above the ankle`);

  // the glute: the pelvis reaches further back than the waist does
  const hipY = F.joint('hip.L')[1];
  const gluteBack = exit([0, hipY, 0.500 * H], back);
  const waistBack = exit([0, hipY, 0.645 * H], back);
  ok(gluteBack > waistBack * 1.15, `a buttock: ${gluteBack.toFixed(0)} mm back at `
    + `0.500H against ${waistBack.toFixed(0)} mm at the waist`);

  // the deltoid: the shoulder is wider than the joint it hangs from
  const shoulderX = F.joint('shoulder.L')[0];
  let widest = 0;
  for (let f = 0.750; f <= 0.815; f += 0.005)
    widest = Math.max(widest, exit([0, hipY, f * H], out) || 0);
  ok(widest > shoulderX * 1.12, `a deltoid: the shoulder measures `
    + `${widest.toFixed(0)} mm out where the joint is at ${shoulderX.toFixed(0)}`);

  // the pectoral, which is the same statement on the other axis
  const chestFwd = exit([0, hipY, 0.755 * H], fwd);
  const ribFwd = exit([0, hipY, 0.690 * H], fwd);
  ok(chestFwd > ribFwd, `a pectoral: the chest stands ${chestFwd.toFixed(0)} mm `
    + `proud against ${ribFwd.toFixed(0)} mm below it`);

  // a limb is an ellipse in section, not a circle
  const armX = F.joint('wrist.L')[0], armY = F.joint('wrist.L')[1];
  const w = exit([armX, armY, 0.550 * H], out);
  const dp = exit([armX, armY, 0.550 * H], back);
  ok(Math.abs(dp / w - FG.GIRTH.forearmAsp) < 0.12,
     `an elliptical forearm: ${w.toFixed(1)} mm across and ${dp.toFixed(1)} through, `
     + `a ratio of ${(dp / w).toFixed(2)} against the table's ${FG.GIRTH.forearmAsp}`);
}

// The spine's S is a pose parameter, so it can be turned off -- and a figure
// with it off has to be a straight column rather than a broken one.
console.log('\nthe spine curves, and can be told not to');
{
  const H = 1750;
  const curved = figure({ height: H, pose: { spine: 1, armLift: 0, legSpread: 0, elbow: 0, wrist: 0 } });
  const straight = figure({ height: H, pose: { spine: 0, armLift: 0, legSpread: 0, elbow: 0, wrist: 0 } });
  const lean = (F) => F.joint('neck')[1] - F.joint('pelvis')[1];
  // The trunk's net lean is backwards, which is what a standing posture does:
  // a lumbar hollow puts the shoulders behind the hips and the neck's own
  // forward offset brings the head back over the feet. What is checked is that
  // the curve moves the trunk at all, and that turning it off leaves nothing
  // but that deliberate offset -- not that the lean has a particular sign.
  const moved = Math.abs(lean(curved) - lean(straight));
  ok(moved > 0.008 * H, `curved: the S moves the neck ${moved.toFixed(1)} mm `
    + `in the sagittal plane (to ${lean(curved).toFixed(1)} mm of the pelvis)`);
  ok(Math.abs(lean(straight) - FG.GIRTH.neckFwd * H) < 1e-9,
     'straight: spine 0 stacks the trunk in one line, less the neck\'s own offset');
  // and either way the head ends up over the feet and at full height
  for (const [what, F] of [['curved', curved], ['straight', straight]])
    ok(Math.abs(F.joint('head')[2] - C.chin * H) < 0.004 * H,
       `${what}: the chin is still at ${(F.joint('head')[2] / H).toFixed(4)}H`);
}

// ----------------------------------------------------------- it scales ------
// Stature is the only length in the file; everything else is a fraction of it.
// So a figure twice as tall is the same figure at twice the size, exactly --
// including its blend radii, which are a girth and scale too.
console.log('\none number is the whole scale');
{
  const A = figure({ height: 900, pose: 'a' });
  const rigB = FG.mannequin({ height: 1800, pose: 'a' });
  const packedB = CN.pack(rigB);
  let worst = 0;
  let seed = 0x1d872b41;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed |= 0;
    return (seed >>> 0) / 4294967296;
  };
  const pts = [];
  for (let i = 0; i < 4000; i++)
    pts.push([(rnd() * 2 - 1) * A.packed.node.d[0] * 1.4,
              (rnd() * 2 - 1) * A.packed.node.d[1] * 1.4,
              (rnd() * 2 - 1) * A.packed.node.d[2] * 1.1]);
  SF.constructs = [A.packed.construct];
  const small = pts.map(p => SF.PRIMS.construct.js(p, A.packed.node.d, 0, { fi: 0 }));
  SF.constructs = [packedB.construct];
  pts.forEach((p, i) => {
    const big = SF.PRIMS.construct.js([p[0] * 2, p[1] * 2, p[2] * 2], packedB.node.d, 0, { fi: 0 });
    worst = Math.max(worst, Math.abs(big - 2 * small[i]));
  });
  ok(worst < 1e-9, `900 mm doubled is 1800 mm, to the last bit (worst ${worst.toExponential(2)} mm)`);
}

// `build` is a girth multiplier and must not touch a length
console.log('\nbuild is girth, and girth is not height');
{
  const H = 1750;
  // measured in the T-pose: with the arms down they rest against the ribs and
  // blend into them, which is what arms do, so there is no free chest to
  // measure across until they are out of the way
  const thin = figure({ height: H, build: 0.8, pose: 't' });
  const thinKnee = thin.joint('knee.L')[2];
  const wide = figure({ height: H, build: 1.3, pose: 't' });
  const wideKnee = wide.joint('knee.L')[2];
  ok(Math.abs(thinKnee - wideKnee) < 1e-9,
     `build 0.8 and 1.3 put the knee at the same height (${thinKnee.toFixed(1)} mm)`);

  const y = thin.joint('hip.L')[1];
  const wt = across(thin, 0.745 * H, y), ww = across(wide, 0.745 * H, y);
  ok(ww > wt * 1.2, `and a heavier chest is wider: ${(2 * wt).toFixed(0)} mm vs `
    + `${(2 * ww).toFixed(0)} mm across`);
}

// ------------------------------------------------------------- posing -------
console.log('\nposing moves what it should and nothing else');
{
  const H = 1750;
  const down = figure({ height: H, pose: 'anatomical' });
  const tee = figure({ height: H, pose: 't' });
  const dW = down.joint('wrist.L'), tW = tee.joint('wrist.L');
  ok(tW[0] > dW[0] * 2.5 && Math.abs(tW[2] - down.joint('neck')[2]) < 0.05 * H,
     `a T-pose puts the wrist out at x = ${tW[0].toFixed(0)} mm, near shoulder height`);
  ok(Math.abs(tee.joint('ankle.L')[2] - down.joint('ankle.L')[2]) < 0.02 * H,
     'and leaves the ankle where it was');

  // an angle on one joint travels down the chain and stops going up it
  const bent = figure({ height: H,
    pose: Object.assign({}, FG.POSES.anatomical, { elbow: 90 }) });
  ok(Math.abs(bent.joint('elbow.L')[2] - down.joint('elbow.L')[2]) < 1e-9,
     'a 90 deg elbow leaves the elbow itself where it was');
  ok(bent.joint('wrist.L')[1] - down.joint('wrist.L')[1] > 0.1 * H,
     `and swings the wrist forward by `
     + `${(bent.joint('wrist.L')[1] - down.joint('wrist.L')[1]).toFixed(0)} mm`);
}

// ------------------------------------------------------------- figure -------
console.log('\n`figure` moves the silhouette and adds nothing else');
{
  const H = 1750;
  const m = figure({ height: H, figure: 0, pose: 't' });
  const f = figure({ height: H, figure: 1, pose: 't' });
  const hipM = across(m, 0.545 * H, m.joint('hip.L')[1]);
  const hipF = across(f, 0.545 * H, f.joint('hip.L')[1]);
  ok(hipF > hipM * 1.05,
     `hips widen: ${(2 * hipM).toFixed(0)} → ${(2 * hipF).toFixed(0)} mm across`);
  // the shoulder is read off the joint rather than the solid, because the
  // deltoid and the arm are one blended run and there is no seam between them
  // to find with a ray
  const shM = m.joint('shoulder.L')[0], shF = f.joint('shoulder.L')[0];
  ok(shF < shM * 0.97, `shoulders narrow: the joint moves in from `
    + `${shM.toFixed(0)} to ${shF.toFixed(0)} mm off the midline`);
  const masses = (F) => F.packed.construct.items.length / SF.CON_STRIDE;
  ok(masses(f) > masses(m) && f.rig.joints.length === m.rig.joints.length,
     `and figure 1 carries ${masses(f) - masses(m)} more masses on the same `
     + `${f.rig.joints.length} connectors`);
  ok(CN.pack(FG.mannequin({ figure: 0.3 })).construct.items.length / SF.CON_STRIDE
       === masses(m),
     'while a mid setting is an androgynous form rather than half of one');
}

// ------------------------------------------------------------- skeleton -----
// The count that matters is not how many shapes the figure is made of but how
// many places it bends. Those are different numbers and the rig keeps them
// apart: a connector is a joint, and the flesh on it is however many
// primitives that flesh takes.
//
// Before a connector could wear a list, a second shape on a joint meant
// inventing a child with a zero offset to carry it -- so the skeleton filled up
// with deltoids and bellies and calves, and anything walking `joints` to build
// an animation had to know which entries were real. This is the check that they
// all are.
console.log('\nevery connector is a joint, not a place to hang a shape');
{
  const F = figure({ height: 1750, pose: 'anatomical' });
  const n = F.rig.joints.length;
  const masses = F.packed.construct.items.length / SF.CON_STRIDE;
  ok(masses > n * 2, `${n} connectors carrying ${masses} masses`);

  // Every connector past the root moves relative to its parent -- it is
  // somewhere else, or it points somewhere else, or both. One that is neither
  // is a shape holder wearing a skeleton's clothes.
  const idle = F.rig.joints.filter((j, i) => {
    if (i === 0) return false;
    const off = j.offset || [0, 0, 0], rot = j.rot || [0, 0, 0];
    return !off.some(v => Math.abs(v) > 1e-9) && !rot.some(v => Math.abs(v) > 1e-9);
  });
  ok(idle.length === 0, 'and each one is somewhere its parent is not'
    + (idle.length ? ` — ${idle.map(j => j.name).join(', ')}` : ''));

  // and they are the joints a body actually has
  const want = ['pelvis', 'lumbar', 'thorax', 'neck', 'head',
                'shoulder.L', 'elbow.L', 'wrist.L', 'hip.L', 'knee.L', 'ankle.L'];
  const have = new Set(F.rig.joints.map(j => j.name));
  const missing = want.filter(w => !have.has(w));
  ok(missing.length === 0, `named for the articulations they are`
    + (missing.length ? ` — missing ${missing.join(', ')}` : ''));

  // posing any of them has to move geometry, or it is not an articulation
  let dead = [];
  for (const j of F.rig.joints) {
    if (j.name === 'pelvis') continue;               // the root turns everything
    const bent = figure({ height: 1750, pose: 'anatomical' });
    const t = bent.rig.joints.find(x => x.name === j.name);
    t.pose = [25, 0, 0];
    const moved = CN.pack(bent.rig);
    const before = F.packed.construct.items, after = moved.construct.items;
    let diff = 0;
    for (let i = 0; i < before.length; i++) diff = Math.max(diff, Math.abs(before[i] - after[i]));
    if (diff < 1) dead.push(j.name);
  }
  ok(dead.length === 0, 'and turning any one of them moves the figure'
    + (dead.length ? ` — ${dead.join(', ')} did nothing` : ''));
}

// -------------------------------------------------------------- refusals ----
console.log('\nit refuses what it cannot mean');
{
  for (const [what, opts, re] of [
    ['a height of zero', { height: 0 }, /height in mm/],
    ['a build of zero', { build: 0 }, /must be > 0/],
    ['a pose it does not have', { pose: 'crouching' }, /no pose named/]
  ]) {
    let threw = false;
    try { FG.mannequin(opts); } catch (e) { threw = re.test(e.message); }
    ok(threw, `${what} is refused`);
  }
}

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
