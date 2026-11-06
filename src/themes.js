// Visual themes: lighting, the wall, the seam sign (the plate behind the loop's pipe stubs) and
// decorations. Each theme's decorate() places things on the wall where the course leaves room
// and returns small animations (bobbing, flapping, flickering, blinking on the beat).
import * as THREE from 'three';
import { mulberry32 } from './util.js';

const std = (o) => new THREE.MeshStandardMaterial(o);
const UP = new THREE.Vector3(0, 1, 0);

function canvasTexture(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 8x8 pixel art ('#' filled) as a little voxel sprite. */
function pixelSprite(rows, color, px, { emissive = 0, depth = 0.6 } = {}) {
  const cells = [];
  rows.forEach((r, y) => [...r].forEach((ch, x) => ch === '#' && cells.push([x, rows.length - 1 - y])));
  const mat = std({ color, roughness: 0.6, emissive: emissive ? color : 0x000000, emissiveIntensity: emissive });
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(px * 0.94, px * 0.94, px * depth), mat, cells.length);
  const M = new THREE.Matrix4();
  cells.forEach(([x, y], i) => m.setMatrixAt(i, M.makeTranslation((x - 3.5) * px, (y - 3.5) * px, 0)));
  m.castShadow = true;
  return m;
}

/** The sign behind a seam stub: same everywhere, so the loop's first and last frames match. */
function signMesh(w, h, draw) {
  const tex = canvasTexture(1024, Math.round((1024 * h) / w), draw, false);
  const front = std({ map: tex, roughness: 0.8 });
  const side = std({ color: 0x777777, roughness: 0.8 });
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.02), [side, side, side, side, front, side]);
  m.receiveShadow = true;
  return m;
}
function fitText(g, text, maxW, size, weight = 'bold', family = 'system-ui, sans-serif') {
  let s = size;
  do { g.font = `${weight} ${s}px ${family}`; s -= 2; } while (g.measureText(text).width > maxW && s > 10);
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// ------------------------------------------------------------------ sky (the original look)
const SKY_SPRITES = {
  star: ['...##...', '...##...', '########', '.######.', '..####..', '.##..##.', '##....##', '........'],
  heart: ['.##..##.', '########', '########', '########', '.######.', '..####..', '...##...', '........'],
  note: ['....###.', '....#.##', '....#..#', '....#...', '.####...', '#####...', '.###....', '........'],
  gem: ['..####..', '.#....#.', '########', '.#.##.#.', '..#..#..', '...##...', '........', '........'],
};

function cloudMesh(rng, size, mat) {
  const g = new THREE.Group();
  const n = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const r = size * (0.32 + rng() * 0.25) * (i === 0 || i === n - 1 ? 0.75 : 1);
    const b = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat);
    b.position.set(((i / (n - 1)) - 0.5) * size * 1.5, (rng() - 0.3) * size * 0.25 + (i % 2) * size * 0.1, 0);
    b.scale.z = 0.45;
    b.castShadow = true;
    g.add(b);
  }
  return g;
}

function bentPipe(rng, color, len) {
  const mat = std({ color, roughness: 0.35, metalness: 0.05 });
  const a = rng() * Math.PI * 2, bend = (rng() - 0.5) * 1.6;
  const p3 = new THREE.Vector3(Math.cos(a) * len, Math.sin(a) * len, 0);
  const p1 = new THREE.Vector3(Math.cos(a + bend) * len * 0.45, Math.sin(a + bend) * len * 0.45, 0);
  const p2 = p3.clone().add(new THREE.Vector3(Math.cos(a + Math.PI - bend) * len * 0.45, Math.sin(a + Math.PI - bend) * len * 0.45, 0));
  const curve = new THREE.CubicBezierCurve3(new THREE.Vector3(), p1, p2, p3);
  const g = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.09, 16), mat);
  tube.castShadow = true;
  g.add(tube);
  for (const u of [0, 1]) {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 20), mat);
    rim.position.copy(curve.getPoint(u));
    rim.quaternion.setFromUnitVectors(UP, curve.getTangent(u));
    rim.castShadow = true;
    g.add(rim);
  }
  g.userData.points = curve.getPoints(20);
  return g;
}

