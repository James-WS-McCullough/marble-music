import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { planCourse, marbleAt, padShape, lastHitIndex, MARBLE_R, TUBE_R } from './planner.js';
import { buildSong, generateSong, groupNotes, splitParts } from './music.js';
import { parseMidi } from './midi.js';
import { Synth } from './audio.js';
import { mulberry32 } from './util.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const WALL_COLOR = 0x4fb3c8;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x5f9fb0);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

const camera = new THREE.PerspectiveCamera(26, innerWidth / innerHeight, 0.05, 400);
camera.position.set(0.8, 0.5, 5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enabled = false;

scene.add(new THREE.HemisphereLight(0xffffff, 0x5a8a98, 0.55));
const sun = new THREE.DirectionalLight(0xfff6e8, 1.9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.01;
Object.assign(sun.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 0.5, far: 30 });
scene.add(sun, sun.target);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.15, 0.3, 0.95));
composer.addPass(new OutputPass());

// ------------------------------------------------------------------ materials & helpers
const UP = new THREE.Vector3(0, 1, 0);
const pitchColor = (midi) => new THREE.Color().setHSL((midi % 12) / 12, 0.9, 0.5);
const std = (o) => new THREE.MeshStandardMaterial(o);
const MAT = {
  rail: std({ color: 0xc4c9d2, metalness: 0.9, roughness: 0.25 }),
  bracket: std({ color: 0x9aa3ad, metalness: 0.8, roughness: 0.35 }),
  padBody: std({ color: 0x1f2a30, roughness: 0.55 }),
  barBody: std({ color: 0x5a3a26, roughness: 0.6 }),
  pipe: std({ color: 0x3fae4a, roughness: 0.35, metalness: 0.05 }),
  // fully clear glass: real transmission (see-through, slight refraction) with just reflections showing its shape
  glass: new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, thickness: 0.01, ior: 1.45, roughness: 0,
    metalness: 0, clearcoat: 1, clearcoatRoughness: 0, specularIntensity: 1, side: THREE.DoubleSide }),
  cloud: std({ color: 0xffffff, roughness: 1 }),
};
const MARBLE_MATS = {
  keys: std({ color: 0xe8ebf0, metalness: 1, roughness: 0.12 }),
  bars: std({ color: 0xd8a84a, metalness: 1, roughness: 0.2 }),
  chimes: std({ color: 0xc87850, metalness: 1, roughness: 0.2 }),
  drums: std({ color: 0x9a1b2a, metalness: 0.3, roughness: 0.15 }),
  cymbals: std({ color: 0x2c2f36, metalness: 0.9, roughness: 0.2 }),
};
// Each marble's course has its own look, so it's easy to tell which track belongs to which marble:
// front = silver chrome with dark slate pads, back = brass with warm wood pads and a gold marble.
const LANE_THEMES = [
  { name: 'silver', dot: '#e8ebf0', marble: MARBLE_MATS.keys,
    rail: std({ color: 0xc4c9d2, metalness: 0.9, roughness: 0.25 }), bracket: std({ color: 0x9aa3ad, metalness: 0.8, roughness: 0.35 }),
    body: std({ color: 0x1f2a30, roughness: 0.55 }) },
  { name: 'brass', dot: '#d8a84a', marble: MARBLE_MATS.bars,
    rail: std({ color: 0xc9a040, metalness: 0.95, roughness: 0.28 }), bracket: std({ color: 0xa8843a, metalness: 0.9, roughness: 0.35 }),
    body: std({ color: 0x7a4a2a, roughness: 0.6 }) },
];
const themeOf = (lane) => LANE_THEMES[Math.min(lane.k, LANE_THEMES.length - 1)];
const SHARED = new Set([...Object.values(MAT), ...Object.values(MARBLE_MATS)]);
for (const t of LANE_THEMES) for (const m of [t.rail, t.bracket, t.body]) SHARED.add(m);

function rodBetween(a, b, r, mat) {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 6), mat);
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
  m.castShadow = true;
  return m;
}
const bracket = (x, y, z, mat = MAT.bracket) => rodBetween(new THREE.Vector3(x, y, z), new THREE.Vector3(x, y, 0), 0.007, mat);

