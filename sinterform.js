/* SinterForm - a signed-distance geometry kernel
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * Primitives, boolean operations with smooth blends, bodies, baked distance
 * fields, a surface-nets mesher and binary STL output. No DOM, no WebGL, no
 * storage: it computes geometry and hands it back. That is what makes it
 * liftable into its own repository, and what keeps it usable from node --
 * which is how it gets tested.
 *
 * Nothing here knows that a GPU exists. The shader half of each primitive
 * lives in glsl.js, along with the two budgets that are facts about a
 * fragment shader rather than about geometry.
 *
 * This block is the whole of it. Everything past the end of this script
 * element is the MetaMeld(TM) application, which is separately licensed; the
 * boundary is this file's seam, and it is load-bearing. Nothing in here may
 * reach for `document`, `gl`, `localStorage` or the application's own state.
 *
 * (And nothing in here may spell the closing script tag, even inside a
 * comment -- HTML ends the element on the literal characters and the page
 * dies. This comment used to, which is how that was learnt.)
 */
(function (root) {
"use strict";
// ======================================================================
// SDF core. Units are millimetres, +Z is up, z = 0 is the build plate.
//
// Every primitive is defined once, in GLSL, in glsl.js. What is here is that
// definition translated into JavaScript by build-twins.mjs, so the two halves
// cannot say different things -- see the generated block below.
//
// They used to be two hand-written halves with check-glsl.mjs watching for
// drift. It was watching, and it still missed one: the cone's GLSL divided by
// dot(k2, k2) unguarded while its twin here wrote `|| 1e-9`, a real difference
// in a case the random-point comparison never landed on. check-glsl still runs
// and still compiles the real shader, but it is now asking whether a
// translation is faithful rather than whether two authors agreed.
// ======================================================================

// ======================================================================
// baked fields
// ======================================================================
// A shape the editor cannot describe with primitives -- the flexi fish, whose
// body is swept from NURBS curves -- arrives instead as its distance field,
// sampled on a grid. That is enough to cut against, blend with and mesh, which
// is the whole reason to want it here: a joint tool has to be positioned
// against the body it will cut, not against a guess at it.
//
// One field per document. It lives on the document rather than inside a node,
// so undo snapshots and the shape list stay small, and a node of type `field`
// refers to it. Samples are one byte each: 0..255 across +/-`range` mm, which
// is ~0.06 mm at the 8 mm range the exporter uses -- far finer than the grid
// spacing, so the quantisation is never the limit.
let fields = [];         // [{ name, nx, ny, nz, box:[hx,hy,hz], range, data, tex }]

// Profiles, the same idea for a shape that is a *drawing* rather than a
// sampled volume. A closed 2D outline extruded to a thickness is most of what
// anyone sketches, and it does not have to be baked to reach a shader: the
// distance to a polygon is a loop over its edges, which GLSL can run as
// happily as JS can. Baking one would cost a megabyte of texture and a grid's
// worth of resolution to say what a few hundred vec2s say exactly.
//
// Like `fields`, they live on the document rather than inside a node, and a
// node of type `profile` refers to one by index.
let profiles = [];       // [{ name, loops: [[[x, y], ...], ...] }]

// iq's polygon distance: nearest edge for the magnitude, a crossing count for
// the sign. Loops beyond the first are holes -- a point inside an odd number
// of them is outside the material. Exact, and 1-Lipschitz.
//
// This is the same function sketch.js exports, and deliberately a second copy:
// the two files do not depend on each other, and check-glsl.mjs holds this one
// against its GLSL twin while check-sketch.mjs holds that one against the
// geometry. A third copy would be one too many; two is the cost of the seam.
function polygonSDF(loops, px, py) {
  let d = Infinity, inside = false;
  for (const poly of loops) {
    const n = poly.length;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ex = poly[j][0] - poly[i][0], ey = poly[j][1] - poly[i][1];
      const wx = px - poly[i][0], wy = py - poly[i][1];
      let t = (wx * ex + wy * ey) / (ex * ex + ey * ey + 1e-300);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const bx = wx - ex * t, by = wy - ey * t;
      const dd = bx * bx + by * by;
      if (dd < d) d = dd;
      const c1 = py >= poly[i][1], c2 = py < poly[j][1];
      if ((c1 && c2 && ex * wy > ey * wx) || (!c1 && !c2 && ex * wy < ey * wx))
        inside = !inside;
    }
  }
  return d === Infinity ? 1e9 : (inside ? -1 : 1) * Math.sqrt(d);
}

// The half-extent of a profile in its own plane. A node carries this in its
// dims because `ext` -- which is what bounds are computed from -- is handed
// the dims and nothing else, the same way a field carries its box.
function profileExtent(loops) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of loops)
    for (const p of poly) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  return x1 < x0 ? [0, 0] : [Math.max(Math.abs(x0), Math.abs(x1)),
                             Math.max(Math.abs(y0), Math.abs(y1))];
}

