import { SimEvent } from '../sim/events';

/**
 * Metrics are computed purely from the event log. Each one stays separate on purpose:
 * there is no combined score yet.
 */
export interface Metrics {
  spots: number;
  arrivals: number;
  entered: number;
  parked: number;
  balked: number;
  gaveUp: number;
  left: number;
  peakParked: number;
  peakOccupancy: number;
  maxStreetQueue: number;
  searchMedian: number;
  searchP90: number;
  walkAvg: number;
  exitAvg: number;
  standoffs: number;
  standoffAvg: number;
  standoffMax: number;
  standoffResolutions: Record<string, number>;
  gridlocks: number;
  nearMisses: number;
  contacts: number;
  corrections: number;
}

export interface MetricDef {
  key: keyof Metrics;
  label: string;
  unit?: string;
  /** Which direction is better, for highlighting comparisons. */
  better: 'higher' | 'lower' | 'none';
  format?: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => (Number.isFinite(v) ? `${v.toFixed(0)}s` : '–');
const m = (v: number) => (Number.isFinite(v) ? `${v.toFixed(0)}m` : '–');

export const METRIC_DEFS: MetricDef[] = [
  { key: 'spots', label: 'Spots', better: 'higher' },
  { key: 'peakOccupancy', label: 'Peak occupancy', better: 'none', format: pct },
  { key: 'parked', label: 'Cars parked', better: 'higher' },
  { key: 'searchMedian', label: 'Time to park (median)', better: 'lower', format: sec },
  { key: 'searchP90', label: 'Time to park (90th pct)', better: 'lower', format: sec },
  { key: 'walkAvg', label: 'Walk to door (avg)', better: 'lower', format: m },
  { key: 'exitAvg', label: 'Time to exit (avg)', better: 'lower', format: sec },
  { key: 'gaveUp', label: 'Gave up searching', better: 'lower' },
  { key: 'balked', label: 'Turned away at street', better: 'lower' },
  { key: 'maxStreetQueue', label: 'Max street queue', better: 'lower' },
  { key: 'standoffs', label: 'Standoffs', better: 'lower' },
  { key: 'standoffAvg', label: 'Standoff length (avg)', better: 'lower', format: sec },
  { key: 'gridlocks', label: 'Gridlocks', better: 'lower' },
  { key: 'corrections', label: 'Tight-turn corrections', better: 'lower' },
  { key: 'nearMisses', label: 'Near-misses', better: 'lower' },
  { key: 'contacts', label: 'Fender-benders', better: 'lower' },
];

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function computeMetrics(events: readonly SimEvent[], spots: number): Metrics {
  const park: number[] = [];
  const walk: number[] = [];
  const exit: number[] = [];
  const standoffDur: number[] = [];
  const resolutions: Record<string, number> = {};
  let arrivals = 0;
  let entered = 0;
  let balked = 0;
  let gaveUp = 0;
  let left = 0;
  let peakParked = 0;
  let maxQueue = 0;
  let standoffs = 0;
  let gridlocks = 0;
  let nearMisses = 0;
  let contacts = 0;
  let corrections = 0;
  let parkedNow = 0;

  for (const e of events) {
    switch (e.type) {
      case 'arrive': arrivals++; break;
      case 'enter': entered++; break;
      case 'balk': balked++; break;
      case 'gave_up': gaveUp++; break;
      case 'parked':
        park.push(e.sinceArrival);
        walk.push(e.walk);
        parkedNow++;
        peakParked = Math.max(peakParked, parkedNow);
        break;
      case 'unpark': parkedNow--; break;
      case 'left':
        left++;
        if (e.parked) exit.push(e.exitTime);
        break;
      case 'standoff_start': standoffs++; break;
      case 'standoff_end':
        standoffDur.push(e.duration);
        resolutions[e.resolvedBy] = (resolutions[e.resolvedBy] ?? 0) + 1;
        break;
      case 'gridlock': gridlocks++; break;
      case 'near_miss': nearMisses++; break;
      case 'contact': contacts++; break;
      case 'correction': corrections++; break;
      case 'sample': maxQueue = Math.max(maxQueue, e.queue); break;
    }
  }

  return {
    spots,
    arrivals,
    entered,
    parked: park.length,
    balked,
    gaveUp,
    left,
    peakParked,
    peakOccupancy: spots > 0 ? peakParked / spots : 0,
    maxStreetQueue: maxQueue,
    searchMedian: quantile(park, 0.5),
    searchP90: quantile(park, 0.9),
    walkAvg: avg(walk),
    exitAvg: avg(exit),
    standoffs,
    standoffAvg: avg(standoffDur),
    standoffMax: standoffDur.length ? Math.max(...standoffDur) : 0,
    standoffResolutions: resolutions,
    gridlocks,
    nearMisses,
    contacts,
    corrections,
  };
}

export function formatMetric(def: MetricDef, value: number): string {
  if (def.format) return def.format(value);
  return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '–';
}
