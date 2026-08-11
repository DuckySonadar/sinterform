/* Generate the JS twins from the GLSL, which is the definition.
 *
 *     node build-twins.mjs            rewrite the generated block in sinterform.js
 *     node build-twins.mjs --check    exit 1 if the file is stale (CI)
 *
 * The kernel is two halves that have to agree. They used to be two hand-written
 * halves, and the whole of check-glsl.mjs existed to catch them drifting -- a
 * drift alarm rather than a proof. It had already missed one: pCone divides by
 * dot(k2, k2) unguarded while its JS twin wrote `|| 1e-9`, a real difference in
 * a degenerate case the random-point comparison never lands on.
 *
 * So the GLSL is now canonical and the JS is derived from it. This file is the
 * derivation: a parser for the subset of GLSL ES 3.0 the primitives actually
 * use, and an emitter that scalarises it into JavaScript. check-glsl.mjs keeps
 * its job but changes its meaning -- it is no longer asking whether two authors
 * agreed, it is asking whether this translation is faithful.
 *
 * The subset is small because the primitives are small: float/vec2/vec3, no
 * loops, twelve builtins. Anything outside it is a parse error rather than a
 * silent mistranslation, which is the property that matters -- a primitive that
 * cannot be translated must not quietly get a wrong twin.
 *
 * Nothing is excluded. Two primitives read data rather than computing from
 * their dims -- `field` samples a grid, `profile` walks an outline -- and the
 * one thing a shader and JavaScript genuinely cannot share is how they reach
 * that data: one asks a sampler, the other indexes an array. So those reads,
 * and only those, are INTRINSICS: named GLSL functions declared here to have a
 * JS counterpart instead of being translated. Everything around them -- the
 * box union, the slab, the crossing count, the nearest-edge search -- is
 * ordinary GLSL and is generated like everything else.
 *
 * That is the whole of the seam, and it is two functions wide. An intrinsic
 * must be declared below; an undeclared call is an error, so the seam cannot
 * widen by accident.
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));

// The seam. `js` is the JavaScript that replaces a call to the GLSL function
// of that name; `$0`, `$1`, ... are its arguments, already emitted. `t` is what
// the call returns, so the rest of the expression still type-checks.
//
// `opaque` names parameter types that carry no components -- a sampler is a
// handle, not a number -- and `bind` says what that handle is in JavaScript.
// This is where `fields` and `profiles` enter: the shader is handed a texture
// unit or a compiled-in outline by its call site, and the JS twin is handed
// the node and looks the same data up itself.
const INTRINSICS = {
  fieldSample: { t: 'float', js: 'sampleFieldUVW($0, $1, $2, $3)' },
  edgeCount:   { t: 'int',   js: 'edgeCount($0)' },
  segCount:    { t: 'int',   js: 'segCount($0)' },
  segA:        { t: 'vec3',  js: ['segAx($0, $1)', 'segAy($0, $1)', 'segAz($0, $1)'] },
  segB:        { t: 'vec3',  js: ['segBx($0, $1)', 'segBy($0, $1)', 'segBz($0, $1)'] },
  segR:        { t: 'vec2',  js: ['segRA($0, $1)', 'segRB($0, $1)'] },
  // one JS expression per component, so a vec2 intrinsic does not have to be
  // called twice to be taken apart
  swCount:     { t: 'int',   js: 'swCount($0)' },
  swA:    { t: 'vec3', js: ['swf($0,$1,0)', 'swf($0,$1,1)', 'swf($0,$1,2)'] },
  swT:    { t: 'vec3', js: ['swf($0,$1,3)', 'swf($0,$1,4)', 'swf($0,$1,5)'] },
  swU:    { t: 'vec3', js: ['swf($0,$1,6)', 'swf($0,$1,7)', 'swf($0,$1,8)'] },
  swV:    { t: 'vec3', js: ['swf($0,$1,9)', 'swf($0,$1,10)', 'swf($0,$1,11)'] },
  swK:    { t: 'vec2', js: ['swf($0,$1,12)', 'swf($0,$1,13)'] },
  swTurn: { t: 'vec2', js: ['swf($0,$1,14)', 'swf($0,$1,15)'] },
  swLS:   { t: 'vec3', js: ['swf($0,$1,16)', 'swf($0,$1,17)', 'swf($0,$1,18)'] },
  swE:    { t: 'vec2', js: ['swf($0,$1,19)', 'swf($0,$1,20)'] },
  swMisc: { t: 'vec3', js: ['swf($0,$1,21)', 'swf($0,$1,22)', 'swf($0,$1,23)'] },
  swCaps: { t: 'vec3', js: ['swf($0,$1,24)', 'swf($0,$1,25)', 'swf($0,$1,26)'] },
  swKind: { t: 'float', js: 'swf($0,$1,27)' },
  swSect: { t: 'vec3', js: ['swf($0,$1,28)', 'swf($0,$1,29)', 'swf($0,$1,30)'] },
  // `keep` marks an intrinsic that stays a *call* on the GLSL side instead of
  // becoming unrolled data: the polygon section is a whole 2D sketch, and GLSL
  // cannot turn a slot number into a function name, so glsl.js emits a small
  // dispatcher over the profile slots and this calls it.
  sectionPoly: { t: 'float', keep: true, js: 'sectionPoly($0, $1, $2)' },
  edgeA:       { t: 'vec2',  js: ['edgeAx($0, $1)', 'edgeAy($0, $1)'] },
  edgeB:       { t: 'vec2',  js: ['edgeBx($0, $1)', 'edgeBy($0, $1)'] }
};
// `$node` rather than `n`: a GLSL local may legitimately be called `n`, and a
// generated `let n` beside a parameter `n` is a SyntaxError rather than a
// wrong answer -- but only by luck, so the name is put out of reach instead.
const NODE_ARG = '$node';
const OPAQUE = {
  sampler3D: `fields[(${NODE_ARG} && ${NODE_ARG}.fi) || 0]`,
  outline:   `profiles[(${NODE_ARG} && ${NODE_ARG}.fi) || 0]`,
  polyline:  `wires[(${NODE_ARG} && ${NODE_ARG}.fi) || 0]`,
  sweeppath: `sweeps[(${NODE_ARG} && ${NODE_ARG}.fi) || 0]`
};

// ---------------------------------------------------------------- tokens ----
const PUNC = ['<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=',
              '{', '}', '(', ')', ',', ';', '.', '?', ':',
              '+', '-', '*', '/', '<', '>', '=', '!'];

function lex(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9.eE]/.test(src[j])) {
        if ((src[j] === 'e' || src[j] === 'E') && /[+-]/.test(src[j + 1] || '')) j++;
        j++;
      }
      out.push({ k: 'num', v: src.slice(i, j) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    const op = PUNC.find(o => src.startsWith(o, i));
    if (!op) throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
    out.push({ k: 'op', v: op }); i += op.length;
  }
  out.push({ k: 'eof', v: '' });
  return out;
}

// ---------------------------------------------------------------- parser ----
// Straight recursive descent; the expression half is precedence climbing. The
// AST is deliberately dumb -- types are worked out during emission, where the
// scope is, rather than in a pass of its own.
const TYPES = new Set(['float', 'vec2', 'vec3', 'void', 'bool', 'int']);
// GLSL ES 3.00 keywords that are legal JavaScript identifiers, so a name like
// `out` translates cleanly and then fails to compile as a shader. Caught here
// instead: a parse error at generation beats a shader error at run time.
const RESERVED_GLSL = new Set([
  'in', 'out', 'inout', 'uniform', 'varying', 'attribute', 'const', 'centroid',
  'flat', 'smooth', 'layout', 'precision', 'invariant', 'discard', 'sample',
  'patch', 'subroutine', 'buffer', 'shared', 'coherent', 'volatile',
  'restrict', 'readonly', 'writeonly', 'noperspective', 'lowp', 'mediump',
  'highp', 'struct', 'switch', 'case', 'default', 'do', 'while', 'break',
  'continue', 'true', 'false'
]);
const BIN = [['||', 1], ['&&', 2], ['==', 3], ['!=', 3],
             ['<', 4], ['>', 4], ['<=', 4], ['>=', 4],
             ['+', 5], ['-', 5], ['*', 6], ['/', 6]];
const PREC = new Map(BIN);

function parse(src) {
  const ts = lex(src);
  let at = 0;
  const peek = (n) => ts[at + (n || 0)];
  const next = () => ts[at++];
  const is = (k, v) => peek().k === k && (v === undefined || peek().v === v);
  const eat = (k, v) => {
    if (!is(k, v)) throw new Error(`expected ${v || k}, got ${JSON.stringify(peek().v)}`);
    return next();
  };

  function primary() {
    if (is('op', '(')) { next(); const e = expr(); eat('op', ')'); return e; }
    if (is('op', '-')) { next(); return { n: 'neg', a: unary() }; }
    if (is('op', '!')) { next(); return { n: 'not', a: unary() }; }
    if (is('num')) return { n: 'num', v: next().v };
    if (is('id')) {
      const name = next().v;
      if (is('op', '(')) {
        next();
        const args = [];
        if (!is('op', ')')) { args.push(expr()); while (is('op', ',')) { next(); args.push(expr()); } }
        eat('op', ')');
        return { n: 'call', f: name, args };
      }
      return { n: 'var', v: name };
    }
    throw new Error(`unexpected ${JSON.stringify(peek().v)} in expression`);
  }

  function unary() {
    let e = primary();
    while (is('op', '.')) { next(); e = { n: 'swz', a: e, s: eat('id').v }; }
    return e;
  }

  function binary(minPrec) {
    let lhs = unary();
    for (;;) {
      if (!is('op') || !PREC.has(peek().v)) break;
      const op = peek().v, prec = PREC.get(op);
      if (prec < minPrec) break;
      next();
      const rhs = binary(prec + 1);
      lhs = { n: 'bin', o: op, a: lhs, b: rhs };
    }
    return lhs;
  }

  function expr() {
    const c = binary(1);
    if (is('op', '?')) {
      next();
      const a = expr(); eat('op', ':');
      const b = expr();
      return { n: 'tern', c, a, b };
    }
    return c;
  }

  // `i++` or an ordinary assignment, with no trailing semicolon
  function forStep() {
    const lv = lvalue();
    if (is('op', '+') && peek(1).k === 'op' && peek(1).v === '+') {
      next(); next();
      return { n: 'assign', lv, op: '+=', e: { n: 'num', v: '1' } };
    }
    const op = eat('op').v;
    if (!['=', '+=', '-=', '*=', '/='].includes(op))
      throw new Error(`expected an assignment in the for step, got ${op}`);
    return { n: 'assign', lv, op, e: expr() };
  }

  function lvalue() {
    const name = eat('id').v;
    let s = null;
    if (is('op', '.')) { next(); s = eat('id').v; }
    return { name, s };
  }

  function statement() {
    if (is('op', '{')) {
      next();
      const body = [];
      while (!is('op', '}')) body.push(statement());
      eat('op', '}');
      return { n: 'block', body };
    }
    if (is('id', 'return')) { next(); const e = expr(); eat('op', ';'); return { n: 'ret', e }; }
    // for (init; test; step) body -- the only loop the primitives need, and
    // deliberately the only one accepted: a while would let a translated
    // primitive fail to terminate in a way the GLSL would not.
    if (is('id', 'for')) {
      next(); eat('op', '(');
      const init = statement();               // consumes its own ';'
      const test = expr(); eat('op', ';');
      const step = forStep(); eat('op', ')');
      return { n: 'for', init, test, step, body: statement() };
    }
    if (is('id', 'if')) {
      next(); eat('op', '(');
      const c = expr(); eat('op', ')');
      const then = statement();
      let els = null;
      if (is('id', 'else')) { next(); els = statement(); }
      return { n: 'if', c, then, els };
    }
    if (is('id') && TYPES.has(peek().v) && peek(1).k === 'id') {
      const t = next().v;
      const decls = [];
      for (;;) {
        const name = eat('id').v;
        if (RESERVED_GLSL.has(name))
          throw new Error(`\`${name}\` is a GLSL keyword and cannot be a variable`);
        let init = null;
        if (is('op', '=')) { next(); init = expr(); }
        decls.push({ name, init });
        if (is('op', ',')) { next(); continue; }
        break;
      }
      eat('op', ';');
      return { n: 'decl', t, decls };
    }
    const lv = lvalue();
    const op = eat('op').v;
    if (!['=', '+=', '-=', '*=', '/='].includes(op))
      throw new Error(`expected an assignment, got ${op}`);
    const e = expr();
    eat('op', ';');
    return { n: 'assign', lv, op, e };
  }

  // A source may hold more than one function -- an intrinsic's own GLSL body
  // sits beside the primitive that calls it. Every definition is parsed; the
  // caller picks the one it wants and skips the intrinsics.
  const fns = [];
  while (!is('eof')) {
    const ret = eat('id').v;
    if (!TYPES.has(ret)) throw new Error(`expected a return type, got ${ret}`);
    const fname = eat('id').v;
    eat('op', '(');
    const params = [];
    if (!is('op', ')')) {
      for (;;) {
        const t = eat('id').v, name = eat('id').v;
        params.push({ t, name });
        if (is('op', ',')) { next(); continue; }
        break;
      }
    }
    eat('op', ')');
    eat('op', '{');
    const body = [];
    while (!is('op', '}')) body.push(statement());
    eat('op', '}');
    fns.push({ fname, ret, params, body });
  }
  return fns;
}

// --------------------------------------------------------------- emitter ----
// A value is its type and one JS expression per component. Everything is
// scalarised: `vec3 q` becomes q_0, q_1, q_2, which is what the hand-written
// twins did by eye and is the only reason they were readable.
const WIDTH = { float: 1, vec2: 2, vec3: 3, bool: 1, int: 1 };
const SWZ = { x: 0, y: 1, z: 2, r: 0, g: 1, b: 2 };

function emit(fn, helpers, flatParams) {
  // The JS side of a translated function returns one number. A vector-returning
  // one would have to return an array, which is an allocation per call -- so it
  // is refused here rather than generated badly, and stays hand-written.
  if (fn.ret && fn.ret !== 'float')
    throw new Error(`returns ${fn.ret}; only float translates to a JS twin`);
  const lines = [];
  const scope = new Map();
  let tmp = 0;
  const fresh = () => `t${tmp++}`;

  const val = (t, parts) => ({ t, p: parts });
  let depth = 2;                       // indent that `hold` writes at
  const wide = (t) => WIDTH[t];

  // bind an expression's components to fresh consts, so a value used twice --
  // or an assignment whose right side reads its own target -- is safe
  function hold(v) {
    if (v.p.every(s => /^[A-Za-z_$][\w$]*$/.test(s) || /^-?[\d.]+$/.test(s))) return v;
    const names = v.p.map(() => fresh());
    lines.push('  '.repeat(depth)
      + `const ${names.map((n, i) => `${n} = ${v.p[i]}`).join(', ')};`);
    return val(v.t, names);
  }

  // Widen a scalar against a vector operand, GLSL's broadcast rule. The scalar
  // is bound first: `k2*clamp(...)` would otherwise paste that clamp into every
  // component, and the mesher evaluates these once per grid corner.
  function pair(a, b) {
    const n = Math.max(wide(a.t), wide(b.t));
    const t = n === 1 ? 'float' : n === 2 ? 'vec2' : 'vec3';
    const sp = (v) => {
      if (wide(v.t) !== 1) return v.p;
      return new Array(n).fill(n === 1 ? v.p[0] : hold(v).p[0]);
    };
    return { t, a: sp(a), b: sp(b) };
  }

  const NUM = (s) => (s.includes('.') || /[eE]/.test(s)) ? s : s;
  const M1 = { abs: 'Math.abs', sqrt: 'Math.sqrt', sin: 'Math.sin',
               cos: 'Math.cos', floor: 'Math.floor', sign: 'Math.sign' };

  function ex(node) {
    switch (node.n) {
      case 'num': return val('float', [NUM(node.v)]);
      case 'var': {
        if (node.v === 'true' || node.v === 'false') return val('bool', [node.v]);
        const v = scope.get(node.v);
        if (!v) throw new Error(`unknown identifier ${node.v}`);
        return val(v.t, v.names.slice());
      }
      case 'neg': { const a = ex(node.a); return val(a.t, a.p.map(s => `(-${s})`)); }
      case 'not': { const a = ex(node.a); return val('bool', [`(!${a.p[0]})`]); }
      case 'swz': {
        const a = ex(node.a);
        const idx = [...node.s].map(c => {
          if (!(c in SWZ)) throw new Error(`bad swizzle .${node.s}`);
          return SWZ[c];
        });
        const t = idx.length === 1 ? 'float' : idx.length === 2 ? 'vec2' : 'vec3';
        return val(t, idx.map(i => a.p[i]));
      }
      case 'tern': {
        const c = hold(ex(node.c));
        const a = ex(node.a), b = ex(node.b);
        const w = pair(a, b);
        return val(w.t, w.a.map((s, i) => `(${c.p[0]} ? ${s} : ${w.b[i]})`));
      }
      case 'bin': {
        const a = ex(node.a), b = ex(node.b);
        if (['&&', '||'].includes(node.o))
          return val('bool', [`(${a.p[0]} ${node.o} ${b.p[0]})`]);
        if (['<', '>', '<=', '>=', '==', '!='].includes(node.o))
          return val('bool', [`(${a.p[0]} ${node.o} ${b.p[0]})`]);
        const w = pair(a, b);
        return val(w.t, w.a.map((s, i) => `(${s} ${node.o} ${w.b[i]})`));
      }
      case 'call': return call(node);
      default: throw new Error(`cannot emit ${node.n}`);
    }
  }

  function call(node) {
    const f = node.f;
    // the seam: a declared intrinsic is substituted, not translated
    if (f in INTRINSICS) {
      const spec = INTRINSICS[f];
      const A = node.args.map(a => ex(a).p[0]);
      const sub = (s) => s.replace(/\$(\d+)/g, (_, i) => {
        if (A[+i] === undefined) throw new Error(`${f}() wants argument ${i}`);
        return A[+i];
      });
      const parts = (Array.isArray(spec.js) ? spec.js : [spec.js]).map(sub);
      if (parts.length !== WIDTH[spec.t])
        throw new Error(`intrinsic ${f} declares ${spec.t} but gives ${parts.length} parts`);
      return val(spec.t, parts);
    }
    // constructors: flatten every argument's components, then take or splat
    if (f === 'vec2' || f === 'vec3') {
      const n = f === 'vec2' ? 2 : 3;
      const flat = [];
      for (const a of node.args) flat.push(...ex(a).p);
      if (flat.length === 1) return val(f, new Array(n).fill(flat[0]));
      if (flat.length !== n) throw new Error(`${f} given ${flat.length} components`);
      return val(f, flat);
    }
    const A = node.args.map(ex);
    if (f === 'length') {
      const v = A[0];
      return val('float', [v.p.length === 1 ? `Math.abs(${v.p[0]})`
                                            : `Math.hypot(${v.p.join(', ')})`]);
    }
    if (f === 'dot') {
      const w = pair(A[0], A[1]);
      return val('float', [`(${w.a.map((s, i) => `${s}*${w.b[i]}`).join(' + ')})`]);
    }
    if (f in M1) {
      const v = A[0];
      return val(v.t, v.p.map(s => `${M1[f]}(${s})`));
    }
    if (f === 'min' || f === 'max') {
      const w = pair(A[0], A[1]);
      const g = f === 'min' ? 'Math.min' : 'Math.max';
      return val(w.t, w.a.map((s, i) => `${g}(${s}, ${w.b[i]})`));
    }
    if (f === 'clamp') {
      // three-way broadcast, so clamp(v, 0.0, 1.0) widens the bounds
      const n = Math.max(...A.map(v => wide(v.t)));
      const t = n === 1 ? 'float' : n === 2 ? 'vec2' : 'vec3';
      const sp = (v) => wide(v.t) === 1 ? new Array(n).fill(v.p[0]) : v.p;
      const [x, lo, hi] = A.map(sp);
      return val(t, x.map((s, i) => `Math.min(Math.max(${s}, ${lo[i]}), ${hi[i]})`));
    }
    if (f === 'mix') {
      const n = Math.max(...A.map(v => wide(v.t)));
      const t = n === 1 ? 'float' : n === 2 ? 'vec2' : 'vec3';
      const sp = (v) => wide(v.t) === 1 ? new Array(n).fill(v.p[0]) : v.p;
      const [x, y, aa] = A.map(sp);
      return val(t, x.map((c, i) => `(${c} + (${y[i]} - ${c})*${aa[i]})`));
    }
    if (f === 'atan') {
      if (A.length === 2) return val('float', [`Math.atan2(${A[0].p[0]}, ${A[1].p[0]})`]);
      return val('float', [`Math.atan(${A[0].p[0]})`]);
    }
    if (f === 'mod') {
      // GLSL mod is a floored modulus, which is not JS `%` for negative x
      const w = pair(A[0], A[1]);
      return val(w.t, w.a.map((s, i) =>
        `(${s} - ${w.b[i]}*Math.floor(${s}/${w.b[i]}))`));
    }
    // a helper defined in the same source: translated too, and called with
    // its vector arguments flattened into scalars
    const h = (helpers || {})[f];
    if (h) {
      const flat = [];
      for (const a of A) flat.push(...a.p);
      if (flat.length !== h.arity)
        throw new Error(`${f}() wants ${h.arity} components, got ${flat.length}`);
      return val('float', [`${f}(${flat.join(', ')})`]);
    }
    throw new Error(`no JS translation for ${f}()`);
  }

  function stmt(s, indent) {
    depth = indent;
    const pad = '  '.repeat(indent);
    const push = (t) => lines.push(pad + t);
    switch (s.n) {
      case 'decl': {
        for (const d of s.decls) {
          const n = wide(s.t);
          const names = n === 1 ? [d.name] : [0, 1, 2].slice(0, n).map(i => `${d.name}_${i}`);
          if (RESERVED.has(d.name))
            throw new Error(`local \`${d.name}\` would shadow the JS argument of `
              + `the same name -- rename it in the GLSL`);
          if (d.init) {
            const v = ex(d.init);
            if (wide(v.t) !== n && wide(v.t) !== 1)
              throw new Error(`cannot initialise ${s.t} ${d.name} from ${v.t}`);
            const parts = wide(v.t) === 1 ? new Array(n).fill(v.p[0]) : v.p;
            push(`let ${names.map((nm, i) => `${nm} = ${parts[i]}`).join(', ')};`);
          } else {
            push(`let ${names.join(', ')};`);
          }
          scope.set(d.name, { t: s.t, names });
        }
        return;
      }
      case 'assign': {
        const target = scope.get(s.lv.name);
        if (!target) throw new Error(`assignment to unknown ${s.lv.name}`);
        const idx = s.lv.s ? [...s.lv.s].map(c => SWZ[c])
                           : target.names.map((_, i) => i);
        let v = ex(s.e);
        if (wide(v.t) === 1 && idx.length > 1) v = val('float', new Array(idx.length).fill(v.p[0]));
        if (v.p.length !== idx.length)
          throw new Error(`assigning ${v.t} to ${s.lv.name}.${s.lv.s || ''}`);
        // the right side may read the target -- P.xz = P.zx is a swap -- so it
        // is fully evaluated into temps before any component is written
        const held = idx.length > 1 ? hold(v) : v;
        const op = s.op === '=' ? '=' : s.op;
        idx.forEach((slot, i) => push(`${target.names[slot]} ${op} ${held.p[i]};`));
        return;
      }
      case 'ret': {
        const v = ex(s.e);
        push(`return ${v.p[0]};`);
        return;
      }
      case 'if': {
        const c = ex(s.c);
        push(`if (${c.p[0]}) {`);
        stmt(s.then, indent + 1);
        if (s.els) { push(`} else {`); stmt(s.els, indent + 1); }
        push(`}`);
        return;
      }
      case 'for': {
        // The test and step are re-emitted each pass, so anything `hold` binds
        // for them has to land inside the loop rather than before it -- which
        // it does, because stmt() writes in order and these are emitted here.
        const save = lines.length;
        stmt(s.init, indent);
        const initLines = lines.splice(save, lines.length - save);
        const t0 = lines.length;
        const test = ex(s.test);
        const testPre = lines.splice(t0, lines.length - t0);
        if (testPre.length)
          throw new Error('a loop test that needs temporaries is not supported');
        lines.push(...initLines);
        push(`for (; ${test.p[0]};) {`);
        stmt(s.body, indent + 1);
        stmt(s.step, indent + 1);
        push(`}`);
        return;
      }
      case 'block': { for (const b of s.body) stmt(b, indent); return; }
      default: throw new Error(`cannot emit statement ${s.n}`);
    }
  }

  // Parameters are destructured into scalars, because some primitives assign to
  // them -- pOcta writes `p = abs(p)` -- and a component-wise write cannot go
  // back into the caller's array.
  const args = [];
  let needsNode = false;
  const RESERVED = new Set(fn.params.filter(q => WIDTH[q.t] === 1).map(q => q.name)
                           .concat([NODE_ARG]));
  for (const prm of fn.params) {
    // An opaque parameter is a handle to data the shader was handed by its
    // call site -- a texture unit, a compiled-in outline. The JS twin is not
    // handed it; it is handed the node and looks the data up, which is why
    // this is a binding rather than an argument.
    if (prm.t in OPAQUE) {
      needsNode = true;
      lines.push(`const ${prm.name} = ${OPAQUE[prm.t]};`);
      scope.set(prm.name, { t: 'opaque', names: [prm.name] });
      continue;
    }
    const n = wide(prm.t);
    if (!n) throw new Error(`unsupported parameter type ${prm.t}`);
    if (n === 1) { args.push(prm.name); scope.set(prm.name, { t: prm.t, names: [prm.name] }); continue; }
    const names = [0, 1, 2].slice(0, n).map(i => `${prm.name}_${i}`);
    // A primitive is called with arrays, so its vectors are destructured here.
    // A helper is called by generated code, which flattens them at the call
    // site -- so its components arrive as separate arguments already.
    if (flatParams) { args.push(...names); }
    else {
      args.push(prm.name);
      lines.push(`let ${names.map((nm, i) => `${nm} = ${prm.name}[${i}]`).join(', ')};`);
    }
    scope.set(prm.name, { t: prm.t, names });
  }
  // `hold` and the parameter prologue write at depth 0; statements indent
  // themselves, which keeps the generated body readable in a diff.
  const head = lines.splice(0, lines.length).map(l => '    ' + l);
  const bodyLines = [];
  const outer = lines;
  {
    const save = lines.length;
    for (const s of fn.body) stmt(s, 2);
    bodyLines.push(...outer.splice(save, outer.length - save));
  }
  if (needsNode) args.push(NODE_ARG);
  return {
    args,
    body: [...head, ...bodyLines.map(l => l.startsWith('    ') ? l : '    ' + l)].join('\n')
  };
}

// ------------------------------------------------------- the GLSL backend ----
// The second emitter on the same AST. The first turns a primitive into
// JavaScript; this one turns a *slotted* primitive -- one whose shape is a list
// of items on the document -- into the unrolled GLSL a WebGL2 shader can run.
//
// This exists because the unrolled form used to be hand-written beside the
// rolled one: two expressions of the same algorithm, in the same language,
// which is exactly the duplication the JS twins no longer have. Now the rolled
// source is the only statement of what a wire or a profile is, and both the
// JavaScript and the straight-line GLSL are derived from it.
//
// The shape of the output is forced by WebGL2, not chosen: dynamic indexing
// into a const array expands to a select chain per read, so the items become
// straight-line code. What is emitted is the loop body once, as a #define, and
// one invocation per item -- so the *body* is written once here and the data is
// whatever the caller has.
function glslOf(node, subst) {
  const g = (n) => glslOf(n, subst);
  switch (node.n) {
    case 'num': return node.v;
    case 'var': return node.v;
    case 'neg': return `(-${g(node.a)})`;
    case 'not': return `(!${g(node.a)})`;
    case 'swz': return `${g(node.a)}.${node.s}`;
    case 'tern': return `(${g(node.c)} ? ${g(node.a)} : ${g(node.b)})`;
    case 'bin': return `(${g(node.a)} ${node.o} ${g(node.b)})`;
    case 'call': {
      const hit = subst && subst(node);
      if (hit !== undefined && hit !== null) return hit;
      return `${node.f}(${node.args.map(g).join(', ')})`;
    }
    default: throw new Error(`cannot print ${node.n} as GLSL`);
  }
}

function glslStmt(s, subst, pad) {
  const g = (n) => glslOf(n, subst);
  const p = pad || '  ';
  switch (s.n) {
    case 'decl':
      return s.decls.map(d => `${p}${s.t} ${d.name}`
        + (d.init ? ` = ${g(d.init)}` : '') + ';').join('\n');
    case 'assign':
      return `${p}${s.lv.name}${s.lv.s ? '.' + s.lv.s : ''} ${s.op} ${g(s.e)};`;
    case 'ret': return `${p}return ${g(s.e)};`;
    case 'if': {
      let out = `${p}if (${g(s.c)}) {\n${glslStmt(s.then, subst, p + '  ')}\n${p}}`;
      if (s.els) out += ` else {\n${glslStmt(s.els, subst, p + '  ')}\n${p}}`;
      return out;
    }
    case 'block': return s.body.map(b => glslStmt(b, subst, p)).join('\n');
    case 'for':
      throw new Error('a nested loop cannot be unrolled');
    default: throw new Error(`cannot print statement ${s.n} as GLSL`);
  }
}

// Split a slotted primitive into what runs once and what runs per item, and
// name the data each item supplies. The count intrinsic disappears -- after
// unrolling the count is how many invocations were written.
function unroller(key, fn) {
  const loops = fn.body.filter(s => s.n === 'for');
  if (loops.length !== 1)
    throw new Error(`${key}: a slotted primitive needs exactly one loop to unroll`);
  const loop = loops[0];
  const idx = loop.init.decls && loop.init.decls[0] && loop.init.decls[0].name;

  // Every intrinsic read inside the loop becomes a macro parameter. Order is
  // the order they are first met, which is also the order the kernel packs its
  // item data in -- one convention, stated in both places and checked by
  // check-glsl.
  const params = [];
  const seen = new Map();
  const paramOf = (node) => {
    if (!(node.f in INTRINSICS)) return null;
    const spec = INTRINSICS[node.f];
    if (spec.t === 'int') return null;              // the count; gone after unrolling
    if (spec.keep) return null;                     // stays a call in the GLSL
    const tag = `${node.f}(${node.args.map(a => a.n === 'var' ? a.v : '?').join(',')})`;
    if (!seen.has(tag)) {
      const name = node.f.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      seen.set(tag, name);
      params.push({ name, width: WIDTH[spec.t], type: spec.t });
    }
    return seen.get(tag);
  };
  // first pass names them, second prints with the names substituted
  const walk = (s) => {
    const ex = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.n === 'call') { paramOf(n); n.args.forEach(ex); return; }
      for (const k of ['a', 'b', 'c', 'e', 'init']) if (n[k]) ex(n[k]);
      if (n.args) n.args.forEach(ex);
    };
    if (s.n === 'decl') s.decls.forEach(d => d.init && ex(d.init));
    else if (s.n === 'assign') ex(s.e);
    else if (s.n === 'ret') ex(s.e);
    else if (s.n === 'if') { ex(s.c); walk(s.then); if (s.els) walk(s.els); }
    else if (s.n === 'block') s.body.forEach(walk);
  };
  walk(loop.body);

  const subst = (node) => {
    const nm = paramOf(node);
    return nm === null ? undefined : nm;
  };
  const body = glslStmt(loop.body, subst, '  ');

  // Statements outside the loop, minus the count, which no longer exists.
  const outside = (before) => fn.body
    .filter((s, i) => (before ? i < fn.body.indexOf(loop) : i > fn.body.indexOf(loop)))
    .filter(s => !(s.n === 'decl' && s.decls.some(d => d.init && d.init.n === 'call'
                   && d.init.f in INTRINSICS && INTRINSICS[d.init.f].t === 'int')))
    .map(s => glslStmt(s, subst, '  ')).join('\n');

  const args = params.map(p => p.name).join(', ');
  const macro = `#define ITEM(${args}) {\\\n`
    + body.split('\n').map(l => l + ' \\').join('\n').replace(/ \\$/, '') + ' }\n';
  return {
    params, idx,
    pre: outside(true),
    post: outside(false),
    macro,
    stride: params.reduce((a, p) => a + p.width, 0)
  };
}

// A helper defined beside the primitive, printed back out as GLSL. A `spec`
// source is not emitted by `library()`, so anything it calls has to travel
// with the unrolled function instead.
function glslFn(fn) {
  const args = fn.params.map(p => `${p.t} ${p.name}`).join(', ');
  return `float ${fn.fname}(${args}){\n`
    + fn.body.map(st => glslStmt(st, null, '  ')).join('\n') + '\n}\n';
}

// ------------------------------------------------------------------ main ----
const mod = { exports: {} };
new Function('module', readFileSync(join(HERE, 'glsl.js'), 'utf8'))(mod);
const GL = mod.exports;

// The fold's own functions, translated first so a primitive that calls one
// finds it. `invRot` is shader-only: its JS twin writes into a caller-supplied
// array rather than returning one, because sceneSDF calls it once per node per
// sample. FOLD_TWINS says which of them cross.
const foldParts = [];
const foldHelpers = {};
for (const fn of parse(GL.FOLD)) {
  if (!GL.FOLD_TWINS.includes(fn.fname)) continue;
  let o;
  try { o = emit(fn, foldHelpers, true); }
  catch (e) { throw new Error(`FOLD/${fn.fname}: ${e.message}`); }
  foldHelpers[fn.fname] = { arity: o.args.length };
  foldParts.push(`// ${fn.fname} — from GLSL.FOLD\n`
    + `function ${fn.fname}(${o.args.join(', ')}) {\n${o.body}\n}`);
}

const parts = [];
const helperParts = [];
const done = [];
const slots = [];
for (const key of GL.KEYS) {
  const src = GL.GLSL[key].src;
  if (!src || !src.trim()) throw new Error(`${key}: no GLSL source to translate`);
  let fns;
  try { fns = parse(src); } catch (e) { throw new Error(`${key}: ${e.message}`); }
  const want = GL.GLSL[key].fn;
  const fn = fns.find(f => f.fname === want);
  if (!fn) throw new Error(`${key}: no function named ${want} in its source`);

  // Anything else in the source is a helper: translated the same way, called
  // with its vector arguments flattened.
  const helpers = Object.assign({}, foldHelpers);
  for (const h of fns) {
    if (h === fn || h.fname in INTRINSICS) continue;
    let ho;
    try { ho = emit(h, helpers, true); } catch (e) { throw new Error(`${key}/${h.fname}: ${e.message}`); }
    helpers[h.fname] = { arity: ho.args.length };
    helperParts.push(`// ${h.fname} — from GLSL.${key}.src\n`
      + `function ${h.fname}(${ho.args.join(', ')}) {\n${ho.body}\n}`);
  }
  let out;
  try { out = emit(fn, helpers); } catch (e) { throw new Error(`${key}: ${e.message}`); }
  parts.push(`  // ${fn.fname} — from GLSL.${key}.src\n`
    + `  ${key}: (${out.args.join(', ')}) => {\n${out.body}\n  },`);
  done.push(key);

  // A slotted primitive also gets an unrolled GLSL form, from the same AST.
  if (GL.GLSL[key].slotted) {
    let u;
    try { u = unroller(key, fn); } catch (e) { throw new Error(`${key}: ${e.message}`); }
    u.helpers = fns.filter(h => h !== fn && !(h.fname in INTRINSICS)).map(glslFn).join('');
    slots.push({ key, fn: want, u });
  }
}

const q = (t) => JSON.stringify(t);
const unrollBlock = `// ---------------------------------------------------------------------------
// GENERATED by build-twins.mjs from the rolled sources above — do not edit.
//
// A slotted primitive's shape is a list of items on the document, and WebGL2
// cannot index a constant array without expanding every read into a chain of
// selects. So the loop is unrolled: the body once as a macro, one invocation
// per item. This table is that body, taken from the same rolled source the JS
// twin is taken from, so the straight-line GLSL and the JavaScript cannot
// describe different shapes.
//
// \`items\` is a flat array of numbers per slot, \`stride\` of them per item, laid
// out in the order the parameters are listed. \`SinterForm.slotItems(key, obj)\`
// packs exactly that, and supplies a default when a slot is empty — which is
// why no default shape is written down in this file.
// ---------------------------------------------------------------------------
const UNROLL = {
${slots.map(({ key, fn, u }) => `  ${key}: {
    fn: ${q(fn)}, stride: ${u.stride}, arity: [${u.params.map(p => p.width).join(', ')}],
    helpers: ${q(u.helpers || '')},
    pre: ${q(u.pre)},
    macro: ${q(u.macro)},
    post: ${q(u.post)}
  }`).join(',\n')}
};

// One slot's function. \`items\` is what SinterForm.slotItems returned for it.
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
      args.push(w === 1 ? c[0] : \`vec\${w}(\${c.join(',')})\`);
    }
    body += \`  ITEM(\${args.join(',')});\n\`;
  }
  // The helpers the body calls travel with the first slot: a spec source is
  // not emitted by library(), so nothing else declares them.
  return (i === 0 ? U.helpers : '')
    + \`float \${U.fn}\${i}(vec3 p, vec3 d){\n\${U.pre}\n\${U.macro}\${body}#undef ITEM\n\${U.post}\n}\n\`;
}

// Every slot the shader must be able to name. A node may refer to a slot the
// document has not filled in yet, and an undeclared function is a compile
// error rather than an empty shape -- so the caller passes one \`items\` array
// per slot, and SinterForm.slotItems turns an absent entry into the default.
function slotDecls(key, itemsPerSlot, count) {
  const n = Math.max(count | 0, (itemsPerSlot || []).length, 1);
  let s = '';
  for (let i = 0; i < n; i++) s += slotDecl(key, i, (itemsPerSlot || [])[i] || []);
  return s;
}
`;

const block = `// ---------------------------------------------------------------------------
// GENERATED by build-twins.mjs from glsl.js — do not edit by hand.
//
// The GLSL is the definition of each primitive; this is that definition
// translated into JavaScript, so the two halves cannot say different things.
// Run \`node build-twins.mjs\` after changing a primitive's GLSL; check-kernel
// fails if this block is stale, and check-glsl proves the translation is
// faithful by running both on the same points.
// ---------------------------------------------------------------------------
${foldParts.join('\n')}

${helperParts.join('\n')}
const TWINS = {
${parts.join('\n')}
};
`;

function splice(file, markA, markB, text) {
  const path = join(HERE, file);
  const src = readFileSync(path, 'utf8');
  if (!src.includes(markA) || !src.includes(markB))
    throw new Error(`${file} is missing the ${markA} / ${markB} markers`);
  const a = src.indexOf(markA) + markA.length;
  const b = src.indexOf(markB);
  return { path, src, next: src.slice(0, a) + '\n' + text + src.slice(b) };
}

const outs = [
  splice('sinterform.js', '// <<< generated twins', '// >>> generated twins', block),
  splice('glsl.js', '// <<< generated unrollers', '// >>> generated unrollers', unrollBlock)
];

if (process.argv.includes('--check')) {
  const stale = outs.filter(o => o.next !== o.src).map(o => o.path.split('/').pop());
  if (stale.length) {
    console.error(`stale, run: node build-twins.mjs   (${stale.join(', ')})`);
    process.exit(1);
  }
  console.log(`generated code is current (${done.length} twins, ${slots.length} unrollers)`);
  process.exit(0);
}
for (const o of outs) writeFileSync(o.path, o.next);
console.log(`wrote ${done.length} twins and ${slots.length} unrollers `
  + `(${slots.map(s => s.key).join(', ')})`);
