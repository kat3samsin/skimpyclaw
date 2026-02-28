import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { getStatus, getCodeAgents, getAudit } from '../api/client.js';

// --- Severance / Lumon palette ---
const C = {
  bg: '#0d1a0f',
  wall: '#e8e0d4',
  wallLine: '#d4ccc0',
  wallRight: '#ddd8cc',
  floorLight: '#1f6b32',
  floorDark: '#145020',
  carpet: '#1a472a',
  carpetBorder: '#0d3318',
  desk: '#8a8a8a',
  deskTop: '#a0a0a0',
  deskSide: '#707070',
  monitor: '#2a2a2a',
  monScreen: '#0f3318',
  codeGreen: '#44ff77',
  newsBlue: '#66aaff',
  screenGlow: '#22cc55',
  chair: '#303030',
  chairSeat: '#404040',
  skin: '#e0b090',
  hair: '#4a2820',
  shirt: '#e0dcd0',
  pants: '#2a3a50',
  shoes: '#1a1a1a',
  zzz: '#88cc88',
  bubble: '#ffffff',
  bubbleBorder: '#bbbbbb',
  logoGreen: '#1a5c2a',
  coffee: '#5c3a1a',
  mug: '#c8c0b0',
  water: '#6ab4e8',
  cooler: '#b8d0e0',
};

type AgentState = 'coding' | 'browsing' | 'thinking' | 'idle' | 'sleeping';

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), s, s);
}

// ============================================================
// CHARACTER STATE MACHINE
// ============================================================

interface Vec2 { x: number; y: number }

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
  timer: number;
  queue: Activity[];
  facing: 'left' | 'right' | 'up' | 'down';
  walkFrame: number;
  pathIdx: number;
  pathProg: number;
  holding: 'coffee' | 'water' | null;
  seated: boolean;
}

// Locations scaled for 640 canvas, room centered
const LOC = {
  desk:      { x: 370, y: 330 },
  deskStand: { x: 380, y: 345 },
  coffee:    { x: 215, y: 395 },
  water:     { x: 455, y: 365 },
  center:    { x: 320, y: 365 },
  wanderA:   { x: 260, y: 380 },
  wanderB:   { x: 400, y: 350 },
};

function initChar(): CharState {
  return {
    pos: { ...LOC.desk }, activity: { kind: 'seated', duration: 9999 },
    timer: 0, queue: [], facing: 'right', walkFrame: 0,
    pathIdx: 0, pathProg: 0, holding: null, seated: true,
  };
}

function coffeTrip(): Activity[] {
  return [
    { kind: 'standing', duration: 20 },
    { kind: 'walking', path: [LOC.deskStand, LOC.center, LOC.coffee], speed: 1.5 },
    { kind: 'pouring', item: 'coffee', duration: 80 },
    { kind: 'walking', path: [LOC.coffee, LOC.center, LOC.deskStand], speed: 1.2 },
    { kind: 'drinking', item: 'coffee', duration: 60 },
    { kind: 'standing', duration: 15 },
  ];
}

function waterTrip(): Activity[] {
  return [
    { kind: 'standing', duration: 20 },
    { kind: 'walking', path: [LOC.deskStand, LOC.wanderB, LOC.water], speed: 1.5 },
    { kind: 'pouring', item: 'water', duration: 60 },
    { kind: 'walking', path: [LOC.water, LOC.wanderB, LOC.deskStand], speed: 1.2 },
    { kind: 'drinking', item: 'water', duration: 50 },
    { kind: 'standing', duration: 15 },
  ];
}

function stretchWalk(): Activity[] {
  return [
    { kind: 'standing', duration: 15 },
    { kind: 'stretching', duration: 50 },
    { kind: 'walking', path: [LOC.deskStand, LOC.wanderA, LOC.center, LOC.wanderB, LOC.deskStand], speed: 1.0 },
    { kind: 'standing', duration: 15 },
  ];
}

function pickBreak(): Activity[] {
  const r = Math.random();
  if (r < 0.4) return coffeTrip();
  if (r < 0.7) return waterTrip();
  return stretchWalk();
}

