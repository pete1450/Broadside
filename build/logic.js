/* BROADSIDE — pure game simulation (no DOM, no three.js).
 * Runs under node for headless tests and in the browser via concatenation.
 * Everything is inside the BS IIFE; the only top-level name is `BS`. */
const BS = (() => {
"use strict";

/* ---------------- math ---------------- */
const TAU = Math.PI * 2;
function angNorm(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
function angDiff(a, b) { return Math.abs(angNorm(a - b)); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist(ax, az, bx, bz) { return Math.hypot(bx - ax, bz - az); }
// heading convention: direction = (sin h, cos h). h=0 faces +z.
function bearing(ax, az, bx, bz) { return Math.atan2(bx - ax, bz - az); }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- tuning (all tunable) ---------------- */
const TUNE = {
  gunDmg: 11,          // damage per gun at point blank
  baseHit: 0.9,        // point-blank hit chance
  // 2026-10-08: baseHit 0.62 -> 0.9 and gunDmg 14 -> 11, together (faster, more
  // decisive gunnery is part of the strategy-over-dice goal); both tunable.
  broadsideArc: Math.PI / 30, // ±6° of the beam (2026-10-09 user verdict: guns fire
  // only directly perpendicular to the centerline; tighter arc + perpendicularity
  // damage bonus make broadside-to-broadside the max-damage geometry)
  noGo: Math.PI * 5 / 6,      // ±30° dead zone upwind (150° from wind dir)
  closeHaulEff: 0.4,
  weighTime: 5,        // seconds to weigh anchor
  captureTime: 60,     // seconds of anchored presence to capture
  batteryRange: 98,
  batteryDmg: 30,
  batteryReload: 12,
  batteryHp: 220,       // shore battery hp (tunable)
  repairGrace: 5,      // seconds anchored + unseen before repairs start (tunable; 2026-10-09: 10 -> 5)
  repairRate: 2.25,    // %/s restored to hull/rigging/crew while repairing (tunable; 2026-10-09: 1.5 -> 2.25, +50%)
  boundsHalf: 1500,   // playable SQUARE half-size: |x|,|z| <= 1500 (2026-10-08).
                     // Was a disc (boundsR 475): the map corners were unreachable.
                     // 2026-10-08: ocean expanded ~10x (960x960 -> 3000x3000).
};

const SHIPCLS = {
  // hp and vision raised 2026-10-08 per user verdicts (tunable)
  sloop:   { name: "Sloop",            speed: 28, hp: 80,  guns: 2,  reload: 8,  turn: 0.81, range: 58, len: 11, beam: 4.2, masts: 1, radius: 4.5, vision: 100 },
  frigate: { name: "Frigate",          speed: 11, hp: 180, guns: 6,  reload: 10, turn: 0.56, range: 70, len: 15, beam: 5.2, masts: 2, radius: 6,   vision: 80 },
  sol:     { name: "Ship of the line", speed: 8,  hp: 350, guns: 10, reload: 12, turn: 0.39, range: 82, len: 19, beam: 6.4, masts: 3, radius: 7.5, vision: 65 },
};

/* ---------------- map (hand-authored harbor) ---------------- */
// 10x the playable area (2026-10-08 user verdict): linear scale S = sqrt(10)
// applied to every geographic constant below.
const MAP_S = Math.sqrt(10);
// Mainland polygon (x,z), north side with a rectangular harbor bay.
const LAND_POLY = [
  [-130, -130], [130, -130], [130, -20], [25, -20],
  [25, -55], [-25, -55], [-25, -20], [-130, -20],
].map(([x, z]) => [x * MAP_S, z * MAP_S]);
const ISLANDS = [
  { x: -70, z: 45, r: 11 },
  { x: 72, z: -5, r: 9 },
].map(o => ({ x: o.x * MAP_S, z: o.z * MAP_S, r: o.r * MAP_S })).concat([
  // 2026-10-08: new islands in the expanded ocean ring (absolute world
  // coords, NOT scaled by MAP_S). All in the new water ring
  // (480 < |coord| < 1400), >=200u from every existing feature/spawn/patrol.
  { x: 950, z: 150, r: 42 },   // east
  { x: -900, z: -150, r: 36 }, // west
  { x: 150, z: -950, r: 48 },  // north, beyond the mainland
  { x: 750, z: 950, r: 32 },   // south-east
]);
const ZONE = { x: 0, z: -38 * MAP_S, r: 22 * MAP_S };
const BATTERY_SPOTS = [{ x: -28, z: -24 }, { x: 28, z: -24 }]
  .map(o => ({ x: o.x * MAP_S, z: o.z * MAP_S }));
const ENEMY_PATROL = [[-45, 25], [45, 25], [0, -2]]
  .map(([x, z]) => [x * MAP_S, z * MAP_S]);

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function inLand(x, z) {
  if (pointInPoly(x, z, LAND_POLY)) return true;
  for (const isl of ISLANDS) if (dist(x, z, isl.x, isl.z) < isl.r) return true;
  return false;
}

/* ---------------- fog of war ---------------- */
// Grid over world [-half, half]^2. exp[] = ever explored by a player ship;
// computeVisibility() returns {vis, seen}: vis is the binary gameplay grid
// (1 inside a player ship's vision radius — drives enemy-visibility rules),
// seen is a soft Float32Array (1 inside visionR-feather, smoothstep-falling
// to 0 at visionR+feather) that the renderer uses for feathered fog edges.
// Fog is a player-presentation feature; enemy AI keeps its own sight
// behavior (unchanged).
const FOW_N = 512, FOW_HALF = 1500, FOW_FEATHER = 12; // feather width in world units (tunable)
// 2026-10-08: fog grid covers the expanded ocean (cell ~5.9u; bilinear +
// 12u feather keeps edges smooth). FOW_N stays 512: redraw cost unchanged.
function fowCellIJ(f, x, z) {
  const i = Math.floor((x + f.half) / (2 * f.half) * f.n);
  const j = Math.floor((z + f.half) / (2 * f.half) * f.n);
  if (i < 0 || i >= f.n || j < 0 || j >= f.n) return -1;
  return j * f.n + i;
}
// Stamp one ship's vision into the given arrays (any may be null):
// seen = soft edge, vis = binary gameplay, exp = explored (seen > 0.02).
function stampVision(f, x, z, r, seen, vis, exp) {
  const feather = FOW_FEATHER, R = r + feather;
  const span = 2 * f.half, cell = span / f.n;
  const i0 = Math.max(0, Math.floor((x - R + f.half) / span * f.n));
  const i1 = Math.min(f.n - 1, Math.floor((x + R + f.half) / span * f.n));
  const j0 = Math.max(0, Math.floor((z - R + f.half) / span * f.n));
  const j1 = Math.min(f.n - 1, Math.floor((z + R + f.half) / span * f.n));
  const r2 = r * r, R2 = R * R;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const cx = (i + 0.5) * cell - f.half, cz = (j + 0.5) * cell - f.half;
      const dx = cx - x, dz = cz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      const idx = j * f.n + i;
      if (d2 <= r2) {
        if (seen) seen[idx] = 1;
        if (vis) vis[idx] = 1;
        if (exp) exp[idx] = 1;
      } else {
        const d = Math.sqrt(d2);
        const t = (R - d) / (2 * feather); // 1 at r-feather .. 0 at r+feather
        const sv = t * t * (3 - 2 * t);
        if (seen && sv > seen[idx]) seen[idx] = sv;
        if (exp && sv > 0.02) exp[idx] = 1;
      }
    }
  }
}
function computeVisibility(st) {
  const f = st.fow;
  // reuse scratch buffers: 512x512 Float32 is 1MB, don't allocate per call
  if (!f._vis || f._vis.length !== f.n * f.n) {
    f._vis = new Uint8Array(f.n * f.n);
    f._seen = new Float32Array(f.n * f.n);
  }
  const vis = f._vis, seen = f._seen;
  vis.fill(0); seen.fill(0);
  for (const s of st.ships) {
    if (!s.alive || s.side !== "P") continue;
    stampVision(f, s.x, s.z, SHIPCLS[s.cls].vision, seen, vis, null);
  }
  return { vis, seen };
}

/* ---------------- wind ---------------- */
// wind = direction the wind blows TOWARD, radians, same heading convention.
// d = 0 → running dead downwind; d = π → dead upwind (no-go).
function sailEff(heading, wind) {
  const d = angDiff(heading, wind);
  const q = Math.PI / 4;
  if (d <= q) return 0.85 + 0.15 * (d / q);
  if (d <= Math.PI / 2) return 1.0;
  if (d <= 3 * q) return 1.0 - 0.6 * ((d - Math.PI / 2) / q);
  if (d <= TUNE.noGo) return TUNE.closeHaulEff;
  return 0.0;
}
const TACK_MARGIN = 6 * Math.PI / 180; // never plan/steer closer than this to the no-go edge

/* ---------------- local wind field (2026-10-08) ---------------- */
// Per-match local wind modifiers on a coarse grid: open water gets smooth
// noise; near land the wind bends coast-parallel, drops in the lee of
// headlands, and funnels faster through channels (land on both flanks).
// Built once in newMatch from a dedicated seeded stream (reproducible per
// seed); queries are pure bilinear interpolation — no inLand at query time.
// Symmetric: both sides sample the same field through steerToward/buildPath;
// the HUD compass keeps showing the global direction.
const WIND_N = 120, WIND_HALF = 1500; // 25u cells over the expanded ocean (tunable)
// 2026-10-08: was 40x40 over +-500. The 2-pass chamfer distance transform
// below is O(cells), so 120x120 (14.4k cells) builds fast.
const WIND_CELL = (2 * WIND_HALF) / WIND_N;
const WIND_NOISE_AMP = 0.15;    // open-water direction noise, radians (tunable)
const WIND_MAG_NOISE = 0.08;    // open-water magnitude noise (tunable)
const WIND_COAST_R = 100;       // coast influence radius for bending (tunable)
const WIND_LEE_R = 75;          // lee ray-search radius (tunable)
const WIND_CHAN_R = 105;        // channel flank search radius (tunable)
const WIND_LEE_MUL = 0.68;      // wind-shadow magnitude multiplier (tunable)
const WIND_ONEFLANK_MUL = 1.25; // single-flank compression (tunable)
const WIND_CHAN_MAX = 1.7;      // venturi cap (tunable)
const WIND_MAG_MIN = 0.60, WIND_MAG_MAX = 1.70; // final magnitude clamp (tunable)
function hash2i(i, j) {
  const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function buildWindField(st) {
  const n = WIND_N, cell = WIND_CELL;
  const wrng = mulberry32((st.seed ^ 0x9e3779b9) >>> 0);
  // Smooth open-water noise: a seeded random grid, bilinearly interpolated —
  // varies gradually, never per-cell white noise. NG=31 keeps the ~100u
  // noise wavelength of the old 11x11-over-+-500 grid on the expanded map.
  const NG = 31, NG1 = NG - 1, nOff = new Float32Array(NG * NG), nMag = new Float32Array(NG * NG);
  for (let k = 0; k < NG * NG; k++) {
    nOff[k] = (wrng() * 2 - 1) * WIND_NOISE_AMP;
    nMag[k] = (wrng() * 2 - 1) * WIND_MAG_NOISE;
  }
  const noiseAt = (grid, x, z) => {
    const u = clamp((x + WIND_HALF) / (2 * WIND_HALF) * NG1, 0, NG1 - 0.001);
    const v = clamp((z + WIND_HALF) / (2 * WIND_HALF) * NG1, 0, NG1 - 0.001);
    const i0 = u | 0, j0 = v | 0, i1 = Math.min(NG1, i0 + 1), j1 = Math.min(NG1, j0 + 1);
    const fu = u - i0, fv = v - j0;
    return grid[j0 * NG + i0] * (1 - fu) * (1 - fv) + grid[j0 * NG + i1] * fu * (1 - fv) +
           grid[j1 * NG + i0] * (1 - fu) * fv + grid[j1 * NG + i1] * fu * fv;
  };
  // Land mask at cell centers.
  const land = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const cx = (i + 0.5) * cell - WIND_HALF, cz = (j + 0.5) * cell - WIND_HALF;
    land[j * n + i] = inLand(cx, cz) ? 1 : 0;
  }
  // Chamfer distance-to-land (in cells) with nearest-source tracking: gives
  // both the distance AND the land-gradient direction per cell in O(n^2).
  // (Equivalent to the expanding-ring nearest-land search at grid resolution,
  // much cheaper, and the source direction comes for free.)
  const INF = 1e9, SQ2 = Math.SQRT2;
  const cd = new Float32Array(n * n).fill(INF);
  const sI = new Int16Array(n * n), sJ = new Int16Array(n * n);
  for (let k = 0; k < n * n; k++) if (land[k]) { cd[k] = 0; sI[k] = k % n; sJ[k] = (k / n) | 0; }
  const relax = (idx, nidx, cost) => {
    const nd = cd[nidx] + cost;
    if (nd < cd[idx]) { cd[idx] = nd; sI[idx] = sI[nidx]; sJ[idx] = sJ[nidx]; }
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const idx = j * n + i;
    if (i > 0) relax(idx, idx - 1, 1);
    if (j > 0) relax(idx, idx - n, 1);
    if (i > 0 && j > 0) relax(idx, idx - n - 1, SQ2);
    if (i < n - 1 && j > 0) relax(idx, idx - n + 1, SQ2);
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    const idx = j * n + i;
    if (i < n - 1) relax(idx, idx + 1, 1);
    if (j < n - 1) relax(idx, idx + n, 1);
    if (i < n - 1 && j < n - 1) relax(idx, idx + n + 1, SQ2);
    if (i > 0 && j < n - 1) relax(idx, idx + n - 1, SQ2);
  }
  const off = new Float32Array(n * n), mag = new Float32Array(n * n);
  const upAng = angNorm(st.wind + Math.PI); // upwind direction
  const ux = Math.sin(upAng), uz = Math.cos(upAng);
  const f1a = st.wind + Math.PI / 2, f2a = st.wind - Math.PI / 2; // flanks
  const f1x = Math.sin(f1a), f1z = Math.cos(f1a), f2x = Math.sin(f2a), f2z = Math.cos(f2a);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const idx = j * n + i;
    const cx = (i + 0.5) * cell - WIND_HALF, cz = (j + 0.5) * cell - WIND_HALF;
    if (land[idx]) { off[idx] = 0; mag[idx] = 1; continue; } // ships never sail here anyway
    const dL = cd[idx] * cell;
    const nO = noiseAt(nOff, cx, cz), nM = noiseAt(nMag, cx, cz);
    if (dL > WIND_COAST_R) { off[idx] = nO; mag[idx] = 1 + nM; continue; } // open water
    // Bend coast-parallel: perpendicular to the land gradient, whichever way
    // is closer to the global direction; fades out by WIND_COAST_R.
    const gAng = Math.atan2((i - sI[idx]) * cell, (j - sJ[idx]) * cell);
    const p1 = gAng + Math.PI / 2, p2 = gAng - Math.PI / 2;
    const chosen = angDiff(p1, st.wind) < angDiff(p2, st.wind) ? p1 : p2;
    const blend = clamp(1 - dL / WIND_COAST_R, 0, 1);
    let o = blend * angNorm(chosen - st.wind) + (1 - blend) * nO;
    let m = 1 + nM;
    // Lee: land inside WIND_LEE_R directly upwind -> wind shadow.
    let lee = false;
    for (let k = 25; k <= WIND_LEE_R; k += 25) {
      if (inLand(cx + ux * k, cz + uz * k)) { lee = true; break; }
    }
    // Channel / venturi: land on BOTH flanks (perpendicular to the global
    // wind) -> the biggest boost, scaled by closeness. The harbor bay is
    // ~158u wide, so the flank search reaches past the 75u lee radius.
    let d1 = Infinity, d2 = Infinity;
    for (let k = 15; k <= WIND_CHAN_R; k += 15) {
      if (d1 === Infinity && inLand(cx + f1x * k, cz + f1z * k)) d1 = k;
      if (d2 === Infinity && inLand(cx + f2x * k, cz + f2z * k)) d2 = k;
    }
    if (d1 < Infinity && d2 < Infinity) {
      const avg = (d1 + d2) / 2;
      m *= 1 + (WIND_CHAN_MAX - 1) * clamp((130 - avg) / 50, 0, 1);
    } else if (lee) {
      m *= WIND_LEE_MUL;
      o += (hash2i(i, j) - 0.5) * 0.15; // extra swirl in the wind shadow
    } else if (d1 < Infinity || d2 < Infinity) {
      m *= WIND_ONEFLANK_MUL; // mild compression along a single shore
    }
    off[idx] = angNorm(o);
    mag[idx] = clamp(m, WIND_MAG_MIN, WIND_MAG_MAX);
  }
  return { n, half: WIND_HALF, cell, off, mag };
}
// Bilinear sample of the local wind field. Returns {ang, mag}: ang is the
// global wind plus the local offset; mag multiplies ship speed. Smooth by
// construction (no discontinuities between cells), never NaN, safe at the
// edges and corners. Pure arithmetic — no inLand at query time.
function windAt(st, x, z) {
  const f = st.windF;
  if (!f) return { ang: st.wind, mag: 1 };
  const n = f.n, cell = f.cell;
  const gx = clamp((x + f.half) / cell, 0, n - 1.001);
  const gz = clamp((z + f.half) / cell, 0, n - 1.001);
  const i0 = gx | 0, j0 = gz | 0;
  const i1 = Math.min(n - 1, i0 + 1), j1 = Math.min(n - 1, j0 + 1);
  const fu = gx - i0, fv = gz - j0;
  const a00 = j0 * n + i0, a10 = j0 * n + i1, a01 = j1 * n + i0, a11 = j1 * n + i1;
  const o = f.off[a00] * (1 - fu) * (1 - fv) + f.off[a10] * fu * (1 - fv) +
            f.off[a01] * (1 - fu) * fv + f.off[a11] * fu * fv;
  const m = f.mag[a00] * (1 - fu) * (1 - fv) + f.mag[a10] * fu * (1 - fv) +
            f.mag[a01] * (1 - fu) * fv + f.mag[a11] * fu * fv;
  return { ang: angNorm(st.wind + o), mag: m };
}
/* ---------------- pathfinding around land (2026-10-08) ---------------- */
// buildPath is the single choke point: player orderMove/patrol AND enemy AI
// (attackStep, patrol) all route through it, so making it obstacle-aware
// fixes beaching everywhere at once. Pipeline:
//   1. clamp the destination off land / into the playable square
//   2. coarse A* around land (100x100, 10u cells)
//   3. greedy line-of-sight smoothing of the cell path
//   4. the existing tacking zigzag per smoothed leg (wind rules unchanged)
// moveShip's slide collision stays as the hard backstop: nothing physical is
// traversable.
const PF_N = 150, PF_HALF = 1500, PF_CELL = 20; // coarse grid over the expanded ocean (tunable)
const PF_EDGE = 1475; // treat cells past this as blocked: with 20u cells the farthest
// waypoint center is 1475, so A* never emits a point outside the ±1500 square
// 2026-10-08: was 100x100/10u over +-500. Coarse routing only — the exact 6u
// waterClear checks in routeLeg/tackWater still handle fine detail.
let pfBlocked = null; // cached Uint8Array: land padded by ~1 cell (~20u)
function pfBuildBlocked() {
  const base = new Uint8Array(PF_N * PF_N);
  for (let j = 0; j < PF_N; j++) {
    for (let i = 0; i < PF_N; i++) {
      const x = (i + 0.5) * PF_CELL - PF_HALF, z = (j + 0.5) * PF_CELL - PF_HALF;
      if (Math.abs(x) > PF_EDGE || Math.abs(z) > PF_EDGE || inLand(x, z)) base[j * PF_N + i] = 1;
    }
  }
  pfBlocked = new Uint8Array(PF_N * PF_N);
  for (let j = 0; j < PF_N; j++) {
    for (let i = 0; i < PF_N; i++) {
      if (!base[j * PF_N + i]) continue;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && ii < PF_N && jj >= 0 && jj < PF_N) pfBlocked[jj * PF_N + ii] = 1;
      }
    }
  }
}
function pfCellOf(x, z) {
  return [
    clamp(Math.floor((x + PF_HALF) / PF_CELL), 0, PF_N - 1),
    clamp(Math.floor((z + PF_HALF) / PF_CELL), 0, PF_N - 1),
  ];
}
function pfNearestOpen(i, j) { // spiral out to 6 cells for an unblocked cell
  if (!pfBlocked[j * PF_N + i]) return [i, j];
  for (let r = 1; r <= 6; r++) {
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || ii >= PF_N || jj < 0 || jj >= PF_N) continue;
      if (!pfBlocked[jj * PF_N + ii]) return [ii, jj];
    }
  }
  return null;
}
// A* from (sx,sz) to (tx,tz). Returns world waypoints [start..end].
// Falls back to a straight line if no route exists.
function astarRoute(sx, sz, tx, tz) {
  if (!pfBlocked) pfBuildBlocked();
  let si, sj, ti, tj;
  {
    const a = pfNearestOpen(...pfCellOf(sx, sz)), b = pfNearestOpen(...pfCellOf(tx, tz));
    if (!a || !b) return [[sx, sz], [tx, tz]];
    [si, sj] = a; [ti, tj] = b;
  }
  const sIdx = sj * PF_N + si, tIdx = tj * PF_N + ti;
  if (sIdx === tIdx) return [[sx, sz], [tx, tz]];
  const g = new Float64Array(PF_N * PF_N).fill(Infinity);
  const came = new Int32Array(PF_N * PF_N).fill(-1);
  const closed = new Uint8Array(PF_N * PF_N);
  const hf = [], hi = []; // binary heap of [f, idx]
  const hpush = (f, idx) => {
    hf.push(f); hi.push(idx);
    let c = hf.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (hf[p] <= hf[c]) break;
      const tf = hf[p]; hf[p] = hf[c]; hf[c] = tf;
      const ti2 = hi[p]; hi[p] = hi[c]; hi[c] = ti2;
      c = p;
    }
  };
  const hpop = () => {
    const top = hi[0], lf = hf.pop(), li = hi.pop();
    if (hf.length) {
      hf[0] = lf; hi[0] = li;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < hf.length && hf[l] < hf[m]) m = l;
        if (r < hf.length && hf[r] < hf[m]) m = r;
        if (m === p) break;
        const tf = hf[p]; hf[p] = hf[m]; hf[m] = tf;
        const ti2 = hi[p]; hi[p] = hi[m]; hi[m] = ti2;
        p = m;
      }
    }
    return top;
  };
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
                [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  const heur = (i, j) => {
    const di = Math.abs(i - ti), dj = Math.abs(j - tj);
    return (Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj)) * PF_CELL;
  };
  g[sIdx] = 0;
  hpush(heur(si, sj), sIdx);
  let found = false, guard = 0;
  while (hf.length && guard++ < 40000) {
    const cur = hpop();
    if (closed[cur]) continue;
    if (cur === tIdx) { found = true; break; }
    closed[cur] = 1;
    const ci = cur % PF_N, cj = (cur / PF_N) | 0;
    for (const [di, dj, cost] of DIRS) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= PF_N || nj < 0 || nj >= PF_N) continue;
      const nIdx = nj * PF_N + ni;
      if (pfBlocked[nIdx] || closed[nIdx]) continue;
      if (di && dj && (pfBlocked[cj * PF_N + ni] || pfBlocked[nj * PF_N + ci])) continue; // no corner-cutting
      const ng = g[cur] + cost * PF_CELL;
      if (ng < g[nIdx]) { g[nIdx] = ng; came[nIdx] = cur; hpush(ng + heur(ni, nj), nIdx); }
    }
  }
  if (!found) return [[sx, sz], [tx, tz]];
  const cells = [];
  let cur = tIdx;
  while (cur !== -1) { cells.push(cur); cur = came[cur]; }
  cells.reverse();
  const pts = [[sx, sz]];
  for (let k = 1; k < cells.length - 1; k++) {
    const ci = cells[k] % PF_N, cj = (cells[k] / PF_N) | 0;
    pts.push([(ci + 0.5) * PF_CELL - PF_HALF, (cj + 0.5) * PF_CELL - PF_HALF]);
  }
  pts.push([tx, tz]);
  return pts;
}
// Is the straight segment water all the way? Samples every ~5u.
function segWalkable(x0, z0, x1, z1) {
  const d = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.ceil(d / 5));
  for (let k = 0; k <= n; k++) {
    if (inLand(x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n)) return false;
  }
  return true;
}
// Greedy shortcutting: from each waypoint, jump to the farthest waypoint
// with a walkable straight segment.
function smoothLos(route) {
  const out = [route[0]];
  let a = 0;
  while (a < route.length - 1) {
    let b = route.length - 1;
    while (b > a + 1 && !segWalkable(route[a][0], route[a][1], route[b][0], route[b][1])) b--;
    out.push(route[b]);
    a = b;
  }
  return out;
}
// Nearest water to a target point: hard-clamp into the playable square, then
// spiral-search outward (5u rings to maxR). Returns [x,z] or null.
function clampToWater(tx, tz, maxR) {
  const B = TUNE.boundsHalf;
  tx = clamp(tx, -B, B); tz = clamp(tz, -B, B);
  if (!inLand(tx, tz)) return [tx, tz];
  maxR = maxR || 120;
  for (let r = 5; r <= maxR; r += 5) {
    const n = 16;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + r * 0.7; // rotate rings so samples don't line up
      const x = tx + Math.sin(a) * r, z = tz + Math.cos(a) * r;
      if (Math.abs(x) > B || Math.abs(z) > B) continue;
      if (!inLand(x, z)) return [x, z];
    }
  }
  return null;
}
/* ---------------- land-aware leg router (2026-10-08) ---------------- */
// The old tackLegs dead-reckoned zigzag waypoints without checking land, so
// tack points/legs could land on the mainland or an island and the ship
// ground along the coast on the slide collision. The router below never
// places a point on land: every generated waypoint keeps a clearance margin
// and every leg segment is checked.
const TACK_CLEAR_R = 6;      // waypoint/segment clearance from land, world units (tunable)
const TACK_DEPTH_MAX = 6;    // recursion cap for the router (tunable)
const TACK_MIN_LEG_FRAC = 0.4; // short-tack keeps at least 40% of the leg (tunable)
// ONE predicate for "can a ship plan to be here": water AND inside the
// playable square (with a margin). The map edge is treated exactly like a
// coastline everywhere in pathfinding — tack points, tack segments, and the
// steering probes all respect it, so no waypoint or leg ever aims outside
// the bounds (ships used to stall grinding against the invisible edge).
function playable(x, z, margin) {
  const B = TUNE.boundsHalf - margin;
  if (Math.abs(x) > B || Math.abs(z) > B) return false;
  return !inLand(x, z);
}
// True if (x,z) is water with clearance from any land (ship radius + margin,
// so a waypoint here never visually beaches the ship) and inside the bounds.
function waterClear(x, z) {
  if (!playable(x, z, TACK_CLEAR_R)) return false;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    if (inLand(x + Math.sin(a) * TACK_CLEAR_R, z + Math.cos(a) * TACK_CLEAR_R)) return false;
  }
  return true;
}
// True if every 5u sample along the segment keeps clearance (tack legs must
// not cut across headlands or clip island shores).
function segClear(x0, z0, x1, z1) {
  const d = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.ceil(d / 5));
  for (let k = 0; k <= n; k++) {
    if (!waterClear(x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n)) return false;
  }
  return true;
}
// Returns water-only waypoints from S to T (excludes S; always ends at T).
// budget = {n} shared tack-leg budget (200 total, see buildPath).
function routeLeg(st, sx, sz, tx, tz, windAng, depth, budget) {
  const dx = tx - sx, dz = tz - sz;
  if (Math.hypot(dx, dz) < 8) return [[tx, tz]];
  const sailable = angDiff(Math.atan2(dx, dz), windAng) <= TUNE.noGo - TACK_MARGIN;
  if (sailable) {
    if (segClear(sx, sz, tx, tz)) return [[tx, tz]];
    if (segWalkable(sx, sz, tx, tz)) return [[tx, tz]]; // near shore but no crossing: sail it
    // else: crosses land -> A* around it (below)
  } else if (segWalkable(sx, sz, tx, tz)) {
    // Water all the way but upwind: land-aware tacking zigzag.
    return tackWater(st, sx, sz, tx, tz, depth, budget);
  }
  // Segment crosses land: A* around it, then recursively route each sub-leg.
  // (Depth cap + slide collision are the hard backstops; A* failure also
  // falls through to a direct push.)
  if (depth >= TACK_DEPTH_MAX || budget.n <= 0) return [[tx, tz]];
  let sub = astarRoute(sx, sz, tx, tz);
  if (sub.length <= 2) return [[tx, tz]];
  sub = smoothLos(sub);
  const pts = [];
  let px = sx, pz = sz;
  for (let k = 1; k < sub.length; k++) {
    const segs = routeLeg(st, px, pz, sub[k][0], sub[k][1], windAng, depth + 1, budget);
    for (const p of segs) pts.push(p);
    px = sub[k][0]; pz = sub[k][1];
  }
  return pts;
}
// Land-aware tacking zigzag: same leg geometry as the old tackLegs (45° off
// dead upwind, L = clamp(remaining*0.5, 14, 38), TACK_MARGIN), but every
// candidate tack point must be water-clear and every leg segment too.
// The LOCAL wind is re-sampled every iteration (windAt is ~free): it can
// bend dramatically along a tack chain near land, and planning against a
// stale sample steers tacks into the shore that caused the bend.
// When boxed in by land it pinches at the target if the remaining leg is
// water, else A*s around the new obstruction.
function tackWater(st, sx, sz, tx, tz, depth, budget) {
  const pts = [];
  let px = sx, pz = sz;
  for (;;) {
    if (budget.n <= 0) { pts.push([tx, tz]); break; } // rare: budget spent, sail direct
    const windAng = windAt(st, px, pz).ang; // fresh local wind (see above)
    const dx = tx - px, dz = tz - pz;
    const remaining = Math.hypot(dx, dz);
    if (remaining < 8) { pts.push([tx, tz]); break; }
    if (angDiff(Math.atan2(dx, dz), windAng) <= TUNE.noGo - TACK_MARGIN) {
      // Course is sailable in the current local wind: hand back. The fresh
      // windAng is passed on so routeLeg's sailable check agrees (no ping-pong).
      const rest = routeLeg(st, px, pz, tx, tz, windAng, depth, budget);
      for (const p of rest) pts.push(p);
      break;
    }
    const up = windAng + Math.PI; // dead-upwind direction
    const L = clamp(remaining * 0.5, 14, 38);
    const l1 = up + Math.PI / 4, l2 = up - Math.PI / 4;
    const ax = px + Math.sin(l1) * L, az = pz + Math.cos(l1) * L;
    const bx = px + Math.sin(l2) * L, bz = pz + Math.cos(l2) * L;
    const prefFirst = Math.hypot(tx - ax, tz - az) < Math.hypot(tx - bx, tz - bz);
    const cands = prefFirst ? [[ax, az], [bx, bz]] : [[bx, bz], [ax, az]];
    let placed = null;
    for (const c of cands) {
      if (waterClear(c[0], c[1]) && segClear(px, pz, c[0], c[1])) { placed = c; break; }
    }
    if (!placed) {
      // Short-tack: walk back from the preferred tack point toward S and keep
      // the first water-clear point that still makes real progress.
      const qx = cands[0][0], qz = cands[0][1];
      const qd = Math.hypot(qx - px, qz - pz);
      for (let back = qd - 5; back > TACK_MIN_LEG_FRAC * L; back -= 5) {
        const wx = px + (qx - px) * back / qd, wz = pz + (qz - pz) * back / qd;
        if (waterClear(wx, wz) && segClear(px, pz, wx, wz)) { placed = [wx, wz]; break; }
      }
    }
    if (!placed) {
      // Boxed in: no tack fits. px advanced since entry, so px->T was never
      // checked — validate it before pushing (a blind push is what used to
      // sail ships into islands). Water leg: pinch at the target
      // (close-hauled progress). Land crossing: A* around it (depth+1; the
      // cap + slide collision stay as backstops).
      if (segWalkable(px, pz, tx, tz)) { pts.push([tx, tz]); break; }
      const rest = routeLeg(st, px, pz, tx, tz, windAng, depth + 1, budget);
      for (const p of rest) pts.push(p);
      break;
    }
    pts.push(placed);
    budget.n--;
    px = placed[0]; pz = placed[1];
  }
  if (!pts.length) pts.push([tx, tz]);
  return pts;
}
// Build a waypoint path from (sx,sz) to (tx,tz). Used identically by player
// orders and enemy AI. Each smoothed A* leg goes through the land-aware
// routeLeg (tacking legs sample the LOCAL wind at each smoothed leg's start;
// legs are 14-38u, the field is smooth at that scale).
function buildPath(sx, sz, tx, tz, st) {
  const dst = clampToWater(tx, tz);
  if (!dst) return [[sx, sz]]; // no water anywhere near: stay put
  const start = inLand(sx, sz) ? (clampToWater(sx, sz, 40) || [sx, sz]) : [sx, sz];
  let route = astarRoute(start[0], start[1], dst[0], dst[1]);
  if (route.length > 2) route = smoothLos(route);
  const pts = [];
  const budget = { n: 200 }; // 200 tack legs total: a dead-upwind trek across
  // the expanded ocean needs ~110 legs at 38u; 64 would strand ships mid-ocean
  let px = sx, pz = sz;
  for (let w = 1; w < route.length; w++) {
    const wx = route[w][0], wz = route[w][1];
    if (dist(px, pz, wx, wz) < 8) continue;
    const segs = routeLeg(st, px, pz, wx, wz, windAt(st, px, pz).ang, 0, budget);
    for (const p of segs) pts.push(p);
    px = wx; pz = wz;
  }
  if (!pts.length) pts.push([dst[0], dst[1]]);
  return pts;
}

