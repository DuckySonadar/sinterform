# SinterForm

A signed-distance geometry kernel for solid modelling: primitives, booleans
with smooth blends, baked distance fields, a surface-nets mesher and binary
STL output. About 470 lines of dependency-free JavaScript.

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
Signed distance to the whole scene at a point, in mm. This is the JS twin of
the GLSL the kernel also emits; the two are written side by side so they stay
in step.

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
`glsl` source string, a `js` twin, and `ext` for bounds. `PRIM_KEYS` is its
key list, `OPS` the boolean operations with labels, `MAXN` the shader's shape
budget, and `RAD` is `π/180`.

A dim is `[label, min, max, step, unit?]`. **No unit means millimetres, and
millimetres are the only thing that scales** — multiplying a shape by 1.5 has
to leave a hexagon a hexagon and a 90° arc a 90° arc. Ask `dimIsLength(t, i)`
and `dimUnit(t, i)` rather than keeping your own list of exceptions.

`exact: false` marks a primitive whose function is a safe *bound* rather than
a true distance — currently only the ellipsoid. It matters more than it
sounds: a raymarcher folds every shape into one `min`, so the loosest
primitive in the library sets the step size for every ray in the scene.
`check-primitives.mjs` prints the maximum safe step the set implies.

To add a primitive, add an entry with both a `glsl` and a `js` implementation.
They must agree; a mismatch shows up as a preview that disagrees with the
exported mesh. `check-glsl.mjs` will tell you.

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
S.solve();   // → { converged, dof, rank, redundant, conflicting, ... }
```

### The contact parameter is a variable

This is the one design decision everything else follows from.

A constraint touching a curve has to know *where* it touches, and that
location is not knowable in advance — it moves as the sketch solves.
"Perpendicular to this spline" is not a complete sentence. "Perpendicular to
this spline's tangent, at the point where they meet" is, and the meeting point
is an unknown like any other.

So contact parameters are solver variables here. Which means `perpendicular`
takes any two **direction sources** and does not care which is which:

```js
S.constrain('perpendicular', { e: line },     { e: otherLine });
S.constrain('perpendicular', { e: line },     { e: arc,    t });   // t is a param
S.constrain('perpendicular', { e: line },     { e: spline, t });
S.constrain('perpendicular', { e: splineA, t1 }, { e: splineB, t2 });
```

All four go through the same three lines of code. Sketchers that keep the
contact point implicit cannot do this — they end up offering perpendicular
between two lines, special-casing "perpendicular to a circle" as "passes
through the centre", and leaving splines out altogether.

### References

| form | means |
| --- | --- |
| `{ p: id }` | a point entity |
| `{ e: id }` | a whole entity — a line's direction, an arc's centre, a curve's size |
| `{ e: id, t: paramId }` | a location on an entity, at a solved parameter: both a position and a tangent |

A **direction source** is `{ e: lineId }` or `{ e: anyId, t }`. A **point
source** is `{ p: id }` or `{ e: anyId, t }`.

### Constraints

| name | takes | equations |
| --- | --- | --- |
| `coincident` | two point sources | 2 |
| `concentric` | two curves | 2 |
| `centre` | a point source, a curve | 2 |
| `collinear` | two lines | 2 |
| `parallel` | two direction sources | 1 |
| `perpendicular` | two direction sources | 1 |
| `tangent` | two curves | 3, and creates 2 contact params → net 1 |
| `equal` | two lines, or two arcs | 1 / 2 |
| `circular` | an arc | 1 |
| `on` | a point source, a curve | 2 |
| `horizontal`, `vertical` | a direction source | 1 |
| `distance`, `radius`, `angle` | as named, plus a value | 1 |

`centre` means an arc's centre, and a line's midpoint — which is what someone
means when they drop a centre mark on a line.

`circular` exists because every arc here is elliptical. Leave it out and a
tangency will find its answer by *squashing* the arc rather than moving it —
a correct solve of a sketch nobody meant to draw.

### What comes back

```js
{ converged, residual, iterations,
  variables,    // free variables, contact parameters included
  equations, rank,
  dof,          // 0 is fully constrained
  redundant,    // constraints that said something already said
  conflicting } // constraints that cannot all hold
```

Rank is measured at the solution, so `dof` is trustworthy even when the solve
did nothing because the sketch already held.

### Two things to know

**Tangency is two-valued.** Two circles can touch side by side or nested, and
both satisfy "touching, with tangents in line" exactly. Contact parameters are
initialised by aiming each at the other entity, which picks the arrangement
someone drawing it would have meant — three circles told to touch each other
land outside each other, from any starting layout. But it only chooses the
near answer; it does not make the far one go away.

**Damping is isotropic**, `λ·max(diag(JᵀJ))` rather than Marquardt's
`λ·diag(JᵀJ)`. Per-coordinate damping is the textbook choice and it is wrong
here: sketches are nearly always rank-deficient, and scaling damping per
coordinate lets the step run furthest exactly where it knows least. Asked to
make two lines perpendicular, it returned a step that stretched one of them to
500 mm instead of rotating it.

### Tests

```
node check-sketch.mjs
```

49 assertions. Every constraint is verified independently after the solve —
measured from the geometry, not by asking the residual that was just
minimised, because a residual can be small for the wrong reason.

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
points, and compares against the JS at the same points. Two implementations
sitting next to each other in the source was the only thing keeping them in
step; this is the thing that checks.

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
