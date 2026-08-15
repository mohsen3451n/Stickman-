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
window.addEventListener('resize', onResize);
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
  beat: 0,          // 0..1 pulsing value driven by music or fallback clock
  beatClock: 0,
  beatPulse: 0,     // sharp spike right on a detected hit, decays fast
  beatCount: 0,
  energy: 0.3,      // slow-moving overall loudness, 0..1
  tempo: 120,       // estimated BPM from the loaded track
  autoStyleTimer: 0,
};

let beatHistory = [];
let lastBeatTime = 0;
let bpmEstimate = 120;

let ragdolls = [];
let W = () => window.innerWidth;
let H = () => window.innerHeight;
const FLOOR_MARGIN = 40;
const WALL_MARGIN = 46; // how close a figure's hips get to the screen edge before it plants a hand and pushes off

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

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  return {
    id: Math.random().toString(36).slice(2),
    pts, bones, color,
    mode: 'dance',
    style: state.style.dance,
    phase: Math.random() * Math.PI * 2,
    speed: 0.85 + Math.random() * 0.35,
    emoteStart: 0,
    poseHold: 0,
    baseX: x, baseY: y + 70, // hip resting position, used as the dance anchor (fixed up below)
    vx: (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 30), // px/sec roaming speed
    walk: { state: 'walk', timer: 0, wallX: 0, dir: 1 },
    lens: {
      neck: dist(pts.head, pts.neck),
      spine: dist(pts.neck, pts.hip),
      upperArm: dist(pts.neck, pts.lElbow),
      foreArm: dist(pts.lElbow, pts.lHand),
      thigh: dist(pts.hip, pts.lKnee),
      shin: dist(pts.lKnee, pts.lFoot),
    },
  };
}



// Move a point toward a world-space target. Keeps a little bit of the
// point's momentum so it still has a soft, springy "ragdoll" feel instead
// of snapping rigidly to the pose every frame.
function driveToward(p, tx, ty, pull) {
  const nx = p.x + (tx - p.x) * pull;
  const ny = p.y + (ty - p.y) * pull;
  p.ox = p.x + (nx - p.x) * 0.55;
  p.oy = p.y + (ny - p.y) * 0.55;
  p.x = nx;
  p.y = ny;
}

function polar(origin, angle, len) {
  return { x: origin.x + Math.cos(angle) * len, y: origin.y + Math.sin(angle) * len };
}

// Two-bone inverse kinematics: given a hip position and a desired foot
// position, find where the knee needs to be so the foot actually reaches
// that spot (instead of guessing a fixed knee angle and hoping the foot
// lands near the floor). This is what lets feet stay planted on the
// ground during a dance instead of floating.
function solveKnee(hipX, hipY, footX, footY, thigh, shin, side) {
  const dx = footX - hipX, dy = footY - hipY;
  let dist = Math.hypot(dx, dy) || 0.0001;
  const maxDist = thigh + shin - 0.5;
  const minDist = Math.max(4, Math.abs(thigh - shin) + 0.5);
  if (dist > maxDist) dist = maxDist;
  if (dist < minDist) dist = minDist;
  const cosA = (thigh * thigh + dist * dist - shin * shin) / (2 * thigh * dist);
  const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const baseAngle = Math.atan2(dy, dx);
  const angle = baseAngle + side * a; // side: +1 left leg, -1 right leg
  return { x: hipX + Math.cos(angle) * thigh, y: hipY + Math.sin(angle) * thigh };
}

function spawnRagdolls(n) {
  ragdolls = [];
  const colors = ['#ffffff', '#d8d8d8', '#b9c2e0', '#e7e7e7', '#c9cfe8'];
  const spacing = Math.min(140, (W() - 80) / Math.max(n, 1));
  const startX = W() / 2 - (spacing * (n - 1)) / 2;
  for (let i = 0; i < n; i++) {
    const rd = makeRagdoll(startX + i * spacing, H() * 0.35, colors[i % colors.length]);
    groundRagdoll(rd);
    rd.mode = state.tab === 'options' ? 'dance' : state.tab;
    rd.style = state.style[rd.mode] || 'Bounce';
    ragdolls.push(rd);
  }
}

