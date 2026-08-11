/* SinterForm GLSL - the shader half of the primitives
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every primitive in sinterform.js is written twice: once in JS, which is
 * geometry, and once in GLSL, which is a picture of geometry. Only the first
 * is the kernel's business. This file holds the second.
 *
 * It stays in this repository rather than moving to the application for two
 * reasons. The functions are portable -- `pBox(vec3 p, vec3 d, float r)` says
 * nothing about any particular renderer's camera, lighting or uniform layout,
 * and the second consumer that wants a GPU preview needs exactly these and
 * should not have to vendor an application to get them. And the twins have to
 * be checkable against each other in one place: split across repositories,
 * check-glsl.mjs could not run here at all, and adding a primitive would be
 * two pull requests with a window in between where this repository ships a
 * shape nothing can draw.
 *
 * What is *not* here is any budget. How many shapes fit in the uniforms and
 * how many fields fit in texture units are decisions belonging to whoever
 * packs the uniforms -- a consumer using an SSBO has no such limit -- so they
 * are arguments, not constants.
 *
 * Splitting them apart costs one thing and buys another. The cost is that the
 * twins no longer sit side by side, which was the only mechanism keeping them
 * in step -- so check-glsl.mjs, which used to compare two halves of one file,
 * now compares two files, and matters more than it did.
 *
 * What it buys is that the kernel can be used by something that does not draw
 * at all: a mesher, a slicer, a test. Nothing in sinterform.js now knows that
 * a GPU exists.
 *
 * Same rule as the kernel: nothing here may spell a literal closing script
 * tag, because this gets inlined into HTML too.
 */
