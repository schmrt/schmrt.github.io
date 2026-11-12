// The 3D view: builds a three.js scene from the plan and lets you orbit around the room or walk
// through it. This module is loaded on demand the first time someone switches to 3D (see setView in
// panels.js), so the plan keeps working even if three.js can't be downloaded.
//
// Plan coordinates map to three.js like this: plan x -> x, plan y -> z, height above the floor -> y.
// Something at plan angle θ (radians, measured like the plan's rotation) gets rotation.y = -θ, which
// sends its local x along the plan direction θ and its local +z toward the plan's "front" (+y).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WALL_THICKNESS as T, pointInPolygon, distanceToSegment, pointInItem } from './geometry.js';
import { ITEM_DEFS, isFlat, isSurface, isTabletop } from './catalog.js';
import { app, getWalls, wallColor, setSelection } from './state.js';
import { setTab } from './panels.js';
import { artColor, frameBorders } from './frames.js';

const EYE_HEIGHT = 1.6;      // walking camera height, metres
const WALK_SPEED = 1.3;      // metres per second; Shift doubles it
const TURN_SPEED = 1.9;      // radians per second for the turn keys
const WALL_MARGIN = 0.25;    // how close the walking camera may get to a wall

let stage, renderer, scene, camera, orbit, sun, ground;
let roomGroup = null;
let active = false;
let mode = 'orbit';          // 'orbit' or 'walk'
let planKey = '';            // JSON of the plan the scene was built from
let selectionKey = '';
let lastTime = 0;
let highlight = null;
let roomBounds = null;       // { minX, maxX, minZ, maxZ, height }
let savedOrbit = null;       // orbit camera position and target while walking
/** Things that can be clicked: `${kind}:${id}` -> group (with userData.sel and userData.box). */
const selectable = new Map();
/** Walls and corner fills, for hiding the walls between the orbit camera and the room. */
let wallParts = [];
let cornerParts = [];
let ceiling = null;
const walk = { x: 0, z: 0, yaw: 0, pitch: -0.08 };
const held = new Set();      // movement keys and pad buttons currently held
const theme = {};

/* ------------------------------------------------------------------ small helpers */

const $ = selector => document.querySelector(selector);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Seeded random numbers (mulberry32), so books and leaves look the same on every rebuild. */
function seeded(text) {
  let a = 2166136261;
  for (const ch of String(text)) a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Darken (factor < 1) or lighten toward white (factor > 1) a hex colour. */
function tone(hex, factor) {
  const color = new THREE.Color(hex);
  if (factor < 1) color.multiplyScalar(factor);
  else color.lerp(new THREE.Color('#ffffff'), Math.min(1, factor - 1));
  return '#' + color.getHexString();
}

function readTheme() {
  const style = getComputedStyle(document.documentElement);
  for (const name of ['paper', 'grid', 'accent']) theme[name] = style.getPropertyValue('--' + name).trim() || '#888888';
}

/* ------------------------------------------------------------------ materials and textures */

/** Roughness and metalness for each furniture material in catalog.js. */
const FINISHES = {
  wood: [0.62, 0], painted: [0.5, 0], fabric: [0.95, 0], leather: [0.42, 0], metal: [0.32, 0.7], stone: [0.28, 0],
};
const materialCache = new Map();
const textureCache = new Map();

/** A shared standard material. Cached, so rebuilding the scene doesn't pile up GPU programs. */
function finish(color, material = 'painted', extra = {}) {
  const key = color + '|' + material + '|' + JSON.stringify(extra);
  if (!materialCache.has(key)) {
    const [roughness, metalness] = FINISHES[material] || [0.6, 0];
    materialCache.set(key, new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra }));
  }
  return materialCache.get(key);
}

function canvasTexture(key, size, paint) {
  if (textureCache.has(key)) return textureCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  paint(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  textureCache.set(key, texture);
  return texture;
}

const shadeRGBA = (random, strength) => (random() < 0.5 ? `rgba(255,255,255,${strength})` : `rgba(0,0,0,${strength})`);

/** Floor textures repeat; `span` is how many metres one copy of the texture covers. */
const FLOORS = {
  planks: { span: 2.4, roughness: 0.55, paint(g, size, random) {
    const rows = 16, rowPx = size / rows, perMetre = size / 2.4;
    for (let row = 0; row < rows; row++) {
      let x = -random() * 1.4 * perMetre;
      while (x < size) {
        const length = (0.9 + random() * 0.8) * perMetre;
        g.fillStyle = shadeRGBA(random, 0.04 + random() * 0.1);
        g.fillRect(x, row * rowPx, length, rowPx);
        for (let k = 0; k < 4; k++) { // grain
          g.fillStyle = shadeRGBA(random, 0.05);
          g.fillRect(x, row * rowPx + random() * rowPx, length, 1);
        }
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x, row * rowPx, 1.5, rowPx);
        x += length;
      }
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(0, row * rowPx, size, 1.5);
    }
  } },
  tile: { span: 1.2, roughness: 0.3, paint(g, size, random) {
    const tile = size / 2;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      g.fillStyle = shadeRGBA(random, 0.03 + random() * 0.05);
      g.fillRect(i * tile, j * tile, tile, tile);
    }
    g.fillStyle = 'rgba(255,255,255,0.45)';
    for (let i = 0; i < 2; i++) { g.fillRect(i * tile, 0, 3, size); g.fillRect(0, i * tile, size, 3); }
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let i = 0; i < 2; i++) { g.fillRect(i * tile + 3, 0, 1, size); g.fillRect(0, i * tile + 3, size, 1); }
  } },
  carpet: { span: 1, roughness: 1, paint(g, size, random) {
    for (let k = 0; k < 26000; k++) { g.fillStyle = shadeRGBA(random, 0.09); g.fillRect(random() * size, random() * size, 1.5, 1.5); }
  } },
  concrete: { span: 2, roughness: 0.8, paint(g, size, random) {
    for (let k = 0; k < 40; k++) {
      const x = random() * size, y = random() * size, r = 20 + random() * 90;
      const gradient = g.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, shadeRGBA(random, 0.06));
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gradient;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    for (let k = 0; k < 9000; k++) { g.fillStyle = shadeRGBA(random, 0.12); g.fillRect(random() * size, random() * size, 1, 1); }
  } },
};