/* ---------------- state ---------------- */
let nextId = 1;
function mkShip(side, cls, x, z, heading) {
  const c = SHIPCLS[cls];
  return {
    id: nextId++, kind: "ship", side, cls,
    x, z, heading, speed: 0,
    hp: c.hp, maxHp: c.hp, alive: true,
    order: { type: "hold" }, path: [],
    reloadL: 0, reloadR: 0, gunsFree: true,
    // gunnery doctrine: shot type + patience dial. Both are per-ship, set from
    // the bottom bar, and apply to whole groups. The enemy AI sets these too
    // (symmetric rules).
    shot: "round",   // "round" | "chain" | "grape"
    patience: 0.6,   // 0..1: fire cycle = reload*(0.5+p), damage x(0.5+p).
                     // 0 = double rate, half damage; 1 = 1.5x cycle, x1.5 damage.
    cycL: c.reload * 1.1, cycR: c.reload * 1.1, // last cycle duration per broadside
                                               // (denominator for the readiness bar)
    // damage pools (2026-10-08): hull sinks at 0; rigging/crew degrade capability.
    rigging: 100, crew: 100,
    // repair at anchor (2026-10-08): repairT accumulates while anchored with no
    // enemy in any friendly ship's vision; repairs start after TUNE.repairGrace.
    repairT: 0, repairing: false,
    weighT: 0, pendingMove: null,
    group: 0, // control group 0..5 (0 = none); selection sets only, no formation logic
    repathT: 0,
    targetId: 0, bside: 0, bsideTgt: 0,
    engage: false, engageTgt: 0,
    // enemy doctrine AI (2026-10-08): per-ship goal + bloodlust + stance.
    // goal: defend the harbor; bloodlust: 0.25..0.75 seeded per ship.
    ai: { stance: "GUARD", thinkT: 0, targetId: 0, bloodlust: 0.5, goal: null },
    hitFlash: 0,
  };
}
function mkBattery(x, z, side) {
  return {
    id: nextId++, kind: "battery", side, x, z, heading: 0,
    hp: TUNE.batteryHp, maxHp: TUNE.batteryHp, alive: true,
    reload: 4, range: TUNE.batteryRange, hitFlash: 0,
  };
}
function newMatch(seed, windOverride, opts) {
  nextId = 1;
  opts = opts || {};
  const noEnemy = !!opts.noEnemy; // debug: no enemy ships, batteries inert
  const rng = mulberry32(seed >>> 0 || 1);
  const wind = (windOverride === undefined) ? rng() * TAU : windOverride;
  const st = {
    seed, rng, wind, time: 0, result: null,
    ships: [], batteries: [], events: [],
    zone: { x: ZONE.x, z: ZONE.z, r: ZONE.r, progress: 0, owner: "E" },
    fow: { n: FOW_N, half: FOW_HALF, exp: new Uint8Array(FOW_N * FOW_N) },
  };
  st.windF = buildWindField(st); // local wind modifiers (seeded, per match)
  // Player fleet (green) — far south, inside the bounds disc.
  st.ships.push(mkShip("P", "sol", 0, 420, Math.PI));
  st.ships.push(mkShip("P", "frigate", -80, 440, Math.PI));
  st.ships.push(mkShip("P", "frigate", 80, 440, Math.PI));
  st.ships.push(mkShip("P", "sloop", -150, 415, Math.PI));
  st.ships.push(mkShip("P", "sloop", 150, 415, Math.PI));
  // Enemy fleet (red) — defending the harbor.
  if (!noEnemy) {
    st.ships.push(mkShip("E", "sol", 0, 12 * MAP_S, 0));
    st.ships.push(mkShip("E", "frigate", -22 * MAP_S, 18 * MAP_S, 0));
    st.ships.push(mkShip("E", "frigate", 22 * MAP_S, 18 * MAP_S, 0));
    st.ships.push(mkShip("E", "sloop", 42 * MAP_S, 30 * MAP_S, 0));
    // doctrine AI state (2026-10-08): this level every enemy ship defends the
    // harbor zone; bloodlust is seeded per ship so the fleet has mixed temperaments.
    for (const s of st.ships) {
      if (s.side !== "E") continue;
      s.ai.goal = { x: ZONE.x, z: ZONE.z };
      s.ai.bloodlust = 0.25 + 0.5 * rng();
      s.ai.thinkT = rng() * 2; // stagger the 2s strategic ticks
    }
  }
  for (const b of BATTERY_SPOTS) {
    const bat = mkBattery(b.x, b.z, "E");
    bat.inert = noEnemy; // debug: present but never fires
    st.batteries.push(bat);
  }
  return st;
}
function unitById(st, id) {
  for (const s of st.ships) if (s.id === id) return s;
  for (const b of st.batteries) if (b.id === id) return b;
  return null;
}
function enemiesOf(st, side) {
  const out = [];
  for (const s of st.ships) if (s.alive && s.side !== side) out.push(s);
  for (const b of st.batteries) if (b.alive && b.side !== side) out.push(b);
  return out;
}

