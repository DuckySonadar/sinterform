/* Check that each primitive's GLSL and its JS twin compute the same thing.
 *
 *     node check-glsl.mjs
 *
 * Every primitive is written twice -- once in GLSL for a raymarcher, once in
 * JS for a mesher -- and the two sitting next to each other in the source is
 * the only thing that has ever kept them in step. When they drift, the
 * preview and the exported mesh disagree about the shape, which is a hard
 * thing to even notice and a miserable thing to bisect.
 *
 * So: compile the real GLSL on a real GPU, evaluate it at a few thousand
 * points, and compare against the JS at the same points.
 *
 * This one needs Playwright and a browser, which the kernel deliberately does
 * not depend on -- it is a zero-dependency file and stays that way. If they
 * are not here the check reports that it skipped and exits 0, unless run with
 * --require, which is what CI should use.
 */
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQUIRE = process.argv.includes('--require');
const TOL = 2e-3;          // mm; fp32 in the shader against fp64 in node

// GLSL ES only promises its transcendentals to about 2^-11 relative, so a
// primitive whose fold goes through atan() carries an angle error the JS twin
// does not have. At a 40 mm radius that is ~0.007 mm of position -- two
// orders under the finest thing this prints, and not a formula difference.
// Anything using sin/cos/atan gets the looser bar; everything else stays
// tight, because a real drift between the twins would be far larger.
const LOOSE = { prism: 3e-2 };
const N = 64;              // N*N points per primitive

const mod = { exports: {} };
new Function('module', readFileSync(join(HERE, 'sinterform.js'), 'utf8'))(mod);
const SF = mod.exports;

let chromium;
for (const cand of [process.env.PLAYWRIGHT_MODULE,
                    join(HERE, 'node_modules/playwright/index.mjs'),
                    join(HERE, '..', 'node_modules/playwright/index.mjs'),
                    'playwright']) {
  if (!cand) continue;
  try {
    ({ chromium } = await import(cand.startsWith('/') ? pathToFileURL(cand).href : cand));
    break;
  } catch { /* try the next one */ }
}
if (!chromium) {
  const msg = 'check-glsl: Playwright not found — GLSL/JS twins NOT compared.';
  if (REQUIRE) { console.error(msg); process.exit(1); }
  console.log(`${msg}\n  npm i playwright   (then re-run; --require makes this fatal)`);
  process.exit(0);
}

// Everything but the baked field, which needs a 3D texture and real samples.
const KEYS = SF.PRIM_KEYS.filter(k => !SF.PRIMS[k].baked);

// Deterministic points, generated here and used by both sides.
let seed = 0x9e3779b1;
const rnd = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed |= 0;
  return (seed >>> 0) / 4294967296;
};

const cases = KEYS.map(k => {
  const P = SF.PRIMS[k];
  const d = P.def.slice();
  const r = P.round ? 1.5 : 0;
  const E = P.ext(d).map(v => Math.min(v, 200) + r + 4);
  const pts = new Float32Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    pts[4 * i] = (rnd() * 2 - 1) * E[0] * 1.7;
    pts[4 * i + 1] = (rnd() * 2 - 1) * E[1] * 1.7;
    pts[4 * i + 2] = (rnd() * 2 - 1) * E[2] * 1.7;
  }
  return { key: k, fn: P.fn, glsl: P.glsl, name: P.name, d, r, pts };
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
});
const page = await browser.newPage();
await page.goto('about:blank');

const got = await page.evaluate(({ cases, N }) => {
  const cv = document.createElement('canvas');
  cv.width = N; cv.height = N;
  const gl = cv.getContext('webgl2');
  if (!gl) return { error: 'no webgl2' };
  if (!gl.getExtension('EXT_color_buffer_float')) return { error: 'no float render target' };

  const VS = `#version 300 es
const vec2 v[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
void main(){ gl_Position = vec4(v[gl_VertexID], 0.0, 1.0); }`;

  const results = {};
  for (const c of cases) {
    const FS = `#version 300 es
precision highp float;
out vec4 outc;
uniform sampler2D uPts;
uniform vec3 uD;
uniform float uR;
${c.glsl}
void main(){
  vec3 p = texelFetch(uPts, ivec2(gl_FragCoord.xy), 0).xyz;
  outc = vec4(${c.fn}(p, uD, uR), 0.0, 0.0, 1.0);
}`;
    const mk = (t, src) => {
      const s = gl.createShader(t);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { results[c.key] = { compileError: String(e.message || e) }; continue; }

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N, N, 0, gl.RGBA, gl.FLOAT,
                  new Float32Array(c.pts));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const out = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, out);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N, N, 0, gl.RGBA, gl.FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);

    gl.viewport(0, 0, N, N);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uPts'), 0);
    gl.uniform3f(gl.getUniformLocation(prog, 'uD'), c.d[0] || 0, c.d[1] || 0, c.d[2] || 0);
    gl.uniform1f(gl.getUniformLocation(prog, 'uR'), c.r);
    gl.bindVertexArray(gl.createVertexArray());
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const px = new Float32Array(N * N * 4);
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, px);
    const vals = new Array(N * N);
    for (let i = 0; i < N * N; i++) vals[i] = px[4 * i];
    results[c.key] = { vals };
  }
  return { results };
}, { cases: cases.map(c => ({ ...c, pts: Array.from(c.pts) })), N });

await browser.close();

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
};

if (got.error) { console.error(`check-glsl: ${got.error}`); process.exit(1); }
console.log(`SinterForm GLSL/JS twins — ${N * N} points each\n`);

for (const c of cases) {
  const R = got.results[c.key];
  if (!R || R.compileError) {
    ok(false, `${c.name}: shader failed to compile — ${R && R.compileError}`);
    continue;
  }
  const tol = LOOSE[c.key] || TOL;
  let worst = 0, bad = 0, whereJs = 0, whereGl = 0, whereP = null;
  for (let i = 0; i < N * N; i++) {
    const p = [c.pts[4 * i], c.pts[4 * i + 1], c.pts[4 * i + 2]];
    const j = SF.PRIMS[c.key].js(p, c.d, c.r, { fi: 0 });
    const g = R.vals[i];
    const diff = Math.abs(j - g);
    if (diff > worst) { worst = diff; whereJs = j; whereGl = g; whereP = p; }
    if (diff > tol) bad++;
  }
  ok(bad === 0, `${c.name}: GLSL matches JS (worst ${worst.toExponential(2)} mm`
    + `${LOOSE[c.key] ? `, transcendental bar ${tol}` : ''})`
    + (bad ? ` — ${bad}/${N * N} over ${tol} mm; at `
      + `[${whereP.map(v => v.toFixed(2))}] js ${whereJs.toFixed(4)} `
      + `vs glsl ${whereGl.toFixed(4)}` : ''));
}

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'all good'}`);
process.exit(fail ? 1 : 0);
