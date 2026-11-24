import { Vec, add, scale, v } from '../core/vec';
import {
  DIRS,
  DIR_VEC,
  Design,
  Dir,
  TILE,
  Tile,
  blocksSight,
  getTile,
  isDrivable,
  isWalkable,
} from './tiles';

/** Navigation runs on a fine grid: each tile is split into 2x2 cells of 1.25 m. */
export const SUB = 2;
export const CELL = TILE / SUB;

export interface SpotInfo {
  id: number;
  /** Tile coordinates of the spot's head (mouth) tile. */
  headX: number;
  headY: number;
  facing: Dir;
  /** Unit vector pointing out of the spot toward the aisle. */
  out: Vec;
  /** Center of the 2.5 x 5 m stall. */
  center: Vec;
  /** Midpoint of the stall's open edge. */
  mouth: Vec;
  /** Nav cell in the aisle right in front of the spot, or -1 if the spot doesn't open onto an aisle. */
  approachCell: number;
  /** Walking distance (m) from the stall to the nearest door. Infinity if unreachable. */
  walkDist: number;
}

export interface Portal {
  kind: 'entrance' | 'exit';
  facing: Dir;
  /** Fine cells covered by this portal. */
  cells: number[];
  /** Midpoint of the portal's outer edge (where the lot meets the street). */
  edge: Vec;
  /** Point on the street 5 m beyond the edge. */
  street: Vec;
}

export interface Compiled {
  design: Design;
  cols: number;
  rows: number;
  drivable: Uint8Array;
  /** Chebyshev distance (in cells) to the nearest non-drivable cell. */
  clearance: Uint8Array;
  /** Cells until a non-drivable cell, per direction N, E, S, W. */
  wallDist: Record<Dir, Uint8Array>;
  /** One-way direction per cell as DIRS index, -1 for two-way. */
  oneWay: Int8Array;
  /** 0 = normal, 1 = entrance, 2 = exit. */
  portalKind: Uint8Array;
  /** Facing (DIRS index) of the portal a cell belongs to. */
  portalFacing: Int8Array;
  spots: SpotInfo[];
  entrances: Portal[];
  exits: Portal[];
  doors: Vec[];
  /** Fine cells that make sensible wander targets for drivers searching for a spot. */
  wanderCells: number[];
  /** Per-tile flag: blocks line of sight. */
  sightBlock: Uint8Array;
  warnings: string[];
}

export const cellCenter = (c: Compiled, idx: number): Vec =>
  v(((idx % c.cols) + 0.5) * CELL, (Math.floor(idx / c.cols) + 0.5) * CELL);

export function cellAt(c: Compiled, p: Vec): number {
  const cx = Math.floor(p.x / CELL);
  const cy = Math.floor(p.y / CELL);
  if (cx < 0 || cy < 0 || cx >= c.cols || cy >= c.rows) return -1;
  return cy * c.cols + cx;
}

