import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { getStatus, getCodeAgents } from '../api/client.js';

// --- Severance / Lumon color palette ---
const C = {
  bg: '#0a1f0f',
  bgNum: '#1a3a1f',
  wall: '#e8e0d4',
  wallLine: '#d4ccc0',
  floor: '#1a5c2a',
  floorLight: '#1f6b32',
  floorDark: '#145020',
  carpet: '#1a472a',
  desk: '#8a8a8a',
  deskTop: '#a0a0a0',
  deskSide: '#707070',
  monitor: '#2a2a2a',
  monitorScreen: '#0f3318',
  screenGlow: '#22cc55',
  screenCode: '#44ff77',
  screenNews: '#66aaff',
  chair: '#303030',
  chairSeat: '#404040',
  skin: '#e0b090',
  hair: '#4a2820',
  shirt: '#e0dcd0',
  pants: '#2a3a50',
  zzz: '#88cc88',
  thought: '#ffffff',
  logoGreen: '#1a5c2a',
  shadow: 'rgba(0,0,0,0.15)',
  coffee: '#5c3a1a',
  mug: '#c8c0b0',
  water: '#6ab4e8',
  cooler: '#b8d0e0',
};

type AgentState = 'coding' | 'browsing' | 'thinking' | 'idle' | 'sleeping';

// --- Drawing primitives ---
function drawPixel(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
}

function drawRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

function drawIsoBox(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, d: number,
  topColor: string, leftColor: string, rightColor: string) {
  ctx.fillStyle = topColor;
  ctx.beginPath();
  ctx.moveTo(cx, cy - d);
  ctx.lineTo(cx + w * 0.866, cy - d + w * 0.5);
  ctx.lineTo(cx, cy - d + w * 0.5 + h * 0.5);
  ctx.lineTo(cx - h * 0.866, cy - d + h * 0.5);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = leftColor;
  ctx.beginPath();
  ctx.moveTo(cx - h * 0.866, cy - d + h * 0.5);
  ctx.lineTo(cx, cy - d + w * 0.5 + h * 0.5);
  ctx.lineTo(cx, cy - d + w * 0.5 + h * 0.5 + d);
  ctx.lineTo(cx - h * 0.866, cy + h * 0.5);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = rightColor;
  ctx.beginPath();
  ctx.moveTo(cx, cy - d + w * 0.5 + h * 0.5);
  ctx.lineTo(cx + w * 0.866, cy - d + w * 0.5);
  ctx.lineTo(cx + w * 0.866, cy + w * 0.5);
  ctx.lineTo(cx, cy + w * 0.5 + h * 0.5);
  ctx.closePath();
  ctx.fill();
}

// ============================================================
// CHARACTER ANIMATION SYSTEM
// ============================================================

interface Vec2 { x: number; y: number; }

type Activity =
  | { kind: 'seated'; duration: number }
  | { kind: 'standing'; duration: number }
  | { kind: 'walking'; path: Vec2[]; speed: number }
  | { kind: 'pouring'; item: 'coffee' | 'water'; duration: number }
  | { kind: 'drinking'; item: 'coffee' | 'water'; duration: number }
  | { kind: 'stretching'; duration: number }
  | { kind: 'looking'; duration: number };

interface CharState {
  pos: Vec2;
  activity: Activity;
  activityTimer: number;
  queue: Activity[];
  facing: 'left' | 'right' | 'up' | 'down';
  walkFrame: number;
  pathIndex: number;
  pathProgress: number;
  holdingItem: 'coffee' | 'water' | null;
  seated: boolean;
}

// Key locations in the office
const LOC = {
  desk: { x: 141, y: 122 },       // SE desk chair position
  deskStand: { x: 145, y: 126 },  // standing behind desk
  coffeeCorner: { x: 100, y: 142 },
  waterCooler: { x: 168, y: 136 },
  centerRoom: { x: 128, y: 132 },
  nearDoor: { x: 95, y: 130 },
  wanderA: { x: 115, y: 138 },
  wanderB: { x: 150, y: 128 },
  wanderC: { x: 120, y: 125 },
};

