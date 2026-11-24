/**
 * The simulation only reports what happens. Metrics are computed from these events
 * afterwards (see metrics/metrics.ts), so new metrics never require touching driver code.
 */
export type SimEvent =
  | { t: number; type: 'arrive'; car: number }
  | { t: number; type: 'enter'; car: number; queued: number }
  | { t: number; type: 'balk'; car: number; waited: number }
  | { t: number; type: 'spot_claimed'; car: number; spot: number; search: number }
  | { t: number; type: 'parked'; car: number; spot: number; walk: number; sinceArrival: number }
  | { t: number; type: 'unpark'; car: number; spot: number }
  | { t: number; type: 'left'; car: number; parked: boolean; inLot: number; exitTime: number }
  | { t: number; type: 'gave_up'; car: number; searched: number }
  | { t: number; type: 'standoff_start'; id: number; cars: number[]; x: number; y: number }
  | { t: number; type: 'standoff_end'; id: number; duration: number; resolvedBy: string }
  | { t: number; type: 'gridlock'; id: number; cars: number[]; x: number; y: number; removed: number }
  | { t: number; type: 'correction'; car: number; x: number; y: number }
  | { t: number; type: 'near_miss'; a: number; b: number; x: number; y: number }
  | { t: number; type: 'contact'; a: number; b: number; x: number; y: number }
  | { t: number; type: 'sample'; queue: number; parked: number; moving: number };

export type SimEventType = SimEvent['type'];
