/* SinterForm GPU meshing - fill the sample grid on the GPU, mesh it here
 * Copyright (c) 2026 DuckySonadar
 * SPDX-License-Identifier: Apache-2.0
 *
 * Meshing is two jobs with very different costs. Filling the grid is one SDF
 * evaluation per corner -- hundreds of thousands for a small part, tens of
 * millions for a real one, and essentially all of the time. Walking the cells
 * to emit triangles is cheap by comparison, and it is `surfaceNets`, which
 * stays where it is.
 *
 * So this file does the expensive half on the GPU. It builds the same
 * `float map(vec3)` the viewer raymarches -- from glsl.js, through the same
 * `mapSource` and `packPlan`, so there is no second opinion about what the
 * scene is -- renders the grid into a float target a slab at a time, reads it
 * back, and hands the samples to the kernel's mesher.
 *
 * What it does NOT do is emit triangles on the GPU. A fragment shader produces
 * one value per pixel; a mesh is a variable-length list of connected
 * triangles, which needs the compute shaders, atomics and prefix sums that
 * WebGL2 does not have (that is WebGPU). Calling this "GPU meshing" is
 * therefore half true, and it is the expensive half.
 *
 * It is optional in the strongest sense: the kernel does not import it, does
 * not know it exists, and meshes perfectly well without it. `SinterForm.mesh`
 * takes a sampler and defaults to evaluating `sceneSDF` in JavaScript; this
 * file is one you can pass instead when there is a GL context to be had.
 *
 * Same rule as the kernel: nothing here may spell a literal closing script
 * tag, because this gets inlined into HTML too.
 */
