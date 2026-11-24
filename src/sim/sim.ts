import { Rng } from '../core/rng';
import { Vec, add, cubicBezier, dist, dot, fromAngle, scale, sub, v, wrapAngle } from '../core/vec';
import { CELL, Compiled, Portal, SpotInfo, cellCenter, lineOfSight, nearestDrivable } from '../world/compile';
import { RouteOptions, findRoute, routeToPoints } from '../world/nav';
import { TILE } from '../world/tiles';
import { SimEvent } from './events';
import { Path } from './path';
import { SEDAN, SUV, VehicleClass, bodyCircles, bodyOffset, circlesGap } from './vehicle';

export interface SimConfig {
  seed: number;
  /** Length of the simulated day in seconds. */
  duration: number;
  /** Peak arrival rate, cars per minute. */
  peakPerMin: number;
  dwellMean: number;
  dwellMin: number;
  /** How long a car waits on the street to get in before giving up. */
  balkAfter: number;
  /** How far drivers see free spots (m). */
  sightRange: number;
  suvShare: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 1,
  duration: 90 * 60,
  peakPerMin: 8,
  dwellMean: 15 * 60,
  dwellMin: 3 * 60,
  balkAfter: 90,
  sightRange: 22,
  suvShare: 0.3,
};

export type Mode =
  | 'searching'
  | 'toSpot'
  | 'parked'
  | 'backingOut'
  | 'toExit'
  | 'resolving';

interface CorridorSample {
  d: number;
  circ: number[];
  cx: number;
  cy: number;
}

export interface Car {
  id: number;
  vc: VehicleClass;
  color: string;
  rear: Vec;
  heading: number;
  /** Signed: negative while reversing. */
  speed: number;
  steer: number;
  mode: Mode;
  path: Path | null;
  s: number;
  spot: number;
  /** What to do once a 'resolving' reverse finishes. */
  resumeMode: Mode;
  arriveT: number;
  enterT: number;
  parkT: number;
  dwellUntil: number;
  unparkT: number;
  patience: number;
  walkTol: number;
  compliance: number;
  lastScan: number;
  wanderCell: number;
  trail: Vec[];
  trailAcc: number;
  blockedBy: number;
  blockKind: 'body' | 'yield' | null;
  corridor: CorridorSample[];
  body: number[];
  /** Cars whose *intent* (not body) this car may ignore until the given time. */
  waveThrough: Map<number, number>;
  lastResolve: number;
  everParked: boolean;
  /** Distance ahead the car may drive this tick (set by avoidance). */
  allowed: number;
  /** Seconds spent stopped against a parked car. */
  stuckOnStatic: number;
  /** Until this time the car squeezes past parked cars instead of stopping for them. */
  squeezeUntil: number;
  /** Cars this one is inching past (ignoring for avoidance) until the given time. */
  squeezePast: Map<number, number>;
}

interface QueuedArrival {
  id: number;
  t: number;
}

interface Standoff {
  id: number;
  cars: number[];
  start: number;
  lastSeen: number;
  announced: boolean;
  resolvedBy: string;
  where: Vec;
}

const DT = 0.1;
const ACCEL = 2.0;
const DECEL = 4.0;
const MARGIN = 0.25;
const COLORS = ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#a8c686', '#c1666b', '#7d5ba6', '#3d9970', '#d4b483', '#48a9a6', '#e07a5f', '#81b29a'];

export class Simulation {
  readonly cfg: SimConfig;
  readonly world: Compiled;
  readonly rng: Rng;
  t = 0;
  cars = new Map<number, Car>();
  events: SimEvent[] = [];
  /** Seconds of moving-car presence per tile. */
  heat: Float32Array;
  queues: QueuedArrival[][];
  spotOwner: Int32Array;
  done = false;

  private nextId = 1;
  private nextArrival = 0;
  private standoffs = new Map<string, Standoff>();
  private nextStandoffId = 1;
  private pairCooldown = new Map<number, number>();
  private lastSample = -Infinity;
  private yieldCache = new Map<number, number>();
  private nearDoor: number[] | null = null;

  constructor(world: Compiled, cfg: Partial<SimConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.world = world;
    this.rng = new Rng(this.cfg.seed);
    this.heat = new Float32Array(world.design.width * world.design.height);
    this.queues = world.entrances.map(() => []);
    this.spotOwner = new Int32Array(world.spots.length).fill(-1);
    this.nextArrival = this.sampleNextArrival(0);
  }

  get dt() {
    return DT;
  }

  /** Cars currently stuck in an announced standoff (for display). */
  standoffCars(): Set<number> {
    const out = new Set<number>();
    for (const so of this.standoffs.values()) if (so.announced) for (const id of so.cars) out.add(id);
    return out;
  }

  private emit(e: SimEvent) {
    this.events.push(e);
  }

  // ---------------------------------------------------------------- demand

  /** Demand shape over the day: quiet start, peak in the middle, tapering off. */
  rateAt(t: number): number {
    const u = Math.min(1, Math.max(0, t / this.cfg.duration));
    const shape = 0.25 + 0.75 * Math.sin(Math.PI * u) ** 2;
    return (this.cfg.peakPerMin / 60) * shape;
  }

  private sampleNextArrival(from: number): number {
    // Thinning against the peak rate.
    const peak = this.cfg.peakPerMin / 60;
    if (peak <= 0) return Infinity;
    let t = from;
    for (let i = 0; i < 10000; i++) {
      t += this.rng.exp(1 / peak);
      if (this.rng.next() * peak <= this.rateAt(t)) return t;
    }
    return Infinity;
  }

  // ---------------------------------------------------------------- main loop