function advance(s: CharState) {
  s.timer = 0; s.pathIdx = 0; s.pathProg = 0;
  if (s.queue.length > 0) {
    s.activity = s.queue.shift()!;
  } else if (Math.abs(s.pos.x - LOC.desk.x) > 2 || Math.abs(s.pos.y - LOC.desk.y) > 2) {
    s.activity = { kind: 'walking', path: [{ ...s.pos }, LOC.deskStand, LOC.desk], speed: 1.5 };
    s.queue = [{ kind: 'seated', duration: 200 }];
  } else {
    s.activity = { kind: 'seated', duration: 200 };
    s.seated = true;
    s.pos = { ...LOC.desk };
  }
}

function tickChar(cs: CharState, agentState: AgentState): CharState {
  const s = { ...cs };
  s.timer++;

  // WORKING states — force seated immediately
  const working = agentState === 'coding' || agentState === 'browsing' || agentState === 'thinking';
  if (working && !s.seated) {
    s.queue = [];
    s.holding = null;
    s.pos = { ...LOC.desk };
    s.activity = { kind: 'seated', duration: 9999 };
    s.seated = true;
    return s;
  }

  const act = s.activity;

  if (act.kind === 'walking') {
    s.seated = false;
    s.walkFrame++;
    const path = act.path;
    if (s.pathIdx < path.length - 1) {
      const from = path[s.pathIdx], to = path[s.pathIdx + 1];
      const dx = to.x - from.x, dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      s.pathProg += act.speed;
      s.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      if (s.pathProg >= dist) { s.pathProg -= dist; s.pathIdx++; s.pos = { ...to }; }
      else { const t = s.pathProg / dist; s.pos = { x: from.x + dx * t, y: from.y + dy * t }; }
    }
    if (s.pathIdx >= path.length - 1) advance(s);
  } else if (act.kind === 'seated') {
    s.seated = true; s.pos = { ...LOC.desk };
    if (s.timer >= act.duration && !working) {
      if (agentState === 'idle' && Math.random() < 0.3) {
        s.queue = pickBreak(); advance(s);
      } else if (agentState === 'sleeping' && Math.random() < 0.1) {
        s.queue = pickBreak(); advance(s);
      } else {
        s.timer = 0;
        s.activity = { kind: 'seated', duration: 150 + Math.random() * 200 };
      }
    }
  } else if (act.kind === 'pouring') {
    s.seated = false;
    if (s.timer >= act.duration) { s.holding = act.item; advance(s); }
  } else if (act.kind === 'drinking') {
    s.seated = false;
    if (s.timer >= act.duration) { s.holding = null; advance(s); }
  } else if (act.kind === 'standing' || act.kind === 'stretching' || act.kind === 'looking') {
    s.seated = false;
    if (act.kind === 'looking') s.facing = (['right', 'up', 'left', 'down'] as const)[Math.floor(s.timer / 20) % 4];
    if (s.timer >= act.duration) advance(s);
  }

  return s;
}

// ============================================================
// SCENE DRAWING (640×640)
// ============================================================

const W = 640;

function drawBg(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, W);
}

// Room geometry — all positions derived from these
const ROOM = {
  cx: 320,             // center x
  top: 220,            // where walls meet (back corner y)
  wallH: 150,          // wall height
  halfW: 180,          // half-width of room diamond
  halfH: 90,           // half-height of room diamond (iso perspective)
};
// Derived corners
const ROOM_BACK = { x: ROOM.cx, y: ROOM.top };
const ROOM_LEFT = { x: ROOM.cx - ROOM.halfW, y: ROOM.top + ROOM.halfH };
const ROOM_RIGHT = { x: ROOM.cx + ROOM.halfW, y: ROOM.top + ROOM.halfH };
const ROOM_FRONT = { x: ROOM.cx, y: ROOM.top + ROOM.halfH * 2 };

