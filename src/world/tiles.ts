/**
 * The tile grid is what the player paints. The simulation never reads it directly;
 * it is compiled into a drivable area + navigation grid (see compile.ts).
 *
 * Scale: 1 tile = 2.5 m. A parking spot is a 1 x 2 tile stamp (2.5 m x 5 m).
 */
export const TILE = 2.5;

export type Dir = 'N' | 'E' | 'S' | 'W';
export const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W'];
export const DIR_VEC: Record<Dir, { x: number; y: number }> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};
export const rotateCW = (d: Dir): Dir => DIRS[(DIRS.indexOf(d) + 1) % 4];
export const opposite = (d: Dir): Dir => DIRS[(DIRS.indexOf(d) + 2) % 4];

export type Tile =
  | { kind: 'empty' }
  | { kind: 'aisle'; oneWay?: Dir }
  /** `facing` is the side the spot opens onto (toward the aisle). `head` is the tile at the mouth. */
  | { kind: 'spot'; facing: Dir; head: boolean }
  /** `facing` points from the lot out to the street. */
  | { kind: 'entrance'; facing: Dir }
  | { kind: 'exit'; facing: Dir }
  | { kind: 'sidewalk' }
  | { kind: 'island' }
  | { kind: 'building' }
  | { kind: 'door' };

export type TileKind = Tile['kind'];

export interface Design {
  name: string;
  width: number;
  height: number;
  tiles: Tile[];
}

export const EMPTY: Tile = { kind: 'empty' };

export function makeDesign(name: string, width: number, height: number): Design {
  return { name, width, height, tiles: Array.from({ length: width * height }, () => EMPTY) };
}

export function cloneDesign(d: Design): Design {
  return { name: d.name, width: d.width, height: d.height, tiles: d.tiles.map((t) => ({ ...t })) };
}

export function inBounds(d: Design, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < d.width && y < d.height;
}

export function getTile(d: Design, x: number, y: number): Tile {
  return inBounds(d, x, y) ? d.tiles[y * d.width + x] : EMPTY;
}

/** Sets a tile. If it overwrites half of a spot, the other half is cleared too. */
export function setTile(d: Design, x: number, y: number, t: Tile): void {
  if (!inBounds(d, x, y)) return;
  const old = getTile(d, x, y);
  if (old.kind === 'spot') {
    const partner = spotPartner(x, y, old);
    if (inBounds(d, partner.x, partner.y) && getTile(d, partner.x, partner.y).kind === 'spot') {
      d.tiles[partner.y * d.width + partner.x] = EMPTY;
    }
  }
  d.tiles[y * d.width + x] = t;
}

function spotPartner(x: number, y: number, t: { facing: Dir; head: boolean }) {
  const f = DIR_VEC[t.facing];
  // head -> tail is "into" the spot, i.e. opposite to facing.
  return t.head ? { x: x - f.x, y: y - f.y } : { x: x + f.x, y: y + f.y };
}

/** Stamp a 1x2 spot whose mouth (head) is at (x, y), opening toward `facing`. */
export function stampSpot(d: Design, x: number, y: number, facing: Dir): boolean {
  const f = DIR_VEC[facing];
  const tx = x - f.x;
  const ty = y - f.y;
  if (!inBounds(d, x, y) || !inBounds(d, tx, ty)) return false;
  setTile(d, x, y, EMPTY);
  setTile(d, tx, ty, EMPTY);
  setTile(d, x, y, { kind: 'spot', facing, head: true });
  setTile(d, tx, ty, { kind: 'spot', facing, head: false });
  return true;
}

export function fillRect(d: Design, x0: number, y0: number, x1: number, y1: number, t: Tile): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setTile(d, x, y, { ...t });
}

export const isDrivable = (t: Tile): boolean =>
  t.kind === 'aisle' || t.kind === 'entrance' || t.kind === 'exit';
export const blocksSight = (t: Tile): boolean => t.kind === 'building' || t.kind === 'door';
export const isWalkable = (t: Tile): boolean =>
  t.kind === 'sidewalk' || t.kind === 'aisle' || t.kind === 'spot' || t.kind === 'island' ||
  t.kind === 'entrance' || t.kind === 'exit' || t.kind === 'door';
