import { Vec } from '../core/vec';
import { Car, Simulation } from '../sim/sim';
import { bodyCorners } from '../sim/vehicle';
import { CELL, Compiled } from '../world/compile';
import { DIR_VEC, Design, Dir, TILE, getTile } from '../world/tiles';

export interface Overlays {
  heat: boolean;
  nav: boolean;
  incidents: boolean;
}

export interface View {
  /** Pixels per meter. */
  ppm: number;
  ox: number;
  oy: number;
}

/** Extra rows of street drawn below the lot. */
export const STREET_TILES = 3;

const C = {
  grass: '#a9c98a',
  grassDark: '#9cbd7c',
  asphalt: '#4b5058',
  asphaltLight: '#565c65',
  line: 'rgba(255,255,255,0.85)',
  arrow: 'rgba(255,255,255,0.45)',
  sidewalk: '#cfc9bd',
  building: '#b9926f',
  buildingEdge: '#8f6d50',
  door: '#f2c14e',
  island: '#6fa356',
  street: '#3b3f45',
  entrance: '#4caf50',
  exit: '#e05a47',
};

export function drawDesign(ctx: CanvasRenderingContext2D, d: Design, view: View) {
  const t = TILE * view.ppm;
  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.fillStyle = C.grass;
  ctx.fillRect(0, 0, d.width * t, d.height * t);
  // Street below the lot.
  ctx.fillStyle = C.street;
  ctx.fillRect(-t, d.height * t, (d.width + 2) * t, STREET_TILES * t);
  ctx.strokeStyle = 'rgba(255,220,120,0.7)';
  ctx.setLineDash([t * 0.8, t * 0.6]);
  ctx.lineWidth = Math.max(1, t * 0.06);
  ctx.beginPath();
  ctx.moveTo(-t, (d.height + STREET_TILES / 2) * t);
  ctx.lineTo((d.width + 1) * t, (d.height + STREET_TILES / 2) * t);
  ctx.stroke();
  ctx.setLineDash([]);

  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const tile = getTile(d, x, y);
      const px = x * t;
      const py = y * t;
      switch (tile.kind) {
        case 'empty':
          if ((x + y) % 2 === 0) {
            ctx.fillStyle = C.grassDark;
            ctx.fillRect(px, py, t, t);
          }
          break;
        case 'aisle':
          ctx.fillStyle = C.asphalt;
          ctx.fillRect(px, py, t + 0.5, t + 0.5);
          if (tile.oneWay) drawArrow(ctx, px + t / 2, py + t / 2, tile.oneWay, t * 0.32, C.arrow);
          break;
        case 'spot':
          ctx.fillStyle = C.asphaltLight;
          ctx.fillRect(px, py, t + 0.5, t + 0.5);
          break;
        case 'entrance':
        case 'exit':
          ctx.fillStyle = C.asphalt;
          ctx.fillRect(px, py, t + 0.5, t + 0.5);
          drawArrow(
            ctx,
            px + t / 2,
            py + t / 2,
            tile.kind === 'entrance' ? oppositeDir(tile.facing) : tile.facing,
            t * 0.3,
            tile.kind === 'entrance' ? C.entrance : C.exit,
          );
          // Connect to the street visually.
          if (tile.facing === 'S' && y === d.height - 1) {
            ctx.fillStyle = C.asphalt;
            ctx.fillRect(px, py + t, t + 0.5, t * 0.6);
          }
          break;
        case 'sidewalk':
          ctx.fillStyle = C.sidewalk;
          ctx.fillRect(px, py, t + 0.5, t + 0.5);
          break;
        case 'island':
          ctx.fillStyle = C.island;
          ctx.fillRect(px, py, t + 0.5, t + 0.5);
          break;
        case 'building':
          ctx.fillStyle = C.building;
          ctx.fillRect(px, py, t + 0.5, t + 0.5);
          break;
        case 'door':
          ctx.fillStyle = C.building;
          ctx.fillRect(px, py, t + 0.5, t + 0.5);
          ctx.fillStyle = C.door;
          ctx.fillRect(px + t * 0.15, py + t * 0.45, t * 0.7, t * 0.55);
          break;
      }
    }
  }

  // Stall lines: draw the two sides and the back of each spot (open at the mouth).
  ctx.strokeStyle = C.line;
  ctx.lineWidth = Math.max(1, t * 0.05);
  ctx.beginPath();
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const tile = getTile(d, x, y);
      if (tile.kind !== 'spot' || !tile.head) continue;
      const f = DIR_VEC[tile.facing];
      const tx = x - f.x;
      const ty = y - f.y;
      const x0 = Math.min(x, tx) * t;
      const y0 = Math.min(y, ty) * t;
      const w = (Math.abs(tx - x) + 1) * t;
      const h = (Math.abs(ty - y) + 1) * t;
      // Rectangle edges; skip the mouth edge.
      const edges: [number, number, number, number, Dir][] = [
        [x0, y0, x0 + w, y0, 'N'],
        [x0 + w, y0, x0 + w, y0 + h, 'E'],
        [x0, y0 + h, x0 + w, y0 + h, 'S'],
        [x0, y0, x0, y0 + h, 'W'],
      ];
      for (const [ax, ay, bx, by, side] of edges) {
        if (side === tile.facing) continue;
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
    }
  }
  ctx.stroke();

  // Building roof outline.
  ctx.strokeStyle = C.buildingEdge;
  ctx.lineWidth = Math.max(1, t * 0.04);
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const k = getTile(d, x, y).kind;
      if (k !== 'building' && k !== 'door') continue;
      for (const dir of ['N', 'E', 'S', 'W'] as Dir[]) {
        const nk = getTile(d, x + DIR_VEC[dir].x, y + DIR_VEC[dir].y).kind;
        if (nk === 'building' || nk === 'door') continue;
        ctx.beginPath();
        const px = x * t;
        const py = y * t;
        if (dir === 'N') { ctx.moveTo(px, py); ctx.lineTo(px + t, py); }
        if (dir === 'S') { ctx.moveTo(px, py + t); ctx.lineTo(px + t, py + t); }
        if (dir === 'W') { ctx.moveTo(px, py); ctx.lineTo(px, py + t); }
        if (dir === 'E') { ctx.moveTo(px + t, py); ctx.lineTo(px + t, py + t); }
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

const oppositeDir = (d: Dir): Dir => ({ N: 'S', S: 'N', E: 'W', W: 'E' })[d] as Dir;

export function drawArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, dir: Dir, size: number, color: string) {
  const v = DIR_VEC[dir];
  const px = -v.y;
  const py = v.x;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx + v.x * size, cy + v.y * size);
  ctx.lineTo(cx - v.x * size * 0.6 + px * size * 0.75, cy - v.y * size * 0.6 + py * size * 0.75);
  ctx.lineTo(cx - v.x * size * 0.2, cy - v.y * size * 0.2);
  ctx.lineTo(cx - v.x * size * 0.6 - px * size * 0.75, cy - v.y * size * 0.6 - py * size * 0.75);
  ctx.closePath();
  ctx.fill();
}