function drawWalls(ctx: CanvasRenderingContext2D) {
  // Left wall
  ctx.fillStyle = C.wall;
  ctx.beginPath();
  ctx.moveTo(ROOM_LEFT.x, ROOM_LEFT.y);
  ctx.lineTo(ROOM_BACK.x, ROOM_BACK.y);
  ctx.lineTo(ROOM_BACK.x, ROOM_BACK.y - ROOM.wallH);
  ctx.lineTo(ROOM_LEFT.x, ROOM_LEFT.y - ROOM.wallH);
  ctx.closePath(); ctx.fill();
  // Right wall
  ctx.fillStyle = C.wallRight;
  ctx.beginPath();
  ctx.moveTo(ROOM_BACK.x, ROOM_BACK.y);
  ctx.lineTo(ROOM_RIGHT.x, ROOM_RIGHT.y);
  ctx.lineTo(ROOM_RIGHT.x, ROOM_RIGHT.y - ROOM.wallH);
  ctx.lineTo(ROOM_BACK.x, ROOM_BACK.y - ROOM.wallH);
  ctx.closePath(); ctx.fill();
  // Panel lines
  ctx.strokeStyle = C.wallLine; ctx.lineWidth = 0.5;
  for (let i = 1; i < 10; i++) {
    const t = i / 10;
    let x1 = ROOM_LEFT.x + t * ROOM.halfW, y1 = ROOM_LEFT.y - t * ROOM.halfH;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1, y1 - ROOM.wallH); ctx.stroke();
    x1 = ROOM_BACK.x + t * ROOM.halfW; y1 = ROOM_BACK.y + t * ROOM.halfH;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1, y1 - ROOM.wallH); ctx.stroke();
  }
}

function drawFloor(ctx: CanvasRenderingContext2D) {
  // Floor fills the room diamond exactly
  const floorCenter = { x: ROOM.cx, y: (ROOM_BACK.y + ROOM_FRONT.y) / 2 };

  // Clip to room shape
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ROOM_BACK.x, ROOM_BACK.y);
  ctx.lineTo(ROOM_RIGHT.x, ROOM_RIGHT.y);
  ctx.lineTo(ROOM_FRONT.x, ROOM_FRONT.y);
  ctx.lineTo(ROOM_LEFT.x, ROOM_LEFT.y);
  ctx.closePath();
  ctx.clip();

  // Tile the floor
  for (let i = -12; i <= 12; i++) {
    for (let j = -12; j <= 12; j++) {
      const fx = floorCenter.x + (i - j) * 10;
      const fy = floorCenter.y + (i + j) * 5;
      ctx.fillStyle = (i + j) % 2 === 0 ? C.floorLight : C.floorDark;
      ctx.beginPath();
      ctx.moveTo(fx, fy - 5); ctx.lineTo(fx + 10, fy);
      ctx.lineTo(fx, fy + 5); ctx.lineTo(fx - 10, fy);
      ctx.closePath(); ctx.fill();
    }
  }

  // Carpet (centered in room)
  const carpetScale = 0.45;
  const cw = ROOM.halfW * carpetScale, ch = ROOM.halfH * carpetScale;
  ctx.fillStyle = C.carpet;
  ctx.beginPath();
  ctx.moveTo(floorCenter.x, floorCenter.y - ch);
  ctx.lineTo(floorCenter.x + cw, floorCenter.y);
  ctx.lineTo(floorCenter.x, floorCenter.y + ch);
  ctx.lineTo(floorCenter.x - cw, floorCenter.y);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = C.carpetBorder; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(floorCenter.x, floorCenter.y - ch + 4);
  ctx.lineTo(floorCenter.x + cw - 6, floorCenter.y);
  ctx.lineTo(floorCenter.x, floorCenter.y + ch - 4);
  ctx.lineTo(floorCenter.x - cw + 6, floorCenter.y);
  ctx.closePath(); ctx.stroke();

  ctx.restore();
}

function drawLogo(ctx: CanvasRenderingContext2D) {
  const lx = 260, ly = 175;
  ctx.fillStyle = C.logoGreen;
  ctx.fillRect(lx - 20, ly - 8, 40, 16);
  ctx.strokeStyle = '#0f4020'; ctx.lineWidth = 1;
  ctx.strokeRect(lx - 20, ly - 8, 40, 16);
  ctx.fillStyle = '#d0d0c0';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('SC', lx, ly + 4);
  ctx.textAlign = 'start';
}

function drawDoor(ctx: CanvasRenderingContext2D) {
  const dx = 195, dy = 225;
  rect(ctx, dx, dy - 50, 18, 50, '#b0a898');
  rect(ctx, dx + 2, dy - 48, 14, 46, '#c8c0b4');
  rect(ctx, dx + 12, dy - 24, 4, 4, '#998877');
}