// Shifts a ragdoll vertically so its feet rest on the floor line (instead
// of floating at whatever arbitrary height it was created at), and records
// that height as its standing "home" position (rd.baseY) for dance/pose to
// return to. Called on spawn and again whenever the screen is resized.
function groundRagdoll(rd) {
  const floorY = H() - FLOOR_MARGIN;
  const legLen = rd.lens.thigh + rd.lens.shin;
  const standHipY = floorY - legLen * 0.94; // slightly bent knees, like a real stance
  const dy = standHipY - rd.pts.hip.y;
  for (const key in rd.pts) {
    rd.pts[key].y += dy;
    rd.pts[key].oy += dy;
  }
  rd.baseY = standHipY;
}

function onResize() {
  resize();
  for (const rd of ragdolls) groundRagdoll(rd);
}

// Free-roaming walk: the dancer's stance (baseX) actually drifts across
// the floor instead of staying pinned in one spot. When it reaches a
// wall it plants a hand, pushes off, and launches back the other way —
// state machine: 'walk' -> 'push' (braced against the wall) -> 'launch'
// (flung off, fast) -> back to 'walk'.
function updateLocomotion(rd, dtSec) {
  const leftWall = WALL_MARGIN, rightWall = W() - WALL_MARGIN;
  const walk = rd.walk;
  // Faster/louder song -> faster walking and a harder wall push.
  const moveMul = analyser
    ? Math.max(0.65, Math.min(2.0, (state.tempo / 120) * (0.7 + state.energy * 0.9)))
    : 1;

  if (walk.state === 'walk') {
    rd.baseX += rd.vx * moveMul * dtSec;
    if (rd.vx < 0 && rd.baseX <= leftWall) {
      rd.baseX = leftWall;
      walk.state = 'push'; walk.timer = 0;
      walk.wallX = leftWall - 30; walk.dir = 1;
    } else if (rd.vx > 0 && rd.baseX >= rightWall) {
      rd.baseX = rightWall;
      walk.state = 'push'; walk.timer = 0;
      walk.wallX = rightWall + 30; walk.dir = -1;
    }
  } else if (walk.state === 'push') {
    walk.timer += dtSec * Math.max(1, moveMul);
    if (walk.timer > 0.32) {
      walk.state = 'launch'; walk.timer = 0;
      rd.vx = walk.dir * (130 + Math.random() * 60) * Math.max(1, moveMul * 0.7); // flung off the wall, fast
    }
  } else if (walk.state === 'launch') {
    rd.baseX += rd.vx * dtSec;
    walk.timer += dtSec;
    rd.vx *= 0.97; // speed bleeds off after the launch
    if (rd.vx < 0 && rd.baseX <= leftWall) {
      rd.baseX = leftWall; walk.state = 'push'; walk.timer = 0;
      walk.wallX = leftWall - 30; walk.dir = 1;
    } else if (rd.vx > 0 && rd.baseX >= rightWall) {
      rd.baseX = rightWall; walk.state = 'push'; walk.timer = 0;
      walk.wallX = rightWall + 30; walk.dir = -1;
    } else if (walk.timer > 0.55) {
      walk.state = 'walk';
      const sign = Math.sign(rd.vx) || walk.dir;
      rd.vx = sign * Math.max(60, Math.min(Math.abs(rd.vx), 95)) * Math.max(1, moveMul);
    }
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
// Full-body kinematic dance driver. Every joint gets an explicit target
// position each frame (computed from time + music beat), and driveToward()
// eases the physical point toward it — big, clearly visible motion, with
// just enough spring left in the verlet solver for a soft ragdoll feel.
function applyDance(rd, t) {
  const beat = state.beat;
  const energy = 1.1 + beat * 1.5 + state.energy * 1.1; // punchier baseline, scales with the song's loudness
  // Movement tempo tracks the song's detected BPM when music is playing,
  // so limbs visibly move faster on a fast song and slower on a slow one.
  const tempoMul = analyser ? Math.max(0.6, Math.min(1.8, state.tempo / 120)) : 1;
  const speed = rd.speed * tempoMul;
  const ph = rd.phase;
  const s = rd.style;
  const L = rd.lens;
  const w = t * speed + ph;

  const floorY = H() - FLOOR_MARGIN;
  const stance = 20; // half distance between the feet when standing
  const walk = rd.walk;
  const moveLean = Math.max(-1, Math.min(1, rd.vx / 90)) * 0.16; // lean slightly into the direction of travel while walking

  let hipX = rd.baseX, hipY = rd.baseY;
  let leanAngle = -Math.PI / 2 + moveLean; // spine pointing up by default
  let armL, armR, elbowBendL, elbowBendR;
  // Feet are given explicit world-space targets (not angles), so IK below
  // can plant them on the floor exactly instead of letting them float.
  let footLx = rd.baseX - stance, footLy = floorY;
  let footRx = rd.baseX + stance, footRy = floorY;

  if (s === 'Bounce') {
    // Weight-bearing bounce: knees do most of the work, feet stay planted,
    // hips/chest pump to the beat like a basic club bounce.
    const squat = Math.abs(Math.sin(w * 3)) * (16 + beat * 24) * (energy / 1.6);
    hipY = rd.baseY - squat * 0.3;
    hipX = rd.baseX + Math.sin(w) * 8;
    leanAngle += Math.sin(w * 3) * 0.12;
    armL = Math.PI * 0.85 + Math.sin(w * 3) * (1.25 * energy);
    armR = Math.PI * 0.15 - Math.sin(w * 3 + Math.PI) * (1.25 * energy);
    elbowBendL = 0.5; elbowBendR = -0.5;
    footLx = hipX - stance; footRx = hipX + stance;
    footLy = floorY - squat * 0.55;
    footRy = floorY - squat * 0.55;
  } else if (s === 'Robot') {
    // Stiff side-to-side stepping: one foot lifts and plants while the
    // other stays grounded, mechanical arm snaps.
    const cyc = Math.sin(w * 2.6);
    const step = cyc > 0 ? 1 : -1;
    hipX = rd.baseX + step * 15;
    hipY = rd.baseY - 4;
    leanAngle += step * 0.1;
    armL = step > 0 ? -Math.PI * 0.55 : Math.PI * 0.9;
    armR = step > 0 ? Math.PI * 0.1 : -Math.PI * 0.4;
    elbowBendL = -1.0; elbowBendR = 1.0;
    const lift = Math.max(0, Math.sin(w * 2.6)) * 32 * (energy / 1.6);
    const lift2 = Math.max(0, -Math.sin(w * 2.6)) * 32 * (energy / 1.6);
    footLx = hipX - stance - 6; footRx = hipX + stance + 6;
    footLy = floorY - lift;
    footRy = floorY - lift2;
  } else if (s === 'Wiggle') {
    // Feet planted, all the motion is in the hips/torso — a real wiggle
    // keeps its base of support still.
    hipX = rd.baseX + Math.sin(w * 2.2) * (30 + beat * 16) * (energy / 1.6);
    hipY = rd.baseY - Math.abs(Math.sin(w * 4.4)) * 9;
    leanAngle += -Math.sin(w * 2.2) * 0.4;
    armL = Math.PI * 0.7 - Math.sin(w * 2.2) * 0.45;
    armR = Math.PI * 0.3 - Math.sin(w * 2.2) * 0.45;
    elbowBendL = 0.4; elbowBendR = -0.4;
    footLx = rd.baseX - stance; footRx = rd.baseX + stance;
  } else { // Freestyle — big, snappy hype-dance hits: sharp lunges, driven
    // knees, fully-extended arm swings, punctuated with a wide pop pose.
    // Poses snap in fast then hold briefly, like a real dancer hitting a
    // beat, instead of smoothly oscillating.
    const cycleLen = 0.85 / speed;
    const localT = t + ph * 0.3;
    const idx = Math.floor(localT / cycleLen) % 4;
    const frac = (localT % cycleLen) / cycleLen;
    const snap = Math.min(1, frac * 7); // fast ease-in, then holds the pose

    const KF = [
      // lunge right: left knee drives up, right leg planted, arms cross-swing
      { lean: 0.55, armL: -1.95, armR: 0.55, elbowL: -0.6, elbowR: 0.5,
        footL: { x: 4,   y: -40 }, footR: { x: 34, y: 0 } },
      // wide pop: both feet planted wide, arms thrown up and out
      { lean: 0, armL: -Math.PI * 0.7, armR: -Math.PI * 0.3, elbowL: -0.15, elbowR: 0.15,
        footL: { x: -38, y: -6 }, footR: { x: 38, y: -6 } },
      // lunge left: mirror of the first
      { lean: -0.55, armL: -0.55, armR: 1.95, elbowL: -0.5, elbowR: 0.6,
        footL: { x: -34, y: 0 }, footR: { x: -4, y: -40 } },
      // low crouch hit: deep bend, head drops toward the front knee
      { lean: 0.8, armL: -1.3, armR: 0.9, elbowL: -0.8, elbowR: 0.7,
        footL: { x: 12, y: -8 }, footR: { x: 28, y: -6 } },
    ];
    const k = KF[idx];
    leanAngle = -Math.PI / 2 + moveLean + k.lean * snap;
    armL = k.armL * snap - Math.PI * 0.85 * (1 - snap);
    armR = k.armR * snap + Math.PI * 0.15 * (1 - snap);
    elbowBendL = k.elbowL; elbowBendR = k.elbowR;
    hipX = rd.baseX + Math.sin(w * 1.1) * 8;
    hipY = rd.baseY - snap * (idx === 1 ? 16 : 6) * (energy / 1.6);
    footLx = hipX + k.footL.x * snap; footLy = floorY + k.footL.y * snap;
    footRx = hipX + k.footR.x * snap; footRy = floorY + k.footR.y * snap;
  }

  // --- Wall push-off overlay: plant a hand on the wall and brace, then on
  // launch throw the body and trailing limbs in the direction of flight.
  // Layered on top of whichever dance style is active, so it works the
  // same for all of them.
  if (walk.state === 'push') {
    const p = Math.min(1, walk.timer / 0.32);
    const brace = Math.sin(p * Math.PI * 0.5); // eases in and holds
    const wallOnLeft = walk.wallX < rd.baseX;
    const reachAngle = wallOnLeft ? Math.PI : 0;
    const reachLen = (L.upperArm + L.foreArm) * 0.94;
    const reachHand = polar(rd.pts.neck, reachAngle, reachLen);
    leanAngle += (wallOnLeft ? -1 : 1) * 0.35 * brace;
    hipX += (wallOnLeft ? 1 : -1) * 10 * brace;
    hipY = rd.baseY + 6 * brace; // braced, slight crouch
    if (wallOnLeft) { armL = reachAngle; elbowBendL = 0; }
    else { armR = reachAngle; elbowBendR = 0; }
    // the bracing arm's target is set directly below (bypasses the polar chain)
    walk.braceHand = reachHand;
    walk.braceSide = wallOnLeft ? 'L' : 'R';
  } else if (walk.state === 'launch') {
    const p = Math.min(1, walk.timer / 0.55);
    const kick = 1 - p; // strongest right after the launch, fades out
    const dir = Math.sign(rd.vx) || walk.dir;
    leanAngle += dir * 0.5 * kick;
    hipY = rd.baseY - 10 * kick;
    if (dir > 0) { armL = Math.PI * 0.75; armR = -0.15; }
    else { armR = Math.PI * 0.25; armL = Math.PI + 0.15; }
    footLx -= dir * 20 * kick; footRx -= dir * 20 * kick;
    walk.braceHand = null;
  } else {
    walk.braceHand = null;
  }

  const pull = 0.46;
  driveToward(rd.pts.hip, hipX, hipY, pull);

  const neckTarget = polar(rd.pts.hip, leanAngle, L.spine);
  driveToward(rd.pts.neck, neckTarget.x, neckTarget.y, pull);

  const headTarget = polar(rd.pts.neck, leanAngle, L.neck);
  driveToward(rd.pts.head, headTarget.x, headTarget.y, pull);

  const lElbowT = polar(rd.pts.neck, armL, L.upperArm);
  driveToward(rd.pts.lElbow, lElbowT.x, lElbowT.y, pull);
  const lHandT = walk.braceHand && walk.braceSide === 'L' ? walk.braceHand : polar(lElbowT, armL + elbowBendL, L.foreArm);
  driveToward(rd.pts.lHand, lHandT.x, lHandT.y, pull);

  const rElbowT = polar(rd.pts.neck, armR, L.upperArm);
  driveToward(rd.pts.rElbow, rElbowT.x, rElbowT.y, pull);
  const rHandT = walk.braceHand && walk.braceSide === 'R' ? walk.braceHand : polar(rElbowT, armR + elbowBendR, L.foreArm);
  driveToward(rd.pts.rHand, rHandT.x, rHandT.y, pull);

  // Legs use IK so the feet actually reach the target (usually the floor)
  // instead of a fixed angle guess that can leave them hovering mid-air.
  const lKneeT = solveKnee(rd.pts.hip.x, rd.pts.hip.y, footLx, footLy, L.thigh, L.shin, 1);
  driveToward(rd.pts.lKnee, lKneeT.x, lKneeT.y, pull);
  driveToward(rd.pts.lFoot, footLx, footLy, pull);

  const rKneeT = solveKnee(rd.pts.hip.x, rd.pts.hip.y, footRx, footRy, L.thigh, L.shin, -1);
  driveToward(rd.pts.rKnee, rKneeT.x, rKneeT.y, pull);
  driveToward(rd.pts.rFoot, footRx, footRy, pull);
}

// Pose targets are joint angles (radians) from each limb's origin, so the
// elbows/knees bend correctly instead of just floating the hands/feet.
const POSE_TARGETS = {
  TPose:     { armL: Math.PI,        armR: 0,             elbowL: 0,     elbowR: 0,     legL: Math.PI/2 - 0.15, legR: Math.PI/2 + 0.15, kneeL: 0,    kneeR: 0 },
  SitDown:   { armL: Math.PI*0.6,    armR: Math.PI*0.4,   elbowL: 0.6,   elbowR: -0.6,  legL: Math.PI*0.25,     legR: Math.PI*0.75,     kneeL: 1.4,  kneeR: -1.4 },
  Superhero: { armL: -Math.PI*0.55,  armR: Math.PI*0.15,  elbowL: -0.2,  elbowR: -0.9,  legL: Math.PI/2 - 0.3,  legR: Math.PI/2 + 0.15, kneeL: 0,    kneeR: 0.1 },
  Relaxed:   { armL: Math.PI*0.65,   armR: Math.PI*0.35,  elbowL: 0.25,  elbowR: -0.25, legL: Math.PI/2 - 0.1,  legR: Math.PI/2 + 0.1,  kneeL: 0.05, kneeR: -0.05 },
};

function applyPose(rd) {
  const target = POSE_TARGETS[rd.style] || POSE_TARGETS.TPose;
  const L = rd.lens;
  const pull = 0.18;

  // SitDown drops the hips toward the floor instead of holding standing
  // height with bent knees (which used to leave the figure hovering).
  const hipY = rd.style === 'SitDown' ? rd.baseY + L.thigh * 0.55 : rd.baseY;
  driveToward(rd.pts.hip, rd.baseX, hipY, pull);
  const neckT = polar(rd.pts.hip, -Math.PI / 2, L.spine);
  driveToward(rd.pts.neck, neckT.x, neckT.y, pull);
  const headT = polar(rd.pts.neck, -Math.PI / 2, L.neck);
  driveToward(rd.pts.head, headT.x, headT.y, pull);

  const lElbowT = polar(rd.pts.neck, target.armL, L.upperArm);
  driveToward(rd.pts.lElbow, lElbowT.x, lElbowT.y, pull);
  const lHandT = polar(lElbowT, target.armL + target.elbowL, L.foreArm);
  driveToward(rd.pts.lHand, lHandT.x, lHandT.y, pull);

  const rElbowT = polar(rd.pts.neck, target.armR, L.upperArm);
  driveToward(rd.pts.rElbow, rElbowT.x, rElbowT.y, pull);
  const rHandT = polar(rElbowT, target.armR + target.elbowR, L.foreArm);
  driveToward(rd.pts.rHand, rHandT.x, rHandT.y, pull);

  const lKneeT = polar(rd.pts.hip, target.legL, L.thigh);
  driveToward(rd.pts.lKnee, lKneeT.x, lKneeT.y, pull);
  const lFootT = polar(lKneeT, target.legL + target.kneeL, L.shin);
  driveToward(rd.pts.lFoot, lFootT.x, lFootT.y, pull);

  const rKneeT = polar(rd.pts.hip, target.legR, L.thigh);
  driveToward(rd.pts.rKnee, rKneeT.x, rKneeT.y, pull);
  const rFootT = polar(rKneeT, target.legR + target.kneeR, L.shin);
  driveToward(rd.pts.rFoot, rFootT.x, rFootT.y, pull);
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

    if (rd.mode === 'dance') { updateLocomotion(rd, 0.016 * dt); applyDance(rd, clock); }
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
  analyser.smoothingTimeConstant = 0.3; // react quickly to individual hits
  freqData = new Uint8Array(analyser.frequencyBinCount);
  sourceNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  // fresh beat/tempo tracking for the new track
  beatHistory = [];
  lastBeatTime = 0;
  bpmEstimate = 120;
  state.beatCount = 0;
  state.autoStyleTimer = 0;

  document.getElementById('musicName').textContent = file.name;
  audioEl.play();
  document.getElementById('playPauseBtn').textContent = '⏸';
}

function updateBeat() {
  if (analyser) {
    analyser.getByteFrequencyData(freqData);
    // Bass-weighted level, used to detect individual hits (kick/snare).
    let sum = 0, weight = 0;
    for (let i = 0; i < 24; i++) {
      const w = 24 - i;
      sum += freqData[i] * w;
      weight += w;
    }
    const bassLevel = sum / weight / 255;

    // Overall loudness across the full spectrum — a slow-moving read on
    // how "big" the song is right now, used to pick which dance style fits.
    let total = 0;
    for (let i = 0; i < freqData.length; i++) total += freqData[i];
    const overall = total / freqData.length / 255;
    state.energy += (overall - state.energy) * 0.04;

    // Real onset detection: a "beat" is a bass spike well above its own
    // recent rolling average, not just raw loudness. This is what makes
    // the hit-poses land on the actual drum hits instead of drifting.
    beatHistory.push(bassLevel);
    if (beatHistory.length > 45) beatHistory.shift();
    const avg = beatHistory.reduce((a, b) => a + b, 0) / beatHistory.length;
    let varSum = 0;
    for (const v of beatHistory) varSum += (v - avg) * (v - avg);
    const spread = Math.sqrt(varSum / beatHistory.length);
    const threshold = avg + spread * 1.25 + 0.045;

    const now = performance.now();
    if (bassLevel > threshold && now - lastBeatTime > 220) {
      const interval = now - lastBeatTime;
      if (lastBeatTime > 0 && interval < 1500) {
        const instBPM = 60000 / interval;
        // only trust plausible dance tempos, so one stray transient can't
        // wreck the running estimate
        if (instBPM > 60 && instBPM < 200) bpmEstimate += (instBPM - bpmEstimate) * 0.25;
      }
      lastBeatTime = now;
      state.beatPulse = 1;
      state.beatCount++;
    }
    state.beatPulse = Math.max(0, state.beatPulse - 0.07);
    state.beat = Math.min(1, bassLevel * 0.5 + state.beatPulse * 0.85);
    state.tempo = bpmEstimate;
  } else {
    // fallback: gentle synthetic pulse so dancing still looks alive without music
    state.beatClock += 0.05;
    state.beat = (Math.sin(state.beatClock) + 1) / 2 * 0.5;
    state.energy += (0.3 - state.energy) * 0.02;
    state.tempo = 120;
  }

  autoStyleSwitch();
}

// While real music is playing, periodically pick a new dance style based
// on how loud/energetic the song currently is — quiet section -> Wiggle,
// building -> Robot, big/energetic -> Bounce or Freestyle. The switch
// cadence itself speeds up or slows down with the detected tempo, so a
// fast song cycles looks faster than a slow one.
function autoStyleSwitch() {
  if (!analyser || state.tab !== 'dance') return;
  const secondsPerCycle = Math.max(3, 16 * (120 / Math.max(60, state.tempo)));
  state.autoStyleTimer += 0.016;
  if (state.autoStyleTimer < secondsPerCycle) return;
  state.autoStyleTimer = 0;

  const e = state.energy;
  let pool;
  if (e > 0.5) pool = ['Freestyle', 'Bounce'];
  else if (e > 0.3) pool = ['Bounce', 'Robot'];
  else pool = ['Wiggle', 'Robot'];
  let next = pool[Math.floor(Math.random() * pool.length)];
  if (next === state.style.dance && pool.length > 1) next = pool.find(s => s !== next) || next;

  state.style.dance = next;
  for (const rd of ragdolls) { if (rd.mode === 'dance') rd.style = next; }
  renderChips();
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

// Double-clicking / double-tapping a tab collapses everything below the
// top tab bar (count panel, chip row, options panel) so the stage isn't
// covered. Using manual tap-timing (instead of the native 'dblclick'
// event) because touch double-tap can be unreliable in WebViews.
let lastTabTap = 0;
document.getElementById('tabBar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;

  const now = Date.now();
  const isDoubleTap = now - lastTabTap < 350;
  lastTabTap = now;

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  state.tab = btn.dataset.tab;

  document.getElementById('countPanel').style.display = state.tab === 'options' ? 'none' : 'block';
  document.getElementById('optionsPanel').style.display = state.tab === 'options' ? 'block' : 'none';

  renderChips();
  applyModeToAll();

  if (isDoubleTap) {
    document.getElementById('app').classList.toggle('ui-collapsed');
  }
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