function initCharState(): CharState {
  return {
    pos: { ...LOC.desk },
    activity: { kind: 'seated', duration: 120 },
    activityTimer: 0,
    queue: [],
    facing: 'right',
    walkFrame: 0,
    pathIndex: 0,
    pathProgress: 0,
    holdingItem: null,
    seated: true,
  };
}

// Build activity sequences
function buildCoffeeTrip(): Activity[] {
  return [
    { kind: 'standing', duration: 15 },
    { kind: 'walking', path: [LOC.deskStand, LOC.centerRoom, LOC.coffeeCorner], speed: 0.6 },
    { kind: 'pouring', item: 'coffee', duration: 60 },
    { kind: 'walking', path: [LOC.coffeeCorner, LOC.centerRoom, LOC.deskStand], speed: 0.5 },
    { kind: 'drinking', item: 'coffee', duration: 45 },
    { kind: 'standing', duration: 10 },
  ];
}

function buildWaterTrip(): Activity[] {
  return [
    { kind: 'standing', duration: 15 },
    { kind: 'walking', path: [LOC.deskStand, LOC.wanderB, LOC.waterCooler], speed: 0.6 },
    { kind: 'pouring', item: 'water', duration: 50 },
    { kind: 'walking', path: [LOC.waterCooler, LOC.wanderB, LOC.deskStand], speed: 0.5 },
    { kind: 'drinking', item: 'water', duration: 40 },
    { kind: 'standing', duration: 10 },
  ];
}

function buildStretchWalk(): Activity[] {
  return [
    { kind: 'standing', duration: 15 },
    { kind: 'stretching', duration: 40 },
    { kind: 'walking', path: [LOC.deskStand, LOC.wanderA, LOC.wanderC, LOC.centerRoom, LOC.wanderB, LOC.deskStand], speed: 0.4 },
    { kind: 'standing', duration: 10 },
  ];
}

function buildLookAround(): Activity[] {
  return [
    { kind: 'standing', duration: 10 },
    { kind: 'looking', duration: 60 },
    { kind: 'standing', duration: 10 },
  ];
}

// Pick a random break activity
function pickBreakActivity(): Activity[] {
  const r = Math.random();
  if (r < 0.35) return buildCoffeeTrip();
  if (r < 0.60) return buildWaterTrip();
  if (r < 0.80) return buildStretchWalk();
  return buildLookAround();
}

