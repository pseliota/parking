import { describe, expect, test } from 'vitest';
import { computeMetrics } from '../src/metrics/metrics';
import { SimEvent } from '../src/sim/events';
import { Path } from '../src/sim/path';
import { stripMall, tightLot } from '../src/world/presets';
import { runDay } from './headless';

describe('path', () => {
  test('measures length and interpolates', () => {
    const p = new Path([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(p.length).toBeCloseTo(10);
    expect(p.at(4).x).toBeCloseTo(4);
    expect(p.project({ x: 6.2, y: 1 }, 5)).toBeCloseTo(6.2);
  });
});

describe('metrics', () => {
  test('are computed from events alone', () => {
    const events: SimEvent[] = [
      { t: 1, type: 'arrive', car: 1 },
      { t: 1, type: 'enter', car: 1, queued: 0 },
      { t: 30, type: 'parked', car: 1, spot: 0, walk: 20, sinceArrival: 29 },
      { t: 40, type: 'arrive', car: 2 },
      { t: 130, type: 'balk', car: 2, waited: 90 },
      { t: 200, type: 'unpark', car: 1, spot: 0 },
      { t: 230, type: 'left', car: 1, parked: true, inLot: 229, exitTime: 30 },
    ];
    const m = computeMetrics(events, 10);
    expect(m.parked).toBe(1);
    expect(m.balked).toBe(1);
    expect(m.searchMedian).toBe(29);
    expect(m.walkAvg).toBe(20);
    expect(m.exitAvg).toBe(30);
    expect(m.peakOccupancy).toBeCloseTo(0.1);
  });
});

describe('simulation', () => {
  test('is deterministic for a given seed', () => {
    const a = runDay(stripMall(), { duration: 600, seed: 7 }).metrics;
    const b = runDay(stripMall(), { duration: 600, seed: 7 }).metrics;
    expect(a).toEqual(b);
  });

  // Sanity check on the driver logic itself: a roomy lot with light traffic should
  // never jam. If this fails, the bug is in the simulation, not the design.
  test('a roomy lot with light traffic flows freely', () => {
    const { metrics: m } = runDay(stripMall(), { duration: 1800, peakPerMin: 3, seed: 3 });
    expect(m.arrivals).toBeGreaterThan(30);
    expect(m.balked).toBe(0);
    expect(m.gaveUp).toBe(0);
    expect(m.gridlocks).toBe(0);
    expect(m.parked).toBe(m.entered);
  }, 60000);

  test('a cramped two-way lot scores worse than the strip mall', () => {
    const cfg = { duration: 1800, peakPerMin: 6, seed: 2 };
    const good = runDay(stripMall(), cfg).metrics;
    const bad = runDay(tightLot(), cfg).metrics;
    expect(bad.searchMedian).toBeGreaterThan(good.searchMedian);
    expect(bad.balked).toBeGreaterThan(good.balked);
  }, 60000);
});
