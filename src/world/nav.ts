import { Vec } from '../core/vec';
import { Compiled, cellCenter } from './compile';
import { DIRS, Dir, rotateCW, opposite } from './tiles';

/**
 * Routing on the fine nav grid. Rules (one-way, keep right, keep off walls, portal direction)
 * are *costs*, not hard constraints, so a driver with low rule compliance can still break them.
 */
export interface RouteOptions {
  /** Extra cost per cell for driving against a one-way arrow or the wrong way through a portal. */
  wrongWayPenalty: number;
  /** Optional per-cell extra cost (e.g. cells occupied by a car we're stuck behind). */
  extraCost?: Float32Array;
  /** The car's current heading (radians). Turning away from it costs extra, so no U-turns. */
  startHeading?: number;
}

/** 8 move directions, index k is angle k*45deg (y points down): E, SE, S, SW, W, NW, N, NE. */
const MOVES: { dx: number; dy: number; cost: number; axes: Dir[] }[] = [
  { dx: 1, dy: 0, cost: 1, axes: ['E'] },
  { dx: 1, dy: 1, cost: Math.SQRT2, axes: ['E', 'S'] },
  { dx: 0, dy: 1, cost: 1, axes: ['S'] },
  { dx: -1, dy: 1, cost: Math.SQRT2, axes: ['W', 'S'] },
  { dx: -1, dy: 0, cost: 1, axes: ['W'] },
  { dx: -1, dy: -1, cost: Math.SQRT2, axes: ['W', 'N'] },
  { dx: 0, dy: -1, cost: 1, axes: ['N'] },
  { dx: 1, dy: -1, cost: Math.SQRT2, axes: ['E', 'N'] },
];
/** Cost of changing direction by 0, 45, 90, 135, 180 degrees between steps. */
const TURN_COST = [0, 0.6, 1.5, 6, 20];

function keepRightCost(c: Compiled, j: number, dir: Dir): number {
  const right = rotateCW(dir);
  const left = opposite(right);
  const dr = c.wallDist[right][j];
  const dl = c.wallDist[left][j];
  // Inside an intersection (open on a side) there are no lanes to keep to.
  if (dr + dl > 8) return 0;
  let cost = 0;
  if (dr > dl) cost += 1.2;
  if (dr > 2) cost += Math.min((dr - 2) * 0.6, 1.8);
  return cost;
}

function staticStepCost(c: Compiled, j: number, mv: (typeof MOVES)[number], wrongWayPenalty: number): number {
  const { dx, dy } = mv;
  let cost = 0;
  // Stay off walls / parked noses.
  if (c.clearance[j] <= 1) cost += 3;

  const ow = c.oneWay[j];
  if (ow >= 0) {
    const d = DIRS[ow];
    const along = (d === 'E' ? dx : d === 'W' ? -dx : 0) + (d === 'S' ? dy : d === 'N' ? -dy : 0);
    if (along < 0) cost += wrongWayPenalty;
  } else if (!c.portalKind[j]) {
    let kr = 0;
    for (const a of mv.axes) kr += keepRightCost(c, j, a);
    cost += kr / mv.axes.length;
  }

  const pk = c.portalKind[j];
  if (pk) {
    const f = DIRS[c.portalFacing[j]];
    const outward = (f === 'E' ? dx : f === 'W' ? -dx : 0) + (f === 'S' ? dy : f === 'N' ? -dy : 0);
    if (pk === 1 && outward > 0) cost += wrongWayPenalty; // driving out through the entrance
    if (pk === 2 && outward < 0) cost += wrongWayPenalty; // driving in through the exit
  }
  return cost;
}

/** Cost of entering cell j with move k, precomputed per layout and rule-compliance level. */
const staticCache = new WeakMap<Compiled, Map<number, Float32Array>>();
function staticCosts(c: Compiled, wrongWayPenalty: number): Float32Array {
  let byPenalty = staticCache.get(c);
  if (!byPenalty) staticCache.set(c, (byPenalty = new Map()));
  let arr = byPenalty.get(wrongWayPenalty);
  if (!arr) {
    const n = c.cols * c.rows;
    arr = new Float32Array(n * 8);
    for (let j = 0; j < n; j++) {
      if (!c.drivable[j]) continue;
      for (let k = 0; k < 8; k++) arr[j * 8 + k] = MOVES[k].cost + staticStepCost(c, j, MOVES[k], wrongWayPenalty);
    }
    byPenalty.set(wrongWayPenalty, arr);
  }
  return arr;
}