// Advance the character state by one frame
function tickCharacter(cs: CharState, agentState: AgentState): CharState {
  const s = { ...cs };
  s.activityTimer++;

  const act = s.activity;

  if (act.kind === 'walking') {
    s.seated = false;
    s.walkFrame++;
    const path = act.path;
    if (s.pathIndex < path.length - 1) {
      const from = path[s.pathIndex];
      const to = path[s.pathIndex + 1];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      s.pathProgress += act.speed;

      // Update facing direction
      if (Math.abs(dx) > Math.abs(dy)) {
        s.facing = dx > 0 ? 'right' : 'left';
      } else {
        s.facing = dy > 0 ? 'down' : 'up';
      }

      if (s.pathProgress >= dist) {
        s.pathProgress -= dist;
        s.pathIndex++;
        s.pos = { ...to };
      } else {
        const t = s.pathProgress / dist;
        s.pos = { x: from.x + dx * t, y: from.y + dy * t };
      }
    }
    // Check if walking is done
    if (s.pathIndex >= path.length - 1) {
      advanceActivity(s, agentState);
    }
  } else if (act.kind === 'seated') {
    s.seated = true;
    s.pos = { ...LOC.desk };
    if (s.activityTimer >= act.duration) {
      // Decide: stay seated or take a break
      if (agentState === 'sleeping' || agentState === 'coding') {
        // Less likely to get up when busy or sleeping
        s.activityTimer = 0;
        s.activity = { kind: 'seated', duration: 200 + Math.random() * 300 };
        if (agentState !== 'sleeping' && Math.random() < 0.15) {
          s.queue = pickBreakActivity();
          advanceActivity(s, agentState);
        }
      } else {
        // Idle/thinking/browsing — more likely to wander
        if (Math.random() < 0.4) {
          s.queue = pickBreakActivity();
          advanceActivity(s, agentState);
        } else {
          s.activityTimer = 0;
          s.activity = { kind: 'seated', duration: 80 + Math.random() * 150 };
        }
      }
    }
  } else if (act.kind === 'pouring') {
    s.seated = false;
    if (s.activityTimer >= act.duration) {
      s.holdingItem = act.item;
      advanceActivity(s, agentState);
    }
  } else if (act.kind === 'drinking') {
    s.seated = false;
    if (s.activityTimer >= act.duration) {
      s.holdingItem = null;
      advanceActivity(s, agentState);
    }
  } else if (act.kind === 'standing') {
    s.seated = false;
    if (s.activityTimer >= act.duration) {
      advanceActivity(s, agentState);
    }
  } else if (act.kind === 'stretching') {
    s.seated = false;
    if (s.activityTimer >= act.duration) {
      advanceActivity(s, agentState);
    }
  } else if (act.kind === 'looking') {
    s.seated = false;
    // Rotate facing while looking around
    const lookPhase = Math.floor(s.activityTimer / 15) % 4;
    s.facing = (['right', 'up', 'left', 'down'] as const)[lookPhase];
    if (s.activityTimer >= act.duration) {
      advanceActivity(s, agentState);
    }
  }

  return s;
}

function advanceActivity(s: CharState, _agentState: AgentState) {
  s.activityTimer = 0;
  s.pathIndex = 0;
  s.pathProgress = 0;

  if (s.queue.length > 0) {
    s.activity = s.queue.shift()!;
  } else {
    // Return to desk
    if (s.pos.x !== LOC.desk.x || s.pos.y !== LOC.desk.y) {
      s.activity = { kind: 'walking', path: [{ ...s.pos }, LOC.deskStand, LOC.desk], speed: 0.6 };
      s.queue = [{ kind: 'seated', duration: 100 + Math.random() * 200 }];
    } else {
      s.activity = { kind: 'seated', duration: 100 + Math.random() * 200 };
      s.seated = true;
    }
  }
}

// ============================================================
// DRAWING FUNCTIONS
// ============================================================

function drawMatrixBg(ctx: CanvasRenderingContext2D, frame: number) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, 256, 256);
  ctx.font = '5px monospace';
  ctx.fillStyle = C.bgNum;
  const nums = '0123456789';
  for (let row = 0; row < 52; row++) {
    for (let col = 0; col < 42; col++) {
      if (Math.random() > 0.6) {
        ctx.fillText(nums[(row * 7 + col * 3 + frame) % 10], col * 6 + 2, row * 5 + 5);
      }
    }
  }
}

function drawFloor(ctx: CanvasRenderingContext2D) {
  const cx = 128, cy = 130;
  ctx.fillStyle = C.shadow;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 30 + 4);
  ctx.lineTo(cx + 56, cy + 4);
  ctx.lineTo(cx, cy + 30 + 4);
  ctx.lineTo(cx - 56, cy + 4);
  ctx.closePath();
  ctx.fill();

  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      const fx = cx + (i - j) * 5;
      const fy = cy + (i + j) * 2.5;
      if (Math.abs(i) + Math.abs(j) > 6) continue;
      ctx.fillStyle = (i + j) % 2 === 0 ? C.floorLight : C.floorDark;
      ctx.beginPath();
      ctx.moveTo(fx, fy - 2.5);
      ctx.lineTo(fx + 5, fy);
      ctx.lineTo(fx, fy + 2.5);
      ctx.lineTo(fx - 5, fy);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Carpet
  ctx.fillStyle = C.carpet;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 22);
  ctx.lineTo(cx + 38, cy);
  ctx.lineTo(cx, cy + 22);
  ctx.lineTo(cx - 38, cy);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#0d3318';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 20);
  ctx.lineTo(cx + 34, cy);
  ctx.lineTo(cx, cy + 20);
  ctx.lineTo(cx - 34, cy);
  ctx.closePath();
  ctx.stroke();
}

