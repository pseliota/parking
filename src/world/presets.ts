import { Design, Dir, fillRect, makeDesign, setTile, stampSpot } from './tiles';

function spotRow(d: Design, x0: number, x1: number, headY: number, facing: Dir): void {
  for (let x = x0; x <= x1; x++) stampSpot(d, x, headY, facing);
}

function storefront(d: Design, doors: number[]): void {
  fillRect(d, 0, 0, d.width - 1, 3, { kind: 'building' });
  for (const x of doors) setTile(d, x, 3, { kind: 'door' });
  fillRect(d, 1, 4, d.width - 2, 4, { kind: 'sidewalk' });
}

/** A strip mall: storefront on top, three double/single-loaded bays, perimeter aisles. */
export function stripMall(): Design {
  const d = makeDesign('Strip mall', 40, 28);
  storefront(d, [12, 27]);
  // Fire lane in front of the stores, perimeter aisles, bay aisles (all 3 tiles = 7.5 m, two-way).
  fillRect(d, 2, 5, 37, 7, { kind: 'aisle' });
  fillRect(d, 2, 5, 4, 26, { kind: 'aisle' });
  fillRect(d, 35, 5, 37, 26, { kind: 'aisle' });
  fillRect(d, 2, 12, 37, 14, { kind: 'aisle' });
  fillRect(d, 2, 19, 37, 21, { kind: 'aisle' });
  fillRect(d, 2, 24, 37, 26, { kind: 'aisle' });
  spotRow(d, 5, 34, 8, 'N');
  spotRow(d, 5, 34, 11, 'S');
  spotRow(d, 5, 34, 15, 'N');
  spotRow(d, 5, 34, 18, 'S');
  spotRow(d, 5, 34, 22, 'N');
  fillRect(d, 8, 27, 9, 27, { kind: 'entrance', facing: 'S' });
  fillRect(d, 30, 27, 31, 27, { kind: 'exit', facing: 'S' });
  return d;
}

/** A cramped lot whose aisles are only 5 m wide but two-way: expect standoffs. */
export function tightLot(): Design {
  const d = makeDesign('Tight two-way lot', 26, 17);
  storefront(d, [12]);
  fillRect(d, 2, 5, 23, 6, { kind: 'aisle' });
  fillRect(d, 2, 5, 3, 15, { kind: 'aisle' });
  fillRect(d, 22, 5, 23, 15, { kind: 'aisle' });
  fillRect(d, 2, 11, 23, 12, { kind: 'aisle' });
  spotRow(d, 4, 21, 7, 'N');
  spotRow(d, 4, 21, 10, 'S');
  spotRow(d, 4, 21, 13, 'N');
  fillRect(d, 2, 15, 23, 15, { kind: 'aisle' });
  fillRect(d, 6, 16, 7, 16, { kind: 'entrance', facing: 'S' });
  fillRect(d, 18, 16, 19, 16, { kind: 'exit', facing: 'S' });
  return d;
}

export const PRESETS: { id: string; make: () => Design }[] = [
  { id: 'strip', make: stripMall },
  { id: 'tight', make: tightLot },
];
