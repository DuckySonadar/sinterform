# SinterSketch — constrained 2D sketching

`sketch.js`. Lines, elliptical arcs and NURBS, the constraints that hold them
together, and a solver that satisfies them. Reports degrees of freedom, rank,
redundancy and conflict.

Self-contained: no DOM, no GL, no dependency on `sinterform.js`, no
dependencies at all. Apache-2.0.

```js
const { Sketch } = require('./sketch.js');      // or <script>, see below
```

The file assigns `module.exports` when there is a `module`, and otherwise puts
`SinterSketch` on the global object.

---

## Conventions

- **Millimetres**, like the rest of the kernel.
- **Radians.** Arc rotation `phi`, arc extent `t0`/`t1`, and the `angle`
  constraint are all radians. ⚠️ This differs from `sinterform.js`, where a
  node's rotation is in *degrees* because it comes from a slider. Convert at
  the boundary; the exported `RAD` in the SDF kernel is `π/180`.
- **Right-handed**, +X right and +Y up. Positive angles turn anticlockwise.
- **Ids are integers**, assigned in creation order, and are indices into the
  entity list. They are stable for the life of a `Sketch` — see
  [`dropEntity`](#dropentityid--bool) for what that costs.

---

## The one idea

A constraint that touches a curve has to know **where** it touches, and that
is not knowable in advance — it moves as the sketch solves.

> "Perpendicular to this spline" is not a complete sentence. "Perpendicular to
> this spline's tangent, at the point where they meet" is, and the meeting
> point is an unknown like any other.

So contact parameters are solver variables here. Which is why `perpendicular`
takes any two **direction sources** and does not care which is which:

```js
S.constrain('perpendicular', { e: lineA },      { e: lineB });
S.constrain('perpendicular', { e: line },       { e: arc,     t: p1 });
S.constrain('perpendicular', { e: line },       { e: spline,  t: p2 });
S.constrain('perpendicular', { e: splineA, t: p3 }, { e: splineB, t: p4 });
```

All four go through the same three lines of code. A sketcher that keeps the
contact point implicit cannot express the question — which is why they tend to
offer perpendicular between two lines, special-case "perpendicular to a
circle" as "passes through the centre", and leave splines out.

---

## References

A **ref** names something a constraint can talk about.

| form | is a | means |
| --- | --- | --- |
| `{ p: id }` | point source | a point entity |
| `{ e: id }` | both, for some kinds | a whole entity: a line's direction, an arc's centre, a curve's size |
| `{ e: id, t: paramId }` | both | a location on an entity at a solved parameter — a **position** and a **tangent**. The parameter is an unknown the solver moves |
| `{ e: id, end: 0\|1 }` | both | a curve's **drawn** end — where it stops being drawn, rather than where something touches it. See [Profiles](#profiles--getting-to-something-extrudable) |

- A **direction source** is `{ e: lineId }`, `{ e: anyId, t }` or `{ e: anyId, end }`.
- A **point source** is `{ p: id }`, `{ e: pointId }`, `{ e: anyId, t }` or
  `{ e: anyId, end }`.

A bare integer is accepted anywhere a ref is and means `{ e: id }`.

Asking a curve for a direction or a position with neither `t` nor `end`
throws `ref has no direction — a curve needs {t} or {end}`.

---

## Entities

Each owns a slice of one flat variable vector. Where that slice sits is not
part of the API — use [`get`](#getid--object) and [`set`](#setid-values--id).

### `point(x, y, [{ fixed }]) → id`
2 DOF. The only entity that carries a position of its own; lines, arcs and
splines all refer to points, so coincidence is often just *sharing* one.

### `param(t, [{ fixed }]) → id`
1 DOF. A free scalar — a contact parameter, or anything else you want solved.
Pass its id as the `t` of a ref.

### `line(aPointId, bPointId) → id`
0 own DOF. Its parameter runs 0 at `a` to 1 at `b`, and extends past both —
`evalAt(line, 2)` is a real point on the infinite line, which is what lets a
tangency contact sit beyond an endpoint.

### `arc(centrePointId, rx, [ry], [phi], [t0], [t1], [{ fixed }]) → id`
5 own DOF (`rx`, `ry`, `phi`, `t0`, `t1`) plus the centre point's 2.
`ry` defaults to `rx`, `phi` to 0, `t0`/`t1` to a full turn.

`t` is the **eccentric parameter**, not the polar angle:
`P(t) = centre + R(phi)·(rx·cos t, ry·sin t)`. For a circle the two coincide;
for an ellipse they do not.

Every arc is elliptical, so say [`circular`](#constraints) when you mean a
circle. Leaving it out lets a tangency satisfy itself by *squashing* the arc.

### Construction geometry

Any curve takes `{ construction: true }`, or `S.construction(id, [on])` after
the fact. Construction geometry constrains the drawing without being part of
it — a centreline, an axis to measure an angle against, a circle inscribed to
size something — and **`loops()` will not walk into it**. It survives
serialisation and shows up as `construction` in `get`.

### `nurbs(ctrlPointIds, [{ degree = 3, weights, closed = false }]) → id`
0 own DOF; the control points are point entities and carry theirs. Clamped
open or periodic closed. Rational — weights are honoured.

**Weights are data, not variables.** The solver will not move them; letting it
is a good way to reach a singular curve nobody asked for. Change them by
rebuilding the entity.

Domain is `[0, 1]`; read it back from `get(id).domain`.

### `fix(id, [on = true]) → id`
Pin an entity so the solver may not move it. Reaches through: fixing a line
fixes its endpoints, fixing an arc fixes its centre.

---

## Constraints

```js
S.constrain(kind, refA, [refB], [value]) → constraint
```

Returns a constraint object carrying `.id`. Refs are normalised, and for
`tangent` and `on` any missing contact parameters are created — see
[Tangency](#tangency-is-two-valued).

| kind | takes | equations | means |
| --- | --- | --- | --- |
| `coincident` | two point sources | 2 | same point |
| `concentric` | two curves | 2 | same centre |
| `centre` | point source, curve | 2 | the point is the curve's centre — an arc's centre, a line's **midpoint** |
| `collinear` | two lines | 2 | same infinite line |
| `parallel` | two direction sources | 1 | tangents parallel |
| `perpendicular` | two direction sources | 1 | tangents at a right angle |
| `tangent` | two curves | 3 | touching, tangents in line. Creates 2 contact params, so it removes **1** DOF |
| `equal` | two lines, or two arcs | 1 / 2 | equal length; equal semi-axes |
| `circular` | an arc | 1 | `rx = ry` |
| `on` | point source, curve | 2 | the point lies somewhere on the curve |
| `horizontal` | direction source | 1 | parallel to +X |
| `vertical` | direction source | 1 | parallel to +Y |
| `distance` | two point sources, value | 1 | |
| `radius` | an arc, value | 1 | sets `rx`; pair with `circular` for a circle |
| `radiusY` | an arc, value | 1 | sets `ry` — an ellipse has two semi-axes |
| `angle` | two direction sources, value | 1 | signed, radians |

`CONSTRAINT_KINDS` is the list of names, for building a UI.

### `addConstraint(kind, a, b, value) → constraint`
The same thing with nothing inferred: refs are taken exactly as given and no
contact parameters are invented. This is what deserialisation uses, and what
you want if you are managing parameters yourself.

---

## Solving

### `solve([{ tol = 1e-9, maxIter = 200 }]) → report`
Levenberg–Marquardt over numerically differentiated residuals. Moves the
sketch to the solution and returns the report.

### `diagnose() → report`
The same report **without moving anything** — for a live degree-of-freedom
readout while someone is still drawing.

### The report

```js
{
  converged,    // did the residuals reach zero
  residual,     // 2-norm at the end
  iterations,
  variables,    // free variables, contact parameters included
  equations,    // total residual rows
  rank,         // numerical rank of the Jacobian at the solution
  dof,          // variables - rank. 0 is fully constrained
  redundant,    // equations - rank: constraints that said something already said
  conflicting   // constraints that cannot all hold
}
```

Rank is measured **at the solution**, so `dof` is trustworthy even when the
solve did nothing because the sketch already held.

`redundant > 0` with `converged` is harmless duplication. `conflicting` means
they contradict.

---

## Reading and editing

### `get(id) → object`
A plain snapshot — a copy, safe to modify and hand straight back to `set`.

| kind | fields |
| --- | --- |
| `point` | `x`, `y`, `fixed` |
| `param` | `t`, `fixed` |
| `line` | `a`, `b`, `from`, `to` |
| `arc` | `c`, `centre`, `rx`, `ry`, `phi`, `t0`, `t1`, `circular` |
| `nurbs` | `ctrl`, `weights`, `degree`, `closed`, `domain` |

All carry `id`, `kind` and `dead`.

### `set(id, values) → id`
Writes back. Ignores fields the entity does not have, so a `get` snapshot can
be returned as-is. `values.fixed` pins or unpins.

### `entities([kind]) → object[]` · `constraints() → object[]`
Enumerate. `entities` hides retired ones.

### `constraintsOn(id) → {id, kind}[]`
What mentions an entity — for greying out a delete, or explaining why
something will not move.

### `dropConstraint(constraintOrId) → bool`

### `dropEntity(id) → bool`
Retires an entity, everything built on it, and every constraint that mentions
any of them.

Ids are indices, so nothing is spliced out: the entity is marked `dead`, its
own variables are pinned so they leave the DOF count, and **the id stays
burnt**. Round-trip through `toJSON` to compact.

---

## Evaluation

### `evalAt(x, id, t) → { p: [x, y], d: [dx, dy] }`
Position and first derivative. Pass `S.x` as `x` — the argument exists because
the solver calls this against trial vectors.

### `tangentAt(id, t) → [x, y]` · `normalAt(id, t) → [x, y]`
Unit vectors, against the current solution. The normal is the tangent turned
+90°.

### `posOf(ref) → [x, y]` · `dirOf(ref) → [dx, dy]`
Resolve a ref. These are the two questions the constraints themselves ask — so
they are what you want to draw a glyph where a constraint bites, or to check
one independently of the residual that was minimised.

### `centreOf(x, id) → [x, y]`
An arc's centre, a line's midpoint, a point itself.

### `sample(id, [tol = 0.05]) → [[x, y], …]`
Polyline. Arcs are subdivided until the sagitta falls under `tol`; splines get
a fixed density proportional to their control count, which is honest about
being a guess rather than a bound.

---

## Profiles — getting to something extrudable

**A sketch that solves is not yet a profile, and the difference is invisible
when you draw it.**

Four curves constrained mutually tangent *look* exactly like a closed slot on
screen while being four disconnected pieces in memory: the lines run past
where they touch, the arcs are drawn over whatever extent they were created
with, and nothing says which end joins which. Walk that as a loop and the gaps
between consecutive pieces come out at 16 mm and 41 mm.

So closing a profile is a modelling act, not a rendering one. Constrain the
ends together and the loops fall out of which ends coincide.

### Endpoint refs

`{ e: id, end: 0 | 1 }` names a curve's **drawn** end — where it stops being
drawn, as opposed to `{ e, t }`, which is a contact point the solver moves.

| entity | `end: 0` | `end: 1` |
| --- | --- | --- |
| line | point `a` | point `b` |
| arc | at `t0` | at `t1` |
| nurbs | domain start | domain end |

It is both a point source and a direction source, so it carries the tangent
there too. That is what lets a profile be closed in two statements per joint:

```js
S.constrain('coincident', { e: arc, end: 1 }, { e: line, end: 0 });  // meet
S.constrain('parallel',   { e: arc, end: 1 }, { e: line });          // smoothly
```

**Prefer this to `tangent` when building a profile.** `tangent` invents its
own contact parameters and is free to place them anywhere on either curve;
combined with endpoint coincidence the two fight, and the sketch will not
converge. Tangency *at a shared end* is just parallel directions there — no
extra unknowns, no branch ambiguity.

### `loops([tol = 1e-6]) → { loops, open }`
Walks the coincidence graph. Ends within `tol` are the same node; a loop
requires every node it passes through to have exactly two edges. Returns
closed chains of `{ id, reversed }`, biggest first, and the chains that did
not close.

### `profile([tol = 0.05]) → { loops, open, closed }`
Loops sampled to polygons.

```js
{
  loops: [ { points: [[x, y], …], area, entities } ],
  open,     // chains that did not close — an unfinished profile
  closed    // open === 0 and at least one loop
}
```

`area` is signed and measured on the polygon actually returned. Loops come
biggest first, and are **oriented by containment**: a loop inside an odd
number of others is a hole, so it carries `hole: true` and runs clockwise with
a negative area. The signed areas therefore sum to the material. This is the
same even-odd rule `sdf2d` uses, so the two cannot disagree.

⚠️ **Loops must not intersect each other.** Two overlapping holes are not a
profile, and the containment test will label them by whichever way the
even-odd count falls. Area converges linearly in `tol`, which is what a
chord approximation does — a slot reaches its analytic area to 0.03 mm² at
`tol = 0.001`.

A full circle closes as a loop on its own, since its two ends are the same
point. Concentric circles are an annulus.

### `sdf2d([tol]) → f(x, y)`
Signed distance to the profile in mm: negative inside, zero on the boundary.
Exact and 1-Lipschitz, which is what anything raymarching it will need.

Holes come from the loops beyond the first — a point inside an odd number of
loops is solid. Sampled once, so moving the sketch afterwards does not change
the returned function. It carries `.loops`, `.closed` and `.open` for
inspection.

### Extruding

`sketch.js` does not do 3D. The operator is five lines against
`sinterform.js`, and it is exact:

```js
const f = S.sdf2d(0.001);
const solid = (x, y, z) => {
  const a = f(x, y), b = Math.abs(z) - height / 2;
  return Math.min(Math.max(a, b), 0) + Math.hypot(Math.max(a, 0), Math.max(b, 0));
};
```

Sample that into a grid, hand it to `SinterForm.surfaceNets`, and it meshes
watertight. The test suite takes a slot the whole way and checks the mesh
volume against area × height.

## Serialisation

### `toJSON() → object` · `Sketch.fromJSON(obj) → Sketch`

A construction script, not a memory dump: entity specs in creation order, then
constraints with refs already resolved. Replaying rebuilds the same ids, which
is what lets refs be plain integers.

Documents carry `sinterSketch: 1`. `fromJSON` refuses anything else rather
than half-reading it.

A restored sketch is already satisfied — `diagnose().converged` is true and
re-solving takes zero iterations.

---

## Recipes

**Drag a point.** Set it, pin it, solve, unpin:

```js
S.set(id, { x, y, fixed: true });
S.solve();
S.fix(id, false);
```

**Live DOF readout.** `S.diagnose().dof` — it moves nothing, so it is safe to
call on every mouse move.

**Check a constraint independently.** Do not read its residual; measure the
geometry:

```js
const a = S.dirOf({ e: line }), b = S.dirOf({ e: spline, t });
const cosine = (a[0]*b[0] + a[1]*b[1]) / (Math.hypot(...a) * Math.hypot(...b));
```

---

## Two things to know

### Tangency is two-valued

Two circles can touch side by side or nested, and both satisfy "touching, with
tangents in line" exactly. Contact parameters are initialised by aiming each
at the other entity, which picks the arrangement someone drawing it would have
meant — three circles told to touch each other land outside each other, from
any starting layout, including from the wrong answer.

That only chooses the near solution. It does not make the far one go away. If
you need a specific branch, start the sketch near it.

### Damping is isotropic

`λ·max(diag(JᵀJ))`, not Marquardt's `λ·diag(JᵀJ)`.

Per-coordinate damping is the textbook choice and it is wrong here. Sketches
are nearly always rank-deficient — four coordinates and one constraint — and
scaling damping per coordinate means the directions with the least curvature
get the least damping, so the step runs furthest exactly where it knows least.
Asked to make two lines perpendicular it returned a step that stretched one of
them to 500 mm instead of rotating it, then converged at a third per iteration
as the gradient weakened.

---

## Errors

Thrown, not returned:

- `no such constraint: <kind>`
- `no entity <id>`
- `ref has no direction — a curve needs {t} or {end}`
- `ref has no position — a curve needs {t} or {end}`
- `entity <id> (<kind>) has no ends` — asking a point or a param for an endpoint
- `entity <id> (<kind>) has no parameterisation` — asking a point for a curve
- `entity <id> (<kind>) has no centre`
- `collinear wants two lines` · `equal wants two lines or two arcs` ·
  `circular wants an arc`
- `not a SinterSketch document (want sinterSketch: 1)`

---

## Tests

```
node check-sketch.mjs
```

110 assertions. Every constraint is verified independently after the solve —
measured from the geometry, not by asking the residual that was just
minimised, because a residual can be small because the constraint is met or
because it was written wrong and is small everywhere.