/* ---------------- orders ---------------- */
function orderMove(st, ids, x, z, attackMove) {
  for (const id of ids) {
    const s = unitById(st, id);
    if (!s || s.kind !== "ship" || !s.alive) continue;
    if (s.order.type === "anchored") {
      // must weigh anchor first; queue the move behind the delay
      s.order = { type: "weighing" };
      s.weighT = TUNE.weighTime;
      s.pendingMove = { x, z, attackMove };
      st.events.push({ k: "weigh", id: s.id });
    } else {
      s.order = { type: attackMove ? "attackmove" : "move" };
      s.path = buildPath(s.x, s.z, x, z, st);
      s.targetId = 0;
    }
  }
}
function orderHold(st, ids) {
  for (const id of ids) {
    const s = unitById(st, id);
    if (!s || s.kind !== "ship" || !s.alive) continue;
    if (s.order.type === "anchored") { // hold while anchored = stay anchored
      continue;
    }
    s.order = { type: "hold" }; s.path = []; s.targetId = 0;
  }
}
function orderAnchor(st, ids) {
  for (const id of ids) {
    const s = unitById(st, id);
    if (!s || s.kind !== "ship" || !s.alive) continue;
    s.order = { type: "anchored" }; s.path = []; s.speed = 0; s.targetId = 0;
    st.events.push({ k: "anchor", id: s.id });
  }
}
function orderWeighAnchor(st, ids) {
  for (const id of ids) {
    const s = unitById(st, id);
    if (!s || s.kind !== "ship" || !s.alive || s.order.type !== "anchored") continue;
    s.order = { type: "weighing" };
    s.weighT = TUNE.weighTime;
    s.pendingMove = null;
    st.events.push({ k: "weigh", id: s.id });
  }
}
function orderAttack(st, ids, targetId) {
  const t = unitById(st, targetId);
  if (!t || !t.alive) return;
  for (const id of ids) {
    const s = unitById(st, id);
    if (!s || s.kind !== "ship" || !s.alive || s.side === t.side) continue;
    if (s.order.type === "anchored") {
      s.order = { type: "weighing" };
      s.weighT = TUNE.weighTime;
      s.pendingMove = null;
      s.targetId = targetId;
      st.events.push({ k: "weigh", id: s.id });
    } else {
      s.order = { type: "attack", targetId };
      s.path = [];
      s.repathT = 0;
    }
  }
}
function patrolAddPoint(st, ids, x, z) {
  for (const id of ids) {
    const s = unitById(st, id);
    if (!s || s.kind !== "ship" || !s.alive) continue;
    if (s.order.type !== "patrol") {
      s.order = { type: "patrol", points: [] };
      s.path = [];
    }
    s.order.points.push([x, z]);
    if (s.order.points.length === 1) {
      s.path = buildPath(s.x, s.z, x, z, st);
    }
  }
}