  step(): void {
    if (this.done) return;
    this.t += DT;
    this.yieldCache.clear();
    this.arrivals();
    this.spawnFromQueues();
    for (const car of this.cars.values()) this.behave(car);
    const moving = [...this.cars.values()].filter((c) => c.mode !== 'parked');
    const hash = this.buildHash();
    for (const car of moving) this.buildCorridor(car);
    for (const car of moving) this.avoid(car, hash);
    this.detectStandoffs();
    for (const car of moving) this.move(car);
    this.detectNearMisses(moving, hash);
    this.finishArrivals();
    for (const car of moving) {
      const tx = Math.floor(car.rear.x / TILE);
      const ty = Math.floor(car.rear.y / TILE);
      if (tx >= 0 && ty >= 0 && tx < this.world.design.width && ty < this.world.design.height) {
        this.heat[ty * this.world.design.width + tx] += DT;
      }
    }
    if (this.t - this.lastSample >= 10) {
      this.lastSample = this.t;
      let parked = 0;
      for (const c of this.cars.values()) if (c.mode === 'parked') parked++;
      this.emit({
        t: this.t,
        type: 'sample',
        queue: this.queues.reduce((a, q) => a + q.length, 0),
        parked,
        moving: this.cars.size - parked,
      });
    }
    if (this.t >= this.cfg.duration) this.done = true;
  }

  private arrivals() {
    while (this.nextArrival <= this.t && this.world.entrances.length > 0) {
      const id = this.nextId++;
      const q = this.queues[this.rng.int(this.queues.length)];
      q.push({ id, t: this.nextArrival });
      this.emit({ t: this.t, type: 'arrive', car: id });
      this.nextArrival = this.sampleNextArrival(this.nextArrival);
    }
  }

  private spawnFromQueues() {
    this.world.entrances.forEach((portal, pi) => {
      const q = this.queues[pi];
      // Balking: drivers waiting too long on the street drive away.
      while (q.length && this.t - q[0].t > this.cfg.balkAfter) {
        const a = q.shift()!;
        this.emit({ t: this.t, type: 'balk', car: a.id, waited: this.t - a.t });
      }
      if (!q.length) return;
      const f = sub(portal.street, portal.edge);
      const fn = scale(f, 1 / Math.max(1e-6, Math.hypot(f.x, f.y)));
      const rear = add(portal.edge, scale(fn, 3.2));
      for (const other of this.cars.values()) {
        if (dist(other.rear, rear) < 7.5) return; // spawn area occupied
      }
      const a = q.shift()!;
      this.spawn(a, portal, rear, Math.atan2(-fn.y, -fn.x));
    });
  }

  private spawn(a: QueuedArrival, portal: Portal, rear: Vec, heading: number) {
    const vc = this.rng.next() < this.cfg.suvShare ? SUV : SEDAN;
    const car: Car = {
      id: a.id,
      vc,
      color: COLORS[a.id % COLORS.length],
      rear,
      heading,
      speed: 3,
      steer: 0,
      mode: 'searching',
      path: null,
      s: 0,
      spot: -1,
      resumeMode: 'searching',
      arriveT: a.t,
      enterT: this.t,
      parkT: 0,
      dwellUntil: 0,
      unparkT: 0,
      patience: this.rng.range(150, 420),
      walkTol: this.rng.range(25, 60),
      compliance: this.rng.next() < 0.9 ? 1 : 0.15,
      lastScan: -Infinity,
      wanderCell: -1,
      trail: [],
      trailAcc: 0,
      blockedBy: -1,
      blockKind: null,
      corridor: [],
      body: [],
      waveThrough: new Map(),
      lastResolve: -Infinity,
      everParked: false,
      allowed: Infinity,
      stuckOnStatic: 0,
      squeezeUntil: -Infinity,
      squeezePast: new Map(),
    };
    bodyCircles(vc, rear, heading, car.body);
    this.cars.set(car.id, car);
    this.emit({ t: this.t, type: 'enter', car: car.id, queued: this.t - a.t });
    // Head toward the door first: that's where everyone wants to park.
    const inner = nearestDrivable(this.world, add(portal.edge, scale(fromAngle(heading), 1.2)));
    this.planWander(car, this.doorCell(), inner);
  }

  private finishArrivals() {
    for (const car of [...this.cars.values()]) {
      if (car.mode === 'toExit' && car.path && car.s >= car.path.length - 0.5) {
        this.emit({
          t: this.t,
          type: 'left',
          car: car.id,
          parked: car.everParked,
          inLot: this.t - car.enterT,
          exitTime: car.everParked ? this.t - car.unparkT : 0,
        });
        this.removeCar(car);
      }
    }
  }

  private removeCar(car: Car) {
    if (car.spot >= 0 && this.spotOwner[car.spot] === car.id) this.spotOwner[car.spot] = -1;
    this.cars.delete(car.id);
    for (const c of this.cars.values()) {
      if (c.blockedBy === car.id) {
        c.blockedBy = -1;
        c.blockKind = null;
      }
    }
  }

  // ---------------------------------------------------------------- behavior

  private routeOpts(car: Car, extraCost?: Float32Array): RouteOptions {
    return { wrongWayPenalty: car.compliance >= 1 ? 60 : 4, extraCost };
  }

  /**
   * Somewhere near a store door to head for first. Each driver picks a random spot among the
   * drivable cells closest to a door, so they don't all converge on one point.
   */
  private doorCell(): number {
    const w = this.world;
    if (w.wanderCells.length === 0) return -1;
    if (w.doors.length === 0) return this.rng.pick(w.wanderCells);
    if (!this.nearDoor) {
      const scored = w.wanderCells.map((i) => {
        const p = cellCenter(w, i);
        return { i, d: Math.min(...w.doors.map((d) => dist(p, d))) };
      });
      scored.sort((a, b) => a.d - b.d);
      const cutoff = scored[0].d + 12;
      this.nearDoor = scored.filter((x) => x.d <= cutoff).map((x) => x.i);
    }
    return this.rng.pick(this.nearDoor);
  }