(function (root) {
"use strict";

// key -> { fn, src, sampler? }. `sampler` marks a primitive whose GLSL takes
// a sampler3D as its first argument, which changes how it is called.
const GLSL = {
  sphere: { fn: 'pSphere',
    src: 'float pSphere(vec3 p, vec3 d, float r){ return length(p)-d.x; }' },
  box: { fn: 'pBox',
    src: `float pBox(vec3 p, vec3 d, float r){
  vec3 b = max(d*0.5 - r, vec3(0.0));
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}` },
  cylinder: { fn: 'pCyl',
    src: `float pCyl(vec3 p, vec3 d, float r){
  float rr = max(d.x - r, 0.0), hh = max(d.y*0.5 - r, 0.0);
  vec2 q = vec2(length(p.xy) - rr, abs(p.z) - hh);
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}` },
  capsule: { fn: 'pCap',
    src: `float pCap(vec3 p, vec3 d, float r){
  float hh = max(d.y*0.5 - d.x, 0.0);
  vec3 q = vec3(p.x, p.y, p.z - clamp(p.z, -hh, hh));
  return length(q) - d.x;
}` },
  torus: { fn: 'pTorus',
    src: `float pTorus(vec3 p, vec3 d, float r){
  vec2 q = vec2(length(p.xy) - d.x, p.z);
  return length(q) - d.y;
}` },
  cone: { fn: 'pCone',
    src: `float pCone(vec3 p, vec3 d, float r){
  float r1 = max(d.x - r, 0.0), r2 = max(d.y - r, 0.0);
  float h = max(d.z*0.5 - r, 0.0);
  vec2 q = vec2(length(p.xy), p.z);
  vec2 k1 = vec2(r2, h);
  vec2 k2 = vec2(r2 - r1, 2.0*h);
  vec2 ca = vec2(q.x - min(q.x, (q.y < 0.0) ? r1 : r2), abs(q.y) - h);
  // dot(k2, k2) is zero for a cone with equal radii and no height left after
  // rounding -- degenerate, but reachable from the sliders, and it used to be
  // guarded on the JS side only. Guarding the definition guards both.
  vec2 cb = q - k1 + k2*clamp(dot(k1 - q, k2)/max(dot(k2, k2), 1e-9), 0.0, 1.0);
  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
  return s*sqrt(min(dot(ca, ca), dot(cb, cb))) - r;
}` },
  ellipsoid: { fn: 'pEllip',
    src: `float pEllip(vec3 p, vec3 d, float r){
  vec3 rr = max(d*0.5, vec3(1e-3));
  float k0 = length(p/rr);
  float k1 = length(p/(rr*rr));
  if (k1 < 1e-6) return -min(rr.x, min(rr.y, rr.z));
  return k0*(k0 - 1.0)/k1;
}` },
  prism: { fn: 'pPrism',
    src: `float pPrism(vec3 p, vec3 d, float r){
  float n = clamp(floor(d.z + 0.5), 3.0, 12.0);
  float ang = 3.14159265359/n;
  float R = max(d.x - r/cos(ang), 0.0);
  float hh = max(d.y*0.5 - r, 0.0);
  float a = atan(p.y, p.x);
  a = mod(a + ang, 2.0*ang) - ang;
  vec2 q = length(p.xy)*vec2(cos(a), sin(a));
  float ap = R*cos(ang), hl = R*sin(ang);
  float e = length(vec2(q.x - ap, q.y - clamp(q.y, -hl, hl)));
  vec2 w = vec2(q.x < ap ? -e : e, abs(p.z) - hh);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - r;
}` },
  pyramid: { fn: 'pPyr',
    src: `float pPyr(vec3 p, vec3 d, float r){
  float b = max(d.x, 1e-4), H = max(d.y, 1e-4);
  vec3 P = vec3(p.x, p.z + H*0.5, p.y)/b;
  float h = H/b;
  float m2 = h*h + 0.25;
  P.xz = abs(P.xz);
  P.xz = (P.z > P.x) ? P.zx : P.xz;
  P.xz -= 0.5;
  vec3 q = vec3(P.z, h*P.y - 0.5*P.x, h*P.x + 0.5*P.y);
  float s = max(-q.x, 0.0);
  float t = clamp((q.y - 0.5*P.z)/(m2 + 0.25), 0.0, 1.0);
  float A = m2*(q.x + s)*(q.x + s) + q.y*q.y;
  float B = m2*(q.x + 0.5*t)*(q.x + 0.5*t) + (q.y - m2*t)*(q.y - m2*t);
  float d2 = min(q.y, -q.x*m2 - q.y*0.5) > 0.0 ? 0.0 : min(A, B);
  float lat = sqrt((d2 + q.z*q.z)/m2);
  float e2 = length(max(vec2(P.x, P.z), 0.0)) + min(P.x, 0.0);
  float base = length(vec2(max(e2, 0.0), P.y));
  float m = min(lat, base);
  return ((q.z < 0.0 && P.y > 0.0) ? -m : m)*b;
}` },
  octa: { fn: 'pOcta',
    src: `float pOcta(vec3 p, vec3 d, float r){
  float s = max(d.x - r*1.73205081, 0.0);
  p = abs(p);
  float m = p.x + p.y + p.z - s;
  vec3 q;
       if (3.0*p.x < m) q = p.xyz;
  else if (3.0*p.y < m) q = p.yzx;
  else if (3.0*p.z < m) q = p.zxy;
  else return m*0.57735027 - r;
  float k = clamp(0.5*(q.z - q.y + s), 0.0, s);
  return length(vec3(q.x, q.y - s + k, q.z - k)) - r;
}` },
  dome: { fn: 'pDome',
    src: `float pDome(vec3 p, vec3 d, float r){
  float R = max(d.x, 1e-4);
  float h = clamp(d.y, -R, R);
  float w = sqrt(max(R*R - h*h, 0.0));
  vec2 q = vec2(length(p.xy), p.z);
  float s = max((h - R)*q.x*q.x + w*w*(h + R - 2.0*q.y), h*q.x - w*q.y);
  return (s < 0.0) ? length(q) - R : (q.x < w) ? h - q.y : length(q - vec2(w, h));
}` },
  arc: { fn: 'pArc',
    src: `float pArc(vec3 p, vec3 d, float r){
  float th = clamp(d.z, 10.0, 360.0)*0.00872664626;
  vec2 sc = vec2(sin(th), cos(th));
  p.x = abs(p.x);
  float k = (sc.y*p.x > sc.x*p.y) ? dot(p.xy, sc) : length(p.xy);
  return sqrt(max(dot(p, p) + d.x*d.x - 2.0*d.x*k, 0.0)) - d.y;
}` },
  link: { fn: 'pLink',
    src: `float pLink(vec3 p, vec3 d, float r){
  float le = max(d.x*0.5 - d.y - d.z, 0.0);
  vec3 q = vec3(p.x, max(abs(p.z) - le, 0.0), p.y);
  return length(vec2(length(q.xy) - d.y, q.z)) - d.z;
}` },
  plane: { fn: 'pPlane',
    src: 'float pPlane(vec3 p, vec3 d, float r){ return p.z; }' },
  // The odd one out twice over. It takes a sampler, which `call` knows about
  // -- and it takes the field's **range** through the slot every other
  // primitive uses for its corner rounding, because a baked field has no
  // rounding and the range has to arrive somehow. The JS twin reads that off
  // the field object instead, so nothing in a plan carries it and a consumer
  // has to know to pack it. Pack `round` there by mistake and the sample comes
  // back multiplied by zero: max(0, box), which draws as the bounding box and
  // looks exactly like a texture that never arrived.
  // `fieldSample` is an INTRINSIC: build-twins.mjs substitutes a JS
  // implementation for it rather than translating this body, because reading a
  // grid is the one thing a shader and JavaScript genuinely do differently --
  // one asks the sampler hardware, the other interpolates by hand. Everything
  // around it is ordinary GLSL and is translated like any other primitive.
  //
  // Samples sit on the grid *corners*, spanning the box exactly, which is what
  // sampleField and every baker in this repository mean. A texture's own
  // coordinates put sample i at texel centre (i + 0.5)/n, so the mapping is
  // corrected here rather than at each call site -- without it the shader
  // reads a field stretched by half a texel at each end.
  field: { fn: 'pFieldS', sampler: true,
    src: `float fieldSample(sampler3D s, float u, float v, float w){
  vec3 sz = vec3(textureSize(s, 0));
  vec3 t = (vec3(u, v, w)*(sz - 1.0) + 0.5)/sz;
  return texture(s, clamp(t, 0.0, 1.0)).r;
}

float pFieldS(sampler3D s, vec3 p, vec3 d, float r){
  vec3 q = abs(p) - d;
  float box = length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
  if (d.x <= 0.0) return 1e9;
  // the grid is stored with z fastest, so the texture is nz wide by ny by nx
  // and the lookup is (z, y, x), not (x, y, z)
  vec3 uvw = clamp((p + d)/(2.0*d), 0.0, 1.0);
  float v = (fieldSample(s, uvw.z, uvw.y, uvw.x)*2.0 - 1.0)*r;
  return max(v, box);
}` },

  // A wire: the drawn curves given a thickness that may vary as it goes.
  //
  // The element is iq's round cone -- the convex hull of a sphere at each end
  // -- which is what a segment with a different radius at each end actually
  // is. It reduces to a capsule when the radii match, so a constant-thickness
  // wire costs nothing extra, and it is exact where a lerped radius is not: a
  // tapered surface is slanted, so measuring perpendicular to the axis
  // over-reports by the secant of the slant. This formula measures to the
  // slant.
  //
  // Consecutive segments share an endpoint, so the sphere there fills the
  // joint and there is no corner case to write. That is the whole reason a
  // wire is simpler than a sweep: a ball revolved about any axis is the same
  // ball, so the turn direction never matters.
  //
  // Rolled, like `profile`, with the segments reached through intrinsics --
  // `slotDecls` unrolls this same loop for the GPU, from this source.
  wire: { fn: 'pWire', slotted: true, spec: true,
    src: `float pWire(polyline w, vec3 p, vec3 d, float r){
  float best = 1e18;
  int n = segCount(w);
  for (int i = 0; i < n; i++) {
    vec3 A = segA(w, i);
    vec3 B = segB(w, i);
    vec2 rr = segR(w, i);
    vec3 ba = B - A;
    vec3 pa = p - A;
    float l2 = dot(ba, ba);
    float dr = rr.x - rr.y;
    float a2 = l2 - dr*dr;
    // One sphere swallowing the other -- or a zero-length segment -- has no
    // tangent cone between them, and the hull is just the larger sphere. min
    // of the two gives exactly that, since the contained one is never nearer.
    if (a2 <= 0.0) {
      best = min(best, min(length(pa) - rr.x, length(p - B) - rr.y));
    } else {
      float il2 = 1.0/l2;
      float y = dot(pa, ba);
      float z = y - l2;
      vec3 cx = pa*l2 - ba*y;
      float x2 = dot(cx, cx);
      float y2 = y*y*l2;
      float z2 = z*z*l2;
      float k = sign(dr)*dr*dr*x2;
      float dd = 0.0;
      if (sign(z)*a2*z2 > k) dd = sqrt(x2 + z2)*il2 - rr.y;
      else if (sign(y)*a2*y2 < k) dd = sqrt(x2 + y2)*il2 - rr.x;
      else dd = (sqrt(x2*a2*il2) + y*dr)*il2 - rr.x;
      best = min(best, dd);
    }
  }
  return best;
}` },

  // A profile is the other one whose data cannot travel in the uniform block,
  // and it does not need to: an outline is a few hundred vec2s, and the
  // distance to a polygon is a loop over its edges.
  //
  // This is the definition -- rolled, with the outline reached through the
  // `edgeCount`/`edgeA`/`edgeB` INTRINSICS, which is how the JS twin is
  // derived from it. What the GPU actually runs is the unrolled form
  // specialises this same loop by unrolling the edges into straight-line code.
  // That is an optimisation forced by WebGL2 (see the note there), not a
  // second definition, and check-glsl holds the unrolled form against the JS
  // this one generates.
  profile: { fn: 'pProfile', slotted: true, spec: true,
    src: `float pProfile(outline o, vec3 p, vec3 d, float r){
  float dd = 1e18;
  bool ins = false;
  int n = edgeCount(o);
  for (int i = 0; i < n; i++) {
    vec2 A = edgeA(o, i);
    vec2 B = edgeB(o, i);
    vec2 e = B - A;
    vec2 w = p.xy - A;
    vec2 q = w - e*clamp(dot(w, e)/dot(e, e), 0.0, 1.0);
    dd = min(dd, dot(q, q));
    bool c1 = p.y >= A.y;
    bool c2 = p.y < B.y;
    float cr = e.x*w.y - e.y*w.x;
    if ((c1 && c2 && cr > 0.0) || (!c1 && !c2 && cr < 0.0)) ins = !ins;
  }
  float da = (ins ? -1.0 : 1.0)*sqrt(dd);
  float db = abs(p.z) - d.z;
  return min(max(da, db), 0.0) + length(max(vec2(da, db), 0.0));
}` }
};

// The whole primitive function library, ready to paste into a fragment
// shader. Pass a key list to emit a subset.
// A `spec` source is the primitive's *definition* -- what build-twins.mjs
// translates -- and not code any shader runs: `profile`'s names an `outline`
// type that GLSL does not have, because what the GPU runs is the unrolled
// specialisation `slotDecls` writes. Emitting it would not compile.
function library(keys) {
  return (keys || Object.keys(GLSL))
    .filter(k => !GLSL[k].spec)
    .map(k => GLSL[k].src).join('\n');
}

// The call for one shape. `dims` and `round` are GLSL expressions the caller
// supplies -- wherever it decided to put them -- and `field` is the texture
// slot for a baked primitive. Emitting this here rather than in the consumer
// is what lets the sampler-first calling convention stay a detail of this
// file.
function call(key, point, dims, round, field) {
  const g = GLSL[key];
  if (!g) throw new Error('no GLSL for primitive: ' + key);
  // A slotted primitive's data is compiled into a function of its own, so the
  // slot is part of the name and there is no round to pass.
  if (g.slotted) return `${g.fn}${field | 0}(${point}, ${dims})`;
  return g.sampler
    ? `${g.fn}(uField${field | 0}, ${point}, ${dims}, ${round})`
    : `${g.fn}(${point}, ${dims}, ${round})`;
}

// The sampler declarations the library needs. `count` is the caller's texture
// budget: this file has no opinion about how many are affordable.
// GLSL ES 3.0 has no default precision for sampler3D, so it is stated here.
// One function per profile, with its outline compiled straight into it.
//
// This is iq's polygon distance, the same loop sinterform.js runs in JS, then
// the usual slab combine for the extrusion -- so the two halves are the same
// arithmetic on the same numbers, and check-glsl.mjs holds them to it. Loops
// after the first are holes: the crossing count runs over all of them at once,
// so a point inside an odd number is outside the material.
//
// The edges are emitted one after another rather than indexed out of a const
// array in a loop. Dynamic indexing of a constant array is where a GLSL
// compiler is entitled to give up and expand every read into a chain of
// selects, one per entry, which turns an O(edges) function into O(edges^2) --
// on a software rasteriser that was the difference between a frame and forty
// seconds. Straight-line code also lets the compiler fold each edge's vector
// arithmetic at compile time, since both its ends are literals.
// `count` is how many slots the shader must be able to name, which is a
// property of the *plan* rather than of the library: a node may refer to slot 3
// with nothing in it yet, and an undeclared pProfile3 is a compile error rather
// than an empty shape. Defaults to one more than the library holds.
// <<< generated unrollers
// ---------------------------------------------------------------------------
// GENERATED by build-twins.mjs from the rolled sources above — do not edit.
//
// A slotted primitive's shape is a list of items on the document, and WebGL2
// cannot index a constant array without expanding every read into a chain of
// selects. So the loop is unrolled: the body once as a macro, one invocation
// per item. This table is that body, taken from the same rolled source the JS
// twin is taken from, so the straight-line GLSL and the JavaScript cannot
// describe different shapes.
//
// `items` is a flat array of numbers per slot, `stride` of them per item, laid
// out in the order the parameters are listed. `SinterForm.slotItems(key, obj)`
// packs exactly that, and supplies a default when a slot is empty — which is
// why no default shape is written down in this file.
// ---------------------------------------------------------------------------
const UNROLL = {
  wire: {
    fn: "pWire", stride: 8, arity: [3, 3, 2],
    pre: "  float best = 1e18;",
    macro: "#define ITEM(SEGA, SEGB, SEGR) {\\\n  vec3 A = SEGA; \\\n  vec3 B = SEGB; \\\n  vec2 rr = SEGR; \\\n  vec3 ba = (B - A); \\\n  vec3 pa = (p - A); \\\n  float l2 = dot(ba, ba); \\\n  float dr = (rr.x - rr.y); \\\n  float a2 = (l2 - (dr * dr)); \\\n  if ((a2 <= 0.0)) { \\\n    best = min(best, min((length(pa) - rr.x), (length((p - B)) - rr.y))); \\\n  } else { \\\n    float il2 = (1.0 / l2); \\\n    float y = dot(pa, ba); \\\n    float z = (y - l2); \\\n    vec3 cx = ((pa * l2) - (ba * y)); \\\n    float x2 = dot(cx, cx); \\\n    float y2 = ((y * y) * l2); \\\n    float z2 = ((z * z) * l2); \\\n    float k = (((sign(dr) * dr) * dr) * x2); \\\n    float dd = 0.0; \\\n    if ((((sign(z) * a2) * z2) > k)) { \\\n      dd = ((sqrt((x2 + z2)) * il2) - rr.y); \\\n    } else { \\\n      if ((((sign(y) * a2) * y2) < k)) { \\\n        dd = ((sqrt((x2 + y2)) * il2) - rr.x); \\\n      } else { \\\n        dd = (((sqrt(((x2 * a2) * il2)) + (y * dr)) * il2) - rr.x); \\\n      } \\\n    } \\\n    best = min(best, dd); \\\n  } }\n",
    post: "  return best;"
  },
  profile: {
    fn: "pProfile", stride: 4, arity: [2, 2],
    pre: "  float dd = 1e18;\n  bool ins = false;",
    macro: "#define ITEM(EDGEA, EDGEB) {\\\n  vec2 A = EDGEA; \\\n  vec2 B = EDGEB; \\\n  vec2 e = (B - A); \\\n  vec2 w = (p.xy - A); \\\n  vec2 q = (w - (e * clamp((dot(w, e) / dot(e, e)), 0.0, 1.0))); \\\n  dd = min(dd, dot(q, q)); \\\n  bool c1 = (p.y >= A.y); \\\n  bool c2 = (p.y < B.y); \\\n  float cr = ((e.x * w.y) - (e.y * w.x)); \\\n  if ((((c1 && c2) && (cr > 0.0)) || (((!c1) && (!c2)) && (cr < 0.0)))) { \\\n    ins = (!ins); \\\n  } }\n",
    post: "  float da = ((ins ? (-1.0) : 1.0) * sqrt(dd));\n  float db = (abs(p.z) - d.z);\n  return (min(max(da, db), 0.0) + length(max(vec2(da, db), 0.0)));"
  }
};

// One slot's function. `items` is what SinterForm.slotItems returned for it.
function slotDecl(key, i, items) {
  const U = UNROLL[key];
  if (!U) throw new Error('not a slotted primitive: ' + key);
  const f = (v) => (Number.isFinite(v) ? v : 0).toPrecision(8);
  let body = '';
  for (let o = 0; o + U.stride <= items.length; o += U.stride) {
    const args = [];
    let k = o;
    for (const w of U.arity) {
      const c = [];
      for (let j = 0; j < w; j++) c.push(f(items[k++]));
      args.push(w === 1 ? c[0] : `vec${w}(${c.join(',')})`);
    }
    body += `  ITEM(${args.join(',')});
`;
  }
  return `float ${U.fn}${i}(vec3 p, vec3 d){
${U.pre}
${U.macro}${body}#undef ITEM
${U.post}
}
`;
}

// Every slot the shader must be able to name. A node may refer to a slot the
// document has not filled in yet, and an undeclared function is a compile
// error rather than an empty shape -- so the caller passes one `items` array
// per slot, and SinterForm.slotItems turns an absent entry into the default.
function slotDecls(key, itemsPerSlot, count) {
  const n = Math.max(count | 0, (itemsPerSlot || []).length, 1);
  let s = '';
  for (let i = 0; i < n; i++) s += slotDecl(key, i, (itemsPerSlot || [])[i] || []);
  return s;
}
// >>> generated unrollers

function samplerDecls(count) {
  let s = 'precision highp sampler3D;\n';
  for (let i = 0; i < (count | 0); i++) s += `uniform sampler3D uField${i};\n`;
  return s;
}

// ----------------------------------------------------------------------
// A whole plan, as shader source and as the uniforms that feed it.
//
// This used to live in viewer.js, on the reasoning that packing is a
// consumer's business. It is -- but the *layout* is not: three vec4 per shape,
// in this order, is a contract between the generated source and whoever fills
// the array, and two consumers writing it separately is the same trap the
// hand-written twins were. The viewer draws with it and glmesh.js meshes with
// it, and they cannot disagree about which float is the blend radius.
//
// Budgets stay arguments, per this file's charter: `maxN` and `maxFields` are
// facts about a caller's uniform block, not about geometry.
//
//   uD[3i + 0] = position.xyz, blend radius
//   uD[3i + 1] = rotation.xyz (radians), round slot
//   uD[3i + 2] = dims.xyz, unused
//
// `roundSlot` is required and is the kernel's `SinterForm.roundSlot`: it says
// what goes in that fourth float, which is corner rounding for every primitive
// but a baked field, where it is the field's range.
function sceneBody(plan, opts) {
  opts = opts || {};
  const maxN = opts.maxN === undefined ? 32 : opts.maxN;
  const maxFields = opts.maxFields === undefined ? 4 : opts.maxFields;
  const uni = opts.uniform || 'uD';
  let body = '', slot = 0;
  const at = new Map();
  for (const part of plan)
    for (const n of part.nodes)
      if (slot < maxN && !at.has(n)) at.set(n, slot++);
  for (const part of plan) {
    body += '  dB = 1e9;\n';
    for (const n of part.nodes) {
      const i = at.get(n);
      if (i === undefined) continue;
      const b = 3 * i;
      body += '  q = P;\n';
      if (n.mx) body += '  q.x = abs(q.x);\n';
      if (n.my) body += '  q.y = abs(q.y);\n';
      if (n.mz) body += '  q.z = abs(q.z);\n';
      body += `  q = invRot(q - ${uni}[${b}].xyz, ${uni}[${b + 1}].xyz);\n`;
      const fi = n.t === 'field'
        ? Math.min(Math.max(n.fi || 0, 0), maxFields - 1)
        : Math.max(n.fi || 0, 0);
      body += `  di = ${call(n.t, 'q', `${uni}[${b + 2}].xyz`, `${uni}[${b + 1}].w`, fi)};\n`;
      body += n.op === 'add' ? `  dB = smin(dB, di, ${uni}[${b}].w);\n`
            : n.op === 'cut' ? `  dB = smax(dB, -di, ${uni}[${b}].w);\n`
            :                  `  dB = smax(dB, di, ${uni}[${b}].w);\n`;
    }
    body += '  d = min(d, dB);\n';
  }
  return { body, at };
}

// The complete `float map(vec3 P)` for a plan: library, outlines, fold.
function mapSource(plan, profiles, opts) {
  const { body, at } = sceneBody(plan, opts);
  // `slots` is { profile: [itemsPerSlot], wire: [...] } from
  // SinterForm.slotItems -- the kernel packs the data, this file turns it into
  // source, and neither has an opinion about the other's half.
  const slots = (opts && opts.slots) || {};
  const src = `${library()}\n`
    + Object.keys(UNROLL).map(k =>
        slotDecls(k, slots[k] || [], maxSlot(plan, k))).join('\n') + '\n'
    + `float map(vec3 P){\n  float d = 1e9, dB, di; vec3 q;\n${body}  return d;\n}\n`;
  return { src, at };
}

// How many slots of a slotted primitive the shader must be able to name. A
// node may refer to a slot the library has not filled in yet, and an
// undeclared pProfileN or pWireN is a compile error rather than an empty shape.
function maxSlot(plan, t) {
  let n = 1;
  for (const part of plan || [])
    for (const q of part.nodes || [])
      if (q.t === t) n = Math.max(n, (q.fi | 0) + 1);
  return n;
}
const maxProfileSlot = (plan) => maxSlot(plan, 'profile');

function packPlan(at, opts) {
  opts = opts || {};
  const maxN = opts.maxN === undefined ? 32 : opts.maxN;
  const roundSlot = opts.roundSlot;
  if (typeof roundSlot !== 'function')
    throw new Error('packPlan needs opts.roundSlot (SinterForm.roundSlot)');
  const RAD = Math.PI / 180;
  const uData = opts.into || new Float32Array(maxN * 12);
  uData.fill(0);
  for (const [n, i] of at) {
    const b = 12 * i;
    uData[b] = n.p[0]; uData[b + 1] = n.p[1]; uData[b + 2] = n.p[2];
    uData[b + 3] = Math.max(n.k || 0, 0);
    uData[b + 4] = (n.r[0] || 0) * RAD;
    uData[b + 5] = (n.r[1] || 0) * RAD;
    uData[b + 6] = (n.r[2] || 0) * RAD;
    uData[b + 7] = roundSlot(n);
    uData[b + 8] = n.d[0]; uData[b + 9] = n.d[1] || 0; uData[b + 10] = n.d[2] || 0;
  }
  return uData;
}

const SinterFormGLSL = { GLSL, library, call, samplerDecls, slotDecls, slotDecl,
                         sceneBody, mapSource, maxProfileSlot, maxSlot, packPlan,
                         KEYS: Object.keys(GLSL) };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterFormGLSL;
root.SinterFormGLSL = SinterFormGLSL;
})(typeof self !== 'undefined' ? self : globalThis);
