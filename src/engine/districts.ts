// src/engine/districts.ts — §7.1 district ground slabs + name sprites (helper).
//
// Called once from the buildings system setup. Creates, per district, a raised
// dark-tint ground slab (PLOT×0.3×PLOT) and a large floating district-name
// sprite (1024×256 canvas, sizeAttenuation, scale 160×40 / ~2.67×
// (-20% of I2's 200×50) (emoji + name, two-line)) centered over the plot (cx, cz) at y≈140
// (clears H_MAX=60). All Three objects are tracked here and disposed on
// teardown.
//
// CRT green-phosphor restyle: slabs take a dark-green tint of the frozen
// city.ts base color (subtle/dark — slabs are background) via a green multiply;
// name sprite text renders in phosphor green (emoji stays colorful — color-emoji
// fonts ignore fillStyle, the one splash of life on the mono CRT).
//
// NOT a per-frame system (no update). Pure construction + disposal helper.

import * as THREE from 'three';
import { DISTRICTS, type DistrictId, PLOT, plotCenter } from '../config/city';

const NAME_CANVAS_W = 1024;
const NAME_CANVAS_H = 256;

// Pure visual sprite content (local to this file). The sidebar still uses
// `districtLabel` from utils/format; the floating sprite uses its own map so
// the on-sprite copy can differ (e.g. fx → "Foreign Exchange",
// energy_industrial → "Energy & Industry"). Emoji→name per the Admiral's map.
const DISTRICT_TITLE: Record<DistrictId, { emoji: string; name: string }> = {
  energy_industrial: { emoji: '🏭', name: 'Energy & Industry' },
  consumer:          { emoji: '🛒', name: 'Consumer' },
  fx:                { emoji: '🌎', name: 'Foreign Exchange' },
  commodities:       { emoji: '📦', name: 'Commodities' },
  indexes:           { emoji: '📊', name: 'Indexes' },
  tech:              { emoji: '💻', name: 'Tech' },
  healthcare:        { emoji: '💊', name: 'Healthcare' },
  finance:           { emoji: '🏦', name: 'Finance' },
  crypto:            { emoji: '🪙', name: 'Crypto' },
};

function makeNameTexture(emoji: string, name: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = NAME_CANVAS_W;
  c.height = NAME_CANVAS_H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(8,12,18,0.0)';
  g.fillRect(0, 0, c.width, c.height);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = 12;

  // Line 1 — emoji. Color-emoji fonts ignore fillStyle (render in full color);
  // a monochrome fallback would pick this opaque color up.
  // NOTE: a real font stack. Canvas `g.font` does NOT resolve CSS variables, so
  // the old `'700 112px var(--font)'` was silently falling back to the browser
  // default. Emoji renders via the system emoji font regardless of stack.
  g.font = '100 100px "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  g.fillStyle = '#7dff8a';
  g.fillText(emoji, c.width / 2, c.height * 0.30);

  // Line 2 — name (uppercase). Real font stack — phosphor green (emoji above
  // stays colorful via color-emoji font, which ignores fillStyle).
  g.font = '700 80px "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  g.fillStyle = '#5dff7a';
  g.fillText(name.toUpperCase(), c.width / 2, c.height * 0.72);

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
    // CRT green-phosphor: slabs take a dark-green tint of the frozen
    // city.ts base color (subtle/dark — slabs are background). We multiply the
    // existing def.color by a green vector so a faint per-district variation
    // survives but the whole slab family reads green on the mono CRT.
    const slabColor = new THREE.Color(def.color).multiply(new THREE.Color(0x4a8a5a));
    const mat = new THREE.MeshLambertMaterial({ color: slabColor });
    const slab = new THREE.Mesh(slabGeo, mat);
    slab.position.set(cx, 0.15, cz);
    slab.name = `district-slab:${id}`;
    scene.add(slab);
    slabs.push(slab);

    // Name sprite centered over the plot (cx, cz), y≈140 (clears H_MAX=60).
    const title = DISTRICT_TITLE[id];
    const tex = makeNameTexture(title.emoji, title.name);
    const mat2 = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const sp = new THREE.Sprite(mat2);
    sp.scale.set(160, 40, 1);
    sp.position.set(cx, 140, cz);
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