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

// Wires, the third of the same idea: a shape that is a *path* rather than an
// area or a volume. A drawn curve has no interior, so the only solid it stands
// for is the one you get by giving it a thickness -- and that thickness may
// vary as it goes, which is what the fourth number on each point is for.
//
// [x, y, z, r] per point, one polyline per entry of `lines`, so a wire can be
// several disjoint curves. Like fields and profiles, it lives on the document
// and a node of type `wire` refers to one by index.
let wires = [];          // [{ name, lines: [[[x, y, z, r], ...], ...] }]

// Sweeps: a section dragged along a path. The largest of the document shapes,
// and the only one whose items are not raw geometry -- each is a path segment
// carrying the frame, span, scale, roll, caps and turn that sweep.js worked
// out for it. `SinterSweep.pack()` builds them; this file only evaluates.
let sweeps = [];         // [{ name, segs: Float64Array, kind, sect: [a, b, c] }]

// Constructs: masses hung on a skeleton of connectors. Like a sweep's, the
// items are not raw geometry -- each carries the frame `SinterConstruct.pack()`
// resolved for it by walking the connector tree, so this file evaluates a flat
// list and never sees a hierarchy. That is what makes a pose cheap: the tree is
// walked once per repack, not once per sample.
let constructs = [];     // [{ name, items: Float64Array }]

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

// ----------------------------------------------------------------------
// The seam: the JS half of the intrinsics build-twins.mjs binds.
//
// Every primitive is defined once, in GLSL, and translated into the JS twins
// below. Two of them read data rather than computing from their dims, and the
// read is the one thing a shader and JavaScript genuinely do differently: the
// shader asks a sampler or reads an outline compiled into its own source, and
// JavaScript indexes an array. These functions are that difference, and there
// is nothing else in it -- the box union, the slab, the crossing count and the
// nearest-edge search are all translated.
// ----------------------------------------------------------------------

// An outline with no data still has to be a shape, because a node can name a
// profile slot before the application has put anything in it -- and a
// primitive that evaluates to nothing is a primitive nobody can see to fix. So
// an empty slot is a 20 x 20 mm square, which is also what makes `profile`
// appear in the viewer's every-primitive scene with no setup at all.
const DEFAULT_OUTLINE = [[[-10, -10], [10, -10], [10, 10], [-10, 10]]];

// A wire with nothing in it is still a shape, same reasoning as the profile's
// default square: a node can name a slot the application has not filled yet.
// A 20 mm run at 2 mm radius, tapering to 1, so the default shows that the
// thickness varies rather than hiding it.
const DEFAULT_WIRE = [[[-10, 0, 0, 2], [10, 0, 0, 1]]];

// The segments of a wire, flattened across its polylines and cached on it:
// eight numbers each -- ax, ay, az, ra, bx, by, bz, rb. Zero-length segments
// are dropped here rather than guarded for in the shader.
function wireSegments(w) {
  const lines = (w && w.lines && w.lines.some(l => l && l.length >= 2))
    ? w.lines : DEFAULT_WIRE;
  if (w && w._segSrc === lines) return w._segs;
  const e = [];
  for (const line of lines) {
    if (!line || line.length < 2) continue;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) < 1e-12) continue;
      // laid out in the order the primitive's intrinsics are declared --
      // segA, segB, segR -- because that is the order slotItems hands to the
      // unroller, and one layout serving both is what keeps them in step
      e.push(a[0], a[1], a[2], b[0], b[1], b[2],
             a[3] === undefined ? 1 : a[3], b[3] === undefined ? 1 : b[3]);
    }
  }
  if (w) { w._segSrc = lines; w._segs = e; }
  return e;
}
// The reads themselves, on the flat array above. A twin is handed that array
// once, when the primitive is entered -- the same thing the shader is handed,
// which has its items compiled in before it runs -- so these are an index and
// nothing else. Resolving the slot inside each read instead put the default
// lookup and the cache check on the hottest path in the kernel.
function segCount(e) { return e.length / 8; }
function segAx(e, i) { return e[8 * i]; }
function segAy(e, i) { return e[8 * i + 1]; }
function segAz(e, i) { return e[8 * i + 2]; }
function segBx(e, i) { return e[8 * i + 3]; }
function segBy(e, i) { return e[8 * i + 4]; }
function segBz(e, i) { return e[8 * i + 5]; }
function segRA(e, i) { return e[8 * i + 6]; }
function segRB(e, i) { return e[8 * i + 7]; }

