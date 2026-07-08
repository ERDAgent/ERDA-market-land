/**
 * THE engine singleton. Plain TS modules hold ALL Three.js objects; Vue and
 * stores never touch Object3Ds (§8.7-1). This file is the registry seam that
 * every later phase plugs into WITHOUT re-editing it:
 *
 *   - **Per-frame systems registry**: this globs `./systems/*.ts` (eager) and
 *     invokes `setup(ctx)` (start), `update(dt, ctx)` (each frame), `dispose(ctx)`
 *     (teardown) when present. At M0 `./systems/` is empty — nothing per-frame
 *     except the built-in fly controls. M1/M4 add city/avatar systems by
 *     dropping files here. NEVER edit core.ts after M0.
 *   - **engine.api**: `{}` at M0. `useEngineBridge` runs `src/bridges/*.ts` once
 *     and they register api slivers (M1 market, M3 connection, M4 avatars, M5
 *     quotes-broadcast). Cross-phase reads go through `engine.api.<x>?.method()`
 *     with optional chaining so any merge order compiles.
 *
 * The fly controls are a built-in system registered here directly (not a dropped
 * `./systems/*.ts` file) because they are M0's own and must always be present.
 */
import * as THREE from 'three';
import { Emitter, type EngineEvents } from './emitter';
import { RafLoop } from './loop';
import { createFlyControls, type FlyControlsApi } from './flyControls';

export interface EngineSystem {
  setup?(ctx: EngineContext): void;
  update?(dt: number, ctx: EngineContext): void;
  dispose?(ctx: EngineContext): void;
}

export interface EngineContext {
  readonly engine: Engine;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly events: Emitter<EngineEvents>;
  readonly dt: number;
}

/** Per-frame HUD/debug snapshot consumed by the Vue debug overlay (primitive only). */
export interface EngineStats {
  fps: number;
  drawCalls: number;
  systems: number;
  peers: number;
  dataBudgetPct: number;
}

export interface EngineApi {
  fly?: FlyControlsApi;
  [key: string]: unknown;
}

const systemModules = import.meta.glob('./systems/*.ts', { eager: true }) as Record<
  string,
  { default?: EngineSystem } | undefined
>;

const SCENE_BG = 0x0b0f14;
const GROUND_COLOR = 0x10161d;
const GRID_COLOR_CENTER = 0x1d2a3a;
const GRID_COLOR = 0x152030;

class Engine {
  readonly events = new Emitter<EngineEvents>();
  api: EngineApi = {};
  canvas: HTMLCanvasElement | null = null;

  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 4000);
  renderer!: THREE.WebGLRenderer;

  stats: EngineStats = { fps: 0, drawCalls: 0, systems: 0, peers: 0, dataBudgetPct: 0 };

  private loop: RafLoop | null = null;
  private systems: EngineSystem[] = [];
  private fly: (EngineSystem & { api: FlyControlsApi }) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private onWindowResize = (): void => this.resize();

  private fpsTimer = 0;
  private fpsFrames = 0;
  private frameCount = 0;
  private disposed = false;

  /** HUD speed pinger (read by a HUD component later); primes to default 15. */
  speedHud = { speed: 15, until: 0 };

  init(canvas: HTMLCanvasElement): void {
    if (this.canvas === canvas && this.renderer) return; // idempotent guard
    this.canvas = canvas;
    this.disposed = false;

    // Scene & atmosphere (§8.1).
    this.scene.background = new THREE.Color(SCENE_BG);
    this.scene.fog = new THREE.Fog(SCENE_BG, 250, 900);

    // Renderer.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    // Ground/lights/grid.
    this.renderer.shadowMap.enabled = false;

    // Ground — huge plane.
    const groundGeo = new THREE.PlaneGeometry(4000, 4000);
    const groundMat = new THREE.MeshBasicMaterial({ color: GROUND_COLOR });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.name = 'ground';
    this.scene.add(ground);

    // Subtle grid (120 divisions, low-contrast).
    const grid = new THREE.GridHelper(2400, 120, GRID_COLOR_CENTER, GRID_COLOR);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    grid.position.y = 0.01;
    grid.name = 'grid';
    this.scene.add(grid);

    // Lighting.
    const hemi = new THREE.HemisphereLight(0x8899bb, GROUND_COLOR, 0.9);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(1 * 300, 2 * 300, 1 * 300);
    this.scene.add(dir);

    // Camera spawn + fly controls (built-in system).
    this.fly = createFlyControls(this.camera, canvas, { speedHud: this.speedHud });
    this.api.fly = this.fly.api;

    const ctx = this.makeContext(0);
    this.fly.setup?.(ctx);

    // Systems registry: drop-in `./systems/*.ts`. Tolerates an empty glob (M0).
    this.systems = Object.values(systemModules)
      .map((m) => m?.default)
      .filter((s): s is EngineSystem => Boolean(s));
    this.stats.systems = this.systems.length;
    for (const s of this.systems) s.setup?.(ctx);

    // Resize handling.
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    window.addEventListener('resize', this.onWindowResize);

    // The one rAF loop.
    this.loop = new RafLoop((dt) => this.frame(dt));
    this.loop.start();
  }

  private frame(dt: number): void {
    if (this.disposed) return;
    const ctx = this.makeContext(dt);
    this.fly?.update?.(dt, ctx);
    for (const s of this.systems) s.update?.(dt, ctx);
    this.renderer.render(this.scene, this.camera);

    // Stats (primitives only — safe for the debug overlay to read).
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.fpsTimer += dt;
    this.fpsFrames += 1;
    if (this.fpsTimer >= 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsTimer;
      this.fpsTimer = 0;
      this.fpsFrames = 0;
    }
    this.frameCount += 1;
  }

  resize(): void {
    const c = this.canvas;
    if (!c || !this.renderer) return;
    const w = c.clientWidth || c.parentElement?.clientWidth || window.innerWidth;
    const h = c.clientHeight || c.parentElement?.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private makeContext(dt: number): EngineContext {
    return {
      engine: this,
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      events: this.events,
      dt,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.loop?.stop();
    this.loop = null;

    const ctx = this.makeContext(0);
    this.fly?.dispose?.(ctx);
    for (const s of this.systems) s.dispose?.(ctx);

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('resize', this.onWindowResize);

    // Dispose geometries/materials (§15: no leak leave → menu → rejoin), then
    // drop children so a subsequent `engine.init` rebuilds a fresh scene instead
    // of stacking new objects on top of disposed (and thus broken) ones.
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    this.scene.clear();
    this.renderer?.dispose();
    this.events.clear();
    this.systems = [];
    this.fly = null;
    delete this.api.fly;
    this.stats = { fps: 0, drawCalls: 0, systems: 0, peers: 0, dataBudgetPct: 0 };
    this.canvas = null;
  }
}

export const engine = new Engine();
export type { Engine };