function decodeField(f) {
  if (!f || !f.data) return null;
  const bin = atob(f.data);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const need = f.nx * f.ny * f.nz;
  if (data.length !== need)
    throw new Error(`field is ${data.length} bytes, expected ${need}`);
  return { name: String(f.name || 'Baked'), nx: f.nx, ny: f.ny, nz: f.nz,
           box: f.box.slice(), range: f.range, data, tex: null };
}
// Chunked, because fromCharCode(...half a million bytes) overflows the call
// stack. Cached, because the samples never change once loaded and this runs on
// every save -- which is every drag of every slider.
function encodeField(f) {
  if (!f.b64) {
    let s = '';
    for (let i = 0; i < f.data.length; i += 8192)
      s += String.fromCharCode.apply(null, f.data.subarray(i, i + 8192));
    f.b64 = btoa(s);
  }
  return { name: f.name, nx: f.nx, ny: f.ny, nz: f.nz, box: f.box,
           range: f.range, data: f.b64 };
}

// Trilinear sample in the field's own local frame. Outside the grid this
// returns the nearest edge sample, and `pField` unions that with the box so
// the result stays a safe under-estimate for the marcher.
function sampleField(f, x, y, z) {
  if (!f) return 1e9;
  const gx = (x + f.box[0]) / (2 * f.box[0]) * (f.nx - 1);
  const gy = (y + f.box[1]) / (2 * f.box[1]) * (f.ny - 1);
  const gz = (z + f.box[2]) / (2 * f.box[2]) * (f.nz - 1);
  const cl = (v, n) => Math.min(Math.max(v, 0), n - 1);
  const x0 = Math.floor(cl(gx, f.nx)), y0 = Math.floor(cl(gy, f.ny)),
        z0 = Math.floor(cl(gz, f.nz));
  const x1 = Math.min(x0 + 1, f.nx - 1), y1 = Math.min(y0 + 1, f.ny - 1),
        z1 = Math.min(z0 + 1, f.nz - 1);
  const tx = cl(gx, f.nx) - x0, ty = cl(gy, f.ny) - y0, tz = cl(gz, f.nz) - z0;
  const at = (i, j, k) => f.data[(i * f.ny + j) * f.nz + k];
  const lerp = (a, b, t) => a + (b - a) * t;
  const c00 = lerp(at(x0, y0, z0), at(x1, y0, z0), tx);
  const c10 = lerp(at(x0, y1, z0), at(x1, y1, z0), tx);
  const c01 = lerp(at(x0, y0, z1), at(x1, y0, z1), tx);
  const c11 = lerp(at(x0, y1, z1), at(x1, y1, z1), tx);
  const c = lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
  return (c / 255 * 2 - 1) * f.range;
}