export function drawNav(ctx: CanvasRenderingContext2D, w: Compiled, view: View) {
  const c = CELL * view.ppm;
  ctx.save();
  ctx.translate(view.ox, view.oy);
  for (let i = 0; i < w.cols * w.rows; i++) {
    if (!w.drivable[i]) continue;
    const x = (i % w.cols) * c;
    const y = Math.floor(i / w.cols) * c;
    const cl = w.clearance[i];
    ctx.fillStyle = cl <= 1 ? 'rgba(255,80,80,0.28)' : cl === 2 ? 'rgba(255,200,80,0.22)' : 'rgba(120,200,255,0.18)';
    ctx.fillRect(x + 1, y + 1, c - 2, c - 2);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (const s of w.spots) {
    if (s.approachCell < 0) {
      ctx.fillStyle = 'rgba(255,60,60,0.9)';
      const p = s.center;
      ctx.beginPath();
      ctx.arc(p.x * view.ppm, p.y * view.ppm, c * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export function drawHeat(ctx: CanvasRenderingContext2D, sim: Simulation, view: View) {
  const d = sim.world.design;
  const t = TILE * view.ppm;
  let max = 0;
  for (const h of sim.heat) max = Math.max(max, h);
  if (max <= 0) return;
  ctx.save();
  ctx.translate(view.ox, view.oy);
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const h = sim.heat[y * d.width + x] / max;
      if (h < 0.02) continue;
      const a = Math.min(0.75, 0.15 + h * 0.7);
      const g = Math.round(220 * (1 - h));
      ctx.fillStyle = `rgba(255,${g},40,${a})`;
      ctx.fillRect(x * t, y * t, t, t);
    }
  }
  ctx.restore();
}

export function drawIncidents(ctx: CanvasRenderingContext2D, sim: Simulation, view: View) {
  ctx.save();
  ctx.translate(view.ox, view.oy);
  const r = view.ppm * 0.9;
  for (const e of sim.events) {
    if (e.type === 'near_miss' || e.type === 'contact') {
      ctx.fillStyle = e.type === 'contact' ? 'rgba(220,30,30,0.9)' : 'rgba(255,170,0,0.85)';
      ctx.beginPath();
      ctx.arc(e.x * view.ppm, e.y * view.ppm, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.type === 'standoff_start' || e.type === 'gridlock') {
      ctx.strokeStyle = e.type === 'gridlock' ? 'rgba(220,30,30,0.95)' : 'rgba(255,120,200,0.9)';
      ctx.lineWidth = Math.max(1.5, view.ppm * 0.25);
      const x = e.x * view.ppm;
      const y = e.y * view.ppm;
      ctx.beginPath();
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawCars(ctx: CanvasRenderingContext2D, sim: Simulation, view: View, selected: number, standoffCars: Set<number>) {
  ctx.save();
  ctx.translate(view.ox, view.oy);
  const s = view.ppm;
  for (const car of sim.cars.values()) {
    const corners = bodyCorners(car.vc, car.rear, car.heading).map((p) => ({ x: p.x * s, y: p.y * s }));
    ctx.fillStyle = car.color;
    poly(ctx, corners);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Windshield toward the front.
    const [rl, fl, fr, rr] = corners;
    const lerp = (a: Vec, b: Vec, k: number) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
    ctx.fillStyle = 'rgba(20,30,45,0.65)';
    poly(ctx, [lerp(rl, fl, 0.58), lerp(rl, fl, 0.74), lerp(rr, fr, 0.74), lerp(rr, fr, 0.58)]);
    ctx.fill();
    // Brake / reverse lights.
    const moving = car.mode !== 'parked';
    if (moving && car.speed < -0.05) {
      ctx.fillStyle = '#ffffff';
      dot(ctx, lerp(rl, rr, 0.18), s * 0.22);
      dot(ctx, lerp(rl, rr, 0.82), s * 0.22);
    } else if (moving && Math.abs(car.speed) < 0.3) {
      ctx.fillStyle = '#ff2a2a';
      dot(ctx, lerp(rl, rr, 0.18), s * 0.2);
      dot(ctx, lerp(rl, rr, 0.82), s * 0.2);
    }
    if (car.mode === 'searching') {
      ctx.strokeStyle = 'rgba(255,235,120,0.9)';
      ctx.lineWidth = Math.max(1, s * 0.15);
      poly(ctx, corners);
      ctx.stroke();
    }
    if (standoffCars.has(car.id)) {
      ctx.strokeStyle = '#ff3b6b';
      ctx.lineWidth = Math.max(1.5, s * 0.25);
      poly(ctx, corners);
      ctx.stroke();
    }
    if (car.id === selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(2, s * 0.3);
      poly(ctx, corners);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawSelected(ctx: CanvasRenderingContext2D, car: Car | undefined, sim: Simulation, view: View) {
  if (!car) return;
  const s = view.ppm;
  ctx.save();
  ctx.translate(view.ox, view.oy);
  if (car.path) {
    ctx.strokeStyle = car.path.reverse ? 'rgba(255,255,255,0.9)' : 'rgba(120,220,255,0.95)';
    ctx.lineWidth = Math.max(1.5, s * 0.2);
    ctx.setLineDash(car.path.reverse ? [s * 0.6, s * 0.4] : []);
    ctx.beginPath();
    car.path.pts.forEach((p, i) => (i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s)));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  for (const c of car.corridor) {
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(c.circ[2 * k] * s, c.circ[2 * k + 1] * s, (car.vc.width / 2) * s, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (car.mode === 'searching') {
    ctx.strokeStyle = 'rgba(255,235,120,0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(car.rear.x * s, car.rear.y * s, sim.cfg.sightRange * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (car.spot >= 0) {
    const sp = sim.world.spots[car.spot];
    ctx.strokeStyle = 'rgba(120,220,255,0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect((sp.center.x - 1.1) * s, (sp.center.y - 1.1) * s, 2.2 * s, 2.2 * s);
  }
  const other = sim.cars.get(car.blockedBy);
  if (other) {
    ctx.strokeStyle = car.blockKind === 'yield' ? 'rgba(255,200,0,0.9)' : 'rgba(255,60,60,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(car.rear.x * s, car.rear.y * s);
    ctx.lineTo(other.rear.x * s, other.rear.y * s);
    ctx.stroke();
  }
  ctx.restore();
}

function poly(ctx: CanvasRenderingContext2D, pts: Vec[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

function dot(ctx: CanvasRenderingContext2D, p: Vec, r: number) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}