  /**
   * Wander targets are areas, not points: any good drivable cell within ~3 m counts, so the
   * router can arrive in the correct lane instead of cutting across the aisle.
   */
  private around(cell: number): number[] {
    const w = this.world;
    if (cell < 0) return [];
    const cx = cell % w.cols;
    const cy = Math.floor(cell / w.cols);
    const out: number[] = [];
    for (let y = cy - 2; y <= cy + 2; y++)
      for (let x = cx - 2; x <= cx + 2; x++) {
        if (x < 0 || y < 0 || x >= w.cols || y >= w.rows) continue;
        const i = y * w.cols + x;
        if (w.drivable[i] && w.clearance[i] >= 2) out.push(i);
      }
    return out.length ? out : [cell];
  }

  /** Builds a forward path from the car's position to the given cells. */
  private forwardPath(car: Car, goals: number[], tail: Vec[] = [], from?: number, extraCost?: Float32Array): Path | null {
    const w = this.world;
    const fwd = fromAngle(car.heading);
    const ahead = add(car.rear, scale(fwd, car.vc.wheelbase + 1.5));
    const start = from ?? nearestClear(w, ahead);
    // Cars can't pivot: make the cells beside and behind the car very expensive so the
    // route leaves forward and loops around the block instead of U-turning in the aisle.
    const cost = new Float32Array(w.cols * w.rows);
    if (extraCost) cost.set(extraCost);
    const reach = 8;
    const cx0 = Math.floor(car.rear.x / CELL);
    const cy0 = Math.floor(car.rear.y / CELL);
    const r = Math.ceil(reach / CELL);
    for (let y = cy0 - r; y <= cy0 + r; y++) {
      for (let x = cx0 - r; x <= cx0 + r; x++) {
        if (x < 0 || y < 0 || x >= w.cols || y >= w.rows) continue;
        const i = y * w.cols + x;
        if (i === start) continue;
        const p = cellCenter(w, i);
        const rel = sub(p, car.rear);
        const along = dot(rel, fwd);
        const lateral = Math.abs(rel.x * -fwd.y + rel.y * fwd.x);
        if (along > -6 && along < car.vc.wheelbase + 0.5 && lateral < 3.0) cost[i] += 500;
      }
    }
    const heading = { startHeading: car.heading };
    let route = findRoute(w, start, goals, { ...this.routeOpts(car, cost), ...heading });
    if (!route || route.cost > 450) route = findRoute(w, start, goals, { ...this.routeOpts(car, extraCost), ...heading }) ?? route;
    if (!route) return null;
    const pts = routeToPoints(w, route);
    // Drop route points that are behind the car so it doesn't try to turn around.
    while (pts.length > 2 && dot(sub(pts[0], car.rear), fwd) < 0.5) pts.shift();
    return new Path([car.rear, ...pts, ...tail]);
  }

  private planWander(car: Car, target: number, from?: number) {
    car.wanderCell = target;
    car.path = target >= 0 ? this.forwardPath(car, this.around(target), [], from) : null;
    car.s = 0;
    car.mode = 'searching';
  }

  private pickWanderCell(car: Car): number {
    const cells = this.world.wanderCells;
    if (cells.length === 0) return -1;
    const fwd = fromAngle(car.heading);
    for (let tries = 0; tries < 12; tries++) {
      const c = cells[this.rng.int(cells.length)];
      const p = cellCenter(this.world, c);
      const d = dist(p, car.rear);
      if (d > 15 && (tries > 6 || dot(sub(p, car.rear), fwd) > 0)) return c;
    }
    return cells[this.rng.int(cells.length)];
  }

  private behave(car: Car) {
    switch (car.mode) {
      case 'searching': {
        if (this.t - car.enterT > car.patience) {
          this.emit({ t: this.t, type: 'gave_up', car: car.id, searched: this.t - car.enterT });
          this.planExit(car);
          return;
        }
        if (this.t - car.lastScan >= 0.5) {
          car.lastScan = this.t;
          const spot = this.scanForSpot(car);
          if (spot) {
            this.claim(car, spot);
            return;
          }
        }
        if (!car.path || car.s >= car.path.length - 1.0) this.planWander(car, this.pickWanderCell(car));
        return;
      }
      case 'toSpot':
        if (car.path && car.s >= car.path.length - 0.35 && Math.abs(car.speed) < 0.6) this.park(car);
        return;
      case 'parked':
        if (this.t >= car.dwellUntil) this.unpark(car);
        return;
      case 'backingOut':
        if (car.path && car.s >= car.path.length - 0.35) {
          this.spotOwner[car.spot] = -1;
          car.spot = -1;
          this.planExit(car);
        }
        return;
      case 'resolving':
        if (!car.path || car.s >= car.path.length - 0.35) this.resume(car);
        return;
      case 'toExit':
        return;
    }
  }