/* ---------------- control groups ---------------- */
// Groups 1..5 are selection sets only (no formation logic). Tapping a grouped
// ship selects the whole group; the Group drawer button assigns selection.
function setGroup(st, ids, n) {
  n |= 0;
  if (n < 1 || n > 5) return;
  for (const id of ids) {
    const s = unitById(st, id);
    if (s && s.kind === "ship" && s.alive && s.side === "P") s.group = n;
  }
}
function leaveGroup(st, ids) {
  for (const id of ids) {
    const s = unitById(st, id);
    if (s && s.kind === "ship" && s.alive) s.group = 0;
  }
}
function groupShips(st, n) {
  return st.ships.filter(s => s.alive && s.side === "P" && s.group === n).map(s => s.id);
}
function setGunsFree(st, ids, free) {
  for (const id of ids) {
    const s = unitById(st, id);
    if (s && s.kind === "ship" && s.alive) s.gunsFree = free;
  }
}


/* ---------------- combat ---------------- */
// Shot types (2026-10-08, symmetric): round = hull killer at full range;
// chain = shreds rigging (cripples speed/tacking) at 0.8x range;
// grape = shreds crew (slows reloads, ruins accuracy) at 0.55x range.
const SHOT_RANGE_MUL = { round: 1, chain: 0.8, grape: 0.55 };
function shotOf(u) { return u.kind === "battery" ? "round" : (u.shot || "round"); }
function effRangeOf(u) {
  const base = u.kind === "battery" ? TUNE.batteryRange : SHIPCLS[u.cls].range;
  return base * (SHOT_RANGE_MUL[shotOf(u)] || 1);
}
function setShot(st, ids, shot) {
  if (!SHOT_RANGE_MUL[shot]) return;
  for (const id of ids) {
    const s = unitById(st, id);
    if (s && s.kind === "ship" && s.alive) s.shot = shot;
  }
}
function setPatience(st, ids, v) {
  v = clamp(v, 0, 1);
  for (const id of ids) {
    const s = unitById(st, id);
    if (s && s.kind === "ship" && s.alive) s.patience = v;
  }
}
// Capability factors from damage (2026-10-08): rigging loss slows and
// unhandies the ship; crew loss slows reloads and ruins accuracy. Focus fire
// compounds — crippling is a strategy, not just a damage race.
function shipFactors(s) {
  const rigFrac = 1 - (s.rigging === undefined ? 100 : s.rigging) / 100;
  const crewFrac = 1 - (s.crew === undefined ? 100 : s.crew) / 100;
  return {
    spd: Math.max(0.35, 1 - 0.45 * rigFrac), // dismasted ships crawl (min floor)
    turn: 1 - 0.4 * rigFrac,
    rld: 1 + 0.8 * crewFrac,   // reload time multiplier
    acc: 1 - 0.35 * crewFrac,  // hit-chance multiplier
  };
}
// Pure hit-chance geometry (no rng): drives the actual shot's hit roll.
// Reaches 1.0 only at a point-blank stern rake (0.9 * 1.35, clamped).
function hitChance(shooter, target) {
  const d = dist(shooter.x, shooter.z, target.x, target.z);
  const range = effRangeOf(shooter);
  let hc = TUNE.baseHit * (1 - 0.5 * clamp(d / range, 0, 1));
  if (target.kind === "ship") {
    const aspect = angDiff(bearing(target.x, target.z, shooter.x, shooter.z), target.heading);
    if (aspect < Math.PI / 4) hc *= 0.5;            // bow-on: narrow target, hard to hit
    // stern rake: shots sweep the deck. x1.35 (not 1.2) so a close stern rake
    // can actually reach hc=1.0: ship separation keeps hulls ~9-15u apart, and
    // at 1.2 nothing reachable in the real sim ever hit 1.0 — the 100% slider
    // stop was a dead option (2026-10-09). Invented/tunable.
    else if (aspect > 3 * Math.PI / 4) hc = Math.min(1, hc * 1.35);
  }
  if (shooter.kind === "ship") hc *= shipFactors(shooter).acc;
  return clamp(hc, 0, 1);
}
// Single gun shot. Returns {hit, dmg}. dmgScale carries the patience damage
// multiplier and the perpendicularity bonus (see tryFireBroadside).
// Exposed for tests.
function shotOutcome(rng, shooter, target, dmgScale) {
  const d = dist(shooter.x, shooter.z, target.x, target.z);
  const range = effRangeOf(shooter);
  const hc = hitChance(shooter, target);
  let dmgMul = 1;
  if (target.kind === "ship") {
    const aspect = angDiff(bearing(target.x, target.z, shooter.x, shooter.z), target.heading);
    if (aspect < Math.PI / 4) dmgMul = 0.5;        // glancing off the bow
    else if (aspect > 3 * Math.PI / 4) dmgMul = 1.25; // raking bonus: the reward for crossing the T
  }
  const hit = rng() < hc;
  const base = (shooter.kind === "battery" ? TUNE.batteryDmg : TUNE.gunDmg) * (dmgScale || 1);
  const dmg = hit ? base * dmgMul * (1 - 0.25 * clamp(d / range, 0, 1)) : 0;
  return { hit, dmg };
}
// Best firing solution for one broadside: nearest enemy in arc, in range,
// and (ships) within vision. Returns {target, hc} or null. Shared by
// tryFireBroadside and fireReadiness so the bar shows exactly what the guns see.
function broadsideSolution(st, s, side) {
  const c = SHIPCLS[s.cls];
  const range = effRangeOf(s);
  const arc = TUNE.broadsideArc;
  // Fog-of-war rule (2026-10-08): a ship only fires at targets it can see —
  // within its own class vision range. (Batteries are static, revealed once
  // explored, and exempt.)
  const vr = s.kind === "battery" ? Infinity : c.vision;
  let best = null, bestD = 1e9;
  for (const t of enemiesOf(st, s.side)) {
    const d = dist(s.x, s.z, t.x, t.z);
    if (d > range || d > vr) continue;
    const rel = angNorm(bearing(s.x, s.z, t.x, t.z) - s.heading);
    const offBeam = Math.abs(Math.abs(rel) - Math.PI / 2);
    if (offBeam > arc) continue;
    const tSide = rel > 0 ? "R" : "L";
    if (tSide !== side) continue;
    if (d < bestD) { bestD = d; best = t; }
  }
  if (!best) return null;
  return { target: best, hc: hitChance(s, best) };
}
// Patience damage multiplier (2026-10-09): x(0.5 + p). p=0 -> half damage,
// p=0.5 -> base, p=1 -> x1.5. Pure — unit-tested.
function patienceDmg(p) { return 0.5 + clamp(p, 0, 1); }
// Perpendicularity bonus (2026-10-09): 1 + 0.5*(1 - dev/arc), dev = how far
// the target's bearing is off the firer's exact beam. Exact perpendicular ->
// x1.5; edge of the firing arc -> x1.0. Pure — unit-tested.
function perpBonus(dev) { return 1 + 0.5 * (1 - clamp(dev / TUNE.broadsideArc, 0, 1)); }
// Patience dial (2026-10-09, user verdict: simplify firing around patience).
// Per broadside: fire cycle = R * (0.5 + p), damage x(0.5 + p) via
// patienceDmg, where R = class reload (crew factor applies through the
// decrement, so effective R = class reload * crew factor). p=0: double rate,
// half damage; p=0.5: base rate, base damage; p=1: 1.5x cycle, x1.5 damage.
// DPS is flat by construction — the tradeoff is alpha-vs-chip, exactly the
// user's ask. Perpendicularity: guns fire only within ±6° of the beam, and
// the squarer the shot the harder it hits (perpBonus above), so mutual
// broadside-to-broadside is max damage. Stacks with rake/aspect/range terms.
// Invented/tunable: the 0.5 slopes.
function tryFireBroadside(st, s, side) {
  const c = SHIPCLS[s.cls];
  const sol = broadsideSolution(st, s, side);
  if (!sol) return; // no target in arc: hold loaded until one enters
  const best = sol.target;
  const p = s.patience === undefined ? 0.6 : s.patience;
  const cycle = c.reload * (0.5 + p);
  if (side === "L") { s.reloadL = cycle; s.cycL = cycle; }
  else { s.reloadR = cycle; s.cycR = cycle; }
  const rel = angNorm(bearing(s.x, s.z, best.x, best.z) - s.heading);
  const dev = Math.abs(Math.abs(rel) - Math.PI / 2);
  const dmgScale = patienceDmg(p) * perpBonus(dev);
  const bx = s.x + Math.sin(s.heading + (side === "R" ? Math.PI / 2 : -Math.PI / 2)) * c.beam;
  const bz = s.z + Math.cos(s.heading + (side === "R" ? Math.PI / 2 : -Math.PI / 2)) * c.beam;
  st.events.push({ k: "fire", id: s.id, side, x: bx, z: bz, tx: best.x, tz: best.z, shot: s.shot });
  for (let g = 0; g < c.guns; g++) {
    const r = shotOutcome(st.rng, s, best, dmgScale);
    if (r.hit) damageUnit(st, best, r.dmg, s);
    else st.events.push({ k: "miss", tx: best.x, tz: best.z });
  }
}
// Fire-readiness meter: 0..patience on a fixed 0-100% bar. The bar climbs
// 0 → patience over the broadside's cycle and turns full green AT the
// patience level — the point where the ship fires (2026-10-09 user verdict:
// "60% patience → green at 60% of the bar; 100% → green at the top").
// Tracks the least-ready broadside (min), so every shot restarts it at 0;
// a loaded-holding side can't pin it at full (the ±6° arc made max() stick).
function fireReadiness(st, s) {
  if (!s.alive || s.kind !== "ship") return 0;
  const p = s.patience === undefined ? 0.6 : s.patience;
  const cl = s.cycL > 0 ? s.cycL : 1, cr = s.cycR > 0 ? s.cycR : 1;
  const prog = Math.min(clamp((cl - s.reloadL) / cl, 0, 1), clamp((cr - s.reloadR) / cr, 0, 1));
  return clamp(prog * p, 0, 1);
}
// Split damage across pools by shot type (2026-10-08). Batteries always fire
// round shot at hull. Ships sink when hull hits 0; rigging/crew bottom out at
// 0 and degrade capability through shipFactors().
function damageUnit(st, t, dmg, from) {
  if (!t.alive || !(dmg > 0)) return;
  const shot = from ? shotOf(from) : "round";
  // the hull fraction is a property of the shot (chain is weak vs forts too);
  // rigging/crew pools only exist on ships.
  let hullDmg = dmg, rigDmg = 0, crewDmg = 0;
  if (shot === "chain") { hullDmg = dmg * 0.35; rigDmg = dmg * 1.2; }
  else if (shot === "grape") { hullDmg = dmg * 0.30; crewDmg = dmg * 1.2; }
  if (t.kind === "ship") {
    t.rigging = Math.max(0, (t.rigging === undefined ? 100 : t.rigging) - rigDmg);
    t.crew = Math.max(0, (t.crew === undefined ? 100 : t.crew) - crewDmg);
  }
  t.hp -= hullDmg;
  t.hitFlash = 0.4;
  st.events.push({ k: "hit", id: t.id, dmg: hullDmg, tx: t.x, tz: t.z, sunk: t.hp <= 0 });
  if (t.hp <= 0) {
    t.alive = false;
    st.events.push({ k: "sunk", id: t.id, kind: t.kind, x: t.x, z: t.z, side: t.side });
  }
}
function batteryFire(st, b) {
  let best = null, bestD = 1e9;
  for (const s of st.ships) {
    if (!s.alive || s.side === b.side) continue;
    const d = dist(b.x, b.z, s.x, s.z);
    if (d < bestD && d <= b.range) { bestD = d; best = s; }
  }
  if (!best) return;
  b.reload = TUNE.batteryReload;
  st.events.push({ k: "fire", id: b.id, side: "B", x: b.x, z: b.z + 2, tx: best.x, tz: best.z });
  const r = shotOutcome(st.rng, b, best, 1);
  if (r.hit) damageUnit(st, best, r.dmg, b);
  else st.events.push({ k: "miss", tx: best.x, tz: best.z });
}

