import { describe, expect, test } from 'vitest';
import { compile } from '../src/world/compile';
import { findRoute } from '../src/world/nav';
import { stripMall, tightLot } from '../src/world/presets';
import { fillRect, getTile, makeDesign, setTile, stampSpot } from '../src/world/tiles';

describe('tiles', () => {
  test('stamping a spot writes a head and tail tile', () => {
    const d = makeDesign('t', 5, 5);
    stampSpot(d, 2, 2, 'N');
    expect(getTile(d, 2, 2)).toEqual({ kind: 'spot', facing: 'N', head: true });
    expect(getTile(d, 2, 3)).toEqual({ kind: 'spot', facing: 'N', head: false });
  });

  test('overwriting half a spot clears the other half', () => {
    const d = makeDesign('t', 5, 5);
    stampSpot(d, 2, 2, 'N');
    setTile(d, 2, 3, { kind: 'aisle' });
    expect(getTile(d, 2, 2).kind).toBe('empty');
  });
});

describe('compile', () => {
  test('strip mall compiles cleanly', () => {
    const w = compile(stripMall());
    expect(w.warnings).toEqual([]);
    expect(w.spots).toHaveLength(150);
    expect(w.spots.every((s) => s.approachCell >= 0 && Number.isFinite(s.walkDist))).toBe(true);
    expect(w.entrances).toHaveLength(1);
    expect(w.exits).toHaveLength(1);
  });

  test('tight lot compiles cleanly', () => {
    expect(compile(tightLot()).warnings).toEqual([]);
  });

  test('a blank lot warns about missing pieces', () => {
    const w = compile(makeDesign('blank', 10, 10));
    expect(w.warnings.join(' ')).toMatch(/entrance/i);
    expect(w.warnings.join(' ')).toMatch(/exit/i);
  });

  test('spots facing away from any aisle are flagged unreachable', () => {
    const d = stripMall();
    stampSpot(d, 20, 9, 'S'); // faces into another spot row, not an aisle
    const w = compile(d);
    expect(w.warnings.join(' ')).toMatch(/spot/);
  });
});

describe('routing', () => {
  // A loop: two parallel horizontal aisles joined at both ends.
  function loop(oneWayTop?: 'E' | 'W') {
    const d = makeDesign('loop', 20, 9);
    fillRect(d, 0, 0, 19, 2, { kind: 'aisle', ...(oneWayTop ? { oneWay: oneWayTop } : {}) });
    fillRect(d, 0, 6, 19, 8, { kind: 'aisle' });
    fillRect(d, 0, 0, 2, 8, { kind: 'aisle' });
    fillRect(d, 17, 0, 19, 8, { kind: 'aisle' });
    return compile(d);
  }
  const cell = (w: ReturnType<typeof compile>, x: number, y: number) => y * w.cols + x;

  test('finds a route between two cells', () => {
    const w = loop();
    const r = findRoute(w, cell(w, 20, 2), [cell(w, 30, 2)], { wrongWayPenalty: 60 });
    expect(r).not.toBeNull();
  });

  test('respects one-way aisles when an alternative exists', () => {
    const w = loop('E');
    // Going west along the top: legal drivers loop around via the bottom aisle instead.
    const start = cell(w, 30, 2);
    const goal = cell(w, 10, 2);
    const r = findRoute(w, start, [goal], { wrongWayPenalty: 60, startHeading: Math.PI })!;
    const maxY = Math.max(...r.cells.map((c) => Math.floor(c / w.cols)));
    expect(maxY).toBeGreaterThan(10); // went through the bottom aisle
    // A rule-breaker takes the short wrong-way route.
    const rb = findRoute(w, start, [goal], { wrongWayPenalty: 0.5, startHeading: Math.PI })!;
    expect(Math.max(...rb.cells.map((c) => Math.floor(c / w.cols)))).toBeLessThan(6);
  });
});