  private scanForSpot(car: Car): SpotInfo | null {
    const w = this.world;
    const front = add(car.rear, scale(fromAngle(car.heading), car.vc.wheelbase));
    const fwd = fromAngle(car.heading);
    const searched = this.t - car.enterT;
    const tolerance = car.walkTol * (1 + searched / 90);
    let best: SpotInfo | null = null;
    let bestScore = Infinity;
    for (const s of w.spots) {
      if (s.approachCell < 0 || this.spotOwner[s.id] >= 0) continue;
      const d = dist(front, s.mouth);
      if (d > this.cfg.sightRange) continue;
      // Only spots comfortably ahead: drivers don't U-turn for a spot they already passed.
      if (dot(sub(s.mouth, front), fwd) < 3.5) continue;
      if (s.walkDist > tolerance) continue;
      if (!lineOfSight(w, front, s.mouth)) continue;
      if (car.vc === SUV && s.walkDist > tolerance * 0.9 && searched < 30) continue;
      const score = s.walkDist + 0.4 * d;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  private claim(car: Car, spot: SpotInfo) {
    const path = this.spotPath(car, spot);
    if (!path) return;
    this.spotOwner[spot.id] = car.id;
    car.spot = spot.id;
    car.mode = 'toSpot';
    car.path = path;
    car.s = 0;
    this.emit({ t: this.t, type: 'spot_claimed', car: car.id, spot: spot.id, search: this.t - car.enterT });
  }

  /** Route to the aisle in front of the spot, then a smooth curve into the stall (front-in). */
  private spotPath(car: Car, spot: SpotInfo, extraCost?: Float32Array): Path | null {
    const route = this.forwardPath(car, [spot.approachCell], [], undefined, extraCost);
    if (!route) return null;
    const inward = scale(spot.out, -1);
    const finalRear = add(spot.center, scale(spot.out, bodyOffset(car.vc)));
    const cut = Math.max(0, route.length - 5.5);
    const p0 = route.at(cut);
    const t0 = fromAngle(route.tangent(cut));
    const keep: Vec[] = [];
    for (let i = 0; i < route.pts.length && route.cum[i] < cut; i++) keep.push(route.pts[i]);
    const curve = cubicBezier(p0, add(p0, scale(t0, 2.8)), add(finalRear, scale(inward, -3.2)), finalRear, 16);
    return new Path([...keep, ...curve]);
  }

  private park(car: Car) {
    const spot = this.world.spots[car.spot];
    car.rear = add(spot.center, scale(spot.out, bodyOffset(car.vc)));
    car.heading = Math.atan2(-spot.out.y, -spot.out.x);
    car.speed = 0;
    car.steer = 0;
    car.mode = 'parked';
    car.path = null;
    car.parkT = this.t;
    car.everParked = true;
    car.dwellUntil = this.t + Math.max(this.cfg.dwellMin, this.rng.exp(this.cfg.dwellMean));
    bodyCircles(car.vc, car.rear, car.heading, car.body);
    this.emit({
      t: this.t,
      type: 'parked',
      car: car.id,
      spot: spot.id,
      walk: spot.walkDist,
      sinceArrival: this.t - car.arriveT,
    });
  }

  /** Back out of the stall, swinging the rear away from where the driver wants to go next. */
  private unpark(car: Car) {
    const w = this.world;
    const spot = w.spots[car.spot];
    const axis = v(-spot.out.y, spot.out.x);
    let dOut = axis;
    const probe = nearestDrivable(w, add(spot.mouth, scale(spot.out, 2.2)));
    const exitCells = w.exits.flatMap((e) => e.cells);
    const route = findRoute(w, probe, exitCells, this.routeOpts(car));
    if (route && route.cells.length > 1) {
      const pts = routeToPoints(w, route);
      const ahead = pts[Math.min(pts.length - 1, 6)];
      if (dot(sub(ahead, cellCenter(w, probe)), axis) < 0) dOut = scale(axis, -1);
    }
    // Reverse straight out to the mouth, then a quarter arc that swings the rear toward -dOut,
    // leaving the car aligned with the aisle and pointing along dOut.
    const R = 4.8;
    const r0 = car.rear;
    const straight = dot(sub(spot.mouth, r0), spot.out) + 0.05;
    const curve: Vec[] = [];
    for (let d = 0; d <= straight; d += 0.25) curve.push(add(r0, scale(spot.out, d)));
    const a0 = add(r0, scale(spot.out, straight));
    const center = add(a0, scale(dOut, -R));
    for (let k = 1; k <= 16; k++) {
      const th = (k / 16) * (Math.PI / 2);
      // Start at a0 (offset +dOut*R from center), sweep toward +out.
      curve.push(add(center, add(scale(dOut, R * Math.cos(th)), scale(spot.out, R * Math.sin(th)))));
    }
    const last = curve[curve.length - 1];
    curve.push(add(last, scale(dOut, -1.0)));
    car.path = new Path(curve, true);
    car.s = 0;
    car.mode = 'backingOut';
    car.trail = [];
    if (car.unparkT === 0) {
      // Only the first attempt counts; a car that pulled back in to wait is retrying.
      car.unparkT = this.t;
      this.emit({ t: this.t, type: 'unpark', car: car.id, spot: spot.id });
    }
  }

  private exitPath(car: Car, extraCost?: Float32Array): Path | null {
    let best: Path | null = null;
    for (const e of this.world.exits) {
      const f = sub(e.street, e.edge);
      const p = this.forwardPath(car, e.cells, [e.edge, e.street, add(e.street, scale(f, 0.6))], undefined, extraCost);
      if (p && (!best || p.length < best.length)) best = p;
    }
    return best;
  }

  private planExit(car: Car, extraCost?: Float32Array) {
    car.mode = 'toExit';
    car.path = this.exitPath(car, extraCost);
    car.s = 0;
  }

  private resume(car: Car) {
    if (car.resumeMode === 'backingOut') {
      // Back in the stall: settle and try leaving again shortly.
      const spot = this.world.spots[car.spot];
      car.rear = add(spot.center, scale(spot.out, bodyOffset(car.vc)));
      car.heading = Math.atan2(-spot.out.y, -spot.out.x);
      car.speed = 0;
      car.steer = 0;
      car.mode = 'parked';
      car.path = null;
      car.dwellUntil = this.t + this.rng.range(4, 9);
      bodyCircles(car.vc, car.rear, car.heading, car.body);
      return;
    }
    const extra = this.avoidanceCost(car);
    if (car.resumeMode === 'toSpot' && car.spot >= 0) {
      const p = this.spotPath(car, this.world.spots[car.spot], extra);
      car.mode = 'toSpot';
      car.path = p;
      car.s = 0;
      if (!p) {
        this.spotOwner[car.spot] = -1;
        car.spot = -1;
        this.planWander(car, this.pickWanderCell(car));
      }
    } else if (car.resumeMode === 'toExit') {
      this.planExit(car, extra);
    } else {
      car.mode = 'searching';
      car.wanderCell = this.pickWanderCell(car);
      car.path = this.forwardPath(car, this.around(car.wanderCell), [], undefined, extra);
      car.s = 0;
    }
  }

  /**
   * Extra routing cost on the cells other nearby cars actually occupy, used when replanning
   * out of a standoff. Only their footprint is marked, so a wide aisle still leaves room to pass.
   */
  private avoidanceCost(car: Car): Float32Array {
    const w = this.world;
    const extra = new Float32Array(w.cols * w.rows);
    for (const o of this.cars.values()) {
      if (o.id === car.id || o.mode === 'parked') continue;
      if (dist(o.rear, car.rear) > 25) continue;
      const reach = o.vc.width / 2 + car.vc.width / 2 + 0.3;
      for (let k = 0; k < 3; k++) {
        const bx = o.body[2 * k];
        const by = o.body[2 * k + 1];
        const x0 = Math.floor((bx - reach) / CELL);
        const x1 = Math.floor((bx + reach) / CELL);
        const y0 = Math.floor((by - reach) / CELL);
        const y1 = Math.floor((by + reach) / CELL);
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            if (x < 0 || y < 0 || x >= w.cols || y >= w.rows) continue;
            const cx = (x + 0.5) * CELL;
            const cy = (y + 0.5) * CELL;
            if (Math.hypot(cx - bx, cy - by) <= reach) extra[y * w.cols + x] = 40;
          }
      }
    }
    return extra;
  }

  // ---------------------------------------------------------------- avoidance

  private buildHash(): Map<number, Car[]> {
    const hash = new Map<number, Car[]>();
    for (const c of this.cars.values()) {
      const k = hashKey(c.rear.x, c.rear.y);
      let arr = hash.get(k);
      if (!arr) hash.set(k, (arr = []));
      arr.push(c);
    }
    return hash;
  }

  private neighbors(hash: Map<number, Car[]>, p: Vec, out: Car[]): Car[] {
    out.length = 0;
    const gx = Math.floor(p.x / 10);
    const gy = Math.floor(p.y / 10);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const arr = hash.get((gx + dx) * 4096 + (gy + dy));
        if (arr) for (const c of arr) out.push(c);
      }
    return out;
  }

