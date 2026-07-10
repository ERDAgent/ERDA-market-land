// tests/bullets.spec.ts — BULLET1 pure hit-math (no THREE/DOM dependency).
//
// `raycastHit(origin, dir, targets, radius, maxRange)` is ray-vs-point-with-
// radius: nearest-along-ray-wins, target must be in front of the shooter
// (positive distance along `dir`), and within `maxRange`. `dir` is assumed a
// unit vector in every case below (mirrors how bullets.ts always calls it
// with `camera.getWorldDirection()`'s normalized output).

import { describe, it, expect } from 'vitest';
import { raycastHit, HIT_RADIUS, MAX_RANGE, type HitTarget } from '../src/engine/systems/bullets';

const ORIGIN = { x: 0, y: 0, z: 0 };
const FORWARD = { x: 0, y: 0, z: -1 }; // unit vector, -z per this app's camera convention

function target(id: string, x: number, y: number, z: number): HitTarget {
  return { id, position: { x, y, z } };
}

describe('BULLET1 raycastHit — pure hit math', () => {
  it('a shot within the hit radius of a target counts as a hit at the right distance', () => {
    const t = target('a', 0, 0, -50);
    const hit = raycastHit(ORIGIN, FORWARD, [t]);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('a');
    expect(hit!.distance).toBeCloseTo(50, 6);
  });

  it('a shot within radius but off-axis still hits (perpendicular offset < radius)', () => {
    const t = target('a', HIT_RADIUS - 1, 0, -50);
    const hit = raycastHit(ORIGIN, FORWARD, [t]);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('a');
  });

  it('a shot outside the hit radius misses', () => {
    const t = target('a', HIT_RADIUS + 5, 0, -50);
    const hit = raycastHit(ORIGIN, FORWARD, [t]);
    expect(hit).toBeNull();
  });

  it('a target behind the shooter (negative distance along the ray) never counts', () => {
    const t = target('a', 0, 0, 50); // +z is behind, since FORWARD is -z
    const hit = raycastHit(ORIGIN, FORWARD, [t]);
    expect(hit).toBeNull();
  });

  it('a target exactly at the shooter (distance 0) is not "behind" and can still hit', () => {
    const t = target('a', 0, 0, 0);
    const hit = raycastHit(ORIGIN, FORWARD, [t]);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBe(0);
  });

  it('with multiple targets in line, the nearest one wins', () => {
    const near = target('near', 0, 0, -20);
    const mid = target('mid', 0, 0, -50);
    const far = target('far', 0, 0, -80);
    const hit = raycastHit(ORIGIN, FORWARD, [far, mid, near]); // deliberately out of order
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('near');
    expect(hit!.distance).toBeCloseTo(20, 6);
  });

  it('a target beyond max range does not count', () => {
    const t = target('a', 0, 0, -(MAX_RANGE + 1));
    const hit = raycastHit(ORIGIN, FORWARD, [t]);
    expect(hit).toBeNull();
  });

  it('a target exactly at max range still counts (boundary inclusive)', () => {
    const t = target('a', 0, 0, -MAX_RANGE);
    const hit = raycastHit(ORIGIN, FORWARD, [t]);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('a');
  });

  it('no targets ⇒ no hit', () => {
    expect(raycastHit(ORIGIN, FORWARD, [])).toBeNull();
  });

  it('a nearer target that is a miss (outside radius) does not block a farther hit', () => {
    const nearMiss = target('nearMiss', HIT_RADIUS + 5, 0, -20); // off-axis, out of radius
    const farHit = target('farHit', 0, 0, -60);
    const hit = raycastHit(ORIGIN, FORWARD, [nearMiss, farHit]);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('farHit');
  });

  it('respects a custom radius/maxRange override', () => {
    const t = target('a', 3, 0, -10);
    expect(raycastHit(ORIGIN, FORWARD, [t], 2, MAX_RANGE)).toBeNull(); // tighter radius ⇒ miss
    expect(raycastHit(ORIGIN, FORWARD, [t], 5, MAX_RANGE)).not.toBeNull(); // looser radius ⇒ hit
    expect(raycastHit(ORIGIN, FORWARD, [t], 5, 5)).toBeNull(); // tighter maxRange ⇒ out of range
  });
});