function drawCamera(ctx: CanvasRenderingContext2D, frame: number) {
  const ex = 430, ey = 240;
  ctx.fillStyle = '#444';
  ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = frame % 60 < 30 ? '#ff3333' : '#661111';
  ctx.beginPath(); ctx.arc(ex, ey, 2, 0, Math.PI * 2); ctx.fill();
}

function drawCoffeeMachine(ctx: CanvasRenderingContext2D) {
  const mx = 210, my = 385;
  rect(ctx, mx, my - 24, 16, 24, '#555');
  rect(ctx, mx + 2, my - 20, 12, 10, '#333');
  px(ctx, mx + 3, my - 9, 3, '#ff4444');
  rect(ctx, mx, my, 16, 3, '#666');
  ctx.fillStyle = '#777';
  ctx.font = '8px sans-serif';
  ctx.fillText('☕', mx + 1, my + 14);
}

function drawWaterCooler(ctx: CanvasRenderingContext2D) {
  const wx = 450, wy = 352;
  // Bottle
  rect(ctx, wx + 3, wy - 30, 10, 16, C.water);
  ctx.globalAlpha = 0.4; rect(ctx, wx + 3, wy - 30, 10, 16, '#fff'); ctx.globalAlpha = 1;
  // Body
  rect(ctx, wx, wy - 14, 16, 18, C.cooler);
  rect(ctx, wx, wy + 4, 16, 6, '#8a9aa8');
  px(ctx, wx + 6, wy - 6, 3, '#aaa');
}

function drawDeskCluster(ctx: CanvasRenderingContext2D) {
  const cx = 320, cy = 318;
  const desks = [
    { x: cx - 42, y: cy - 24 },
    { x: cx + 10, y: cy - 24 },
    { x: cx - 42, y: cy + 10 },
    { x: cx + 10, y: cy + 10 },
  ];
  for (const d of desks) {
    // Desk body
    rect(ctx, d.x - 4, d.y + 2, 32, 10, C.deskSide);
    rect(ctx, d.x - 4, d.y - 4, 32, 6, C.deskTop);
    // Monitor
    rect(ctx, d.x + 4, d.y - 22, 20, 16, C.monitor);
    rect(ctx, d.x + 6, d.y - 20, 16, 12, C.monScreen);
    rect(ctx, d.x + 12, d.y - 6, 6, 3, C.desk);
    // Keyboard
    rect(ctx, d.x + 4, d.y - 2, 16, 3, '#555');
  }
}

function drawEmptyDeskDetails(ctx: CanvasRenderingContext2D) {
  // NW desk — empty chair
  rect(ctx, 268, 306, 18, 10, C.chairSeat);
  // NE desk — coffee mug
  rect(ctx, 348, 288, 6, 6, C.mug);
  rect(ctx, 348, 287, 6, 3, '#a08060');
  // SW desk — paper stack
  rect(ctx, 282, 340, 10, 3, '#f0f0e8');
  rect(ctx, 282, 337, 10, 3, '#e8e8e0');
}

// ============================================================
// SEATED CHARACTER (at desk)
// ============================================================