// The item data for a slotted primitive, flat, in the order that primitive's
// intrinsics are declared -- which is the order the generated unroller reads
// them back in. This is the kernel's half of drawing a slotted shape: it
// constructs the data, and glsl.js turns data into source. An absent entry
// gets the primitive's default, so an empty slot is a shape rather than a
// compile error, and the default is written down once, here.
// A sweep's items come pre-packed, because building them needs parallel
// transport, holonomy and the corner axis -- construction that belongs to
// sweep.js and not to an evaluator. An empty slot is a plain straight run, so
// the primitive still draws something before an application feeds it.
const SWEEP_STRIDE = 32;
const DEFAULT_SWEEP = (() => {
  const L = 20, e = new Float64Array(SWEEP_STRIDE);
  e[0] = -10; e[3] = 1;                       // A, T = +x
  e[6] = L; e[7] = 1; e[8] = 1;               // span, scale 1 -> 1
  e[10] = 1;                                  // no roll, taper 1, nothing to reach
  e[12] = 3;                                  // cull radius: the section's own
  e[14] = 1; e[18] = 1;                       // U = +y, V = +z
  e[20] = 1;                                  // turn axis, unused: no join here
  e[25] = 1; e[26] = 1;                       // capped both ends, no rounded joint
  e[29] = 3;                                  // kind 0, circle, r = 3
  return e;
})();
function sweepSegs(w) {
  const s = w && w.segs;
  return (s && s.length >= SWEEP_STRIDE) ? s : DEFAULT_SWEEP;
}
function swCount(e) { return Math.floor(e.length / SWEEP_STRIDE); }
function swf(e, i, k) { return e[SWEEP_STRIDE * i + k]; }

// A construct's items come pre-packed too, and for a sharper version of the
// same reason: building them means walking a connector tree and composing each
// joint's rotation down the chain, which is construction and belongs to
// construct.js. What arrives here is flat -- one mass per item, carrying the
// frame already resolved and already inverted, so evaluating it is arithmetic
// and nothing else.
//
//   0..2 cull centre   3 cull radius   4..6 origin
//   7..9 inverse rotation, imaginary   10 its real part
//   11..13 dims        14..16 kind, tip, blend
const CON_STRIDE = 17;

// An empty slot is a shape, same rule as the wire's tapered run and the
// profile's square: a node can name a construct the application has not filled
// in, and a primitive that draws nothing is a primitive nobody can see to fix.
//
// This one is a small armature rather than a single mass, because what a
// construct *is* -- masses on a skeleton, blended where they meet -- is not
// visible in one of anything. It uses all four kinds and one connector turned
// off-axis, so the default is also the case that would catch a broken
// quaternion, a broken cull or a broken kind dispatch the moment anybody
// looked at the viewer's every-primitive scene.
const DEFAULT_CONSTRUCT = (() => {
  const e = [];
  // cx, cy, cz, cull radius, ox, oy, oz, inverse quaternion (x, y, z, w),
  // dims, kind, tip, blend -- the layout above, written the way it is read
  const put = (c, cr, o, q, dm, kind, tip, k) =>
    e.push(c[0], c[1], c[2], cr + k, o[0], o[1], o[2], q[0], q[1], q[2], q[3],
           dm[0], dm[1], dm[2], kind, tip, k);
  const I = [0, 0, 0, 1];
  // a turn of `a` degrees about +Y, inverted: the arms, and the only thing
  // here that is not axis-aligned
  const rad = Math.PI / 180;             // RAD itself is declared further down
  const armQ = (a) => {
    const h = a * rad * 0.5;
    return [0, -Math.sin(h), 0, Math.cos(h)];
  };
  const armDir = (a) => [Math.sin(a * rad), 0, Math.cos(a * rad)];
  put([0, 0, -4], 14, [0, 0, -14], I, [4, 1, 20], 0, 3, 0);        // spine
  put([0, 0, -2], 8, [0, 0, -2], I, [7, 5, 8], 1, 0, 3);           // chest
  put([0, 0, 11], 5, [0, 0, 11], I, [5, 0, 0], 2, 0, 2.5);         // head
  put([0, -1, -19], Math.hypot(5, 7, 2.5), [0, -1, -19], I,
      [5, 7, 2.5], 3, 1.2, 2);                                     // base
  // the arms are elliptical in section -- flattened in y, which the arms' own
  // rotation leaves along the world's y -- so the default exercises that too
  for (const a of [50, -50]) {
    const u = armDir(a);
    put([7 * u[0], 0, 4 + 7 * u[2]], 9.2, [0, 0, 4], armQ(a), [2.2, 0.6, 14], 0, 1.4, 2);
  }
  return Float64Array.from(e);
})();
function conItems(c) {
  const it = c && c.items;
  return (it && it.length >= CON_STRIDE) ? it : DEFAULT_CONSTRUCT;
}
function conCount(e) { return Math.floor(e.length / CON_STRIDE); }
function conf(e, i, k) { return e[CON_STRIDE * i + k]; }

