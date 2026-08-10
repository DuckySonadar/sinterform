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
  field: { fn: 'pFieldS', sampler: true,
    src: `float pFieldS(sampler3D s, vec3 p, vec3 d, float r){
  vec3 q = abs(p) - d;
  float box = length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
  if (d.x <= 0.0) return 1e9;
  // the grid is stored with z fastest, so the texture is nz wide by ny by nx
  // and the lookup is (z, y, x), not (x, y, z)
  vec3 uvw = (p + d)/(2.0*d);
  float v = (texture(s, clamp(uvw.zyx, 0.0, 1.0)).r*2.0 - 1.0)*r;
  return max(v, box);
}` },

  // A profile is the other one whose data cannot travel in the uniform block,
  // and it does not need to: an outline is a few hundred vec2s, and the
  // distance to a polygon is a loop over its edges. So it arrives as generated
  // source rather than as a texture -- `profileDecls` writes one function per
  // profile, and `call` names the slot in the function rather than passing it.
  // The src here is empty for that reason; there is nothing shared to emit.
  profile: { fn: 'pProfile', slotted: true, src: '' }
};

// The whole primitive function library, ready to paste into a fragment
// shader. Pass a key list to emit a subset.
function library(keys) {
  return (keys || Object.keys(GLSL)).map(k => GLSL[k].src).join('\n');
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
function profileDecls(profiles) {
  let s = '';
  (profiles || []).forEach((pr, i) => {
    const loops = ((pr && pr.loops) || []).filter(l => l && l.length >= 3);
    if (!loops.length) { s += profileStub(i); return; }
    const f = (v) => (Number.isFinite(v) ? v : 0).toPrecision(8);
    let body = '';
    for (const poly of loops)
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++)
        body += `  E(vec2(${f(poly[a][0])},${f(poly[a][1])}),`
              + `vec2(${f(poly[b][0])},${f(poly[b][1])}));\n`;
    s += `float pProfile${i}(vec3 p, vec3 d){
  float dd = 1e18; bool ins = false;
#define E(A, B) { vec2 e = (B) - (A), w = p.xy - (A); \\
  vec2 q = w - e*clamp(dot(w, e)/dot(e, e), 0.0, 1.0); \\
  dd = min(dd, dot(q, q)); \\
  bool c1 = p.y >= (A).y, c2 = p.y < (B).y; \\
  float cr = e.x*w.y - e.y*w.x; \\
  if ((c1 && c2 && cr > 0.0) || (!c1 && !c2 && cr < 0.0)) ins = !ins; }
${body}#undef E
  float da = (ins ? -1.0 : 1.0)*sqrt(dd);
  float db = abs(p.z) - d.z;
  return min(max(da, db), 0.0) + length(max(vec2(da, db), 0.0));
}
`;
  });
  return s;
}
// A slot with no outline in it still has to compile: the shader is generated
// from the plan, and a node can name a profile that is not there yet.
function profileStub(i) {
  return `float pProfile${i}(vec3 p, vec3 d){ return 1e9; }\n`;
}

function samplerDecls(count) {
  let s = 'precision highp sampler3D;\n';
  for (let i = 0; i < (count | 0); i++) s += `uniform sampler3D uField${i};\n`;
  return s;
}

const SinterFormGLSL = { GLSL, library, call, samplerDecls, profileDecls,
                         KEYS: Object.keys(GLSL) };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterFormGLSL;
root.SinterFormGLSL = SinterFormGLSL;
})(typeof self !== 'undefined' ? self : globalThis);