function drawWalls(ctx: CanvasRenderingContext2D) {
  const cx = 128, cy = 130, wallH = 55;
  ctx.fillStyle = C.wall;
  ctx.beginPath();
  ctx.moveTo(cx - 52, cy);
  ctx.lineTo(cx, cy - 30);
  ctx.lineTo(cx, cy - 30 - wallH);
  ctx.lineTo(cx - 52, cy - wallH);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ddd8cc';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 30);
  ctx.lineTo(cx + 52, cy);
  ctx.lineTo(cx + 52, cy - wallH);
  ctx.lineTo(cx, cy - 30 - wallH);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = C.wallLine;
  ctx.lineWidth = 0.3;
  for (let i = 1; i < 6; i++) {
    const t = i / 6;
    let x1 = cx - 52 + t * 52, y1 = cy - t * 30;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1, y1 - wallH); ctx.stroke();
    x1 = cx + t * 52; y1 = cy - 30 + t * 30;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1, y1 - wallH); ctx.stroke();
  }
}

function drawLumonLogo(ctx: CanvasRenderingContext2D) {
  const lx = 105, ly = 68;
  ctx.fillStyle = C.logoGreen;
  ctx.fillRect(lx - 8, ly - 3, 16, 6);
  ctx.fillStyle = C.wall;
  ctx.font = 'bold 4px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('SC', lx, ly + 1);
  ctx.textAlign = 'start';
}

function drawDoor(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#b0a898';
  ctx.fillRect(89, 82, 6, 16);
  ctx.fillStyle = '#c8c0b4';
  ctx.fillRect(90, 83, 4, 14);
  drawPixel(ctx, 93, 90, '#888');
}

function drawCamera(ctx: CanvasRenderingContext2D, frame: number) {
  const ex = 163, ey = 99;
  ctx.fillStyle = '#444';
  ctx.beginPath(); ctx.arc(ex, ey, 2, 0, Math.PI * 2); ctx.fill();
  if (frame % 60 < 30) {
    ctx.fillStyle = '#ff2222';
    ctx.beginPath(); ctx.arc(ex, ey, 0.8, 0, Math.PI * 2); ctx.fill();
  }
}

// --- Coffee machine (left wall area) ---
function drawCoffeeMachine(ctx: CanvasRenderingContext2D) {
  const mx = 98, my = 138;
  // Machine body
  drawRect(ctx, mx, my - 8, 5, 8, '#555');
  drawRect(ctx, mx + 1, my - 7, 3, 3, '#333');
  // Red light
  drawPixel(ctx, mx + 1, my - 4, '#ff4444');
  // Drip tray
  drawRect(ctx, mx, my, 5, 1, '#666');
}

// --- Water cooler (right wall area) ---
function drawWaterCooler(ctx: CanvasRenderingContext2D) {
  const wx = 166, wy = 132;
  // Bottle
  drawRect(ctx, wx + 1, wy - 10, 3, 5, C.water);
  ctx.globalAlpha = 0.6;
  drawRect(ctx, wx + 1, wy - 10, 3, 5, '#fff');
  ctx.globalAlpha = 1;
  // Body
  drawRect(ctx, wx, wy - 5, 5, 6, C.cooler);
  drawRect(ctx, wx, wy + 1, 5, 2, '#8a9aa8');
  // Tap
  drawPixel(ctx, wx + 2, wy - 2, '#aaa');
}

