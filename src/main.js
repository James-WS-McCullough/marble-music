import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { planCourse, marbleAt, padShape, MARBLE_R, TUBE_R, WALL_MOUNTED, rehydratePlan } from './planner.js';
import { cameraPose, cameraPlacement } from './camera.js';
import { THEMES } from './themes.js';
import { buildSong, generateSong, generateLofi, attachSwitches, groupNotes, splitParts, assignObjects, instrumentForSong } from './music.js';
import { appendItem, itemAt, collect, settingsAt } from './timeline.js';
import { parseMidi } from './midi.js';
import { Synth } from './audio.js';
import { mulberry32 } from './util.js';

const $ = (id) => document.getElementById(id);

// A cached copy of an older page (missing newer controls) can't run this code: reload once to
// get the current page, rather than failing silently.
{
  const needed = ['song', 'seed', 'second', 'zoom', 'bright', 'glow', 'deco', 'volume', 'lofiFx', 'pace', 'melodyObj', 'harmonyObj', 'drumKit', 'theme', 'cam', 'planning', 'info'];
  const missing = needed.filter((id) => !$(id));
  if (missing.length) {
    let tried = false;
    try { tried = sessionStorage.getItem('marble-reloaded') === '1'; sessionStorage.setItem('marble-reloaded', '1'); } catch {}
    if (!tried) location.reload();
    throw new Error(`This page is out of date (missing ${missing.join(', ')}); please reload.`);
  }
  try { sessionStorage.removeItem('marble-reloaded'); } catch {}
}
// Show problems in the panel instead of leaving a blank page.
const showError = (msg) => {
  $('planning').classList.remove('on');
  $('info').innerHTML = `<span style="color:#ff8a80">Something went wrong: ${String(msg).replace(/</g, '&lt;')}</span>`;
};
addEventListener('error', (e) => showError(e.message));
addEventListener('unhandledrejection', (e) => showError(e.reason?.message || e.reason));

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
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.15, 0.3, 0.95);
composer.addPass(bloom);
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
const GUITAR_BOARD = std({ color: 0x3b2418, roughness: 0.55 });
const GUITAR_BRIDGE = std({ color: 0x1e1410, roughness: 0.5 });
const GUITAR_SADDLE = std({ color: 0xf1e8d4, roughness: 0.4 });
/** Pose a guitar string as two straight halves meeting at a midpoint displaced by dy (a pluck). */
function setString(s, dy) {
  const h = s.L / 2;
  for (const [m, x0] of [[s.a, -h], [s.b, h]]) {
    const dx = -x0, len = Math.hypot(dx, dy);
    m.scale.set(1, len, 1);
    m.position.set(x0 + dx / 2, s.y + dy / 2, s.z);
    m.rotation.set(0, 0, Math.atan2(dy, dx) - Math.PI / 2);
  }
}
const EPIANO_BODY = std({ color: 0x4a2c1c, roughness: 0.45, metalness: 0.05 });
// record grooves: fine concentric rings
const VINYL_TEX = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0d0d10'; g.fillRect(0, 0, 256, 256);
  for (let r = 40; r < 127; r += 1.5) { g.strokeStyle = `rgba(255,255,255,${0.03 + 0.04 * Math.sin(r * 0.7) ** 2})`; g.beginPath(); g.arc(128, 128, r, 0, Math.PI * 2); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
// hazard stripes on a switch block's top
const STRIPE_TEX = (() => {
  const c = document.createElement('canvas'); c.width = 128; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#1f2328'; g.fillRect(0, 0, 128, 32); g.fillStyle = '#ffc533';
  for (let x = -32; x < 160; x += 24) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 12, 32); g.lineTo(x + 44, 0); g.lineTo(x + 32, 0); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const themeOf = (lane) => LANE_THEMES[Math.min(lane.k, LANE_THEMES.length - 1)];
const clampN = (x, a, b) => Math.max(a, Math.min(b, x));
const SHARED = new Set([...Object.values(MAT), ...Object.values(MARBLE_MATS), EPIANO_BODY, GUITAR_BOARD, GUITAR_BRIDGE, GUITAR_SADDLE]);
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

/** Wood grain for the wooden tubes (lengthwise streaks, mapped around the tube). */
const WOOD_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d'), rng = mulberry32(21);
  g.fillStyle = '#c08a55'; g.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 60; i++) {
    g.strokeStyle = `rgba(${rng() < 0.5 ? '90,50,20' : '230,190,140'},${0.08 + rng() * 0.15})`;
    g.lineWidth = 1 + rng() * 3;
    const x = rng() * 128;
    g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + (rng() - 0.5) * 20, 90, x + (rng() - 0.5) * 20, 170, x + (rng() - 0.5) * 10, 256); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
/** Bamboo skin: yellow-green with fine lengthwise streaks. */
const BAMBOO_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d'), rng = mulberry32(33);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 70; i++) {
    g.fillStyle = `rgba(${rng() < 0.6 ? '120,130,40' : '255,255,220'},${0.05 + rng() * 0.12})`;
    g.fillRect(rng() * 128, 0, 1 + rng() * 2, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})();