function floorMaterial(material, color) {
  const spec = FLOORS[material] || FLOORS.planks;
  const key = 'floor|' + material + '|' + color;
  if (materialCache.has(key)) return materialCache.get(key);
  const texture = canvasTexture(key, 512, (g, size) => {
    g.fillStyle = color;
    g.fillRect(0, 0, size, size);
    spec.paint(g, size, seeded(material));
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / spec.span, 1 / spec.span); // floor UVs are in metres
  const result = new THREE.MeshStandardMaterial({ map: texture, roughness: spec.roughness });
  materialCache.set(key, result);
  return result;
}

/** Rug textures cover the whole rug once. */
function rugMaterial(material, color, round) {
  const key = 'rug|' + material + '|' + color + '|' + round;
  if (materialCache.has(key)) return materialCache.get(key);
  const texture = canvasTexture(key, 512, (g, size) => {
    const random = seeded(key);
    g.fillStyle = color;
    g.fillRect(0, 0, size, size);
    const light = tone(color, 1.45), dark = tone(color, 0.6);
    if (material === 'stripes') {
      for (let x = 0, k = 0; x < size; k++) {
        const band = 18 + random() * 40;
        if (k % 2) { g.fillStyle = k % 4 === 1 ? light : dark; g.fillRect(x, 0, band, size); }
        x += band;
      }
    } else if (material === 'border') {
      const inset = round ? size * 0.08 : size * 0.07;
      g.strokeStyle = light; g.lineWidth = size * 0.05;
      if (round) { g.beginPath(); g.arc(size / 2, size / 2, size / 2 - inset, 0, Math.PI * 2); g.stroke(); }
      else g.strokeRect(inset, inset, size - 2 * inset, size - 2 * inset);
      g.strokeStyle = dark; g.lineWidth = size * 0.012;
      if (round) { g.beginPath(); g.arc(size / 2, size / 2, size / 2 - inset * 2.1, 0, Math.PI * 2); g.stroke(); }
      else g.strokeRect(inset * 2.1, inset * 2.1, size - 4.2 * inset, size - 4.2 * inset);
    }
    const dots = material === 'shag' ? 40000 : 16000;
    for (let k = 0; k < dots; k++) {
      g.fillStyle = shadeRGBA(random, material === 'shag' ? 0.16 : 0.07);
      g.fillRect(random() * size, random() * size, material === 'shag' ? 2.5 : 1.5, material === 'shag' ? 2.5 : 1);
    }
  });
  const result = new THREE.MeshStandardMaterial({ map: texture, roughness: 1 });
  materialCache.set(key, result);
  return result;
}

/* ------------------------------------------------------------------ mesh helpers */

function addMesh(group, geometry, material, x = 0, y = 0, z = 0, shadows = true) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = shadows;
  group.add(mesh);
  return mesh;
}

/** A box whose bottom face sits at height y, centred on x and z. */
function block(group, w, h, d, material, x = 0, y = 0, z = 0) {
  w = Math.max(0.004, w); h = Math.max(0.004, h); d = Math.max(0.004, d);
  return addMesh(group, new THREE.BoxGeometry(w, h, d), material, x, y + h / 2, z);
}

/** An upright cylinder (or cone) whose bottom sits at height y. */
function post(group, radius, h, material, x = 0, y = 0, z = 0, topRadius = radius, segments = 20) {
  h = Math.max(0.004, h);
  return addMesh(group, new THREE.CylinderGeometry(topRadius, radius, h, segments), material, x, y + h / 2, z);
}

/* ------------------------------------------------------------------ furniture */

// One builder per catalog `kind`. Each builds into `g` with its origin at the centre of the
// footprint on the floor: x across the width, z toward the front, y up.
const DARK_WOOD = '#3a2d24';
const METAL = '#55595f';
const LINEN = '#f2efe8';
const BOOK_COLORS = ['#7b3b2f', '#2f4a3c', '#3f5d73', '#d2a43c', '#e6ddd0', '#5b4a7a', '#b4573a', '#2e2c2b', '#9aa98f', '#c98d9a'];