function drawSeatedChar(ctx: CanvasRenderingContext2D, state: AgentState, frame: number) {
  const cx = 370, cy = 330;
  const bobY = state === 'sleeping' ? 4 : (state === 'idle' ? Math.sin(frame * 0.04) * 1.5 : 0);

  // Chair
  rect(ctx, cx - 10, cy + 6, 20, 12, C.chairSeat);
  rect(ctx, cx - 11, cy - 10, 3, 16, C.chair);
  rect(ctx, cx + 17, cy - 10, 3, 16, C.chair);
  rect(ctx, cx - 11, cy - 14, 22, 5, C.chair);

  // Body
  rect(ctx, cx - 6, cy - 12 + bobY, 16, 16, C.shirt);
  rect(ctx, cx + 1, cy - 12 + bobY, 5, 3, '#ccc8bc'); // collar

  // Arms
  if (state === 'coding' || state === 'browsing' || state === 'thinking') {
    const tL = (frame % 8 < 4) ? 0 : -3;
    const tR = (frame % 8 < 4) ? -3 : 0;
    rect(ctx, cx - 10, cy - 4 + bobY + tL, 5, 5, C.skin);
    rect(ctx, cx + 14, cy - 4 + bobY + tR, 5, 5, C.skin);
  } else if (state === 'sleeping') {
    rect(ctx, cx, cy - 18, 12, 4, C.skin);
  } else {
    rect(ctx, cx - 10, cy + bobY, 4, 8, C.skin);
    rect(ctx, cx + 15, cy + bobY, 4, 8, C.skin);
  }

  // Pants
  rect(ctx, cx - 3, cy + 4 + bobY, 8, 8, C.pants);
  rect(ctx, cx + 5, cy + 4 + bobY, 8, 8, C.pants);

  // Head
  if (state === 'sleeping') {
    // Head on desk
    const breathe = Math.sin(frame * 0.03) * 1;
    rect(ctx, cx + 1, cy - 22 + breathe, 12, 8, C.skin);
    rect(ctx, cx + 1, cy - 25 + breathe, 12, 4, C.hair);
  } else {
    rect(ctx, cx - 2, cy - 28 + bobY, 14, 14, C.skin);
    rect(ctx, cx - 2, cy - 31 + bobY, 14, 5, C.hair);
    rect(ctx, cx - 2, cy - 28 + bobY, 3, 8, C.hair);
    // Eyes + blink
    if (frame % 120 > 3) {
      px(ctx, cx + 1, cy - 22 + bobY, 3, '#2a2a2a');
      px(ctx, cx + 7, cy - 22 + bobY, 3, '#2a2a2a');
    }
    // Smile when working
    if (state === 'coding' || state === 'browsing') {
      px(ctx, cx + 4, cy - 17 + bobY, 3, '#c09080');
    }
  }
}

// --- Monitor content for agent's desk (SE desk) ---
function drawMonitorContent(ctx: CanvasRenderingContext2D, state: AgentState, frame: number) {
  const mx = 336, my = 298;
  const mw = 16, mh = 12;

  if (state === 'coding') {
    ctx.save();
    ctx.beginPath(); ctx.rect(mx, my, mw, mh); ctx.clip();
    const off = (frame * 0.4) % 10;
    for (let i = 0; i < 8; i++) {
      const w = 4 + ((frame + i * 5) % 10);
      rect(ctx, mx + 2, my - off + i * 4, w, 2, C.codeGreen);
    }
    ctx.restore();
  } else if (state === 'browsing') {
    ctx.save();
    ctx.beginPath(); ctx.rect(mx, my, mw, mh); ctx.clip();
    const off = (frame * 0.25) % 8;
    rect(ctx, mx + 2, my - off, 12, 2, C.newsBlue);
    rect(ctx, mx + 2, my - off + 4, 8, 2, C.newsBlue);
    rect(ctx, mx + 2, my - off + 8, 10, 2, C.newsBlue);
    rect(ctx, mx + 2, my - off + 12, 6, 2, C.newsBlue);
    ctx.restore();
  } else if (state === 'thinking') {
    const d = Math.floor(frame / 12) % 4;
    for (let i = 0; i < 3; i++) {
      if (i < d) px(ctx, mx + 3 + i * 4, my + 5, 3, C.screenGlow);
    }
  } else {
    // Screensaver
    const pulse = Math.sin(frame * 0.02) * 0.3 + 0.3;
    ctx.globalAlpha = pulse;
    rect(ctx, mx + 3, my + 3, 10, 6, '#0a3318');
    ctx.globalAlpha = 1;
  }
}

// ============================================================
// STANDING/WALKING CHARACTER
// ============================================================

