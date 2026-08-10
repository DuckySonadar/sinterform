# SinterSketch3D — constrained 3D sketching

`sketch3d.js`. [`sketch.js`](SKETCH.md) one dimension up: points, lines,
elliptical arcs and NURBS **in space**, the constraints that hold them
together, and the same solver reporting the same degrees of freedom.

Self-contained: no DOM, no GL, no dependency on `sinterform.js`, and none on
`sketch.js` either. Apache-2.0.

```js
const { Sketch3D } = require('./sketch3d.js');   // or <script>, see below
```

The file assigns `module.exports` when there is a `module`, and otherwise puts
`SinterSketch3D` on the global object. `Sketch` is exported as an alias of
`Sketch3D`, so code written against the 2D file reads the same.

---

## What is the same

Everything you already know from [SKETCH.md](SKETCH.md): refs, the flat
variable vector, entity ids as indices, `constrain` versus `addConstraint`,
the caller-driven `solver()`, `get`/`set`, `dropEntity`, construction
geometry, the coincidence walk that finds loops, serialisation as a
construction script.

And **the one idea**: a constraint touching a curve has to know *where* it
touches, that place moves as the sketch solves, so a contact parameter is a
solver variable. `perpendicular` still takes any two direction sources and
still does not care which is which — line to line, line to a spline's tangent,
spline to spline, in space now.

---

## What is different, and why

### 1. Rows are not equations

In the plane, "parallel" is one scalar — the cross product. In space the cross
product is a **vector**, and setting it to zero is three rows that can only
ever have rank two, because two directions in space differ by two angles.

You cannot write it in two rows without choosing a frame perpendicular to one
of the directions, and you cannot choose that frame smoothly everywhere — you
cannot comb a sphere. So the rows stay, and **each constraint declares the
rank it generically carries alongside the rows it writes**.

| | 2D | 3D |
| --- | --- | --- |
| `parallel` | 1 row, rank 1 | **3 rows, rank 2** |
| `collinear` | 2, rank 2 | **6, rank 4** |
| `tangent` | 3, rank 3 | **6, rank 5** |
| `vertical` | 1, rank 1 | **2, rank 2** |

The report therefore carries **both** numbers, and `redundant` counts against
the declared ranks:

```js
r.rows         // residual rows the constraints wrote
r.equations    // independent equations they carry
r.redundant    // equations - rank: constraints that said something already said
```

A sketcher that counts the rows will tell you a perfectly ordinary sketch is
over-constrained. Ask a constraint what it costs and it will tell you:

```js
const c = S.constrain('parallel', { e: a }, { e: b });
c.n     // 3
c.rank  // 2
```

### 2. An arc carries a frame

In the plane an ellipse needs one angle. In space it needs three, so an arc
owns **seven** numbers rather than five: `rx`, `ry`, three Euler angles, `t0`,
`t1`.

The angles are applied **Rz·Ry·Rx**, matching `sinterform.js` so that a sketch
and a shape rotated by the same three numbers agree — but in **radians**,
matching `sketch.js`. Convert at whichever boundary you cross.

### 3. Angles are unsigned

A signed angle needs an axis to be signed about, and space does not supply
one. `angle` measures the unsigned angle between two directions, in `[0, π]`.
Asking for a negative one asks for something that cannot hold.

An unsigned angle has a kink at 0 and at π — the value is right there but the
derivative is not, and the solver reads derivatives. Say `parallel` or
`perpendicular` for those two; they are smooth, and they are what you meant.

### 4. A closed loop does not bound anything

In the plane a closed loop bounds an area and `sdf2d` is the distance to it.

