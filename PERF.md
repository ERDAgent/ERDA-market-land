# PERF — structural performance report (M5G Gate 4)

> This is a **structural** report. A live multi-tab browser cannot be driven from
> a crew berth, so the draw-call count and per-frame work below are derived by
> reading the merged engine code (files + line ranges cited) and reasoning about
> what the single rAF loop submits to `WebGLRenderer.render()` each frame. The
> §16 DoD gate is "60 fps integrated + 8 simulated avatars, draw calls < 200
> (report)". Live multi-peer + label-LOD behavior remains recommended for a
> captain's telescope smoke on `integration`.

## 1. The one rAF loop

There is a single `requestAnimationFrame` loop:

- `src/engine/loop.ts:1–40` — `RafLoop` starts one rAF; `frame()` calls the
  registered tick callback each tick.
- `src/engine/core.ts:151` — `this.loop = new RafLoop((dt) => this.frame(dt))`.
- `src/engine/core.ts:155–173` — `frame(dt)`:
  1. `this.fly?.update?.(dt, ctx)` — built-in fly controls (one system, M0).
  2. `for (const s of this.systems) s.update?.(dt, ctx)` — the systems glob
     (`import.meta.glob('./systems/*.ts', { eager: true })`, `core.ts:46–50`).
  3. `this.renderer.render(this.scene, this.camera)` — exactly one render/f
  4. `this.stats.drawCalls = this.renderer.info.render.calls` (`core.ts:163`) —
     the authoritative render-time draw-call count, surfaced to the debug
     overlay.

No per-frame allocations in the hot path: systems lerp/slerp into the shared
M0 scratch object (`src/engine/scratch.ts`) and copy out immediately (avatars
`systems/avatars.ts:369–372`; buildings reuses module-level `Vector3`/
`Quaternion`/`Color` scratch, `systems/buildings.ts:68–71`).

## 2. Per-frame work enumeration

Eager-globbed systems (`systems/*.ts`), run every frame via `s.update`:

| System | File | Per-frame work |
|---|---|---|
| Buildings | `src/engine/systems/buildings.ts:140–180` | height tween (lerp `hCurrent → hTarget`) + color blend toward target; writes instanceMatrix + instanceColor only when `moved`. One `InstancedMesh` update, ≤117 instances. |
| Labels | `src/engine/systems/labels.ts:159–187` | LOD evaluated at **4 Hz** (`LOD_INTERVAL_S = 0.25`, line 28), NOT per frame. Repaint budget **≤8 canvases/frame**, nearest-first (line 174, `REPAINT_BUDGET_PER_FRAME = 8`). Idle-skips when buildings not animating (line 181 `buildings.animating()`). |
| Picking | `src/engine/systems/picking.ts:1–55` | hover highlight **throttled 10 Hz** (`HOVER_HZ = 10`, `HOVER_INTERVAL_MS = 100`, lines 18–19); raycast only on pointermove, throttled. |
| Avatars | `src/engine/systems/avatars.ts:360–390` | for each remote peer: lerp position + slerp quaternion into scratch (`scratch.v3a`/`scratch.q`), copy out. O(N peers). |
| Fly-to | `src/engine/systems/flyTo.ts:73–80` | active only when a tween is running; otherwise `if (!active) return` (line 74). No cost when idle. |
| Fly controls | `src/engine/flyControls.ts` (built-in, `core.ts:155`) | keyboard damping + pointer-look deltas; constant cost. |

The heaviest per-frame CPU cost is the **≤8 canvas repaints** for nearest
labels (`labels.ts:173–178`). At city scale (≤117 buildings) this is well
under an integrated-graphics frame budget; canvas `fillText` is the dominant
ops cost and is bounded at 8/frame.

## 3. Draw-call count (structural)

Render-time draw calls come from `WebGLRenderer.info.render.calls`. Counting
every object added to the scene graph:

| Object | Count | Source |
|---|---|---|
| Ground plane (`PlaneGeometry`) | 1 | `core.ts:105–111` |
| Grid helper (`GridHelper` → 1 `LineSegments`) | 1 | `core.ts:113–119` |
| District slabs (1 `Mesh` per district) | 9 | `districts.ts:43–56` (one `Mesh` per `DISTRICTS` key; 9 districts in `config/city.ts:47–69`) |
| District-name sprites (1 `Sprite` per district) | 9 | `districts.ts:44–71` |
| Buildings `InstancedMesh` (117 instances) | 1 | `systems/buildings.ts:113–116` (`InstancedMesh(geo, mat, count)`, count = manifest length = 117, verified via `grep -o '"id"' src/data/manifest/instruments.json | wc -l` = 117) |
| Building label sprites (`Sprite`, 1 per building) | up to 117 | `systems/labels.ts:138–152` (one Sprite per manifest instrument; `visible=false` past `LOD_TICKER = 160u` so far labels are skipped by Three.js — worst case counts them as active) |
| Avatar cone (`Mesh`) | up to N peers | `systems/avatars.ts:190` (`new THREE.Mesh(coneGeo, coneMat)`), 1 cone per remote peer |
| Avatar name-tag (`Sprite`) | up to N peers | `systems/avatars.ts:207` (`new THREE.Sprite(tagMat)`), 1 tag per remote peer |