  /**
   * The corridor is where the car's body will be over the next few meters. It's predicted by
   * rolling the car's own steering model forward, so it matches how the car will really move.
   */
  private buildCorridor(car: Car) {
    car.corridor = [];
    const p = car.path;
    if (!p) return;
    const v2 = car.speed * car.speed;
    const look = Math.min(p.length - car.s, Math.max(3.5, v2 / (2 * DECEL) + 3.5));
    const off = bodyOffset(car.vc);
    const dir = p.reverse ? -1 : 1;
    const L = car.vc.wheelbase;
    let rear = { ...car.rear };
    let h = car.heading;
    let steer = car.steer;
    let s = car.s;
    const STEP = 0.5;
    for (let k = 1; k * STEP <= look + 1e-6; k++) {
      s = p.project(rear, s, 3);
      const cmd = this.pursuitSteer(car, p, rear, h, s, Math.abs(car.speed));
      steer += Math.max(-0.35, Math.min(0.35, cmd - steer));
      h += ((dir * STEP) / L) * Math.tan(steer);
      rear = { x: rear.x + Math.cos(h) * dir * STEP, y: rear.y + Math.sin(h) * dir * STEP };
      if (k % 2 === 0) {
        const circ = bodyCircles(car.vc, rear, h, []);
        car.corridor.push({ d: k * STEP, circ, cx: rear.x + Math.cos(h) * off, cy: rear.y + Math.sin(h) * off });
      }
    }
  }

  private isManeuvering(car: Car, remaining: number): boolean {
    return car.mode === 'backingOut' || car.mode === 'resolving' || (car.mode === 'toSpot' && remaining < 9);
  }

  /** Pure pursuit on the rear axle; works forward and in reverse. */
  private pursuitSteer(car: Car, p: Path, rear: Vec, heading: number, s: number, speed: number): number {
    const vc = car.vc;
    const ld = this.isManeuvering(car, p.length - s) ? 1.4 : Math.min(3.0, Math.max(1.5, 1.0 + 0.45 * speed));
    const target = p.at(s + ld);
    const motionHeading = p.reverse ? heading + Math.PI : heading;
    const alpha = wrapAngle(Math.atan2(target.y - rear.y, target.x - rear.x) - motionHeading);
    const dTarget = Math.max(0.5, Math.hypot(target.x - rear.x, target.y - rear.y));
    const kappa = (2 * Math.sin(alpha)) / dTarget;
    let cmd = Math.atan(kappa * vc.wheelbase);
    if (p.reverse) cmd = -cmd;
    return Math.max(-vc.maxSteer, Math.min(vc.maxSteer, cmd));
  }

  private rank(c: Car): number {
    if (c.mode === 'resolving') return 1;
    if (c.mode === 'backingOut') return 0;
    return 2;
  }

