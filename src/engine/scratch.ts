/**
 * Recycled scratch Three objects. §8.7-3: no per-frame allocations in hot paths.
 * Anything running inside the rAF loop MUST reuse these instead of `new`-ing.
 */
import * as THREE from 'three';

export const scratch = {
  v3a: new THREE.Vector3(),
  v3b: new THREE.Vector3(),
  v3c: new THREE.Vector3(),
  v3d: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  m4: new THREE.Matrix4(),
  euler: new THREE.Euler(0, 0, 0, 'YXZ'),
} as const;