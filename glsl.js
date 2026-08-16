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

  // A sweep: a section dragged along a path, at a scale and a roll that may
  // both vary as it goes. The largest of the slotted primitives, and a direct
  // transcription of sweep.js's evaluator -- which is the point, because that
  // evaluator is the one check-sweep holds against tangent fillets, an exact
  // torus and the kernel's own cone in a slanted frame.
  //
  // Each item is one path segment carrying its own frame, span, scale, roll,
  // caps and turn. The section travels with every segment rather than once per
  // slot: a few floats repeated, and the compiler folds the branch away since
  // the kind arrives as a literal.
  //
  // Two things here are not obvious and both were bugs first. The rounded
  // joint revolves the section about *the axis the path turns about* -- a
  // circular section cannot show the difference, anything else bunches at the
  // corner. And it is a term of its own rather than something the segment
  // answers past its end, gated on reach and clamped into the turn.
  //
  // The item is laid out in the order this reads it, which is not the order it
  // was worked out in: the five values the cull test needs come first, so a
  // segment that cannot win is answered without reading the other nineteen.
  // build-twins.mjs's intrinsic table and sweep.js's `pack` say that same
  // layout, and check-glsl runs both ends of it on the same data.
  sweep: { fn: 'pSweep', slotted: true, spec: true,
    src: `float sweepSection(float kind, vec3 sp, float u, float v){
  if (kind < 0.5) return length(vec2(u, v)) - sp.x;
  if (kind < 1.5) {
    float hw = max(sp.x*0.5 - sp.z, 0.0), hh = max(sp.y*0.5 - sp.z, 0.0);
    float qu = abs(u) - hw, qv = abs(v) - hh;
    return length(max(vec2(qu, qv), 0.0)) + min(max(qu, qv), 0.0) - sp.z;
  }
  if (kind < 2.5) return max(length(vec2(u, v)) - sp.x, -v);
  // A drawn 2D sketch, by profile slot: the same outlines the profile
  // primitive extrudes, and the same polygonSDF the kernel evaluates.
  return sectionPoly(sp.x, u, v);
}

float pSweep(sweeppath w, vec3 p, vec3 d, float r){
  float best = 1e18;
  int n = swCount(w);
  for (int i = 0; i < n; i++) {
    // Only what the cull test needs is read here. A segment that cannot win
    // costs one dot, one length and a compare, and never touches the other
    // nineteen numbers of its item -- which is most of the item, and on the JS
    // side most of the memory traffic.
    vec3 A = swA(w, i);
    vec3 T = swT(w, i);
    vec3 LS = swLS(w, i);
    vec3 M = swMisc(w, i);
    float cull = swCull(w, i);

    vec3 pa = p - A;
    float proj = dot(pa, T);
    float q = clamp(proj, 0.0, LS.x);
    // Everything this segment can contribute -- the prism, its caps, a miter's
    // run-on and the fill at its joint -- lies within cull of the axis, so a
    // point further than that from the axis cannot beat what is already in
    // best. The taper divides the answer down, so it has to be allowed for
    // here, exactly as the joint's own reach test allows for it.
    //
    // This is what makes a sweep affordable. The union is over every segment
    // by definition -- that is what stops a self-crossing path from taking
    // bites out of itself -- but a point near one end of the path is nowhere
    // near the far end, and answering for the far end costs a hundred flops to
    // return a number that loses. The test drops only terms that provably
    // lose, so a culled sweep is bit-for-bit the sweep it would have been.
    if (length(pa - T*q) - cull < best*M.y) {
      vec3 U = swU(w, i);
      vec3 V = swV(w, i);
      vec2 K = swK(w, i);
      vec2 TC = swTurn(w, i);
      vec2 E = swE(w, i);
      vec3 C = swCaps(w, i);
      float kind = swKind(w, i);
      vec3 sp = swSect(w, i);

      float t = q/LS.x;
      float oStart = -(proj + E.x);
      float oEnd = proj - (LS.x + E.y);
      bool atA = oStart > oEnd;
      float past = atA ? oStart : oEnd;
      float capped = max(C.x > 0.5 ? oStart : -1e30, C.y > 0.5 ? oEnd : -1e30);
      float s = LS.y + (LS.z - LS.y)*t;
      float u0 = dot(pa, U);
      float v0 = dot(pa, V);
      float u = u0;
      float v = v0;
      if (M.x != 0.0) {
        float a = M.x*t;
        float ca = cos(a);
        float sa = sin(a);
        u = u0*ca + v0*sa;
        v = v0*ca - u0*sa;
      }
      float d2 = s > 1e-9 ? sweepSection(kind, sp, u/s, v/s)*s : length(vec2(u, v));
      float raw;
      if (past > 0.0) raw = d2 <= 0.0 ? past : length(vec2(d2, past));
      else raw = max(d2, capped);
      best = min(best, raw/M.y);

      if (C.z > 0.5) {
        float oJ = proj - LS.x;
        if (length(vec3(u0, v0, oJ)) - M.z < best*M.y) {
          float uj = u0;
          float vj = v0;
          if (M.x != 0.0) {
            float ca = cos(M.x);
            float sa = sin(M.x);
            uj = u0*ca + v0*sa;
            vj = v0*ca - u0*sa;
          }
          float sJ = LS.z;
          float pk = uj*K.x + vj*K.y;
          float pm = vj*K.x - uj*K.y;
          float beta;
          float off;
          if (oJ < 0.0) { beta = pm; off = oJ; }
          else if (pm*TC.y - oJ*TC.x >= 0.0) { beta = length(vec2(pm, oJ)); off = 0.0; }
          else { beta = pm*TC.x + oJ*TC.y; off = oJ*TC.x - pm*TC.y; }
          float p2 = sweepSection(kind, sp, (pk*K.x - beta*K.y)/sJ,
                                            (pk*K.y + beta*K.x)/sJ)*sJ;
          float c = (off == 0.0 ? p2 : length(vec2(max(p2, 0.0), abs(off))))/M.y;
          best = min(best, c);
        }
      }
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
}` },

  // A construct: masses hung on a skeleton of connectors, folded with smin.
  //
  // The skeleton is not here. construct.js walks the tree once and hands over
  // a flat list in which every item already carries its own resolved frame --
  // the same division sweep.js makes, and for the same reason: composing
  // parents is a global property of the rig and this is a local evaluation. So
  // there is no hierarchy in this loop, no recursion, and nothing indexed
  // dynamically. A pose is different numbers in the same list.
  //
  // The frame arrives as a unit quaternion, already inverted, because what a
  // mass wants is its own local point: local = R'(p - o). Inverting a unit
  // quaternion is a sign flip on three floats, so construct.js does it once
  // per pack instead of once per sample per item, and the shader applies it
  // with the standard two-cross-product form. Four floats rather than a 3x3's
  // nine is worth it here: an item is read out of a uniform block whose size
  // is the consumer's whole budget, and a timeline will want to slerp them.
  //
  // Every transform is rigid. That is not a convention, it is what keeps this
  // a distance function -- construct.js refuses a scaled connector rather than
  // let the marcher step by a number that is too big.
  //
  // The cull is sweep's, for the same payoff: a bounding sphere first, so a
  // connector that cannot beat what has already been found is answered in four
  // reads instead of seventeen. smin(best, dd, k) is best whenever
  // dd >= best + k, and the k is already inside the radius construct.js packed,
  // so skipping is exact -- it changes the cost and never the answer.
  //
  // Exact *provided* a mass never reports less than the distance to its own
  // bounding sphere, and one of them does. An ellipsoid's is iq's bound rather
  // than its distance, and an anisotropic bound falls behind the true distance
  // without limit as you go out: no sphere is large enough to make the
  // implication hold, so this was not a radius to enlarge. What fixes it is
  // that the ball distance is *itself* a valid under-estimate -- the mass is
  // inside the ball -- so the greater of the two is one as well, and taking it
  // makes the premise true by construction. It costs a `max` and it tightens
  // the ellipsoid's far field on the way past, which the marcher is glad of.
  construct: { fn: 'pConstruct', slotted: true, spec: true,
    src: `float constructMass(float kind, vec3 q, vec3 dm, float tip){
  if (kind < 0.5) {
    float r0 = dm.x;
    float h = dm.z;
    // The cross-section's second axis, as a ratio of the first. A limb is not
    // a circle in section -- a wrist is 55 mm across and 40 through -- and a
    // figure built from round bones reads as tubing however good its
    // proportions are. Dividing the point by the ratio and multiplying the
    // answer by the smaller scale is the standard way to make an anisotropic
    // shape out of an isotropic one and stay 1-Lipschitz: the gradient picks
    // up 1/min(scale) and the factor takes it straight back out.
    float asp = max(dm.y, 1e-4);
    vec3 e = vec3(q.x, q.y/asp, q.z);
    float m = min(asp, 1.0);
    float sl = (r0 - tip)/h;
    float a2 = 1.0 - sl*sl;
    // One ball swallowing the other leaves no tangent cone between them and
    // the hull is just the larger ball -- the same degenerate case a wire's
    // round cone guards, reachable here by tapering a short bone hard.
    if (a2 <= 0.0) return min(length(e) - r0, length(e - vec3(0.0, 0.0, h)) - tip)*m;
    float a = sqrt(a2);
    vec2 w = vec2(length(e.xy), e.z);
    float t = dot(w, vec2(-sl, a));
    if (t < 0.0) return (length(w) - r0)*m;
    if (t > a*h) return (length(w - vec2(0.0, h)) - tip)*m;
    return (dot(w, vec2(a, sl)) - r0)*m;
  }
  if (kind < 1.5) {
    vec3 rr = max(dm, vec3(1e-3));
    float k0 = length(q/rr);
    float k1 = length(q/(rr*rr));
    if (k1 < 1e-6) return -min(rr.x, min(rr.y, rr.z));
    return k0*(k0 - 1.0)/k1;
  }
  if (kind < 2.5) return length(q) - dm.x;
  vec3 e = max(dm - tip, vec3(0.0));
  vec3 g = abs(q) - e;
  return length(max(g, 0.0)) + min(max(g.x, max(g.y, g.z)), 0.0) - tip;
}

float pConstruct(rig c, vec3 p, vec3 d, float r){
  float best = 1e18;
  int n = conCount(c);
  for (int i = 0; i < n; i++) {
    vec3 bc = conCull(c, i);
    float br = conCullR(c, i);
    float bd = length(p - bc) - br;
    if (bd < best) {
      vec3 org = conOrg(c, i);
      vec3 qv = conQ(c, i);
      float qw = conQW(c, i);
      vec3 dm = conMass(c, i);
      vec3 ms = conMisc(c, i);
      vec3 pa = p - org;
      vec3 t = vec3(qv.y*pa.z - qv.z*pa.y, qv.z*pa.x - qv.x*pa.z, qv.x*pa.y - qv.y*pa.x);
      vec3 lp = pa + (t*qw + vec3(qv.y*t.z - qv.z*t.y, qv.z*t.x - qv.x*t.z,
                                  qv.x*t.y - qv.y*t.x))*2.0;
      best = smin(best, max(constructMass(ms.x, lp, dm, ms.y), bd + ms.z), ms.z);
    }
  }
  return best;
}` }
};

