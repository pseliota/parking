# Parking Lot Lab

A prototype game about designing parking lots. Paint a lot on a tile grid, then watch simulated
drivers enter, search for a spot, park, back out and leave. Each design is measured on separate
metrics (no combined score yet) so you can compare layouts on the same stream of drivers.

## Running

```sh
npm install
npm run dev        # open the printed localhost URL
npm test           # unit + simulation sanity tests
npm run build      # typecheck + production build
```

## Playing

- **Build** (left): pick a tool and drag on the grid. `R` rotates the direction used by one-way
  aisles and parking spots. Right-drag erases. Spots are 1 × 2 tile stamps; the arrow shows the
  side that opens onto the aisle. Entrances and exits face the street automatically.
- **Inspect** (`V`): click a car to see its route, the space it's about to drive through,
  its search radius and what it's waiting for.
- **Show**: a traffic heatmap, incident markers (standoffs ✕, near-misses ●) and the nav grid.
- **Scenario**: peak arrival rate, average stay, day length and random seed. The same seed
  produces the same drivers, so two designs can be compared fairly.
- **Run full day & record** simulates the whole day quickly and adds a column to the
  comparison table (best values in green, worst in red).

Two layouts are included: a strip mall, and a deliberately cramped lot with 5 m two-way aisles.

## How the simulation works

```
tile grid ──compile──▶ drivable area + fine nav grid (1.25 m cells)
                        ├─ per-cell costs: keep right, stay off walls, one-way, portal direction
                        ├─ spots (stall geometry, approach cell, walking distance to a door)
                        └─ entrances / exits

each 0.1 s tick:
  behavior   searching → claim spot → drive in → parked → back out → leave
  routing    A* over (cell, heading): turning costs, so no U-turns or zigzags;
             traffic rules are costs, so rule-breaking drivers can ignore them
  motion     kinematic bicycle model following the route with pure pursuit (forward and reverse)
  avoidance  each car predicts its body over the next few meters and slows for bodies in the way;
             when two predicted paths cross, right-of-way decides who yields
  standoffs  wait-for graph cycle detection; drivers wave through, reroute, back up,
             pull back into their stall, or as a last resort squeeze past
  events     everything is logged; metrics are computed from the log afterwards
```

Key files:

| File | What it does |
|---|---|
| `src/world/tiles.ts` | Tile types and the editable design |
| `src/world/compile.ts` | Design → nav grid, spots, portals, walking distances, warnings |
| `src/world/nav.ts` | Heading-aware A* with rule costs |
| `src/sim/sim.ts` | Drivers, motion, avoidance, standoff handling |
| `src/sim/events.ts` | Event types the simulation emits |
| `src/metrics/metrics.ts` | Metrics computed from events |
| `src/ui/` | Canvas renderer and editor |

## Metrics

Spots · peak occupancy · cars parked · time to park (median / 90th percentile) · walk to door ·
time to exit · gave up searching · turned away at the street · max street queue · standoffs and
their length · gridlocks · tight-turn corrections · near-misses · fender-benders.

## Known limitations

- Single level, top-down; one vehicle size class pair (sedan, SUV); no pedestrians yet.
- Drivers see spots within a radius (blocked by buildings) rather than a full visibility model.
- Parking is front-in only; spot entry is a fixed curve and the car snaps into the final pose.
- In very tight layouts cars can visually overlap while "squeezing past"; that's logged as a
  standoff rather than silently ignored.
- The street is drawn along the bottom edge only.
