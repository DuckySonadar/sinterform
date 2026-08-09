# SinterForm

A signed-distance geometry kernel for solid modelling: primitives, booleans
with smooth blends, baked distance fields, a surface-nets mesher and binary
STL output. Dependency-free JavaScript.

| file | what |
| --- | --- |
| `sinterform.js` | the kernel — geometry, and nothing that knows a GPU exists |
| `glsl.js` | the shader half of each primitive, and the two shader budgets |
| `sketch.js` | constrained 2D sketching → profiles → a 2D distance field |

They are separate because they are used separately: a mesher, a slicer or a
test wants the first and not the second.

It computes geometry and hands it back. There is no DOM in it, no WebGL, no
storage, no state belonging to whatever is using it — which is what makes it
runnable from node, testable without a browser, and liftable into a project
that looks nothing like the one it grew up in.

It was extracted from [MetaMeld][mm], a single-file SDF modeller for 3D
printing, and that is still its main consumer: MetaMeld inlines this file into
its one shipped HTML file at build time.

[mm]: https://github.com/DuckySonadar/mywebsiterepository-Iknowtotallyoriginal

## Conventions

Fixed throughout, and worth reading before the API:

- **Millimetres.** Every length — coordinates, dimensions, blend radii, mesh
  resolution — is in millimetres. There is no unit setting.
- **+Z is up.**
- **z = 0 is the build plate.** Geometry below it is geometry below the plate;
  the kernel will happily evaluate it, and a printer will not.
- **Rotations are degrees**, as Euler angles applied Rz·Ry·Rx.
- **Distances are signed**: negative inside the solid, zero on the surface,
  positive outside.

## Using it

```js
const SinterForm = require('./sinterform.js');   // or <script> it, see below
```

The file assigns `module.exports` when there is a `module`, and otherwise puts
`SinterForm` on the global object. Nothing else — no ESM build, no bundler
step, no `package.json` dependencies.

### Shapes

A **shape** is a plain object. Nothing is a class and nothing is validated;
these are the fields the kernel reads:

| field | meaning |
| --- | --- |
| `t` | primitive key — one of `PRIM_KEYS` |
| `p` | `[x, y, z]` position, mm |
| `r` | `[rx, ry, rz]` rotation, degrees |
| `d` | dimensions, meaning set by the primitive (`PRIMS[t].dims`) |
| `op` | `'add'`, `'cut'` or `'keep'` (intersect) |
| `k` | blend radius in mm; `0` is a hard edge |
| `round` | corner rounding in mm, on primitives with `PRIMS[t].round` |
| `on` | `false` hides it from bounds; callers usually filter these out first |
| `b` | which body it belongs to |
| `mx`, `my`, `mz` | mirror across that axis (evaluates at `abs` of the coordinate) |
| `fi` | which baked field, for `t: 'field'` |

Shapes fold in order: each one is combined with the running distance so far,
so a `cut` removes what is already there and the order of the list matters.

### Bodies

A **body** is one buildable part. Bodies fold onto their *own* running
distance and then meet in a plain `min`, so nothing blends across the boundary
between two parts that are meant to print separately.

A **plan** — what `sceneSDF` takes — is that grouping made explicit:

```js
const plan = [
  { id: 0, nodes: [ /* shapes of body 0 */ ] },
  { id: 1, nodes: [ /* shapes of body 1 */ ] }
];
```

### The API

```js
sceneSDF(plan, x, y, z) → number
```
Signed distance to the whole scene at a point, in mm. This is the JS side of
each primitive; `glsl.js` holds the GLSL side, and `check-glsl.mjs` is what
keeps the two in step now that they no longer share a file.

```js
sceneBounds(nodes) → { lo: [x, y, z], hi: [x, y, z] } | null
```
Axis-aligned bounds, in mm, of everything that *adds* material — takes a flat
shape list, not a plan. `null` when nothing does. It returns `lo`/`hi`, not
`x0`/`x1`.

