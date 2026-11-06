import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { planCourse, marbleAt, padShape, MARBLE_R, TUBE_R, rehydratePlan } from './planner.js';
import { cameraPose, cameraPlacement } from './camera.js';
import { THEMES } from './themes.js';
import { buildSong, generateSong, groupNotes, splitParts, assignObjects } from './music.js';
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

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

const camera = new THREE.PerspectiveCamera(26, innerWidth / innerHeight, 0.05, 400);
camera.position.set(0.8, 0.5, 5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enabled = false;

const hemi = new THREE.HemisphereLight(0xffffff, 0x5a8a98, 0.55);
scene.add(hemi);
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
  // fully clear glass: real transmission (see-through, slight refraction) with just reflections showing its shape
  glass: new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, thickness: 0.01, ior: 1.45, roughness: 0,
    metalness: 0, clearcoat: 1, clearcoatRoughness: 0, specularIntensity: 1, side: THREE.DoubleSide }),
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

let theme = THEMES.sky;
/** Lighting and background for the current theme (the scene is rebuilt separately). */
function applyTheme() {
  theme = THEMES[$('theme').value] || THEMES.sky;
  scene.background = new THREE.Color(theme.background);
  scene.fog = theme.fog ? new THREE.Fog(...theme.fog) : null;
  renderer.toneMappingExposure = theme.exposure;
  scene.environmentIntensity = theme.env;
  hemi.color.set(theme.hemi[0]); hemi.groundColor.set(theme.hemi[1]); hemi.intensity = theme.hemi[2];
  sun.color.set(theme.sun[0]); sun.intensity = theme.sun[1];
}

// ------------------------------------------------------------------ state
let synth = null, startTime = 0, playing = false;
let plan = null, events = [], world = null, pads = [], marbles = [], anims = [];
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

  if (hit.type === 'button') {
    // an arcade button: black bezel, coloured cap that presses in and flashes when hit
    const c = pitchColor(hit.midi);
    const bezel = new THREE.Mesh(new THREE.CylinderGeometry(len / 2, len / 2 * 1.05, thick * 0.5, 32), std({ color: 0x15171c, roughness: 0.35, metalness: 0.3 }));
    bezel.position.y = -thick / 4;
    const capMat = std({ color: c, roughness: 0.25, emissive: c, emissiveIntensity: 0.15 });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(len * 0.38, len * 0.4, thick * 0.5, 32), capMat);
    cap.position.y = thick / 4;
    const ringMat = std({ color: 0x222222, emissive: c, emissiveIntensity: 0.2 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(len * 0.44, 0.006, 8, 32), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.002;
    for (const m of [bezel, cap]) m.castShadow = m.receiveShadow = true;
    group.add(bezel, cap, ring);
    group.quaternion.setFromUnitVectors(UP, n);
    group.userData.button = { cap, capMat, ringMat };
  } else if (hit.type === 'tube') {
    // a chime tube lying along the bounce surface, with a coloured band that shimmers when struck
    const c = pitchColor(hit.midi);
    const metal = std({ color: themeOf(lane).rail.color, metalness: 1, roughness: 0.18 });
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(thick / 2, thick / 2, len, 24), metal);
    tube.rotation.z = Math.PI / 2; // axis along the pad's surface
    tube.castShadow = true;
    const bandMat = std({ color: c, roughness: 0.3, metalness: 0.4, emissive: c, emissiveIntensity: 0 });
    const band = new THREE.Mesh(new THREE.CylinderGeometry(thick / 2 + 0.002, thick / 2 + 0.002, Math.min(0.05, len * 0.18), 24), bandMat);
    band.rotation.z = Math.PI / 2;
    const capGeo = new THREE.CylinderGeometry(thick / 2 + 0.003, thick / 2 + 0.003, 0.01, 24);
    for (const sx of [-1, 1]) { const ec = new THREE.Mesh(capGeo, themeOf(lane).rail); ec.rotation.z = Math.PI / 2; ec.position.x = sx * len / 2; group.add(ec); }
    group.add(tube, band);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, n, new THREE.Vector3(0, 0, 1)));
    flashMats.push(bandMat);
    group.userData.tube = true;
  } else if (hit.type === 'key' || hit.type === 'bar' || hit.type === 'chime') {
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
  group.userData = { ...group.userData, t: hit.t, base: center.clone(), n, mats: flashMats, baseQ: group.quaternion.clone() };
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
  return out;
}