function drawDeskCluster(ctx: CanvasRenderingContext2D) {
  const cx = 128, cy = 125;
  const desks = [
    { x: cx - 15, y: cy - 8 },
    { x: cx + 5, y: cy - 8 },
    { x: cx - 15, y: cy + 4 },
    { x: cx + 5, y: cy + 4 },
  ];
  for (const d of desks) {
    drawIsoBox(ctx, d.x + 5, d.y + 5, 10, 8, 8, C.deskTop, C.deskSide, C.desk);
    const mx = d.x + 5, my = d.y - 2;
    drawRect(ctx, mx - 1, my - 5, 6, 5, C.monitor);
    drawRect(ctx, mx, my - 4, 4, 3, C.monitorScreen);
    drawRect(ctx, mx + 1, my, 2, 1, C.desk);
  }
}

function drawEmptyDesks(ctx: CanvasRenderingContext2D) {
  drawRect(ctx, 113, 122, 6, 4, C.chairSeat);
  drawRect(ctx, 137, 111, 2, 2, '#c0c0c0');
  drawRect(ctx, 137, 110, 2, 1, '#a08060');
  drawRect(ctx, 118, 130, 3, 1, '#f0f0e8');
  drawRect(ctx, 118, 129, 3, 1, '#e8e8e0');
}

// ============================================================
// CHARACTER RENDERING (position-based)
// ============================================================

function drawCharacterSprite(ctx: CanvasRenderingContext2D, cs: CharState, agentState: AgentState, frame: number) {
  const { pos, activity, walkFrame, facing, holdingItem, seated } = cs;
  const x = Math.round(pos.x);
  const y = Math.round(pos.y);

  if (seated) {
    drawSeatedCharacter(ctx, x, y, agentState, frame);
    return;
  }

  // Walking / standing character
  const isWalking = activity.kind === 'walking';
  const legPhase = isWalking ? Math.sin(walkFrame * 0.4) * 2 : 0;
  const armSwing = isWalking ? Math.sin(walkFrame * 0.4) * 1.5 : 0;
  const headBob = isWalking ? Math.abs(Math.sin(walkFrame * 0.4)) * 0.5 : 0;

  const isStretching = activity.kind === 'stretching';
  const stretchPhase = isStretching ? Math.sin(cs.activityTimer * 0.08) : 0;

  const isDrinking = activity.kind === 'drinking';
  const drinkPhase = isDrinking ? Math.sin(cs.activityTimer * 0.1) : 0;

  const isPouring = activity.kind === 'pouring';

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.1)';
  ctx.beginPath();
  ctx.ellipse(x, y + 2, 3, 1.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs
  drawRect(ctx, x - 1, y - 2 + legPhase * 0.3, 2, 4, C.pants);
  drawRect(ctx, x + 1, y - 2 - legPhase * 0.3, 2, 4, C.pants);
  // Shoes
  drawRect(ctx, x - 1, y + 2, 2, 1, '#222');
  drawRect(ctx, x + 1, y + 2, 2, 1, '#222');

  // Body
  const bodyY = y - 6 - headBob;
  drawRect(ctx, x - 2, bodyY, 5, 5, C.shirt);

  // Arms
  if (isStretching) {
    // Arms up stretch
    const armUp = stretchPhase * 3;
    drawRect(ctx, x - 3, bodyY - armUp, 1, 3, C.skin);
    drawRect(ctx, x + 5, bodyY - armUp, 1, 3, C.skin);
  } else if (isDrinking && holdingItem) {
    // One arm holding mug up
    const mugUp = Math.abs(drinkPhase) * 2;
    drawRect(ctx, x - 3, bodyY + 1 + armSwing, 1, 2, C.skin);
    drawRect(ctx, x + 5, bodyY - 1 - mugUp, 1, 2, C.skin);
    // Mug
    drawRect(ctx, x + 5, bodyY - 2 - mugUp, 2, 2, C.mug);
    drawRect(ctx, x + 5, bodyY - 1 - mugUp, 2, 1, holdingItem === 'coffee' ? C.coffee : C.water);
  } else if (isPouring) {
    // Arms forward at machine
    drawRect(ctx, x + 3, bodyY + 1, 3, 1, C.skin);
    drawRect(ctx, x - 3, bodyY + 2, 1, 2, C.skin);
  } else if (holdingItem) {
    // Carrying mug while walking
    drawRect(ctx, x - 3, bodyY + 1 + armSwing, 1, 2, C.skin);
    drawRect(ctx, x + 4, bodyY + 1, 1, 2, C.skin);
    // Mug in hand
    drawRect(ctx, x + 4, bodyY, 2, 2, C.mug);
    drawRect(ctx, x + 4, bodyY + 1, 2, 1, holdingItem === 'coffee' ? C.coffee : C.water);
  } else {
    // Normal arm swing
    drawRect(ctx, x - 3, bodyY + 1 + armSwing, 1, 2, C.skin);
    drawRect(ctx, x + 5, bodyY + 1 - armSwing, 1, 2, C.skin);
  }

  // Head
  const headY = bodyY - 5;
  drawRect(ctx, x - 1, headY, 5, 5, C.skin);
  // Hair
  drawRect(ctx, x - 1, headY - 1, 5, 2, C.hair);
  drawRect(ctx, x - 1, headY, 1, 3, C.hair);
  // Eyes (direction-aware)
  if (facing === 'left') {
    drawPixel(ctx, x - 1, headY + 2, '#2a2a2a');
    drawPixel(ctx, x + 1, headY + 2, '#2a2a2a');
  } else if (facing === 'up') {
    drawPixel(ctx, x, headY + 1, '#2a2a2a');
    drawPixel(ctx, x + 2, headY + 1, '#2a2a2a');
  } else {
    drawPixel(ctx, x + 1, headY + 2, '#2a2a2a');
    drawPixel(ctx, x + 3, headY + 2, '#2a2a2a');
  }

  // Stretch yawn
  if (isStretching && stretchPhase > 0.5) {
    drawPixel(ctx, x + 1, headY + 3, '#c08070');
  }
}