const sky = {
  id: 'sky', name: 'Sky',
  background: 0x5f9fb0, exposure: 0.9, env: 0.45,
  hemi: [0xffffff, 0x5a8a98, 0.55], sun: [0xfff6e8, 1.9],
  pipe: 0x3fae4a,
  wall: () => ({ color: 0x4fb3c8, roughness: 0.95, map: canvasTexture(256, 256, (g) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256);
    const rng = mulberry32(5);
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `rgba(${rng() < 0.5 ? '255,255,255' : '0,40,60'},${0.02 + rng() * 0.03})`;
      g.fillRect(rng() * 256, rng() * 256, 1 + rng() * 2, 1 + rng() * 2);
    }
  }) }),
  sign: (w, h, title) => signMesh(w, h, (g, W, H) => {
    g.fillStyle = '#4fb3c8'; g.fillRect(0, 0, W, H);
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#e9f8fc'); sky.addColorStop(1, '#c6ebf4');
    g.fillStyle = sky; roundRect(g, 30, 30, W - 60, H - 60, 60); g.fill();
    g.lineWidth = 14; g.strokeStyle = '#2b7f95'; roundRect(g, 30, 30, W - 60, H - 60, 60); g.stroke();
    g.fillStyle = '#1d5566'; g.textAlign = 'center'; g.textBaseline = 'middle';
    fitText(g, title, W * 0.5, 64);
    g.fillText(title, W / 2, H * 0.33);
    g.fillStyle = '#ffb703';
    for (const [x, y] of [[90, 90], [W - 90, 90], [90, H - 90], [W - 90, H - 90]]) { g.beginPath(); g.arc(x, y, 18, 0, Math.PI * 2); g.fill(); }
  }),
  decorate(ctx) {
    const { rng, area, place, free, mark, add, bounds } = ctx;
    const cloudMat = std({ color: 0xffffff, roughness: 1 });
    for (let i = 0; i < area / 5; i++) {
      const size = 0.22 + rng() * 0.3, at = place(size * 0.9);
      if (!at) continue;
      const c = cloudMesh(rng, size, cloudMat);
      c.position.set(at.x, at.y, 0.05);
      add(c);
    }
    const colors = [0x3fae4a, 0xe0533d, 0xf2c230, 0x8e6cd8];
    for (let i = 0; i < area / 16; i++) {
      const p = bentPipe(rng, colors[i % colors.length], 0.8 + rng() * 0.8);
      for (let k = 0; k < 60; k++) {
        const x = bounds.x0 + 0.3 + rng() * (bounds.x1 - bounds.x0 - 0.6), y = bounds.y0 + 0.3 + rng() * (bounds.y1 - bounds.y0 - 0.6);
        if (p.userData.points.every((q) => free(x + q.x, y + q.y, 0.2))) {
          p.userData.points.forEach((q) => mark(x + q.x, y + q.y, 0.45));
          p.position.set(x, y, 0.1);
          add(p);
          break;
        }
      }
    }
    const anim = [], names = Object.keys(SKY_SPRITES), cols = [0xffd23f, 0xff6b6b, 0x7b6cff, 0x4cd964, 0xff9f43];
    for (let i = 0; i < area / 6; i++) {
      const at = place(0.2);
      if (!at) continue;
      const sp = pixelSprite(SKY_SPRITES[names[Math.floor(rng() * names.length)]], cols[Math.floor(rng() * cols.length)], 0.04);
      sp.position.set(at.x, at.y, 0.03);
      add(sp);
      const phase = rng() < 0.5 ? 0 : 0.5;
      anim.push((tau, beat) => { sp.position.y = at.y + 0.025 * Math.abs(Math.sin(Math.PI * (beat + phase))); });
    }
    return anim;
  },
};