/** A short opaque pipe stub: the marble rolls out of one at its start and into one at its end. */
function stubMeshes(st, lane, pipeMat) {
  const out = [];
  const dir = new THREE.Vector3(Math.cos(st.angle), Math.sin(st.angle), 0);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_R, TUBE_R, st.len, 24, 1, true), pipeMat);
  tube.position.set(st.x, st.y, lane.z);
  tube.quaternion.setFromUnitVectors(UP, dir);
  tube.castShadow = true;
  out.push(tube);
  for (const sgn of [-1, 1]) { // rims at both mouths
    const rim = new THREE.Mesh(new THREE.TorusGeometry(TUBE_R, 0.014, 8, 24), themeOf(lane).rail);
    rim.position.set(st.x + dir.x * sgn * st.len / 2, st.y + dir.y * sgn * st.len / 2, lane.z);
    rim.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    out.push(rim);
  }
  out.push(bracket(st.bracket.x, st.bracket.y, lane.z, themeOf(lane).bracket));
  return out;
}

function buildScene() {
  disposeWorld();
  world = new THREE.Group();
  scene.add(world);
  pads = [];
  marbles = [];
  anims = [];
  const b = plan.bounds;
  const x0 = b.x0 - 1.5, x1 = b.x1 + 1.5, yBot = b.y0 - 1.5, yTop = b.y1 + 1.5;

  // the wall, in the theme's finish (texture world-aligned: one tile per 1.5 m)
  const wallW = x1 - x0, wallH = yTop - yBot;
  const wm = theme.wall();
  wm.map.repeat.set(wallW / 1.5, wallH / 1.5);
  wm.map.offset.set((x0 / 1.5) % 1, (yBot / 1.5) % 1);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(wallW, wallH), std(wm));
  wall.position.set((x0 + x1) / 2, (yTop + yBot) / 2, 0);
  wall.receiveShadow = true;
  world.add(wall);

  // the two seam signs behind the first marble's start and end stubs (identical: seamless loop)
  for (const c of [plan.seam.top, plan.seam.bottom]) {
    const sign = theme.sign(plan.seam.plate.w, plan.seam.plate.h, currentSong.name.replace(/ —.*/, ''));
    sign.position.set(c.x, c.y, 0.011);
    world.add(sign);
  }

  // Where the course runs (pads, rails, flights) and the seam frames: decorations keep clear.
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
    for (const st of lane.stubs) mark(st.x, st.y, 0.3);
  }
  for (const bx of [plan.seam.boxTop, plan.seam.boxBottom])
    for (let x = bx.x0; x <= bx.x1; x += CELL) for (let y = bx.y0; y <= bx.y1; y += CELL) mark(x, y, 0.3);

  const rng = mulberry32(plan.opt.seed * 31 + 7);
  const place = (r, tries = 30) => {
    for (let k = 0; k < tries; k++) {
      const x = x0 + r + rng() * (wallW - 2 * r), y = yBot + r + rng() * (wallH - 2 * r);
      if (free(x, y, r)) { mark(x, y, r + 0.3); return { x, y }; }
    }
    return null;
  };
  anims = theme.decorate({ rng, area: wallW * wallH, place, free, mark, add: (m) => world.add(m), bounds: { x0, x1, y0: yBot, y1: yTop } });

  // lanes
  const pipeMat = std({ color: theme.pipe, roughness: 0.35, metalness: 0.1 });
  for (const lane of plan.lanes) {
    for (const h of lane.hits) {
      const m = padMesh(h, lane);
      const c = m.userData.base.clone().addScaledVector(m.userData.n, -padShape(h.type, h.midi, h.scale).thick / 2);
      world.add(bracket(c.x, c.y, lane.z - 0.02, themeOf(lane).bracket));
      world.add(m);
      pads.push(m);
    }
    for (const r of lane.rails) world.add(...railMeshes(r, lane));
    for (const st of lane.stubs) world.add(...stubMeshes(st, lane, pipeMat));
    const marble = new THREE.Mesh(new THREE.SphereGeometry(MARBLE_R, 32, 24), themeOf(lane).marble);
    marble.castShadow = true;
    world.add(marble);
    marbles.push(marble);
  }
}

// ------------------------------------------------------------------ song loading
// Planning runs in a worker so the page stays responsive and the spinner can show progress.
let worker = null, planId = 0;
function showPlanning(text, frac) {
  $('planning').classList.add('on');
  $('planningText').textContent = text;
  $('planningBar').style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}
function hidePlanning() { $('planning').classList.remove('on'); }