/** A plain painted wall: just a hint of texture so it doesn't look like flat CG. */
function wallTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  const rng = mulberry32(5);
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = `rgba(${rng() < 0.5 ? '255,255,255' : '0,40,60'},${0.02 + rng() * 0.03})`;
    g.fillRect(rng() * 256, rng() * 256, 1 + rng() * 2, 1 + rng() * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const WALL_TEX = wallTexture();

// 8x8 pixel-art sprites for the retro theme ('#' = filled)
const SPRITES = {
  star: ['...##...', '...##...', '########', '.######.', '..####..', '.##..##.', '##....##', '........'],
  heart: ['.##..##.', '########', '########', '########', '.######.', '..####..', '...##...', '........'],
  note: ['....###.', '....#.##', '....#..#', '....#...', '.####...', '#####...', '.###....', '........'],
  gem: ['..####..', '.#....#.', '########', '.#.##.#.', '..#..#..', '...##...', '........', '........'],
};
const SPRITE_COLORS = [0xffd23f, 0xff6b6b, 0x7b6cff, 0x4cd964, 0xff9f43];
const PIPE_COLORS = [0x3fae4a, 0xe0533d, 0xf2c230, 0x8e6cd8];

function spriteMesh(name, color, px) {
  const rows = SPRITES[name];
  const cells = [];
  rows.forEach((r, y) => [...r].forEach((ch, x) => ch === '#' && cells.push([x, 7 - y])));
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(px * 0.94, px * 0.94, px * 0.6), std({ color, roughness: 0.6 }), cells.length);
  const M = new THREE.Matrix4();
  cells.forEach(([x, y], i) => m.setMatrixAt(i, M.makeTranslation((x - 3.5) * px, (y - 3.5) * px, 0)));
  m.castShadow = true;
  return m;
}

function cloudMesh(rng, size) {
  const g = new THREE.Group();
  const n = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const r = size * (0.32 + rng() * 0.25) * (i === 0 || i === n - 1 ? 0.75 : 1);
    const b = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), MAT.cloud);
    b.position.set(((i / (n - 1)) - 0.5) * size * 1.5, (rng() - 0.3) * size * 0.25 + (i % 2) * size * 0.1, 0);
    b.scale.z = 0.45;
    b.castShadow = true;
    g.add(b);
  }
  return g;
}

function pipeMesh(rng, color, len) {
  const mat = std({ color, roughness: 0.35, metalness: 0.05 });
  const a = rng() * Math.PI * 2, bend = (rng() - 0.5) * 1.6;
  const p0 = new THREE.Vector3(0, 0, 0), p3 = new THREE.Vector3(Math.cos(a) * len, Math.sin(a) * len, 0);
  const p1 = new THREE.Vector3(Math.cos(a + bend) * len * 0.45, Math.sin(a + bend) * len * 0.45, 0);
  const p2 = p3.clone().add(new THREE.Vector3(Math.cos(a + Math.PI - bend) * len * 0.45, Math.sin(a + Math.PI - bend) * len * 0.45, 0));
  const curve = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
  const g = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.09, 16), mat);
  tube.castShadow = true;
  g.add(tube);
  for (const u of [0, 1]) { // rims
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 20), mat);
    rim.position.copy(curve.getPoint(u));
    rim.quaternion.setFromUnitVectors(UP, curve.getTangent(u));
    rim.castShadow = true;
    g.add(rim);
  }
  g.userData.points = curve.getPoints(20);
  return g;
}

// ------------------------------------------------------------------ state
let synth = null, startTime = 0, playing = false;
let plan = null, events = [], world = null, pads = [], marbles = [], sprites = [];
let schedAbs = 0, currentSong = null, customMidi = null;

function disposeWorld() {
  if (!world) return;
  world.traverse((o) => {
    o.geometry?.dispose();
    if (o.material && !SHARED.has(o.material)) [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); });
  });
  scene.remove(world);
}

