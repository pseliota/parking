import { Vec } from '../core/vec';

export interface VehicleClass {
  name: string;
  length: number;
  width: number;
  wheelbase: number;
  /** Distance from rear bumper to rear axle. */
  rearOverhang: number;
  maxSteer: number;
}

export const SEDAN: VehicleClass = {
  name: 'sedan',
  length: 4.6,
  width: 1.85,
  wheelbase: 2.7,
  rearOverhang: 0.95,
  maxSteer: 0.6,
};

export const SUV: VehicleClass = {
  name: 'suv',
  length: 5.0,
  width: 2.0,
  wheelbase: 2.95,
  rearOverhang: 1.0,
  maxSteer: 0.58,
};

/** Distance from the rear axle forward to the center of the body. */
export const bodyOffset = (vc: VehicleClass) => vc.length / 2 - vc.rearOverhang;

/**
 * Bodies are approximated by three circles along the car's axis for cheap overlap tests.
 * Returns flat [x0, y0, x1, y1, x2, y2]; radius is width/2 (+ margin).
 */
export function bodyCircles(vc: VehicleClass, rear: Vec, heading: number, out: number[] = []): number[] {
  const cx = Math.cos(heading);
  const cy = Math.sin(heading);
  const c = bodyOffset(vc);
  const r = vc.width / 2;
  const half = vc.length / 2 - r;
  out.length = 6;
  for (let k = 0; k < 3; k++) {
    const o = c + (k - 1) * half;
    out[2 * k] = rear.x + cx * o;
    out[2 * k + 1] = rear.y + cy * o;
  }
  return out;
}

/** Minimum gap between two 3-circle bodies (negative = overlap). */
export function circlesGap(a: number[], ra: number, b: number[], rb: number): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const d = Math.hypot(a[2 * i] - b[2 * j], a[2 * i + 1] - b[2 * j + 1]);
      if (d < best) best = d;
    }
  }
  return best - ra - rb;
}

/** The four corners of the car's rectangle, for drawing. */
export function bodyCorners(vc: VehicleClass, rear: Vec, heading: number): Vec[] {
  const cx = Math.cos(heading);
  const cy = Math.sin(heading);
  const back = -vc.rearOverhang;
  const front = vc.length - vc.rearOverhang;
  const hw = vc.width / 2;
  const p = (along: number, side: number): Vec => ({
    x: rear.x + cx * along - cy * side,
    y: rear.y + cy * along + cx * side,
  });
  return [p(back, -hw), p(front, -hw), p(front, hw), p(back, hw)];
}