function planInBackground(parts, options, onProgress) {
  const id = ++planId;
  return new Promise((resolve, reject) => {
    const fallback = () => { // no worker (old browser / file://): plan here instead
      try { resolve(planCourse(parts, options)); } catch (e) { reject(e); }
    };
    if (params.has('shot')) return fallback(); // screenshot mode: plan synchronously (deterministic capture)
    if (!worker) {
      try { worker = new Worker(new URL('./plan-worker.js', import.meta.url), { type: 'module' }); }
      catch { worker = null; return fallback(); }
    }
    const w = worker;
    w.onmessage = (e) => {
      if (e.data.id !== id) return; // an older request: ignore
      if (e.data.progress) return onProgress(e.data.progress);
      if (e.data.error) return reject(new Error(e.data.error));
      resolve(rehydratePlan(e.data.plan));
    };
    w.onerror = (e) => { e.preventDefault?.(); worker.terminate(); worker = null; fallback(); };
    w.postMessage({ id, parts, options });
  });
}

async function loadSong() {
  const key = $('song').value;
  const seed = parseInt($('seed').value, 10) || 0;
  let song;
  if (key === 'proc') song = generateSong(seed);
  else if (key === 'midi' && customMidi) song = customMidi;
  else song = buildSong(key);
  let truncated = false;
  const split = splitParts(song.notes, { second: $('second').value });
  const parts = split.parts.map((p) => {
    const g = groupNotes(p.notes, { maxGroups: 500 });
    truncated ||= g.truncated;
    return { ...p, groups: g.groups };
  });
  assignObjects(parts, { mode: $('objects').value, seed, bpm: song.bpm || 120, bar: song.bar || 4 }); // keys / buttons / tubes by song section
  // if a song is already planning, restart the worker so the new request doesn't queue behind it
  if ($('planning').classList.contains('on') && worker) { worker.terminate(); worker = null; }
  const myId = planId + 1;
  showPlanning(`Planning ${song.name.replace(/ —.*/, '')}…`, 0);
  let newPlan;
  try {
    newPlan = await planInBackground(parts, { seed, vMax: parseFloat($('pace').value) || 2.3 }, (p) =>
      showPlanning(`Planning ${p.name.toLowerCase()} (${p.lane + 1} of ${p.lanes})…`, (p.lane + p.done) / p.lanes));
  } catch (e) {
    if (myId === planId) { hidePlanning(); $('info').textContent = `Error: ${e.message}`; }
    throw e;
  }
  if (myId !== planId) return; // superseded by a newer request
  plan = newPlan;
  currentSong = song;
  // one event per pad hit; the synth splits it into lead / chord / drum voices
  events = plan.lanes.flatMap((l) => l.groups.map((g) => ({ notes: g.notes, role: l.role, obj: g.obj, tau: plan.offset + g.t - plan.g0 })));
  events.sort((a, b) => a.tau - b.tau);
  buildScene();
  hidePlanning();
  const laneInfo = plan.lanes.map((l) => `<span style="color:${themeOf(l).dot}">●</span> ${l.name} ${l.hits.length} (${themeOf(l).name} track)`).join(' &nbsp;');
  const muted = split.muted.length ? `<br><span style="color:#9aa0c0">${split.muted.length} drum notes muted — set Second marble to Percussion to hear them</span>` : '';
  $('info').innerHTML = `<b style="color:#e8eaf6">${song.name}</b><br>${laneInfo}<br>${plan.D.toFixed(1)}s seamless loop · ${(plan.yMax - plan.yMin).toFixed(0)}m tall wall` + muted +
    (truncated ? '<br><span style="color:#ffb347">Song truncated to fit.</span>' : '');
  restart();
}

function restart() {
  if (!synth) return;
  startTime = synth.ctx.currentTime + 0.1; // the loop starts at the seam
  schedAbs = synth.ctx.currentTime - startTime;
}

function pumpAudio() {
  const now = synth.ctx.currentTime - startTime;
  const until = now + 0.25;
  const from = Math.max(schedAbs, now);
  for (let li = Math.floor(from / plan.D); li * plan.D < until; li++)
    for (const e of events) {
      const a = li * plan.D + e.tau;
      if (a >= from && a < until) synth.playHit(e.notes, startTime + a, e.role, synth.font, e.obj);
    }
  schedAbs = until;
}

// ?t=12.5 freezes the preview at that loop time (handy for screenshots); ?cam=, ?song=, ?seed=
const params = new URLSearchParams(location.search);
for (const k of ['cam', 'song', 'seed', 'second', 'font', 'pace', 'theme', 'objects']) if (params.get(k)) $(k).value = params.get(k);
if (params.has('shot')) for (const id of ['start', 'panel', 'toggle']) $(id).style.display = 'none';