```js
surfaceNets(vol, nx, ny, nz, ox, oy, oz, res) → { positions, indices }
```
Meshes a sampled grid. `vol` is a `Float32Array` of `nx*ny*nz` signed
distances in `x`-major order (`vol[(i*ny + j)*nz + k]`), `o*` is the world
position of sample `(0,0,0)` and `res` the spacing, all mm. Returns a
`Float32Array` of positions and a `Uint32Array` of triangle indices. The
cell-to-vertex map is kept sparse — at print resolution a dense one costs
hundreds of megabytes to hold the ~1% of cells the surface crosses.

```js
meshToSTL(mesh, header) → Blob
```
Binary STL. `header` is truncated to the 80 bytes the format allows.

```js
smin(a, b, k) · smax(a, b, k)
```
Polynomial smooth min and max, the blend behind `k`. Both fall back to plain
`Math.min`/`Math.max` when `k <= 0`.

```js
invRot(x, y, z, euler, out) → out
```
World → local for a shape rotated Rz·Ry·Rx. `euler` is in **radians** here
(multiply degrees by the exported `RAD`); writes into `out` and returns it,
because it runs once per shape per sample.

### Tables

`PRIMS` maps a key to a primitive: display `name`, its `dims`, defaults, a
`js` implementation, and `ext` for bounds. `PRIM_KEYS` is its key list, `OPS`
the boolean operations with labels, and `RAD` is `π/180`.

The GLSL twin of each primitive lives in **`glsl.js`**, keyed the same way:

```js
const GL = require('./glsl.js');
GL.library(PRIM_KEYS)                       // the whole primitive function set
GL.call('box', 'q', 'uD[5].xyz', 'uD[4].w') // → "pBox(q, uD[5].xyz, uD[4].w)"
GL.samplerDecls(4)                          // sampler3D declarations, 4 of them
```

`GL.call` knows the sampler-first calling convention baked primitives use, so
a consumer does not have to. The uniform *expressions* are the caller's, which
is what keeps the packing out of here.

**No budgets live in this repository.** How many shapes fit in the uniforms
and how many fields fit in texture units belong to whoever packs them — a
consumer using an SSBO has neither limit — so they are arguments rather than
constants. MetaMeld's own numbers are 32 shapes at 3 vec4 each, and 4 fields.

A dim is `[label, min, max, step, unit?]`. **No unit means millimetres, and
millimetres are the only thing that scales** — multiplying a shape by 1.5 has
to leave a hexagon a hexagon and a 90° arc a 90° arc. Ask `dimIsLength(t, i)`
and `dimUnit(t, i)` rather than keeping your own list of exceptions.

`exact: false` marks a primitive whose function is a safe *bound* rather than
a true distance — currently only the ellipsoid. It matters more than it
sounds: a raymarcher folds every shape into one `min`, so the loosest
primitive in the library sets the step size for every ray in the scene.
`check-primitives.mjs` prints the maximum safe step the set implies.

To add a primitive, add a `js` entry in `sinterform.js` and a `glsl.js` entry
with the same key. They must agree; a mismatch shows up as a preview that
disagrees with the exported mesh. They used to sit side by side in one file,
which was the only thing keeping them in step — now `check-glsl.mjs` is, and
it also refuses a primitive present in one file and missing from the other.

### Baked fields

A shape too complicated to describe with primitives can arrive as its distance
field instead, sampled on a grid — enough to cut against, blend with and mesh.
Samples are one byte each across ±`range` mm.

```js
SinterForm.fields = [ /* field objects */ ];   // library, max MAXFIELDS
decodeField(f) · encodeField(f) · sampleField(f, x, y, z)
```

**`fields` is a getter/setter pair, not a value.** The kernel reads it every
time it evaluates a `field` primitive, and a consumer typically replaces the
whole array when it loads or imports a document. Assign to
`SinterForm.fields`; do not capture it into a local and expect writes through
that local to be seen. A copied reference leaves the two sides looking at
different arrays, and the symptom — a baked shape rendering as the one you
opened before — is slow to trace back here.

## Sketches (`sketch.js`)

A separate, self-contained module: lines, elliptical arcs and NURBS in 2D,
with the constraints that hold them together and a solver that satisfies them.
Same charter — no DOM, no GL — and no dependency on `sinterform.js`.