/** Binary min-heap over (state, priority) using typed arrays. */
class MinHeap {
  private keys = new Float64Array(1024);
  private vals = new Int32Array(1024);
  size = 0;
  push(val: number, key: number) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    const k = this.keys;
    const vs = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      vs[i] = vs[p];
      i = p;
    }
    k[i] = key;
    vs[i] = val;
  }
  pop(): number {
    const k = this.keys;
    const vs = this.vals;
    const top = vs[0];
    const n = --this.size;
    if (n > 0) {
      const lk = k[n];
      const lv = vs[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && k[r] < k[l] ? r : l;
        if (k[m] >= lk) break;
        k[i] = k[m];
        vs[i] = vs[m];
        i = m;
      }
      k[i] = lk;
      vs[i] = lv;
    }
    return top;
  }
}

export interface Route {
  cells: number[];
  cost: number;
}

/**
 * A* from `start` to any cell in `goals`. The search state is (cell, direction of travel), so
 * turning has a cost and routes come out as smooth, drivable lines rather than zigzags.
 */
export function findRoute(c: Compiled, start: number, goals: number[], opts: RouteOptions): Route | null {
  if (start < 0 || goals.length === 0) return null;
  const n = c.cols * c.rows;
  const goalSet = new Set(goals);
  const goalXY = goals.map((g) => [g % c.cols, Math.floor(g / c.cols)]);
  const h = (i: number) => {
    const x = i % c.cols;
    const y = Math.floor(i / c.cols);
    let best = Infinity;
    for (const [gx, gy] of goalXY) {
      const ax = Math.abs(gx - x);
      const ay = Math.abs(gy - y);
      const d = Math.max(ax, ay) + (Math.SQRT2 - 1) * Math.min(ax, ay);
      if (d < best) best = d;
    }
    return best;
  };
  const base = staticCosts(c, opts.wrongWayPenalty);
  const extra = opts.extraCost;
  const g = new Float64Array(n * 8).fill(Infinity);
  const came = new Int32Array(n * 8).fill(-1);
  const closed = new Uint8Array(n * 8);
  const heap = new MinHeap();
  if (opts.startHeading !== undefined) {
    const k = (((Math.round(opts.startHeading / (Math.PI / 4)) % 8) + 8) % 8);
    g[start * 8 + k] = 0;
    heap.push(start * 8 + k, h(start));
  } else {
    for (let k = 0; k < 8; k++) {
      g[start * 8 + k] = 0;
      heap.push(start * 8 + k, h(start));
    }
  }
  while (heap.size) {
    const st = heap.pop();
    if (closed[st]) continue;
    closed[st] = 1;
    const i = st >> 3;
    const k0 = st & 7;
    if (goalSet.has(i)) {
      const cells: number[] = [];
      for (let q = st; q >= 0; q = came[q]) {
        const cell = q >> 3;
        if (cells[cells.length - 1] !== cell) cells.push(cell);
      }
      cells.reverse();
      return { cells, cost: g[st] };
    }
    const x = i % c.cols;
    const y = Math.floor(i / c.cols);
    for (let k = 0; k < 8; k++) {
      const mv = MOVES[k];
      const nx = x + mv.dx;
      const ny = y + mv.dy;
      if (nx < 0 || ny < 0 || nx >= c.cols || ny >= c.rows) continue;
      const j = ny * c.cols + nx;
      const ns = j * 8 + k;
      if (!c.drivable[j] || closed[ns]) continue;
      // Don't cut diagonally across a wall corner.
      if (mv.axes.length === 2 && (!c.drivable[y * c.cols + nx] || !c.drivable[ny * c.cols + x])) continue;
      const turn = Math.min(Math.abs(k - k0), 8 - Math.abs(k - k0));
      const ng = g[st] + base[ns] + TURN_COST[turn] + (extra ? extra[j] : 0);
      if (ng < g[ns]) {
        g[ns] = ng;
        came[ns] = st;
        heap.push(ns, ng + h(j));
      }
    }
  }
  return null;
}

/** Turn a cell route into a smoothed polyline of world points. */
export function routeToPoints(c: Compiled, route: Route): Vec[] {
  let pts = route.cells.map((i) => cellCenter(c, i));
  // Chaikin corner cutting, keeping endpoints.
  for (let iter = 0; iter < 2 && pts.length > 2; iter++) {
    const out: Vec[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