const BUILDERS = {
  sofa(g, { w, d, h }, m) {
    const leg = 0.08, seat = Math.min(0.46, h * 0.6), back = Math.min(0.24, d * 0.3);
    const arm = Math.min(0.2, w * 0.14), armHeight = Math.min(h, seat + 0.18), cushion = 0.12;
    const legs = finish(DARK_WOOD, 'wood');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) post(g, 0.022, leg, legs, sx * (w / 2 - 0.07), 0, sz * (d / 2 - 0.07));
    block(g, w, seat - leg - cushion, d, m, 0, leg, 0);
    block(g, w, h - leg, back, m, 0, leg, -d / 2 + back / 2);
    for (const sx of [-1, 1]) block(g, arm, armHeight - leg, d, m, sx * (w / 2 - arm / 2), leg, 0);
    const inner = w - 2 * arm;
    if (inner < 0.15) return;
    const count = inner > 1.5 ? 3 : inner > 0.9 ? 2 : 1, each = inner / count;
    for (let i = 0; i < count; i++) {
      const x = -inner / 2 + each * (i + 0.5);
      block(g, each - 0.012, cushion, d - back - 0.01, m, x, seat - cushion, back / 2);
      block(g, each - 0.012, Math.max(0.05, h - seat - 0.05), 0.13, m, x, seat, -d / 2 + back + 0.065);
    }
  },
  // An L-shaped sectional: the main run along the back (-z) and a return running forward on one
  // side (+x for side 'right'). Backs run along the rear and the return's outer side; the main run's
  // free end has an arm; the return ends open, like a chaise.
  lsofa(g, item, m) {
    const { w, d, h } = item;
    const s = Math.min(item.seat || d * 0.45, w, d), k = item.side === 'left' ? -1 : 1;
    const leg = 0.08, seat = Math.min(0.46, h * 0.6), back = Math.min(0.24, s * 0.3);
    const arm = Math.min(0.2, w * 0.1), armHeight = Math.min(h, seat + 0.18), cushion = 0.12;
    const legs = finish(DARK_WOOD, 'wood');
    const inset = 0.07;
    for (const [x, z] of [[-w / 2 + inset, -d / 2 + inset], [w / 2 - inset, -d / 2 + inset], [w / 2 - inset, d / 2 - inset],
      [w / 2 - s + inset, d / 2 - inset], [-w / 2 + inset, -d / 2 + s - inset]]) post(g, 0.022, leg, legs, k * x, 0, z);
    const baseH = seat - leg - cushion;
    block(g, w, baseH, s, m, 0, leg, -d / 2 + s / 2);                    // main run
    block(g, s, baseH, d - s, m, k * (w / 2 - s / 2), leg, s / 2);        // return
    block(g, w, h - leg, back, m, 0, leg, -d / 2 + back / 2);            // back of the main run
    block(g, back, h - leg, d - back, m, k * (w / 2 - back / 2), leg, back / 2); // back of the return
    block(g, arm, armHeight - leg, s, m, -k * (w / 2 - arm / 2), leg, -d / 2 + s / 2);
    // Cushions: seats and back cushions along the main run, the corner, then down the return.
    const backH = Math.max(0.05, h - seat - 0.05), runDepth = s - back - 0.01;
    const mainZ = -d / 2 + (back + s) / 2, returnX = w / 2 - (s + back) / 2;
    const split = (from, to) => {
      const n = Math.max(1, Math.round((to - from) / 0.75)), each = (to - from) / n;
      return Array.from({ length: n }, (_, i) => [from + each * (i + 0.5), each - 0.012]);
    };
    if (w - s - arm > 0.15) {
      for (const [x, each] of split(-w / 2 + arm, w / 2 - s)) {
        block(g, each, cushion, runDepth, m, k * x, seat - cushion, mainZ);
        block(g, each, backH, 0.13, m, k * x, seat, -d / 2 + back + 0.065);
      }
    }
    block(g, runDepth, cushion, runDepth, m, k * returnX, seat - cushion, mainZ);
    block(g, runDepth, backH, 0.13, m, k * returnX, seat, -d / 2 + back + 0.065);
    if (d - s > 0.15) {
      for (const [z, each] of split(-d / 2 + s, d / 2)) {
        block(g, runDepth, cushion, each, m, k * returnX, seat - cushion, z);
        block(g, 0.13, backH, each, m, k * (w / 2 - back - 0.065), seat, z);
      }
    }
  },
  chair(g, { w, d, h }, m) {
    const seat = Math.min(0.46, h * 0.56), thick = 0.035, leg = 0.032;
    for (const sx of [-1, 1]) {
      block(g, leg, seat - thick, leg, m, sx * (w / 2 - leg / 2), 0, d / 2 - leg / 2);
      block(g, leg, h, leg, m, sx * (w / 2 - leg / 2), 0, -d / 2 + leg / 2); // back legs run up into the backrest
    }
    block(g, w, thick, d, m, 0, seat - thick, 0);
    const rail = Math.min(0.16, (h - seat) * 0.4);
    block(g, w - 2 * leg, rail, 0.022, m, 0, h - rail, -d / 2 + leg / 2);
    block(g, w - 2 * leg, 0.04, 0.022, m, 0, seat + (h - seat) * 0.35, -d / 2 + leg / 2);
  },
  office(g, { w, d, h }, m) {
    const metal = finish('#2f3236', 'metal'), seat = Math.min(0.48, h * 0.5);
    const reach = Math.min(w, d) / 2 - 0.03;
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const spoke = block(g, reach, 0.03, 0.035, metal, 0, 0.05, 0);
      spoke.rotation.y = angle;
      spoke.position.x = Math.cos(angle) * reach / 2;
      spoke.position.z = -Math.sin(angle) * reach / 2;
      addMesh(g, new THREE.SphereGeometry(0.025, 10, 8), metal, Math.cos(angle) * reach, 0.025, -Math.sin(angle) * reach);
    }
    post(g, 0.024, seat - 0.13, metal, 0, 0.07, 0);
    block(g, w * 0.88, 0.08, d * 0.85, m, 0, seat - 0.08, 0.02);
    block(g, 0.05, 0.16, 0.03, metal, 0, seat - 0.04, -d / 2 + 0.06);
    block(g, w * 0.82, Math.max(0.1, h - seat - 0.1), 0.06, m, 0, seat + 0.1, -d / 2 + 0.05);
  },
  table(g, { w, d, h }, m) {
    const top = 0.04, leg = 0.055, inset = 0.06;
    block(g, w, top, d, m, 0, h - top, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) block(g, leg, h - top, leg, m, sx * (w / 2 - inset), 0, sz * (d / 2 - inset));
    const apron = Math.min(0.08, (h - top) * 0.3);
    for (const sz of [-1, 1]) block(g, w - 2 * inset, apron, 0.02, m, 0, h - top - apron, sz * (d / 2 - inset));
    for (const sx of [-1, 1]) block(g, 0.02, apron, d - 2 * inset, m, sx * (w / 2 - inset), h - top - apron, 0);
  },
  rtable(g, { w, d, h }, m) {
    const top = post(g, w / 2, 0.04, m, 0, h - 0.04, 0, w / 2, 48);
    top.scale.z = d / w;
    post(g, Math.min(0.05, w * 0.12), h - 0.06, m, 0, 0.02, 0);
    post(g, Math.min(w, d) * 0.3, 0.025, m, 0, 0, 0, Math.min(w, d) * 0.26, 32);
  },
  desk(g, { w, d, h }, m) {
    const top = 0.035, side = 0.03;
    block(g, w, top, d, m, 0, h - top, 0);
    for (const sx of [-1, 1]) block(g, side, h - top, d - 0.02, m, sx * (w / 2 - side / 2), 0, 0);
    block(g, w - 2 * side, h * 0.45, 0.02, m, 0, h * 0.5 - top, -d / 2 + 0.04);
    // a drawer under the right-hand side
    const drawerW = Math.min(0.42, w * 0.35);
    block(g, drawerW, 0.12, d - 0.06, m, w / 2 - side - drawerW / 2, h - top - 0.12, 0);
    block(g, 0.1, 0.012, 0.012, finish(METAL, 'metal'), w / 2 - side - drawerW / 2, h - top - 0.065, d / 2 - 0.024);
  },
  shelf(g, { w, d, h }, m, item) {
    const t = 0.022, base = 0.06;
    for (const sx of [-1, 1]) block(g, t, h, d, m, sx * (w / 2 - t / 2), 0, 0);
    block(g, w - 2 * t, t, d, m, 0, h - t, 0);
    block(g, w - 2 * t, base, d - 0.02, m, 0, 0, 0);
    block(g, w - 2 * t, h - t - base, 0.008, m, 0, base, -d / 2 + 0.004);
    const levels = Math.max(1, Math.round((h - base - t) / 0.36));
    const spacing = (h - base - t) / levels;
    const random = seeded(item.id);
    for (let level = 0; level < levels; level++) {
      const floorY = base + level * spacing;
      if (level > 0) block(g, w - 2 * t, t, d - 0.01, m, 0, floorY - t, 0.005);
      const room = spacing - t - 0.02;
      if (room < 0.1) continue;
      let x = -w / 2 + t + 0.01;
      while (x < w / 2 - t - 0.03) {
        if (random() < 0.08) { x += 0.06 + random() * 0.1; continue; } // gaps
        const bookW = 0.018 + random() * 0.03;
        if (x + bookW > w / 2 - t - 0.005) break;
        const bookH = Math.min(room, 0.32) * (0.62 + random() * 0.36);
        const color = BOOK_COLORS[Math.floor(random() * BOOK_COLORS.length)];
        block(g, bookW, bookH, d * (0.62 + random() * 0.2), finish(color, 'painted'), x + bookW / 2, floorY, 0.01);
        x += bookW + 0.002;
      }
    }
  },
  chest(g, { w, d, h }, m) {
    const leg = Math.min(0.06, h * 0.12);
    const legs = finish(tone('#' + m.color.getHexString(), 0.7), 'wood');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) block(g, 0.04, leg, 0.04, legs, sx * (w / 2 - 0.04), 0, sz * (d / 2 - 0.04));
    block(g, w, h - leg, d - 0.02, m, 0, leg, -0.01);
    const rows = h > 0.5 ? Math.max(2, Math.round((h - leg) / 0.24)) : 1;
    const cols = w > 1 ? 2 : 1;
    const rowH = (h - leg - 0.04) / rows, colW = (w - 0.04) / cols;
    const knob = finish('#b8a27a', 'metal');
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = -w / 2 + 0.02 + colW * (c + 0.5), y = leg + 0.02 + rowH * r;
      block(g, colW - 0.012, rowH - 0.012, 0.018, m, x, y + 0.006, d / 2 - 0.009);
      addMesh(g, new THREE.SphereGeometry(0.014, 10, 8), knob, x, y + rowH / 2, d / 2 + 0.008);
    }
  },
  wardrobe(g, { w, d, h }, m) {
    const plinth = 0.06;
    block(g, w, plinth, d - 0.04, finish(tone('#' + m.color.getHexString(), 0.75), 'painted'), 0, 0, -0.02);
    block(g, w, h - plinth, d - 0.02, m, 0, plinth, -0.01);
    const doors = w > 0.7 ? 2 : 1, doorW = (w - 0.02) / doors;
    const handle = finish(METAL, 'metal');
    for (let i = 0; i < doors; i++) {
      const x = -w / 2 + 0.01 + doorW * (i + 0.5);
      block(g, doorW - 0.01, h - plinth - 0.02, 0.02, m, x, plinth + 0.01, d / 2 - 0.01);
      const side = doors === 2 ? (i === 0 ? 1 : -1) : 1;
      block(g, 0.015, 0.3, 0.02, handle, x + side * (doorW / 2 - 0.06), h * 0.5, d / 2 + 0.01);
    }
  },
  media(g, { w, d, h }, m) {
    const leg = Math.min(0.1, h * 0.3);
    const legs = finish(DARK_WOOD, 'wood');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) post(g, 0.015, leg, legs, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.05));
    block(g, w, h - leg, d, m, 0, leg, 0);
    const fronts = w > 1.2 ? 3 : 2, frontW = (w - 0.03) / fronts;
    for (let i = 0; i < fronts; i++) {
      block(g, frontW - 0.012, h - leg - 0.04, 0.012, m, -w / 2 + 0.015 + frontW * (i + 0.5), leg + 0.02, d / 2);
    }
    // a television on top
    const screenW = Math.min(w * 0.88, 1.45), screenH = screenW * 0.575;
    const black = finish('#141518', 'metal', { roughness: 0.35, metalness: 0.2 });
    block(g, 0.3, 0.015, 0.18, black, 0, h, -0.02);
    block(g, 0.05, 0.06, 0.03, black, 0, h + 0.015, -0.02);
    block(g, screenW, screenH, 0.035, black, 0, h + 0.07, -0.02);
    const glass = new THREE.MeshStandardMaterial({ color: '#0d1420', roughness: 0.12, metalness: 0.4 });
    addMesh(g, new THREE.PlaneGeometry(screenW - 0.02, screenH - 0.02), glass, 0, h + 0.07 + screenH / 2, -0.002, false);
  },
  bed(g, { w, d, h }, m) {
    const frame = finish('#8a6a4a', 'wood'), linen = finish(LINEN, 'fabric');
    const frameH = Math.min(0.3, h * 0.5);
    block(g, w, frameH, d - 0.06, frame, 0, 0, 0.03);
    block(g, w + 0.04, Math.min(1.1, h + 0.55), 0.06, frame, 0, 0, -d / 2 + 0.03);
    block(g, w - 0.05, h - frameH, d - 0.1, linen, 0, frameH, 0.035);
    const duvetLength = Math.max(0.2, d - 0.55);
    block(g, w + 0.02, h - frameH * 0.6 + 0.03, duvetLength, m, 0, frameH * 0.6, d / 2 - duvetLength / 2 + 0.01);
    block(g, w + 0.02, 0.035, 0.28, finish(tone('#' + m.color.getHexString(), 1.35), 'fabric'), 0, h + 0.02, d / 2 - duvetLength + 0.15); // folded edge
    const pillows = w > 1.2 ? 2 : 1, pillowW = (w - 0.12) / pillows;
    for (let i = 0; i < pillows; i++) {
      const pillow = addMesh(g, new THREE.SphereGeometry(0.5, 20, 12), linen, -w / 2 + 0.06 + pillowW * (i + 0.5), h + 0.06, -d / 2 + 0.3);
      pillow.scale.set(pillowW - 0.04, 0.14, 0.4);
    }
  },
  lamp(g, { w, d, h, color }, m, item, lights) {
    const shadeMaterial = new THREE.MeshStandardMaterial({
      color, roughness: 0.8, side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.3,
    });
    let lightY;
    if (h > 0.9) { // floor lamp
      const metal = finish(METAL, 'metal');
      post(g, Math.min(w / 2, 0.15), 0.03, metal, 0, 0, 0);
      post(g, 0.012, h - 0.3, metal, 0, 0.03, 0);
      const shade = Math.min(w / 2, 0.2);
      addMesh(g, new THREE.CylinderGeometry(shade * 0.75, shade, 0.3, 28, 1, true), shadeMaterial, 0, h - 0.15, 0, false);
      lightY = h - 0.18;
    } else { // table lamp
      const body = addMesh(g, new THREE.SphereGeometry(0.5, 20, 14), m, 0, h * 0.25, 0);
      body.scale.set(w * 0.55, h * 0.5, d * 0.55);
      post(g, 0.008, h * 0.25, finish(METAL, 'metal'), 0, h * 0.45, 0);
      addMesh(g, new THREE.CylinderGeometry(w * 0.36, w / 2, h * 0.38, 24, 1, true), shadeMaterial, 0, h - h * 0.19, 0, false);
      lightY = h * 0.75;
    }
    lights.push({ group: g, y: lightY });
  },
  rug(g, { w, d, h, color, material }) {
    block(g, w, Math.max(h, 0.008), d, rugMaterial(material, color, false), 0, 0, 0).castShadow = false;
  },
  rrug(g, { w, d, h, color, material }) {
    const rug = post(g, w / 2, Math.max(h, 0.008), rugMaterial(material, color, true), 0, 0, 0, w / 2, 56);
    rug.scale.z = d / w;
    rug.castShadow = false;
  },
  plant(g, { w, d, h, color }, m, item) {
    const random = seeded(item.id);
    const radius = Math.min(w, d) * 0.28, potH = Math.min(0.34, h * 0.36);
    post(g, radius * 0.82, potH, finish(color, 'stone'), 0, 0, 0, radius, 28);
    post(g, radius * 0.95, 0.01, finish('#3b2b20', 'fabric'), 0, potH - 0.02, 0);
    const stem = finish('#5b4a32', 'wood');
    post(g, 0.012, (h - potH) * 0.6, stem, 0, potH, 0);
    const leafCount = 9 + Math.floor(random() * 5);
    for (let i = 0; i < leafCount; i++) {
      const up = potH + (h - potH) * (0.3 + random() * 0.6);
      const angle = random() * Math.PI * 2, out = random() * (w / 2 - 0.08);
      const size = 0.07 + random() * 0.08;
      const green = ['#3f6b3a', '#4f7d42', '#2f5530', '#5f8b4a'][Math.floor(random() * 4)];
      const leaf = addMesh(g, new THREE.IcosahedronGeometry(size, 0), finish(green, 'fabric', { flatShading: true }),
        Math.cos(angle) * out, Math.min(up, h - size), Math.sin(angle) * out * (d / w));
      leaf.rotation.set(random() * 3, random() * 3, random() * 3);
    }
  },
  box(g, { w, d, h }, m) { block(g, w, h, d, m, 0, 0, 0); },
};