/** Bamboo colour: greener for low notes, yellower for high ones. */
const bambooTint = (midi) => new THREE.Color().setHSL(0.2 + Math.max(-0.03, Math.min(0.03, (60 - midi) / 500)), 0.55, 0.42);

let theme = THEMES.sky;
/** Lighting and background for the current theme (the scene is rebuilt separately). */
function applyTheme() {
  theme = THEMES[$('theme').value] || THEMES.sky;
  scene.background = new THREE.Color(theme.background);
  scene.fog = theme.fog ? new THREE.Fog(...theme.fog) : null;
  applySettings();
  scene.environmentIntensity = theme.env;
  hemi.color.set(theme.hemi[0]); hemi.groundColor.set(theme.hemi[1]); hemi.intensity = theme.hemi[2];
  sun.color.set(theme.sun[0]); sun.intensity = theme.sun[1];
}

// ------------------------------------------------------------------ state
let synth = null, startTime = 0, playing = false;
let plan = null, world = null, pads = [], marbles = [], anims = [];
let schedAbs = 0, currentSong = null, customMidi = null;
// What's playing: a timeline of songs on one clock (one item, looping - or, in endless mode, a new
// song appended at a loop boundary as each one nears its end). `active` is the one on screen.
let items = [], active = null;

/** Display settings (the Settings section): brightness, glow; volume. */
function applySettings() {
  renderer.toneMappingExposure = theme.exposure * parseFloat($('bright').value);
  bloom.strength = parseFloat($('glow').value);
  synth?.setVolume(parseFloat($('volume').value));
  for (const id of ['zoom', 'bright', 'glow', 'volume']) $(`${id}Val`).textContent = `${Math.round(parseFloat($(id).value) * 100)}%`;
}

function disposeWorld() {
  if (!world) return;
  world.traverse((o) => {
    o.geometry?.dispose();
    if (o.material && !SHARED.has(o.material)) [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); });
  });
  scene.remove(world);
}