// <<< generated twins
// ---------------------------------------------------------------------------
// GENERATED by build-twins.mjs from glsl.js — do not edit by hand.
//
// The GLSL is the definition of each primitive; this is that definition
// translated into JavaScript, so the two halves cannot say different things.
// Run `node build-twins.mjs` after changing a primitive's GLSL; check-kernel
// fails if this block is stale, and check-glsl proves the translation is
// faithful by running both on the same points.
//
// `field` and `profile` are not here: one reads a sampler and one is
// generated source with a macro. Both are hand-written below, and NOTICE
// records why.
// ---------------------------------------------------------------------------
const TWINS = {
  // pSphere — from GLSL.sphere.src
  sphere: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    return (Math.hypot(p_0, p_1, p_2) - d_0);
  },
  // pBox — from GLSL.box.src
  box: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let b_0 = Math.max(((d_0 * 0.5) - r), 0.0), b_1 = Math.max(((d_1 * 0.5) - r), 0.0), b_2 = Math.max(((d_2 * 0.5) - r), 0.0);
    let q_0 = (Math.abs(p_0) - b_0), q_1 = (Math.abs(p_1) - b_1), q_2 = (Math.abs(p_2) - b_2);
    return ((Math.hypot(Math.max(q_0, 0.0), Math.max(q_1, 0.0), Math.max(q_2, 0.0)) + Math.min(Math.max(q_0, Math.max(q_1, q_2)), 0.0)) - r);
  },
  // pCyl — from GLSL.cylinder.src
  cylinder: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let rr = Math.max((d_0 - r), 0.0);
    let hh = Math.max(((d_1 * 0.5) - r), 0.0);
    let q_0 = (Math.hypot(p_0, p_1) - rr), q_1 = (Math.abs(p_2) - hh);
    return ((Math.min(Math.max(q_0, q_1), 0.0) + Math.hypot(Math.max(q_0, 0.0), Math.max(q_1, 0.0))) - r);
  },
  // pCap — from GLSL.capsule.src
  capsule: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let hh = Math.max(((d_1 * 0.5) - d_0), 0.0);
    let q_0 = p_0, q_1 = p_1, q_2 = (p_2 - Math.min(Math.max(p_2, (-hh)), hh));
    return (Math.hypot(q_0, q_1, q_2) - d_0);
  },
  // pTorus — from GLSL.torus.src
  torus: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let q_0 = (Math.hypot(p_0, p_1) - d_0), q_1 = p_2;
    return (Math.hypot(q_0, q_1) - d_1);
  },
  // pCone — from GLSL.cone.src
  cone: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let r1 = Math.max((d_0 - r), 0.0);
    let r2 = Math.max((d_1 - r), 0.0);
    let h = Math.max(((d_2 * 0.5) - r), 0.0);
    let q_0 = Math.hypot(p_0, p_1), q_1 = p_2;
    let k1_0 = r2, k1_1 = h;
    let k2_0 = (r2 - r1), k2_1 = (2.0 * h);
    const t0 = (q_1 < 0.0);
    let ca_0 = (q_0 - Math.min(q_0, (t0 ? r1 : r2))), ca_1 = (Math.abs(q_1) - h);
    const t1 = Math.min(Math.max((((k1_0 - q_0)*k2_0 + (k1_1 - q_1)*k2_1) / Math.max((k2_0*k2_0 + k2_1*k2_1), 1e-9)), 0.0), 1.0);
    let cb_0 = ((q_0 - k1_0) + (k2_0 * t1)), cb_1 = ((q_1 - k1_1) + (k2_1 * t1));
    const t2 = ((cb_0 < 0.0) && (ca_1 < 0.0));
    let s = (t2 ? (-1.0) : 1.0);
    return ((s * Math.sqrt(Math.min((ca_0*ca_0 + ca_1*ca_1), (cb_0*cb_0 + cb_1*cb_1)))) - r);
  },
  // pEllip — from GLSL.ellipsoid.src
  ellipsoid: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let rr_0 = Math.max((d_0 * 0.5), 1e-3), rr_1 = Math.max((d_1 * 0.5), 1e-3), rr_2 = Math.max((d_2 * 0.5), 1e-3);
    let k0 = Math.hypot((p_0 / rr_0), (p_1 / rr_1), (p_2 / rr_2));
    let k1 = Math.hypot((p_0 / (rr_0 * rr_0)), (p_1 / (rr_1 * rr_1)), (p_2 / (rr_2 * rr_2)));
    if ((k1 < 1e-6)) {
      return (-Math.min(rr_0, Math.min(rr_1, rr_2)));
    }
    return ((k0 * (k0 - 1.0)) / k1);
  },
  // pPrism — from GLSL.prism.src
  prism: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let n = Math.min(Math.max(Math.floor((d_2 + 0.5)), 3.0), 12.0);
    let ang = (3.14159265359 / n);
    let R = Math.max((d_0 - (r / Math.cos(ang))), 0.0);
    let hh = Math.max(((d_1 * 0.5) - r), 0.0);
    let a = Math.atan2(p_1, p_0);
    a = (((a + ang) - (2.0 * ang)*Math.floor((a + ang)/(2.0 * ang))) - ang);
    const t0 = Math.hypot(p_0, p_1);
    let q_0 = (t0 * Math.cos(a)), q_1 = (t0 * Math.sin(a));
    let ap = (R * Math.cos(ang));
    let hl = (R * Math.sin(ang));
    let e = Math.hypot((q_0 - ap), (q_1 - Math.min(Math.max(q_1, (-hl)), hl)));
    const t1 = (q_0 < ap);
    let w_0 = (t1 ? (-e) : e), w_1 = (Math.abs(p_2) - hh);
    return ((Math.min(Math.max(w_0, w_1), 0.0) + Math.hypot(Math.max(w_0, 0.0), Math.max(w_1, 0.0))) - r);
  },
  // pPyr — from GLSL.pyramid.src
  pyramid: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let b = Math.max(d_0, 1e-4);
    let H = Math.max(d_1, 1e-4);
    let P_0 = (p_0 / b), P_1 = ((p_2 + (H * 0.5)) / b), P_2 = (p_1 / b);
    let h = (H / b);
    let m2 = ((h * h) + 0.25);
    const t0 = Math.abs(P_0), t1 = Math.abs(P_2);
    P_0 = t0;
    P_2 = t1;
    const t2 = (P_2 > P_0);
    const t3 = (t2 ? P_2 : P_0), t4 = (t2 ? P_0 : P_2);
    P_0 = t3;
    P_2 = t4;
    P_0 -= 0.5;
    P_2 -= 0.5;
    let q_0 = P_2, q_1 = ((h * P_1) - (0.5 * P_0)), q_2 = ((h * P_0) + (0.5 * P_1));
    let s = Math.max((-q_0), 0.0);
    let t = Math.min(Math.max(((q_1 - (0.5 * P_2)) / (m2 + 0.25)), 0.0), 1.0);
    let A = (((m2 * (q_0 + s)) * (q_0 + s)) + (q_1 * q_1));
    let B = (((m2 * (q_0 + (0.5 * t))) * (q_0 + (0.5 * t))) + ((q_1 - (m2 * t)) * (q_1 - (m2 * t))));
    const t5 = (Math.min(q_1, (((-q_0) * m2) - (q_1 * 0.5))) > 0.0);
    let d2 = (t5 ? 0.0 : Math.min(A, B));
    let lat = Math.sqrt(((d2 + (q_2 * q_2)) / m2));
    let e2 = (Math.hypot(Math.max(P_0, 0.0), Math.max(P_2, 0.0)) + Math.min(P_0, 0.0));
    let base = Math.hypot(Math.max(e2, 0.0), P_1);
    let m = Math.min(lat, base);
    const t6 = ((q_2 < 0.0) && (P_1 > 0.0));
    return ((t6 ? (-m) : m) * b);
  },
  // pOcta — from GLSL.octa.src
  octa: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let s = Math.max((d_0 - (r * 1.73205081)), 0.0);
    const t0 = Math.abs(p_0), t1 = Math.abs(p_1), t2 = Math.abs(p_2);
    p_0 = t0;
    p_1 = t1;
    p_2 = t2;
    let m = (((p_0 + p_1) + p_2) - s);
    let q_0, q_1, q_2;
    if (((3.0 * p_0) < m)) {
      q_0 = p_0;
      q_1 = p_1;
      q_2 = p_2;
    } else {
      if (((3.0 * p_1) < m)) {
        q_0 = p_1;
        q_1 = p_2;
        q_2 = p_0;
      } else {
        if (((3.0 * p_2) < m)) {
          q_0 = p_2;
          q_1 = p_0;
          q_2 = p_1;
        } else {
          return ((m * 0.57735027) - r);
        }
      }
    }
    let k = Math.min(Math.max((0.5 * ((q_2 - q_1) + s)), 0.0), s);
    return (Math.hypot(q_0, ((q_1 - s) + k), (q_2 - k)) - r);
  },
  // pDome — from GLSL.dome.src
  dome: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let R = Math.max(d_0, 1e-4);
    let h = Math.min(Math.max(d_1, (-R)), R);
    let w = Math.sqrt(Math.max(((R * R) - (h * h)), 0.0));
    let q_0 = Math.hypot(p_0, p_1), q_1 = p_2;
    let s = Math.max(((((h - R) * q_0) * q_0) + ((w * w) * ((h + R) - (2.0 * q_1)))), ((h * q_0) - (w * q_1)));
    const t0 = (s < 0.0);
    const t1 = (q_0 < w);
    return (t0 ? (Math.hypot(q_0, q_1) - R) : (t1 ? (h - q_1) : Math.hypot((q_0 - w), (q_1 - h))));
  },
  // pArc — from GLSL.arc.src
  arc: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let th = (Math.min(Math.max(d_2, 10.0), 360.0) * 0.00872664626);
    let sc_0 = Math.sin(th), sc_1 = Math.cos(th);
    p_0 = Math.abs(p_0);
    const t0 = ((sc_1 * p_0) > (sc_0 * p_1));
    let k = (t0 ? (p_0*sc_0 + p_1*sc_1) : Math.hypot(p_0, p_1));
    return (Math.sqrt(Math.max((((p_0*p_0 + p_1*p_1 + p_2*p_2) + (d_0 * d_0)) - ((2.0 * d_0) * k)), 0.0)) - d_1);
  },
  // pLink — from GLSL.link.src
  link: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let le = Math.max((((d_0 * 0.5) - d_1) - d_2), 0.0);
    let q_0 = p_0, q_1 = Math.max((Math.abs(p_2) - le), 0.0), q_2 = p_1;
    return (Math.hypot((Math.hypot(q_0, q_1) - d_1), q_2) - d_2);
  },
  // pPlane — from GLSL.plane.src
  plane: (p, d, r) => {
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    return p_2;
  },
};
// >>> generated twins

