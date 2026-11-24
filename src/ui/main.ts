import { METRIC_DEFS, Metrics, computeMetrics, formatMetric } from '../metrics/metrics';
import { DEFAULT_CONFIG, SimConfig, Simulation } from '../sim/sim';
import { Compiled, compile } from '../world/compile';
import { stripMall, tightLot } from '../world/presets';
import {
  DIR_VEC,
  Design,
  Dir,
  TILE,
  Tile,
  cloneDesign,
  getTile,
  inBounds,
  makeDesign,
  rotateCW,
  setTile,
  stampSpot,
} from '../world/tiles';
import { STREET_TILES, View, drawArrow, drawCars, drawDesign, drawHeat, drawIncidents, drawNav, drawSelected } from './render';

// ------------------------------------------------------------------ state

type ToolId = 'inspect' | 'aisle' | 'oneway' | 'spot' | 'entrance' | 'exit' | 'sidewalk' | 'island' | 'building' | 'door' | 'erase';

const TOOLS: { id: ToolId; label: string; key: string; color: string }[] = [
  { id: 'inspect', label: 'Inspect car', key: 'V', color: 'transparent' },
  { id: 'aisle', label: 'Two-way aisle', key: '1', color: '#4b5058' },
  { id: 'oneway', label: 'One-way aisle', key: '2', color: '#4b5058' },
  { id: 'spot', label: 'Parking spot', key: '3', color: '#ffffff' },
  { id: 'entrance', label: 'Entrance', key: '4', color: '#4caf50' },
  { id: 'exit', label: 'Exit', key: '5', color: '#e05a47' },
  { id: 'sidewalk', label: 'Sidewalk', key: '6', color: '#cfc9bd' },
  { id: 'island', label: 'Island', key: '7', color: '#6fa356' },
  { id: 'building', label: 'Building', key: '8', color: '#b9926f' },
  { id: 'door', label: 'Store door', key: '9', color: '#f2c14e' },
  { id: 'erase', label: 'Erase', key: '0', color: '#a9c98a' },
];

interface RunRecord {
  name: string;
  seed: number;
  metrics: Metrics;
}

