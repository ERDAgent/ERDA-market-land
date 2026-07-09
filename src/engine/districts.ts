// src/engine/districts.ts — §7.1 district ground slabs + name sprites (helper).
//
// Called once from the buildings system setup. Creates, per district, a raised
// dark-tint ground slab (PLOT×0.3×PLOT) and a large floating district-name
// sprite (1024×256 canvas, sizeAttenuation, scale 160×40 / ~2.67×
// (-20% of I2's 200×50) (emoji + name, two-line)) centered over the plot (cx, cz) at y≈140
// (clears H_MAX=60). All Three objects are tracked here and disposed on
// teardown.
//
// CRT restyle (K1): slabs read as a 50% transparent green fill with a thick
// solid green outline via ONE shared CanvasTexture (square canvas: 50% green
// fill across the face + a thick opaque green border ring drawn on top) applied
// as a flat MeshBasicMaterial (transparent, depthWrite:false) so the
// ground/grid is faintly visible through the center. Name sprite text renders
// in WHITE (Admiral authorized white titles; emoji stays colorful — color-emoji
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

  // Line 2 — name (uppercase). Real font stack — WHITE title text (K1; emoji
  // above stays colorful via color-emoji font, which ignores fillStyle).
  g.font = '700 80px "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  g.fillStyle = '#ffffff';
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
  // ONE shared slab face texture for all 9 slabs: 90% transparent green fill +
  // a thin opaque green border ring. Built once, disposed once on teardown.
  const slabTex = makeSlabTexture();

  for (const id of Object.keys(DISTRICTS) as DistrictId[]) {
    const def = DISTRICTS[id];
    const [cx, , cz] = plotCenter(def.col, def.row);
    // CRT (K1): flat green-tinted slab — 90% transparent green fill + thin
    // solid green outline via the shared canvas texture. MeshBasicMaterial so
    // it reads as a flat emissive CRT fill (ignores scene lights).
    const mat = new THREE.MeshBasicMaterial({
      map: slabTex,
      transparent: true,
      depthWrite: false,
    });
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
      slabTex.dispose();
    },
  };
}

/** Shared square slab face texture: 90% transparent green fill + thin opaque green border ring. */
function makeSlabTexture(): THREE.CanvasTexture {
  const SIZE = 256;
  const BORDER = 3; // thin frame on the 256px square (−75% vs the old 12px ring)
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, SIZE, SIZE);
  // Interior: 90% transparent phosphor-green fill across the whole square
  // (ground/grid clearly visible through it via the transparent material).
  g.fillStyle = 'rgba(46, 255, 122, 0.1)';
  g.fillRect(0, 0, SIZE, SIZE);
  // Thin opaque green border ring so the perimeter reads as a crisp thin green
  // outline while the center stays 90% see-through.
  g.fillStyle = '#2eff7a';
  // Top & bottom strips.
  g.fillRect(0, 0, SIZE, BORDER);
  g.fillRect(0, SIZE - BORDER, SIZE, BORDER);
  // Left & right strips.
  g.fillRect(0, 0, BORDER, SIZE);
  g.fillRect(SIZE - BORDER, 0, BORDER, SIZE);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}