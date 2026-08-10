/* SinterForm viewer - a debugging window onto the kernel
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * Not part of the kernel, and the kernel does not know it exists. It is the
 * other way round: this consumes sinterform.js, glsl.js and sketch.js the way
 * any other application would, which is also what makes it useful -- if the
 * viewer needs something the modules do not expose, that is a finding about
 * the API rather than a reason to reach inside.
 *
 * Its one real trick is that it draws the same scene two ways. Raymarch mode
 * runs the GLSL from glsl.js on the GPU; mesh mode runs the JS twins from
 * sinterform.js on the CPU and meshes the result. The two are meant to be the
 * same shape. Toggling between them is a divergence detector you can see,
 * which check-glsl.mjs can only report as a number.
 *
 * Everything about the machine is this file's: the uniform packing, the
 * budgets, the raymarch loop, the camera, the lights. None of that is
 * geometry, so none of it belongs in the kernel.
 */
(function (root) {
"use strict";

const SF = root.SinterForm, GL = root.SinterFormGLSL;

// This viewer's packing: 32 shapes at 3 vec4 apiece, 4 field textures. Its
// numbers, not the kernel's -- see the note at the top of glsl.js.
const MAXN = 32;
const MAXFIELDS = 4;

// Sphere tracing steps by a fraction of the reported distance, and the
// fraction has to be under 1 / (the loosest primitive's Lipschitz constant).
// check-primitives.mjs prints that figure: 0.817, set by the ellipsoid. 0.75
// keeps a margin without crawling.
const STEP = 0.75;

// One field of view for both modes, or the comparison they exist for is
// worthless. The raymarch takes it as a focal length against uv that spans
// +/-0.5 vertically, so it carries a 0.5 the projection matrix does not --
// get that wrong and the GPU view is zoomed 2x against the meshed one, which
// looks exactly like the geometry disagreeing.
const FOV = 40 * Math.PI / 180;
const FOCAL = 0.5 / Math.tan(FOV / 2);

const VS = `#version 300 es
const vec2 v[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
void main(){ gl_Position = vec4(v[gl_VertexID], 0.0, 1.0); }`;

const PREAMBLE = `#version 300 es
precision highp float;
out vec4 frag;
uniform vec2 uRes;
uniform vec3 uEye;
uniform mat3 uCam;
uniform float uFocal;
uniform vec4 uD[${MAXN * 3}];
uniform vec3 uTint;
uniform float uHit;
uniform float uFlat;
${GL.samplerDecls(MAXFIELDS)}
float smin(float a, float b, float k){
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

// The shading half. Deliberately plain: this is a window, not a renderer.
const TAIL = `
vec3 normalAt(vec3 p){
  vec2 e = vec2(1.0, -1.0)*0.0015;
  return normalize(e.xyy*map(p + e.xyy) + e.yyx*map(p + e.yyx)
                 + e.yxy*map(p + e.yxy) + e.xxx*map(p + e.xxx));
}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;
  vec3 rd = normalize(uCam*vec3(uv, uFocal));
  vec3 ro = uEye;
  float t = 0.0; bool hit = false;
  for (int i = 0; i < 220; i++){
    float d = map(ro + rd*t);
    if (d < uHit*t + 0.002) { hit = true; break; }
    t += d*${STEP};
    if (t > 1200.0) break;
  }
  // Silhouette mode: no ground, no shading, no tint -- just where the solid
  // is. It exists so the two draw paths can be compared as masks; anything
  // else in the picture is a difference between renderers, not between the
  // geometry they were given.
  if (uFlat > 0.5) { frag = vec4(hit ? 1.0 : 0.0); return; }
  float tg = (rd.z < -1e-5) ? (-ro.z/rd.z) : -1.0;
  bool ground = tg > 0.0 && (!hit || tg < t);
  vec3 col;
  if (ground){
    vec3 p = ro + rd*tg;
    float fade = exp(-0.0025*tg);
    vec2 g = abs(fract(p.xy/10.0 + 0.5) - 0.5)/fwidth(p.xy/10.0);
    float minor = 1.0 - min(min(g.x, g.y), 1.0);
    vec2 G = abs(fract(p.xy/50.0 + 0.5) - 0.5)/fwidth(p.xy/50.0);
    float major = 1.0 - min(min(G.x, G.y), 1.0);
    col = mix(vec3(0.055,0.065,0.080), vec3(0.15,0.19,0.23), minor*0.5);
    col = mix(col, vec3(0.26,0.32,0.38), major*0.6);
    col *= fade;
    col = mix(vec3(0.05,0.058,0.070), col, fade);
  } else if (hit){
    vec3 p = ro + rd*t;
    vec3 n = normalAt(p);
    vec3 L1 = normalize(vec3(0.42,-0.5,0.76)), L2 = normalize(vec3(-0.6,0.55,0.25));
    float dif = max(dot(n,L1),0.0)*0.8 + max(dot(n,L2),0.0)*0.22;
    vec3 V = normalize(uEye - p);
    float spec = pow(max(dot(n, normalize(L1 + V)), 0.0), 40.0)*0.3;
    col = uTint*(dif + 0.30 + 0.12*n.z) + vec3(spec);
  } else {
    col = vec3(0.05,0.058,0.070);
  }
  frag = vec4(pow(col, vec3(0.85)), 1.0);
}`;

// Turn a plan into the body of map(). This is the same job MetaMeld does, and
// it is done here rather than shared because the uniform layout it reads from
// is this viewer's own -- GL.call() takes the expressions as arguments for
// exactly that reason.
function mapBody(plan) {
  let body = '', slot = 0;
  const at = new Map();
  for (const part of plan)
    for (const n of part.nodes)
      if (slot < MAXN && !at.has(n)) at.set(n, slot++);
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
      body += `  q = invRot(q - uD[${b}].xyz, uD[${b + 1}].xyz);\n`;
      const fi = Math.min(Math.max(n.fi || 0, 0), MAXFIELDS - 1);
      body += `  di = ${GL.call(n.t, 'q', `uD[${b + 2}].xyz`, `uD[${b + 1}].w`, fi)};\n`;
      body += n.op === 'add' ? `  dB = smin(dB, di, uD[${b}].w);\n`
            : n.op === 'cut' ? `  dB = smax(dB, -di, uD[${b}].w);\n`
            :                  `  dB = smax(dB, di, uD[${b}].w);\n`;
    }
    body += '  d = min(d, dB);\n';
  }
  return { body, at };
}

function fragSource(plan) {
  const { body, at } = mapBody(plan);
  // A profile's outline is compiled into the shader rather than uploaded, so
  // the source depends on the document's profiles as well as on the plan.
  return { src: PREAMBLE + `${GL.library()}\n${GL.profileDecls(SF.profiles)}\nfloat map(vec3 P){\n`
    + `  float d = 1e9, dB, di; vec3 q;\n${body}  return d;\n}\n` + TAIL, at };
}

// ----------------------------------------------------------------------
function attach(canvas, opts) {
  opts = opts || {};
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) throw new Error('the viewer needs WebGL2');
  const view = {
    plan: [], mode: 'raymarch', tint: [0.91, 0.56, 0.24],
    yaw: -0.9, pitch: 0.55, dist: 140, target: [0, 0, 12],
    res: opts.res || 0.6, flat: false, mesh: null, tris: 0, meshMs: 0, lastError: null
  };
  let prog = null, uni = {}, meshProg = null, meshVao = null, meshCount = 0;
  const uData = new Float32Array(MAXN * 12);

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const link = (vs, fs) => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p));
    return p;
  };

  // ---- mesh mode: the JS twins, through the kernel's own mesher ----------
  const MESH_VS = `#version 300 es
in vec3 aP; in vec3 aN; uniform mat4 uMVP; out vec3 vN; out vec3 vW;
void main(){ vN = aN; vW = aP; gl_Position = uMVP*vec4(aP,1.0); }`;
  const MESH_FS = `#version 300 es
precision highp float; in vec3 vN; in vec3 vW; out vec4 o; uniform vec3 uTint;
uniform vec3 uEye; uniform float uFlat;
void main(){
  if (uFlat > 0.5) { o = vec4(1.0); return; }
  vec3 n = normalize(vN);
  vec3 L1 = normalize(vec3(0.42,-0.5,0.76)), L2 = normalize(vec3(-0.6,0.55,0.25));
  float dif = max(dot(n,L1),0.0)*0.8 + max(dot(n,L2),0.0)*0.22;
  vec3 V = normalize(uEye - vW);
  float spec = pow(max(dot(n, normalize(L1 + V)),0.0), 40.0)*0.3;
  o = vec4(pow(uTint*(dif + 0.30 + 0.12*n.z) + vec3(spec), vec3(0.85)), 1.0);
}`;

  function buildMesh() {
    const t0 = Date.now();
    const nodes = [];
    for (const part of view.plan) for (const n of part.nodes) nodes.push(n);
    const B = SF.sceneBounds(nodes);
    if (!B) { view.mesh = null; view.tris = 0; return; }
    const res = view.res, pad = 2 * res;
    const lo = [B.lo[0] - pad, B.lo[1] - pad, B.lo[2] - pad];
    const n = [0, 1, 2].map(i => Math.ceil((B.hi[i] - B.lo[i] + 2 * pad) / res) + 1);
    const total = n[0] * n[1] * n[2];
    if (total > 24e6) { view.lastError = `grid too big (${(total / 1e6).toFixed(0)} M)`; return; }
    const vol = new Float32Array(total);
    let k = 0;
    for (let i = 0; i < n[0]; i++)
      for (let j = 0; j < n[1]; j++)
        for (let m = 0; m < n[2]; m++)
          vol[k++] = SF.sceneSDF(view.plan, lo[0] + i * res, lo[1] + j * res, lo[2] + m * res);
    const mesh = SF.surfaceNets(vol, n[0], n[1], n[2], lo[0], lo[1], lo[2], res);
    const P = mesh.positions, I = mesh.indices;
    const N = new Float32Array(P.length);
    for (let t = 0; t < I.length; t += 3) {
      const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const o of [a, b, c]) { N[o] += nx; N[o + 1] += ny; N[o + 2] += nz; }
    }
    if (!meshProg) meshProg = link(MESH_VS, MESH_FS);
    meshVao = gl.createVertexArray();
    gl.bindVertexArray(meshVao);
    const put = (data, name, size) => {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(meshProg, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    put(P, 'aP', 3); put(N, 'aN', 3);
    const eb = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eb);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, I, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    meshCount = I.length;
    view.tris = I.length / 3;
    view.meshMs = Date.now() - t0;
  }

  // ---- camera -----------------------------------------------------------
  function camera() {
    // Orbit: the eye sits on a sphere around the target, so a positive pitch
    // is above the build plate looking down -- which is where someone expects
    // to start, and the only place the z = 0 grid is visible from.
    const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
    const eye = [view.target[0] + cp * cy * view.dist,
                 view.target[1] + cp * sy * view.dist,
                 view.target[2] + sp * view.dist];
    const dir = [view.target[0] - eye[0], view.target[1] - eye[1], view.target[2] - eye[2]];
    const up = [0, 0, 1];
    const nrm = v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
    const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const f = nrm(dir), r = nrm(cr(f, up)), u = cr(r, f);
    return { eye, r, u, f };
  }

  function upload(at) {
    uData.fill(0);
    for (const [n, i] of at) {
      const b = 12 * i;
      uData[b] = n.p[0]; uData[b + 1] = n.p[1]; uData[b + 2] = n.p[2];
      uData[b + 3] = Math.max(n.k || 0, 0);
      uData[b + 4] = (n.r[0] || 0) * SF.RAD;
      uData[b + 5] = (n.r[1] || 0) * SF.RAD;
      uData[b + 6] = (n.r[2] || 0) * SF.RAD;
      // A baked field has no rounding, and its GLSL twin takes the *range* --
      // the millimetres one byte of sample spans -- through that slot instead.
      // The JS twin reads it off the field object, so nothing in the plan
      // carries it and a consumer that packs `round` here gets a field that
      // reads zero everywhere: max(0, box), which draws as the bounding box
      // and looks like the texture never arrived.
      uData[b + 7] = n.t === 'field'
        ? (((SF.fields || [])[n.fi | 0] || { range: 0 }).range || 0)
        : (n.round || 0);
      uData[b + 8] = n.d[0]; uData[b + 9] = n.d[1] || 0; uData[b + 10] = n.d[2] || 0;
    }
  }

  // ---- baked fields ----------------------------------------------------
  // The consumer's half of the `field` primitive. The kernel holds the
  // samples, glsl.js declares the samplers and reads them back, and somebody
  // has to put the one into the other -- that somebody is whoever owns the GL
  // context, which is this file.
  //
  // The grid is stored z-fastest, so the texture is nz wide by ny by nx, and
  // glsl.js looks it up as uvw.zyx to match. Trilinear filtering and clamped
  // edges are not a choice: they are what sampleField does in JS, and the two
  // have to be the same shape.
  const texes = new Map();
  function texOf(f) {
    if (!f || !f.data) return null;
    let t = texes.get(f);
    if (t) return t;
    t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, f.nz, f.ny, f.nx, 0,
                  gl.RED, gl.UNSIGNED_BYTE, f.data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of ['TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'TEXTURE_WRAP_R'])
      gl.texParameteri(gl.TEXTURE_3D, gl[w], gl.CLAMP_TO_EDGE);
    texes.set(f, t);
    return t;
  }
  function bindFields() {
    const fs = SF.fields || [];
    for (let i = 0; i < MAXFIELDS; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_3D, texOf(fs[i]));
      const u = uni['uField' + i];
      if (u) gl.uniform1i(u, i);
    }
  }
  // A scene replaces the whole array when it loads, so anything not in it any
  // more is never coming back.
  function dropStaleTextures() {
    const live = new Set(SF.fields || []);
    for (const [f, t] of texes)
      if (!live.has(f)) { gl.deleteTexture(t); texes.delete(f); }
  }

  let at = new Map();
  function rebuild() {
    view.lastError = null;
    try {
      dropStaleTextures();
      const { src, at: a } = fragSource(view.plan);
      prog = link(VS, src);
      at = a;
      uni = {};
      for (const k of ['uRes', 'uEye', 'uCam', 'uFocal', 'uTint', 'uHit', 'uFlat'])
        uni[k] = gl.getUniformLocation(prog, k);
      uni.uD = gl.getUniformLocation(prog, 'uD[0]');
      for (let i = 0; i < MAXFIELDS; i++)
        uni['uField' + i] = gl.getUniformLocation(prog, 'uField' + i);
    } catch (e) { view.lastError = String(e.message || e); }
    if (view.mode === 'mesh') { try { buildMesh(); } catch (e) { view.lastError = String(e.message || e); } }
  }

  function draw() {
    const w = canvas.width, h = canvas.height;
    gl.viewport(0, 0, w, h);
    if (view.flat) gl.clearColor(0, 0, 0, 1); else gl.clearColor(0.05, 0.058, 0.070, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const C = camera();
    if (view.mode === 'mesh') {
      if (!meshVao || !meshCount) return;
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(meshProg);
      const asp = w / h, fz = 1 / Math.tan(FOV / 2);
      const nr = 1, fr = 4000;
      const proj = [fz / asp, 0, 0, 0, 0, fz, 0, 0, 0, 0, (fr + nr) / (nr - fr), -1,
                    0, 0, 2 * fr * nr / (nr - fr), 0];
      const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const vm = [C.r[0], C.u[0], -C.f[0], 0, C.r[1], C.u[1], -C.f[1], 0,
                  C.r[2], C.u[2], -C.f[2], 0,
                  -d(C.r, C.eye), -d(C.u, C.eye), d(C.f, C.eye), 1];
      const M = new Float32Array(16);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        let s = 0; for (let k = 0; k < 4; k++) s += proj[k * 4 + j] * vm[i * 4 + k];
        M[i * 4 + j] = s;
      }
      gl.uniformMatrix4fv(gl.getUniformLocation(meshProg, 'uMVP'), false, M);
      gl.uniform3f(gl.getUniformLocation(meshProg, 'uTint'), 0.42, 0.72, 0.95);
      gl.uniform3f(gl.getUniformLocation(meshProg, 'uEye'), C.eye[0], C.eye[1], C.eye[2]);
      gl.uniform1f(gl.getUniformLocation(meshProg, 'uFlat'), view.flat ? 1 : 0);
      gl.bindVertexArray(meshVao);
      gl.drawElements(gl.TRIANGLES, meshCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      return;
    }
    if (!prog) return;
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    upload(at);
    bindFields();
    gl.uniform2f(uni.uRes, w, h);
    gl.uniform3f(uni.uEye, C.eye[0], C.eye[1], C.eye[2]);
    gl.uniformMatrix3fv(uni.uCam, false, new Float32Array(
      [C.r[0], C.r[1], C.r[2], C.u[0], C.u[1], C.u[2], C.f[0], C.f[1], C.f[2]]));
    gl.uniform1f(uni.uFocal, FOCAL);
    gl.uniform3f(uni.uTint, view.tint[0], view.tint[1], view.tint[2]);
    gl.uniform1f(uni.uHit, 0.0006);
    gl.uniform1f(uni.uFlat, view.flat ? 1 : 0);
    gl.uniform4fv(uni.uD, uData);
    gl.bindVertexArray(gl.createVertexArray());
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    view,
    show(plan) { view.plan = plan; rebuild(); draw(); return this; },
    setMode(m) {
      view.mode = m;
      if (m === 'mesh' && !meshVao) { try { buildMesh(); } catch (e) { view.lastError = String(e.message || e); } }
      draw(); return this;
    },
    setRes(r) { view.res = r; if (view.mode === 'mesh') buildMesh(); draw(); return this; },
    setFlat(on) { view.flat = !!on; draw(); return this; },
    orbit(dy, dp) { view.yaw += dy; view.pitch = Math.max(-1.5, Math.min(1.5, view.pitch + dp)); draw(); },
    zoom(f) { view.dist = Math.max(8, Math.min(900, view.dist * f)); draw(); },
    frame(nodes) {
      const B = SF.sceneBounds(nodes || view.plan.flatMap(p => p.nodes));
      if (!B) return this;
      view.target = [0, 1, 2].map(i => (B.lo[i] + B.hi[i]) / 2);
      const span = Math.max(B.hi[0] - B.lo[0], B.hi[1] - B.lo[1], B.hi[2] - B.lo[2]);
      view.dist = Math.max(24, span * 2.1);
      draw(); return this;
    },
    draw, rebuild, buildMesh
  };
}

// A node with every field the kernel reads, so callers can write only what
// they mean. Handy enough that the viewer would otherwise grow its own.
function node(t, over) {
  return Object.assign({ t, on: true, op: 'add', k: 0, b: 0, tg: null, fi: 0,
    p: [0, 0, 0], r: [0, 0, 0], d: (SF.PRIMS[t] || { def: [0, 0, 0] }).def.slice(),
    round: 0, mx: false, my: false, mz: false }, over);
}

const SinterView = { attach, node, mapBody, fragSource, MAXN, MAXFIELDS, STEP };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterView;
root.SinterView = SinterView;
})(typeof self !== 'undefined' ? self : globalThis);