// ------------------------------------------------------------------ building the scene
function padMesh(hit, lane, grp = {}) {
  const { len, thick } = padShape(hit.type, hit.midi, hit.scale);
  const n = new THREE.Vector3(hit.normal.x, hit.normal.y, 0);
  const t = new THREE.Vector3(hit.normal.y, -hit.normal.x, 0);
  const center = new THREE.Vector3(hit.pos.x, hit.pos.y, lane.z).addScaledVector(n, -(MARBLE_R + thick / 2));
  const group = new THREE.Group();
  const flashMats = [];
  const pitched = hit.notes.filter((nt) => nt.ch !== 9).sort((a, b) => a.midi - b.midi);

  if (hit.type === 'bamboo') {
    // a bamboo tube sticking straight out of the wall, with nodes along it and a pale cut end;
    // the marble bounces off its rounded side
    const r = thick / 2, L = lane.z + 0.08;
    const skin = std({ map: BAMBOO_TEX, color: bambooTint(hit.midi), roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide });
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, 28, 1, true), skin);
    tube.rotation.x = Math.PI / 2;
    tube.position.z = -L / 2 + 0.08; // from the wall (z = -lane.z here) to just past the marble
    tube.castShadow = tube.receiveShadow = true;
    group.add(tube);
    const nodeMat = std({ color: bambooTint(hit.midi).multiplyScalar(0.6), roughness: 0.5 });
    for (let z = 0.08 - 0.2; z > 0.08 - L + 0.05; z -= 0.24) { // the raised rings of the nodes
      const node = new THREE.Mesh(new THREE.TorusGeometry(r * 1.0, r * 0.07, 6, 28), nodeMat);
      node.position.z = z;
      group.add(node);
    }
    const rimMat = std({ color: 0xe8dcb0, roughness: 0.8, emissive: 0xfff0b0, emissiveIntensity: 0 });
    const rim = new THREE.Mesh(new THREE.RingGeometry(r * 0.8, r, 28), rimMat); // the pale cut end
    rim.position.z = 0.0801;
    const hole = new THREE.Mesh(new THREE.CircleGeometry(r * 0.8, 28), std({ color: 0x2a2410, roughness: 1 }));
    hole.position.z = 0.079;
    group.add(rim, hole);
    flashMats.push(rimMat);
    group.userData.bamboo = true;
    group.position.set(center.x, center.y, lane.z);
    group.userData = { ...group.userData, t: hit.t, base: group.position.clone(), n, mats: flashMats, baseQ: group.quaternion.clone() };
    return group;
  }
  if (hit.type === 'bottle') {
    // a glass bottle lying along the surface, part-filled with coloured water (more water = lower)
    const c = pitchColor(hit.midi), r = thick / 2, bodyL = len * 0.65, neckL = len * 0.22;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, bodyL, 24), MAT.glass);
    body.rotation.z = Math.PI / 2; body.position.x = -len / 2 + bodyL / 2;
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.3, r, len * 0.13, 24), MAT.glass);
    shoulder.rotation.z = -Math.PI / 2; shoulder.position.x = -len / 2 + bodyL + len * 0.065;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.3, neckL, 16), MAT.glass);
    neck.rotation.z = Math.PI / 2; neck.position.x = len / 2 - neckL / 2;
    const lip = new THREE.Mesh(new THREE.TorusGeometry(r * 0.32, 0.004, 6, 16), MAT.glass);
    lip.rotation.y = Math.PI / 2; lip.position.x = len / 2;
    // the water: a circular segment (flat top) along the body, kept level as the bottle tilts
    const fill = clampN(0.85 - (hit.midi - 48) / 48, 0.2, 0.85);
    const ri = r * 0.88, h = 2 * ri * fill, a = Math.acos(1 - h / ri) ; // half-angle of the segment
    const shape = new THREE.Shape();
    shape.absarc(0, 0, ri, -Math.PI / 2 - a, -Math.PI / 2 + a, false);
    shape.closePath();
    // (solid, not transparent: the glass's transmission only shows solid things through it)
    const waterMat = std({ color: c, roughness: 0.15, metalness: 0, emissive: c, emissiveIntensity: 0.1 });
    const water = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: bodyL * 0.94, bevelEnabled: false, curveSegments: 16 }), waterMat);
    water.rotation.y = Math.PI / 2; // extrude along the bottle's axis
    water.position.x = -len / 2 + bodyL * 0.03;
    const waterPivot = new THREE.Group();
    waterPivot.add(water);
    // "down" in the bottle's cross-section is along -n (or +n for an underside pad): roll the
    // water so its flat surface is level
    waterPivot.rotation.x = n.y >= 0 ? 0 : Math.PI;
    for (const m of [body, shoulder, neck]) m.renderOrder = 2;
    group.add(waterPivot, body, shoulder, neck, lip);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, n, new THREE.Vector3(0, 0, 1)));
    flashMats.push(waterMat);
    group.userData.bottle = { waterPivot, rest: waterPivot.rotation.x };
  } else if (hit.type === 'neon') {
    // a neon light tube: glows softly all the time, flares when hit
    const c = pitchColor(hit.midi), r = thick / 2;
    // a deep colour at a modest glow keeps its hue (very bright emissive tone-maps to white)
    const hue = new THREE.Color().setHSL((hit.midi % 12) / 12, 1, 0.42);
    const glowMat = std({ color: hue, emissive: hue, emissiveIntensity: 0.75, roughness: 0.2 });
    const tube = new THREE.Mesh(new THREE.CapsuleGeometry(r * 0.7, len - r * 1.4, 6, 16), glowMat);
    tube.rotation.z = Math.PI / 2;
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len * 0.96, 20, 1, true), MAT.glass);
    sleeve.rotation.z = Math.PI / 2; sleeve.renderOrder = 2;
    const capMat = std({ color: 0x3a3d44, metalness: 0.8, roughness: 0.35 });
    for (const sx of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.1, r * 1.1, 0.03, 16), capMat);
      cap.rotation.z = Math.PI / 2; cap.position.x = sx * (len / 2 - 0.015);
      group.add(cap);
    }
    group.add(tube, sleeve);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, n, new THREE.Vector3(0, 0, 1)));
    group.userData.neon = { glowMat };
  } else if (hit.type === 'bell') {
    // a brass handbell on its side (mouth one way, wooden handle the other), struck on its flank
    const r = thick / 2, bellL = len * 0.55;
    // profile from the crown (a rounded dome) down a gently widening waist to a flared lip
    const pts = [];
    for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI / 2; pts.push(new THREE.Vector2(r * 0.6 * Math.sin(a), bellL / 2 - r * 0.35 * (1 - Math.cos(a)))); }
    const top = bellL / 2 - r * 0.35;
    for (let i = 1; i <= 10; i++) { const u = i / 10; pts.push(new THREE.Vector2(r * (0.6 + 0.22 * u + (u > 0.75 ? 0.18 * ((u - 0.75) / 0.25) ** 1.5 : 0)), top - u * (top + bellL / 2))); }
    pts.reverse(); // lathe goes mouth (-) to crown (+)
    const brass = std({ color: 0xd8a640, metalness: 1, roughness: 0.22, emissive: 0xffd27a, emissiveIntensity: 0, side: THREE.DoubleSide });
    const bell = new THREE.Mesh(new THREE.LatheGeometry(pts, 28), brass);
    bell.rotation.z = Math.PI / 2; // axis along the surface; the mouth (wide end) towards -t
    bell.position.x = -len / 2 + bellL / 2;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.017, len - bellL, 12), std({ color: 0x5a3416, roughness: 0.6 }));
    handle.rotation.z = Math.PI / 2; handle.position.x = len / 2 - (len - bellL) / 2;
    bell.castShadow = handle.castShadow = true;
    group.add(bell, handle);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, n, new THREE.Vector3(0, 0, 1)));
    flashMats.push(brass);
    group.userData.swing = true;
  } else if (hit.type === 'woodblock') {
    const blockMat = std({ map: WOOD_TEX, color: 0xb8743f, roughness: 0.55, emissive: 0xffa060, emissiveIntensity: 0 });
    const block = new THREE.Mesh(new THREE.BoxGeometry(len, thick, 0.09), blockMat);
    const slit = new THREE.Mesh(new THREE.BoxGeometry(len * 0.8, thick * 0.12, 0.092), std({ color: 0x1e120a, roughness: 1 }));
    slit.position.y = -thick * 0.15;
    block.castShadow = block.receiveShadow = true;
    group.add(block, slit);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, n, new THREE.Vector3(0, 0, 1)));
    flashMats.push(blockMat);
  } else if (hit.type === 'cowbell') {
    // a squarish bell (a frustum with four sides), mouth towards -t
    const iron = std({ color: 0x5b5f66, metalness: 0.9, roughness: 0.35, emissive: 0xfff2c0, emissiveIntensity: 0 });
    const bellG = new THREE.CylinderGeometry(thick * 0.32, thick * 0.62, len, 4, 1, true);
    const cow = new THREE.Mesh(bellG, iron);
    cow.material.side = THREE.DoubleSide;
    cow.rotation.set(0, Math.PI / 4, Math.PI / 2);
    cow.castShadow = true;
    group.add(cow);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, n, new THREE.Vector3(0, 0, 1)));
    flashMats.push(iron);
    group.userData.swing = true;
  } else   if (hit.type === 'button') {
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
  } else if (hit.type === 'vinyl') {
    // a record on a little turntable platter: black grooves, a coloured label, a chrome spindle
    const r = len / 2;
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(len + 0.04, thick * 0.55, 0.16), std({ color: 0x6b4a32, roughness: 0.55 }));
    plinth.position.y = -thick * 0.22;
    plinth.castShadow = plinth.receiveShadow = true;
    const disc = new THREE.Group();
    const grooveTex = VINYL_TEX;
    const rec = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.008, 48), [std({ color: 0x101012, roughness: 0.35 }), std({ map: grooveTex, roughness: 0.3, metalness: 0.2 }), std({ color: 0x101012 })]);
    rec.position.y = thick / 2 - 0.004;
    const c = pitchColor(hit.midi);
    const labelMat = std({ color: c, roughness: 0.6, emissive: c, emissiveIntensity: 0 });
    const label = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.32, r * 0.32, 0.0085, 32), labelMat);
    label.position.y = thick / 2 - 0.004;
    const dot = new THREE.Mesh(new THREE.BoxGeometry(r * 0.12, 0.009, 0.01), std({ color: 0xffffff, roughness: 0.6 }));
    dot.position.set(r * 0.18, thick / 2 - 0.004, 0);
    disc.add(rec, label, dot);
    const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.02, 10), MAT.rail);
    spindle.position.y = thick / 2;
    group.add(plinth, disc, spindle);
    flashMats.push(labelMat);
    group.quaternion.setFromUnitVectors(UP, n);
    group.userData.vinyl = { disc };
  } else if (hit.type === 'guitar') {
    // guitar strings stretched between two bridges over a rosewood board (a chord = several
    // strings side by side); the marble strikes the strings, which twang when hit
    const keys = pitched.length ? pitched : [{ midi: hit.midi }];
    const W = 0.13, R = 0.0055, yS = thick / 2 - R;
    const board = new THREE.Mesh(new THREE.BoxGeometry(len + 0.03, thick * 0.45, W + 0.02), GUITAR_BOARD);
    board.position.y = -thick / 2 + thick * 0.225;
    board.castShadow = board.receiveShadow = true;
    group.add(board);
    for (const fx of [-0.22, 0.05, 0.27]) { // a few frets
      const fret = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.006, W), MAT.rail);
      fret.position.set(fx * len, board.position.y + thick * 0.225 + 0.003, 0);
      group.add(fret);
    }
    for (const fx of [-0.085, 0.16]) { // pearl inlay dots between the frets
      const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.002, 16), GUITAR_SADDLE);
      dot.position.set(fx * len, board.position.y + thick * 0.225 + 0.001, 0);
      group.add(dot);
    }
    for (const sx of [-1, 1]) { // the bridges (bone-white saddles on dark blocks)
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.02, yS - board.position.y, W + 0.01), GUITAR_BRIDGE);
      block.position.set(sx * len / 2, (yS + board.position.y) / 2 - 0.004, 0);
      const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.006, W + 0.01), GUITAR_SADDLE);
      saddle.position.set(sx * len / 2, yS - R - 0.002, 0);
      block.castShadow = true;
      group.add(block, saddle);
    }
    const strings = [], half = new THREE.CylinderGeometry(R, R, 1, 8);
    keys.forEach((nt, j) => {
      const c = pitchColor(nt.midi);
      const mat = std({ color: nt.midi < 55 ? 0xe0b070 : 0xf2f4f7, metalness: 0.6, roughness: 0.22, emissive: c, emissiveIntensity: 0 });
      const z = keys.length > 1 ? -W / 2 + 0.012 + (W - 0.024) * (j / (keys.length - 1)) : 0;
      const a = new THREE.Mesh(half, mat), b = new THREE.Mesh(half, mat);
      group.add(a, b);
      flashMats.push(mat);
      const s = { a, b, L: len, y: yS, z, phase: j * 1.3 };
      setString(s, 0);
      strings.push(s);
    });
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, n, new THREE.Vector3(0, 0, 1)));
    group.userData.guitar = { strings };
  } else if (hit.type === 'switch') {
    // a chunky switch block: the marble lands on its top; on the front, a lever that flips over
    // and a lamp (orange: the beat; blue: the filter) that lights when it's thrown
    const set = grp.fx || {};
    const col = 'beat' in set ? 0xff9a3c : 0x5ab8ff;
    const body = new THREE.Mesh(new THREE.BoxGeometry(len, thick, 0.16), std({ color: 0x3a3f4a, roughness: 0.5, metalness: 0.3 }));
    body.castShadow = body.receiveShadow = true;
    const top = new THREE.Mesh(new THREE.BoxGeometry(len * 0.92, 0.006, 0.14), std({ map: STRIPE_TEX, roughness: 0.6 }));
    top.position.y = thick / 2 + 0.003;
    const lampMat = std({ color: col, emissive: col, emissiveIntensity: 0.06, roughness: 0.3 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.014, 14, 10), lampMat);
    lamp.position.set(len * 0.3, 0, 0.082);
    const lever = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.06, 10), MAT.rail);
    stick.position.y = 0.03;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.013, 14, 10), std({ color: 0xd8312a, roughness: 0.35 }));
    knob.position.y = 0.06;
    lever.add(stick, knob);
    lever.rotation.x = Math.PI / 2 - 0.35; // pointing out of the front face, towards the camera
    const pivot = new THREE.Group();
    pivot.position.set(-len * 0.12, 0, 0.08);
    pivot.add(lever);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.006), std({ color: 0x9aa3ad, metalness: 0.7, roughness: 0.35 }));
    plate.position.set(-len * 0.12, 0, 0.081);
    group.add(body, top, lamp, plate, pivot);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, n, new THREE.Vector3(0, 0, 1)));
    group.userData.switch = { lever: pivot, lampMat };
  } else if (hit.type === 'key' || hit.type === 'bar' || hit.type === 'chime' || hit.type === 'epiano') {
    // a chunky slab with a bright coloured top; a chord = several coloured strips side by side
    const keys = pitched.length ? pitched : [{ midi: hit.midi }];
    const W = 0.14, w = W / keys.length, cap = 0.014;
    const ep = hit.type === 'epiano';
    const body = new THREE.Mesh(new THREE.BoxGeometry(len, thick - cap, W), ep ? EPIANO_BODY : themeOf(lane).body);
    body.position.y = -cap / 2;
    body.castShadow = body.receiveShadow = true;
    group.add(body);
    keys.forEach((nt, j) => {
      const c = pitchColor(nt.midi);
      // (e-piano keys are cream ivory that glow in their note's colour when played)
      const mat = std({ color: ep ? 0xf2e6c8 : c, roughness: 0.4, emissive: c, emissiveIntensity: 0 });
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

/** Everything for one song's course, built off-screen (shown by showScene). */
function buildScene(plan, signTitle) {
  const world = new THREE.Group(), pads = [], marbles = [];
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
    const sign = theme.sign(plan.seam.plate.w, plan.seam.plate.h, signTitle);
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
  const anims = theme.decorate({ rng, area: wallW * wallH * parseFloat($('deco').value), place, free, mark, add: (m) => world.add(m), bounds: { x0, x1, y0: yBot, y1: yTop } });

  // lanes
  const pipeMat = std({ color: theme.pipe, roughness: 0.35, metalness: 0.1 });
  for (const lane of plan.lanes) {
    lane.hits.forEach((h, i) => {
      const m = padMesh(h, lane, lane.groups[i]);
      const c = m.userData.base.clone().addScaledVector(m.userData.n, -padShape(h.type, h.midi, h.scale).thick / 2);
      if (!WALL_MOUNTED.has(h.type)) world.add(bracket(c.x, c.y, lane.z - 0.02, themeOf(lane).bracket));
      world.add(m);
      pads.push(m);
    });
    for (const r of lane.rails) world.add(...railMeshes(r, lane));
    for (const st of lane.stubs) world.add(...stubMeshes(st, lane, pipeMat));
    const marble = new THREE.Mesh(new THREE.SphereGeometry(MARBLE_R, 32, 24), themeOf(lane).marble);
    marble.castShadow = true;
    world.add(marble);
    marbles.push(marble);
  }
  return { world, pads, marbles, anims };
}

function showScene(sc) {
  disposeWorld();
  ({ world, pads, marbles, anims } = sc);
  scene.add(world);
}

// ------------------------------------------------------------------ song loading
// Planning runs in a worker so the page stays responsive and the spinner can show progress. A
// second worker plans the next song in endless mode while the current one plays.
function showPlanning(text, frac) {
  $('planning').classList.add('on');
  $('planningText').textContent = text;
  $('planningBar').style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}
function hidePlanning() { $('planning').classList.remove('on'); }

function makePlanner() {
  let worker = null, id = 0;
  return {
    busy: false,
    cancel() { if (worker) { worker.terminate(); worker = null; } id++; this.busy = false; },
    plan(parts, options, onProgress = () => {}) {
      const my = ++id;
      this.busy = true;
      const done = (f) => (x) => { if (my === id) this.busy = false; f(x); };
      return new Promise((res, rej) => {
        const resolve = done(res), reject = done(rej);
        const fallback = () => { // no worker (old browser / file://): plan here instead
          try { resolve(planCourse(parts, options)); } catch (e) { reject(e); }
        };
        if (params.has('shot')) return fallback(); // screenshot mode: plan synchronously (deterministic capture)
        if (!worker) {
          try { worker = new Worker(new URL(`./plan-worker.js?v=${window.APP_VERSION || ''}`, import.meta.url), { type: 'module' }); }
          catch { worker = null; return fallback(); }
        }
        const w = worker;
        w.onmessage = (e) => {
          if (e.data.id !== my) return; // an older request: ignore
          if (e.data.progress) return onProgress(e.data.progress);
          if (e.data.error) return reject(new Error(e.data.error));
          resolve(rehydratePlan(e.data.plan));
        };
        w.onerror = (e) => { e.preventDefault?.(); w.terminate(); if (worker === w) worker = null; fallback(); };
        w.postMessage({ id: my, parts, options });
      });
    },
  };
}
const mainPlanner = makePlanner(), nextPlanner = makePlanner();

/** A song, split between the marbles and given its objects (and, for lofi, its switch blocks). */
function prepareSong(key, seed) {
  let song;
  if (key === 'proc') song = generateSong(seed);
  else if (key === 'lofi' || key === 'endless') song = generateLofi(seed);
  else if (key === 'midi' && customMidi) song = customMidi;
  else song = buildSong(key);
  let truncated = false;
  const split = splitParts(song.notes, { second: $('second').value });
  const parts = split.parts.map((p) => {
    const g = groupNotes(p.notes, { maxGroups: 500 });
    truncated ||= g.truncated;
    return { ...p, groups: g.groups };
  });
  // what each marble hits: chosen per marble, or mixed by song section
  // ("one per song": the seed picks it, so in endless mode every new song has a new lead instrument)
  const melody = $('melodyObj').value === 'song' ? instrumentForSong(seed, !!song.lofi) : $('melodyObj').value;
  assignObjects(parts, { melody, harmony: $('harmonyObj').value, drums: $('drumKit').value,
    seed, bpm: song.bpm || 120, bar: song.bar || 4, lofi: !!song.lofi });
  if (song.fx) attachSwitches(parts, song.fx);
  return { song, parts, split, truncated, seed, key };
}

/** A planned song as a timeline item: its hits, background beat and switch blocks in loop time. */
function songItem(prep, plan) {
  const { song } = prep;
  const tauOf = (t) => plan.offset + t - plan.g0;
  const events = plan.lanes.flatMap((l) => l.groups.map((g) => ({ notes: g.notes, role: l.role, obj: g.obj, fx: g.fx, tau: tauOf(g.t) })));
  events.sort((a, b) => a.tau - b.tau);
  const fx = events.filter((e) => e.fx).map((e) => ({ tau: e.tau, set: e.fx }));
  const beat = (song.beat || []).map((n) => ({ ...n, tau: tauOf(n.t) })).filter((n) => n.tau >= 0 && n.tau < plan.D);
  const title = prep.key === 'endless' ? 'lofi radio ∞' : song.lofi ? song.name.replace(/^.*— /, '') : song.name.replace(/ —.*/, '');
  return { ...prep, plan, D: plan.D, events, fx, beat, initial: song.initial || {}, lofi: !!song.lofi, title, scene: null, start: 0, reps: Infinity };
}

const planOptions = (seed) => ({ seed, vMax: parseFloat($('pace').value) || 2.3 });

async function loadSong() {
  const key = $('song').value;
  const seed = parseInt($('seed').value, 10) || 0;
  const prep = prepareSong(key, seed);
  // a newer request replaces whatever is planning (and any endless prefetch)
  mainPlanner.cancel();
  nextPlanner.cancel();
  const name = prep.song.name.replace(/ —.*/, '');
  showPlanning(`Planning ${name}…`, 0);
  let newPlan;
  try {
    newPlan = await mainPlanner.plan(prep.parts, planOptions(seed), (p) =>
      showPlanning(`Planning ${p.name.toLowerCase()} (${p.lane + 1} of ${p.lanes})…`, (p.lane + p.done) / p.lanes));
  } catch (e) {
    if (mainPlanner.busy === false && $('song').value === key) { hidePlanning(); $('info').textContent = `Error: ${e.message}`; }
    throw e;
  }
  if ($('song').value !== key || (parseInt($('seed').value, 10) || 0) !== seed) return; // superseded
  items = [songItem(prep, newPlan)];
  active = null;
  hidePlanning();
  activate(items[0]);
  restart();
}

/** Put an item's course on screen (building it if it wasn't built ahead). */
function activate(item) {
  active = item;
  plan = item.plan;
  currentSong = item.song;
  showScene(item.scene || (item.scene = buildScene(item.plan, item.title)));
  showInfo(item);
}

function showInfo(item) {
  const { plan, song, split, truncated } = item;
  const laneInfo = plan.lanes.map((l) => `<span style="color:${themeOf(l).dot}">●</span> ${l.name} ${l.hits.length} (${themeOf(l).name} track)`).join(' &nbsp;');
  const muted = split.muted.length ? `<br><span style="color:#9aa0c0">${split.muted.length} drum notes muted — set Second marble to Percussion to hear them</span>` : '';
  const endless = item.key === 'endless' ? `<br><span style="color:#c9b8ff">Endless lofi · song ${item.seed - (parseInt($('seed').value, 10) || 0) + 1}${nextPlanner.busy ? ' · composing the next one…' : items[items.length - 1] !== item ? ' · next song ready' : ''}</span>` : '';
  const lofi = item.lofi ? ` · ${song.bpm} bpm · ${item.fx.length} switch blocks` : '';
  $('info').innerHTML = `<b style="color:#e8eaf6">${song.name}</b><br>${laneInfo}<br>${plan.D.toFixed(1)}s seamless loop${lofi}` + muted + endless +
    (truncated ? '<br><span style="color:#ffb347">Song truncated to fit.</span>' : '');
}

/** Endless mode: once the last song is under way, compose and plan the next one; it starts at a loop seam. */
function endlessTick(t) {
  const last = items[items.length - 1];
  if (!last || last.key !== 'endless' || nextPlanner.busy || !synth) return;
  if (last.reps !== Infinity) return; // already has a successor
  if (t - last.start < 0.4 * last.D) return; // not yet: generate it as this one heads to its end
  const prep = prepareSong('endless', last.seed + 1);
  const forItems = items;
  nextPlanner.plan(prep.parts, planOptions(prep.seed)).then((p) => {
    if (items !== forItems) return; // the user loaded something else meanwhile
    const next = songItem(prep, p);
    next.scene = buildScene(next.plan, next.title);
    const now = synth.ctx.currentTime - startTime;
    appendItem(items, next, Math.max(now + 0.5, last.start + last.D * 0.999));
    showInfo(active);
  }).catch((e) => { if (items === forItems) console.warn('next song failed to plan', e); });
  showInfo(active);
}

function restart() {
  if (!synth) return;
  startTime = synth.ctx.currentTime + 0.1; // the loop starts at the seam
  schedAbs = synth.ctx.currentTime - startTime;
  for (const it of items) it.start = it === items[0] ? 0 : it.start; // (only ever called with one item)
}

/** The lofi master effects at a moment: the item's switch settings (if switch effects are on). */
function applyFx(set, at, item) {
  const fxOn = $('lofiFx').checked;
  if ('filter' in set) synth.setFilter(fxOn && !!set.filter, at);
  if ('crackle' in set) synth.setCrackle(fxOn && !!set.crackle, at);
}

function pumpAudio() {
  const now = synth.ctx.currentTime - startTime;
  const until = now + 0.25;
  const from = Math.max(schedAbs, now);
  for (const ev of collect(items, from, until)) {
    const at = startTime + ev.at;
    if (ev.kind === 'hit') synth.playHit(ev.event.notes, at, ev.event.role, ev.event.obj);
    else if (ev.kind === 'beat') synth.playBeat(ev.note, at);
    else if (ev.kind === 'fx') applyFx(ev.set, at, ev.item);
    else if (ev.kind === 'start') { // each time round: the song's own starting state
      synth.setLofi(ev.item.lofi, at);
      applyFx({ filter: false, crackle: false, ...ev.item.initial }, at, ev.item);
    }
  }
  schedAbs = until;
}

// ?t=12.5 freezes the preview at that loop time (handy for screenshots); ?cam=, ?song=, ?seed=, ...
const params = new URLSearchParams(location.search);
for (const k of ['cam', 'song', 'seed', 'second', 'pace', 'theme', 'melodyObj', 'harmonyObj', 'drumKit', 'zoom', 'bright', 'glow', 'deco']) if (params.get(k)) $(k).value = params.get(k);
if (params.has('shot')) for (const id of ['start', 'panel', 'toggle']) $(id).style.display = 'none';
if (['lofi', 'endless'].includes($('song').value) && !params.get('theme')) $('theme').value = 'lofi';

/** Where the timeline is now: { item, tau } (or the frozen ?t= time before audio starts). */
function now() {
  if (!synth) return { item: items[0], tau: params.has('t') ? Math.min(parseFloat(params.get('t')), items[0].D - 1e-6) : 0, t: 0 };
  const t = synth.ctx.currentTime - startTime - synth.latency;
  return { ...itemAt(items, Math.max(0, t)), t };
}

// ------------------------------------------------------------------ animation
let lastTau = 0, lastFrame = performance.now();

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  lastFrame = nowMs;
  if (!items.length || !marbles.length) return;
  if (playing) pumpAudio();
  const cur = now();
  if (cur.item !== active) { // endless: the next song starts at the seam
    activate(cur.item);
    items = items.filter((it) => it.start + it.reps * it.D > cur.t - 1); // forget songs that have finished
  }
  endlessTick(cur.t);
  const tau = cur.tau;
  // the switch blocks' state right now: a muffled picture while the filter is closed
  const st = settingsAt(active, tau);
  renderer.domElement.classList.toggle('muffled', !!st.filter && $('lofiFx').checked);
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
    for (const m of u.mats) m.emissiveIntensity = f * (u.tube ? 1.2 : u.bamboo ? 1.4 : 0.5);
    // a struck pad dips slightly (a wall-mounted tube doesn't move)
    if (!u.bamboo) p.position.copy(u.base).addScaledVector(u.n, on ? -Math.exp(-dh * 20) * 0.012 : 0);
    if (u.button) { // the cap presses in and the button flashes bright (bloom picks it up)
      const fl = on ? Math.exp(-dh * 6) : 0;
      u.button.capMat.emissiveIntensity = 0.15 + 3.5 * fl;
      u.button.ringMat.emissiveIntensity = 0.2 + 2.5 * fl;
      u.button.cap.position.y = padShape('button', 0).thick / 4 - (on ? 0.012 * Math.exp(-dh * 25) : 0);
    }
    if (u.neon) { // idles at a soft glow, flares (with a flicker) when hit
      const fl = on ? Math.exp(-dh * 5) : 0;
      u.neon.glowMat.emissiveIntensity = 0.75 + 2.2 * fl * (0.85 + 0.15 * Math.sin(dh * 90));
    }
    if (u.bottle) { // the water sloshes
      u.bottle.waterPivot.rotation.x = u.bottle.rest + (on ? 0.35 * Math.exp(-dh * 4) * Math.sin(dh * 16) : 0);
    }
    if (u.swing) { // bells swing on their mounting
      const w = on ? 0.12 * Math.exp(-dh * 2.5) * Math.sin(dh * 12) : 0;
      p.quaternion.copy(u.baseQ).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), w));
    }
    if (u.guitar) { // the strings twang: a quick, fading vibration (pushed down first by the marble)
      for (const st of u.guitar.strings) {
        const amp = on ? 0.009 * Math.exp(-dh * 5) : 0;
        setString(st, -amp * Math.cos(dh * 95 + st.phase * Math.min(1, dh * 20)));
      }
    }
    if (u.vinyl) { // the record turns (and gets a spin when hit)
      u.vinyl.disc.rotation.y = -tau * 3.4 - (dh >= 0 ? 2.5 * (1 - Math.exp(-dh * 3)) : 0);
    }
    if (u.switch) { // the lever is thrown when the marble hits it; the lamp shows the new state
      const k = dh < 0 ? 0 : Math.min(1, dh / 0.12);
      u.switch.lever.rotation.z = 0.55 * (1 - 2 * k * k * (3 - 2 * k));
      u.switch.lampMat.emissiveIntensity = dh >= 0 ? 0.4 + 2.5 * Math.exp(-dh * 4) : 0.06;
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
  const pose = cameraPose(plan, tau, camera.aspect, { zoom: parseFloat($('zoom').value) });
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
  applySettings();
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
$('song').addEventListener('change', () => { // lofi songs start in the cozy theme (change it after if you like)
  if (['lofi', 'endless'].includes($('song').value) && $('theme').value !== 'lofi') { $('theme').value = 'lofi'; applyTheme(); }
});
const rebuild = () => { if (!active) return; for (const it of items) it.scene = null; activate(active); };
$('theme').addEventListener('change', () => { applyTheme(); rebuild(); });
$('deco').addEventListener('change', rebuild);
for (const id of ['bright', 'glow', 'volume', 'zoom']) $(id).addEventListener('input', applySettings);
$('lofiFx').addEventListener('change', () => { // apply now, not at the next switch block
  if (!synth || !active) return;
  const s = settingsAt(active, now().tau);
  applyFx({ filter: !!s.filter, crackle: !!s.crackle }, synth.ctx.currentTime, active);
});
$('second').addEventListener('change', loadSong);
$('pace').addEventListener('change', loadSong);
$('melodyObj').addEventListener('change', loadSong);
$('harmonyObj').addEventListener('change', loadSong);
$('drumKit').addEventListener('change', loadSong);
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
