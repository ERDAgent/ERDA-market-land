// src/utils/gauss.ts — Box–Muller standard-normal sample (§5.4).
//
// Stateless module-level spare value: each call returns one N(0,1) sample;
// Box–Muller generates two at a time, so the second is cached for the next
// call. The Simulated provider consumes one gauss() per instrument per tick.

let _spare: number | null = null;

/**
 * One standard-normal sample. Box–Muller transform on two independent
 * Uniform(0,1) draws (`Math.random`). The second of the pair is cached and
 * returned on the following call.
 */
export function gauss(): number {
  if (_spare !== null) {
    const s = _spare;
    _spare = null;
    return s;
  }
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const mag = Math.sqrt(-2 * Math.log(u));
  _spare = mag * Math.sin(2 * Math.PI * v);
  return mag * Math.cos(2 * Math.PI * v);
}