/** Nearest drivable cell to a world point (searches outward in rings). */
export function nearestDrivable(c: Compiled, p: Vec): number {
  const cx = Math.min(c.cols - 1, Math.max(0, Math.floor(p.x / CELL)));
  const cy = Math.min(c.rows - 1, Math.max(0, Math.floor(p.y / CELL)));
  for (let r = 0; r < Math.max(c.cols, c.rows); r++) {
    let best = -1;
    let bestD = Infinity;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        if (x < 0 || y < 0 || x >= c.cols || y >= c.rows) continue;
        const i = y * c.cols + x;
        if (!c.drivable[i]) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

const tileCenter = (x: number, y: number): Vec => v((x + 0.5) * TILE, (y + 0.5) * TILE);

export function compile(design: Design): Compiled {
  const cols = design.width * SUB;
  const rows = design.height * SUB;
  const n = cols * rows;
  const drivable = new Uint8Array(n);
  const oneWay = new Int8Array(n).fill(-1);
  const portalKind = new Uint8Array(n);
  const portalFacing = new Int8Array(n).fill(-1);
  const warnings: string[] = [];

  const forTileCells = (tx: number, ty: number, fn: (i: number) => void) => {
    for (let sy = 0; sy < SUB; sy++)
      for (let sx = 0; sx < SUB; sx++) fn((ty * SUB + sy) * cols + tx * SUB + sx);
  };

  for (let ty = 0; ty < design.height; ty++) {
    for (let tx = 0; tx < design.width; tx++) {
      const t = getTile(design, tx, ty);
      if (!isDrivable(t)) continue;
      forTileCells(tx, ty, (i) => {
        drivable[i] = 1;
        if (t.kind === 'aisle' && t.oneWay) oneWay[i] = DIRS.indexOf(t.oneWay);
        if (t.kind === 'entrance' || t.kind === 'exit') {
          portalKind[i] = t.kind === 'entrance' ? 1 : 2;
          portalFacing[i] = DIRS.indexOf(t.facing);
        }
      });
    }
  }

  // Clearance: multi-source BFS from non-drivable cells (grid border counts as a wall,
  // except along portals' outer edges, which open onto the street).
  const clearance = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  const dist = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!drivable[i]) {
      dist[i] = 0;
      queue[qt++] = i;
    }
  }
  // Border cells next to the outside of the grid get clearance 1 unless they're portals.
  for (let i = 0; i < n; i++) {
    if (!drivable[i] || dist[i] >= 0) continue;
    const x = i % cols;
    const y = Math.floor(i / cols);
    const onBorder = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
    if (onBorder && !portalKind[i]) {
      dist[i] = 1;
      queue[qt++] = i;
    }
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % cols;
    const y = Math.floor(i / cols);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const j = ny * cols + nx;
        if (dist[j] >= 0) continue;
        dist[j] = dist[i] + 1;
        queue[qt++] = j;
      }
    }
  }
  for (let i = 0; i < n; i++) clearance[i] = Math.min(255, Math.max(0, dist[i]));

  const wallDist = {} as Record<Dir, Uint8Array>;
  for (const d of DIRS) {
    const arr = new Uint8Array(n);
    const dv = DIR_VEC[d];
    for (let i = 0; i < n; i++) {
      if (!drivable[i]) continue;
      let x = i % cols;
      let y = Math.floor(i / cols);
      let k = 0;
      while (k < 255) {
        x += dv.x;
        y += dv.y;
        k++;
        if (x < 0 || y < 0 || x >= cols || y >= rows || !drivable[y * cols + x]) break;
      }
      arr[i] = k;
    }
    wallDist[d] = arr;
  }

  // Walking distances from doors (Dijkstra over walkable tiles, 4-connected, uniform cost).
  const tw = design.width;
  const th = design.height;
  const walk = new Float64Array(tw * th).fill(Infinity);
  const doors: Vec[] = [];
  const wq: number[] = [];
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      if (getTile(design, tx, ty).kind === 'door') {
        walk[ty * tw + tx] = 0;
        wq.push(ty * tw + tx);
        doors.push(tileCenter(tx, ty));
      }
    }
  }
  for (let h = 0; h < wq.length; h++) {
    const i = wq[h];
    const x = i % tw;
    const y = Math.floor(i / tw);
    for (const d of DIRS) {
      const nx = x + DIR_VEC[d].x;
      const ny = y + DIR_VEC[d].y;
      if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue;
      const j = ny * tw + nx;
      if (walk[j] !== Infinity || !isWalkable(getTile(design, nx, ny))) continue;
      walk[j] = walk[i] + TILE;
      wq.push(j);
    }
  }
  if (doors.length === 0) warnings.push('No store doors: drivers have nowhere to walk to.');

  // Spots.
  const spots: SpotInfo[] = [];
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const t = getTile(design, tx, ty);
      if (t.kind !== 'spot' || !t.head) continue;
      const out = DIR_VEC[t.facing];
      const head = tileCenter(tx, ty);
      const center = add(head, scale(out, -TILE / 2));
      const mouth = add(head, scale(out, TILE / 2));
      const probe = add(mouth, scale(out, 1.9));
      let approachCell = cellAt({ cols, rows } as Compiled, probe);
      if (approachCell >= 0 && !drivable[approachCell]) approachCell = -1;
      spots.push({
        id: spots.length,
        headX: tx,
        headY: ty,
        facing: t.facing,
        out,
        center,
        mouth,
        approachCell,
        walkDist: walk[ty * tw + tx] + TILE / 2,
      });
    }
  }

  // Portals: group contiguous entrance/exit tiles with the same facing.
  const entrances: Portal[] = [];
  const exits: Portal[] = [];
  const seen = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const t = getTile(design, tx, ty);
      if ((t.kind !== 'entrance' && t.kind !== 'exit') || seen[ty * tw + tx]) continue;
      const group: [number, number][] = [];
      const stack: [number, number][] = [[tx, ty]];
      seen[ty * tw + tx] = 1;
      while (stack.length) {
        const [x, y] = stack.pop()!;
        group.push([x, y]);
        for (const d of DIRS) {
          const nx = x + DIR_VEC[d].x;
          const ny = y + DIR_VEC[d].y;
          const o = getTile(design, nx, ny);
          if (o.kind === t.kind && o.facing === t.facing && !seen[ny * tw + nx] && nx >= 0 && ny >= 0 && nx < tw && ny < th) {
            seen[ny * tw + nx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      const f = DIR_VEC[t.facing];
      let cx = 0;
      let cy = 0;
      const cells: number[] = [];
      for (const [x, y] of group) {
        cx += x;
        cy += y;
        forTileCells(x, y, (i) => cells.push(i));
      }
      const mid = tileCenter(cx / group.length, cy / group.length);
      const edge = add(mid, scale(f, TILE / 2));
      const portal: Portal = { kind: t.kind, facing: t.facing, cells, edge, street: add(edge, scale(f, 5)) };
      (t.kind === 'entrance' ? entrances : exits).push(portal);
    }
  }
  if (entrances.length === 0) warnings.push('No entrance: cars cannot arrive.');
  if (exits.length === 0) warnings.push('No exit: parked cars can never leave.');

  // Reachability from entrances, ignoring direction rules.
  const reach = new Uint8Array(n);
  const rq: number[] = [];
  for (const p of entrances) for (const i of p.cells) if (!reach[i]) { reach[i] = 1; rq.push(i); }
  for (let h = 0; h < rq.length; h++) {
    const i = rq[h];
    const x = i % cols;
    const y = Math.floor(i / cols);
    for (const d of DIRS) {
      const nx = x + DIR_VEC[d].x;
      const ny = y + DIR_VEC[d].y;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const j = ny * cols + nx;
      if (drivable[j] && !reach[j]) {
        reach[j] = 1;
        rq.push(j);
      }
    }
  }
  let unreachableSpots = 0;
  for (const s of spots) {
    if (s.approachCell < 0 || !reach[s.approachCell]) {
      s.approachCell = -1;
      unreachableSpots++;
    }
  }
  if (unreachableSpots > 0) warnings.push(`${unreachableSpots} spot(s) don't open onto a reachable aisle.`);
  if (exits.length > 0 && entrances.length > 0 && !exits.some((e) => e.cells.some((i) => reach[i]))) {
    warnings.push('No exit is reachable from the entrance.');
  }

  const wanderCells: number[] = [];
  for (let i = 0; i < n; i++) {
    if (drivable[i] && reach[i] && clearance[i] >= 2 && !portalKind[i]) wanderCells.push(i);
  }

  const sightBlock = new Uint8Array(tw * th);
  for (let i = 0; i < tw * th; i++) sightBlock[i] = blocksSight(design.tiles[i] as Tile) ? 1 : 0;

  return {
    design,
    cols,
    rows,
    drivable,
    clearance,
    wallDist,
    oneWay,
    portalKind,
    portalFacing,
    spots,
    entrances,
    exits,
    doors,
    wanderCells,
    sightBlock,
    warnings,
  };
}

/** Line of sight between two world points, blocked by buildings (grid DDA over tiles). */
export function lineOfSight(c: Compiled, a: Vec, b: Vec): boolean {
  const tw = c.design.width;
  const th = c.design.height;
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (TILE / 2));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.floor((a.x + (b.x - a.x) * t) / TILE);
    const y = Math.floor((a.y + (b.y - a.y) * t) / TILE);
    if (x < 0 || y < 0 || x >= tw || y >= th) continue;
    if (c.sightBlock[y * tw + x]) return false;
  }
  return true;
}