In space a closed loop bounds an area **only if it is planar**, which is a
property to be measured — or constrained, see [`planar`](#constraints) — and a
wireframe bounds no volume at all. So there is no argument-free `sdf3d` here.
There is [`profile()`](#profiletol-planetol--faces-open-nonplanar-closed),
which groups planar loops into faces; [`extrude`](#extrudeface-height-tol--f),
which turns one face into an exact solid along **its own normal**; and
[`wire`](#wireradius-tol--f), which gives the drawn curves a radius.

---

## Conventions

- **Millimetres**, like the rest of the kernel.
- **Radians** — arc rotation, arc extents, and the `angle` constraint.
- **Right-handed**, **+Z up**, `z = 0` the build plate. `horizontal` and
  `vertical` are about that plate, not about a drawing.
- **Ids are integers**, assigned in creation order, and are indices into the
  entity list.

---

## References

Unchanged from 2D.

| form | is a | means |
| --- | --- | --- |
| `{ p: id }` | point source | a point entity |
| `{ e: id }` | both, for some kinds | a whole entity: a line's direction, an arc's centre, a curve's size |
| `{ e: id, t: paramId }` | both | a location on an entity at a solved parameter — a **position** and a **tangent**. The parameter is an unknown the solver moves |
| `{ e: id, end: 0\|1 }` | both | a curve's **drawn** end. See [Profiles](#profiles--getting-to-something-extrudable) |

A bare integer is accepted anywhere a ref is and means `{ e: id }`.

`collinear` and `coplanar` want a position **and** a direction from one ref, so
they take `{ e: lineId }`, `{ e, t }` or `{ e, end }` — and say so if given
anything else.

---

## Entities

### `point(x, y, z, [{ fixed }]) → id`
**3 DOF.**

### `param(t, [{ fixed }]) → id`
1 DOF. A free scalar — a contact parameter, or anything else you want solved.

### `line(aPointId, bPointId) → id`
0 own DOF. Its parameter runs 0 at `a` to 1 at `b` and extends past both.

### `arc(centrePointId, rx, [ry], [rot], [t0], [t1], [{ fixed }]) → id`
**7 own DOF** (`rx`, `ry`, three angles, `t0`, `t1`) plus the centre point's 3.

`rot` is the plane the arc is drawn in: `[ax, ay, az]` in radians, applied
Rz·Ry·Rx. **A bare number means rotation about +Z alone**, which is exactly the
2D `phi` — so a planar sketch written for `sketch.js` lifts across unchanged
and stays in the `z = 0` plane.

`t` is the eccentric parameter: `P(t) = centre + rx·cos t · u + ry·sin t · v`,
where `u`, `v` are the first two columns of the rotation. `get` hands back
`u`, `v` and `normal` so nothing has to rebuild them.

Every arc is elliptical, so say `circular` when you mean a circle.

> **A full circle has one degree of freedom that changes nothing.** Its frame
> has three angles and a circle only cares about its normal, which is two — so
> rotating it in its own plane maps it to itself. Expect one apparent DOF that
> moves nothing. A partial arc does not have it: `t0` and `t1` are measured
> from `u`, so turning the frame turns the drawn extent with it.

### `nurbs(ctrlPointIds, [{ degree = 3, weights, closed = false }]) → id`
0 own DOF; the control points carry theirs. Clamped open or periodic closed,
rational, weights honoured and **not** solver variables.

**A spline in space is not planar unless something says so** — see `planar`.

### `fix(id, [on = true]) → id`
Pin an entity. Reaches through: fixing a line fixes its endpoints, fixing an
arc fixes its centre and its frame.

### Construction geometry

Any curve takes `{ construction: true }`, or `S.construction(id, [on])` after
the fact. `loops()` will not walk into it and `bounds()`/`wire()` ignore it.

---

## Constraints

```js
S.constrain(kind, refA, [refB], [value]) → constraint
```

| kind | takes | rows | equations | means |
| --- | --- | --- | --- | --- |
| `coincident` | two point sources | 3 | 3 | same point |
| `concentric` | two curves | 3 | 3 | same centre |
| `centre` | point source, curve | 3 | 3 | the point is the curve's centre — an arc's centre, a line's **midpoint** |
| `collinear` | two lines | 6 | 4 | the same infinite line |
| `parallel` | two direction sources | 3 | 2 | tangents parallel |
| `perpendicular` | two direction sources | 1 | 1 | tangents at a right angle — the one thing that does not get harder in 3D |
| `tangent` | two curves | 6 | 5 | touching, tangents in line. Creates 2 contact params, so it removes **3** DOF |
| `equal` | two lines, or two arcs | 1 / 2 | same | equal length; equal semi-axes |
| `circular` | an arc | 1 | 1 | `rx = ry` |
| `on` | point source, curve | 3 | 3 | the point lies somewhere on the curve. Creates 1 param, so it removes **2** DOF |
| `horizontal` | direction source | 1 | 1 | lies in a horizontal plane (no z component) |
| `vertical` | direction source | 2 | 2 | runs up +Z |
| `distance` | two point sources, value | 1 | 1 | |
| `radius` | an arc, value | 1 | 1 | sets `rx` |
| `radiusY` | an arc, value | 1 | 1 | sets `ry` |
| `angle` | two direction sources, value | 1 | 1 | **unsigned**, radians, in `[0, π]` |
| `coplanar` | two lines | 1 | 1 | **3D only.** They meet, or they are parallel |
| `planar` | a curve | n−3 | n−3 | **3D only.** A spline's control points share a plane, so the curve does. 0 rows for a line or an arc, which are planar already |

`CONSTRAINT_KINDS` is the list of names, for building a UI.

`planar` takes its plane from the first three control points, so it is
degenerate if those three are collinear. That is the reason it is a constraint
on a spline rather than a general "these points are coplanar".

### `addConstraint(kind, a, b, value) → constraint`
The same thing with nothing inferred: refs taken exactly as given, no contact
parameters invented. What deserialisation uses.

---

## Solving

Identical to 2D. `solver([{ tol, maxIter }])` hands back `{ step, report,
state }`; **the loop is yours**. `solve()` is a `while` around it.
`diagnose()` is the report without moving anything.

### The report

```js
{
  converged,    // did the residuals reach zero
  residual,     // 2-norm at the end
  iterations,
  variables,    // free variables, contact parameters included
  equations,    // independent equations the constraints carry
  rows,         // residual rows they wrote — not the same number
  rank,         // numerical rank of the Jacobian at the solution
  dof,          // variables - rank. 0 is fully constrained
  redundant,    // equations - rank
  conflicting
}
```

`rows()` and `equations()` are also callable directly, for a UI that wants to
show the difference.

---

## Reading and editing

### `get(id) → object`

| kind | fields |
| --- | --- |
| `point` | `x`, `y`, `z`, `fixed` |
| `param` | `t`, `fixed` |
| `line` | `a`, `b`, `from`, `to` |
| `arc` | `c`, `centre`, `rx`, `ry`, `rot`, `u`, `v`, `normal`, `t0`, `t1`, `circular` |
| `nurbs` | `ctrl`, `weights`, `degree`, `closed`, `domain` |

`set(id, values)` writes back; `values.rot` takes an array or a bare number
(about +Z). `entities([kind])`, `constraints()`, `constraintsOn(id)`,
`dropConstraint`, `dropEntity` are as in 2D.

---

## Evaluation

### `evalAt(x, id, t) → { p: [x, y, z], d: [dx, dy, dz] }`
Position and first derivative. Pass `S.x` as `x`.

### `tangentAt(id, t) → [x, y, z]`
Unit tangent, against the current solution.

### `frameAt(id, t) → { t, n, b, straight }`
The Frenet frame, as far as it exists. The principal normal comes from
differencing the unit tangent — it never goes into a residual, so finite
differences are honest here.

**Where the curve is straight the principal normal is genuinely undefined.**
An arbitrary perpendicular comes back and `straight` is `true`: fine for
drawing, not to be trusted by a calculation. `normalAt` and `binormalAt` are
the two components on their own.

### `posOf(ref)` · `dirOf(ref)` · `centreOf(x, id)` · `frameOfArc(x, id)`
Resolve a ref, an entity's centre, an arc's `[u, v, normal]`.

### `sample(id, [tol = 0.05]) → [[x, y, z], …]` · `bounds([tol]) → { lo, hi } | null`
Polyline per entity; bounds over everything drawn, construction geometry
excluded.

---

## Profiles — getting to something extrudable

**Two things have to be true, and only the first was true in 2D.**

1. The curves have to be **joined**. Four curves constrained mutually tangent
   look like a closed shape on screen while being four disconnected pieces in
   memory. Constrain the ends together — `coincident` between two `{e, end}`
   refs — and the loops fall out of which ends coincide.
2. The loop has to be **flat**. Three points always are; a fourth rarely is
   unless someone said so. Nothing about closing a loop makes it planar, so
   planarity is measured, and the loops that fail come back counted rather
   than quietly flattened.

### `loops([tol = 1e-6], [planeTol = 1e-6]) → { loops, open, faces }`

Walks the coincidence graph. Ends within `tol` are the same node; a loop
requires every node it passes through to have exactly two edges. Each closed
loop carries its `normal`, `origin`, `deviation` from flat, whether it is
`planar`, which `face` it landed in and whether it is a `hole`.

`planeTol` is separate from `tol` because they answer different questions —
"do these two ends meet" and "is this thing flat".

Faces group loops that share a plane: parallel normals *and* no offset between
them. Two squares in parallel planes are two faces, not one with a hole.

**A face's normal is pinned to a convention**: the first of z, y, x that is
not zero comes out positive. Which way a flat loop faces is arbitrary, but
`extrude` runs along it, so it must not be unpredictable — and this way a
sketch drawn in the XY plane extrudes upwards.

### `profile([tol = 0.05], [planeTol]) → { faces, open, nonplanar, closed }`

Faces sampled to polygons, biggest first.

```js
{
  faces: [ {
    origin, normal, u, v,          // the plane, with an orthonormal in-plane basis
    area,                          // signed areas summed: the material
    loops: [ { points, uv, area, hole, entities } ]
  } ],
  open,        // chains that did not close — an unfinished profile
  nonplanar,   // closed, but not flat — not a face either
  closed       // open === 0 and nonplanar === 0 and at least one face
}
```

`points` are in space; `uv` are the same points in the face's plane. Loops are
**oriented by containment**: a loop inside an odd number of others is a hole,
so it runs clockwise about the face normal and its area is negative. The signed
areas therefore sum to the material.

⚠️ **Loops must not intersect each other**, same as in 2D.

A full circle closes as a loop on its own. Concentric circles are an annulus.

### `extrude(face, height, [tol]) → f`

The exact solid: a face given a thickness, along **its own normal** rather
than along Z. Material runs from the plane by `height`; negative goes the other
way. `face` may be an index into `profile().faces`.

```js
const prof = S.profile(0.001);
const f = SK.extrude(prof.faces[0], 10);
f(x, y, z);     // mm, negative inside
f.bounds;       // { lo, hi }, ready for surfaceNets
f.exact;        // true
```

This is the operator the 2D file left to its caller, and it is here because in
space the direction is not obvious: extruding a tilted face along Z is a shear,
not an extrusion.

### `wire([radius = 1], [tol]) → f`

The drawn curves given a radius: exact, 1-Lipschitz, negative inside.
Construction geometry is left out. Carries `.bounds`, `.segments`, `.radius`.

A wireframe is the other thing a 3D sketch can be, and the union of capsules
is the only honest solid it stands for.

---

## Serialisation

### `toJSON() → object` · `Sketch3D.fromJSON(obj) → Sketch3D`

A construction script, not a memory dump. Documents carry `sinterSketch3d: 1`,
and `fromJSON` refuses anything else — including a 2D `sinterSketch: 1`
document, rather than half-reading it.

A restored sketch is already satisfied: `diagnose().converged` is true and
re-solving takes zero iterations.

---

## Two things to know

### Tangency is two-valued in 2D and worse in 3D

Two circles told to be tangent can be side by side or nested, and contact
parameters are initialised by aiming each at the other so the near answer comes
back. That is unchanged.

What is new: **tangency in space does not fix the centre distance.** Two
circles of radius 10 and 6 touching tangentially in the plane have their
centres 16 mm apart; in space the second is free to tilt about the shared
tangent, and 15.18 mm is a correct answer to the question that was asked. Say
which plane it is in — two `horizontal` tangents, a `coplanar`, a `parallel`
against a construction line — and 16 comes back exactly.

This is not a defect in the solver. It is what one more dimension costs, and
the test suite asserts both halves of it.

### Damping is isotropic

`λ·max(diag(JᵀJ))`, not Marquardt's `λ·diag(JᵀJ)`. Per-coordinate damping
gives the least damping to the directions with the least curvature, so the step
runs furthest exactly where it knows least. It matters more here than in 2D:
every vector-valued constraint contributes a dependent row by construction, so
a 3D sketch is *always* rank-deficient at the row level.

---

## Errors

Thrown, not returned:

- `no such constraint: <kind>` · `no entity <id>`
- `ref has no direction — a curve needs {t} or {end}`
- `ref has no position — a curve needs {t} or {end}`
- `ref has no position and direction — a line, or a curve with {t} or {end}`
- `entity <id> (<kind>) has no ends` · `has no parameterisation` · `has no centre` · `has no frame`
- `equal wants two lines or two arcs` · `circular wants an arc` · `planar wants a curve`
- `extrude wants a face from profile()`
- `not a SinterSketch3D document (want sinterSketch3d: 1)`

---

## Tests

```
node check-sketch3d.mjs
```

164 assertions. Every constraint is verified independently after the solve —
measured from the geometry, not by asking the residual that was just
minimised.

Three of the sections are there because of the lift specifically:

- **the spline basis is the same one sketch.js runs.** Both files hold their
  own copy of `findSpan` / `dersBasisFuns`, because neither depends on the
  other. This is what notices when they drift, the same way `check-glsl.mjs`
  keeps the GLSL and JS twins in step.
- **rows are not equations.** The rank bookkeeping, asserted directly: three
  rows of parallel, two equations, redundant 0 — and redundant 2 when it is
  genuinely said twice.
- **the same drawing, in both files.** A slot built identically in `sketch.js`
  and in `sketch3d.js` at `z = 0` has to produce the same polygon and the same
  area, bit for bit.

The mesh at the end goes the whole way: a slot with a hole extruded 10 mm,
meshed with `surfaceNets`, checked watertight and against area × thickness,
and written to STL. The tilted extrusion is checked on volume only — the
mesher leaves a handful of unpaired edges on any slanted sharp edge, and a
plain rotated box out of `PRIMS` does the same, so that is the mesher and not
the field.