const params = new URLSearchParams(location.search);
const store = {
  get<T>(k: string): T | null {
    try {
      const s = localStorage.getItem(k);
      return s ? (JSON.parse(s) as T) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};

let design: Design = loadInitialDesign();
let world: Compiled = compile(design);
let cfg: SimConfig = { ...DEFAULT_CONFIG, ...(store.get<Partial<SimConfig>>('parking.cfg') ?? {}) };
for (const k of ['duration', 'peakPerMin', 'seed', 'dwellMean'] as const) {
  if (params.has(k)) cfg = { ...cfg, [k]: Number(params.get(k)) };
}
let sim = new Simulation(world, cfg);
let playing = false;
let speed = 4;
let tool: ToolId = 'inspect';
let dir: Dir = 'N';
let selected = -1;
let hover: { x: number; y: number } | null = null;
let painting: 'paint' | 'erase' | null = null;
let lastPainted = '';
let lastTile: { x: number; y: number } | null = null;
let runs: RunRecord[] = store.get<RunRecord[]>('parking.runs') ?? [];
let view: View = { ppm: 8, ox: 0, oy: 0 };

function loadInitialDesign(): Design {
  const preset = params.get('preset');
  if (preset === 'tight') return tightLot();
  if (preset === 'strip') return stripMall();
  const saved = store.get<Design>('parking.design');
  if (saved && Array.isArray(saved.tiles) && saved.tiles.length === saved.width * saved.height) return saved;
  return stripMall();
}

// ------------------------------------------------------------------ DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const playBtn = $<HTMLButtonElement>('play');
const metricsTable = $<HTMLTableElement>('metrics');
const runsTable = $<HTMLTableElement>('runs');
const inspector = $<HTMLDivElement>('inspector');
const nameInput = $<HTMLInputElement>('design-name');
const overlays = {
  heat: $<HTMLInputElement>('ov-heat'),
  incidents: $<HTMLInputElement>('ov-incidents'),
  nav: $<HTMLInputElement>('ov-nav'),
};

function buildToolButtons() {
  const wrap = $('tool-buttons');
  wrap.innerHTML = '';
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="sw" style="background:${t.color}"></span>${t.label}<kbd>${t.key}</kbd>`;
    b.className = t.id === tool ? 'active' : '';
    b.onclick = () => setTool(t.id);
    wrap.appendChild(b);
  }
}

function setTool(t: ToolId) {
  tool = t;
  buildToolButtons();
  canvas.style.cursor = t === 'inspect' ? 'pointer' : 'crosshair';
}

function updateDirLabel() {
  $('dir-label').textContent = { N: 'North ↑', E: 'East →', S: 'South ↓', W: 'West ←' }[dir];
}

// ------------------------------------------------------------------ design changes

function designChanged() {
  world = compile(design);
  resetSim();
  store.set('parking.design', design);
  $('warnings').textContent = world.warnings.join(' ');
}

function resetSim() {
  sim = new Simulation(world, cfg);
  selected = -1;
  renderMetrics();
}

/**
 * Portals face the street: the side that's off the lot if there is one, else the side opposite
 * the aisle they connect to, else the side that isn't pavement nearest the lot edge.
 */
function edgeFacing(x: number, y: number): Dir {
  const dirs: Dir[] = ['S', 'N', 'E', 'W'];
  const off = dirs.find((d) => !inBounds(design, x + DIR_VEC[d].x, y + DIR_VEC[d].y));
  if (off) return off;
  // Next to an aisle: the street is on the opposite side.
  const aisle = dirs.find((d) => getTile(design, x + DIR_VEC[d].x, y + DIR_VEC[d].y).kind === 'aisle');
  if (aisle) return ({ N: 'S', S: 'N', E: 'W', W: 'E' } as const)[aisle];
  const paved = new Set(['aisle', 'entrance', 'exit', 'spot']);
  const open = dirs.filter((d) => !paved.has(getTile(design, x + DIR_VEC[d].x, y + DIR_VEC[d].y).kind));
  const byEdge = (d: Dir) => ({ N: y, S: design.height - 1 - y, W: x, E: design.width - 1 - x })[d];
  const pool = open.length ? open : dirs;
  return pool.sort((a, b) => byEdge(a) - byEdge(b))[0];
}

/** Paint every tile on the line from the last painted tile to (x, y), so fast drags leave no gaps. */
function paintTo(x: number, y: number, mode: 'paint' | 'erase') {
  const from = lastTile ?? { x, y };
  let changed = false;
  const steps = Math.max(Math.abs(x - from.x), Math.abs(y - from.y));
  for (let i = 0; i <= steps; i++) {
    const tx = Math.round(from.x + ((x - from.x) * i) / Math.max(1, steps));
    const ty = Math.round(from.y + ((y - from.y) * i) / Math.max(1, steps));
    changed = applyTool(tx, ty, mode) || changed;
  }
  lastTile = { x, y };
  if (changed) designChanged();
}

function applyTool(x: number, y: number, mode: 'paint' | 'erase'): boolean {
  if (!inBounds(design, x, y)) return false;
  const key = `${x},${y},${mode},${tool},${dir}`;
  if (key === lastPainted) return false;
  lastPainted = key;
  if (mode === 'erase' || tool === 'erase') {
    setTile(design, x, y, { kind: 'empty' });
  } else {
    let t: Tile | null = null;
    switch (tool) {
      case 'aisle': t = { kind: 'aisle' }; break;
      case 'oneway': t = { kind: 'aisle', oneWay: dir }; break;
      case 'entrance': t = { kind: 'entrance', facing: edgeFacing(x, y) }; break;
      case 'exit': t = { kind: 'exit', facing: edgeFacing(x, y) }; break;
      case 'sidewalk': t = { kind: 'sidewalk' }; break;
      case 'island': t = { kind: 'island' }; break;
      case 'building': t = { kind: 'building' }; break;
      case 'door': t = { kind: 'door' }; break;
      case 'spot': {
        const cur = getTile(design, x, y);
        if (cur.kind === 'spot' && cur.facing === dir) return false; // already a spot here
        stampSpot(design, x, y, dir);
        break;
      }
      default: return false;
    }
    if (t) setTile(design, x, y, t);
  }
  return true;
}

// ------------------------------------------------------------------ input

function tileAt(ev: MouseEvent): { x: number; y: number; wx: number; wy: number } {
  const r = canvas.getBoundingClientRect();
  const px = ev.clientX - r.left;
  const py = ev.clientY - r.top;
  const wx = (px - view.ox) / view.ppm;
  const wy = (py - view.oy) / view.ppm;
  return { x: Math.floor(wx / TILE), y: Math.floor(wy / TILE), wx, wy };
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (ev) => {
  const p = tileAt(ev);
  if (ev.button === 0 && tool === 'inspect') {
    selected = pickCar(p.wx, p.wy);
    return;
  }
  painting = ev.button === 2 ? 'erase' : 'paint';
  lastPainted = '';
  lastTile = null;
  paintTo(p.x, p.y, painting);
});
window.addEventListener('mouseup', () => (painting = null));
canvas.addEventListener('mousemove', (ev) => {
  const p = tileAt(ev);
  hover = { x: p.x, y: p.y };
  if (painting) paintTo(p.x, p.y, painting);
});
canvas.addEventListener('mouseleave', () => (hover = null));

function pickCar(wx: number, wy: number): number {
  let best = -1;
  let bestD = 3;
  for (const c of sim.cars.values()) {
    const d = Math.hypot(c.body[2] - wx, c.body[3] - wy);
    if (d < bestD) {
      bestD = d;
      best = c.id;
    }
  }
  return best;
}

window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).tagName === 'INPUT') return;
  if (ev.key === ' ') {
    ev.preventDefault();
    togglePlay();
    return;
  }
  if (ev.key === 'r' || ev.key === 'R') {
    dir = rotateCW(dir);
    updateDirLabel();
    return;
  }
  const t = TOOLS.find((t) => t.key.toLowerCase() === ev.key.toLowerCase());
  if (t) setTool(t.id);
});

function togglePlay() {
  playing = !playing;
  if (sim.done) {
    resetSim();
    playing = true;
  }
  playBtn.textContent = playing ? '❚❚ Pause' : '▶ Play';
}

playBtn.onclick = togglePlay;
$('reset').onclick = () => resetSim();
$<HTMLSelectElement>('speed').onchange = (e) => (speed = Number((e.target as HTMLSelectElement).value));

$<HTMLSelectElement>('preset').onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (!v) return;
  design = v === 'strip' ? stripMall() : v === 'tight' ? tightLot() : blankLot();
  nameInput.value = design.name;
  (e.target as HTMLSelectElement).value = '';
  designChanged();
};

function blankLot(): Design {
  const d = makeDesign('My lot', 40, 28);
  return d;
}

nameInput.value = design.name;
nameInput.oninput = () => {
  design.name = nameInput.value || 'Untitled';
  store.set('parking.design', design);
};

Object.values(overlays).forEach((o) => (o.onchange = () => draw()));

// Scenario config.
function bindConfig() {
  const rate = $<HTMLInputElement>('cfg-rate');
  const dwell = $<HTMLInputElement>('cfg-dwell');
  const dur = $<HTMLSelectElement>('cfg-duration');
  const seed = $<HTMLInputElement>('cfg-seed');
  const sync = () => {
    rate.value = String(cfg.peakPerMin);
    $('cfg-rate-v').textContent = String(cfg.peakPerMin);
    dwell.value = String(Math.round(cfg.dwellMean / 60));
    $('cfg-dwell-v').textContent = String(Math.round(cfg.dwellMean / 60));
    dur.value = String(cfg.duration);
    seed.value = String(cfg.seed);
    $('clock-end').textContent = fmtClock(cfg.duration);
  };
  const changed = () => {
    cfg = {
      ...cfg,
      peakPerMin: Number(rate.value),
      dwellMean: Number(dwell.value) * 60,
      duration: Number(dur.value),
      seed: Math.max(1, Math.floor(Number(seed.value) || 1)),
    };
    store.set('parking.cfg', cfg);
    sync();
    resetSim();
  };
  rate.oninput = changed;
  dwell.oninput = changed;
  dur.onchange = changed;
  seed.onchange = changed;
  sync();
}

// ------------------------------------------------------------------ metrics UI

function usableSpots(w: Compiled) {
  return w.spots.filter((s) => s.approachCell >= 0).length;
}

function renderMetrics() {
  const m = computeMetrics(sim.events, usableSpots(world));
  let parkedNow = 0;
  for (const c of sim.cars.values()) if (c.mode === 'parked') parkedNow++;
  const rows = [
    `<tr><td>Parked now</td><td>${parkedNow} / ${m.spots}</td></tr>`,
    `<tr><td>Waiting on street</td><td>${sim.queues.reduce((a, q) => a + q.length, 0)}</td></tr>`,
    ...METRIC_DEFS.filter((d) => d.key !== 'spots').map(
      (d) => `<tr><td>${d.label}</td><td>${formatMetric(d, m[d.key] as number)}</td></tr>`,
    ),
  ];
  metricsTable.innerHTML = rows.join('');
  $('clock').textContent = fmtClock(sim.t);
}

function renderRuns() {
  if (runs.length === 0) {
    runsTable.innerHTML = '<tr><td class="hint">Record a full day to compare designs on the same drivers.</td></tr>';
    return;
  }
  const legend = `<tr><td colspan="${runs.length + 1}" class="legend">${runs
    .map((r, i) => `<b>#${i + 1}</b> ${escapeHtml(r.name)} <span class="hint">(seed ${r.seed})</span>`)
    .join('<br>')}</td></tr>`;
  const head = `${legend}<tr><th>Metric</th>${runs.map((_, i) => `<th>#${i + 1}</th>`).join('')}</tr>`;
  const body = METRIC_DEFS.map((d) => {
    const vals = runs.map((r) => r.metrics[d.key] as number);
    const finite = vals.filter((v) => Number.isFinite(v));
    const best = d.better === 'higher' ? Math.max(...finite) : d.better === 'lower' ? Math.min(...finite) : NaN;
    const worst = d.better === 'higher' ? Math.min(...finite) : d.better === 'lower' ? Math.max(...finite) : NaN;
    const cells = vals.map((v) => {
      const cls = runs.length > 1 && best !== worst ? (v === best ? 'best' : v === worst ? 'worst' : '') : '';
      return `<td class="${cls}">${formatMetric(d, v)}</td>`;
    });
    return `<tr><td>${d.label}</td>${cells.join('')}</tr>`;
  });
  runsTable.innerHTML = head + body.join('');
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

$('clear-runs').onclick = () => {
  runs = [];
  store.set('parking.runs', runs);
  renderRuns();
};

$('record').onclick = () => {
  const btn = $<HTMLButtonElement>('record');
  const bar = $('progress');
  const fill = bar.firstElementChild as HTMLDivElement;
  btn.disabled = true;
  bar.hidden = false;
  const runWorld = compile(cloneDesign(design));
  const runSim = new Simulation(runWorld, cfg);
  const name = design.name;
  const chunk = () => {
    const end = performance.now() + 30;
    while (!runSim.done && performance.now() < end) runSim.step();
    fill.style.width = `${(100 * runSim.t) / runSim.cfg.duration}%`;
    if (!runSim.done) {
      setTimeout(chunk, 0);
      return;
    }
    runs.push({ name, seed: cfg.seed, metrics: computeMetrics(runSim.events, usableSpots(runWorld)) });
    if (runs.length > 6) runs.shift();
    store.set('parking.runs', runs);
    renderRuns();
    btn.disabled = false;
    bar.hidden = true;
  };
  chunk();
};

function fmtClock(t: number) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ drawing

function fitView() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const wM = (design.width + 2) * TILE;
  const hM = (design.height + STREET_TILES + 1) * TILE;
  const ppm = Math.max(2, Math.min(r.width / wM, r.height / hM));
  view = {
    ppm,
    ox: (r.width - design.width * TILE * ppm) / 2,
    oy: (r.height - (design.height + STREET_TILES) * TILE * ppm) / 2,
  };
}

function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  drawDesign(ctx, design, view);
  if (overlays.nav.checked) drawNav(ctx, world, view);
  if (overlays.heat.checked) drawHeat(ctx, sim, view);
  if (overlays.incidents.checked) drawIncidents(ctx, sim, view);
  drawCars(ctx, sim, view, selected, sim.standoffCars());
  drawSelected(ctx, sim.cars.get(selected), sim, view);
  drawHover();
  drawInspector();
}

function drawHover() {
  if (!hover || tool === 'inspect' || !inBounds(design, hover.x, hover.y)) return;
  const t = TILE * view.ppm;
  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  if (tool === 'spot') {
    const f = DIR_VEC[dir];
    const tx = hover.x - f.x;
    const ty = hover.y - f.y;
    ctx.strokeRect(Math.min(hover.x, tx) * t, Math.min(hover.y, ty) * t, (Math.abs(tx - hover.x) + 1) * t, (Math.abs(ty - hover.y) + 1) * t);
    drawArrow(ctx, hover.x * t + t / 2, hover.y * t + t / 2, dir, t * 0.3, 'rgba(255,255,255,0.9)');
  } else {
    ctx.strokeRect(hover.x * t, hover.y * t, t, t);
    if (tool === 'oneway') drawArrow(ctx, hover.x * t + t / 2, hover.y * t + t / 2, dir, t * 0.3, 'rgba(255,255,255,0.9)');
  }
  ctx.restore();
}

function drawInspector() {
  const car = sim.cars.get(selected);
  if (!car) {
    inspector.hidden = true;
    return;
  }
  inspector.hidden = false;
  const label: Record<string, string> = {
    searching: 'Searching for a spot',
    toSpot: 'Heading to spot',
    parked: 'Parked',
    backingOut: 'Backing out',
    toExit: 'Leaving',
    resolving: 'Backing up to clear a standoff',
  };
  const lines = [
    `<strong>Car #${car.id}</strong> · ${car.vc.name}`,
    label[car.mode] ?? car.mode,
    `Speed ${(Math.abs(car.speed) * 3.6).toFixed(0)} km/h${car.speed < -0.05 ? ' (reverse)' : ''}`,
    car.mode === 'parked' ? `Leaves in ${fmtClock(Math.max(0, car.dwellUntil - sim.t))}` : `In lot ${fmtClock(sim.t - car.enterT)}`,
    car.blockedBy >= 0 ? `${car.blockKind === 'yield' ? 'Yielding to' : 'Blocked by'} #${car.blockedBy}` : '',
    car.compliance < 1 ? 'Ignores one-way arrows' : '',
  ].filter(Boolean);
  inspector.innerHTML = lines.join('<br>');
}

// ------------------------------------------------------------------ loop

let lastUi = 0;
function frame(now: number) {
  if (playing && !sim.done) {
    const steps = Math.max(1, Math.round((speed * (1 / 60)) / sim.dt));
    for (let i = 0; i < steps && !sim.done; i++) sim.step();
    if (sim.done) togglePlayOff();
  }
  draw();
  if (now - lastUi > 250) {
    lastUi = now;
    renderMetrics();
  }
  requestAnimationFrame(frame);
}

function togglePlayOff() {
  playing = false;
  playBtn.textContent = '▶ Play';
}

window.addEventListener('resize', () => {
  fitView();
  draw();
});

buildToolButtons();
updateDirLabel();
bindConfig();
designChanged();
renderRuns();
fitView();

// Debug helpers: ?t=<seconds> fast-forwards, ?select=<id> selects a car, ?play=1 autoplays.
const ff = Number(params.get('t') ?? 0);
while (sim.t < ff && !sim.done) sim.step();
if (params.get('select')) selected = Number(params.get('select'));
if (params.get('play') === '1') togglePlay();
(window as unknown as { debug: unknown }).debug = {
  sim: () => sim,
  select: (id: number) => (selected = id),
  view: () => view,
};
requestAnimationFrame(frame);
