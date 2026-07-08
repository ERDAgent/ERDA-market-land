/**
 * One rAF loop owns ALL per-frame work (§8.7-2). `Engine.frame(dt)` is the only
 * tick callback; it drives fly controls, the systems registry, and the render.
 * This class is just the thin rAF/scheduling layer so the clock delta math lives
 * in exactly one place.
 */
export class RafLoop {
  private rafId = 0;
  private last = 0;
  private running = false;

  constructor(private readonly tick: (dt: number) => void) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    // Clamp dt so a long pause (tab switch) doesn't teleport the camera across the map.
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.tick(dt);
    this.rafId = requestAnimationFrame(this.frame);
  };
}