function drawSeatedCharacter(ctx: CanvasRenderingContext2D, cx: number, cy: number, state: AgentState, frame: number) {
  const bobY = state === 'sleeping' ? 2 : (state === 'idle' ? Math.sin(frame * 0.05) * 0.5 : 0);

  // Chair
  drawRect(ctx, cx - 3, cy + 2, 6, 4, C.chairSeat);
  drawRect(ctx, cx - 3, cy - 2, 1, 4, C.chair);

  // Body
  drawRect(ctx, cx - 2, cy - 3 + bobY, 5, 5, C.shirt);

  // Arms
  if (state === 'coding' || state === 'browsing') {
    const armBob = frame % 6 < 3 ? 0 : -1;
    drawRect(ctx, cx - 3, cy - 1 + bobY + armBob, 2, 1, C.skin);
    drawRect(ctx, cx + 4, cy - 1 + bobY - armBob, 2, 1, C.skin);
  } else if (state === 'sleeping') {
    drawRect(ctx, cx - 1, cy - 4, 4, 1, C.skin);
  } else {
    drawRect(ctx, cx - 3, cy + bobY, 1, 2, C.skin);
    drawRect(ctx, cx + 5, cy + bobY, 1, 2, C.skin);
  }

  // Pants
  drawRect(ctx, cx - 1, cy + 2 + bobY, 2, 2, C.pants);
  drawRect(ctx, cx + 1, cy + 2 + bobY, 2, 2, C.pants);

  // Head
  if (state === 'sleeping') {
    drawRect(ctx, cx, cy - 6, 4, 3, C.skin);
    drawRect(ctx, cx, cy - 7, 4, 1, C.hair);
  } else {
    drawRect(ctx, cx - 1, cy - 8 + bobY, 5, 5, C.skin);
    drawRect(ctx, cx - 1, cy - 9 + bobY, 5, 2, C.hair);
    drawRect(ctx, cx - 1, cy - 8 + bobY, 1, 3, C.hair);
    drawPixel(ctx, cx, cy - 6 + bobY, '#2a2a2a');
    drawPixel(ctx, cx + 2, cy - 6 + bobY, '#2a2a2a');
  }

  // Monitor screen
  const smx = 139, smy = 118;
  if (state === 'coding') {
    for (let i = 0; i < 3; i++) {
      const lineW = 1 + ((frame + i * 3) % 3);
      drawRect(ctx, smx, smy - 4 + i, lineW, 0.5, C.screenCode);
    }
  } else if (state === 'browsing') {
    drawRect(ctx, smx, smy - 4, 3, 0.5, C.screenNews);
    drawRect(ctx, smx, smy - 3, 2, 0.5, C.screenNews);
    drawRect(ctx, smx, smy - 2, 3, 0.5, C.screenNews);
  } else if (state === 'thinking') {
    const dotPhase = frame % 12;
    for (let i = 0; i < 3; i++) {
      if ((dotPhase / 4) > i) drawPixel(ctx, smx + i, smy - 3, C.screenGlow);
    }
  } else {
    drawRect(ctx, smx, smy - 4, 3, 2.5, '#0a2210');
  }
}