(function (root) {
"use strict";

// One R32F texel per sample would be the obvious layout and it does not fit:
// a 300 x 300 x 400 grid is 36 M samples, and no texture is that wide. So the
// grid is drawn a slab of rows at a time, capped by texels rather than by
// rows, and read back per slab. 4 M texels is 64 MB of RGBA32F readback
// buffer, which is a comfortable working set and about 25 slabs for the
// biggest grid the kernel will accept.
const TEXELS = 4 << 20;

const VS = `#version 300 es
const vec2 v[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
void main(){ gl_Position = vec4(v[gl_VertexID], 0.0, 1.0); }`;

function head(maxN, maxFields) {
  return `#version 300 es
precision highp float;
out vec4 outc;
uniform vec4 uD[${maxN * 3}];
uniform vec3 uLo;
uniform float uRes;
uniform ivec3 uN;
uniform int uRow0;
uniform int uW;
${SinterFormGLSL.samplerDecls(maxFields)}
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
}

// The grid is stored the way surfaceNets reads it: vol[(i*ny + j)*nz + k],
// x-major, z fastest. One row of the render target is one (i, j) pair and the
// column is k, so a row-major readback drops straight into the volume with no
// shuffling -- which matters, because the shuffle would be the second most
// expensive thing here.
const TAIL = `
void main(){
  int col = int(gl_FragCoord.x);
  int row = uRow0 + int(gl_FragCoord.y);
  int i = row / uN.y;
  int j = row - i*uN.y;
  if (col >= uN.z || i >= uN.x) { outc = vec4(1e9); return; }
  vec3 P = uLo + vec3(float(i), float(j), float(col))*uRes;
  outc = vec4(map(P), 0.0, 0.0, 1.0);
}`;

function compile(gl, src, kind) {
  const s = gl.createShader(kind);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('glmesh: ' + gl.getShaderInfoLog(s));
  return s;
}

// A context of our own, off-screen, when the caller has not got one to lend.
// OffscreenCanvas where it exists so this works in a worker; a detached
// <canvas> otherwise.
function makeContext() {
  const opts = { antialias: false, depth: false, stencil: false,
                 preserveDrawingBuffer: false };
  let cv = null;
  if (typeof OffscreenCanvas !== 'undefined') cv = new OffscreenCanvas(1, 1);
  else if (typeof document !== 'undefined') cv = document.createElement('canvas');
  if (!cv) return null;
  return cv.getContext('webgl2', opts);
}

// Is there a GPU path to be had at all? Cheap enough to ask before every
// mesh, and the answer is what decides between this and the JS fallback.
function available(gl) {
  try {
    const g = gl || makeContext();
    return !!(g && g.getExtension('EXT_color_buffer_float'));
  } catch { return false; }
}

// The sampler `SinterForm.mesh` wants: fill `vol` with the scene's distance at
// every grid corner. Signature and grid convention are the kernel's, so this
// and the JS default are interchangeable.
function sampler(opts) {
  opts = opts || {};
  const SF = opts.SinterForm || root.SinterForm;
  const GL = opts.SinterFormGLSL || root.SinterFormGLSL;
  if (!SF || !GL) throw new Error('glmesh needs SinterForm and SinterFormGLSL');
  const maxN = opts.maxN === undefined ? 32 : opts.maxN;
  const maxFields = opts.maxFields === undefined ? 4 : opts.maxFields;

  let gl = opts.gl || null, owned = false;
  const texes = new Map();

  return function sample(plan, lo, n, res, vol) {
    if (!gl) { gl = makeContext(); owned = true; }
    if (!gl) throw new Error('glmesh: no WebGL2 context');
    if (!gl.getExtension('EXT_color_buffer_float'))
      throw new Error('glmesh: no float render target (EXT_color_buffer_float)');

    // A borrowed context belongs to something that is drawing with it, so
    // whatever this binds has to be put back. The viewer hands over its own
    // context and would otherwise find its framebuffer and viewport moved.
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevVp = gl.getParameter(gl.VIEWPORT);
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);

    const { src, at } = GL.mapSource(plan, SF.profiles,
                                     { maxN, maxFields, wires: SF.wires });
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, VS, gl.VERTEX_SHADER));
    gl.attachShader(prog, compile(gl, head(maxN, maxFields) + src + TAIL,
                                  gl.FRAGMENT_SHADER));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('glmesh: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const W = n[2];                       // one column per z sample
    const rows = n[0] * n[1];
    const maxRows = Math.max(1, Math.min(rows, Math.floor(TEXELS / Math.max(W, 1)),
                                         gl.getParameter(gl.MAX_TEXTURE_SIZE)));
    if (W > gl.getParameter(gl.MAX_TEXTURE_SIZE))
      throw new Error(`glmesh: grid is ${W} deep, past this GPU's texture limit`);

    const out = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, out);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, maxRows, 0,
                  gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                            gl.TEXTURE_2D, out, 0);

    // the same uniform block the viewer packs, from the same function
    const uData = GL.packPlan(at, { maxN, roundSlot: SF.roundSlot });
    gl.uniform4fv(gl.getUniformLocation(prog, 'uD'), uData);
    gl.uniform3f(gl.getUniformLocation(prog, 'uLo'), lo[0], lo[1], lo[2]);
    gl.uniform1f(gl.getUniformLocation(prog, 'uRes'), res);
    gl.uniform3i(gl.getUniformLocation(prog, 'uN'), n[0], n[1], n[2]);
    gl.uniform1i(gl.getUniformLocation(prog, 'uW'), W);
    bindFields(gl, SF, texes, maxFields, prog);

    gl.bindVertexArray(gl.createVertexArray());
    const px = new Float32Array(W * maxRows * 4);
    const rowLoc = gl.getUniformLocation(prog, 'uRow0');
    for (let r0 = 0; r0 < rows; r0 += maxRows) {
      const h = Math.min(maxRows, rows - r0);
      gl.uniform1i(rowLoc, r0);
      gl.viewport(0, 0, W, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, W, h, gl.RGBA, gl.FLOAT, px);
      // RGBA32F rather than R32F: reading RGBA/FLOAT off a float attachment is
      // the combination WebGL2 always allows, and the extra bandwidth is a
      // rounding error beside the evaluation it saves.
      const base = r0 * W;
      for (let t = 0, m = h * W; t < m; t++) vol[base + t] = px[4 * t];
    }

    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(out);
    gl.deleteProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
    gl.useProgram(prevProg);
    gl.bindVertexArray(prevVao);
    return vol;
  };
}

// Baked fields still have to reach the shader. Same layout as viewer.js's
// texOf -- nz wide by ny by nx, trilinear, edges clamped -- because
// `fieldSample` in glsl.js assumes exactly that.
function bindFields(gl, SF, texes, maxFields, prog) {
  const fs = SF.fields || [];
  for (let i = 0; i < maxFields; i++) {
    const f = fs[i];
    const loc = gl.getUniformLocation(prog, `uField${i}`);
    if (loc === null) continue;
    gl.activeTexture(gl.TEXTURE0 + i);
    let t = f && texes.get(f);
    if (f && !t) {
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
    }
    gl.bindTexture(gl.TEXTURE_3D, t || null);
    gl.uniform1i(loc, i);
  }
  gl.activeTexture(gl.TEXTURE0);
}

// The whole job, for a caller that just wants triangles.
function mesh(plan, opts) {
  opts = opts || {};
  const SF = opts.SinterForm || root.SinterForm;
  return SF.mesh(plan, Object.assign({}, opts, { sample: sampler(opts) }));
}

const SinterGLMesh = { available, sampler, mesh, TEXELS };
if (typeof module !== 'undefined' && module.exports) module.exports = SinterGLMesh;
root.SinterGLMesh = SinterGLMesh;
})(typeof self !== 'undefined' ? self : globalThis);
