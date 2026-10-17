/* Check that an STL read back in is the shape that went out.
 *
 *     node check-stl.mjs
 *
 * parseSTL and meshField turn a mesh from somewhere else into a baked field.
 * The useful property is that the field is the *distance* to that mesh -- not
 * merely the right inside and outside, which is all a picture would show, but
 * the right number out to the edge of its range, because that number is what
 * a blend reads. A field whose distances were grid steps instead of
 * millimetres would draw correctly and blend wrongly, and nobody would see it
 * until a fillet came out lopsided.
 *
 * So the meshes here come from the kernel's own shapes, meshed by the kernel's
 * own mesher and written by its own STL writer, and the answer to compare the
 * field against is sceneSDF of the scene that made them -- known exactly,
 * everywhere, with no second implementation to trust.
 *
 * Then the faults STLs from elsewhere actually have: two shells overlapping
 * (parity alone calls the overlap empty), a triangle wound the wrong way
 * (winding alone calls the far side empty), a cavity, ASCII, and a binary file
 * whose header starts with "solid".
 *
 * Exit code is 0 or 1, so it can be a CI step.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const mod = { exports: {} };
new Function('module', readFileSync(join(HERE, 'sinterform.js'), 'utf8'))(mod);
const SF = mod.exports;

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};
let seed = 0x51e7a3;
const rnd = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed |= 0;
  return (seed >>> 0) / 4294967296;
};

const node = (t, o) => Object.assign({ t, on: true, op: 'add', k: 0, b: 0, fi: 0,
  p: [0, 0, 0], r: [0, 0, 0], d: SF.PRIMS[t].def.slice(), round: 0,
  mx: false, my: false, mz: false }, o);

// the baked field, placed where meshField says, as the only shape in a scene
const fieldScene = (r) => {
  SF.fields = [r.field];
  return [{ id: 0, nodes: [node('field', { p: r.centre, d: r.field.box.slice() })] }];
};

// a scene -> its mesh -> the bytes of a binary STL -> back
async function roundTrip(plan, meshRes) {
  const m = SF.mesh(plan, { res: meshRes });
  const buf = await SF.meshToSTL(m, 'check-stl').arrayBuffer();
  return SF.parseSTL(buf);
}

// Exact distance from a point to a triangle soup, by brute force: slow, and
// sharing nothing with meshField but the question.
function soupDist(T, p) {
  let best = Infinity;
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const seg = (a, b) => {
    const ab = sub(b, a), t = Math.min(Math.max(dot(sub(p, a), ab) / (dot(ab, ab) || 1), 0), 1);
    return Math.hypot(...sub(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]));
  };
  for (let o = 0; o < T.length; o += 9) {
    const a = [T[o], T[o + 1], T[o + 2]], b = [T[o + 3], T[o + 4], T[o + 5]],
          c = [T[o + 6], T[o + 7], T[o + 8]];
    const ab = sub(b, a), ac = sub(c, a);
    const nrm = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2],
                 ab[0] * ac[1] - ab[1] * ac[0]];
    const nn = dot(nrm, nrm);
    // inside the prism over the face, the plane distance; otherwise the edges
    if (nn > 0) {
      const ap = sub(p, a), h = dot(ap, nrm) / nn;
      const q = sub(ap, [nrm[0] * h, nrm[1] * h, nrm[2] * h]);
      const d00 = dot(ab, ab), d01 = dot(ab, ac), d11 = dot(ac, ac);
      const d20 = dot(q, ab), d21 = dot(q, ac), den = d00 * d11 - d01 * d01;
      const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
      if (v >= 0 && w >= 0 && v + w <= 1) { best = Math.min(best, Math.abs(h) * Math.sqrt(nn)); continue; }
    }
    best = Math.min(best, seg(a, b), seg(b, c), seg(c, a));
  }
  return best;
}

// The grid nodes are where meshField's own answer is, before the sampler
// interpolates between them. There it should be the brute-force distance to
// within the byte encoding -- half of 16/255 mm -- plus whatever the sweeps
// lose handing nearest triangles on, which is the part of this that is an
// approximation and so the part worth measuring on its own. A mesh of a few
// big faces is exact to the encoding (0.031 mm); a curved one of small
// triangles measured 0.039-0.055 mm when this was written, so the bar is half
// an encoding step plus 0.04 mm.
const NODE_BAR = 0.07;
function nodes(name, tris, r, tol) {
  const f = r.field, lo = r.centre.map((c, a) => c - f.box[a]);
  const res = (f.box[0] * 2) / (f.nx - 1);
  let worst = 0, n = 0;
  for (let q = 0; q < 400; q++) {
    const i = Math.floor(rnd() * f.nx), j = Math.floor(rnd() * f.ny), k = Math.floor(rnd() * f.nz);
    const t = soupDist(tris, [lo[0] + i * res, lo[1] + j * res, lo[2] + k * res]);
    if (t > f.range - 1) continue;
    const v = Math.abs((f.data[(i * f.ny + j) * f.nz + k] / 255 * 2 - 1) * f.range);
    worst = Math.max(worst, Math.abs(v - t)); n++;
  }
  ok(worst < tol, `${name}: grid nodes within ${worst.toFixed(3)} mm of brute force (bar ${tol}, ${n} nodes)`);
}

// Compare a field against the truth at random points inside its box. The
// distance is held to the mesh it was made from, by brute force, out to the
// edge of the range, where it is clamped. The sign is held to the scene, by
// sceneSDF: a blended or cut scene's sceneSDF is only a bound on distance --
// smin and smax under-report -- but its sign is exact, and the mesh's own
// "inside" is what the sign pass is supposed to recover. Skip `scene` for a
// soup with no scene behind it and the distance's own sign is used.
//
// Between nodes the sampler interpolates, and a distance field is not linear:
// it has a crease along every medial surface and a cone at every convex edge,
// and a trilinear read across either is off by a fraction of a cell. That is
// a property of any baked field -- MetaMeld's own Bake has it -- so the bar
// here is 0.45 of the grid spacing, and the node check above is the one that
// says whether meshField itself is right.
function compare(name, scene, tris, r, samples) {
  const tol = +(0.45 * (r.field.box[0] * 2) / (r.field.nx - 1)).toFixed(3);
  const F = fieldScene(r);
  const f = r.field;
  let worst = 0, n = 0, signBad = 0, signN = 0;
  for (let i = 0; i < (samples || 800); i++) {
    const p = [0, 1, 2].map(a => r.centre[a] + (rnd() * 2 - 1) * f.box[a] * 0.97);
    const s = SF.sceneSDF(scene, ...p), v = SF.sceneSDF(F, ...p);
    const t = soupDist(tris, p);
    if (t < f.range - 1) { worst = Math.max(worst, Math.abs(t - Math.abs(v))); n++; }
    if (t > 0.5) { signN++; if (Math.sign(s) !== Math.sign(v)) signBad++; }
  }
  ok(worst < tol, `${name}: distance within ${worst.toFixed(3)} mm of brute force `
    + `(bar ${tol}, ${n} samples inside the range)`);
  ok(signBad === 0, `${name}: inside and outside agree at all ${signN} samples `
    + `clear of the surface` + (signBad ? ` — ${signBad} wrong` : ''));
}

console.log('\nRound trips through the kernel\'s own STL');
{
  // blended, so the surface is curved everywhere the distance is tested
  const plan = [{ id: 0, nodes: [
    node('box', { d: [24, 18, 14], round: 2 }),
    node('sphere', { p: [10, 4, 6], d: [9, 0, 0], k: 3 }),
    node('cylinder', { op: 'cut', p: [-6, 0, 0], d: [3, 40, 0], r: [90, 0, 0] })
  ] }];
  const s = await roundTrip(plan, 0.5);
  ok(s.count > 1000, `parseSTL read ${s.count} triangles back`);
  const t0 = Date.now();
  const r = SF.meshField(s.tris, { res: 0.6 });
  const ms = Date.now() - t0;
  const f = r.field;
  ok(f.nx * f.ny * f.nz === f.data.length, `grid ${f.nx}×${f.ny}×${f.nz} in ${ms} ms`);
  // the grid's box is exactly (n - 1) cells, so a sample sits on every corner
  ok([f.nx, f.ny, f.nz].every((m, a) => Math.abs(f.box[a] * 2 - (m - 1) * 0.6) < 1e-9),
     'box is (n - 1) × res: the samples are not stretched');
  // Surface nets at 0.3 mm, trilinear at 0.6, one byte across +-8 mm: each is
  // a few hundredths, and a blend fold reading this is a few tenths wide.
  nodes('blended box with a bore', s.tris, r, NODE_BAR);
  compare('blended box with a bore', plan, s.tris, r);
}
{
  // a hole straight through: rays in every axis cross it
  const plan = [{ id: 0, nodes: [node('torus', { d: [14, 5, 0], r: [30, 20, 0] })] }];
  const s = await roundTrip(plan, 0.5);
  const r = SF.meshField(s.tris, { res: 0.5 });
  nodes('tilted torus', s.tris, r, NODE_BAR);
  compare('tilted torus', plan, s.tris, r);
}
{
  // a sealed void: the inner wall faces inward, so both rules must call the
  // void outside
  const plan = [{ id: 0, nodes: [node('sphere', { d: [14, 0, 0] }),
                                 node('box', { op: 'cut', d: [12, 12, 12] })] }];
  const s = await roundTrip(plan, 0.5);
  const r = SF.meshField(s.tris, { res: 0.5 });
  nodes('sphere with a sealed cubic void', s.tris, r, NODE_BAR);
  compare('sphere with a sealed cubic void', plan, s.tris, r);
}

console.log('\nWhat STLs from elsewhere get wrong');
// A cube as twelve triangles, wound outward, which no mesher would produce:
// faces exactly on the grid's lines and corners on its points, which is where
// a ray lands on a shared edge if anything is going to.
const cube = (c, h, flip) => {
  const v = [];
  for (let i = 0; i < 8; i++)
    v.push([c[0] + (i & 1 ? h : -h), c[1] + (i & 2 ? h : -h), c[2] + (i & 4 ? h : -h)]);
  const F = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const out = [];
  F.forEach((q, fi) => {
    for (const tri of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
      if (flip && fi === 0) tri.reverse();
      for (const k of tri) out.push(...v[k]);
    }
  });
  return out;
};
const boxTruth = (cs, h) => [{ id: 0, nodes: cs.map(c => node('box', { p: c, d: [2 * h, 2 * h, 2 * h] })) }];
{
  const t = new Float32Array(cube([0, 0, 0], 8));
  const r = SF.meshField(t, { res: 0.5 });
  nodes('cube on the grid lines', t, r, NODE_BAR);
  compare('cube on the grid lines', boxTruth([[0, 0, 0]], 8), t, r, 3000);
}
{
  // The soup's own faces include the buried ones, so brute force over it is
  // the wrong distance inside; the union of two boxes is exact as a min, and
  // that is what the field should have found once the buried faces are gone.
  const soup = new Float32Array(cube([0, 0, 0], 8).concat(cube([6, 5, 4], 8)));
  const truth = boxTruth([[0, 0, 0], [6, 5, 4]], 8);
  const r = SF.meshField(soup, { res: 0.5 });
  const F = fieldScene(r);
  let worst = 0, signBad = 0;
  for (let i = 0; i < 20000; i++) {
    const p = [0, 1, 2].map(a => r.centre[a] + (rnd() * 2 - 1) * r.field.box[a] * 0.97);
    const t = SF.sceneSDF(truth, ...p), v = SF.sceneSDF(F, ...p);
    // outside, min of two exact boxes is exact; inside it is a bound, so
    // inside only the sign is asked for
    if (t > 0 && t < r.field.range - 1) worst = Math.max(worst, Math.abs(t - v));
    if (t < -0.5 && v >= 0) signBad++;
    if (t < -1.5 && t > -6 && Math.abs(v) < 0.6 * Math.abs(t)) worst = Math.max(worst, 9);
  }
  ok(worst < 0.15, `two cubes overlapping, never unioned: outside within ${worst.toFixed(3)} mm, `
    + 'and no buried face reads as surface');
  ok(signBad === 0, `two cubes overlapping: the overlap is solid` + (signBad ? ` — ${signBad} wrong` : ''));
}
{
  const t = new Float32Array(cube([1, 2, 3], 8, true));
  const r = SF.meshField(t, { res: 0.5 });
  nodes('cube with one face wound backwards', t, r, NODE_BAR);
  compare('cube with one face wound backwards', boxTruth([[1, 2, 3]], 8), t, r, 3000);
}
{
  // ASCII, and a binary whose header begins with "solid"
  const t = cube([0, 0, 0], 5);
  let s = 'solid test\n';
  for (let i = 0; i < t.length; i += 9) {
    s += ' facet normal 0 0 0\n  outer loop\n';
    for (let v = 0; v < 9; v += 3) s += `   vertex ${t[i + v]} ${t[i + v + 1]} ${t[i + v + 2]}\n`;
    s += '  endloop\n endfacet\n';
  }
  s += 'endsolid test\n';
  const a = SF.parseSTL(new TextEncoder().encode(s));
  ok(a.count === 12 && a.lo.join() === '-5,-5,-5' && a.hi.join() === '5,5,5',
     `ASCII: ${a.count} triangles, bounds ${a.lo} .. ${a.hi}`);
  const buf = new ArrayBuffer(84 + 12 * 50), dv = new DataView(buf);
  'solid but binary'.split('').forEach((ch, i) => dv.setUint8(i, ch.charCodeAt(0)));
  dv.setUint32(80, 12, true);
  for (let i = 0; i < 12; i++)
    for (let v = 0; v < 9; v++) dv.setFloat32(84 + i * 50 + 12 + 4 * v, t[i * 9 + v], true);
  const b = SF.parseSTL(buf);
  ok(b.count === 12 && b.tris.every((x, i) => x === t[i]),
     'binary with a "solid" header is read as binary');
  let threw = '';
  try { SF.parseSTL(new TextEncoder().encode('not a mesh')); } catch (e) { threw = e.message; }
  ok(/no triangles/.test(threw), `junk is refused: "${threw}"`);
}

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