/** How high an item sits: table lamps rest on the surface they're placed over. */
function elevation(item) {
  if (!isTabletop(item.type)) return 0;
  let height = 0;
  for (const other of app.plan.items) {
    if (other !== item && isSurface(ITEM_DEFS[other.type].kind) && pointInItem(item, other)) height = Math.max(height, other.h);
  }
  return height;
}

/* ------------------------------------------------------------------ the room */

function selectableGroup(kind, id, box) {
  const group = new THREE.Group();
  group.userData.sel = { kind, id };
  group.userData.box = box;
  selectable.set(kind + ':' + id, group);
  return group;
}

function floorShape(corners, flipY) {
  const shape = new THREE.Shape();
  corners.forEach((c, i) => (i ? shape.lineTo(c.x, flipY ? -c.y : c.y) : shape.moveTo(c.x, flipY ? -c.y : c.y)));
  shape.closePath();
  return shape;
}

/** One wall, with holes for windows and doors, its trim, outlets and picture frames. */
function buildWall(wall, height, openings, frames = []) {
  const s = wall.inwardSign; // the room side of the wall is local +z when s = 1, -z when s = -1
  const L = wall.length;
  const group = selectableGroup('wall', wall.id, { w: L, h: height, d: T, x: L / 2, y: height / 2, z: -s * T / 2 });
  group.position.set(wall.a.x, 0, wall.a.y);
  group.rotation.y = -Math.atan2(wall.uy, wall.ux);

  // Openings that cut the wall, in order along it. Overlapping ones are skipped.
  const cuts = [];
  openings.filter(o => o.type !== 'outlet')
    .map(o => {
      const x0 = clamp(o.pos - o.width / 2, 0.02, L - 0.06), x1 = clamp(o.pos + o.width / 2, x0 + 0.04, L - 0.02);
      const y0 = o.type === 'door' || o.sill < 0.01 ? 0 : clamp(o.sill, 0.01, height - 0.12);
      return { o, x0, x1, y0, y1: clamp(y0 + o.height, y0 + 0.08, height - 0.03) };
    })
    .sort((a, b) => a.x0 - b.x0)
    .forEach(cut => { if (!cuts.length || cut.x0 > cuts[cuts.length - 1].x1 + 0.01) cuts.push(cut); });

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  for (const c of cuts) if (c.y0 === 0) { shape.lineTo(c.x0, 0); shape.lineTo(c.x0, c.y1); shape.lineTo(c.x1, c.y1); shape.lineTo(c.x1, 0); }
  shape.lineTo(L, 0); shape.lineTo(L, height); shape.lineTo(0, height); shape.closePath();
  for (const c of cuts) {
    if (c.y0 === 0) continue;
    const hole = new THREE.Path();
    hole.moveTo(c.x0, c.y0); hole.lineTo(c.x1, c.y0); hole.lineTo(c.x1, c.y1); hole.lineTo(c.x0, c.y1); hole.closePath();
    shape.holes.push(hole);
  }
  const wallMaterial = finish(wallColor(wall.id), 'painted', { roughness: 0.92 });
  addMesh(group, new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false }), wallMaterial, 0, 0, s === 1 ? -T : 0);

  const trim = finish('#f4f2ec', 'painted');
  // Baseboard along the room side, broken at doors.
  let from = 0;
  for (const c of [...cuts.filter(c => c.y0 === 0), { x0: L, x1: L }]) {
    if (c.x0 - from > 0.02) block(group, c.x0 - from, 0.09, 0.014, trim, (from + c.x0) / 2, 0, s * 0.007);
    from = c.x1;
  }

  const middle = -s * T / 2;
  for (const { o, x0, x1, y0, y1 } of cuts) {
    const cx = (x0 + x1) / 2;
    const og = selectableGroup('opening', o.id, { w: x1 - x0, h: y1 - y0, d: T, x: cx, y: (y0 + y1) / 2, z: middle });
    group.add(og);
    if (o.type === 'door') {
      const casing = 0.07;
      for (const x of [x0 - casing / 2, x1 + casing / 2]) block(og, casing, y1, 0.02, trim, x, 0, s * 0.01);
      block(og, x1 - x0 + 2 * casing, casing, 0.02, trim, cx, y1, s * 0.01);
      // The leaf, hinged at the wall's starting side and open into the room, as on the plan.
      const leafW = x1 - x0 - 0.01, leafT = 0.04;
      block(og, leafT, y1 - 0.01, leafW, finish('#ebe6dc', 'painted'), x0 + 0.005 + leafT / 2, 0, s * (leafW / 2 + 0.005));
      const knob = finish('#b8a27a', 'metal');
      for (const side of [-1, 1]) addMesh(og, new THREE.SphereGeometry(0.028, 12, 8), knob, x0 + 0.025 + side * 0.04, 0.95, s * (leafW - 0.06));
    } else {
      const frame = 0.045;
      block(og, x1 - x0, frame, T, trim, cx, y0, middle);
      block(og, x1 - x0, frame, T, trim, cx, y1 - frame, middle);
      block(og, frame, y1 - y0, T, trim, x0 + frame / 2, y0, middle);
      block(og, frame, y1 - y0, T, trim, x1 - frame / 2, y0, middle);
      if (x1 - x0 > 0.9) block(og, frame * 0.7, y1 - y0, 0.04, trim, cx, y0, middle);
      if (y0 > 0) block(og, x1 - x0 + 0.1, 0.025, 0.08, trim, cx, y0 - 0.025, s * 0.02);
      const glass = new THREE.MeshStandardMaterial({
        color: '#bcd8ea', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false,
      });
      addMesh(og, new THREE.PlaneGeometry(x1 - x0 - 2 * frame, y1 - y0 - 2 * frame), glass, cx, (y0 + y1) / 2, middle, false);
    }
  }

  for (const o of openings.filter(o => o.type === 'outlet')) {
    const og = selectableGroup('opening', o.id, { w: 0.07, h: 0.115, d: 0.01, x: o.pos, y: o.sill + 0.0575, z: s * 0.005 });
    group.add(og);
    block(og, 0.07, 0.115, 0.008, finish('#f7f6f2', 'painted'), o.pos, o.sill, s * 0.004);
    const slot = finish('#3a3a3a', 'painted');
    for (const dy of [0.03, 0.07]) for (const dx of [-0.007, 0.007]) block(og, 0.004, 0.012, 0.002, slot, o.pos + dx, o.sill + dy, s * 0.009);
  }

  // Picture frames: a moulding, a mat, and a block of colour standing in for the picture.
  const depth = 0.025;
  const moulding3d = finish('#2e2c2b', 'wood'), mat3d = finish('#f6f4ee', 'painted');
  for (const f of frames) {
    const fg = selectableGroup('frame', f.id, { w: f.w, h: f.h, d: depth, x: f.pos, y: f.alt, z: s * depth / 2 });
    group.add(fg);
    const { moulding, mat } = frameBorders(f.w, f.h), bottom = f.alt - f.h / 2;
    block(fg, f.w, f.h, depth, moulding3d, f.pos, bottom, s * depth / 2);
    block(fg, f.w - 2 * moulding, f.h - 2 * moulding, 0.004, mat3d, f.pos, bottom + moulding, s * (depth + 0.001));
    const inset = moulding + mat;
    if (f.w > 2 * inset && f.h > 2 * inset) {
      block(fg, f.w - 2 * inset, f.h - 2 * inset, 0.004, finish(artColor(f.id), 'painted'), f.pos, bottom + inset, s * (depth + 0.002));
    }
  }
  return group;
}