/* ---------------- movement ---------------- */
const STEER_PROBE = 20; // lookahead for the land-aware no-go edge choice (tunable)
// True if sailing heading h from the ship keeps clearance for STEER_PROBE.
// Used to keep the no-go falloff from picking an edge that runs into a shore.
function edgeClear(s, h) {
  return segClear(s.x, s.z, s.x + Math.sin(h) * STEER_PROBE, s.z + Math.cos(h) * STEER_PROBE);
}
function followPath(st, s, dt, arriveSlow) {
  if (!s.path.length) return true;
  const wp = s.path[0];
  const d = dist(s.x, s.z, wp[0], wp[1]);
  // Corner carving (2026-10-09 user verdict: tacking ships should flow around
  // corners, not sail dead-on at each tack point, arrive slow, and pivot in
  // place). Within 25u of the waypoint with a next leg queued, steer at a
  // blend of this waypoint and the next (k: 0 far away -> 1 at the point), so
  // the ship arcs onto the next leg while it still has speed. Final waypoint:
  // no blending, arriveSlow behavior untouched.
  let tx = wp[0], tz = wp[1];
  if (s.path.length > 1 && d < 25) {
    const nx = s.path[1];
    const k = 1 - clamp(d / 25, 0, 1);
    tx = wp[0] + (nx[0] - wp[0]) * k;
    tz = wp[1] + (nx[1] - wp[1]) * k;
  }
  // Advance the index when close to the current point, or when the next point
  // is already nearer (the corner was cut) — never skip indices blindly.
  // The FINAL waypoint keeps the old tight 7u arrival radius: corner-cutting
  // must not complete the order while the ship is still 12u out.
  const advR = s.path.length === 1 ? 7 : 12;
  if (d < advR || (s.path.length > 1 && dist(s.x, s.z, s.path[1][0], s.path[1][1]) < d)) {
    s.path.shift();
    return s.path.length === 0;
  }
  const final = s.path.length === 1;
  steerToward(st, s, dt, bearing(s.x, s.z, tx, tz), arriveSlow && final && d < 25 ? 0.35 : 1);
  return false;
}
function steerToward(st, s, dt, wantH, speedMul) {
  const c = SHIPCLS[s.cls];
  // Local wind at the ship: direction drives the no-go clamp and sail
  // efficiency, magnitude scales the target speed. Same field for both sides.
  const w = windAt(st, s.x, s.z);
  // Never try to sail in irons: fall off to the nearest sailable heading.
  // (This also yields emergent tacking when a waypoint lies dead upwind.)
  // The edge is picked by proximity to the CURRENT heading: picking by the
  // sign of `off` flips 72° whenever the bearing jitters across ±π, which
  // made ships spin in place (2026-10-08).
  const off = angNorm(wantH - w.ang);
  if (Math.abs(off) > TUNE.noGo - TACK_MARGIN) {
    const e1 = w.ang + (TUNE.noGo - TACK_MARGIN);
    const e2 = w.ang - (TUNE.noGo - TACK_MARGIN);
    // Land-aware edge choice (2026-10-08): the spin-fix proximity rule below
    // can trap a ship against a lee shore — it keeps picking the edge that
    // points into the island while moveShip zeroes its speed. If exactly one
    // edge is clear of land, take it; otherwise keep the proximity rule.
    const c1 = edgeClear(s, e1), c2 = edgeClear(s, e2);
    if (c1 && !c2) wantH = e1;
    else if (c2 && !c1) wantH = e2;
    else wantH = angDiff(e1, s.heading) < angDiff(e2, s.heading) ? e1 : e2;
  }
  const inNoGo = angDiff(wantH, w.ang) > TUNE.noGo;
  // damage degrades capability (2026-10-08): shot-away rigging slows the ship
  // and makes her unhandy; the factors are symmetric for both sides.
  const fac = shipFactors(s);
  // Way-dependent turning (2026-10-09 user verdict: ships must be traveling
  // forward to turn; curve SOFTENED 2026-10-09 per user — the old 0.2/0.6
  // curve compounded with speed loss through irons and strangled tacks).
  // Stopped = 40% turn (still punishes rotate-in-place-to-shoot; doubles as
  // the anti-stall floor, never permanently stuck); >=40% of class base
  // speed = full turn, so a tacking ship keeps authority through most of the
  // turn. ~constant turning radius (v/turnRate) in the proportional band —
  // the user's "limit the turning radius". Invented/tunable: 0.4 floor/band.
  // (The original spin-in-place bug was fixed by hysteresis, not by this
  // penalty, so softening reopens nothing.)
  const wayFrac = clamp(s.speed / (0.4 * c.speed), 0, 1);
  const turnRate = c.turn * (0.4 + 0.6 * wayFrac) * (inNoGo ? 0.5 : 1) * fac.turn;
  const dh = angNorm(wantH - s.heading);
  s.heading += clamp(dh, -turnRate * dt, turnRate * dt);
  const eff = sailEff(s.heading, w.ang);
  const target = c.speed * eff * (speedMul || 1) * w.mag * fac.spd;
  // ships wallowing in the no-go zone barely move
  // gentle decel (0.5x) so ships coast to a stop instead of halting hard (2026-10-08).
  // In irons (sails flogging, eff~0) the ship glides on momentum instead of
  // slamming to a stop: decel scales with sail drive, 0.03x deep in irons.
  // Without this, a tacking ship loses all way mid-turn and wallows (2026-10-09
  // user verdict: tacking must flow, not stop). Invented/tunable: 0.03 floor.
  const ironsK = clamp(eff / 0.4, 0, 1); // 0 deep in irons -> 1 sails drawing
  s.speed += clamp(target - s.speed, -c.speed * dt * (0.03 + 0.47 * ironsK), c.speed * dt * 0.8);
  moveShip(st, s, dt);
}
function moveShip(st, s, dt) {
  if (s.speed < 0.01) return;
  const B = TUNE.boundsHalf;
  const nx = s.x + Math.sin(s.heading) * s.speed * dt;
  const nz = s.z + Math.cos(s.heading) * s.speed * dt;
  // The map edge is a coastline: try the full step, then slide along each
  // axis — exactly like land. A ship carried into the edge slides along it
  // instead of stopping dead against the invisible wall.
  const ok = (x, z) => Math.abs(x) <= B && Math.abs(z) <= B && !inLand(x, z);
  if (ok(nx, nz)) { s.x = nx; s.z = nz; return; }
  if (ok(nx, s.z)) { s.x = nx; return; }
  if (ok(s.x, nz)) { s.z = nz; return; }
  s.speed *= 0.5; // fully boxed in: gentle decel, never a permanent hard stop
}
function separation(st) {
  const ships = st.ships.filter(s => s.alive);
  for (let i = 0; i < ships.length; i++) {
    for (let j = i + 1; j < ships.length; j++) {
      const a = ships[i], b = ships[j];
      const ra = SHIPCLS[a.cls].radius, rb = SHIPCLS[b.cls].radius;
      const d = dist(a.x, a.z, b.x, b.z), min = ra + rb;
      if (d > 0.01 && d < min) {
        const push = (min - d) / 2;
        const nx = (b.x - a.x) / d, nz = (b.z - a.z) / d;
        if (!a.order || a.order.type !== "anchored") { a.x -= nx * push; a.z -= nz * push; }
        if (!b.order || b.order.type !== "anchored") { b.x += nx * push; b.z += nz * push; }
      }
    }
  }
}

