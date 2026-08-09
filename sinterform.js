/* SinterForm - a signed-distance geometry kernel
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * Primitives, boolean operations with smooth blends, bodies, baked distance
 * fields, GLSL sources for a raymarcher, a surface-nets mesher and binary STL
 * output. No DOM, no WebGL, no storage: it computes geometry and hands it
 * back. That is what makes it liftable into its own repository, and what
 * keeps it usable from node -- which is how it gets tested.
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
// SDF core — every primitive is written twice, GLSL for the live preview
// and JS for the mesher. They sit side by side so they stay in step.
// Units are millimeters, +Z is up, z = 0 is the build plate.
// ======================================================================
const MAXN = 32;                      // uniform slots: 3 vec4 per shape

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
const MAXFIELDS = 4;     // one 3D texture each; the shader declares this many
let fields = [];         // [{ name, nx, ny, nz, box:[hx,hy,hz], range, data, tex }]

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

const PRIMS = {
  sphere: {
    name: 'Sphere', fn: 'pSphere', round: false,
    dims: [['Radius', 0.5, 80, 0.5]],
    def: [10, 0, 0],
    glsl: 'float pSphere(vec3 p, vec3 d, float r){ return length(p)-d.x; }',
    js: (p, d) => Math.hypot(p[0], p[1], p[2]) - d[0],
    ext: d => [d[0], d[0], d[0]]
  },
  box: {
    name: 'Box', fn: 'pBox', round: true,
    dims: [['Size X', 0.5, 160, 0.5], ['Size Y', 0.5, 160, 0.5],
           ['Size Z', 0.5, 160, 0.5]],
    def: [20, 20, 20],
    glsl: `float pBox(vec3 p, vec3 d, float r){
  vec3 b = max(d*0.5 - r, vec3(0.0));
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}`,
    js: (p, d, r) => {
      const b = [Math.max(d[0] * .5 - r, 0), Math.max(d[1] * .5 - r, 0),
                 Math.max(d[2] * .5 - r, 0)];
      const q = [Math.abs(p[0]) - b[0], Math.abs(p[1]) - b[1],
                 Math.abs(p[2]) - b[2]];
      const o = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
      return o + Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0) - r;
    },
    ext: d => [d[0] / 2, d[1] / 2, d[2] / 2]
  },
  cylinder: {
    name: 'Cylinder', fn: 'pCyl', round: true,
    dims: [['Radius', 0.5, 80, 0.5], ['Height', 0.5, 160, 0.5]],
    def: [10, 24, 0],
    glsl: `float pCyl(vec3 p, vec3 d, float r){
  float rr = max(d.x - r, 0.0), hh = max(d.y*0.5 - r, 0.0);
  vec2 q = vec2(length(p.xy) - rr, abs(p.z) - hh);
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}`,
    js: (p, d, r) => {
      const rr = Math.max(d[0] - r, 0), hh = Math.max(d[1] * .5 - r, 0);
      const qx = Math.hypot(p[0], p[1]) - rr, qy = Math.abs(p[2]) - hh;
      return Math.min(Math.max(qx, qy), 0) +
             Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
    },
    ext: d => [d[0], d[0], d[1] / 2]
  },
  capsule: {
    name: 'Capsule', fn: 'pCap', round: false,
    dims: [['Radius', 0.5, 60, 0.5], ['Length', 1, 200, 0.5]],
    def: [7, 40, 0],
    glsl: `float pCap(vec3 p, vec3 d, float r){
  float hh = max(d.y*0.5 - d.x, 0.0);
  vec3 q = vec3(p.x, p.y, p.z - clamp(p.z, -hh, hh));
  return length(q) - d.x;
}`,
    js: (p, d) => {
      const hh = Math.max(d[1] * .5 - d[0], 0);
      const z = p[2] - Math.min(Math.max(p[2], -hh), hh);
      return Math.hypot(p[0], p[1], z) - d[0];
    },
    ext: d => [d[0], d[0], Math.max(d[1] / 2, d[0])]
  },
  torus: {
    name: 'Torus', fn: 'pTorus', round: false,
    dims: [['Ring radius', 1, 80, 0.5], ['Tube radius', 0.4, 40, 0.25]],
    def: [14, 4, 0],
    glsl: `float pTorus(vec3 p, vec3 d, float r){
  vec2 q = vec2(length(p.xy) - d.x, p.z);
  return length(q) - d.y;
}`,
    js: (p, d) => Math.hypot(Math.hypot(p[0], p[1]) - d[0], p[2]) - d[1],
    ext: d => [d[0] + d[1], d[0] + d[1], d[1]]
  },
  cone: {
    name: 'Cone', fn: 'pCone', round: true,
    dims: [['Base radius', 0, 80, 0.5], ['Top radius', 0, 80, 0.5],
           ['Height', 0.5, 160, 0.5]],
    def: [14, 0, 28],
    // iq's capped cone: h is the half height, r1 the -Z cap, r2 the +Z cap
    glsl: `float pCone(vec3 p, vec3 d, float r){
  float r1 = max(d.x - r, 0.0), r2 = max(d.y - r, 0.0);
  float h = max(d.z*0.5 - r, 0.0);
  vec2 q = vec2(length(p.xy), p.z);
  vec2 k1 = vec2(r2, h);
  vec2 k2 = vec2(r2 - r1, 2.0*h);
  vec2 ca = vec2(q.x - min(q.x, (q.y < 0.0) ? r1 : r2), abs(q.y) - h);
  vec2 cb = q - k1 + k2*clamp(dot(k1 - q, k2)/dot(k2, k2), 0.0, 1.0);
  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
  return s*sqrt(min(dot(ca, ca), dot(cb, cb))) - r;
}`,
    js: (p, d, r) => {
      const r1 = Math.max(d[0] - r, 0), r2 = Math.max(d[1] - r, 0);
      const h = Math.max(d[2] * .5 - r, 0);
      const qx = Math.hypot(p[0], p[1]), qy = p[2];
      const k1x = r2, k1y = h, k2x = r2 - r1, k2y = 2 * h;
      const cax = qx - Math.min(qx, qy < 0 ? r1 : r2), cay = Math.abs(qy) - h;
      const kk = k2x * k2x + k2y * k2y || 1e-9;
      const t = Math.min(Math.max(((k1x - qx) * k2x + (k1y - qy) * k2y) / kk, 0), 1);
      const cbx = qx - k1x + k2x * t, cby = qy - k1y + k2y * t;
      const s = (cbx < 0 && cay < 0) ? -1 : 1;
      return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby)) - r;
    },
    ext: d => [Math.max(d[0], d[1]), Math.max(d[0], d[1]), d[2] / 2]
  },
  ellipsoid: {
    name: 'Ellipsoid', fn: 'pEllip', round: false,
    dims: [['Size X', 0.5, 160, 0.5], ['Size Y', 0.5, 160, 0.5],
           ['Size Z', 0.5, 160, 0.5]],
    def: [30, 18, 14],
    // iq's bound: not exact, so the marcher takes slightly shorter steps
    glsl: `float pEllip(vec3 p, vec3 d, float r){
  vec3 rr = max(d*0.5, vec3(1e-3));
  float k0 = length(p/rr);
  float k1 = length(p/(rr*rr));
  if (k1 < 1e-6) return -min(rr.x, min(rr.y, rr.z));
  return k0*(k0 - 1.0)/k1;
}`,
    js: (p, d) => {
      const rx = Math.max(d[0] * .5, 1e-3), ry = Math.max(d[1] * .5, 1e-3),
            rz = Math.max(d[2] * .5, 1e-3);
      const k0 = Math.hypot(p[0] / rx, p[1] / ry, p[2] / rz);
      const k1 = Math.hypot(p[0] / (rx * rx), p[1] / (ry * ry), p[2] / (rz * rz));
      if (k1 < 1e-6) return -Math.min(rx, ry, rz);
      return k0 * (k0 - 1) / k1;
    },
    ext: d => [d[0] / 2, d[1] / 2, d[2] / 2]
  },
  plane: {
    name: 'Plane cut', fn: 'pPlane', round: false, infinite: true,
    dims: [],
    def: [0, 0, 0],
    // solid below local +Z: as a Cut it shaves everything above the plane
    glsl: 'float pPlane(vec3 p, vec3 d, float r){ return p.z; }',
    js: p => p[2],
    ext: () => [1e4, 1e4, 1e4]
  },
  field: {
    // `d` is the grid's half-extent in mm and `r` its quantisation range, so
    // this needs no uniform of its own beyond the texture. Outside the grid
    // the sampler clamps to the edge, which would read as solid forever, so
    // the box distance is maxed in: outside, the box wins and the marcher
    // still converges; inside, the sampled field does.
    name: 'Baked', fn: 'pFieldS', round: false, baked: true,
    dims: [],
    def: [0, 0, 0],
    // GLSL ES 3.0 allows a sampler as a function parameter, so one function
    // serves every slot and the generated call names its slot literally.
    glsl: `float pFieldS(sampler3D s, vec3 p, vec3 d, float r){
  vec3 q = abs(p) - d;
  float box = length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
  if (d.x <= 0.0) return 1e9;
  // the grid is stored with z fastest, so the texture is nz wide by ny by nx
  // and the lookup is (z, y, x), not (x, y, z)
  vec3 uvw = (p + d)/(2.0*d);
  float v = (texture(s, clamp(uvw.zyx, 0.0, 1.0)).r*2.0 - 1.0)*r;
  return max(v, box);
}`,
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
  }
};
const PRIM_KEYS = Object.keys(PRIMS);
const OPS = [['add', 'Add'], ['cut', 'Cut'], ['keep', 'Keep']];

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
  function quad(a, b, c, d2, flip) {
    if (a < 0 || b < 0 || c < 0 || d2 < 0) return;
    if (flip) tris.push(a, c, b, a, d2, c); else tris.push(a, b, c, a, c, d2);
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
  MAXN, MAXFIELDS, PRIMS, PRIM_KEYS, OPS, RAD,
  get fields() { return fields; },
  set fields(v) { fields = v; },
  decodeField, encodeField, sampleField,
  smin, smax, invRot,
  sceneSDF, sceneBounds, surfaceNets, meshToSTL
};
if (typeof module !== 'undefined' && module.exports) module.exports = SinterForm;
root.SinterForm = SinterForm;
})(typeof self !== 'undefined' ? self : globalThis);