const PRIMS = {
  sphere: {
    name: 'Sphere', round: false,
    dims: [['Radius', 0.5, 80, 0.5]],
    def: [10, 0, 0],
    js: TWINS.sphere,
    ext: d => [d[0], d[0], d[0]]
  },
  box: {
    name: 'Box', round: true,
    dims: [['Size X', 0.5, 160, 0.5], ['Size Y', 0.5, 160, 0.5],
           ['Size Z', 0.5, 160, 0.5]],
    def: [20, 20, 20],
    js: TWINS.box,
    ext: d => [d[0] / 2, d[1] / 2, d[2] / 2]
  },
  cylinder: {
    name: 'Cylinder', round: true,
    dims: [['Radius', 0.5, 80, 0.5], ['Height', 0.5, 160, 0.5]],
    def: [10, 24, 0],
    js: TWINS.cylinder,
    ext: d => [d[0], d[0], d[1] / 2]
  },
  capsule: {
    name: 'Capsule', round: false,
    dims: [['Radius', 0.5, 60, 0.5], ['Length', 1, 200, 0.5]],
    def: [7, 40, 0],
    js: TWINS.capsule,
    ext: d => [d[0], d[0], Math.max(d[1] / 2, d[0])]
  },
  torus: {
    name: 'Torus', round: false,
    dims: [['Ring radius', 1, 80, 0.5], ['Tube radius', 0.4, 40, 0.25]],
    def: [14, 4, 0],
    js: TWINS.torus,
    ext: d => [d[0] + d[1], d[0] + d[1], d[1]]
  },
  cone: {
    name: 'Cone', round: true,
    dims: [['Base radius', 0, 80, 0.5], ['Top radius', 0, 80, 0.5],
           ['Height', 0.5, 160, 0.5]],
    def: [14, 0, 28],
    // iq's capped cone: h is the half height, r1 the -Z cap, r2 the +Z cap
    js: TWINS.cone,
    ext: d => [Math.max(d[0], d[1]), Math.max(d[0], d[1]), d[2] / 2]
  },
  ellipsoid: {
    // `exact: false` is load-bearing, not a footnote: this one's gradient
    // reaches ~1.22, so a full step of it can overshoot the surface. Whatever
    // marches this library has to scale its steps by less than 1/that, and
    // check-primitives.mjs prints the figure the whole set implies.
    name: 'Ellipsoid', round: false, exact: false,
    dims: [['Size X', 0.5, 160, 0.5], ['Size Y', 0.5, 160, 0.5],
           ['Size Z', 0.5, 160, 0.5]],
    def: [30, 18, 14],
    // iq's bound: not exact, so the marcher takes slightly shorter steps
    js: TWINS.ellipsoid,
    ext: d => [d[0] / 2, d[1] / 2, d[2] / 2]
  },
  prism: {
    // Regular n-gon extruded along Z. Folding the point into one wedge and
    // measuring to that wedge's edge segment is exact everywhere, vertices
    // included, which a max-of-half-planes would not be.
    name: 'Prism', round: true,
    dims: [['Radius', 0.5, 80, 0.5], ['Height', 0.5, 160, 0.5],
           ['Sides', 3, 12, 1, '']],
    def: [12, 24, 6],
    js: TWINS.prism,
    ext: d => [d[0], d[0], d[1] / 2]
  },
  pyramid: {
    // iq's exact pyramid is unit-base and +Y up, so the point is swizzled into
    // that frame, divided to unit base and multiplied back -- a uniform scale,
    // which is the only kind a distance survives.
    //
    // His formula measures the four lateral faces and signs the result with
    // `max(q.z, -p.y)`, which gets the sign right below the base but not the
    // magnitude: it keeps reporting the distance to the *extended* cone, so a
    // point a hair under the middle of the base comes back 10.9 mm away when
    // it is touching. Over-estimating is the direction that tunnels -- the
    // marcher takes the whole step and passes through the solid. So the base
    // is intersected in properly, as max() against its half-space.
    name: 'Pyramid', round: false,
    dims: [['Base', 0.5, 160, 0.5], ['Height', 0.5, 160, 0.5]],
    def: [24, 26, 0],
    js: TWINS.pyramid,
    ext: d => [d[0] / 2, d[0] / 2, d[1] / 2]
  },
  octa: {
    // |x|+|y|+|z| = s is the cheap bound everyone reaches for; this is iq's
    // exact form, which matters because a loose primitive shortens the step
    // for every ray in the scene, not just the ones near it.
    name: 'Octahedron', round: true,
    dims: [['Size', 0.5, 100, 0.5]],
    def: [16, 0, 0],
    js: TWINS.octa,
    ext: d => [d[0], d[0], d[0]]
  },
  dome: {
    // A sphere with everything above local z = `cut` taken off. Negative cut
    // leaves less than a hemisphere, positive more; at -radius it vanishes.
    name: 'Dome', round: false,
    dims: [['Radius', 0.5, 80, 0.5], ['Cut height', -80, 80, 0.5]],
    def: [16, 0, 0],
    js: TWINS.dome,
    ext: d => {
      const R = Math.max(d[0], 1e-4), h = Math.min(Math.max(d[1], -R), R);
      const w = h >= 0 ? R : Math.sqrt(Math.max(R * R - h * h, 0));
      return [w, w, R];
    }
  },
  arc: {
    // A torus swept through part of a turn instead of all of it -- the hinge
    // and spring shape. Opens symmetrically about local +Y.
    name: 'Arc', round: false,
    dims: [['Ring radius', 1, 80, 0.5], ['Tube radius', 0.4, 40, 0.25],
           ['Sweep', 10, 360, 5, '°']],
    def: [14, 4, 180],
    js: TWINS.arc,
    ext: d => [d[0] + d[1], d[0] + d[1], d[1]]
  },
  link: {
    // A chain link standing on end: the tube wraps a stadium in the XZ plane,
    // so the hole runs along Y and the next link threads through it.
    name: 'Link', round: false,
    dims: [['Length', 2, 120, 0.5], ['Ring radius', 0.5, 40, 0.25],
           ['Tube radius', 0.3, 20, 0.25]],
    def: [30, 6, 2.5],
    js: TWINS.link,
    ext: d => [d[1] + d[2], d[2], Math.max(d[0] / 2, d[1] + d[2])]
  },
  plane: {
    name: 'Plane cut', round: false, infinite: true,
    dims: [],
    def: [0, 0, 0],
    // solid below local +Z: as a Cut it shaves everything above the plane
    js: TWINS.plane,
    ext: () => [1e4, 1e4, 1e4]
  },
  field: {
    // `d` is the grid's half-extent in mm and `r` its quantisation range, so
    // this needs no uniform of its own beyond the texture. Outside the grid
    // the sampler clamps to the edge, which would read as solid forever, so
    // the box distance is maxed in: outside, the box wins and the marcher
    // still converges; inside, the sampled field does.
    name: 'Baked', round: false, baked: true,
    dims: [],
    def: [0, 0, 0],
    // GLSL ES 3.0 allows a sampler as a function parameter, so one function
    // serves every slot and the generated call names its slot literally.
    js: (p, d, r, n) => {
      const f = fields[(n && n.fi) || 0];
      if (!f) return 1e9;
      const q = [Math.abs(p[0]) - d[0], Math.abs(p[1]) - d[1],
                 Math.abs(p[2]) - d[2]];
      const box = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0),
                             Math.max(q[2], 0))
                + Math.min(Math.max(q[0], q[1], q[2]), 0);
      return Math.max(sampleField(f, p[0], p[1], p[2]), box);
    },
    ext: d => [d[0] || 1, d[1] || 1, d[2] || 1]
  },

  // A closed 2D outline given a thickness -- the shape a sketch turns into.
  // The outline is not in the node: it is in `profiles`, and `fi` says which,
  // exactly as a baked field works. What the node carries is the half-extent
  // of the outline and half the thickness, because that is what bounds are
  // computed from.
  //
  // No rounding: the outline already says what its corners do. Rotating the
  // node is what puts the extrusion somewhere other than up the Z axis, which
  // is how a face found in a tilted plane arrives here.
  profile: {
    name: 'Profile', round: false, baked: true,
    dims: [['Half width', 0.5, 200, 0.5], ['Half depth', 0.5, 200, 0.5],
           ['Half height', 0.25, 100, 0.25]],
    def: [20, 20, 6],
    js: (p, d, r, n) => {
      const pr = profiles[(n && n.fi) || 0];
      if (!pr || !pr.loops) return 1e9;
      const a = polygonSDF(pr.loops, p[0], p[1]);
      const b = Math.abs(p[2]) - d[2];
      return Math.min(Math.max(a, b), 0)
           + Math.hypot(Math.max(a, 0), Math.max(b, 0));
    },
    ext: d => [d[0] || 1, d[1] || 1, d[2] || 1]
  }
};
const PRIM_KEYS = Object.keys(PRIMS);
const OPS = [['add', 'Add'], ['cut', 'Cut'], ['keep', 'Keep']];