**Structural worst-case total:**

```
1 (ground) + 1 (grid) + 9 (slabs) + 9 (name sprites)
  + 1 (InstancedMesh, 117 instances) + 117 (label sprites)
  + 2·N (cone + tag per avatar)
= 138 + 2·N
```

**At N = 8 simulated avatars (the §16 gate):**

```
138 + 2·8 = 138 + 16 = 154  ✓  < 200
```

Headroom to the 200-draw-call ceiling: **46** (≈30%). At N = 31 the count
reaches 200, far beyond any plausible session for this build.

Note: in practice the count is materially **lower** than 154, because label
sprites `visible = false` past 160u (`labels.ts:26–27`, `212–216`) are not
rendered, so only labels within the LOD_TICKER band submit a draw. At a
typical ground-level fly cam a handful of labels are visible, not 117. The
154 figure is the conservative worst-case (every label visible), used here to
assert the ceiling with margin.

## 4. 60 fps reasoning (integrated-graphics class)

Target: **60 fps** on an integrated-graphics-class machine (the build target,
`README` § Build: modern Chrome/Edge/Firefox/Safari).

Per-frame CPU is bounded and allocation-free:
- **Buildings**: 117 instanceMatrix / instanceColor writes, no allocations
  (scratch `Vector3`/`Color`, `buildings.ts:68–71`). `DynamicDrawUsage`
  (`buildings.ts:117`) so the buffer upload is incremental.
- **Labels**: ≤8 `fillText` repaints/frame nearest-first, LOD evaluated at
  4 Hz (`labels.ts:28, 161, 173–178`). The 3-line 256×128 canvas texture is
  generated once and re-uploaded only when a quote dirties a label
  (`labels.ts:11–16`).
- **Picking**: raycast throttled to 10 Hz (`picking.ts:18–19`), pointermove-only.
- **Avatars**: O(N) lerp/slerp into shared scratch (`avatars.ts:369–372`),
  N ≤ 8 ⇒ negligible.
- **Fly-to**: cost only while a tween is active (`flyTo.ts:25, 73–74`).

GPU: 154 draw calls + 1 InstancedMesh (117 instances in a single draw) is
trivial for any integrated GPU at 60 fps. `shadowMap.enabled = false`
(`core.ts:102`) — no shadow pass. Pixel ratio is capped at 2
(`core.ts:100`, `Math.min(dpr, 2)`), bounding the fragment load on high-DPI.

The dominant risk to a steady 60 fps is the **≤8 label canvas repaints/frame**
when many labels are simultaneously near + freshly quoted; at this city scale
(≤117 buildings) that remains comfortably under one frame's budget.

## 5. Caveats / verification status

- **Live multi-peer unverified.** Three guests in three browser tabs sharing
  identical quotes, plus "fresh guest sees prices within 1 s of welcome," is
  the runtime gate (§16). The wire receive leg is now wired (M5G Gate 1,
  `src/net/guest.ts` welcome/quotesDelta/quotesFull → `engine.api.market`),
  but the actual fps under a real WebRTC session is *structural-only* here.
  Recommend: **captain's telescope smoke on `integration`** (3 tabs, dev
  server) eyeballing the `drawCalls`/`fps` debug overlay added by the
  `core.ts:163` stats line.
- **Label-LOD behavior unverified without a browser.** The visible-far-skip
  relies on Three.js not rendering `Sprite.visible = false`; this is standard
  but unmeasured here. The conservative 154 worst-case assumes all labels
  visible, so the asserted ceiling holds even if LOD never kicks in.
- **`renderer.info.render.calls` is the source of truth**, surfaced live in the
  debug overlay (`README` controls + `core.ts:163`). A telescope smoke can
  read the real number directly — no further code guesswork needed.

## 6. Files / line ranges read for this count

- `src/engine/core.ts:46–50` (systems glob), `:99–128` (ground + grid setup),
  `:151–173` (one rAF + `drawCalls` stat)
- `src/engine/loop.ts:1–40` (single rAF)
- `src/engine/systems/buildings.ts:113–117` (one `InstancedMesh`, count = 117),
  `:68–71, 140–180` (scratch + per-frame tween)
- `src/engine/systems/labels.ts:26–29` (LOD/budget consts), `:138–152` (one
  Sprite per building), `:159–216` (update + LOD eval)
- `src/engine/systems/picking.ts:18–19` (10 Hz hover throttle)
- `src/engine/systems/avatars.ts:190, 207` (cone Mesh + tag Sprite), `:360–390`
  (lerp/slerp into scratch)
- `src/engine/systems/flyTo.ts:25, 73–80` (active gate)
- `src/engine/districts.ts:43–71` (9 slabs + 9 name sprites)
- `src/config/city.ts:47–69` (9 districts)
- `src/data/manifest/instruments.json` (117 instruments, `grep -o '"id"' | wc -l`)

**Assertion: draw calls < 200 at 8 avatars — ≈ 154 worst-case — holds
structurally with ~30% headroom.**