  /** Returns true if `a` should yield to `b` over an intent conflict. Cached per pair per tick. */
  private shouldYield(a: Car, da: number, b: Car, db: number): boolean {
    const key = Math.min(a.id, b.id) * 1e6 + Math.max(a.id, b.id);
    const cached = this.yieldCache.get(key);
    if (cached !== undefined) return cached === a.id;
    let loser: Car;
    const wa = a.waveThrough.get(b.id);
    const wb = b.waveThrough.get(a.id);
    // A car whose body is already in the other's way can't usefully yield: it should clear out.
    const aInB = this.bodyInCorridor(a, b);
    const bInA = this.bodyInCorridor(b, a);
    if (wa !== undefined && wa > this.t) loser = b;
    else if (wb !== undefined && wb > this.t) loser = a;
    else if (aInB !== bInA) loser = aInB ? b : a;
    else if (this.rank(a) !== this.rank(b)) loser = this.rank(a) < this.rank(b) ? a : b;
    else if (Math.abs(da - db) > 1.0) loser = da > db ? a : b;
    else loser = a.id > b.id ? a : b;
    this.yieldCache.set(key, loser.id);
    return loser === a;
  }

  /** Does a's current body overlap b's planned corridor? */
  private bodyInCorridor(a: Car, b: Car): boolean {
    for (const s of b.corridor) {
      if (Math.hypot(s.cx - a.body[2], s.cy - a.body[3]) > 5) continue;
      if (circlesGap(a.body, a.vc.width / 2, s.circ, b.vc.width / 2) < MARGIN) return true;
    }
    return false;
  }

  private avoid(car: Car, hash: Map<number, Car[]>) {
    car.blockedBy = -1;
    car.blockKind = null;
    let allowed = Infinity;
    const r = car.vc.width / 2;
    const near = this.neighbors(hash, car.rear, []);
    const nearSpot = car.mode === 'toSpot' && car.spot >= 0 ? this.world.spots[car.spot].center : null;
    // Direction of motion: drivers only brake for things in front of them (in the direction they move).
    const mh = car.speed < 0 || car.path?.reverse ? car.heading + Math.PI : car.heading;
    const mx = Math.cos(mh);
    const my = Math.sin(mh);
    const behind = (o: Car) => (o.body[2] - car.body[2]) * mx + (o.body[3] - car.body[3]) * my < -0.5;
    outer: for (const sample of car.corridor) {
      for (const o of near) {
        if (o === car || behind(o) || (car.squeezePast.get(o.id) ?? -Infinity) > this.t) continue;
        if (Math.hypot(o.body[2] - sample.cx, o.body[3] - sample.cy) > 6) continue;
        const parked = this.isStatic(o);
        if (parked) {
          if (car.mode === 'backingOut' || car.mode === 'resolving' || this.t < car.squeezeUntil) continue;
          if (nearSpot && dist(nearSpot, { x: sample.cx, y: sample.cy }) < 7) continue;
        }
        const ro = parked ? o.vc.width / 2 - 0.2 : o.vc.width / 2;
        if (circlesGap(sample.circ, r, o.body, ro) < (parked ? 0 : MARGIN)) {
          allowed = sample.d - 1.0;
          car.blockedBy = o.id;
          car.blockKind = 'body';
          break outer;
        }
        if (parked || o.corridor.length === 0) continue;
        for (const os of o.corridor) {
          if (Math.hypot(os.cx - sample.cx, os.cy - sample.cy) > 5) continue;
          if (circlesGap(sample.circ, r, os.circ, o.vc.width / 2) < MARGIN) {
            if (this.shouldYield(car, sample.d, o, os.d)) {
              allowed = sample.d - 1.6;
              car.blockedBy = o.id;
              car.blockKind = 'yield';
              break outer;
            }
            break;
          }
        }
      }
    }
    car.allowed = allowed;
  }

  // ---------------------------------------------------------------- standoffs

  /** Parked, or still sitting in its stall about to back out. */
  private isStatic(o: Car): boolean {
    return o.mode === 'parked' || (o.mode === 'backingOut' && o.s < 0.3);
  }

  /**
   * A car pressed against a parked car took a corner too tight. Like a real driver it backs
   * up a little and tries again; each one is logged as a 'correction'.
   */
  private correctTightTurns() {
    for (const car of this.cars.values()) {
      const o = this.cars.get(car.blockedBy);
      if (!o || !this.isStatic(o) || Math.abs(car.speed) > 0.2 || car.mode === 'backingOut') {
        car.stuckOnStatic = 0;
        continue;
      }
      car.stuckOnStatic += DT;
      if (car.stuckOnStatic < 2.5 || this.t - car.lastResolve < 4) continue;
      car.stuckOnStatic = 0;
      car.lastResolve = this.t;
      const nearby = [...this.cars.values()].filter((x) => x !== car && dist(x.rear, car.rear) < 20);
      if (car.trail.length >= 3) {
        const back = new Path([car.rear, ...[...car.trail].reverse()].slice(0, 10), true);
        const free = Math.min(3.5, this.freeLength(car, back, nearby));
        if (free >= 1.5) {
          const pts: Vec[] = [];
          for (let d = 0; d <= free; d += 0.5) pts.push(back.at(d));
          car.resumeMode = car.mode === 'resolving' ? car.resumeMode : car.mode;
          car.mode = 'resolving';
          car.path = new Path(pts, true);
          car.s = 0;
          car.trail = [];
          this.emit({ t: this.t, type: 'correction', car: car.id, x: car.rear.x, y: car.rear.y });
          continue;
        }
      }
      // No room to back up: inch past carefully (a slow, tight squeeze).
      car.squeezeUntil = this.t + 3;
      this.emit({ t: this.t, type: 'correction', car: car.id, x: car.rear.x, y: car.rear.y });
    }
  }