// ------------------------------------------------------------------ spooky (purple, moonlit)
const SPOOKY_SPRITES = {
  ghost: ['..####..', '.######.', '##.##.##', '########', '########', '########', '#.##.##.', '........'],
  bat: ['........', '#......#', '##.##.##', '########', '.######.', '..#..#..', '........', '........'],
  pumpkin: ['...##...', '.######.', '########', '#.#..#.#', '########', '#.####.#', '.######.', '........'],
  skull: ['.######.', '########', '#..##..#', '#..##..#', '########', '.##..##.', '.#.##.#.', '........'],
};

const spooky = {
  id: 'spooky', name: 'Spooky',
  background: 0x120a1c, exposure: 0.95, env: 0.28, fog: [0x120a1c, 9, 32],
  hemi: [0x9a85e0, 0x1a0f26, 0.55], sun: [0xc9bfff, 1.5],
  pipe: 0x4b2a6e,
  wall: () => ({ color: 0xffffff, roughness: 0.95, map: canvasTexture(256, 256, (g) => {
    // purple stone blocks
    const rng = mulberry32(13);
    g.fillStyle = '#1c0f2a'; g.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 8; row++) for (let col = -1; col < 5; col++) {
      const x = col * 64 + (row % 2 ? 32 : 0), y = row * 32;
      const l = 22 + rng() * 10;
      g.fillStyle = `hsl(${268 + rng() * 14}, 32%, ${l}%)`;
      g.fillRect(x + 2, y + 2, 60, 28);
      for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(0,0,0,${rng() * 0.15})`; g.fillRect(x + 2 + rng() * 58, y + 2 + rng() * 26, 2, 2); }
    }
  }) }),
  sign: (w, h, title) => signMesh(w, h, (g, W, H) => {
    g.fillStyle = '#1a0d27'; g.fillRect(0, 0, W, H);
    const grad = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W / 1.6);
    grad.addColorStop(0, '#3a1f57'); grad.addColorStop(1, '#170b23');
    g.fillStyle = grad; roundRect(g, 26, 26, W - 52, H - 52, 30); g.fill();
    g.lineWidth = 10; g.strokeStyle = '#9b6cff'; g.shadowColor = '#b28cff'; g.shadowBlur = 30;
    roundRect(g, 26, 26, W - 52, H - 52, 30); g.stroke();
    g.shadowBlur = 40; g.shadowColor = '#ff9a3c';
    g.fillStyle = '#ffd7a8'; g.textAlign = 'center'; g.textBaseline = 'middle';
    fitText(g, title, W * 0.5, 64, 'bold', 'Georgia, serif');
    g.fillText(title, W / 2, H * 0.33);
    g.shadowBlur = 0;
  }),
  decorate(ctx) {
    const { rng, area, place, add } = ctx;
    const anim = [];
    // a moon or two
    for (let i = 0; i < Math.max(1, area / 60); i++) {
      const at = place(0.6);
      if (!at) continue;
      const moon = new THREE.Mesh(new THREE.CircleGeometry(0.45, 48), std({ color: 0xfff3c4, emissive: 0xfff0b0, emissiveIntensity: 0.55, roughness: 1 }));
      moon.position.set(at.x, at.y, 0.012);
      add(moon);
      for (let c = 0; c < 4; c++) {
        const cr = new THREE.Mesh(new THREE.CircleGeometry(0.05 + rng() * 0.07, 24), std({ color: 0xe8d9a0, emissive: 0xe8d9a0, emissiveIntensity: 0.3 }));
        cr.position.set(at.x + (rng() - 0.5) * 0.5, at.y + (rng() - 0.5) * 0.5, 0.014);
        if (Math.hypot(cr.position.x - at.x, cr.position.y - at.y) < 0.33) add(cr);
      }
    }
    for (let i = 0; i < area / 7; i++) {
      const at = place(0.2);
      if (!at) continue;
      const kind = ['ghost', 'bat', 'bat', 'pumpkin', 'skull'][Math.floor(rng() * 5)];
      const color = { ghost: 0xf2ecff, bat: 0x2a1a3a, pumpkin: 0xff7a1a, skull: 0xe8e2d0 }[kind];
      const sp = pixelSprite(SPOOKY_SPRITES[kind], color, 0.04, { emissive: kind === 'ghost' ? 0.25 : 0 });
      sp.position.set(at.x, at.y, 0.03);
      add(sp);
      const phase = rng() * Math.PI * 2;
      if (kind === 'ghost') anim.push((tau) => { sp.position.y = at.y + 0.04 * Math.sin(tau * 1.3 + phase); });
      if (kind === 'bat') anim.push((tau, beat) => { sp.scale.y = 0.7 + 0.3 * Math.abs(Math.cos(Math.PI * beat + phase)); });
      if (kind === 'pumpkin') { // a glowing face behind the carved holes
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.2), std({ color: 0xffc04a, emissive: 0xffa020, emissiveIntensity: 1.2 }));
        glow.position.set(at.x, at.y, 0.02);
        add(glow);
        anim.push((tau) => { glow.material.emissiveIntensity = 1 + 0.35 * Math.sin(tau * 9 + phase) * Math.sin(tau * 5.3); });
      }
    }
    // candles
    for (let i = 0; i < area / 14; i++) {
      const at = place(0.15);
      if (!at) continue;
      const wax = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.14, 12), std({ color: 0xf3ead2, roughness: 0.8 }));
      wax.position.set(at.x, at.y, 0.05);
      wax.castShadow = true;
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.04, 10), std({ color: 0xffd27a, emissive: 0xffa53a, emissiveIntensity: 2 }));
      flame.position.set(at.x, at.y + 0.095, 0.05);
      add(wax); add(flame);
      const phase = rng() * 10;
      anim.push((tau) => { const f = 0.85 + 0.15 * Math.sin(tau * 13 + phase) * Math.sin(tau * 7.7); flame.scale.set(1, f, 1); flame.material.emissiveIntensity = 1.6 + f; });
    }
    return anim;
  },
};

// ------------------------------------------------------------------ lab (clean white test lab)
const lab = {
  id: 'lab', name: 'Lab',
  background: 0xd9dee3, exposure: 1.0, env: 0.6,
  hemi: [0xffffff, 0xc3ccd6, 1.0], sun: [0xffffff, 1.6],
  pipe: 0xb9c0c8,
  wall: () => ({ color: 0xffffff, roughness: 0.6, map: canvasTexture(256, 256, (g) => {
    // 2 x 2 white panels per 1.5 m, with seams and screws
    g.fillStyle = '#9aa3ad'; g.fillRect(0, 0, 256, 256);
    for (const [x, y] of [[0, 0], [128, 0], [0, 128], [128, 128]]) {
      const grad = g.createLinearGradient(x, y, x + 128, y + 128);
      grad.addColorStop(0, '#f4f6f8'); grad.addColorStop(1, '#e3e7eb');
      g.fillStyle = grad; g.fillRect(x + 2, y + 2, 124, 124);
      g.fillStyle = '#b3bac2';
      for (const [sx, sy] of [[8, 8], [118, 8], [8, 118], [118, 118]]) { g.beginPath(); g.arc(x + sx, y + sy, 2.2, 0, Math.PI * 2); g.fill(); }
    }
  }) }),
  sign: (w, h, title) => signMesh(w, h, (g, W, H) => {
    g.fillStyle = '#f5f7f9'; g.fillRect(0, 0, W, H);
    const stripes = (y0, hh) => {
      g.save(); g.beginPath(); g.rect(0, y0, W, hh); g.clip();
      g.fillStyle = '#1f2328'; g.fillRect(0, y0, W, hh);
      g.fillStyle = '#ffc533';
      for (let x = -hh; x < W + hh; x += 60) { g.beginPath(); g.moveTo(x, y0 + hh); g.lineTo(x + 30, y0 + hh); g.lineTo(x + 30 + hh, y0); g.lineTo(x + hh, y0); g.fill(); }
      g.restore();
    };
    stripes(0, 44); stripes(H - 44, 44);
    g.fillStyle = '#1f2328'; g.textAlign = 'left'; g.textBaseline = 'middle';
    const x0 = W * 0.26;
    g.font = 'bold 26px system-ui, sans-serif';
    g.fillText('TEST RUN', x0, H * 0.27);
    fitText(g, title, W * 0.48, 56);
    g.fillText(title, x0, H * 0.34);
    g.fillStyle = '#2b9fd6'; g.fillRect(x0, H * 0.385, 120, 8);
  }),
  decorate(ctx) {
    const { rng, area, place, add } = ctx;
    const anim = [];
    const stripeTex = canvasTexture(128, 32, (g) => {
      g.fillStyle = '#1f2328'; g.fillRect(0, 0, 128, 32); g.fillStyle = '#ffc533';
      for (let x = -32; x < 160; x += 24) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 12, 32); g.lineTo(x + 44, 0); g.lineTo(x + 32, 0); g.fill(); }
    }, false);
    const ventTex = canvasTexture(128, 80, (g) => {
      g.fillStyle = '#c9cfd6'; g.fillRect(0, 0, 128, 80); g.fillStyle = '#5c6670';
      for (let y = 10; y < 72; y += 10) g.fillRect(10, y, 108, 5);
    }, false);
    const signs = ['↓', '!', '●→', '⟲'];
    for (let i = 0; i < area / 6; i++) {
      const r = rng();
      if (r < 0.3) { // light panel
        const at = place(0.4);
        if (!at) continue;
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.16, 0.025), std({ color: 0xffffff, emissive: 0xdff2ff, emissiveIntensity: 0.9 }));
        m.position.set(at.x, at.y, 0.013);
        add(m);
      } else if (r < 0.45) { // hazard plate
        const at = place(0.32);
        if (!at) continue;
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.012), std({ map: stripeTex, roughness: 0.7 }));
        m.position.set(at.x, at.y, 0.008);
        add(m);
      } else if (r < 0.65) { // indicator light, blinking on the beat
        const at = place(0.12);
        if (!at) continue;
        const col = [0x37c4ff, 0xffb020, 0x5be37d][Math.floor(rng() * 3)];
        const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 20), std({ color: 0x8c949c, metalness: 0.6, roughness: 0.4 }));
        housing.rotation.x = Math.PI / 2; housing.position.set(at.x, at.y, 0.01);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 10), std({ color: col, emissive: col, emissiveIntensity: 1 }));
        lamp.position.set(at.x, at.y, 0.025);
        add(housing); add(lamp);
        const every = 1 + Math.floor(rng() * 4), phase = Math.floor(rng() * every);
        anim.push((tau, beat) => { const on = Math.floor(beat) % every === phase; lamp.material.emissiveIntensity = on ? 1.6 * Math.max(0.2, 1 - (beat % 1) * 1.5) : 0.15; });
      } else if (r < 0.8) { // vent
        const at = place(0.28);
        if (!at) continue;
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.26, 0.02), std({ map: ventTex, roughness: 0.6, metalness: 0.2 }));
        m.position.set(at.x, at.y, 0.01);
        m.castShadow = true;
        add(m);
      } else { // pictogram sign
        const at = place(0.2);
        if (!at) continue;
        const glyph = signs[Math.floor(rng() * signs.length)];
        const tex = canvasTexture(128, 128, (g) => {
          g.fillStyle = '#1f2328'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#ffffff';
          g.font = 'bold 72px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(glyph, 64, 70);
        }, false);
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.012), std({ map: tex, roughness: 0.7 }));
        m.position.set(at.x, at.y, 0.008);
        add(m);
      }
    }
    return anim;
  },
};

export const THEMES = { sky, spooky, lab };
