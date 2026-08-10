# SinterForm

A signed-distance geometry kernel for solid modelling: primitives, booleans
with smooth blends, baked distance fields, a surface-nets mesher and binary
STL output. Dependency-free JavaScript.

| file | what |
| --- | --- |
| `glsl.js` | **each primitive's definition**, as GLSL, plus the two shader budgets |
| `sinterform.js` | the kernel — those definitions translated to JS, booleans, bounds, meshing |
| `build-twins.mjs` | the translator; `--check` fails if the generated block is stale |
| `sketch.js` | constrained 2D sketching → profiles → a 2D distance field |
| `sketch3d.js` | the same, one dimension up → planar faces → an extrusion |
| `sweep.js` | a profile dragged along a sketch path, flat or through space |
| `viewer.html` · `viewer.js` | a window onto the above — open it, no server, no build |
| `demo3d.html` | the 3D sketcher, drawn rough and solved in front of you |

The first two are one kernel in two languages: `glsl.js` is where a primitive
is *defined*, and the JS in `sinterform.js` is that definition translated. They
are separate files because they are used separately — a mesher, a slicer or a
test wants the JS and no GPU at all.

It computes geometry and hands it back. There is no DOM in it, no WebGL, no
storage, no state belonging to whatever is using it — which is what makes it
runnable from node, testable without a browser, and liftable into a project
that looks nothing like the one it grew up in.

It was extracted from [MetaMeld][mm], a single-file SDF modeller for 3D
printing, and that is still its main consumer: MetaMeld inlines this file into
its one shipped HTML file at build time.

[mm]: https://github.com/DuckySonadar/mywebsiterepository-Iknowtotallyoriginal

## Looking at it

```
open viewer.html
```

That is the whole setup. It is a plain page next to the modules, so `file://`
works and there is nothing to install.

It is **not** part of the kernel and the kernel does not know it exists — it
consumes `sinterform.js`, `glsl.js` and `viewer.js` the way any application
would, which is also what makes it useful: if the viewer needs something the
modules do not expose, that is a finding about the API rather than a reason to
reach inside. Everything about the machine is the viewer's own — the uniform
packing, the budgets, the raymarch loop, the camera, the lights.

Its one real trick is that it draws every scene **two ways**:

- **GLSL · GPU** runs `glsl.js` in a fragment shader and sphere-traces it
- **JS · mesh** runs the JS twins in `sinterform.js` and meshes them with
  `surfaceNets`

Those are meant to be the same shape, so flipping between them is a
divergence detector you can see. `check-glsl.mjs` compares the two at sampled
points, which is sharper per point but blind to anything the sampling misses —
bounds that are wrong, a boolean folded the wrong way, a rotation applied in
the other order. Those change the outline, and the outline is what this shows.

The first scene, and the one it opens on, is *every primitive* — all of them
at once, so a broken one is obvious at a glance instead of being found later by
whichever model happened to use it. `profile` is in it too, drawing its default
20 × 20 mm square — a primitive that shows nothing until an application feeds it
is a primitive nobody can see to fix. (`plane` and `field` sit it out: one is a
half-space that would swallow the grid, the other needs real samples.)

Two of the scenes are sketches: **sketch 2D, extruded** is a `sketch.js`
profile closed by constraints and given a thickness, and **sketch 3D,
extruded** is a `sketch3d.js` plate found by `profile()` and extruded along its
own plane's normal. Both are solved when the scene loads, so what is on screen
is the solver's answer rather than a shape typed in to look like one.

Neither is baked. A sketch extrude reaches the GPU as a `profile` — the
outline compiled straight into the shader source, so both halves walk the same
edges. What still needs baking is the shape with no formula at all: **twisted
box — baked field** is a domain warp sampled onto a grid, and it is the only
scene here that exercises a `field` on either side.

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
| `fi` | which baked field, for `t: 'field'` — or which outline, for `t: 'profile'` |

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
Signed distance to the whole scene at a point, in mm. This runs the JS twins,
which are generated from the GLSL in `glsl.js` — see *One definition, two
halves* below.

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