// ------------------------------------------------------------------ building the scene
function padMesh(hit, lane) {
  const { len, thick } = padShape(hit.type, hit.midi, hit.scale);
  const n = new THREE.Vector3(hit.normal.x, hit.normal.y, 0);
  const t = new THREE.Vector3(hit.normal.y, -hit.normal.x, 0);
  const center = new THREE.Vector3(hit.pos.x, hit.pos.y, lane.z).addScaledVector(n, -(MARBLE_R + thick / 2));
  const group = new THREE.Group();
  const flashMats = [];
  const pitched = hit.notes.filter((nt) => nt.ch !== 9).sort((a, b) => a.midi - b.midi);

  if (hit.type === 'key' || hit.type === 'bar' || hit.type === 'chime') {
    // a chunky slab with a bright coloured top; a chord = several coloured strips side by side
    const keys = pitched.length ? pitched : [{ midi: hit.midi }];
    const W = 0.14, w = W / keys.length, cap = 0.014;
    const body = new THREE.Mesh(new THREE.BoxGeometry(len, thick - cap, W), themeOf(lane).body);
    body.position.y = -cap / 2;
    body.castShadow = body.receiveShadow = true;
    group.add(body);
    keys.forEach((nt, j) => {
      const c = pitchColor(nt.midi);
      const mat = std({ color: c, roughness: 0.4, emissive: c, emissiveIntensity: 0 });
      const k = new THREE.Mesh(new THREE.BoxGeometry(len, cap, w - (keys.length > 1 ? 0.008 : 0)), mat);
      k.position.set(0, thick / 2 - cap / 2, -W / 2 + w * (j + 0.5));
      k.castShadow = true;
      group.add(k);
      flashMats.push(mat);
    });
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, n, new THREE.Vector3(0, 0, 1)));
  } else {
    const head = std({ color: 0xf1eadb, roughness: 0.7, emissive: 0xffd9a0, emissiveIntensity: 0 });
    const brass = std({ color: 0xc9a040, metalness: 0.95, roughness: 0.3, emissive: 0xffd27a, emissiveIntensity: 0 });
    const r = len / 2;
    if (hit.type === 'hat' || hit.type === 'crash') {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.25, r, 0.012, 32), brass);
      disc.position.y = thick / 2 - 0.006;
      disc.castShadow = true;
      group.add(disc);
      if (hit.type === 'hat') {
        const lower = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.25, 0.012, 32), brass);
        lower.position.y = -thick / 2;
        group.add(lower);
      }
      flashMats.push(brass);
    } else {
      const shellCol = { kick: 0x8e1a26, snare: 0xb8bcc4, tom: 0x1f4f8a }[hit.type];
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, thick, 32, 1, true),
        std({ color: shellCol, metalness: hit.type === 'snare' ? 0.9 : 0.3, roughness: 0.25, side: THREE.DoubleSide }));
      const top = new THREE.Mesh(new THREE.CircleGeometry(r, 32), head);
      top.rotation.x = -Math.PI / 2;
      top.position.y = thick / 2;
      const bottom = new THREE.Mesh(new THREE.CircleGeometry(r, 32), head);
      bottom.rotation.x = Math.PI / 2;
      bottom.position.y = -thick / 2;
      for (const y of [thick / 2, -thick / 2]) {
        const hoop = new THREE.Mesh(new THREE.TorusGeometry(r, 0.008, 6, 32), themeOf(lane).rail);
        hoop.rotation.x = Math.PI / 2;
        hoop.position.y = y;
        group.add(hoop);
      }
      shell.castShadow = true;
      group.add(shell, top, bottom);
      flashMats.push(head);
    }
    group.quaternion.setFromUnitVectors(UP, n);
  }
  group.position.copy(center);
  group.userData = { t: hit.t, base: center.clone(), n, mats: flashMats };
  return group;
}