// The whole primitive function library, ready to paste into a fragment
// shader. Pass a key list to emit a subset.
// The fold's own functions, which are not primitives but are just as much a
// definition: `smin` is what a blend *is*, and `invRot` is what a rotation is.
//
// These used to be hand-written in three places -- once in JavaScript in the
// kernel, and once in GLSL in each of the two files that assemble a shader,
// character for character identical. That is the same duplication the twins no
// longer have, so it is written here once and everyone reads it from here.
//
// `smin` and `smax` are translated into the kernel's generated block like any
// primitive. `invRot` is not, and deliberately: its JS twin writes into a
// caller-supplied array rather than returning one, because `sceneSDF` calls it
// once per node per sample and a returned array would be a hundred million
// allocations in a single mesh. It stays hand-written on the JS side, and
// check-glmesh compares the two ends of it per sample on a rotated scene.
const FOLD = `float smin(float a, float b, float k){
  if (k <= 0.0) return min(a, b);
  float h = clamp(0.5 + 0.5*(b - a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0 - h);
}

float smax(float a, float b, float k){ return -smin(-a, -b, k); }

vec3 invRot(vec3 p, vec3 e){
  float c, s; vec3 q = p;
  c = cos(e.z); s = sin(e.z); q = vec3( c*q.x + s*q.y, -s*q.x + c*q.y, q.z);
  c = cos(e.y); s = sin(e.y); q = vec3( c*q.x - s*q.z, q.y, s*q.x + c*q.z);
  c = cos(e.x); s = sin(e.x); q = vec3( q.x, c*q.y + s*q.z, -s*q.y + c*q.z);
  return q;
}
`;
// Which of them the kernel generates a twin for; the rest are shader-only.
const FOLD_TWINS = ['smin', 'smax'];