**Triangles are wound so that `cross(b − a, c − a)` points out of the solid** —
what STL means by a facet normal, and what anything shading or back-face
culling the mesh will assume. They used to come out the other way round on
every triangle, and nothing fell over: slicers flood-fill orientation
themselves so the prints were fine, the viewer's mesh mode lit every surface
from the side facing away without looking obviously broken, and every volume
in these suites is measured through an `abs()`. `check-kernel.mjs` now tests
the winding against the gradient of the distance field, which points out of
the solid by definition.

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
GL.profileDecls(SinterForm.profiles)        // one pProfileN function per outline
```

`GL.call` knows the sampler-first calling convention baked primitives use, so
a consumer does not have to. It also knows the *slotted* convention `profile`
uses — the slot is part of the function name, because the outline is compiled
into the function rather than passed to it. The uniform *expressions* are the
caller's, which is what keeps the packing out of here.

One thing a consumer does have to know: **a baked field takes its `range`
through the slot every other primitive uses for corner rounding.** A field has
no rounding and the range has to arrive somehow. Do not reimplement that rule —
ask for it:

```js
uData[b + 7] = SinterForm.roundSlot(node);   // rounding, or a field's range
```

`sceneSDF` asks the same function, so the two halves cannot disagree about
what is in that uniform. Packing `round` there by hand gives a field multiplied
by zero, which draws as its bounding box and looks exactly like a texture that
never arrived.

Uploading the texture is the consumer's job; `viewer.js` does it in about twenty
lines and its `texOf` is the reference for the layout — `nz` wide by `ny` by
`nx`, trilinear, edges clamped. **Samples sit on the grid corners, spanning the
box exactly**, which is what every baker here writes; a texture's own
coordinates put sample `i` at texel centre `(i + 0.5)/n`, so `fieldSample`
corrects the mapping. Without that correction the shader reads the field
stretched by half a texel at each end — 1.2 mm on a coarse grid, and invisible
until the twins are compared per point.

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

### One definition, two halves

**The GLSL is the definition.** The JS twins in `sinterform.js` are generated
from it by `build-twins.mjs`, into a marked block that says so. To add or change
a primitive, write the GLSL in `glsl.js` and run:

```
node build-twins.mjs           # rewrite the generated block
node build-twins.mjs --check   # exit 1 if it is stale (check-kernel does this)
```

There is no build step for *consumers* — the generated code is committed, so
`sinterform.js` is still one file you can drop in a page. Only someone changing
a primitive runs the generator.

This replaced two hand-written halves. `check-glsl.mjs` existed to catch them
drifting, and it was a drift alarm rather than a proof — it had already missed
one: the cone's GLSL divided by `dot(k2, k2)` unguarded while its JS twin wrote
`|| 1e-9`, a real difference in a degenerate case the random-point comparison
never landed on. That check still runs and still compiles the real shader, but
it is now asking whether a translation is faithful rather than whether two
authors agreed, and `check-kernel.mjs` refuses a stale generated block so a
hand-edited twin cannot creep back.

The generator parses the subset of GLSL ES 3.0 the primitives actually use —
`float`/`vec2`/`vec3`/`int`/`bool`, one loop form, a dozen builtins. Anything
outside that subset is a **parse error rather than a silent mistranslation**,
which is the property that matters.

**Nothing is excluded.** All sixteen primitives are generated, including the two
that read data rather than computing from their dims. The one thing a shader and
JavaScript genuinely cannot share is *how they reach that data* — one asks a
sampler or reads an outline compiled into its own source, the other indexes an
array — so those reads, and only those, are **intrinsics**: GLSL functions
declared in `build-twins.mjs` to have a JS counterpart instead of being
translated.

| intrinsic | JS counterpart |
| --- | --- |
| `fieldSample(s, u, v, w)` | `sampleFieldUVW` — trilinear read of a `fields` grid |
| `edgeCount(o)`, `edgeA(o, i)`, `edgeB(o, i)` | the flattened edges of a `profiles` outline |

That is the whole seam, and it is two data reads wide. An undeclared intrinsic
is an error, so it cannot widen by accident. Everything around them — the box
union, the slab, the crossing count, the nearest-edge search — is ordinary GLSL
and is generated like everything else.

`profile`'s canonical source is therefore the **rolled** loop. What the GPU runs
is `profileDecls`, which specialises that same loop by unrolling the edges; that
is an optimisation forced by WebGL2, not a second definition, and `check-glsl`
holds the unrolled form against the JS the rolled one generates. `library()`
skips any source marked `spec`, since the rolled one names an `outline` type
GLSL does not have.

`check-glsl.mjs` also refuses a primitive present in one file and missing from
the other.

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

### Profiles

A closed outline extruded along Z. This is what a sketch becomes, and it is
deliberately *not* a baked field: the polygon is exact, and a grid fine enough
to hold a 0.1 mm fillet costs a megabyte to say what a few hundred `vec2`s say
exactly.

```js
SinterForm.profiles = [{ name, loops: [[[x, y], ...], ...] }];
polygonSDF(loops, x, y) · profileExtent(loops)
```

An empty slot — no entry, or one with no usable loops — is a **20 × 20 mm
square**, matching the primitive's default dims, because a node may name a
profile before the application has put anything in it.

Loop 0 is the outer boundary and the rest are holes — containment is even-odd,
so winding does not matter. `polygonSDF` is iq's: nearest edge for the
magnitude, a crossing count for the sign. Exact and 1-Lipschitz, at a cost
linear in the edge count, per sample. `profileExtent` gives the half-extents a
node's `d[0]`/`d[1]` want; `d[2]` is the half-thickness, and it is the only
one of the three the shape actually reads.

`profiles` is a getter/setter pair with the same rule as `fields`: assign to
`SinterForm.profiles`, never write through a captured local.

Neither sketch module needs to know this file exists to produce one, because a
profile and a node are both plain data. `S.shape(height)` in `sketch.js` and
`S.shape(face, height)` in `sketch3d.js` hand back `{ profile, node }` ready to
use:

```js
const { profile, node } = S.shape(S.profile().faces[0], 8);
SinterForm.profiles = [profile];
SinterForm.sceneSDF([{ id: 0, nodes: [node] }], x, y, z);
```

Loops come back centred on their own bounding box with the node moved to
match, so bounds are tight rather than wherever the sketch was drawn. Height
runs symmetrically about the sketch plane unless `base` is given. The 3D
version is the one worth having: a face has a plane of its own, and inverting
that plane into the `Rz·Ry·Rx` the kernel applies — including the edge-on case
where `ry` is ±90° and `rz` and `rx` turn about the same line — is algebra no
caller should write twice.

On the GPU the outline is not a uniform and not a texture — `GL.profileDecls`
writes one function per profile with the edges **unrolled into the source**.
That is not cosmetic. Reading a dynamically indexed `const vec2[]` array in
GLSL expands to a select chain per read, so a few hundred edges compile in
tens of seconds and unrolled ones in a few. A slot with no outline still emits
a function that returns `1e9`, because the shader is generated from the plan
and a node can name a profile that has not arrived yet — so changing an
outline means recompiling, while moving the node does not.

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
// …or drive it yourself, a step per frame, so nothing blocks:
//   const run = S.solver();  while (!run.step().done) { draw(); await frame(); }
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

## Sketches in space (`sketch3d.js`)

The same file one dimension up: points, lines, elliptical arcs and NURBS in
space, the same constraints, the same caller-driven solver. Self-contained in
the same way — and deliberately not an extension of `sketch.js`, because two
dimensions and three are different enough that a shared file would be a pile
of `if (is3d)`.

```js
const { Sketch3D } = require('./sketch3d.js');
const S = new Sketch3D();
const a = S.point(0, 0, 0, { fixed: true });
const b = S.point(10, 3, 4);
const ln = S.line(a, b);
S.constrain('horizontal', { e: ln });     // lies in a horizontal plane
S.constrain('distance', { p: a }, { p: b }, 20);
S.solve();            // → { converged, dof, rank, equations, rows, … }
```

Four things change, and none of them is cosmetic.

**Rows are not equations.** In the plane "parallel" is one scalar — the cross
product. In space the cross product is a vector, and setting it to zero is
three rows that can only ever have rank two, because two directions in space
differ by two angles. There is no way to write it in two rows without picking
a frame perpendicular to one of them, and no way to pick that frame smoothly
everywhere. So the rows stay and **each constraint declares the rank it
carries** alongside them; the report gives `rows` and `equations` separately,
and `redundant` counts against the second. A sketcher that counts the rows
tells people an ordinary sketch is over-constrained.

**An arc carries a frame** — three Euler angles rather than one, applied
Rz·Ry·Rx as in the kernel but in radians as in `sketch.js`. A bare number for
the rotation means about +Z alone, which is exactly the 2D `phi`, so a planar
sketch lifts across unchanged.

**Angles are unsigned.** A signed angle needs an axis to be signed about.

**A closed loop does not bound anything** unless it is planar, and a wireframe
bounds no volume at all. So there is no argument-free `sdf3d`: there is
`profile()`, which groups planar loops into faces with a plane apiece;
`extrude`, which turns a face into an exact solid along **its own normal**
(along Z would be a shear); and `wire`, which gives the drawn curves a radius.

Two constraints exist here that have nothing to say in the plane: `coplanar`,
that two lines meet or are parallel, and `planar`, that a spline's control
points share a plane — which is what gets a curve in space back to something
extrudable.

📖 **[SKETCH3D.md](SKETCH3D.md) is the full API reference.**

```
open demo3d.html           # five sketches, drawn rough and solved in front of you
node check-sketch3d.mjs    # 170 assertions
```

`demo3d.html` is a plain page next to the modules, like `viewer.html` and for
the same reason: it consumes `sketch3d.js` the way an application would, so
anything it cannot do without reaching inside is a finding about the API. It
drives the solver a step per frame — so every scene arrives as a rough drawing
and settles while you watch — reads the profile back, and hands the distance
field to `surfaceNets`. The report beside it is the real one, `redundant`
included.

## Sweeps (`sweep.js`)

Take a path — anything `sketch.js` or `sketch3d.js` can sample, open or closed,
flat or through space — and drag a 2D profile along it, at a scale that may
change as it goes.

```js
const SW = require('./sweep.js');
const f = SW.fromSketch(S, { entity: curveId }, SW.PROFILES.circle(4),
                        { scale: (t) => 1 + 2 * t });
