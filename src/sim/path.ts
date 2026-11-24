import { Vec, angleOf, dist, sub } from '../core/vec';

/**
 * A polyline the car's rear axle follows. `reverse` means the car drives it backwards
 * (rear first), e.g. backing out of a stall.
 */
export class Path {
  readonly pts: Vec[];
  readonly cum: number[];
  readonly length: number;

  constructor(points: Vec[], readonly reverse = false, spacing = 0.5) {
    const pts = resample(points, spacing);
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + dist(pts[i - 1], pts[i]));
    this.length = this.cum[this.cum.length - 1];
  }

  /** Point at distance s along the path (clamped). */
  at(s: number): Vec {
    const { i, t } = this.locate(s);
    const a = this.pts[i];
    const b = this.pts[Math.min(i + 1, this.pts.length - 1)];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /** Direction of travel along the path at s, as an angle. */
  tangent(s: number): number {
    const { i } = this.locate(s);
    const a = this.pts[Math.min(i, this.pts.length - 2)];
    const b = this.pts[Math.min(i + 1, this.pts.length - 1)];
    return angleOf(sub(b, a));
  }

  /** Projects p onto the path, searching forward from `fromS` within `window` meters. */
  project(p: Vec, fromS: number, window = 6): number {
    const { i: start } = this.locate(Math.max(0, fromS - 1));
    let best = fromS;
    let bestD = Infinity;
    for (let i = start; i < this.pts.length - 1 && this.cum[i] <= fromS + window; i++) {
      const a = this.pts[i];
      const b = this.pts[i + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const l2 = abx * abx + aby * aby || 1e-9;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2));
      const qx = a.x + abx * t;
      const qy = a.y + aby * t;
      const d = (p.x - qx) ** 2 + (p.y - qy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = this.cum[i] + Math.sqrt(l2) * t;
      }
    }
    return Math.max(best, fromS - 0.25);
  }

  private locate(s: number): { i: number; t: number } {
    if (s <= 0 || this.pts.length < 2) return { i: 0, t: 0 };
    if (s >= this.length) return { i: this.pts.length - 2, t: 1 };
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] <= s) lo = m;
      else hi = m;
    }
    const seg = this.cum[hi] - this.cum[lo] || 1e-9;
    return { i: lo, t: (s - this.cum[lo]) / seg };
  }
}

function resample(points: Vec[], spacing: number): Vec[] {
  const clean: Vec[] = [];
  for (const p of points) {
    if (clean.length === 0 || dist(clean[clean.length - 1], p) > 1e-3) clean.push(p);
  }
  if (clean.length < 2) return clean.length === 1 ? [clean[0], { x: clean[0].x + 1e-3, y: clean[0].y }] : clean;
  const out: Vec[] = [clean[0]];
  let carry = 0;
  for (let i = 0; i < clean.length - 1; i++) {
    const a = clean[i];
    const b = clean[i + 1];
    const segLen = dist(a, b);
    let s = spacing - carry;
    while (s < segLen) {
      const t = s / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      s += spacing;
    }
    carry = segLen - (s - spacing);
  }
  const last = clean[clean.length - 1];
  if (dist(out[out.length - 1], last) > 1e-3) out.push(last);
  return out;
}