// A dim entry is [label, min, max, step, unit?]. No unit means millimetres,
// and millimetres are the only thing that may be scaled: multiplying a shape
// by 1.5 has to leave a hexagon a hexagon and a 90° arc a 90° arc. Consumers
// ask here rather than each keeping their own list of exceptions.
function dimIsLength(t, i) {
  const dim = PRIMS[t] && PRIMS[t].dims[i];
  return !!dim && dim[4] === undefined;
}
function dimUnit(t, i) {
  const dim = PRIMS[t] && PRIMS[t].dims[i];
  return dim && dim[4] !== undefined ? dim[4] : ' mm';
}

function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.min(Math.max(0.5 + 0.5 * (b - a) / k, 0), 1);
  return b + (a - b) * h - k * h * (1 - h);
}
function smax(a, b, k) {
  if (k <= 0) return Math.max(a, b);
  const h = Math.min(Math.max(0.5 - 0.5 * (b - a) / k, 0), 1);
  return b + (a - b) * h + k * h * (1 - h);
}
// world -> local: the shape is rotated by Rz*Ry*Rx, so undo it in reverse
function invRot(x, y, z, e, out) {
  let c = Math.cos(e[2]), s = Math.sin(e[2]);
  let X = c * x + s * y, Y = -s * x + c * y, Z = z;
  c = Math.cos(e[1]); s = Math.sin(e[1]);
  let X2 = c * X - s * Z; Z = s * X + c * Z; X = X2;
  c = Math.cos(e[0]); s = Math.sin(e[0]);
  const Y2 = c * Y + s * Z; Z = -s * Y + c * Z; Y = Y2;
  out[0] = X; out[1] = Y; out[2] = Z;
  return out;
}
const RAD = Math.PI / 180;