function currentTau() {
  if (!synth) return params.has('t') ? Math.min(parseFloat(params.get('t')), plan.D - 1e-6) : 0;
  const t = synth.ctx.currentTime - startTime - synth.latency;
  return ((t % plan.D) + plan.D) % plan.D;
}

// ------------------------------------------------------------------ animation
let lastTau = 0, lastFrame = performance.now();

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  lastFrame = nowMs;
  if (!plan || !marbles.length) return;
  if (playing) pumpAudio();
  const tau = currentTau();
  const dTau = tau - lastTau;
  lastTau = tau;

  // marbles (rolling rotation from velocity); hidden while inside a pipe stub
  plan.lanes.forEach((lane, i) => {
    const m = marbleAt(lane, tau);
    const mesh = marbles[i];
    mesh.position.set(m.x, m.y, lane.z);
    mesh.visible = m.type !== 'hidden';
    if (dTau > 0 && dTau < 0.1) {
      const v = new THREE.Vector3(m.vx, m.vy, 0);
      const axis = new THREE.Vector3(0, 0, 1).cross(v).negate();
      if (axis.lengthSq() > 1e-8) mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis.normalize(), (v.length() * dTau) / MARBLE_R));
    }
  });

  // pads: short soft glow + a small dip when struck
  for (const p of pads) {
    const u = p.userData;
    const dh = tau - u.t;
    const on = dh >= 0 && dh < 0.8;
    const f = on ? Math.exp(-dh * 8) : 0;
    for (const m of u.mats) m.emissiveIntensity = f * (u.tube ? 1.2 : 0.5);
    // a struck pad dips slightly
    p.position.copy(u.base).addScaledVector(u.n, on ? -Math.exp(-dh * 20) * 0.012 : 0);
    if (u.button) { // the cap presses in and the button flashes bright (bloom picks it up)
      const fl = on ? Math.exp(-dh * 6) : 0;
      u.button.capMat.emissiveIntensity = 0.15 + 3.5 * fl;
      u.button.ringMat.emissiveIntensity = 0.2 + 2.5 * fl;
      u.button.cap.position.y = padShape('button', 0).thick / 4 - (on ? 0.012 * Math.exp(-dh * 25) : 0);
    }
    if (u.tube) { // the struck tube wobbles a little
      const w = on ? 0.07 * Math.exp(-dh * 3) * Math.sin(dh * 22) : 0;
      p.quaternion.copy(u.baseQ).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), w));
    }
  }
  // decorations animate with loop time (so they're in the same state at both ends of the loop)
  const beat = (tau * (currentSong.bpm || 120)) / 60;
  for (const a of anims) a(tau, beat);

  // camera: a pure function of loop time (see camera.js), so the loop's ends match exactly
  const mode = $('cam').value;
  controls.enabled = mode === 'free';
  const pose = cameraPose(plan, tau, camera.aspect);
  if (mode === 'follow') {
    const { position: p, lookAt: l } = cameraPlacement(pose);
    camera.position.set(p.x, p.y, p.z);
    camera.lookAt(l.x, l.y, l.z);
  } else if (mode === 'overview') {
    const H = plan.yMax - plan.yMin + 2;
    const dist = H / 2 / Math.tan((13 * Math.PI) / 180) + 1;
    const mid = (plan.yMax + plan.yMin) / 2, cx = (plan.bounds.x0 + plan.bounds.x1) / 2;
    const a = Math.sin(nowMs / 9000) * 0.35;
    camera.position.set(cx + Math.sin(a) * dist, mid, Math.cos(a) * dist);
    camera.lookAt(cx, mid, 0);
  } else controls.update();
  sun.position.set(pose.x - 1.2, pose.y + 4, 5);
  sun.target.position.set(pose.x + 0.6, pose.y - 0.8, 0);

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
$('theme').addEventListener('change', () => { applyTheme(); if (plan) buildScene(); });
$('second').addEventListener('change', loadSong);
$('pace').addEventListener('change', loadSong);
$('objects').addEventListener('change', loadSong);
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
      rails: l.rails.map((rl) => ({ kind: rl.kind, from: r(rl.s0 || 0), length: r(rl.sEnd), tube: !!rl.tube, pieces: rl.path.pieces })),
      stubs: l.stubs.map((st) => ({ role: st.role, position: [r(st.x), r(st.y), l.z], angle: r(st.angle), length: st.len })),
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

applyTheme();
loadSong();
frame();