// The JS half of the sweep's polygon-section hook: a slot number and a point
// in the section plane. Same outlines, same polygonSDF, same default -- a
// sweep's section is a 2D sketch and nothing else.
function sectionPoly(slot, u, v) {
  const pr = profiles[Math.max(slot | 0, 0)];
  const loops = (pr && pr.loops && pr.loops.some(l => l && l.length >= 3))
    ? pr.loops : DEFAULT_OUTLINE;
  return polygonSDF(loops, u, v);
}

function slotItems(t, obj) {
  if (t === 'wire') return wireSegments(obj);
  if (t === 'profile') return outlineEdges(obj);
  if (t === 'sweep') return sweepSegs(obj);
  if (t === 'construct') return conItems(obj);
  throw new Error('not a slotted primitive: ' + t);
}

// `count` slots' worth, which is what a shader needs: a node may name a slot
// the document has not filled in, and every named slot must exist as a
// function. Absent entries come back as the primitive's default rather than as
// nothing, so an unfilled slot draws a shape instead of failing to compile.
function slotList(t, list, count) {
  const n = Math.max(count | 0, (list || []).length, 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(slotItems(t, (list || [])[i]));
  return out;
}

// Half-extents of a wire, each point expanded by its own radius. Tight: the
// furthest reach along any axis is attained at some point plus its radius.
function wireExtent(lines) {
  const e = wireSegments({ lines });
  let h = [0, 0, 0];
  for (let i = 0; i < e.length; i += 8)
    for (const [o, r] of [[0, e[i + 6]], [3, e[i + 7]]])
      for (let k = 0; k < 3; k++) h[k] = Math.max(h[k], Math.abs(e[i + o + k]) + r);
  return h;
}

// The edges of an outline, flattened across its loops and cached on it: each
// entry is Ax, Ay, Bx, By, where B is the *previous* vertex, matching the
// pairing polygonSDF walks and the one profileDecls unrolls.
function outlineEdges(o) {
  const loops = (o && o.loops && o.loops.some(l => l && l.length >= 3))
    ? o.loops : DEFAULT_OUTLINE;
  if (o && o._edgeSrc === loops) return o._edges;
  const e = [];
  for (const poly of loops) {
    if (!poly || poly.length < 3) continue;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++)
      e.push(poly[a][0], poly[a][1], poly[b][0], poly[b][1]);
  }
  if (o) { o._edgeSrc = loops; o._edges = e; }
  return e;
}
function edgeCount(e) { return e.length / 4; }
function edgeAx(e, i) { return e[4 * i]; }
function edgeAy(e, i) { return e[4 * i + 1]; }
function edgeBx(e, i) { return e[4 * i + 2]; }
function edgeBy(e, i) { return e[4 * i + 3]; }

// What `texture()` does to a field, in JavaScript. `u`, `v`, `w` are the
// texture's own coordinates in its own order -- z, y, x -- and the result is
// the raw sample in 0..1, the way GLSL hands back an R8 texel. Samples sit on
// the grid corners, spanning the box exactly, which is what every baker here
// writes; the shader's half-texel correction is in `fieldSample`.
function sampleFieldUVW(f, u, v, w) {
  if (!f || !f.data) return 0.5;              // 0.5 -> zero mm after decoding
  const cl = (t, n) => Math.min(Math.max(t, 0), n - 1);
  const gz = cl(u * (f.nz - 1), f.nz);
  const gy = cl(v * (f.ny - 1), f.ny);
  const gx = cl(w * (f.nx - 1), f.nx);
  const x0 = Math.floor(gx), y0 = Math.floor(gy), z0 = Math.floor(gz);
  const x1 = Math.min(x0 + 1, f.nx - 1), y1 = Math.min(y0 + 1, f.ny - 1),
        z1 = Math.min(z0 + 1, f.nz - 1);
  const tx = gx - x0, ty = gy - y0, tz = gz - z0;
  const at = (i, j, k) => f.data[(i * f.ny + j) * f.nz + k];
  const lerp = (a, b, t) => a + (b - a) * t;
  const c00 = lerp(at(x0, y0, z0), at(x1, y0, z0), tx);
  const c10 = lerp(at(x0, y1, z0), at(x1, y1, z0), tx);
  const c01 = lerp(at(x0, y0, z1), at(x1, y0, z1), tx);
  const c11 = lerp(at(x0, y1, z1), at(x1, y1, z1), tx);
  return lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz) / 255;
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
// ---------------------------------------------------------------------------
// smin — from GLSL.FOLD
function smin(a, b, k) {
    if ((k <= 0.0)) {
      return Math.min(a, b);
    }
    let h = Math.min(Math.max((0.5 + ((0.5 * (b - a)) / k)), 0.0), 1.0);
    return ((b + (a - b)*h) - ((k * h) * (1.0 - h)));
}
// smax — from GLSL.FOLD
function smax(a, b, k) {
    return (-smin((-a), (-b), k));
}