// The JS twin of the generated shader. Same order, same math. Takes a plan
// (see buildPlan): each body folds on its own running distance, and the
// bodies meet in a plain min so nothing blends across the boundary.
function sceneSDF(plan, x, y, z) {
  let out = 1e9;
  const q = [0, 0, 0], e = [0, 0, 0];
  for (let g = 0; g < plan.length; g++) {
    const list = plan[g].nodes;
    let d = 1e9;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      let px = n.mx ? Math.abs(x) : x;
      let py = n.my ? Math.abs(y) : y;
      let pz = n.mz ? Math.abs(z) : z;
      e[0] = n.r[0] * RAD; e[1] = n.r[1] * RAD; e[2] = n.r[2] * RAD;
      invRot(px - n.p[0], py - n.p[1], pz - n.p[2], e, q);
      const di = PRIMS[n.t].js(q, n.d, n.round || 0, n);
      if (n.op === 'add') d = smin(d, di, n.k);
      else if (n.op === 'cut') d = smax(d, -di, n.k);
      else d = smax(d, di, n.k);
    }
    if (d < out) out = d;
  }
  return out;
}

// ---------- axis-aligned bounds of everything that adds material ----------
function sceneBounds(nodes) {
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], any = false;
  const e = [0, 0, 0], q = [0, 0, 0];
  for (const n of nodes) {
    if (!n.on || n.op !== 'add' || PRIMS[n.t].infinite) continue;
    any = true;
    const h = PRIMS[n.t].ext(n.d);
    const pad = (n.round || 0) + n.k;
    e[0] = n.r[0] * RAD; e[1] = n.r[1] * RAD; e[2] = n.r[2] * RAD;
    const c = [Math.cos(e[0]), Math.cos(e[1]), Math.cos(e[2])];
    const s = [Math.sin(e[0]), Math.sin(e[1]), Math.sin(e[2])];
    // R = Rz*Ry*Rx applied to each corner of the local box
    const rot = (v, o) => {
      let x = v[0], y = c[0] * v[1] - s[0] * v[2], z = s[0] * v[1] + c[0] * v[2];
      let x2 = c[1] * x + s[1] * z; z = -s[1] * x + c[1] * z; x = x2;
      o[0] = c[2] * x - s[2] * y; o[1] = s[2] * x + c[2] * y; o[2] = z;
    };
    for (let cx = -1; cx <= 1; cx += 2)
      for (let cy = -1; cy <= 1; cy += 2)
        for (let cz = -1; cz <= 1; cz += 2) {
          rot([cx * (h[0] + pad), cy * (h[1] + pad), cz * (h[2] + pad)], q);
          for (const m of (n.mx ? [1, -1] : [1]))
            for (const my of (n.my ? [1, -1] : [1]))
              for (const mz of (n.mz ? [1, -1] : [1])) {
                const P = [m * (q[0] + n.p[0]), my * (q[1] + n.p[1]),
                           mz * (q[2] + n.p[2])];
                for (let a = 0; a < 3; a++) {
                  if (P[a] < lo[a]) lo[a] = P[a];
                  if (P[a] > hi[a]) hi[a] = P[a];
                }
              }
        }
  }
  if (!any) return null;
  return { lo, hi };
}