function railMeshes(rail, lane) {
  const out = [];
  const { path, sEnd } = rail, s0 = rail.s0 || 0;
  const steps = Math.max(4, Math.ceil((sEnd - s0) / 0.03));
  if (rail.tube) {
    // a ramp that loops back: a clear glass tube around the marble's path; it flies in one open
    // end and out the other
    const pts = [];
    for (let j = 0; j <= steps; j++) { const q = path.at(s0 + ((sEnd - s0) * j) / steps); pts.push(new THREE.Vector3(q.x, q.y, lane.z)); }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, steps * 2, TUBE_R - 0.004, 20, false), MAT.glass);
    tube.renderOrder = 2;
    out.push(tube);
    for (const u of [0, 1]) { // a metal rim at each mouth
      const rim = new THREE.Mesh(new THREE.TorusGeometry(TUBE_R - 0.002, 0.006, 8, 24), themeOf(lane).rail);
      rim.position.copy(curve.getPoint(u));
      rim.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangent(u));
      out.push(rim);
    }
  } else {
    const a = [], b = [];
    for (let j = 0; j <= steps; j++) {
      const q = path.at(s0 + ((sEnd - s0) * j) / steps);
      const x = q.x + q.nx * MARBLE_R * 0.85, y = q.y + q.ny * MARBLE_R * 0.85;
      a.push(new THREE.Vector3(x, y, lane.z + 0.036));
      b.push(new THREE.Vector3(x, y, lane.z - 0.036));
    }
    for (const pts of [a, b]) {
      const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), steps * 2, 0.009, 6), themeOf(lane).rail);
      m.castShadow = true;
      out.push(m);
    }
  }
  // support brackets exactly where the planner put them (it keeps the lanes behind clear of them)
  for (const q of rail.brackets || []) out.push(bracket(q.x, q.y, lane.z - (rail.tube ? 0 : 0.036), themeOf(lane).bracket));
  if (rail.kind === 'gutter') {
    // collector trough: a back plate so the catch reads as a channel
    const p0 = path.at(0), p1 = path.at(sEnd);
    const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(L, 0.12, 0.01), std({ color: 0x6b4a2c, roughness: 0.7 }));
    plate.position.set((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, lane.z - 0.07);
    plate.rotation.z = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    out.push(plate);
  }
  return out;
}

function buildScene() {
  disposeWorld();
  world = new THREE.Group();
  scene.add(world);
  pads = [];
  marbles = [];
  sprites = [];
  const { half, liftX } = plan;
  const yTop = plan.yMax + 1.5, yBot = plan.yMin - 1.0;
  const x0 = -half - 1.6, x1 = liftX + 1.2;

  // the wall: one plain painted colour
  const wallW = x1 - x0, wallH = yTop - yBot;
  const tex = WALL_TEX.clone();
  tex.needsUpdate = true;
  tex.repeat.set(wallW / 1.5, wallH / 1.5);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(wallW, wallH), std({ color: WALL_COLOR, map: tex, roughness: 0.95 }));
  wall.position.set((x0 + x1) / 2, (yTop + yBot) / 2, 0);
  wall.receiveShadow = true;
  world.add(wall);

  // Where the course runs (pads, rails, flights): decorations must keep clear of it.
  const CELL = 0.25, busy = new Set();
  const mark = (x, y, r) => {
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++)
      for (let iy = Math.floor((y - r) / CELL); iy <= Math.floor((y + r) / CELL); iy++) busy.add(ix * 7919 + iy);
  };
  const free = (x, y, r) => {
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++)
      for (let iy = Math.floor((y - r) / CELL); iy <= Math.floor((y + r) / CELL); iy++) if (busy.has(ix * 7919 + iy)) return false;
    return true;
  };
  for (const lane of plan.lanes) {
    for (let t = 0; t < plan.D; t += 0.02) { const m = marbleAt(lane, t); mark(m.x, m.y, 0.15); }
    for (const h of lane.hits) mark(h.pos.x, h.pos.y, 0.25);
    mark(liftX, (lane.yTop + lane.base.y) / 2, 0); // (lift is drawn below)
    for (let y = lane.base.y; y < lane.yTop; y += CELL) mark(liftX, y, 0.3);
  }

  // decorations: clouds, a few chunky pipes, little pixel-art sprites that bob to the beat
  const rng = mulberry32(plan.opt.seed * 31 + 7);
  const area = wallW * wallH;
  const place = (r, tries = 30) => {
    for (let k = 0; k < tries; k++) {
      const x = x0 + r + rng() * (wallW - 2 * r), y = yBot + r + rng() * (wallH - 2 * r);
      if (free(x, y, r)) { mark(x, y, r + 0.3); return { x, y }; }
    }
    return null;
  };
  for (let i = 0; i < area / 5; i++) {
    const size = 0.22 + rng() * 0.3, at = place(size * 0.9);
    if (!at) continue;
    const c = cloudMesh(rng, size);
    c.position.set(at.x, at.y, 0.05);
    world.add(c);
  }
  for (let i = 0; i < area / 16; i++) {
    const len = 0.8 + rng() * 0.8;
    const p = pipeMesh(rng, PIPE_COLORS[i % PIPE_COLORS.length], len);
    for (let k = 0; k < 60; k++) {
      const x = x0 + 0.3 + rng() * (wallW - 0.6), y = yBot + 0.3 + rng() * (wallH - 0.6);
      if (p.userData.points.every((q) => free(x + q.x, y + q.y, 0.2))) {
        p.userData.points.forEach((q) => mark(x + q.x, y + q.y, 0.45));
        p.position.set(x, y, 0.1);
        world.add(p);
        break;
      }
    }
  }
  const names = Object.keys(SPRITES);
  for (let i = 0; i < area / 6; i++) {
    const at = place(0.2);
    if (!at) continue;
    const sp = spriteMesh(names[Math.floor(rng() * names.length)], SPRITE_COLORS[Math.floor(rng() * SPRITE_COLORS.length)], 0.04);
    sp.position.set(at.x, at.y, 0.03);
    sp.userData = { y: at.y, phase: rng() < 0.5 ? 0 : 0.5 };
    world.add(sp);
    sprites.push(sp);
  }

  // lanes
  for (const lane of plan.lanes) {
    for (const h of lane.hits) {
      const m = padMesh(h, lane);
      const c = m.userData.base.clone().addScaledVector(m.userData.n, -padShape(h.type, h.midi, h.scale).thick / 2);
      world.add(bracket(c.x, c.y, lane.z - 0.02, themeOf(lane).bracket));
      world.add(m);
      pads.push(m);
    }
    for (const r of lane.rails) world.add(...railMeshes(r, lane));
    // lift: an opaque pipe the marble rides back up inside
    const yb = lane.base.y - 0.12, yt = lane.yTop + 0.14;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, yt - yb, 24, 1, true), MAT.pipe);
    tube.position.set(liftX, (yt + yb) / 2, lane.z);
    tube.castShadow = true;
    world.add(tube);
    for (const y of [yb, yt]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.088, 0.014, 8, 24), themeOf(lane).rail);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(liftX, y, lane.z);
      world.add(ring, bracket(liftX, y, lane.z - 0.08, themeOf(lane).bracket));
    }
    const marble = new THREE.Mesh(new THREE.SphereGeometry(MARBLE_R, 32, 24), themeOf(lane).marble);
    marble.castShadow = true;
    world.add(marble);
    marbles.push(marble);
  }
}