/** Fill the gap outside a convex corner, where the two walls' thickness doesn't meet. */
function buildCornerFill(previous, wall, height) {
  const cross = previous.ux * wall.uy - previous.uy * wall.ux;
  if (cross * wall.inwardSign <= 1e-6) return null; // a straight or inward-turning corner needs no fill
  const c = wall.a;
  const o1 = { x: -previous.nx, y: -previous.ny }, o2 = { x: -wall.nx, y: -wall.ny };
  // The mitre point: where the two walls' outer faces meet (capped for very sharp corners).
  const factor = T * Math.min(3, 1 / Math.max(0.2, 1 + o1.x * o2.x + o1.y * o2.y));
  const mx = (o1.x + o2.x) * factor, my = (o1.y + o2.y) * factor;
  const points = [c, { x: c.x + o1.x * T, y: c.y + o1.y * T }, { x: c.x + mx, y: c.y + my }, { x: c.x + o2.x * T, y: c.y + o2.y * T }];
  const mesh = new THREE.Mesh(
    new THREE.ExtrudeGeometry(floorShape(points, true), { depth: height, bevelEnabled: false }),
    finish(wallColor(previous.id), 'painted', { roughness: 0.92 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

function disposeGroup(group) {
  group.traverse(object => { if (object.geometry) object.geometry.dispose(); });
}

/** Throw away the old scene contents and build them again from the plan. */
function rebuild() {
  const { plan } = app;
  const corners = plan.room.verts;
  const height = plan.room.wallHeight;
  if (roomGroup) { scene.remove(roomGroup); disposeGroup(roomGroup); }
  roomGroup = new THREE.Group();
  selectable.clear();
  wallParts = [];
  cornerParts = [];
  readTheme();
  scene.background = new THREE.Color(theme.paper);
  ground.material.color.set(theme.grid);

  // Floor and ceiling.
  const floor = addMesh(roomGroup, new THREE.ShapeGeometry(floorShape(corners, true)),
    floorMaterial(plan.room.floor.material, plan.room.floor.color), 0, 0.001, 0);
  floor.rotation.x = -Math.PI / 2;
  floor.castShadow = false;
  ceiling = addMesh(roomGroup, new THREE.ShapeGeometry(floorShape(corners, false)), finish('#f7f6f2', 'painted', { roughness: 0.95 }), 0, height, 0, false);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.receiveShadow = true;

  // Walls.
  const walls = getWalls();
  walls.forEach((wall, i) => {
    const group = buildWall(wall, height, plan.openings.filter(o => o.wall === wall.id), plan.frames.filter(f => f.wall === wall.id));
    roomGroup.add(group);
    wallParts.push({ group, wall });
    const fill = buildCornerFill(walls[(i - 1 + walls.length) % walls.length], wall, height);
    if (fill) { roomGroup.add(fill); cornerParts.push({ mesh: fill, walls: [(i - 1 + walls.length) % walls.length, i] }); }
  });

  // Furniture.
  const lights = [];
  for (const item of plan.items) {
    const def = ITEM_DEFS[item.type];
    const group = selectableGroup('item', item.id, { w: item.w, h: Math.max(item.h, 0.02), d: item.d, x: 0, y: Math.max(item.h, 0.02) / 2, z: 0 });
    group.position.set(item.x, elevation(item), item.y);
    group.rotation.y = -(item.rot * Math.PI) / 180;
    const build = BUILDERS[def.kind] || BUILDERS.box;
    build(group, item, finish(item.color, isFlat(def.kind) ? 'fabric' : item.material), item, lights);
    roomGroup.add(group);
  }
  // Each lamp gives off a little warm light (no shadows, to keep it quick).
  for (const { group, y } of lights.slice(0, 6)) {
    const light = new THREE.PointLight('#ffd9a0', 0.7, 3.5, 2);
    light.position.set(0, y, 0);
    group.add(light);
  }

  // Fit the shadow camera and the ground to the room.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of corners) { minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minZ = Math.min(minZ, c.y); maxZ = Math.max(maxZ, c.y); }
  roomBounds = { minX, maxX, minZ, maxZ, height };
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, size = Math.max(maxX - minX, maxZ - minZ, 1);
  sun.position.set(cx - size * 0.45, height + size * 1.1, cz + size * 0.7);
  sun.target.position.set(cx, 0, cz);
  const reach = size * 0.9 + 1;
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.5, far: size * 4 + height * 2 });
  sun.shadow.camera.updateProjectionMatrix();
  ground.position.set(cx, -0.002, cz);

  scene.add(roomGroup);
  selectionKey = ''; // the highlight has to be rebuilt too
  if (mode === 'walk' && !canStand(walk.x, walk.z)) startWalk();
}

/* ------------------------------------------------------------------ selection */

function updateHighlight() {
  if (highlight) { highlight.parent && highlight.parent.remove(highlight); highlight.geometry.dispose(); highlight = null; }
  const selection = app.selection;
  if (!selection) return;
  const group = selectable.get(selection.kind + ':' + selection.id);
  if (!group) return;
  const { w, h, d, x, y, z } = group.userData.box;
  const pad = 0.03;
  highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(w + pad, h + pad, d + pad)),
    new THREE.LineBasicMaterial({ color: theme.accent, depthTest: false, transparent: true }),
  );
  highlight.renderOrder = 10;
  highlight.position.set(x, y, z);
  group.add(highlight);
}