  private detectStandoffs() {
    this.correctTightTurns();
    const seen = new Set<string>();
    for (const car of this.cars.values()) {
      if (car.blockedBy < 0 || Math.abs(car.speed) > 0.2) continue;
      // Walk the wait-for chain; a cycle that returns to `car` is a standoff.
      const chain: Car[] = [car];
      let cur = this.cars.get(car.blockedBy);
      while (cur && chain.length < 8) {
        if (cur === car) break;
        if (chain.includes(cur)) {
          cur = undefined;
          break;
        }
        if (cur.blockedBy < 0 || Math.abs(cur.speed) > 0.2) {
          cur = undefined;
          break;
        }
        chain.push(cur);
        cur = this.cars.get(cur.blockedBy);
      }
      if (cur !== car || chain.length < 2) continue;
      const ids = chain.map((c) => c.id).sort((a, b) => a - b);
      const key = ids.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      let so = this.standoffs.get(key);
      if (!so) {
        const where = scale(chain.reduce((acc, c) => add(acc, c.rear), v(0, 0)), 1 / chain.length);
        so = { id: this.nextStandoffId++, cars: ids, start: this.t, lastSeen: this.t, announced: false, resolvedBy: '', where };
        this.standoffs.set(key, so);
      }
      so.lastSeen = this.t;
      const age = this.t - so.start;
      if (!so.announced && age >= 1.0) {
        so.announced = true;
        this.emit({ t: this.t, type: 'standoff_start', id: so.id, cars: ids, x: so.where.x, y: so.where.y });
      }
      if (age >= 40) {
        this.gridlock(so, chain);
        this.standoffs.delete(key);
        continue;
      }
      if (age >= 12 && so.resolvedBy !== 'squeeze') {
        // Last resort before gridlock: drivers inch past each other with mirrors folded.
        for (const a of chain) for (const b of chain) if (a !== b) a.squeezePast.set(b.id, this.t + 6);
        so.resolvedBy = 'squeeze';
      } else if (age >= 2.0) this.resolve(so, chain);
    }
    for (const [key, so] of this.standoffs) {
      // A standoff that flickers (briefly clears, then re-forms) is still the same standoff.
      if (this.t - so.lastSeen > 4.0) {
        if (so.announced) {
          this.emit({
            t: this.t,
            type: 'standoff_end',
            id: so.id,
            duration: so.lastSeen - so.start,
            resolvedBy: so.resolvedBy || 'cleared',
          });
        }
        this.standoffs.delete(key);
      }
    }
  }

  private resolve(so: Standoff, chain: Car[]) {
    // 1. Pure courtesy deadlock (everyone yielding to intent): the oldest driver goes.
    if (chain.every((c) => c.blockKind === 'yield')) {
      const go = chain.reduce((a, b) => (a.id < b.id ? a : b));
      for (const c of chain) if (c !== go) go.waveThrough.set(c.id, this.t + 6);
      so.resolvedBy ||= 'wave_through';
      return;
    }
    // 2. Someone has to physically get out of the way. Prefer the lowest-ranked / newest
    //    driver, but only if they actually have somewhere to go.
    const candidates = chain
      .filter((c) => c.mode !== 'parked' && this.t - c.lastResolve > 6)
      .sort((a, b) => (this.rank(a) !== this.rank(b) ? this.rank(a) - this.rank(b) : b.id - a.id));
    for (const loser of candidates) {
      // Each driver tries at most once every few seconds, whether or not it works out.
      loser.lastResolve = this.t;
      const nearby = [...this.cars.values()].filter((o) => o !== loser && dist(o.rear, loser.rear) < 20);
      // A car that was backing up to clear space and got boxed in: give up on reversing.
      if (loser.mode === 'resolving' && loser.resumeMode !== 'backingOut') {
        loser.lastResolve = this.t;
        this.resume(loser);
        so.resolvedBy ||= 'reroute';
        return;
      }
      // A car halfway out of its stall pulls back in and waits for a gap.
      if (loser.mode === 'backingOut' && loser.path) {
        if (loser.s < 0.5) continue;
        const pts: Vec[] = [];
        for (let d = loser.s; d > 0; d -= 0.5) pts.push(loser.path.at(d));
        pts.push(loser.path.at(0));
        loser.lastResolve = this.t;
        loser.resumeMode = 'backingOut';
        loser.mode = 'resolving';
        loser.path = new Path(pts, false);
        loser.s = 0;
        so.resolvedBy ||= 'pull_back_in';
        return;
      }
      // 2a. Find another way around.
      const extra = this.avoidanceCost(loser);
      let alt: Path | null = null;
      if (loser.mode === 'searching') alt = this.forwardPath(loser, this.around(this.pickWanderCell(loser)), [], undefined, extra);
      else if (loser.mode === 'toSpot' && loser.spot >= 0) alt = this.spotPath(loser, this.world.spots[loser.spot], extra);
      else if (loser.mode === 'toExit') alt = this.exitPath(loser, extra);
      if (alt && !this.pathHitsCars(loser, alt, nearby)) {
        loser.lastResolve = this.t;
        loser.path = alt;
        loser.s = 0;
        so.resolvedBy ||= 'reroute';
        return;
      }
      // 2b. Back up along the way we came, as far as there's room.
      if (loser.trail.length >= 4) {
        const back = new Path([loser.rear, ...[...loser.trail].reverse()].slice(0, 20), true);
        const free = this.freeLength(loser, back, nearby);
        if (free >= 2.5) {
          const pts: Vec[] = [];
          for (let d = 0; d <= free; d += 0.5) pts.push(back.at(d));
          loser.lastResolve = this.t;
          loser.resumeMode = loser.mode === 'resolving' ? loser.resumeMode : loser.mode;
          loser.mode = 'resolving';
          loser.path = new Path(pts, true);
          loser.s = 0;
          loser.trail = [];
          so.resolvedBy ||= 'reverse';
          return;
        }
      }
    }
    // 2c. Nobody can move: wait (and eventually call it gridlock).
  }

  private poseOn(p: Path, d: number): { rear: Vec; heading: number } {
    return { rear: p.at(d), heading: p.tangent(d) + (p.reverse ? Math.PI : 0) };
  }

  private pathHitsCars(car: Car, p: Path, others: Car[]): boolean {
    return this.freeLength(car, p, others, 10) < Math.min(10, p.length) - 1e-6;
  }