function foldSource() { return FOLD; }

// The bridge from a sweep's polygon section to the profile slot that holds it.
// GLSL has no function pointers and cannot build a name from a float, so this
// is a dispatch over however many slots the plan named -- three or four lines,
// and the compiler folds it away because the slot arrives as a literal.
//
// A profile extruded with a half-thickness of 1e9 is exactly its own 2D
// distance: the slab term never wins, so min(max(da, db), 0) + length(...)
// collapses to da. That is why a section needs no separate evaluator.
function sectionPolyDecl(count) {
  const n = Math.max(count | 0, 1);
  let s = 'float sectionPoly(float slot, float u, float v){\n';
  for (let i = 0; i < n - 1; i++)
    s += `  if (slot < ${i}.5) return pProfile${i}(vec3(u, v, 0.0), vec3(0.0, 0.0, 1e9));\n`;
  s += `  return pProfile${n - 1}(vec3(u, v, 0.0), vec3(0.0, 0.0, 1e9));\n}\n`;
  return s;
}

// Every slotted primitive's declarations, in the one order that compiles:
// profiles first, then the section dispatcher, then everything else -- because
// a sweep with a drawn section calls into the profiles and GLSL wants a
// function declared before it is used. `slots` is
// { profile: [items], wire: [...], sweep: [...] } from SinterForm.slotList.
//
// Both consumers get their block from here. The viewer packs its uniforms
// differently and writes its own map(), but the unrolling is the kernel's --
// written once per primitive, and called.
function slotBlock(plan, slots) {
  slots = slots || {};
  const nProfile = Math.max(maxSlot(plan, 'profile'),
                            (slots.profile || []).length, 1);
  return slotDecls('profile', slots.profile || [], nProfile) + '\n'
    + sectionPolyDecl(nProfile) + '\n'
    + Object.keys(UNROLL).filter(k => k !== 'profile')
        .map(k => slotDecls(k, slots[k] || [], maxSlot(plan, k))).join('\n');
}

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
    helpers: "",
    pre: "  float best = 1e18;",
    macro: "#define ITEM(SEGA, SEGB, SEGR) {\\\n  vec3 A = SEGA; \\\n  vec3 B = SEGB; \\\n  vec2 rr = SEGR; \\\n  vec3 ba = (B - A); \\\n  vec3 pa = (p - A); \\\n  float l2 = dot(ba, ba); \\\n  float dr = (rr.x - rr.y); \\\n  float a2 = (l2 - (dr * dr)); \\\n  if ((a2 <= 0.0)) { \\\n    best = min(best, min((length(pa) - rr.x), (length((p - B)) - rr.y))); \\\n  } else { \\\n    float il2 = (1.0 / l2); \\\n    float y = dot(pa, ba); \\\n    float z = (y - l2); \\\n    vec3 cx = ((pa * l2) - (ba * y)); \\\n    float x2 = dot(cx, cx); \\\n    float y2 = ((y * y) * l2); \\\n    float z2 = ((z * z) * l2); \\\n    float k = (((sign(dr) * dr) * dr) * x2); \\\n    float dd = 0.0; \\\n    if ((((sign(z) * a2) * z2) > k)) { \\\n      dd = ((sqrt((x2 + z2)) * il2) - rr.y); \\\n    } else { \\\n      if ((((sign(y) * a2) * y2) < k)) { \\\n        dd = ((sqrt((x2 + y2)) * il2) - rr.x); \\\n      } else { \\\n        dd = (((sqrt(((x2 * a2) * il2)) + (y * dr)) * il2) - rr.x); \\\n      } \\\n    } \\\n    best = min(best, dd); \\\n  } }\n",
    post: "  return best;"
  },
  sweep: {
    fn: "pSweep", stride: 32, arity: [3, 3, 3, 3, 1, 3, 3, 2, 2, 2, 3, 1, 3],
    helpers: "float sweepSection(float kind, vec3 sp, float u, float v){\n  if ((kind < 0.5)) {\n    return (length(vec2(u, v)) - sp.x);\n  }\n  if ((kind < 1.5)) {\n    float hw = max(((sp.x * 0.5) - sp.z), 0.0);\n    float hh = max(((sp.y * 0.5) - sp.z), 0.0);\n    float qu = (abs(u) - hw);\n    float qv = (abs(v) - hh);\n    return ((length(max(vec2(qu, qv), 0.0)) + min(max(qu, qv), 0.0)) - sp.z);\n  }\n  if ((kind < 2.5)) {\n    return max((length(vec2(u, v)) - sp.x), (-v));\n  }\n  return sectionPoly(sp.x, u, v);\n}\n",
    pre: "  float best = 1e18;",
    macro: "#define ITEM(SWA, SWT, SWLS, SWMISC, SWCULL, SWU, SWV, SWK, SWTURN, SWE, SWCAPS, SWKIND, SWSECT) {\\\n  vec3 A = SWA; \\\n  vec3 T = SWT; \\\n  vec3 LS = SWLS; \\\n  vec3 M = SWMISC; \\\n  float cull = SWCULL; \\\n  vec3 pa = (p - A); \\\n  float proj = dot(pa, T); \\\n  float q = clamp(proj, 0.0, LS.x); \\\n  if (((length((pa - (T * q))) - cull) < (best * M.y))) { \\\n    vec3 U = SWU; \\\n    vec3 V = SWV; \\\n    vec2 K = SWK; \\\n    vec2 TC = SWTURN; \\\n    vec2 E = SWE; \\\n    vec3 C = SWCAPS; \\\n    float kind = SWKIND; \\\n    vec3 sp = SWSECT; \\\n    float t = (q / LS.x); \\\n    float oStart = (-(proj + E.x)); \\\n    float oEnd = (proj - (LS.x + E.y)); \\\n    bool atA = (oStart > oEnd); \\\n    float past = (atA ? oStart : oEnd); \\\n    float capped = max(((C.x > 0.5) ? oStart : (-1e30)), ((C.y > 0.5) ? oEnd : (-1e30))); \\\n    float s = (LS.y + ((LS.z - LS.y) * t)); \\\n    float u0 = dot(pa, U); \\\n    float v0 = dot(pa, V); \\\n    float u = u0; \\\n    float v = v0; \\\n    if ((M.x != 0.0)) { \\\n      float a = (M.x * t); \\\n      float ca = cos(a); \\\n      float sa = sin(a); \\\n      u = ((u0 * ca) + (v0 * sa)); \\\n      v = ((v0 * ca) - (u0 * sa)); \\\n    } \\\n    float d2 = ((s > 1e-9) ? (sweepSection(kind, sp, (u / s), (v / s)) * s) : length(vec2(u, v))); \\\n    float raw; \\\n    if ((past > 0.0)) { \\\n      raw = ((d2 <= 0.0) ? past : length(vec2(d2, past))); \\\n    } else { \\\n      raw = max(d2, capped); \\\n    } \\\n    best = min(best, (raw / M.y)); \\\n    if ((C.z > 0.5)) { \\\n      float oJ = (proj - LS.x); \\\n      if (((length(vec3(u0, v0, oJ)) - M.z) < (best * M.y))) { \\\n        float uj = u0; \\\n        float vj = v0; \\\n        if ((M.x != 0.0)) { \\\n          float ca = cos(M.x); \\\n          float sa = sin(M.x); \\\n          uj = ((u0 * ca) + (v0 * sa)); \\\n          vj = ((v0 * ca) - (u0 * sa)); \\\n        } \\\n        float sJ = LS.z; \\\n        float pk = ((uj * K.x) + (vj * K.y)); \\\n        float pm = ((vj * K.x) - (uj * K.y)); \\\n        float beta; \\\n        float off; \\\n        if ((oJ < 0.0)) { \\\n          beta = pm; \\\n          off = oJ; \\\n        } else { \\\n          if ((((pm * TC.y) - (oJ * TC.x)) >= 0.0)) { \\\n            beta = length(vec2(pm, oJ)); \\\n            off = 0.0; \\\n          } else { \\\n            beta = ((pm * TC.x) + (oJ * TC.y)); \\\n            off = ((oJ * TC.x) - (pm * TC.y)); \\\n          } \\\n        } \\\n        float p2 = (sweepSection(kind, sp, (((pk * K.x) - (beta * K.y)) / sJ), (((pk * K.y) + (beta * K.x)) / sJ)) * sJ); \\\n        float c = (((off == 0.0) ? p2 : length(vec2(max(p2, 0.0), abs(off)))) / M.y); \\\n        best = min(best, c); \\\n      } \\\n    } \\\n  } }\n",
    post: "  return best;"
  },
  profile: {
    fn: "pProfile", stride: 4, arity: [2, 2],
    helpers: "",
    pre: "  float dd = 1e18;\n  bool ins = false;",
    macro: "#define ITEM(EDGEA, EDGEB) {\\\n  vec2 A = EDGEA; \\\n  vec2 B = EDGEB; \\\n  vec2 e = (B - A); \\\n  vec2 w = (p.xy - A); \\\n  vec2 q = (w - (e * clamp((dot(w, e) / dot(e, e)), 0.0, 1.0))); \\\n  dd = min(dd, dot(q, q)); \\\n  bool c1 = (p.y >= A.y); \\\n  bool c2 = (p.y < B.y); \\\n  float cr = ((e.x * w.y) - (e.y * w.x)); \\\n  if ((((c1 && c2) && (cr > 0.0)) || (((!c1) && (!c2)) && (cr < 0.0)))) { \\\n    ins = (!ins); \\\n  } }\n",
    post: "  float da = ((ins ? (-1.0) : 1.0) * sqrt(dd));\n  float db = (abs(p.z) - d.z);\n  return (min(max(da, db), 0.0) + length(max(vec2(da, db), 0.0)));"
  },
  construct: {
    fn: "pConstruct", stride: 17, arity: [3, 1, 3, 3, 1, 3, 3],
    helpers: "float constructMass(float kind, vec3 q, vec3 dm, float tip){\n  if ((kind < 0.5)) {\n    float r0 = dm.x;\n    float h = dm.z;\n    float asp = max(dm.y, 1e-4);\n    vec3 e = vec3(q.x, (q.y / asp), q.z);\n    float m = min(asp, 1.0);\n    float sl = ((r0 - tip) / h);\n    float a2 = (1.0 - (sl * sl));\n    if ((a2 <= 0.0)) {\n      return (min((length(e) - r0), (length((e - vec3(0.0, 0.0, h))) - tip)) * m);\n    }\n    float a = sqrt(a2);\n    vec2 w = vec2(length(e.xy), e.z);\n    float t = dot(w, vec2((-sl), a));\n    if ((t < 0.0)) {\n      return ((length(w) - r0) * m);\n    }\n    if ((t > (a * h))) {\n      return ((length((w - vec2(0.0, h))) - tip) * m);\n    }\n    return ((dot(w, vec2(a, sl)) - r0) * m);\n  }\n  if ((kind < 1.5)) {\n    vec3 rr = max(dm, vec3(1e-3));\n    float k0 = length((q / rr));\n    float k1 = length((q / (rr * rr)));\n    if ((k1 < 1e-6)) {\n      return (-min(rr.x, min(rr.y, rr.z)));\n    }\n    return ((k0 * (k0 - 1.0)) / k1);\n  }\n  if ((kind < 2.5)) {\n    return (length(q) - dm.x);\n  }\n  vec3 e = max((dm - tip), vec3(0.0));\n  vec3 g = (abs(q) - e);\n  return ((length(max(g, 0.0)) + min(max(g.x, max(g.y, g.z)), 0.0)) - tip);\n}\n",
    pre: "  float best = 1e18;",
    macro: "#define ITEM(CONCULL, CONCULLR, CONORG, CONQ, CONQW, CONMASS, CONMISC) {\\\n  vec3 bc = CONCULL; \\\n  float br = CONCULLR; \\\n  float bd = (length((p - bc)) - br); \\\n  if ((bd < best)) { \\\n    vec3 org = CONORG; \\\n    vec3 qv = CONQ; \\\n    float qw = CONQW; \\\n    vec3 dm = CONMASS; \\\n    vec3 ms = CONMISC; \\\n    vec3 pa = (p - org); \\\n    vec3 t = vec3(((qv.y * pa.z) - (qv.z * pa.y)), ((qv.z * pa.x) - (qv.x * pa.z)), ((qv.x * pa.y) - (qv.y * pa.x))); \\\n    vec3 lp = (pa + (((t * qw) + vec3(((qv.y * t.z) - (qv.z * t.y)), ((qv.z * t.x) - (qv.x * t.z)), ((qv.x * t.y) - (qv.y * t.x)))) * 2.0)); \\\n    best = smin(best, max(constructMass(ms.x, lp, dm, ms.y), (bd + ms.z)), ms.z); \\\n  } }\n",
    post: "  return best;"
  }
};