const raycaster = new THREE.Raycaster();

function isShown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** Select whatever is under a click on the 3D view, as clicking the plan would. */
function pick(clientX, clientY) {
  const box = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  for (const hit of raycaster.intersectObject(roomGroup, true)) {
    if (!isShown(hit.object) || hit.object === highlight) continue;
    let o = hit.object;
    while (o && !o.userData.sel) o = o.parent;
    if (!o) return selectAndShow(null); // the floor or ceiling
    return selectAndShow({ ...o.userData.sel });
  }
  selectAndShow(null);
}

function selectAndShow(selection) {
  if (setSelection(selection) && selection && window.innerWidth <= 880) setTab('selected');
}

/* ------------------------------------------------------------------ cameras */

/** Put the orbit camera above and in front of the room, looking at its middle. */
function frameRoom() {
  const { minX, maxX, minZ, maxZ, height } = roomBounds;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, size = Math.max(maxX - minX, maxZ - minZ, 2);
  orbit.target.set(cx, height * 0.3, cz);
  camera.position.set(cx - size * 0.35, height + size * 0.85, cz + size * 1.05);
  orbit.maxDistance = size * 5;
  orbit.update();
}

/** Can the walking camera stand here? Inside the room and not right up against a wall. */
function canStand(x, z) {
  const corners = app.plan.room.verts;
  if (!pointInPolygon({ x, y: z }, corners)) return false;
  for (let i = 0; i < corners.length; i++) {
    if (distanceToSegment({ x, y: z }, corners[i], corners[(i + 1) % corners.length]).distance < WALL_MARGIN) return false;
  }
  return true;
}