// --- ZZZ ---
function drawZzz(ctx: CanvasRenderingContext2D, frame: number) {
  ctx.fillStyle = C.zzz;
  ctx.font = '4px monospace';
  const phase = frame * 0.03;
  for (let i = 0; i < 3; i++) {
    const t = (phase + i * 0.8) % 2;
    ctx.globalAlpha = (t < 1 ? t : 2 - t) * 0.8;
    ctx.fillText('z', 148 + i * 4, 106 - t * 8 - i * 3);
  }
  ctx.globalAlpha = 1;
}

// --- Thought bubble ---
function drawThoughtBubble(ctx: CanvasRenderingContext2D, frame: number) {
  const bx = 150, by = 100;
  ctx.fillStyle = C.thought;
  ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.ellipse(bx, by, 8, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(bx - 8, by + 5, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(bx - 10, by + 8, 1, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#666';
  const dotPhase = Math.floor(frame / 8) % 4;
  for (let i = 0; i < 3; i++) {
    if (i <= dotPhase) {
      ctx.beginPath(); ctx.arc(bx - 3 + i * 3, by, 0.8, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// --- Status bar ---
function drawStatusBar(ctx: CanvasRenderingContext2D, state: AgentState, statusText: string, cs: CharState) {
  drawRect(ctx, 0, 236, 256, 20, 'rgba(0,0,0,0.7)');

  const dotColors: Record<AgentState, string> = {
    coding: '#44ff77', browsing: '#66aaff', thinking: '#ffaa44',
    idle: '#88cc88', sleeping: '#555555',
  };
  ctx.beginPath();
  ctx.arc(12, 246, 3, 0, Math.PI * 2);
  ctx.fillStyle = dotColors[state];
  ctx.fill();

  ctx.fillStyle = '#ccddcc';
  ctx.font = '5px monospace';
  const displayState = !cs.seated && cs.activity.kind !== 'seated'
    ? activityLabel(cs)
    : state.toUpperCase();
  ctx.fillText(displayState, 20, 248);

  ctx.fillStyle = '#889988';
  ctx.font = '4px monospace';
  ctx.fillText(statusText, 75, 248);

  ctx.fillStyle = '#556655';
  ctx.font = '4px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('👙🦞 SkimpyClaw', 250, 248);
  ctx.textAlign = 'start';
}

function activityLabel(cs: CharState): string {
  switch (cs.activity.kind) {
    case 'walking': return cs.holdingItem ? `CARRYING ${cs.holdingItem.toUpperCase()}` : 'WALKING';
    case 'pouring': return `GETTING ${cs.activity.item.toUpperCase()}`;
    case 'drinking': return `DRINKING ${cs.activity.item.toUpperCase()}`;
    case 'stretching': return 'STRETCHING';
    case 'looking': return 'LOOKING AROUND';
    case 'standing': return 'STANDING';
    default: return 'IDLE';
  }
}

// ============================================================
// MAIN RENDER
// ============================================================

function renderFrame(ctx: CanvasRenderingContext2D, state: AgentState, statusText: string, cs: CharState, frame: number) {
  drawMatrixBg(ctx, frame);
  drawWalls(ctx);
  drawLumonLogo(ctx);
  drawDoor(ctx);
  drawCamera(ctx, frame);
  drawFloor(ctx);
  drawCoffeeMachine(ctx);
  drawWaterCooler(ctx);
  drawDeskCluster(ctx);
  drawEmptyDesks(ctx);
  drawCharacterSprite(ctx, cs, state, frame);

  if (cs.seated && state === 'sleeping') drawZzz(ctx, frame);
  if (cs.seated && state === 'thinking') drawThoughtBubble(ctx, frame);

  drawStatusBar(ctx, state, statusText, cs);
}

// ============================================================
// STATE DERIVATION FROM API
// ============================================================

function deriveState(status: any, codeAgents: any[]): { state: AgentState; text: string } {
  const activeAgents = (codeAgents || []).filter((a: any) => a.status === 'running');
  if (activeAgents.length > 0) {
    return { state: 'coding', text: `${activeAgents.length} agent(s) active` };
  }
  if (status?.busy || status?.processing) {
    return { state: 'thinking', text: 'Processing request...' };
  }
  const lastActivity = status?.lastActivityAt || status?.lastMessageAt;
  if (lastActivity) {
    const mins = Math.floor((Date.now() - new Date(lastActivity).getTime()) / 60000);
    if (mins < 2) return { state: 'thinking', text: `Active ${mins}m ago` };
    if (mins < 15) return { state: 'idle', text: `Last activity ${mins}m ago` };
    if (mins < 60) return { state: 'idle', text: `Idle for ${mins}m` };
    return { state: 'sleeping', text: `Sleeping for ${Math.floor(mins / 60)}h ${mins % 60}m` };
  }
  const model = status?.model || '';
  if (model) return { state: 'idle', text: `Model: ${model}` };
  return { state: 'idle', text: 'Standing by' };
}

// ============================================================
// COMPONENT
// ============================================================

export function Office() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const charRef = useRef<CharState>(initCharState());
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [statusText, setStatusText] = useState('Initializing...');
  const animRef = useRef<number>(0);

  const pollStatus = useCallback(async () => {
    try {
      const [status, agents] = await Promise.all([
        getStatus().catch(() => null),
        getCodeAgents().catch(() => []),
      ]);
      const { state, text } = deriveState(status, agents as any[]);
      setAgentState(state);
      setStatusText(text);
    } catch {
      setStatusText('Connection lost');
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 10000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    function animate() {
      frameRef.current++;
      charRef.current = tickCharacter(charRef.current, agentState);
      renderFrame(ctx!, agentState, statusText, charRef.current, frameRef.current);
      animRef.current = requestAnimationFrame(animate);
    }

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [agentState, statusText]);

  return (
    <div>
      <div class="page-header">
        <div class="page-title">The Office</div>
        <div class="header-actions">
          <span style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            fontFamily: 'var(--mono)',
          }}>
            Macrodata Refinement · Floor 7
          </span>
        </div>
      </div>

      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '20px 0',
      }}>
        <canvas
          ref={canvasRef}
          width={256}
          height={256}
          style={{
            width: '512px',
            height: '512px',
            imageRendering: 'pixelated',
            borderRadius: '8px',
            border: '2px solid var(--border)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
          }}
        />
      </div>

      <div style={{
        textAlign: 'center',
        marginTop: 12,
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: 'var(--text-muted)',
        letterSpacing: '0.05em',
      }}>
        Please enjoy each state equally.
      </div>
    </div>
  );
}
