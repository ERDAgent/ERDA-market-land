// src/engine/districts.ts — §7.1 district ground slabs + name sprites (helper).
//
// Called once from the buildings system setup. Creates, per district, a raised
// dark-tint ground slab (PLOT×0.3×PLOT) and a large floating district-name
// sprite (1024×256 canvas, sizeAttenuation) anchored over the plot's −z edge
// at y≈28. All Three objects are tracked here and disposed on teardown.
//
// NOT a per-frame system (no update). Pure construction + disposal helper.

import * as THREE from 'three';
import { DISTRICTS, type DistrictId, PLOT, PITCH, plotCenter } from '../config/city';
import { districtLabel } from '../utils/format';

const NAME_CANVAS_W = 1024;
const NAME_CANVAS_H = 256;

function makeNameTexture(label: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = NAME_CANVAS_W;
  c.height = NAME_CANVAS_H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(8,12,18,0.0)';
  g.fillRect(0, 0, c.width, c.height);
  g.font = '700 96px var(--font)';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#9fb2c6';
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 12;
  g.fillText(label.toUpperCase(), c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export interface DistrictOverlay {
  dispose(): void;
}

export function buildDistricts(scene: THREE.Scene): DistrictOverlay {
  const slabs: THREE.Mesh[] = [];
  const nameSprites: THREE.Sprite[] = [];
  const nameTextures: THREE.CanvasTexture[] = [];
  const slabGeo = new THREE.BoxGeometry(PLOT, 0.3, PLOT);

  for (const id of Object.keys(DISTRICTS) as DistrictId[]) {
    const def = DISTRICTS[id];
    const [cx, , cz] = plotCenter(def.col, def.row);
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(def.color) });
    const slab = new THREE.Mesh(slabGeo, mat);
    slab.position.set(cx, 0.15, cz);
    slab.name = `district-slab:${id}`;
    scene.add(slab);
    slabs.push(slab);

    // Name sprite over the plot's −z edge, y≈28.
    const tex = makeNameTexture(districtLabel(id));
    const mat2 = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const sp = new THREE.Sprite(mat2);
    sp.scale.set(60, 15, 1);
    sp.position.set(cx, 28, cz - PLOT / 2);
    sp.name = `district-name:${id}`;
    scene.add(sp);
    nameSprites.push(sp);
    nameTextures.push(tex);
  }

  return {
    dispose() {
      for (const s of slabs) scene.remove(s);
      for (const s of nameSprites) scene.remove(s);
      slabGeo.dispose();
      slabs.forEach((s) => (s.material as THREE.Material).dispose());
      nameSprites.forEach((s) => (s.material as THREE.SpriteMaterial).dispose());
      nameTextures.forEach((t) => t.dispose());
    },
  };
}