/** Furniture tall enough to bump into (not rugs, and not lamps sitting on a table). */
function blockingItemsAt(x, z) {
  return app.plan.items.filter(item => !isFlat(ITEM_DEFS[item.type].kind) && !isTabletop(item.type) && item.h > 0.25 && pointInItem({ x, y: z }, item, 0.18));
}

/** Start walking just inside a door if there is one, otherwise in the middle of the room. */
function startWalk() {
  const walls = getWalls();
  const door = app.plan.openings.find(o => o.type === 'door');
  const wall = door && walls.find(w => w.id === door.wall);
  if (wall) {
    for (const step of [0.7, 1, 1.4, 0.4]) {
      const x = wall.a.x + wall.ux * door.pos + wall.nx * step, z = wall.a.y + wall.uy * door.pos + wall.ny * step;
      if (canStand(x, z)) {
        Object.assign(walk, { x, z, yaw: Math.atan2(-wall.nx, -wall.ny), pitch: -0.08 });
        return;
      }
    }
  }
  const { minX, maxX, minZ, maxZ } = roomBounds;
  let best = null;
  // The interior point closest to the bounding-box centre, sampled on a grid (works for L and T shapes).
  for (let i = 1; i < 20; i++) for (let j = 1; j < 20; j++) {
    const x = minX + ((maxX - minX) * i) / 20, z = minZ + ((maxZ - minZ) * j) / 20;
    const score = Math.hypot(x - (minX + maxX) / 2, z - (minZ + maxZ) / 2);
    if (canStand(x, z) && (!best || score < best.score)) best = { x, z, score };
  }
  if (!best) best = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
  Object.assign(walk, { x: best.x, z: best.z, yaw: maxX - minX > maxZ - minZ ? -Math.PI / 2 : 0, pitch: -0.08 });
}

function moveWalker(dx, dz) {
  const blockedNow = new Set(blockingItemsAt(walk.x, walk.z));
  const free = (x, z) => canStand(x, z) && blockingItemsAt(x, z).every(item => blockedNow.has(item));
  // Try the whole step, then slide along whatever is in the way.
  if (free(walk.x + dx, walk.z + dz)) { walk.x += dx; walk.z += dz; }
  else if (free(walk.x + dx, walk.z)) walk.x += dx;
  else if (free(walk.x, walk.z + dz)) walk.z += dz;
}

function updateWalk(dt) {
  const has = key => (held.has(key) ? 1 : 0);
  const forward = has('fwd') - has('back');
  const strafe = has('right') - has('left');
  walk.yaw += (has('turnL') - has('turnR')) * TURN_SPEED * dt;
  if (forward || strafe) {
    const step = WALK_SPEED * (held.has('fast') ? 2 : 1) * dt / (forward && strafe ? Math.SQRT2 : 1);
    const sin = Math.sin(walk.yaw), cos = Math.cos(walk.yaw);
    moveWalker((-sin * forward + cos * strafe) * step, (-cos * forward - sin * strafe) * step);
  }
  camera.position.set(walk.x, Math.min(EYE_HEIGHT, roomBounds.height - 0.2), walk.z);
  camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ');
}