// ------------------------------------------------------------------ song loading
function loadSong() {
  $('info').textContent = 'Planning course…';
  setTimeout(() => {
    try {
      loadSongNow();
    } catch (e) {
      $('info').textContent = `Error: ${e.message}`;
      throw e;
    }
  }, 20);
}

function loadSongNow() {
  const key = $('song').value;
  const seed = parseInt($('seed').value, 10) || 0;
  if (key === 'proc') currentSong = generateSong(seed);
  else if (key === 'midi' && customMidi) currentSong = customMidi;
  else currentSong = buildSong(key);
  let truncated = false;
  const split = splitParts(currentSong.notes, { second: $('second').value });
  const parts = split.parts.map((p) => {
    const g = groupNotes(p.notes, { maxGroups: 500 });
    truncated ||= g.truncated;
    return { ...p, groups: g.groups };
  });
  plan = planCourse(parts, { seed, vMax: parseFloat($('pace').value) || 2.3 });
  // one event per pad hit; the synth splits it into lead / chord / drum voices
  events = plan.lanes.flatMap((l) => l.groups.map((g) => ({ notes: g.notes, role: l.role, tau: plan.offset + g.t - plan.g0 })));
  events.sort((a, b) => a.tau - b.tau);
  buildScene();
  const laneInfo = plan.lanes.map((l) => `<span style="color:${themeOf(l).dot}">●</span> ${l.name} ${l.hits.length} (${themeOf(l).name} track)`).join(' &nbsp;');
  const muted = split.muted.length ? `<br><span style="color:#9aa0c0">${split.muted.length} drum notes muted — set Second marble to Percussion to hear them</span>` : '';
  $('info').innerHTML = `<b style="color:#e8eaf6">${currentSong.name}</b><br>${laneInfo}<br>${plan.D.toFixed(1)}s loop · ${(plan.yMax - plan.yMin).toFixed(0)}m tall wall` + muted +
    (truncated ? '<br><span style="color:#ffb347">Song truncated to fit.</span>' : '');
  restart();
}