function drawStandingChar(ctx: CanvasRenderingContext2D, cs: CharState) {
  const { pos, activity, walkFrame, facing, holding } = cs;
  const x = Math.round(pos.x), y = Math.round(pos.y);
  const isWalk = activity.kind === 'walking';
  const legP = isWalk ? Math.sin(walkFrame * 0.3) * 4 : 0;
  const armP = isWalk ? Math.sin(walkFrame * 0.3) * 3 : 0;
  const headB = isWalk ? Math.abs(Math.sin(walkFrame * 0.3)) * 1.5 : 0;
  const isStretch = activity.kind === 'stretching';
  const strP = isStretch ? Math.sin(cs.timer * 0.06) : 0;
  const isDrink = activity.kind === 'drinking';
  const drP = isDrink ? Math.sin(cs.timer * 0.08) : 0;
  const isPour = activity.kind === 'pouring';

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath(); ctx.ellipse(x + 4, y + 5, 10, 4, 0, 0, Math.PI * 2); ctx.fill();

  // Legs
  rect(ctx, x - 3, y - 6 + legP * 0.3, 6, 14, C.pants);
  rect(ctx, x + 5, y - 6 - legP * 0.3, 6, 14, C.pants);
  rect(ctx, x - 3, y + 7, 6, 3, C.shoes);
  rect(ctx, x + 5, y + 7, 6, 3, C.shoes);

  // Body
  const by = y - 20 - headB;
  rect(ctx, x - 5, by, 16, 16, C.shirt);
  rect(ctx, x + 1, by, 5, 3, '#ccc8bc');

  // Arms
  if (isStretch) {
    const up = strP * 12;
    rect(ctx, x - 9, by - up, 5, 10, C.shirt);
    rect(ctx, x + 12, by - up, 5, 10, C.shirt);
    rect(ctx, x - 9, by - up, 5, 4, C.skin);
    rect(ctx, x + 12, by - up, 5, 4, C.skin);
  } else if (isDrink && holding) {
    const mugUp = Math.abs(drP) * 7;
    rect(ctx, x - 9, by + 3 + armP, 5, 8, C.shirt);
    rect(ctx, x - 9, by + 9 + armP, 5, 4, C.skin);
    rect(ctx, x + 12, by - mugUp, 5, 8, C.shirt);
    rect(ctx, x + 12, by - mugUp, 5, 4, C.skin);
    rect(ctx, x + 12, by - mugUp - 6, 7, 7, C.mug);
    rect(ctx, x + 13, by - mugUp - 5, 5, 5, holding === 'coffee' ? C.coffee : C.water);
  } else if (isPour) {
    rect(ctx, x + 8, by + 3, 8, 4, C.skin);
    rect(ctx, x - 8, by + 5, 5, 7, C.shirt);
  } else if (holding) {
    rect(ctx, x - 9, by + 3 + armP, 5, 8, C.shirt);
    rect(ctx, x - 9, by + 9 + armP, 5, 4, C.skin);
    rect(ctx, x + 12, by + 3, 5, 8, C.shirt);
    rect(ctx, x + 12, by + 9, 5, 4, C.skin);
    rect(ctx, x + 13, by + 2, 7, 7, C.mug);
    rect(ctx, x + 14, by + 3, 5, 5, holding === 'coffee' ? C.coffee : C.water);
  } else {
    rect(ctx, x - 9, by + 3 + armP, 5, 8, C.shirt);
    rect(ctx, x - 9, by + 9 + armP, 5, 4, C.skin);
    rect(ctx, x + 12, by + 3 - armP, 5, 8, C.shirt);
    rect(ctx, x + 12, by + 9 - armP, 5, 4, C.skin);
  }

  // Head
  const hy = by - 16;
  rect(ctx, x - 2, hy, 14, 14, C.skin);
  rect(ctx, x - 2, hy - 3, 14, 5, C.hair);
  rect(ctx, x - 2, hy, 3, 8, C.hair);
  const eyeOff = facing === 'left' ? -2 : facing === 'up' ? 0 : 2;
  px(ctx, x + 2 + eyeOff, hy + 5, 3, '#2a2a2a');
  px(ctx, x + 8 + eyeOff, hy + 5, 3, '#2a2a2a');

  if (isStretch && strP > 0.5) {
    rect(ctx, x + 4, hy + 10, 4, 3, '#c08070');
  }
}

// ============================================================
// ACTIVITY BUBBLE
// ============================================================