// ======================================================================
// surface nets — the same mesher the flexi fish tools use
// ======================================================================
function surfaceNets(vol, nx, ny, nz, ox, oy, oz, res) {
  // cell -> vertex map kept sparse: at print resolution the dense array
  // would cost hundreds of MB, crossing cells are ~1% of the grid
  const YZ = ny * nz, cellIdx = new Map();
  const verts = [];
  const CI = (i, j, k) => (i * (ny - 1) + j) * (nz - 1) + k;
  const V = (i, j, k) => vol[i * YZ + j * nz + k];
  const CG = key => { const v = cellIdx.get(key); return v === undefined ? -1 : v; };
  const E = [
    [0,0,0, 1,0,0],[0,1,0, 1,1,0],[0,0,1, 1,0,1],[0,1,1, 1,1,1],
    [0,0,0, 0,1,0],[1,0,0, 1,1,0],[0,0,1, 0,1,1],[1,0,1, 1,1,1],
    [0,0,0, 0,0,1],[1,0,0, 1,0,1],[0,1,0, 0,1,1],[1,1,0, 1,1,1]];
  for (let i = 0; i < nx - 1; i++)
    for (let j = 0; j < ny - 1; j++)
      for (let k = 0; k < nz - 1; k++) {
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let e = 0; e < 12; e++) {
          const q = E[e];
          const a = V(i + q[0], j + q[1], k + q[2]);
          const b = V(i + q[3], j + q[4], k + q[5]);
          if ((a < 0) !== (b < 0)) {
            const t = a / (a - b);
            sx += q[0] + (q[3] - q[0]) * t;
            sy += q[1] + (q[4] - q[1]) * t;
            sz += q[2] + (q[5] - q[2]) * t;
            cnt++;
          }
        }
        if (cnt) {
          cellIdx.set(CI(i, j, k), verts.length / 3);
          verts.push(ox + (i + sx / cnt) * res,
                     oy + (j + sy / cnt) * res,
                     oz + (k + sz / cnt) * res);
        }
      }
  const tris = [];
  // Wound so that cross(b - a, c - a) points *out* of the solid, which is what
  // the STL format means by a facet normal and what anything shading or
  // back-face culling this mesh will assume. It used to come out the other way
  // round on every triangle: slicers flood-fill orientation themselves so the
  // prints were fine, and the viewer lit every surface from the wrong side
  // without ever looking obviously broken. `flip` follows the sign of the
  // sample the crossing edge leaves behind.
  function quad(a, b, c, d2, flip) {
    if (a < 0 || b < 0 || c < 0 || d2 < 0) return;
    if (flip) tris.push(a, b, c, a, c, d2); else tris.push(a, c, b, a, d2, c);
  }
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++) {
        const v0 = V(i, j, k);
        if (i < nx - 1 && j > 0 && k > 0) {
          const v1 = V(i + 1, j, k);
          if ((v0 < 0) !== (v1 < 0))
            quad(CG(CI(i, j - 1, k - 1)), CG(CI(i, j, k - 1)),
                 CG(CI(i, j, k)), CG(CI(i, j - 1, k)), v0 < 0);
        }
        if (j < ny - 1 && i > 0 && k > 0) {
          const v1 = V(i, j + 1, k);
          if ((v0 < 0) !== (v1 < 0))
            quad(CG(CI(i - 1, j, k - 1)), CG(CI(i - 1, j, k)),
                 CG(CI(i, j, k)), CG(CI(i, j, k - 1)), v0 < 0);
        }
        if (k < nz - 1 && i > 0 && j > 0) {
          const v1 = V(i, j, k + 1);
          if ((v0 < 0) !== (v1 < 0))
            quad(CG(CI(i - 1, j - 1, k)), CG(CI(i, j - 1, k)),
                 CG(CI(i, j, k)), CG(CI(i - 1, j, k)), v0 < 0);
        }
      }
  return { positions: new Float32Array(verts), indices: new Uint32Array(tris) };
}