function restart() {
  if (!synth) return;
  startTime = synth.ctx.currentTime + 0.1 - (plan.opt.lift - 0.4);
  schedAbs = synth.ctx.currentTime - startTime;
}

function pumpAudio() {
  const now = synth.ctx.currentTime - startTime;
  const until = now + 0.25;
  const from = Math.max(schedAbs, now);
  for (let li = Math.floor(from / plan.D); li * plan.D < until; li++)
    for (const e of events) {
      const a = li * plan.D + e.tau;
      if (a >= from && a < until) synth.playHit(e.notes, startTime + a, e.role);
    }
  schedAbs = until;
}

// ?t=12.5 freezes the preview at that loop time (handy for screenshots); ?cam=, ?song=, ?seed=
const params = new URLSearchParams(location.search);
for (const k of ['cam', 'song', 'seed', 'second', 'font', 'pace']) if (params.get(k)) $(k).value = params.get(k);
if (params.has('shot')) for (const id of ['start', 'panel', 'toggle']) $(id).style.display = 'none';

function currentTau() {
  if (!synth) return params.has('t') ? Math.min(parseFloat(params.get('t')), plan.D - 0.01) : plan.opt.lift - 0.4;
  const t = synth.ctx.currentTime - startTime - synth.latency;
  return ((t % plan.D) + plan.D) % plan.D;
}

// ------------------------------------------------------------------ animation
const focus = new THREE.Vector3(0, 0, 6);
let lastTau = 0, lastFrame = performance.now(), camInit = false;

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  const dtF = Math.min(0.1, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;
  if (!plan || !marbles.length) return;
  if (playing) pumpAudio();
  const tau = currentTau();
  const dTau = tau - lastTau;
  lastTau = tau;

  // marbles (rolling rotation from velocity)
  let yLo = Infinity, yHi = -Infinity, xLo = Infinity, xHi = -Infinity;
  plan.lanes.forEach((lane, i) => {
    const m = marbleAt(lane, tau);
    const mesh = marbles[i];
    mesh.position.set(m.x, m.y, lane.z);
    if (dTau > 0 && dTau < 0.1) {
      const v = new THREE.Vector3(m.vx, m.vy, 0);
      const axis = new THREE.Vector3(0, 0, 1).cross(v).negate();
      if (axis.lengthSq() > 1e-8) mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis.normalize(), (v.length() * dTau) / MARBLE_R));
    }
    // frame only marbles that are playing: a hit within the last 1 s or the next 1.5 s (a marble
    // resting through a long gap in its part can wander off; it rejoins the shot before it plays)
    const hi = lastHitIndex(lane, tau), hits = lane.hits;
    const active = (hi >= 0 && tau - hits[hi].t < 1) || (hits[hi + 1] && hits[hi + 1].t - tau < 1.5);
    if ((m.type === 'flight' || m.type === 'rail') && active) { yLo = Math.min(yLo, m.y); yHi = Math.max(yHi, m.y); xLo = Math.min(xLo, m.x); xHi = Math.max(xHi, m.x); }
  });

  // pads: short soft glow + a small dip when struck
  for (const p of pads) {
    const u = p.userData;
    const dh = tau - u.t;
    const on = dh >= 0 && dh < 0.8;
    const f = on ? Math.exp(-dh * 8) : 0;
    for (const m of u.mats) m.emissiveIntensity = f * 0.5;
    // a struck pad dips slightly
    p.position.copy(u.base).addScaledVector(u.n, on ? -Math.exp(-dh * 20) * 0.012 : 0);
  }
  const beat = (tau * (currentSong.bpm || 120)) / 60;
  for (const s of sprites) s.position.y = s.userData.y + 0.025 * Math.abs(Math.sin(Math.PI * (beat + s.userData.phase)));

  // camera: close behind the marbles, zooming out only as far as needed to keep both in shot
  const mode = $('cam').value;
  controls.enabled = mode === 'free';
  const onCourse = yLo <= yHi;
  const fx = onCourse ? (xLo + xHi) / 2 : marbles[0].position.x;
  const fy = onCourse ? (yLo + yHi) / 2 : marbles[0].position.y;
  const k = camInit ? 1 - Math.exp(-dtF * 2.5) : 1;
  focus.x += (fx - focus.x) * k;
  focus.y += (fy - focus.y) * k;
  const needH = Math.max(2.5, (onCourse ? yHi - yLo : 0) + 1.5, ((onCourse ? xHi - xLo : 0) + 1.8) / camera.aspect);
  const wantDist = needH / 2 / Math.tan((13 * Math.PI) / 180);
  focus.z += (wantDist - focus.z) * (camInit ? 1 - Math.exp(-dtF * 1.2) : 1);
  camInit = true;
  if (mode === 'follow') {
    // a little above and to the side, so pads read as slabs and shadows fall on the wall
    camera.position.set(focus.x + 0.25 * focus.z / 5, focus.y + 0.7 * focus.z / 5, focus.z);
    camera.lookAt(focus.x, focus.y - 0.05, 0.3);
  } else if (mode === 'overview') {
    const H = plan.yMax - plan.yMin + 2;
    const dist = H / 2 / Math.tan((13 * Math.PI) / 180) + 1;
    const mid = (plan.yMax + plan.yMin) / 2;
    const a = Math.sin(nowMs / 9000) * 0.35;
    camera.position.lerp(new THREE.Vector3(0.4 + Math.sin(a) * dist, mid, Math.cos(a) * dist), k);
    camera.lookAt(0.4, mid, 0);
  } else controls.update();
  sun.position.set(focus.x - 1.2, focus.y + 4, 5);
  sun.target.position.set(focus.x + 0.6, focus.y - 0.8, 0);

  composer.render();
}