f(x, y, z);        // mm
f.bounds;          // { lo, hi }, ready for surfaceNets
f.exact;           // false once the scale varies — see below
```

A path point is `[x, y]` or `[x, y, z]`; two-coordinate points sit at `opts.z`,
which is what this file used to assume of all of them. `fromSketch` takes
either sketcher — it asks for samples and gets points with two coordinates or
three — and reaches a loop as `{ loop: i }` from a 2D sketch or `{ face: i }`
/ `{ face: i, loop: j }` from a 3D one.

A profile is any `(u, v) → mm`, with `u` across the path and `v` up;
`PROFILES.circle`, `.rect` and `.halfCircle` cover the usual ones. `scale`
takes a number, a function of arc length in `[0, 1]`, or one factor per path
point.

### A path through space: the frame is carried, not computed

In the XY plane there is nothing to decide — the profile's *v* axis is +Z and
its *u* axis is the path's normal, and that is the only frame there is.

In space there is no distinguished up, and no rule that picks one pointwise
will do: "take the normal" is undefined where the path runs straight, and the
Frenet frame — the textbook answer — turns its normal through 180° at every
inflection. Sweep a rectangle along an S-bend with it and the section flips
halfway along. `check-sweep.mjs` counts those flips: three on its test bend.

So the frame is **carried**. Start with one, and at each joint rotate it by the
smallest rotation taking the old tangent onto the new one. That is the
rotation-minimising frame; it exists wherever the tangent does, and it never
turns further than the tangent made it — which is the property the suite
asserts, because it is the one a Frenet frame breaks.

`opts.up` leans the starting frame (default +Z), `opts.twist` rolls the section
as it goes, in radians over the path or as a function of *t*, and `f.frames`
hands back what each segment ended up with.

**The profile's size varies exactly as it did in the plane** — `opts.scale` is
still a number, a function of arc length in `[0, 1]`, or one factor per path
point, and what stopped being flat is the path, not the profile. A rising scale
along a line that points nowhere near an axis reproduces `PRIMS.cone` in that
direction: meshed in the same frame the two agree on volume to 0.00%, and leave
the *same* four unpaired edges, which is the mesher on a slanted sharp edge
rather than anything about the field. Taper and twist together still come out
1-Lipschitz, because the two slants are at right angles and both are divided
back out.

**A closed path in space need not bring the frame back.** It returns rotated by
the area its tangent traced on the sphere — a fact about the sphere, not a bug
to be careful around. `f.holonomy` reports it. Left alone it is a visible seam
at one station for any profile that is not round; by default it is spread along
the path instead, so it becomes a twist of a couple of degrees over the whole
loop and no joint is worse than its neighbours (`opts.closeFrame: false` keeps
the seam). A closed *flat* path has none of this, so nothing about a 2D sweep
changed: the same path with a `z` on every point gives the same field, to the
last bit, and the suite checks that too.

### Self-intersection is not a special case

A swept solid is the **union** of the profile over the path. Union is `min`,
and `min` does not care how many times a point is covered — covered once is
negative, covered five times is still negative. A path that crosses itself,
doubles back or coils is the ordinary case with more terms in the min.

That is true of the union, and it is worth being exact about, because it is
not how sweeps are usually written. The cheap way attaches the profile to the
**nearest** path point: one lookup instead of a loop, and wrong wherever the
nearest pass is not the covering pass. `check-sweep.mjs` implements that
version alongside and points both at the same geometry — on a self-crossing
path with a one-sided profile it loses material in 9,504 of 200,000 samples,
gains it past the ends it cannot cap, and is not 1-Lipschitz, so a marcher
can step through it.

The price of the union is O(path segments) per sample instead of O(1).
Affordable for a mesher; the thing to watch for a raymarcher.

### What is exact

At constant scale the result is a true distance: 1-Lipschitz, and it
reproduces the analytic shapes — a circle along a line is a cylinder to 1e-9
whichever way the line points, a circle along a circle is `PRIMS.torus` in
whatever plane that circle lies in, a swept torus meshes watertight within
0.4% of 2π²Rr².

**Varying the scale makes it a bound rather than a distance**, and nothing
puts that back: a tapered surface is slanted, and the profile's distance is
measured across the sweep rather than square to the slant. Dividing out the
secant restores a *safe* bound — outside it never reports further than the
truth, so a marcher cannot step through it; inside it under-reports depth by
up to half a millimetre on a steep taper, which is the conservative
direction.

**Twisting costs the same**, and for the same reason — a rolled surface is
slanted the other way about, so the two corrections go in together. Which
means a closed path whose holonomy is being spread is a twisted sweep, and
`f.exact` says so.

### Joins and caps

The **ends** of an open path are capped flat with the profile, which is what
a sweep means; rounded ends would be a capsule and a different operation.
Where the path doubles back on itself the joint is a real end of the
material, so it caps too — retracing a path adds nothing.

**Corners** take one of the two usual joins:

| `join` | at a corner | reaches |
| --- | --- | --- |
| `'round'` (default) | the section swept through the turn, about the axis the path turns about | exactly the profile radius, at any angle |
| `'miter'` | both segments run on until their outer edges meet | `R / cos(turn/2)`, the true miter point |

A miter runs on by `R·tan(turn/2)`, which is **zero on a straight joint** — so
it costs nothing on a finely sampled curve and only bites where there is a
real corner. It runs away as the corner closes, so `miterLimit` (default 4,
in profile radii) clips it and the flat end becomes a bevel.

Neither join may ever leave a gap, and getting that wrong is easy: treating
anything sharper than a right angle as an end of the path — which this did at
first — caps both segments flat and leaves nothing filling the wedge between
them. On a 120° corner with a 6 mm profile, material reached 0.05 mm past the
vertex instead of 6.

**A corner in space needs two more things right, and a round profile hides
both.** The section is swept about the axis the path turns about, and in the
plane that is always +Z — the section's own *v* — so nothing had to be worked
out. Out of the plane the axis tilts, and sweeping about the wrong one puts a
lobe of material at an angle the path never turned through while leaving the
real wedge empty: the sweep pinches in where it should be fullest, and what
fills it looks round because a circle sweeps into the same solid whichever way
you spin it. The second thing is that the sweep must **stop at the turn** —
going the whole way round is what the plane got away with, because the extra
was inside the prisms, and out of the plane it hangs a blister off every joint
of a sampled curve.

The fill is a term of the union in its own right rather than something a
segment answers for past its end, because out of the plane it reaches back
*inside* both spans. `check-sweep.mjs` measures it against the same corner
filleted and swept in 160 steps — no join code involved at all — and holds it
to no material lost or invented, and no more than 0.05 mm reported past the
truth on the outside.

```
node check-sweep.mjs      # 105 assertions
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

### `check-viewer.mjs` — does the viewer work, and do the halves agree in the large?

```
node check-viewer.mjs            # skips, loudly, if Playwright is absent
node check-viewer.mjs --require  # what CI should run
```

Loads the page, then draws each scene both ways in **silhouette mode** — no
ground, no shading, no tint, just where the solid is — and compares the two
masks. Anything in the picture that is not geometry has to come out before the
picture means anything. Agreement runs 0.93–0.99 IoU; a meshed surface sits up
to half a cell inside the true one and its edges are faceted, so the outlines
are close rather than identical.

It also catches the ordinary breakages: a shader that stopped compiling, a
module that stopped attaching to its global.

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