/* ---------------- broadside hold (shared by player + enemy attack) ---------------- */
// Hold a broadside bearing on target t, drifting slowly. The port/starboard
// choice has hysteresis: picking the nearer side fresh every frame flips the
// choice whenever the target sits near the equidistant boundary, and the ship
// cranks ~100° back and forth while sail efficiency is ~0 — spinning in place
// (2026-10-08). The choice sticks until the other side is nearer by BSIDE_HYST.
const BSIDE_HYST = 25 * Math.PI / 180;
function broadsideHold(st, s, dt, t) {
  if (s.bsideTgt !== t.id) { s.bside = 0; s.bsideTgt = t.id; }
  const b = bearing(s.x, s.z, t.x, t.z);
  const h1 = b + Math.PI / 2, h2 = b - Math.PI / 2;
  if (!s.bside) {
    s.bside = angDiff(h1, s.heading) < angDiff(h2, s.heading) ? 1 : -1;
  } else {
    const cur = s.bside === 1 ? h1 : h2;
    const oth = s.bside === 1 ? h2 : h1;
    if (angDiff(oth, s.heading) + BSIDE_HYST < angDiff(cur, s.heading)) s.bside = -s.bside;
  }
  steerToward(st, s, dt, s.bside === 1 ? h1 : h2, 0.25);
}
// Shared attack-order movement: close to gun range, then hold a broadside
// bearing while drifting. The range check has hysteresis (engage at 0.7x
// effective range, break off beyond 0.9x): with a single threshold the
// distance jitters across the line on successive steps and the ship
// flip-flops between chase (followPath) and broadside-hold — two steering
// modes fighting, spinning in place (2026-10-08).
function attackStep(st, s, dt, t) {
  if (s.engageTgt !== t.id) { s.engage = false; s.engageTgt = t.id; s.repathTx = undefined; }
  const d = dist(s.x, s.z, t.x, t.z);
  const range = effRangeOf(s);
  if (!s.engage && d <= 0.7 * range) s.engage = true;
  else if (s.engage && d > 0.9 * range) s.engage = false;
  if (!s.engage) {
    // Throttle A* rebuilds: at most once a second, and only when the target
    // actually moved (>15u) since the last build — a full-grid A* per ship
    // per tick would be wasteful during long chases.
    s.repathT -= dt;
    const moved = s.repathTx === undefined ? 1e9 : dist(s.repathTx, s.repathTz, t.x, t.z);
    if (!s.path.length || (s.repathT <= 0 && moved > 15)) {
      s.path = buildPath(s.x, s.z, t.x, t.z, st);
      s.repathT = 1;
      s.repathTx = t.x; s.repathTz = t.z;
    }
    followPath(st, s, dt, false);
  } else {
    s.path = [];
    broadsideHold(st, s, dt, t);
  }
}