// ------------------------------------------------------------------ UI
$('start').addEventListener('click', async () => {
  $('start').remove();
  synth = new Synth();
  synth.font = $('font').value;
  await synth.ctx.resume();
  playing = true;
  restart();
});
$('song').addEventListener('change', loadSong);
$('seed').addEventListener('change', loadSong);
$('dice').addEventListener('click', () => {
  $('seed').value = Math.floor(Math.random() * 100000);
  if ($('song').value === 'midi') $('song').value = 'proc';
  loadSong();
});
$('font').addEventListener('change', () => synth && (synth.font = $('font').value));
$('second').addEventListener('change', loadSong);
$('pace').addEventListener('change', loadSong);
$('play').addEventListener('click', async () => {
  if (!synth) return;
  if (playing) await synth.ctx.suspend();
  else await synth.ctx.resume();
  playing = !playing;
  $('play').textContent = playing ? 'Pause' : 'Play';
});
$('loadMidi').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const notes = parseMidi(await f.arrayBuffer());
    if (!notes.length) throw new Error('No notes found');
    customMidi = { name: f.name, notes, bpm: 120 };
    let opt = $('song').querySelector('option[value=midi]');
    if (!opt) $('song').append((opt = new Option('', 'midi')));
    opt.textContent = `MIDI: ${f.name}`;
    $('song').value = 'midi';
    loadSong();
  } catch (err) {
    alert(`Couldn't read MIDI: ${err.message}`);
  }
});
$('export').addEventListener('click', () => {
  const r = (v) => +v.toFixed(4);
  const data = {
    song: currentSong.name, loopSeconds: plan.D, gravity: 9.8, marbleRadius: MARBLE_R,
    lanes: plan.lanes.map((l) => ({
      name: l.name, style: l.style, depth: l.z,
      hits: l.hits.map((h) => ({ t: r(h.t), type: h.type, position: [r(h.pos.x), r(h.pos.y), l.z], normal: [r(h.normal.x), r(h.normal.y), 0],
        notes: h.notes.map((n) => ({ midi: n.midi, vel: n.vel, ch: n.ch })) })),
      rails: l.rails.map((rl) => ({ kind: rl.kind, length: r(rl.sEnd), pieces: rl.path.pieces })),
    })),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = 'marble-course.json';
  a.click();
});
$('toggle').addEventListener('click', () => $('panel').classList.toggle('hidden'));
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'h') $('panel').classList.toggle('hidden');
  if (e.key === ' ') { e.preventDefault(); $('play').click(); }
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

loadSong();
frame();