/** In orbit view, hide the walls standing between the camera and the room, like a doll's house. */
function updateWallVisibility() {
  const walking = mode === 'walk';
  ceiling.visible = walking;
  const shown = wallParts.map(({ group, wall }) => {
    const side = (camera.position.x - wall.a.x) * wall.nx + (camera.position.z - wall.a.y) * wall.ny;
    group.visible = walking || side > -0.05;
    return group.visible;
  });
  for (const { mesh, walls } of cornerParts) mesh.visible = shown[walls[0]] || shown[walls[1]];
}

export function setMode(next) {
  if (next === mode) return;
  if (next === 'walk') {
    savedOrbit = { position: camera.position.clone(), target: orbit.target.clone() };
    orbit.enabled = false;
    startWalk();
  } else {
    orbit.enabled = true;
    camera.rotation.order = 'XYZ';
    if (savedOrbit) { camera.position.copy(savedOrbit.position); orbit.target.copy(savedOrbit.target); orbit.update(); }
    else frameRoom();
  }
  mode = next;
  held.clear();
  renderControls();
}

export function resetView() {
  if (mode === 'walk') startWalk();
  else frameRoom();
}

function renderControls() {
  document.querySelectorAll('[data-cam]').forEach(button => button.setAttribute('aria-pressed', button.dataset.cam === mode));
  $('#walkPad').hidden = mode !== 'walk';
  $('#sheet').dataset.cam = mode;
  $('#hint3d').innerHTML = mode === 'walk'
    ? '<span>Drag to look around. <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or the arrows to walk, <kbd>Shift</kbd> to hurry.</span>'
    : '<span>Drag to orbit, right-drag or two fingers to pan, scroll or pinch to zoom. Click a piece to select it.</span>';
}

/* ------------------------------------------------------------------ input */

const KEY_MOVES = {
  KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', KeyD: 'right',
  ArrowLeft: 'turnL', ArrowRight: 'turnR', KeyQ: 'turnL', KeyE: 'turnR', ShiftLeft: 'fast', ShiftRight: 'fast',
};

/** Walking keys. Runs in the capture phase so the plan's own arrow-key nudging doesn't also fire. */
function onKey(event) {
  if (!active || mode !== 'walk') return;
  const target = event.target;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  const move = KEY_MOVES[event.code];
  if (!move || event.ctrlKey || event.metaKey || event.altKey) return;
  if (move !== 'fast') { event.preventDefault(); event.stopPropagation(); }
  if (event.type === 'keydown') held.add(move);
  else held.delete(move);
}

function initPointer() {
  const element = renderer.domElement;
  let press = null;
  element.addEventListener('pointerdown', event => {
    press = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, button: event.button };
    if (mode === 'walk') element.setPointerCapture(event.pointerId);
  });
  element.addEventListener('pointermove', event => {
    if (!press) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) press.moved = true;
    if (mode === 'walk') { // drag the view, like grabbing the scene
      walk.yaw += (event.clientX - press.lastX) * 0.0045;
      walk.pitch = clamp(walk.pitch + (event.clientY - press.lastY) * 0.0045, -1.3, 1.3);
    }
    press.lastX = event.clientX;
    press.lastY = event.clientY;
  });
  const release = event => {
    if (press && !press.moved && press.button === 0 && event.type === 'pointerup') pick(event.clientX, event.clientY);
    press = null;
  };
  element.addEventListener('pointerup', release);
  element.addEventListener('pointercancel', release);
  element.addEventListener('contextmenu', event => event.preventDefault());

  // The on-screen walking pad, for touch screens (and anyone who prefers it).
  const pad = $('#walkPad');
  const stop = event => { const b = event.target.closest('[data-move]'); if (b) held.delete(b.dataset.move); };
  pad.addEventListener('pointerdown', event => {
    const button = event.target.closest('[data-move]');
    if (!button) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    held.add(button.dataset.move);
  });
  pad.addEventListener('pointerup', stop);
  pad.addEventListener('pointercancel', stop);
  pad.addEventListener('lostpointercapture', stop);
  pad.addEventListener('contextmenu', event => event.preventDefault());

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', () => held.clear());
}

/* ------------------------------------------------------------------ setup and the render loop */

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  stage.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, 1, 0.05, 300);
  scene.add(new THREE.HemisphereLight('#ffffff', '#9a8e80', 1.7));
  sun = new THREE.DirectionalLight('#fff4e6', 1.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  ground = new THREE.Mesh(new THREE.CircleGeometry(60, 48), new THREE.MeshStandardMaterial({ color: '#cccccc', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.09;
  orbit.screenSpacePanning = false; // pan across the floor rather than up the screen
  orbit.minDistance = 0.8;
  orbit.maxPolarAngle = Math.PI / 2 - 0.04;

  new ResizeObserver(resize).observe(stage);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { planKey = ''; });
  new MutationObserver(() => { planKey = ''; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.querySelectorAll('[data-cam]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.cam)));
  $('#reset3d').addEventListener('click', resetView);
  initPointer();

  rebuild();
  planKey = JSON.stringify(app.plan);
  frameRoom();
}

function resize() {
  const box = stage.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return;
  renderer.setSize(box.width, box.height, false);
  camera.aspect = box.width / box.height;
  camera.updateProjectionMatrix();
}

function tick(time) {
  const dt = Math.min(0.1, (time - (lastTime || time)) / 1000);
  lastTime = time;
  const key = JSON.stringify(app.plan);
  if (key !== planKey) { planKey = key; rebuild(); }
  const currentSelection = JSON.stringify(app.selection);
  if (currentSelection !== selectionKey) { selectionKey = currentSelection; updateHighlight(); }
  if (mode === 'walk') updateWalk(dt);
  else orbit.update();
  // From outside, the outline shows through walls; when walking it would cut across the view.
  if (highlight) highlight.material.depthTest = mode === 'walk';
  updateWallVisibility();
  renderer.render(scene, camera);
}

/** Show the 3D view inside `container` and start rendering. */
export function show(container) {
  if (!renderer) { stage = container; init(); }
  active = true;
  stage.hidden = false;
  renderControls();
  resize();
  lastTime = 0;
  renderer.setAnimationLoop(tick);
}

/** Stop rendering. The camera stays where it was for next time. */
export function hide() {
  active = false;
  held.clear();
  if (renderer) renderer.setAnimationLoop(null);
  if (stage) stage.hidden = true;
}