  /** How far along `p` the car can go before touching another car. */
  private freeLength(car: Car, p: Path, others: Car[], max = Infinity): number {
    const end = Math.min(max, p.length);
    for (let d = 0.5; d <= end; d += 0.5) {
      const pose = this.poseOn(p, d);
      const circ = bodyCircles(car.vc, pose.rear, pose.heading, []);
      for (const o of others) {
        const ro = o.mode === 'parked' ? o.vc.width / 2 - 0.2 : o.vc.width / 2;
        if (circlesGap(circ, car.vc.width / 2, o.body, ro) < MARGIN) return Math.max(0, d - 1.0);
      }
    }
    return end;
  }

  private gridlock(so: Standoff, chain: Car[]) {
    const victim = chain.reduce((a, b) => (a.id > b.id ? a : b));
    this.emit({ t: this.t, type: 'gridlock', id: so.id, cars: so.cars, x: so.where.x, y: so.where.y, removed: victim.id });
    if (so.announced) {
      this.emit({ t: this.t, type: 'standoff_end', id: so.id, duration: this.t - so.start, resolvedBy: 'gridlock' });
    }
    this.removeCar(victim);
  }

  // ---------------------------------------------------------------- motion

  private move(car: Car) {
    const p = car.path;
    if (!p) {
      car.speed = 0;
      return;
    }
    const vc = car.vc;
    const L = vc.wheelbase;
    car.s = p.project(car.rear, car.s);
    const remaining = p.length - car.s;

    const maneuver = this.isManeuvering(car, remaining);
    const steerCmd = this.pursuitSteer(car, p, car.rear, car.heading, car.s, Math.abs(car.speed));
    const maxRate = 1.5 * DT;
    car.steer += Math.max(-maxRate, Math.min(maxRate, steerCmd - car.steer));

    let vmax = car.mode === 'searching' ? 3.5 : 4.5;
    for (const until of car.squeezePast.values()) if (until > this.t) vmax = Math.min(vmax, 1.0);
    if (maneuver) vmax = p.reverse ? 1.3 : 1.8;
    const allowed = car.allowed;
    const stopAt = Math.min(remaining - (car.mode === 'toExit' ? -5 : 0.1), allowed);
    const vStop = Math.sqrt(2 * DECEL * Math.max(0, stopAt - 0.15));
    const tanS = Math.abs(Math.tan(car.steer));
    const vCurve = tanS > 1e-3 ? Math.sqrt(1.6 * (L / tanS)) : Infinity;
    const vTarget = Math.max(0, Math.min(vmax, vStop, Math.max(1.0, vCurve)));
    let mag = Math.abs(car.speed);
    mag += Math.max(-DECEL * DT, Math.min(ACCEL * DT, vTarget - mag));
    if (stopAt <= 0.15) mag = Math.min(mag, Math.max(0, stopAt) * 2);
    car.speed = p.reverse ? -mag : mag;

    const stepLen = car.speed * DT;
    car.heading = wrapAngle(car.heading + (car.speed / L) * Math.tan(car.steer) * DT);
    car.rear = { x: car.rear.x + Math.cos(car.heading) * stepLen, y: car.rear.y + Math.sin(car.heading) * stepLen };
    bodyCircles(vc, car.rear, car.heading, car.body);

    if (car.speed > 0) {
      car.trailAcc += stepLen;
      if (car.trailAcc >= 0.5) {
        car.trailAcc = 0;
        car.trail.push({ ...car.rear });
        if (car.trail.length > 30) car.trail.shift();
      }
    }
  }

  private detectNearMisses(moving: Car[], hash: Map<number, Car[]>) {
    const near: Car[] = [];
    for (const a of moving) {
      this.neighbors(hash, a.rear, near);
      for (const b of near) {
        if (b === a || (b.mode !== 'parked' && b.id < a.id)) continue;
        if (Math.abs(a.speed) < 1.0 && Math.abs(b.speed) < 1.0) continue;
        if (b.mode === 'parked' && (a.mode === 'toSpot' || a.mode === 'backingOut')) continue;
        if (Math.hypot(a.body[2] - b.body[2], a.body[3] - b.body[3]) > 6.5) continue;
        const gap = circlesGap(a.body, a.vc.width / 2, b.body, b.vc.width / 2);
        if (gap >= 0.3) continue;
        const key = Math.min(a.id, b.id) * 1e6 + Math.max(a.id, b.id);
        if ((a.squeezePast.get(b.id) ?? -Infinity) > this.t) continue; // already logged as a standoff
        const until = this.pairCooldown.get(key) ?? -Infinity;
        if (this.t < until) continue;
        this.pairCooldown.set(key, this.t + 10);
        const x = (a.body[2] + b.body[2]) / 2;
        const y = (a.body[3] + b.body[3]) / 2;
        this.emit({ t: this.t, type: gap < 0 ? 'contact' : 'near_miss', a: a.id, b: b.id, x, y });
      }
    }
  }
}

/** Nearest drivable cell with clearance >= 2 (i.e. not hugging a wall or parked noses). */
function nearestClear(w: Compiled, p: Vec): number {
  const base = nearestDrivable(w, p);
  if (base < 0 || w.clearance[base] >= 2) return base;
  const cx = Math.floor(p.x / CELL);
  const cy = Math.floor(p.y / CELL);
  let best = base;
  let bestD = Infinity;
  for (let y = cy - 3; y <= cy + 3; y++)
    for (let x = cx - 3; x <= cx + 3; x++) {
      if (x < 0 || y < 0 || x >= w.cols || y >= w.rows) continue;
      const i = y * w.cols + x;
      if (!w.drivable[i] || w.clearance[i] < 2) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  return best;
}

function hashKey(x: number, y: number) {
  return Math.floor(x / 10) * 4096 + Math.floor(y / 10);
}