// sweepSection — from GLSL.sweep.src
function sweepSection(kind, sp_0, sp_1, sp_2, u, v) {
    if ((kind < 0.5)) {
      return (Math.hypot(u, v) - sp_0);
    }
    if ((kind < 1.5)) {
      let hw = Math.max(((sp_0 * 0.5) - sp_2), 0.0);
      let hh = Math.max(((sp_1 * 0.5) - sp_2), 0.0);
      let qu = (Math.abs(u) - hw);
      let qv = (Math.abs(v) - hh);
      return ((Math.hypot(Math.max(qu, 0.0), Math.max(qv, 0.0)) + Math.min(Math.max(qu, qv), 0.0)) - sp_2);
    }
    if ((kind < 2.5)) {
      return Math.max((Math.hypot(u, v) - sp_0), (-v));
    }
    return sectionPoly(sp_0, u, v);
}
// constructMass — from GLSL.construct.src
function constructMass(kind, q_0, q_1, q_2, dm_0, dm_1, dm_2, tip) {
    if ((kind < 0.5)) {
      let r0 = dm_0;
      let h = dm_2;
      let asp = Math.max(dm_1, 1e-4);
      let e_0 = q_0, e_1 = (q_1 / asp), e_2 = q_2;
      let m = Math.min(asp, 1.0);
      let sl = ((r0 - tip) / h);
      let a2 = (1.0 - (sl * sl));
      if ((a2 <= 0.0)) {
        return (Math.min((Math.hypot(e_0, e_1, e_2) - r0), (Math.hypot((e_0 - 0.0), (e_1 - 0.0), (e_2 - h)) - tip)) * m);
      }
      let a = Math.sqrt(a2);
      let w_0 = Math.hypot(e_0, e_1), w_1 = e_2;
      let t = (w_0*(-sl) + w_1*a);
      if ((t < 0.0)) {
        return ((Math.hypot(w_0, w_1) - r0) * m);
      }
      if ((t > (a * h))) {
        return ((Math.hypot((w_0 - 0.0), (w_1 - h)) - tip) * m);
      }
      return (((w_0*a + w_1*sl) - r0) * m);
    }
    if ((kind < 1.5)) {
      let rr_0 = Math.max(dm_0, 1e-3), rr_1 = Math.max(dm_1, 1e-3), rr_2 = Math.max(dm_2, 1e-3);
      let k0 = Math.hypot((q_0 / rr_0), (q_1 / rr_1), (q_2 / rr_2));
      let k1 = Math.hypot((q_0 / (rr_0 * rr_0)), (q_1 / (rr_1 * rr_1)), (q_2 / (rr_2 * rr_2)));
      if ((k1 < 1e-6)) {
        return (-Math.min(rr_0, Math.min(rr_1, rr_2)));
      }
      return ((k0 * (k0 - 1.0)) / k1);
    }
    if ((kind < 2.5)) {
      return (Math.hypot(q_0, q_1, q_2) - dm_0);
    }
    let e_0 = Math.max((dm_0 - tip), 0.0), e_1 = Math.max((dm_1 - tip), 0.0), e_2 = Math.max((dm_2 - tip), 0.0);
    let g_0 = (Math.abs(q_0) - e_0), g_1 = (Math.abs(q_1) - e_1), g_2 = (Math.abs(q_2) - e_2);
    return ((Math.hypot(Math.max(g_0, 0.0), Math.max(g_1, 0.0), Math.max(g_2, 0.0)) + Math.min(Math.max(g_0, Math.max(g_1, g_2)), 0.0)) - tip);
}
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
  // pFieldS — from GLSL.field.src
  field: (p, d, r, $node) => {
    const s = fields[($node && $node.fi) || 0];
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let q_0 = (Math.abs(p_0) - d_0), q_1 = (Math.abs(p_1) - d_1), q_2 = (Math.abs(p_2) - d_2);
    let box = (Math.hypot(Math.max(q_0, 0.0), Math.max(q_1, 0.0), Math.max(q_2, 0.0)) + Math.min(Math.max(q_0, Math.max(q_1, q_2)), 0.0));
    if ((d_0 <= 0.0)) {
      return 1e9;
    }
    let uvw_0 = Math.min(Math.max(((p_0 + d_0) / (2.0 * d_0)), 0.0), 1.0), uvw_1 = Math.min(Math.max(((p_1 + d_1) / (2.0 * d_1)), 0.0), 1.0), uvw_2 = Math.min(Math.max(((p_2 + d_2) / (2.0 * d_2)), 0.0), 1.0);
    let v = (((sampleFieldUVW(s, uvw_2, uvw_1, uvw_0) * 2.0) - 1.0) * r);
    return Math.max(v, box);
  },
  // pWire — from GLSL.wire.src
  wire: (p, d, r, $node) => {
    const w = wireSegments(wires[($node && $node.fi) || 0]);
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let best = 1e18;
    let n = segCount(w);
    let i = 0;
    for (; (i < n);) {
      let A_0 = segAx(w, i), A_1 = segAy(w, i), A_2 = segAz(w, i);
      let B_0 = segBx(w, i), B_1 = segBy(w, i), B_2 = segBz(w, i);
      let rr_0 = segRA(w, i), rr_1 = segRB(w, i);
      let ba_0 = (B_0 - A_0), ba_1 = (B_1 - A_1), ba_2 = (B_2 - A_2);
      let pa_0 = (p_0 - A_0), pa_1 = (p_1 - A_1), pa_2 = (p_2 - A_2);
      let l2 = (ba_0*ba_0 + ba_1*ba_1 + ba_2*ba_2);
      let dr = (rr_0 - rr_1);
      let a2 = (l2 - (dr * dr));
      if ((a2 <= 0.0)) {
        best = Math.min(best, Math.min((Math.hypot(pa_0, pa_1, pa_2) - rr_0), (Math.hypot((p_0 - B_0), (p_1 - B_1), (p_2 - B_2)) - rr_1)));
      } else {
        let il2 = (1.0 / l2);
        let y = (pa_0*ba_0 + pa_1*ba_1 + pa_2*ba_2);
        let z = (y - l2);
        let cx_0 = ((pa_0 * l2) - (ba_0 * y)), cx_1 = ((pa_1 * l2) - (ba_1 * y)), cx_2 = ((pa_2 * l2) - (ba_2 * y));
        let x2 = (cx_0*cx_0 + cx_1*cx_1 + cx_2*cx_2);
        let y2 = ((y * y) * l2);
        let z2 = ((z * z) * l2);
        let k = (((Math.sign(dr) * dr) * dr) * x2);
        let dd = 0.0;
        if ((((Math.sign(z) * a2) * z2) > k)) {
          dd = ((Math.sqrt((x2 + z2)) * il2) - rr_1);
        } else {
          if ((((Math.sign(y) * a2) * y2) < k)) {
            dd = ((Math.sqrt((x2 + y2)) * il2) - rr_0);
          } else {
            dd = (((Math.sqrt(((x2 * a2) * il2)) + (y * dr)) * il2) - rr_0);
          }
        }
        best = Math.min(best, dd);
      }
      i += 1;
    }
    return best;
  },
  // pSweep — from GLSL.sweep.src
  sweep: (p, d, r, $node) => {
    const w = sweepSegs(sweeps[($node && $node.fi) || 0]);
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let best = 1e18;
    let n = swCount(w);
    let i = 0;
    for (; (i < n);) {
      let A_0 = swf(w,i,0), A_1 = swf(w,i,1), A_2 = swf(w,i,2);
      let T_0 = swf(w,i,3), T_1 = swf(w,i,4), T_2 = swf(w,i,5);
      let LS_0 = swf(w,i,6), LS_1 = swf(w,i,7), LS_2 = swf(w,i,8);
      let M_0 = swf(w,i,9), M_1 = swf(w,i,10), M_2 = swf(w,i,11);
      let cull = swf(w,i,12);
      let pa_0 = (p_0 - A_0), pa_1 = (p_1 - A_1), pa_2 = (p_2 - A_2);
      let proj = (pa_0*T_0 + pa_1*T_1 + pa_2*T_2);
      let q = Math.min(Math.max(proj, 0.0), LS_0);
      if (((Math.hypot((pa_0 - (T_0 * q)), (pa_1 - (T_1 * q)), (pa_2 - (T_2 * q))) - cull) < (best * M_1))) {
        let U_0 = swf(w,i,13), U_1 = swf(w,i,14), U_2 = swf(w,i,15);
        let V_0 = swf(w,i,16), V_1 = swf(w,i,17), V_2 = swf(w,i,18);
        let K_0 = swf(w,i,19), K_1 = swf(w,i,20);
        let TC_0 = swf(w,i,21), TC_1 = swf(w,i,22);
        let E_0 = swf(w,i,23), E_1 = swf(w,i,24);
        let C_0 = swf(w,i,25), C_1 = swf(w,i,26), C_2 = swf(w,i,27);
        let kind = swf(w,i,28);
        let sp_0 = swf(w,i,29), sp_1 = swf(w,i,30), sp_2 = swf(w,i,31);
        let t = (q / LS_0);
        let oStart = (-(proj + E_0));
        let oEnd = (proj - (LS_0 + E_1));
        let atA = (oStart > oEnd);
        let past = (atA ? oStart : oEnd);
        const t0 = (C_0 > 0.5);
        const t1 = (C_1 > 0.5);
        let capped = Math.max((t0 ? oStart : (-1e30)), (t1 ? oEnd : (-1e30)));
        let s = (LS_1 + ((LS_2 - LS_1) * t));
        let u0 = (pa_0*U_0 + pa_1*U_1 + pa_2*U_2);
        let v0 = (pa_0*V_0 + pa_1*V_1 + pa_2*V_2);
        let u = u0;
        let v = v0;
        if ((M_0 != 0.0)) {
          let a = (M_0 * t);
          let ca = Math.cos(a);
          let sa = Math.sin(a);
          u = ((u0 * ca) + (v0 * sa));
          v = ((v0 * ca) - (u0 * sa));
        }
        const t2 = (s > 1e-9);
        let d2 = (t2 ? (sweepSection(kind, sp_0, sp_1, sp_2, (u / s), (v / s)) * s) : Math.hypot(u, v));
        let raw;
        if ((past > 0.0)) {
          const t3 = (d2 <= 0.0);
          raw = (t3 ? past : Math.hypot(d2, past));
        } else {
          raw = Math.max(d2, capped);
        }
        best = Math.min(best, (raw / M_1));
        if ((C_2 > 0.5)) {
          let oJ = (proj - LS_0);
          if (((Math.hypot(u0, v0, oJ) - M_2) < (best * M_1))) {
            let uj = u0;
            let vj = v0;
            if ((M_0 != 0.0)) {
              let ca = Math.cos(M_0);
              let sa = Math.sin(M_0);
              uj = ((u0 * ca) + (v0 * sa));
              vj = ((v0 * ca) - (u0 * sa));
            }
            let sJ = LS_2;
            let pk = ((uj * K_0) + (vj * K_1));
            let pm = ((vj * K_0) - (uj * K_1));
            let beta;
            let off;
            if ((oJ < 0.0)) {
              beta = pm;
              off = oJ;
            } else {
              if ((((pm * TC_1) - (oJ * TC_0)) >= 0.0)) {
                beta = Math.hypot(pm, oJ);
                off = 0.0;
              } else {
                beta = ((pm * TC_0) + (oJ * TC_1));
                off = ((oJ * TC_0) - (pm * TC_1));
              }
            }
            let p2 = (sweepSection(kind, sp_0, sp_1, sp_2, (((pk * K_0) - (beta * K_1)) / sJ), (((pk * K_1) + (beta * K_0)) / sJ)) * sJ);
            const t4 = (off == 0.0);
            let c = ((t4 ? p2 : Math.hypot(Math.max(p2, 0.0), Math.abs(off))) / M_1);
            best = Math.min(best, c);
          }
        }
      }
      i += 1;
    }
    return best;
  },
  // pProfile — from GLSL.profile.src
  profile: (p, d, r, $node) => {
    const o = outlineEdges(profiles[($node && $node.fi) || 0]);
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let dd = 1e18;
    let ins = false;
    let n = edgeCount(o);
    let i = 0;
    for (; (i < n);) {
      let A_0 = edgeAx(o, i), A_1 = edgeAy(o, i);
      let B_0 = edgeBx(o, i), B_1 = edgeBy(o, i);
      let e_0 = (B_0 - A_0), e_1 = (B_1 - A_1);
      let w_0 = (p_0 - A_0), w_1 = (p_1 - A_1);
      const t0 = Math.min(Math.max(((w_0*e_0 + w_1*e_1) / (e_0*e_0 + e_1*e_1)), 0.0), 1.0);
      let q_0 = (w_0 - (e_0 * t0)), q_1 = (w_1 - (e_1 * t0));
      dd = Math.min(dd, (q_0*q_0 + q_1*q_1));
      let c1 = (p_1 >= A_1);
      let c2 = (p_1 < B_1);
      let cr = ((e_0 * w_1) - (e_1 * w_0));
      if ((((c1 && c2) && (cr > 0.0)) || (((!c1) && (!c2)) && (cr < 0.0)))) {
        ins = (!ins);
      }
      i += 1;
    }
    let da = ((ins ? (-1.0) : 1.0) * Math.sqrt(dd));
    let db = (Math.abs(p_2) - d_2);
    return (Math.min(Math.max(da, db), 0.0) + Math.hypot(Math.max(da, 0.0), Math.max(db, 0.0)));
  },
  // pConstruct — from GLSL.construct.src
  construct: (p, d, r, $node) => {
    const c = conItems(constructs[($node && $node.fi) || 0]);
    let p_0 = p[0], p_1 = p[1], p_2 = p[2];
    let d_0 = d[0], d_1 = d[1], d_2 = d[2];
    let best = 1e18;
    let n = conCount(c);
    let i = 0;
    for (; (i < n);) {
      let bc_0 = conf(c,i,0), bc_1 = conf(c,i,1), bc_2 = conf(c,i,2);
      let br = conf(c,i,3);
      let bd = (Math.hypot((p_0 - bc_0), (p_1 - bc_1), (p_2 - bc_2)) - br);
      if ((bd < best)) {
        let org_0 = conf(c,i,4), org_1 = conf(c,i,5), org_2 = conf(c,i,6);
        let qv_0 = conf(c,i,7), qv_1 = conf(c,i,8), qv_2 = conf(c,i,9);
        let qw = conf(c,i,10);
        let dm_0 = conf(c,i,11), dm_1 = conf(c,i,12), dm_2 = conf(c,i,13);
        let ms_0 = conf(c,i,14), ms_1 = conf(c,i,15), ms_2 = conf(c,i,16);
        let pa_0 = (p_0 - org_0), pa_1 = (p_1 - org_1), pa_2 = (p_2 - org_2);
        let t_0 = ((qv_1 * pa_2) - (qv_2 * pa_1)), t_1 = ((qv_2 * pa_0) - (qv_0 * pa_2)), t_2 = ((qv_0 * pa_1) - (qv_1 * pa_0));
        let lp_0 = (pa_0 + (((t_0 * qw) + ((qv_1 * t_2) - (qv_2 * t_1))) * 2.0)), lp_1 = (pa_1 + (((t_1 * qw) + ((qv_2 * t_0) - (qv_0 * t_2))) * 2.0)), lp_2 = (pa_2 + (((t_2 * qw) + ((qv_0 * t_1) - (qv_1 * t_0))) * 2.0));
        best = smin(best, Math.max(constructMass(ms_0, lp_0, lp_1, lp_2, dm_0, dm_1, dm_2, ms_1), (bd + ms_2)), ms_2);
      }
      i += 1;
    }
    return best;
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
    js: TWINS.field,
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
  // A drawn path given a thickness that may vary along it. Like `profile` and
  // `field`, the data is on the document and `fi` says which; unlike them, the
  // dims are purely the bounds, since a wire's shape is entirely in its points.
  wire: {
    name: 'Wire', round: false, baked: true,
    dims: [['Half width', 0.5, 200, 0.5], ['Half depth', 0.5, 200, 0.5],
           ['Half height', 0.5, 200, 0.5]],
    // matches DEFAULT_WIRE, so a wire node with no data behind it is a 20 mm
    // tapered run rather than nothing at all
    def: [12, 2, 2],
    js: TWINS.wire,
    ext: d => [d[0] || 1, d[1] || 1, d[2] || 1]
  },
  // A section dragged along a path. Its dims are purely the bounds: everything
  // about the shape is in the packed segments on the document.
  sweep: {
    name: 'Sweep', round: false, baked: true,
    dims: [['Half width', 0.5, 400, 0.5], ['Half depth', 0.5, 400, 0.5],
           ['Half height', 0.5, 400, 0.5]],
    def: [13, 3, 3],
    js: TWINS.sweep,
    ext: d => [d[0] || 1, d[1] || 1, d[2] || 1]
  },
  profile: {
    name: 'Profile', round: false, baked: true,
    dims: [['Half width', 0.5, 200, 0.5], ['Half depth', 0.5, 200, 0.5],
           ['Half height', 0.25, 100, 0.25]],
    // the defaults match DEFAULT_OUTLINE, so a profile node with no outline
    // behind it is a 20 x 20 x 12 mm slab rather than nothing at all
    def: [10, 10, 6],
    js: TWINS.profile,
    ext: d => [d[0] || 1, d[1] || 1, d[2] || 1]
  },
  // Masses hung on a skeleton of connectors. The skeleton is on the document
  // and `fi` says which; the dims are purely the bounds, because everything
  // about the shape -- and everything about the pose -- is in the items
  // `SinterConstruct.pack()` resolved.
  //
  // `exact: false` for the reason a blend always breaks it: every joint folds
  // with `smin`, and inside a blend shell the gradient is under one. It stays
  // 1-Lipschitz, which is what the marcher actually rests on, because rigid
  // frames and exact masses cannot make it anything else -- but it is a bound
  // and says so.
  construct: {
    name: 'Construct', round: false, baked: true, exact: false,
    dims: [['Half width', 0.5, 400, 0.5], ['Half depth', 0.5, 400, 0.5],
           ['Half height', 0.5, 400, 0.5]],
    // matches DEFAULT_CONSTRUCT, so a construct node with no rig behind it is
    // a small armature rather than nothing at all
    def: [13, 9, 22.5],
    js: TWINS.construct,
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

// What goes in the round slot. Every primitive but one puts its corner
// rounding there; a baked field has no rounding and puts its *range* there
// instead, because the range has to reach the shader somehow and that uniform
// is spare. That used to be prose a consumer had to remember -- viewer.js
// carried its own copy of the rule, and packing `round` there by mistake gives
// a field multiplied by zero, which draws as its bounding box and looks
// exactly like a texture that never arrived. Now both halves ask here.
function roundSlot(n) {
  if (n && n.t === 'field')
    return ((fields[(n && n.fi) || 0] || {}).range) || 0;
  return (n && n.round) || 0;
}

// smin and smax are generated from GLSL.FOLD, above. invRot is not, and is
// the one deliberate exception in the file: its GLSL returns a vec3, and a JS
// twin that returned an array would allocate once per node per sample -- a
// hundred million times in a single mesh. It writes into `out` instead, and
// check-glmesh compares the two ends of it per sample on a rotated scene.
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
      const di = PRIMS[n.t].js(q, n.d, roundSlot(n), n);
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

// A plan, meshed. The grid is derived from the scene's own bounds, filled by
// `opts.sample`, and walked by surfaceNets.
//
// The filling is pluggable and the default is this file's own JS evaluation,
// which is the point: it is one SDF call per grid corner and essentially all
// of the cost, so it is the half worth moving to a GPU. `glmesh.js` provides a
// sampler that does exactly that, with the same signature, and nothing here
// knows whether it was used -- which is what keeps this file free of any
// notion that a GPU exists.
//
//   SinterForm.mesh(plan)                              // JS, always works
//   SinterForm.mesh(plan, { sample: SinterGLMesh.sampler() })   // on the GPU
//
// `res` is the grid spacing in mm. `maxSamples` is a guard, not a policy: a
// grid is cubic in 1/res and it is easy to ask for a hundred gigabytes by
// dragging a slider.
function mesh(plan, opts) {
  opts = opts || {};
  const res = opts.res === undefined ? 0.6 : opts.res;
  const maxSamples = opts.maxSamples === undefined ? 24e6 : opts.maxSamples;
  const nodes = [];
  for (const part of plan) for (const n of part.nodes) nodes.push(n);
  const B = opts.bounds || sceneBounds(nodes);
  if (!B) return null;
  const pad = 2 * res;
  const lo = [B.lo[0] - pad, B.lo[1] - pad, B.lo[2] - pad];
  const n = [0, 1, 2].map(i => Math.ceil((B.hi[i] - B.lo[i] + 2 * pad) / res) + 1);
  const total = n[0] * n[1] * n[2];
  if (total > maxSamples)
    throw new Error(`mesh: ${(total / 1e6).toFixed(1)} M samples at ${res} mm`
      + ` exceeds maxSamples (${(maxSamples / 1e6).toFixed(0)} M)`);
  const vol = new Float32Array(total);
  if (opts.sample) {
    opts.sample(plan, lo, n, res, vol);
  } else {
    let k = 0;
    for (let i = 0; i < n[0]; i++)
      for (let j = 0; j < n[1]; j++)
        for (let m = 0; m < n[2]; m++)
          vol[k++] = sceneSDF(plan, lo[0] + i * res, lo[1] + j * res, lo[2] + m * res);
  }
  const out = surfaceNets(vol, n[0], n[1], n[2], lo[0], lo[1], lo[2], res);
  out.lo = lo; out.n = n; out.res = res; out.samples = total;
  return out;
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
  get wires() { return wires; },
  set wires(v) { wires = v; },
  get sweeps() { return sweeps; },
  set sweeps(v) { sweeps = v; },
  get constructs() { return constructs; },
  set constructs(v) { constructs = v; },
  decodeField, encodeField, sampleField,
  polygonSDF, profileExtent, wireExtent, slotItems, slotList, SWEEP_STRIDE,
  CON_STRIDE,
  smin, smax, invRot, roundSlot,
  sceneSDF, sceneBounds, surfaceNets, mesh, meshToSTL
};
if (typeof module !== 'undefined' && module.exports) module.exports = SinterForm;
root.SinterForm = SinterForm;
})(typeof self !== 'undefined' ? self : globalThis);