// One slot's function. `items` is what SinterForm.slotItems returned for it.
//
// `uniform` is what makes a *pose* different from a *shape*. Without it the
// item data is compiled straight into the function as literals, which is what
// a wire or a sweep wants: the numbers are the geometry, and a compiler that
// can see them folds the item's arithmetic away before it ever runs. A
// construct's numbers change every frame an animation runs, and recompiling a
// shader per frame is not a thing anyone can afford -- so the literals become
// reads out of a uniform array instead. The *indices* stay literal, which is
// the part that matters: WebGL2 still never indexes an array dynamically, so
// the unrolling buys what it was written to buy, and only the values move.
function slotDecl(key, i, items, uniform) {
  const U = UNROLL[key];
  if (!U) throw new Error('not a slotted primitive: ' + key);
  const f = (v) => (Number.isFinite(v) ? v : 0).toPrecision(8);
  const nm = uniform && uniform.name;
  const rd = (j) => nm + '[' + (j >> 2) + '].' + 'xyzw'[j & 3];
  // components landing inside one vec4 are a swizzle rather than a
  // constructor: the same reads, a third of the source
  const grp = (j, w) => {
    if (w === 1) return rd(j);
    if ((j & 3) + w <= 4)
      return nm + '[' + (j >> 2) + '].' + 'xyzw'.slice(j & 3, (j & 3) + w);
    const c = [];
    for (let m = 0; m < w; m++) c.push(rd(j + m));
    return 'vec' + w + '(' + c.join(',') + ')';
  };
  let body = '';
  for (let o = 0; o + U.stride <= items.length; o += U.stride) {
    const args = [];
    let k = o;
    for (const w of U.arity) {
      if (uniform) { args.push(grp(uniform.base + k, w)); k += w; continue; }
      const c = [];
      for (let j = 0; j < w; j++) c.push(f(items[k++]));
      args.push(w === 1 ? c[0] : `vec${w}(${c.join(',')})`);
    }
    body += `  ITEM(${args.join(',')});
`;
  }
  // The helpers the body calls travel with the first slot: a spec source is
  // not emitted by library(), so nothing else declares them.
  return (i === 0 ? U.helpers : '')
    + `float ${U.fn}${i}(vec3 p, vec3 d){
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
//
// `uniform`, when given, is the name of the vec4 array the items are read out
// of, and the declaration comes back with them. Feed it with slotUniformData.
function slotDecls(key, itemsPerSlot, count, uniform) {
  const F = slotFill(itemsPerSlot, count);
  const u = typeof uniform === 'string' ? { name: uniform } : uniform;
  let s = u ? 'uniform vec4 ' + u.name + '[' + F.vec4s + '];\n' : '';
  for (let i = 0; i < F.list.length; i++)
    s += slotDecl(key, i, F.list[i], u ? { name: u.name, base: F.bases[i] } : null);
  return s;
}

// One slot list, padded out to the slot count a shader has to be able to name,
// and where each slot's items begin in the flat uniform array. Both the
// source's reads and the consumer's upload come through here, so the two
// cannot disagree about which float is which -- the same reason the shape
// layout lives in this file rather than in whoever packs it.
function slotFill(itemsPerSlot, count) {
  const n = Math.max(count | 0, (itemsPerSlot || []).length, 1);
  const list = [];
  for (let i = 0; i < n; i++) list.push((itemsPerSlot || [])[i] || []);
  const bases = [];
  let f = 0;
  for (const it of list) { bases.push(f); f += it.length; }
  return { list, bases, floats: f, vec4s: Math.max(Math.ceil(f / 4), 1) };
}

// The numbers those reads expect, in that layout, padded to whole vec4s. A
// consumer uploads this and nothing else.
function slotUniformData(itemsPerSlot, count) {
  const F = slotFill(itemsPerSlot, count);
  const out = new Float32Array(F.vec4s * 4);
  let n = 0;
  for (const it of F.list) for (let j = 0; j < it.length; j++) out[n++] = it[j];
  return out;
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
    + slotBlock(plan, slots) + '\n'
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

const SinterFormGLSL = { GLSL, FOLD, FOLD_TWINS, foldSource, sectionPolyDecl,
                         library, call, samplerDecls, slotBlock, slotDecls, slotDecl,
                         slotFill, slotUniformData,
                         sceneBody, mapSource, maxSlot, packPlan,
                         KEYS: Object.keys(GLSL) };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterFormGLSL;
root.SinterFormGLSL = SinterFormGLSL;
})(typeof self !== 'undefined' ? self : globalThis);
