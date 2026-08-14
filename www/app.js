/* =========================================================
   Stickman Ragdoll — verlet physics + dance/pose/emote demo
   No external libraries. Pure canvas + JS.
   ========================================================= */

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------
// Global state
// ---------------------------------------------------------
const state = {
  gravity: 1,
  neverTouch: false,
  count: 3,
  tab: 'dance',
  style: { emote: 'Wave', dance: 'Bounce', pose: 'TPose' },
  beat: 0,        // 0..1 pulsing value driven by music or fallback clock
  beatClock: 0,
};

let ragdolls = [];
let W = () => window.innerWidth;
let H = () => window.innerHeight;
const FLOOR_MARGIN = 40;

// ---------------------------------------------------------
// Verlet primitives
// ---------------------------------------------------------
class Point {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.ox = x; this.oy = y;
    this.pinned = false;
  }
}
class Stick {
  constructor(p0, p1, stiffness = 1) {
    this.p0 = p0; this.p1 = p1;
    this.len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    this.stiffness = stiffness;
  }
}

const BONE_NAMES = [
  'head', 'neck', 'hip',
  'lElbow', 'lHand', 'rElbow', 'rHand',
  'lKnee', 'lFoot', 'rKnee', 'rFoot'
];

function makeRagdoll(x, y, color) {
  const pts = {};
  pts.head   = new Point(x, y);
  pts.neck   = new Point(x, y + 22);
  pts.hip    = new Point(x, y + 70);
  pts.lElbow = new Point(x - 22, y + 34);
  pts.lHand  = new Point(x - 38, y + 50);
  pts.rElbow = new Point(x + 22, y + 34);
  pts.rHand  = new Point(x + 38, y + 50);
  pts.lKnee  = new Point(x - 14, y + 108);
  pts.lFoot  = new Point(x - 18, y + 146);
  pts.rKnee  = new Point(x + 14, y + 108);
  pts.rFoot  = new Point(x + 18, y + 146);

  const bones = [
    new Stick(pts.head, pts.neck),
    new Stick(pts.neck, pts.hip),
    new Stick(pts.neck, pts.lElbow),
    new Stick(pts.lElbow, pts.lHand),
    new Stick(pts.neck, pts.rElbow),
    new Stick(pts.rElbow, pts.rHand),
    new Stick(pts.hip, pts.lKnee),
    new Stick(pts.lKnee, pts.lFoot),
    new Stick(pts.hip, pts.rKnee),
    new Stick(pts.rKnee, pts.rFoot),
    // light stabilizers so limbs don't flop through the torso
    new Stick(pts.head, pts.hip, 0.15),
  ];

  return {
    id: Math.random().toString(36).slice(2),
    pts, bones, color,
    mode: 'dance',
    style: state.style.dance,
    phase: Math.random() * Math.PI * 2,
    speed: 0.9 + Math.random() * 0.4,
    emoteStart: 0,
    poseHold: 0,
  };
}

function spawnRagdolls(n) {
  ragdolls = [];
  const colors = ['#ffffff', '#d8d8d8', '#b9c2e0', '#e7e7e7', '#c9cfe8'];
  const spacing = Math.min(140, (W() - 80) / Math.max(n, 1));
  const startX = W() / 2 - (spacing * (n - 1)) / 2;
  for (let i = 0; i < n; i++) {
    const rd = makeRagdoll(startX + i * spacing, H() * 0.35, colors[i % colors.length]);
    rd.mode = state.tab === 'options' ? 'dance' : state.tab;
    rd.style = state.style[rd.mode] || 'Bounce';
    ragdolls.push(rd);
  }
}

// ---------------------------------------------------------
// Physics step
// ---------------------------------------------------------
function integrate(pts, damping) {
  for (const key in pts) {
    const p = pts[key];
    if (p.pinned) continue;
    const vx = (p.x - p.ox) * damping;
    const vy = (p.y - p.oy) * damping;
    p.ox = p.x; p.oy = p.y;
    p.x += vx;
    p.y += vy + state.gravity * 0.9;
  }
}