function meshToSTL(m, header) {
  const nt = m.indices.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  for (let i = 0; i < Math.min(80, header.length); i++)
    dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nt, true);
  const P = m.positions, I = m.indices;
  let o = 84;
  for (let t = 0; t < nt; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / nl, true); dv.setFloat32(o + 4, ny / nl, true);
    dv.setFloat32(o + 8, nz / nl, true); o += 12;
    for (const vi of [a, b, c]) {
      dv.setFloat32(o, P[vi], true);
      dv.setFloat32(o + 4, P[vi + 1], true);
      dv.setFloat32(o + 8, P[vi + 2], true); o += 12;
    }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}

// ----------------------------------------------------------------------
// The public surface.
//
// `fields` is a live accessor rather than a plain value: it is the baked
// field library, the kernel reads it when evaluating a `field` primitive,
// and the application replaces the whole array on load and on import. A
// copied reference would leave the two looking at different arrays, and the
// symptom would be a baked shape that renders as the one you opened before.
// ----------------------------------------------------------------------
const SinterForm = {
  PRIMS, PRIM_KEYS, OPS, RAD, dimIsLength, dimUnit,
  get fields() { return fields; },
  set fields(v) { fields = v; },
  get profiles() { return profiles; },
  set profiles(v) { profiles = v; },
  decodeField, encodeField, sampleField,
  polygonSDF, profileExtent,
  smin, smax, invRot,
  sceneSDF, sceneBounds, surfaceNets, meshToSTL
};
if (typeof module !== 'undefined' && module.exports) module.exports = SinterForm;
root.SinterForm = SinterForm;
})(typeof self !== 'undefined' ? self : globalThis);