```js
const { Sketch } = require('./sketch.js');
const S = new Sketch();
const a = S.point(0, 0, { fixed: true });
const b = S.point(10, 3);
const ln = S.line(a, b);
S.constrain('horizontal', { e: ln });
S.constrain('distance', { p: a }, { p: b }, 20);
S.solve();            // → { converged, dof, rank, redundant, conflicting, … }
S.get(b);             // → { kind: 'point', x: 20, y: 0, fixed: false, … }
```

Constraints: `coincident`, `concentric`, `centre`, `collinear`, `parallel`,
`perpendicular`, `tangent`, `equal`, `circular`, `on`, `horizontal`,
`vertical`, `distance`, `radius`, `angle`.

The design turns on one thing. A constraint touching a curve has to know
*where* it touches, and that is not knowable in advance — it moves as the
sketch solves. So contact parameters are solver variables, which lets
`perpendicular` take any two **direction sources** and not care which is
which: line to line, line to arc tangent, line to spline tangent and spline to
spline all run through the same three lines of code. Sketchers that keep the
contact point implicit cannot express the question, which is why they tend to
offer perpendicular between two lines and leave splines out.

**Angles here are radians**, unlike a node's rotation in `sinterform.js`,
which is degrees because it comes from a slider. Convert at the boundary.

📖 **[SKETCH.md](SKETCH.md) is the full API reference** — entities,
constraints, the solve report, reading and editing, serialisation, and the two
characteristics worth knowing about before relying on it.

```
node check-sketch.mjs      # 110 assertions
```

## Inlining it into HTML

The kernel is written to survive being pasted between `<script>` tags, which
is how MetaMeld ships as one file that opens from `file://`.

That imposes one rule: **nothing in this file may spell a literal closing
script tag, not even inside a comment.** HTML ends the element on those
characters wherever they appear, and the page after it becomes text. This has
happened once already. `check-kernel.mjs` asserts it.

## Tests

Three, each answering a different question. All exit 0 or 1.

### `check-kernel.mjs` — is the seam intact?

```
node check-kernel.mjs             # checks sinterform.js
node check-kernel.mjs some.html   # checks the <script id="sinterform"> in it
```

27 assertions. Refuses the kernel if it names anything browser-shaped, runs it
under node with no DOM at all, and asks it for geometry whose answer is known.

The HTML form is there so a project that inlines the kernel can check the file
its build actually produced, using these assertions rather than a second copy
of them that drifts.

### `check-primitives.mjs` — is each primitive really a distance function?

```
node check-primitives.mjs
```

Per primitive: that it encloses something, that `ext()` really does contain it
(a short box silently crops an exported mesh, which is the slowest of these to
notice), that it is 1-Lipschitz so a step of it can never cross the surface,
and — unless marked `exact: false` — that `|∇f| = 1`.

The last two are the ones that bite quietly. A primitive that over-estimates
distance looks perfectly fine on screen and makes the marcher tunnel through
thin features *somewhere else in the scene*. The run ends by printing the
loosest primitive and the maximum safe raymarch step it implies.

### `check-glsl.mjs` — do the GLSL and JS twins agree?

```
node check-glsl.mjs            # skips, loudly, if Playwright is absent
node check-glsl.mjs --require  # what CI should run
```

Compiles the real GLSL on a real GPU, evaluates every primitive at 4096
points, and compares against the JS at the same points. First it checks the
two files describe the same set of primitives at all.

This matters more since the split than it did before: the twins no longer sit
next to each other, so nothing but this notices when they drift.

It needs Playwright and a browser. The kernel does not depend on either and
does not intend to, so without them the check reports that it skipped and
exits 0 — `--require` makes that fatal instead.

Note that GLSL ES only promises its transcendentals to about 2⁻¹¹ relative, so
primitives whose fold goes through `atan` carry a small angle error the JS twin
does not. The prism is held to a looser bar for that reason; at a 40 mm radius
it is ~0.007 mm, two orders under the finest thing this prints.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

If you redistribute this — including inlined into a larger file — §4 asks you
to keep the attribution and include the licence. MetaMeld's build script does
that automatically rather than relying on anyone remembering.

The name *MetaMeld* is a reserved trademark of that project and is deliberately
not part of this one; this kernel has no "Meld" in it so the boundary stays
clean.