function satisfyBones(bones, iterations) {
  for (let it = 0; it < iterations; it++) {
    for (const b of bones) {
      const dx = b.p1.x - b.p0.x;
      const dy = b.p1.y - b.p0.y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      const diff = (dist - b.len) / dist;
      const factor = 0.5 * b.stiffness;
      const ox = dx * diff * factor;
      const oy = dy * diff * factor;
      if (!b.p0.pinned) { b.p0.x += ox; b.p0.y += oy; }
      if (!b.p1.pinned) { b.p1.x -= ox; b.p1.y -= oy; }
    }
  }
}

function constrainToWorld(pts) {
  const floorY = H() - FLOOR_MARGIN;
  for (const key in pts) {
    const p = pts[key];
    const bounce = 0.35;
    if (p.y > floorY) {
      const vy = (p.y - p.oy) * bounce;
      p.y = floorY;
      p.oy = p.y + vy;
    }
    if (p.x < 12) { p.ox = p.x + (p.x - p.ox) * 0.3; p.x = 12; }
    if (p.x > W() - 12) { p.ox = p.x + (p.x - p.ox) * 0.3; p.x = W() - 12; }
  }
}

function resolveInterRagdollCollisions() {
  if (state.neverTouch) return; // ghost mode: skip collisions between figures
  const R = 12;
  for (let i = 0; i < ragdolls.length; i++) {
    for (let j = i + 1; j < ragdolls.length; j++) {
      const a = ragdolls[i].pts, b = ragdolls[j].pts;
      for (const ka in a) {
        for (const kb in b) {
          const p0 = a[ka], p1 = b[kb];
          const dx = p1.x - p0.x, dy = p1.y - p0.y;
          const dist = Math.hypot(dx, dy) || 0.0001;
          const minDist = R * 2;
          if (dist < minDist) {
            const diff = (minDist - dist) / dist * 0.5;
            const ox = dx * diff, oy = dy * diff;
            if (!p0.pinned) { p0.x -= ox; p0.y -= oy; }
            if (!p1.pinned) { p1.x += ox; p1.y += oy; }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------
// Behaviors: dance / pose / emote
// ---------------------------------------------------------
function applyDance(rd, t) {
  const beat = state.beat;
  const amp = 10 + beat * 26;
  const speed = rd.speed;
  const s = rd.style;

  const swing = Math.sin(t * speed * 4 + rd.phase);
  const swingOpp = Math.sin(t * speed * 4 + rd.phase + Math.PI);

  if (s === 'Bounce') {
    rd.pts.hip.y += Math.sin(t * speed * 6 + rd.phase) * (0.6 + beat * 1.2);
    rd.pts.lHand.x += swing * amp * 0.03;
    rd.pts.lHand.y -= Math.abs(swing) * amp * 0.05;
    rd.pts.rHand.x += swingOpp * amp * 0.03;
    rd.pts.rHand.y -= Math.abs(swingOpp) * amp * 0.05;
  } else if (s === 'Robot') {
    const step = Math.floor(t * speed * 3) % 2 === 0 ? 1 : -1;
    rd.pts.lElbow.x += step * 0.6;
    rd.pts.rElbow.x -= step * 0.6;
    rd.pts.lHand.y -= 0.4;
    rd.pts.rHand.y -= 0.4;
    rd.pts.head.x += Math.sign(Math.sin(t * speed * 2)) * 0.15;
  } else if (s === 'Wiggle') {
    rd.pts.hip.x += swing * amp * 0.04;
    rd.pts.head.x -= swing * amp * 0.02;
    rd.pts.lFoot.x -= swing * amp * 0.02;
    rd.pts.rFoot.x += swing * amp * 0.02;
  } else { // Freestyle
    rd.pts.lHand.x += Math.sin(t * 3.1 + rd.phase) * amp * 0.03;
    rd.pts.lHand.y += Math.cos(t * 2.3 + rd.phase) * amp * 0.03;
    rd.pts.rHand.x += Math.cos(t * 2.7 + rd.phase) * amp * 0.03;
    rd.pts.rHand.y += Math.sin(t * 3.4 + rd.phase) * amp * 0.03;
    rd.pts.hip.y += Math.sin(t * speed * 5 + rd.phase) * (0.5 + beat);
  }
}

const POSE_TARGETS = {
  TPose:     { lHand: [-58, 0], rHand: [58, 0], lFoot: [-16, 76], rFoot: [16, 76] },
  SitDown:   { lHand: [-30, 30], rHand: [30, 30], lFoot: [-30, 30], rFoot: [30, 30] },
  Superhero: { lHand: [-14, -40], rHand: [46, -6], lFoot: [-20, 76], rFoot: [16, 76] },
  Relaxed:   { lHand: [-30, 46], rHand: [30, 46], lFoot: [-18, 76], rFoot: [18, 76] },
};
function applyPose(rd) {
  const target = POSE_TARGETS[rd.style] || POSE_TARGETS.TPose;
  const anchor = rd.pts.neck;
  const pull = 0.06;
  for (const key of ['lHand', 'rHand', 'lFoot', 'rFoot']) {
    const p = rd.pts[key];
    const base = key.includes('Foot') ? rd.pts.hip : anchor;
    const [ox, oy] = target[key];
    const tx = base.x + ox, ty = base.y + oy;
    p.x += (tx - p.x) * pull;
    p.y += (ty - p.y) * pull;
  }
}

function applyEmote(rd, t) {
  const el = t - rd.emoteStart;
  const s = rd.style;
  if (s === 'Wave' && el < 1.6) {
    rd.pts.rHand.x = rd.pts.rElbow.x + 28 * Math.sin(el * 10);
    rd.pts.rHand.y = rd.pts.rElbow.y - 34;
  } else if (s === 'Jump' && el < 0.9) {
    const impulse = Math.sin(el * Math.PI) * 5;
    for (const k in rd.pts) rd.pts[k].oy += impulse * 0.4;
  } else if (s === 'Spin' && el < 1.2) {
    const cx = rd.pts.hip.x, cy = rd.pts.hip.y;
    const ang = el * 8;
    for (const k in rd.pts) {
      const p = rd.pts[k];
      const dx = p.x - cx, dy = p.y - cy;
      p.x = cx + dx * Math.cos(0.05) - dy * Math.sin(0.05);
      p.y = cy + dx * Math.sin(0.05) + dy * Math.cos(0.05);
    }
  } else if (s === 'Clap' && el < 1.4) {
    const close = (Math.sin(el * 12) + 1) / 2;
    rd.pts.lHand.x = rd.pts.neck.x - 6 - close * 20;
    rd.pts.rHand.x = rd.pts.neck.x + 6 + close * 20;
    rd.pts.lHand.y = rd.pts.rHand.y = rd.pts.neck.y + 10;
  } else if (el > 2.2) {
    rd.mode = 'idle';
  }
}

// ---------------------------------------------------------
// Main loop
// ---------------------------------------------------------
let lastTime = performance.now();
let clock = 0;

function frame(now) {
  const dt = Math.min((now - lastTime) / 16.67, 2);
  lastTime = now;
  clock += 0.016 * dt;

  updateBeat();

  for (const rd of ragdolls) {
    integrate(rd.pts, 0.985);

    if (rd.mode === 'dance') applyDance(rd, clock);
    else if (rd.mode === 'pose') applyPose(rd);
    else if (rd.mode === 'emote') applyEmote(rd, clock);

    satisfyBones(rd.bones, 6);
    constrainToWorld(rd.pts);
  }
  resolveInterRagdollCollisions();
  for (const rd of ragdolls) satisfyBones(rd.bones, 2);

  render();
  requestAnimationFrame(frame);
}

function render() {
  ctx.clearRect(0, 0, W(), H());
  for (const rd of ragdolls) drawRagdoll(rd);
}

function drawRagdoll(rd) {
  ctx.save();
  ctx.strokeStyle = rd.color;
  ctx.fillStyle = rd.color;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 4;

  for (const b of rd.bones) {
    if (b.stiffness < 0.5) continue; // skip drawing the stabilizer bone
    ctx.beginPath();
    ctx.moveTo(b.p0.x, b.p0.y);
    ctx.lineTo(b.p1.x, b.p1.y);
    ctx.stroke();
  }
  // head
  ctx.beginPath();
  ctx.arc(rd.pts.head.x, rd.pts.head.y, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------
// Music: file picker + Web Audio amplitude analysis
// ---------------------------------------------------------
let audioCtx = null, analyser = null, sourceNode = null, audioEl = null, freqData = null;

function setupAudio(file) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioEl) { audioEl.pause(); audioEl.src = ''; }

  audioEl = new Audio();
  audioEl.src = URL.createObjectURL(file);
  audioEl.loop = true;
  audioEl.volume = parseFloat(document.getElementById('volumeSlider').value);

  if (sourceNode) sourceNode.disconnect();
  sourceNode = audioCtx.createMediaElementSource(audioEl);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  freqData = new Uint8Array(analyser.frequencyBinCount);
  sourceNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  document.getElementById('musicName').textContent = file.name;
  audioEl.play();
  document.getElementById('playPauseBtn').textContent = '⏸';
}

function updateBeat() {
  if (analyser) {
    analyser.getByteFrequencyData(freqData);
    // weight lower frequencies (bass) more heavily to approximate a beat
    let sum = 0, weight = 0;
    for (let i = 0; i < 24; i++) {
      const w = 24 - i;
      sum += freqData[i] * w;
      weight += w;
    }
    const level = sum / weight / 255;
    state.beat += (level - state.beat) * 0.35;
  } else {
    // fallback: gentle synthetic pulse so dancing still looks alive without music
    state.beatClock += 0.05;
    state.beat = (Math.sin(state.beatClock) + 1) / 2 * 0.5;
  }
}

// ---------------------------------------------------------
// UI wiring
// ---------------------------------------------------------
const CHIPS = {
  emote: ['Wave', 'Jump', 'Spin', 'Clap'],
  dance: ['Bounce', 'Robot', 'Wiggle', 'Freestyle'],
  pose:  ['TPose', 'SitDown', 'Superhero', 'Relaxed'],
};

function renderChips() {
  const row = document.getElementById('chipRow');
  row.innerHTML = '';
  const list = CHIPS[state.tab];
  if (!list) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  for (const name of list) {
    const btn = document.createElement('button');
    btn.className = 'chip' + (state.style[state.tab] === name ? ' active' : '');
    btn.textContent = name.replace(/([A-Z])/g, ' $1').trim();
    btn.onclick = () => {
      state.style[state.tab] = name;
      applyModeToAll();
      renderChips();
    };
    row.appendChild(btn);
  }
}

function applyModeToAll() {
  for (const rd of ragdolls) {
    if (state.tab === 'options') continue;
    rd.mode = state.tab;
    rd.style = state.style[state.tab];
    if (state.tab === 'emote') rd.emoteStart = clock;
  }
}

document.getElementById('tabBar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  state.tab = btn.dataset.tab;

  document.getElementById('countPanel').style.display = state.tab === 'options' ? 'none' : 'block';
  document.getElementById('optionsPanel').style.display = state.tab === 'options' ? 'block' : 'none';

  renderChips();
  applyModeToAll();
});

document.getElementById('countSlider').addEventListener('input', (e) => {
  state.count = parseInt(e.target.value, 10);
  document.getElementById('countValue').textContent = state.count;
  spawnRagdolls(state.count);
});

document.getElementById('neverTouchBtn').addEventListener('click', () => {
  state.neverTouch = !state.neverTouch;
  const label = document.getElementById('neverTouchState');
  label.textContent = state.neverTouch ? 'ON' : 'OFF';
  document.getElementById('neverTouchBtn').classList.toggle('on', state.neverTouch);
});

document.getElementById('musicBtn').addEventListener('click', () => {
  document.getElementById('audioFileInput').click();
});
document.getElementById('audioFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) setupAudio(file);
});
document.getElementById('playPauseBtn').addEventListener('click', () => {
  if (!audioEl) return;
  if (audioEl.paused) { audioEl.play(); document.getElementById('playPauseBtn').textContent = '⏸'; }
  else { audioEl.pause(); document.getElementById('playPauseBtn').textContent = '▶'; }
});
document.getElementById('volumeSlider').addEventListener('input', (e) => {
  if (audioEl) audioEl.volume = parseFloat(e.target.value);
});
document.getElementById('gravitySlider').addEventListener('input', (e) => {
  state.gravity = parseFloat(e.target.value);
});

// ---------------------------------------------------------
// Boot
// ---------------------------------------------------------
renderChips();
spawnRagdolls(state.count);
requestAnimationFrame(frame);