/* ---------------- enemy doctrine AI (2026-10-08) ---------------- */
// NOT "send all ships at nearest enemy" (user verdict). Each enemy ship has a
// per-ship goal (this level: defend the harbor zone), a seeded bloodlust
// (0.25..0.75: cautious ships hold station, hotheads pursue), and a stance.
// The strategic tick runs every 2s per ship (staggered); the tactical layer
// (attackStep/broadsideHold, fire discipline, split damage) is the same code
// the player uses. The AI uses every gunnery option: shot types, fire
// thresholds.
const AI_GUARD_R = 150;   // hold within this of the goal (tunable)
const AI_INTERCEPT_R = 400; // intercept player ships this close to the goal and closing (tunable)
const AI_PURSUE_R = 600;  // break pursuit past this from the goal (tunable)
// (2026-10-09: AI_WITHDRAW_HP / AI_RECOVER_HP removed with the WITHDRAW stance —
// enemies never repair, so crippled ships fight on.)
// Player ships this ship can see (class vision range — the enemy's "existing
// vision rules"). Sorted nearest-first. [{p, d}]
function visibleEnemies(st, s) {
  const out = [];
  const vr = SHIPCLS[s.cls].vision;
  for (const p of st.ships) {
    if (!p.alive || p.side === s.side) continue;
    const d = dist(s.x, s.z, p.x, p.z);
    if (d <= vr) out.push({ p, d });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}
// Is p's velocity carrying it toward the goal faster than 1 u/s?
function closingOn(p, goal) {
  const vx = Math.sin(p.heading) * p.speed, vz = Math.cos(p.heading) * p.speed;
  const dx = goal.x - p.x, dz = goal.z - p.z;
  const l = Math.hypot(dx, dz) || 1;
  return (vx * dx + vz * dz) / l > 1.0;
}
// Is p moving away from the goal faster than 2 u/s? (fleeing)
function movingAway(p, goal) {
  const vx = Math.sin(p.heading) * p.speed, vz = Math.cos(p.heading) * p.speed;
  const dx = p.x - goal.x, dz = p.z - goal.z;
  const l = Math.hypot(dx, dz) || 1;
  return (vx * dx + vz * dz) / l > 2.0;
}
// Claim coordination (anti-deathball): each ship prefers its stance target,
// otherwise takes the nearest visible enemy with < 2 claimants; very
// bloodlusty ships (>0.6) may join as a 3rd for focus fire. Reads the live
// targetIds of the other enemy ships, so staggered 2s ticks stay coherent.
function aiTarget(st, s, preferred, leashR) {
  const ai = s.ai;
  const claims = {};
  for (const o of st.ships) {
    if (o === s || o.side !== "E" || !o.alive || !o.ai || !o.ai.targetId) continue;
    claims[o.ai.targetId] = (claims[o.ai.targetId] || 0) + 1;
  }
  let visP = visibleEnemies(st, s);
  if (leashR) visP = visP.filter(v => v.d <= leashR);
  const pick = (maxClaims) => {
    for (const v of visP) if ((claims[v.p.id] || 0) < maxClaims) return v.p;
    return null;
  };
  let t = null;
  if (preferred && preferred.alive && visP.some(v => v.p === preferred)) {
    const cc = claims[preferred.id] || 0;
    if (cc < 2 || ai.bloodlust > 0.6) t = preferred;
  }
  if (!t) t = pick(2);
  if (!t && ai.bloodlust > 0.6) t = pick(3);
  ai.targetId = t ? t.id : 0;
  if (t) {
    // shot selection (AI uses the same shot types as the player):
    // chain the faster/fleeing, grape them close aboard, round otherwise.
    const tc = SHIPCLS[t.cls], mc = SHIPCLS[s.cls];
    const d = dist(s.x, s.z, t.x, t.z);
    if (tc.speed > mc.speed || movingAway(t, ai.goal)) s.shot = "chain";
    else if (d < 0.5 * mc.range) s.shot = "grape";
    else s.shot = "round";
  }
  // patience dial (AI uses the same slider as the player):
  // patient ships wait longer between broadsides for harder hits, hotheads
  // fire fast and weak.
  s.patience = 0.75 - 0.3 * ai.bloodlust;
}
// Strategic tick (every 2s per ship, staggered). Sets stance + target;
// aiMove executes.
function aiStrategic(st, s) {
  const ai = s.ai, c = SHIPCLS[s.cls], goal = ai.goal;
  const hullFrac = s.hp / s.maxHp;
  // (2026-10-09: WITHDRAW removed — enemies never repair, so crippled ships
  // fight on instead of falling back.)
  const visP = visibleEnemies(st, s);
  // Continue an existing pursuit? Break off if the target is gone, escaped
  // >600u past the goal, or the bloodlust check fails this tick.
  if (ai.stance === "PURSUE") {
    const t = unitById(st, ai.targetId);
    if (!t || !t.alive || dist(t.x, t.z, goal.x, goal.z) > AI_PURSUE_R || st.rng() > ai.bloodlust) {
      ai.stance = "GUARD"; ai.targetId = 0;
    } else { aiTarget(st, s, t); return; }
  }
  // INTERCEPT: a visible player ship inside 400u of the goal and closing on
  // it gets cut off — this is the harbor defense doing its job.
  let ic = null, icd = 1e9;
  for (const v of visP) {
    if (dist(v.p.x, v.p.z, goal.x, goal.z) < AI_INTERCEPT_R && closingOn(v.p, goal) && v.d < icd) {
      icd = v.d; ic = v.p;
    }
  }
  if (ic) { ai.stance = "INTERCEPT"; aiTarget(st, s, ic); return; }
  // PURSUE: bloodlust — a damaged or fleeing visible enemy is chased.
  for (const v of visP) {
    const p = v.p;
    if ((p.hp / p.maxHp < 0.45 || movingAway(p, goal)) && st.rng() < ai.bloodlust) {
      ai.stance = "PURSUE"; aiTarget(st, s, p); return;
    }
  }
  // GUARD: hold station near the goal; engage visible enemies only at
  // defensive range (leashed), coordinated through the claim map.
  ai.stance = "GUARD";
  aiTarget(st, s, null, c.range * 1.5);
}
function aiThink(st, s, dt) {
  s.ai.thinkT -= dt;
  if (s.ai.thinkT > 0) return;
  s.ai.thinkT = 2;
  aiStrategic(st, s);
}
// Tactical execution. Enemy ships are fully AI-driven (no player orders).
function aiMove(st, s, dt) {
  const ai = s.ai, c = SHIPCLS[s.cls];
  const t = ai.targetId ? unitById(st, ai.targetId) : null;
  if (t && t.alive) { attackStep(st, s, dt, t); return; }
  ai.targetId = 0;
  // station keeping: back inside 150u of the goal, else hold still
  const g = ai.goal;
  if (dist(s.x, s.z, g.x, g.z) > AI_GUARD_R) {
    if (s.order.type !== "move" || !s.path.length) {
      s.order = { type: "move" };
      s.path = buildPath(s.x, s.z, g.x, g.z, st);
    }
    followPath(st, s, dt, true);
  } else {
    if (s.order.type !== "hold") { s.order = { type: "hold" }; s.path = []; }
    s.speed = Math.max(0, s.speed - c.speed * dt * 0.35);
    if (s.speed > 0.01) moveShip(st, s, dt);
  }
}

/* ---------------- per-ship step ---------------- */
function stepShip(st, s, dt) {
  if (!s.alive) return;
  const c = SHIPCLS[s.cls];
  if (s.hitFlash > 0) s.hitFlash -= dt;
  // crew casualties slow the gun crews: reloads take longer (2026-10-08)
  const rdt = dt / shipFactors(s).rld;
  s.reloadL = Math.max(0, s.reloadL - rdt);
  s.reloadR = Math.max(0, s.reloadR - rdt);

  if (s.side === "E") { aiThink(st, s, dt); aiMove(st, s, dt); }
  else {
  const o = s.order;
  if (o.type === "anchored") {
    s.speed = 0;
  } else if (o.type === "weighing") {
    s.speed = 0;
    s.weighT -= dt;
    if (s.weighT <= 0) {
      if (s.pendingMove) {
        const pm = s.pendingMove;
        s.order = { type: pm.attackMove ? "attackmove" : "move" };
        s.path = buildPath(s.x, s.z, pm.x, pm.z, st);
        s.pendingMove = null;
      } else if (s.targetId) {
        s.order = { type: "attack", targetId: s.targetId };
        s.repathT = 0;
      } else {
        s.order = { type: "hold" };
      }
    }
  } else if (o.type === "hold") {
    // coast to a stop (gentle 0.35x decay, 2026-10-08)
    s.speed = Math.max(0, s.speed - c.speed * dt * 0.35);
    if (s.speed > 0.01) moveShip(st, s, dt);
  } else if (o.type === "move" || o.type === "attackmove") {
    if (followPath(st, s, dt, true)) { s.order = { type: "hold" }; }
  } else if (o.type === "patrol") {
    if (!o.points.length || o.points.length < 2) {
      s.speed = Math.max(0, s.speed - c.speed * dt * 0.35);
      if (s.speed > 0.01) moveShip(st, s, dt);
    } else if (followPath(st, s, dt, false)) {
      o.leg = ((o.leg === undefined ? 0 : o.leg) + 1) % o.points.length;
      const pn = o.points[o.leg];
      s.path = buildPath(s.x, s.z, pn[0], pn[1], st);
    }
  } else if (o.type === "attack") {
    const t = unitById(st, o.targetId);
    if (!t || !t.alive) { s.order = { type: "hold" }; s.targetId = 0; }
    else attackStep(st, s, dt, t);
  }
  } // end player order dispatch (enemy ships run aiThink/aiMove instead)

  // combat: Hold = never fire; Free = fire per the ship's patience cycle
  // (2026-10-08 user verdict). tryFireBroadside fires at the best target in
  // arc whenever the broadside's cycle completes — no withholding.
  if (s.gunsFree && s.order.type !== "weighing") {
    if (s.reloadL <= 0) tryFireBroadside(st, s, "L");
    if (s.reloadR <= 0) tryFireBroadside(st, s, "R");
  }
}

/* ---------------- main step ---------------- */
function step(st, dt) {
  if (st.result) return;
  st.time += dt;
  for (const s of st.ships) stepShip(st, s, dt);
  for (const b of st.batteries) {
    if (!b.alive || b.inert) continue;
    if (b.hitFlash > 0) b.hitFlash -= dt;
    b.reload -= dt;
    if (b.reload <= 0) batteryFire(st, b);
  }
  separation(st);

  // repair at anchor (2026-10-08): a PLAYER ship that stays anchored with no
  // enemy inside any friendly ship's vision for TUNE.repairGrace continuous
  // seconds starts repairing (+repairRate %/s to hull/rigging/crew, capped).
  // Weighing anchor or an enemy entering vision resets the grace period.
  // Enemy ships never repair (2026-10-09 user verdict): damage sticks.
  {
    let threatP = false; // enemy visible to P
    for (const a of st.ships) {
      if (!a.alive || a.side !== "P") continue;
      for (const b of st.ships) {
        if (!b.alive || b.side === a.side) continue;
        if (dist(a.x, a.z, b.x, b.z) <= SHIPCLS[a.cls].vision) { threatP = true; break; }
      }
      if (threatP) break;
    }
    for (const s of st.ships) {
      if (!s.alive || s.kind !== "ship") continue;
      if (s.side !== "P") { s.repairT = 0; s.repairing = false; continue; }
      if (s.order.type === "anchored" && !threatP) {
        s.repairT += dt;
        if (s.repairT >= TUNE.repairGrace) {
          s.repairing = true;
          const rh = s.maxHp * (TUNE.repairRate / 100) * dt;
          const rp = TUNE.repairRate * dt;
          s.hp = Math.min(s.maxHp, s.hp + rh);
          s.rigging = Math.min(100, s.rigging + rp);
          s.crew = Math.min(100, s.crew + rp);
        }
      } else {
        s.repairT = 0;
        s.repairing = false;
      }
    }
  }

  // fog of war: stamp explored discs around every alive player ship
  // (soft-edged: explored reaches visionR + FOW_FEATHER)
  {
    const f = st.fow;
    for (const s of st.ships) {
      if (s.alive && s.side === "P") stampVision(f, s.x, s.z, SHIPCLS[s.cls].vision, null, null, f.exp);
    }
  }

  // capture
  const z = st.zone;
  if (z.owner !== "P") {
    let anchoredP = 0, enemyIn = 0;
    for (const s of st.ships) {
      if (!s.alive) continue;
      if (dist(s.x, s.z, z.x, z.z) > z.r) continue;
      if (s.side === "P" && s.order.type === "anchored") anchoredP++;
      if (s.side === "E") enemyIn++;
    }
    if (anchoredP > 0 && enemyIn === 0) {
      const before = z.progress;
      z.progress = Math.min(1, z.progress + dt / TUNE.captureTime);
      if (Math.floor(z.progress * 20) !== Math.floor(before * 20))
        st.events.push({ k: "capture", p: z.progress });
      if (z.progress >= 1) {
        z.owner = "P";
        for (const b of st.batteries) if (b.alive) b.side = "P";
        st.result = "won";
        st.events.push({ k: "win" });
      }
    }
  }
  // defeat
  if (!st.result && !st.ships.some(s => s.alive && s.side === "P")) {
    st.result = "lost";
    st.events.push({ k: "lose" });
  }
}

/* ---------------- public API ---------------- */
return {
  TAU, TUNE, SHIPCLS, MAP_S, FOW_N, FOW_HALF, FOW_FEATHER, ZONE, LAND_POLY, ISLANDS, BATTERY_SPOTS, ENEMY_PATROL,
  WIND_N, WIND_HALF, windAt,
  angNorm, angDiff, clamp, dist, bearing, sailEff, buildPath, astarRoute, clampToWater, segWalkable,
  waterClear, segClear, routeLeg, playable,
  inLand, pointInPoly, mulberry32,
  newMatch, unitById, enemiesOf, computeVisibility, fowCellIJ,
  orderMove, orderHold, orderAnchor, orderWeighAnchor, orderAttack,
  patrolAddPoint, setGunsFree, setGroup, leaveGroup, groupShips,  setShot, setPatience, patienceDmg, perpBonus, shotOf, effRangeOf, hitChance, shipFactors, damageUnit,
  shotOutcome, broadsideSolution, fireReadiness, steerToward, step,
};
})();
if (typeof module !== "undefined" && module.exports) module.exports = BS;
