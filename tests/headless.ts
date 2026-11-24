import { computeMetrics } from '../src/metrics/metrics';
import { Simulation, SimConfig } from '../src/sim/sim';
import { compile } from '../src/world/compile';
import { Design } from '../src/world/tiles';

export function runDay(design: Design, cfg: Partial<SimConfig> = {}) {
  const world = compile(design);
  const sim = new Simulation(world, cfg);
  while (!sim.done) sim.step();
  const usable = world.spots.filter((s) => s.approachCell >= 0).length;
  return { sim, world, metrics: computeMetrics(sim.events, usable) };
}