function drawActivityBubble(ctx: CanvasRenderingContext2D, state: AgentState, detail: string, frame: number) {
  if (state !== 'coding' && state !== 'browsing' && state !== 'thinking') return;

  const bx = 430, by = 260;
  const bw = 160, bh = 44;

  // Bubble body
  ctx.fillStyle = C.bubble;
  ctx.strokeStyle = C.bubbleBorder;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(bx - bw / 2, by - bh / 2, bw, bh, 8);
  ctx.fill(); ctx.stroke();

  // Pointer
  ctx.fillStyle = C.bubble;
  ctx.beginPath();
  ctx.moveTo(bx - 12, by + bh / 2);
  ctx.lineTo(bx - 22, by + bh / 2 + 14);
  ctx.lineTo(bx, by + bh / 2);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = C.bubbleBorder;
  ctx.beginPath();
  ctx.moveTo(bx - 12, by + bh / 2);
  ctx.lineTo(bx - 22, by + bh / 2 + 14);
  ctx.lineTo(bx, by + bh / 2);
  ctx.stroke();
  rect(ctx, bx - 11, by + bh / 2 - 2, 12, 3, C.bubble);

  const labels: Record<string, { icon: string; label: string; color: string }> = {
    coding: { icon: '⌨️', label: 'Writing code', color: '#1a6b32' },
    browsing: { icon: '🌐', label: 'Browsing web', color: '#2266aa' },
    thinking: { icon: '💭', label: 'Thinking', color: '#aa7722' },
  };
  const info = labels[state] || labels.thinking;
  const dots = '.'.repeat((Math.floor(frame / 15) % 3) + 1);

  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = info.color;
  ctx.fillText(`${info.icon} ${info.label}${dots}`, bx, by - 2);

  if (detail) {
    ctx.font = '10px monospace';
    ctx.fillStyle = '#888';
    ctx.fillText(detail.length > 24 ? detail.slice(0, 24) + '…' : detail, bx, by + 14);
  }
  ctx.textAlign = 'start';
}

// --- ZZZ ---
function drawZzz(ctx: CanvasRenderingContext2D, frame: number) {
  ctx.font = '14px monospace';
  const phase = frame * 0.02;
  for (let i = 0; i < 3; i++) {
    const t = (phase + i * 0.7) % 2;
    ctx.globalAlpha = (t < 1 ? t : 2 - t) * 0.85;
    ctx.fillStyle = C.zzz;
    ctx.fillText('z', 395 + i * 14, 275 - t * 22 - i * 10);
  }
  ctx.globalAlpha = 1;
}

// --- Status bar ---
function drawStatusBar(ctx: CanvasRenderingContext2D, state: AgentState, statusText: string, cs: CharState) {
  rect(ctx, 0, W - 44, W, 44, 'rgba(0,0,0,0.75)');

  const colors: Record<AgentState, string> = {
    coding: '#44ff77', browsing: '#66aaff', thinking: '#ffaa44',
    idle: '#88cc88', sleeping: '#555555',
  };
  ctx.fillStyle = colors[state];
  ctx.beginPath(); ctx.arc(26, W - 22, 7, 0, Math.PI * 2); ctx.fill();

  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = '#ccddcc';
  const label = !cs.seated && cs.activity.kind !== 'seated' ? activityLabel(cs) : state.toUpperCase();
  ctx.fillText(label, 42, W - 17);

  ctx.font = '11px monospace';
  ctx.fillStyle = '#778877';
  ctx.fillText(statusText, 180, W - 17);

  ctx.textAlign = 'right';
  ctx.font = '11px monospace';
  ctx.fillStyle = '#556655';
  ctx.fillText('👙🦞 SkimpyClaw', W - 16, W - 17);
  ctx.textAlign = 'start';
}

function activityLabel(cs: CharState): string {
  switch (cs.activity.kind) {
    case 'walking': return cs.holding ? `CARRYING ${cs.holding.toUpperCase()}` : 'WALKING';
    case 'pouring': return `GETTING ${(cs.activity as any).item.toUpperCase()}`;
    case 'drinking': return `DRINKING ${(cs.activity as any).item.toUpperCase()}`;
    case 'stretching': return 'STRETCHING';
    case 'looking': return 'LOOKING AROUND';
    default: return 'IDLE';
  }
}

// ============================================================
// MAIN RENDER
// ============================================================

function renderFrame(ctx: CanvasRenderingContext2D, state: AgentState, statusText: string, cs: CharState, frame: number) {
  drawBg(ctx);
  drawWalls(ctx);
  drawLogo(ctx);
  drawDoor(ctx);
  drawCamera(ctx, frame);
  drawFloor(ctx);
  drawCoffeeMachine(ctx);
  drawWaterCooler(ctx);
  drawDeskCluster(ctx);
  drawEmptyDeskDetails(ctx);

  if (cs.seated) {
    drawSeatedChar(ctx, state, frame);
    drawMonitorContent(ctx, state, frame);
    if (state === 'sleeping') drawZzz(ctx, frame);
    drawActivityBubble(ctx, state, statusText, frame);
  } else {
    drawStandingChar(ctx, cs);
  }

  drawStatusBar(ctx, state, statusText, cs);
}

// ============================================================
// API STATE DETECTION
// ============================================================

function deriveState(status: any, codeAgents: any[], recentAudit: any[]): { state: AgentState; text: string } {
  // Active coding agents?
  const active = (codeAgents || []).filter((a: any) => a.status === 'running');
  if (active.length > 0) return { state: 'coding', text: `${active.length} coding agent(s)` };

  // Check recent audit traces (last 2 min = active)
  const now = Date.now();
  const recentTraces = (recentAudit || []).filter((t: any) => {
    const started = new Date(t.startedAt || t.createdAt || 0).getTime();
    return now - started < 120_000;
  });

  if (recentTraces.length > 0) {
    const latest = recentTraces[0];
    const trigger = latest.trigger || 'unknown';

    // Still processing (no completedAt or status is running)
    if (!latest.completedAt || latest.status === 'running') {
      if (trigger === 'cron') return { state: 'browsing', text: `Cron: ${latest.jobId || latest.cronJobId || 'job'}` };
      if (trigger === 'heartbeat') return { state: 'thinking', text: 'Heartbeat check' };
      return { state: 'thinking', text: 'Processing...' };
    }

    // Completed recently
    if (trigger === 'cron') return { state: 'browsing', text: `Ran: ${latest.jobId || latest.cronJobId || 'cron job'}` };
    if (trigger === 'discord' || trigger === 'telegram') return { state: 'thinking', text: `Chat reply` };
  }

  // Check lastMessage timestamp from status
  const lastMsg = status?.lastMessage;
  if (lastMsg) {
    const mins = Math.floor((now - new Date(lastMsg).getTime()) / 60000);
    if (mins < 2) return { state: 'thinking', text: `Active ${mins}m ago` };
    if (mins < 30) return { state: 'idle', text: `Last active ${mins}m ago` };
    if (mins < 120) return { state: 'idle', text: `Idle ${mins}m` };
    return { state: 'sleeping', text: `Sleeping ${Math.floor(mins / 60)}h` };
  }

  return { state: 'idle', text: status?.model ? `Model: ${status.model}` : 'Standing by' };
}

// ============================================================
// COMPONENT
// ============================================================

export function Office() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const charRef = useRef<CharState>(initChar());
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [statusText, setStatusText] = useState('Initializing...');
  const animRef = useRef<number>(0);

  const poll = useCallback(async () => {
    try {
      const [status, agents, audit] = await Promise.all([
        getStatus().catch(() => null),
        getCodeAgents().catch(() => []),
        getAudit({ limit: 5 }).catch(() => ({ traces: [] })),
      ]);
      const traces = (audit as any)?.traces || [];
      const { state, text } = deriveState(status, agents as any[], traces);
      setAgentState(state);
      setStatusText(text);
    } catch {
      setStatusText('Offline');
    }
  }, []);

  useEffect(() => {
    poll();
    const iv = setInterval(poll, 5000); // poll every 5s for responsiveness
    return () => clearInterval(iv);
  }, [poll]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    function animate() {
      frameRef.current++;
      charRef.current = tickChar(charRef.current, agentState);
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
            fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--mono)',
          }}>
            Macrodata Refinement · Floor 7
          </span>
        </div>
      </div>

      <div style={{
        display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '8px 0',
      }}>
        <canvas
          ref={canvasRef}
          width={W}
          height={W}
          style={{
            width: 'min(100%, 800px)',
            aspectRatio: '1',
            imageRendering: 'pixelated',
            borderRadius: '12px',
            border: '2px solid var(--border)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          }}
        />
      </div>

      <div style={{
        textAlign: 'center', marginTop: 8,
        fontFamily: 'var(--mono)', fontSize: 13,
        color: 'var(--text-muted)', letterSpacing: '0.04em',
      }}>
        Please enjoy each state equally.
      </div>
    </div>
  );
}
