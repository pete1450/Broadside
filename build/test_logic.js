/* Headless node tests for BROADSIDE logic.js. Run: node test_logic.js */
const BS = require("./logic.js");

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log("  ok  " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
function stepFor(st, secs, dt) {
  dt = dt || 0.1;
  const n = Math.ceil(secs / dt);
  for (let i = 0; i < n; i++) BS.step(st, dt);
}
// time (s) for ship to get within 10 of target, cap 900s
function timeToArrive(st, ship, tx, tz) {
  let t = 0;
  const dt = 0.2;
  while (t < 900 && BS.dist(ship.x, ship.z, tx, tz) > 10) { BS.step(st, dt); t += dt; }
  return t;
}

console.log("== tacking pathfinder ==");
{
  // wind blowing toward +z (south). Ship at (0,60) ordered to (0,-5): dead upwind.
  const st = BS.newMatch(7, 0);
  const s = st.ships[0];
  s.x = 0; s.z = 60; s.heading = Math.PI; s.speed = 0;
  st.ships.forEach(x => { if (x.side === "E") { x.x = 120; x.z = 120; } });
  st.batteries.forEach(b => { b.x = 120; b.z = -120; });
  BS.orderMove(st, [s.id], 0, -5, false);
  ok(s.path.length > 3, "upwind order builds multi-leg tacking path", "legs=" + s.path.length);
  const tUp = timeToArrive(st, s, 0, -5);
  ok(BS.dist(s.x, s.z, 0, -5) <= 10, "tacking ship reaches upwind target", "t=" + tUp.toFixed(0));

  // downwind comparison: same distance, wind behind.
  const st2 = BS.newMatch(7, 0);
  const s2 = st2.ships[0];
  s2.x = 0; s2.z = 0; s2.heading = 0; s2.speed = 0;
  st2.ships.forEach(x => { if (x.side === "E") { x.x = 120; x.z = 120; } });
  st2.batteries.forEach(b => { b.x = 120; b.z = -120; });
  BS.orderMove(st2, [s2.id], 0, 65, false);
  ok(s2.path.length <= 2, "downwind order is a straight path", "legs=" + s2.path.length);
  const tDown = timeToArrive(st2, s2, 0, 65);
  const ratio = tUp / tDown;
  ok(ratio > 2.0 && ratio < 4.5, "upwind takes ~2.5-3x longer than downwind",
     "up=" + tUp.toFixed(0) + "s down=" + tDown.toFixed(0) + "s ratio=" + ratio.toFixed(2));
}

console.log("== sail efficiency ==");
{
  ok(Math.abs(BS.sailEff(0, 0) - 0.85) < 0.01, "running dead downwind = 0.85");
  ok(Math.abs(BS.sailEff(Math.PI / 2, 0) - 1.0) < 0.01, "beam reach = 1.0");
  ok(Math.abs(BS.sailEff(3 * Math.PI / 4, 0) - 0.4) < 0.01, "close-hauled (135°) = 0.4");
  ok(BS.sailEff(Math.PI, 0) === 0, "dead upwind = 0 (no-go)");
}

console.log("== broadside arcs ==");
{
  const st = BS.newMatch(11, 0);
  const a = st.ships[0]; // player frigate... ships[0] is sol; fine
  a.x = 0; a.z = 0; a.heading = 0; a.reloadL = 0; a.reloadR = 0; a.gunsFree = true;
  const e = st.ships[5];
  // abeam target (bearing 90° off bow) -> should fire
  e.x = 30; e.z = 0; e.heading = 0;
  st.events.length = 0;
  BS.step(st, 0.1);
  ok(st.events.some(ev => ev.k === "fire" && ev.id === a.id), "fires at abeam target");
  // dead-ahead target -> must not fire
  a.reloadL = 0; a.reloadR = 0;
  e.x = 0; e.z = 30; e.hp = e.maxHp;
  st.events.length = 0;
  BS.step(st, 0.5);
  ok(!st.events.some(ev => ev.k === "fire" && ev.id === a.id), "no fire at dead-ahead target");
}

console.log("== target aspect: bow-on reduced, stern rake rewarded (symmetric) ==");
{
  // shooter broadside facing +x at target; bearing(target->shooter) = -PI/2.
  // heading -PI/2 -> aspect 0 (bow-on, facing the shooter);
  // heading 0 -> aspect PI/2 (broadside-on);
  // heading +PI/2 -> aspect PI (stern-on: the classic rake).
  const rng = BS.mulberry32(99);
  const shooter = { kind: "ship", cls: "frigate", x: -40, z: 0, crew: 100, rigging: 100 };
  const mkT = (h) => ({ kind: "ship", cls: "frigate", x: 0, z: 0, heading: h, crew: 100, rigging: 100 });
  const bowOn = mkT(-Math.PI / 2), broad = mkT(0), stern = mkT(Math.PI / 2);
  let hb = 0, db = 0, hh = 0, dh = 0, hs = 0, ds = 0;
  const N = 800;
  for (let i = 0; i < N; i++) {
    let r = BS.shotOutcome(rng, shooter, bowOn); hb += r.hit ? 1 : 0; db += r.dmg;
    r = BS.shotOutcome(rng, shooter, broad); hh += r.hit ? 1 : 0; dh += r.dmg;
    r = BS.shotOutcome(rng, shooter, stern); hs += r.hit ? 1 : 0; ds += r.dmg;
  }
  ok(hb < hh * 0.7, "bow-on target hit less often than broadside-on", hb + " vs " + hh);
  ok(hs > hh, "stern rake hits more often than broadside-on", hs + " vs " + hh);
  ok(db < dh * 0.6, "bow-on deals less damage (glancing)", "ratio=" + (db / dh).toFixed(2));
  ok(ds > dh * 1.2, "stern rake deals the most damage (raking bonus)", "ratio=" + (ds / dh).toFixed(2));
  // hit chance must reach 1.0 at the perfect geometry: point-blank stern rake
  const pb = BS.hitChance(
    { kind: "ship", cls: "frigate", x: 0, z: 0, crew: 100, rigging: 100, shot: "round" },
    { kind: "ship", cls: "frigate", x: 2, z: 0, heading: Math.PI / 2 });
  ok(pb >= 1.0, "point-blank stern rake: hit chance reaches 1.0", "hc=" + pb.toFixed(3));
}

console.log("== capture timer ==");
{
  const st = BS.newMatch(21, 0);
  const s = st.ships[0];
  s.x = BS.ZONE.x; s.z = BS.ZONE.z;
  BS.orderAnchor(st, [s.id]);
  // move enemies far away so none are in the zone
  for (const e of st.ships) if (e.side === "E") { e.x = 120; e.z = 120; }
  stepFor(st, BS.TUNE.captureTime + 5);
  ok(st.result === "won", "anchored ship alone in zone captures -> win", "result=" + st.result);
}
{
  const st = BS.newMatch(22, 0);
  const s = st.ships[0];
  s.x = BS.ZONE.x; s.z = BS.ZONE.z;
  BS.orderAnchor(st, [s.id]);
  const e = st.ships[5];
  e.x = BS.ZONE.x + 5; e.z = BS.ZONE.z; // enemy present in zone
  e.order = { type: "hold" };
  stepFor(st, 30);
  ok(st.zone.progress === 0, "enemy ship in zone blocks capture progress",
     "p=" + st.zone.progress.toFixed(2));
  ok(st.result === null, "no win while contested");
}
{
  // not anchored -> no progress
  const st = BS.newMatch(23, 0);
  const s = st.ships[0];
  s.x = BS.ZONE.x; s.z = BS.ZONE.z; // inside zone but not anchored
  for (const e of st.ships) if (e.side === "E") { e.x = 120; e.z = 120; }
  stepFor(st, 20);
  ok(st.zone.progress === 0, "unanchored ship does not capture");
}

console.log("== weigh anchor delay ==");
{
  const st = BS.newMatch(31, 0);
  const s = st.ships[4];
  s.x = 0; s.z = 60; s.heading = Math.PI;
  BS.orderAnchor(st, [s.id]);
  BS.orderMove(st, [s.id], 0, -5, false); // queues behind weighing
  stepFor(st, BS.TUNE.weighTime - 1);
  ok(s.order.type === "weighing" && s.speed === 0, "ship stationary during weigh-anchor delay");
  const x0 = s.x, z0 = s.z;
  stepFor(st, 1.5);
  ok(s.order.type !== "weighing", "weighing completes", "order=" + s.order.type);
  stepFor(st, 20);
  ok(BS.dist(x0, z0, s.x, s.z) > 5, "ship sails after weighing anchor");
}

console.log("== enemy AI brings broadside to bear ==");
{
  const st = BS.newMatch(41, 0);
  const e = st.ships[6]; // enemy frigate
  e.x = 0; e.z = 0; e.heading = 0;
  e.ai.bloodlust = 0.75; // hothead: patience = 0.525, engages readily (deterministic)
  const p = st.ships[1]; // player frigate (180hp)
  p.x = 50; p.z = 0; p.hp = p.maxHp;
  // keep other enemies away so only e engages
  st.ships.forEach(s => { if (s !== e && s !== p && s.side === "E") { s.x = 120; s.z = 120; } });
  stepFor(st, 15); // 15s: the AI kills a frigate by ~22s now (better maneuvering), so assert while it lives
  const b = BS.bearing(e.x, e.z, p.x, p.z);
  const offBeam = Math.abs(Math.abs(BS.angNorm(b - e.heading)) - Math.PI / 2);
  ok(offBeam < 0.6, "AI steers to broadside bearing", "offBeam=" + offBeam.toFixed(2));
  ok(p.hp < p.maxHp, "AI actually shot the player", "hp=" + p.hp.toFixed(0));
  ok(e.ai.targetId === p.id, "AI claimed the player frigate as its target");
}

console.log("== batteries shoot back ==");
{
  const st = BS.newMatch(51, 0);
  const s = st.ships[4];
  s.x = -60; s.z = -80; s.hp = s.maxHp; // in battery range (batteries at ±88,-76, range 98)
  st.ships.forEach(x => { if (x.side === "E" && x.kind === "ship") { x.x = 400; x.z = 400; } });
  stepFor(st, 30);
  ok(s.hp < s.maxHp, "shore battery damaged player ship in range", "hp=" + s.hp.toFixed(0));
}

console.log("== control groups ==");
{
  const st = BS.newMatch(71, 0);
  const a = st.ships[0], b = st.ships[1], c = st.ships[2];
  BS.setGroup(st, [a.id, b.id], 2);
  ok(a.group === 2 && b.group === 2 && c.group === 0, "setGroup assigns 1..5");
  const got = BS.groupShips(st, 2).slice().sort((x, y) => x - y);
  const want = [a.id, b.id].sort((x, y) => x - y);
  ok(JSON.stringify(got) === JSON.stringify(want), "groupShips lists members");
  BS.setGroup(st, [a.id], 9);
  ok(a.group === 2, "invalid group number ignored");
  BS.setGroup(st, [c.id], 2);
  ok(BS.groupShips(st, 2).length === 3, "ships can join an existing group");
  BS.leaveGroup(st, [a.id]);
  ok(a.group === 0 && b.group === 2, "leaveGroup clears one ship");
  const e = st.ships[5]; // enemy
  BS.setGroup(st, [e.id], 3);
  ok(e.group === 0, "enemy ships can't join control groups");
}

console.log("== fog of war ==");
{
  const st = BS.newMatch(55, 0);
  ok(st.fow.exp.every(v => v === 0), "fog starts fully unexplored");
  const s = st.ships[0]; // sol, vision 65
  s.x = 0; s.z = 100; s.heading = Math.PI; s.speed = 0; s.order = { type: "hold" };
  for (const o of st.ships) if (o !== s) { o.x = 400; o.z = 400; }
  BS.step(st, 0.2);
  const cell = (x, z) => BS.fowCellIJ(st.fow, x, z);
  ok(st.fow.exp[cell(0, 100)] === 1, "ship stamps explored disc under itself");
  ok(st.fow.exp[cell(0, 40)] === 1, "cell within vision radius explored");
  ok(st.fow.exp[cell(0, 10)] === 0, "cell beyond vision+feather stays unexplored", "d~89 > 65+12");
  // sail north: new cells flip to explored
  BS.orderMove(st, [s.id], 0, 0, false);
  let guard = 0;
  while (guard++ < 400 && s.z > 60) BS.step(st, 0.2);
  ok(st.fow.exp[cell(0, 70)] === 1, "sailed-over cells become explored");
}
{
  // computeVisibility: enemy ship visible only inside a player ship's vision
  const st = BS.newMatch(56, 0);
  const s = st.ships[0]; // sol, vision 65
  s.x = 0; s.z = 100; s.heading = Math.PI; s.speed = 0; s.order = { type: "hold" };
  for (const o of st.ships) if (o !== s && o.side === "P") { o.x = 400; o.z = 400; }
  const e = st.ships[5];
  e.x = 0; e.z = 40; e.order = { type: "hold" }; // 60 away: inside vision
  for (const o of st.ships) if (o.side === "E" && o !== e) { o.x = 400; o.z = 400; }
  BS.step(st, 0.2);
  const cell = (x, z) => BS.fowCellIJ(st.fow, x, z);
  let v = BS.computeVisibility(st);
  ok(v.vis[cell(e.x, e.z)] === 1, "enemy inside vision is currently visible");
  e.x = 0; e.z = 20; // 80 away: outside vision
  v = BS.computeVisibility(st);
  ok(v.vis[cell(e.x, e.z)] === 0, "enemy outside vision is not currently visible");
  ok(st.fow.exp[cell(0, 40)] === 1, "explored flag persists after leaving vision");
}
{
  // soft fog edge: seen[] is fractional across the feather band
  const st = BS.newMatch(57, 0);
  const s = st.ships[0]; // sol, vision 65, feather 12
  s.x = 0; s.z = 100; s.heading = Math.PI; s.speed = 0; s.order = { type: "hold" };
  for (const o of st.ships) if (o !== s) { o.x = 400; o.z = 400; }
  BS.step(st, 0.2);
  const v = BS.computeVisibility(st);
  const cell = (x, z) => BS.fowCellIJ(st.fow, x, z);
  ok(v.seen[cell(0, 100)] === 1, "seen=1 at the ship's own cell");
  const edge = v.seen[cell(0, 30)]; // d~70: inside the feather band (53..77)
  ok(edge > 0.05 && edge < 0.6, "seen is fractional at the vision edge", "seen=" + edge.toFixed(3));
  ok(v.vis[cell(0, 30)] === 0, "binary vis still 0 outside the vision radius");
  ok(st.fow.exp[cell(0, 30)] === 1, "feather band stamps explored (seen>0.02)");
  ok(v.seen[cell(0, 10)] === 0, "seen=0 well outside vision+feather");
}

console.log("== A* pathfinding around land ==");
{
  // island 1 sits at (-70*S, 45*S) r=11*S; sail a sloop straight across it.
  const S = BS.MAP_S;
  const ix = -70 * S, iz = 45 * S, ir = 11 * S;
  const st = BS.newMatch(7, 0); // wind toward +z: east-west legs are beam reach
  const s = st.ships[4]; // sloop
  s.x = ix - 80; s.z = iz; s.heading = Math.PI / 2; s.speed = 0; s.order = { type: "hold" };
  st.ships.forEach(x => { if (x !== s && x.side === "E") { x.x = 400; x.z = 400; } });
  st.batteries.forEach(b => { b.x = 400; b.z = 400; });
  ok(BS.inLand(ix, iz), "test setup: island center is land");
  ok(!BS.segWalkable(s.x, s.z, ix + 80, iz), "test setup: straight line crosses the island");
  BS.orderMove(st, [s.id], ix + 80, iz, false);
  ok(s.path.length > 0, "path built across the island");
  ok(s.path.every(p => !BS.inLand(p[0], p[1])), "no waypoint is on land", "legs=" + s.path.length);
  let bad = 0, t = 0;
  while (t < 300 && BS.dist(s.x, s.z, ix + 80, iz) > 15) { BS.step(st, 0.2); t += 0.2; if (BS.inLand(s.x, s.z)) bad++; }
  ok(BS.dist(s.x, s.z, ix + 80, iz) <= 15, "ship routed around the island and arrived", "t=" + t.toFixed(0) + "s");
  ok(bad === 0, "ship never entered land en route");
}
{
  // land destination clamps to the nearest water: (100,-100) is mainland
  // just east of the bay; the ship should end up at the bay shore, not beach.
  const st = BS.newMatch(8, 0);
  const s = st.ships[4];
  s.x = 150; s.z = 0; s.heading = 0; s.speed = 0; s.order = { type: "hold" };
  st.ships.forEach(x => { if (x !== s && x.side === "E") { x.x = 400; x.z = 400; } });
  st.batteries.forEach(b => { b.x = 400; b.z = 400; });
  ok(BS.inLand(100, -100), "test setup: (100,-100) is land");
  BS.orderMove(st, [s.id], 100, -100, false);
  const last = s.path[s.path.length - 1];
  ok(!BS.inLand(last[0], last[1]), "destination clamped off land to water",
     "clamped=(" + last[0].toFixed(0) + "," + last[1].toFixed(0) + ")");
  ok(BS.dist(last[0], last[1], 100, -100) < 120, "clamped point is near the requested target");
  let bad = 0, t = 0;
  while (t < 300 && BS.dist(s.x, s.z, last[0], last[1]) > 15) { BS.step(st, 0.2); t += 0.2; if (BS.inLand(s.x, s.z)) bad++; }
  ok(BS.dist(s.x, s.z, last[0], last[1]) <= 15, "ship reached the clamped shore point");
  ok(bad === 0, "ship never entered land going to a land target");
}

console.log("== land-aware tacking (2026-10-08) ==");
// Simulate until the ship gets within 15 of (tx,tz); returns {t, landHits}.
function simToArrive(st, s, tx, tz) {
  let t = 0, landHits = 0; const dt = 0.2;
  while (t < 900 && BS.dist(s.x, s.z, tx, tz) > 15) {
    BS.step(st, dt); t += dt;
    if (BS.inLand(s.x, s.z)) landHits++;
  }
  return { t, landHits };
}
function clearSetup(st, s) {
  st.ships.forEach(x => { if (x !== s && x.side === "E") { x.x = 400; x.z = 400; } });
  st.batteries.forEach(b => { b.x = 400; b.z = 400; });
}
// The router's guarantee: no waypoint on land, no leg crossing land.
// (Tack-generated points additionally keep a 6u clearance margin, but
// direct-sail legs may pass near a shore without crossing it — walkable is
// the exact property the sim's slide collision needs.)
function pathClearOfLand(sx, sz, path) {
  if (!path.every(p => !BS.inLand(p[0], p[1]))) return "waypoint-on-land";
  let prev = [sx, sz];
  for (const p of path) {
    if (!BS.segWalkable(prev[0], prev[1], p[0], p[1])) return "leg-crosses-land";
    prev = p;
  }
  return null;
}
{
  // Test 1: dead-upwind course past island 1 — the straight line goes right
  // through it, so the router must A* around and tack in open water only.
  const S = BS.MAP_S;
  const ix = -70 * S, iz = 45 * S; // (-221.4, 142.3), r ~= 34.8
  const st = BS.newMatch(7, 0); // wind toward +z; upwind = -z
  const s = st.ships[4]; // sloop
  s.x = ix - 90; s.z = iz + 130; s.heading = Math.PI; s.speed = 0; s.order = { type: "hold" };
  clearSetup(st, s);
  const tx = ix + 90, tz = iz - 130;
  ok(!BS.segWalkable(s.x, s.z, tx, tz), "setup: straight line crosses the island");
  BS.orderMove(st, [s.id], tx, tz, false);
  ok(s.path.length > 3, "tacking path built past the island", "legs=" + s.path.length);
  ok(pathClearOfLand(s.x, s.z, s.path) === null, "no waypoint on land, no leg crosses land");
  const r = simToArrive(st, s, tx, tz);
  ok(BS.dist(s.x, s.z, tx, tz) <= 15, "ship tacked past the island and arrived", "t=" + r.t.toFixed(0) + "s");
  ok(r.landHits === 0, "ship never entered land en route");
}
{
  // Test 2: dead-upwind approach into the mainland bay (0,300) -> (0,-100).
  // The bay is 158u wide; tack points must dodge the headlands.
  const st = BS.newMatch(21, 0); // wind toward +z
  const s = st.ships[4];
  s.x = 0; s.z = 300; s.heading = Math.PI; s.speed = 0; s.order = { type: "hold" };
  clearSetup(st, s);
  ok(!BS.inLand(0, -100), "setup: (0,-100) is water inside the bay");
  BS.orderMove(st, [s.id], 0, -100, false);
  ok(s.path.length > 3, "upwind bay approach builds a tacking path", "legs=" + s.path.length);
  ok(pathClearOfLand(s.x, s.z, s.path) === null, "no bay tack waypoint on land, no leg crosses land");
  const r = simToArrive(st, s, 0, -100);
  ok(BS.dist(s.x, s.z, 0, -100) <= 15, "ship worked upwind into the bay", "t=" + r.t.toFixed(0) + "s");
  ok(r.landHits === 0, "ship never entered land working into the bay");
}
{
  // Test 3: mirror tack — dead-upwind course hugging island 1's east shore;
  // the west (+45°) tack point is ON the island, so the router must take the
  // east mirror even though the tie-break prefers west.
  const S = BS.MAP_S;
  const ix = -70 * S, iz = 45 * S;
  const st = BS.newMatch(33, 0);
  const s = st.ships[4];
  const sx0 = ix + 42, sz0 = iz + 40;
  s.x = sx0; s.z = sz0; s.heading = Math.PI; s.speed = 0; s.order = { type: "hold" };
  clearSetup(st, s);
  const tx = ix + 42, tz = iz - 100;
  ok(BS.segWalkable(s.x, s.z, tx, tz), "setup: straight course is water (no A* needed)");
  BS.orderMove(st, [s.id], tx, tz, false);
  const P = s.path;
  ok(P.length > 1, "mirror-tack path built", "legs=" + P.length);
  ok(P[0][0] > sx0, "first tack went EAST (mirror): west point was on the island",
     "p0=(" + P[0][0].toFixed(1) + "," + P[0][1].toFixed(1) + ")");
  ok(pathClearOfLand(sx0, sz0, P) === null, "no mirror-tack waypoint on land, no leg crosses land");
  const r = simToArrive(st, s, tx, tz);
  ok(BS.dist(s.x, s.z, tx, tz) <= 15, "ship arrived via mirror tacks", "t=" + r.t.toFixed(0) + "s");
  ok(r.landHits === 0, "ship never entered land on mirror tacks");
}
{
  // Test 4: tight water — dead-upwind destination deep in the bay notch.
  // Short-tack creep must get the ship there without landing a point on land.
  const st = BS.newMatch(44, 0);
  const s = st.ships[4];
  s.x = 0; s.z = 60; s.heading = Math.PI; s.speed = 0; s.order = { type: "hold" };
  clearSetup(st, s);
  ok(!BS.inLand(0, -150), "setup: (0,-150) is water deep in the bay");
  BS.orderMove(st, [s.id], 0, -150, false);
  ok(pathClearOfLand(s.x, s.z, s.path) === null, "no tight-water waypoint on land, no leg crosses land",
     "legs=" + s.path.length);
  const r = simToArrive(st, s, 0, -150);
  ok(BS.dist(s.x, s.z, 0, -150) <= 15, "ship short-tacked deep into the bay", "t=" + r.t.toFixed(0) + "s");
  ok(r.landHits === 0, "ship never entered land in the tight bay");
}
{
  // Land-aware no-go edge (2026-10-08): ship beached on island 1's west
  // shore, bow pointing into the island, ordered dead upwind. The old
  // proximity-only edge rule kept picking the edge into the island while
  // moveShip zeroed its speed — the ship stalled forever. Now it must take
  // the clear edge and sail off.
  const S = BS.MAP_S;
  const ix = -70 * S, iz = 45 * S, ir = 11 * S;
  const st = BS.newMatch(55, 0); // wind toward +z
  const s = st.ships[4];
  s.x = ix - ir - 1; s.z = iz; s.heading = Math.PI / 2; s.speed = 0; s.order = { type: "hold" };
  clearSetup(st, s);
  ok(!BS.inLand(s.x, s.z), "setup: ship starts just off the west shore");
  BS.orderMove(st, [s.id], s.x, s.z - 120, false); // dead upwind
  stepFor(st, 60);
  ok(BS.dist(s.x, s.z, ix, iz) > ir + 25, "beached ship turned away and cleared the island",
     "d=" + BS.dist(s.x, s.z, ix, iz).toFixed(1));
  ok(!BS.inLand(s.x, s.z), "still not on land after escaping");
}
{
  // waterClear / segClear sanity
  const S = BS.MAP_S;
  ok(BS.waterClear(0, 300), "open water is water-clear");
  ok(!BS.waterClear(-70 * S, 45 * S), "island center is not water-clear");
  ok(!BS.waterClear(-70 * S + 11 * S - 3, 45 * S), "point 3u inside island shore is not water-clear");
  ok(BS.waterClear(-70 * S + 11 * S + 9, 45 * S), "point 9u off the island shore is water-clear");
  ok(!BS.segClear(-70 * S - 60, 45 * S, -70 * S + 60, 45 * S), "segment through island is not clear");
  ok(BS.segClear(-70 * S - 60, 45 * S + 60, -70 * S + 60, 45 * S + 60), "segment past the island is clear");
  // the map edge is a coastline: bounds are part of the predicates now
  ok(BS.playable(1460, 100, 6) && !BS.playable(1510, 100, 6), "playable() enforces the square bounds");
  ok(!BS.waterClear(1510, 100), "tack point outside bounds is not water-clear");
  ok(BS.waterClear(1460, 100), "in-bounds open water is water-clear");
}

console.log("== square map bounds ==");
{
  // corners were unreachable under the old disc bound (dist 672 > 475)
  const st = BS.newMatch(9, 0);
  const s = st.ships[4];
  s.x = 400; s.z = 400; s.heading = 0; s.speed = 0; s.order = { type: "hold" };
  st.ships.forEach(x => { if (x !== s && x.side === "E") { x.x = -400; x.z = 400; } });
  st.batteries.forEach(b => { b.x = 400; b.z = -400; });
  BS.orderMove(st, [s.id], 1450, 1450, false);
  let bad = 0, t = 0;
  while (t < 300 && BS.dist(s.x, s.z, 1450, 1450) > 12) {
    BS.step(st, 0.2); t += 0.2;
    if (Math.abs(s.x) > 1500.5 || Math.abs(s.z) > 1500.5) bad++;
  }
  ok(BS.dist(s.x, s.z, 1450, 1450) <= 12, "corner (1450,1450) is reachable under square bounds");
  ok(bad === 0, "ship never left the playable square");
  // ordering outside the square clamps to the edge
  BS.orderMove(st, [s.id], 1600, 1600, false);
  const last = s.path[s.path.length - 1];
  ok(Math.abs(last[0]) <= 1500 && Math.abs(last[1]) <= 1500, "out-of-bounds target clamps into the square",
     "clamped=(" + last[0].toFixed(0) + "," + last[1].toFixed(0) + ")");
}

console.log("== map edge behaves like a coastline ==");
{
  // Slide-along: a ship driven into the edge slides along it (axis-separated,
  // like land) instead of stopping dead against the invisible wall.
  const st = BS.newMatch(61, 0);
  const s = st.ships[4]; // player sloop
  clearSetup(st, s);
  s.x = 1490; s.z = 100; s.heading = Math.PI / 4; s.speed = 10;
  s.order = { type: "move" }; s.path = [[1530, 300]]; // waypoint beyond the edge
  let maxAbs = 0, zMax = -1e9;
  for (let t = 0; t < 8; t += 0.2) {
    BS.step(st, 0.2);
    maxAbs = Math.max(maxAbs, Math.abs(s.x), Math.abs(s.z));
    zMax = Math.max(zMax, s.z);
  }
  ok(maxAbs <= 1500.5, "sliding ship never left the square", "max=" + maxAbs.toFixed(1));
  ok(zMax - 100 > 80, "ship slid along the edge instead of stopping", "dz=" + (zMax - 100).toFixed(0));
  ok(s.speed > 1, "ship kept way (no permanent stall)", "speed=" + s.speed.toFixed(1));
}
{
  // Edge tacking: dead-upwind course along the east edge. The old tacker
  // could place a tack point past the bounds (unreachable forever) and the
  // ship ground against the edge. Now the mirror tack is taken instead.
  const st = BS.newMatch(62, 0); // wind toward +z: course north is dead upwind
  const s = st.ships[4];
  clearSetup(st, s);
  s.x = 1485; s.z = 300; s.heading = Math.PI; s.speed = 0; s.order = { type: "hold" };
  BS.orderMove(st, [s.id], 1485, -100, false);
  ok(s.path.length > 0 && s.path.every(p => Math.abs(p[0]) <= 1500 && Math.abs(p[1]) <= 1500),
     "tacking path near the edge: every waypoint in-bounds", "legs=" + s.path.length);
  let bad = 0, t = 0;
  while (t < 600 && BS.dist(s.x, s.z, 1485, -100) > 12) {
    BS.step(st, 0.2); t += 0.2;
    if (Math.abs(s.x) > 1500.5 || Math.abs(s.z) > 1500.5) bad++;
  }
  ok(BS.dist(s.x, s.z, 1485, -100) <= 12, "edge-tacking ship arrives (no stall)", "t=" + t.toFixed(0));
  ok(bad === 0, "ship never left the square while tacking along the edge");
}
{
  // Out-of-bounds order: clamps in-bounds AND the ship arrives.
  const st = BS.newMatch(63, 0);
  const s = st.ships[4];
  clearSetup(st, s);
  s.x = 400; s.z = 100; s.heading = Math.PI / 2; s.speed = 0; s.order = { type: "hold" };
  BS.orderMove(st, [s.id], 1520, 100, false);
  const last = s.path[s.path.length - 1];
  ok(Math.abs(last[0]) <= 1500 && Math.abs(last[1]) <= 1500, "OOB order (1520,100) clamps in-bounds",
     "clamped=(" + last[0].toFixed(0) + "," + last[1].toFixed(0) + ")");
  let bad = 0, t = 0;
  while (t < 300 && BS.dist(s.x, s.z, last[0], last[1]) > 12) {
    BS.step(st, 0.2); t += 0.2;
    if (Math.abs(s.x) > 1500.5 || Math.abs(s.z) > 1500.5) bad++;
  }
  ok(BS.dist(s.x, s.z, last[0], last[1]) <= 12, "ship arrives at the clamped destination", "t=" + t.toFixed(0));
  ok(bad === 0, "ship never left the square en route");
}
{
  // Cross-map upwind route: no waypoint or leg leaves the square.
  const st = BS.newMatch(64, Math.PI / 2); // wind toward +x
  const path = BS.buildPath(-1400, 1400, 1400, -1400, st);
  ok(path.length > 0, "cross-map path builds");
  ok(path.every(p => Math.abs(p[0]) <= 1500 && Math.abs(p[1]) <= 1500), "no waypoint outside the square");
  let prev = [-1400, 1400], legBad = 0;
  for (const p of path) {
    const d = BS.dist(prev[0], prev[1], p[0], p[1]);
    const n = Math.max(1, Math.ceil(d / 20));
    for (let k = 0; k <= n; k++) {
      const x = prev[0] + (p[0] - prev[0]) * k / n, z = prev[1] + (p[1] - prev[1]) * k / n;
      if (Math.abs(x) > 1500.5 || Math.abs(z) > 1500.5) legBad++;
    }
    prev = p;
  }
  ok(legBad === 0, "no leg leaves the square");
}

console.log("== patrol order ==");
{
  const st = BS.newMatch(72, 0);
  const s = st.ships[4];
  s.x = 0; s.z = 60;
  BS.patrolAddPoint(st, [s.id], 30, 60);
  BS.patrolAddPoint(st, [s.id], 30, 90);
  BS.patrolAddPoint(st, [s.id], 0, 90);
  ok(s.order.type === "patrol" && s.order.points.length === 3, "patrol points recorded");
  const x0 = s.x, z0 = s.z;
  stepFor(st, 120);
  ok(BS.dist(x0, z0, s.x, s.z) > 10, "patrol ship moves along loop");
  ok(s.order.type === "patrol", "patrol loops (order persists)");
}
{
  // defeat: an invincible enemy sails ship-to-ship, sinking each hp=1 player
  // ship (teleported alongside, since the 10x map keeps them far apart).
  const st = BS.newMatch(61, 0);
  for (const s of st.ships) if (s.side === "P") { s.hp = 1; }
  const e = st.ships[6];
  e.hp = 1e9; // test rig: don't let return fire sink the attacker
  for (const p of st.ships.filter(s => s.side === "P")) {
    if (st.result) break;
    // park due south of the target: both broadside bearings (±90° off the
    // bearing) are then beam-reach and sailable, so the attacker always gets
    // its guns to bear regardless of the wind roll.
    e.x = p.x; e.z = p.z + 20; e.heading = 0;
    e.bside = 0; e.engage = false; e.ai.thinkT = 0;
    stepFor(st, 12);
    ok(!p.alive, "enemy sank " + p.cls + " id=" + p.id);
  }
  ok(st.result === "lost" || !st.ships.some(s => s.alive && s.side === "P"), "all player ships dead -> lost");
}

console.log("== attack engage hysteresis (2026-10-08, range scale 2026-10-09) ==");
{
  // Engage at 0.7x effective range, break off beyond 0.9x (frigate, range 70:
  // engage at d <= 49, break at d > 63). A single threshold made d jitter
  // across the line on successive steps, flip-flopping between chase and
  // broadside-hold so the ship spun in place.
  const st = BS.newMatch(4242, 0);
  const atk = st.ships.find(s => s.side === "P" && s.cls === "frigate"); // range 70
  const bat = st.batteries[0]; // stationary target
  bat.reload = 1e9; // don't shoot during the test
  for (const s of st.ships) if (s !== atk) { s.x = 400; s.z = 400; }
  BS.setGunsFree(st, st.ships.map(s => s.id), false);
  BS.orderAttack(st, [atk.id], bat.id);
  const setD = (d) => {
    atk.x = 0; atk.z = 0; atk.heading = 0; atk.speed = 0; atk.path = [];
    bat.x = 0; bat.z = -d;
    BS.step(st, 0.2); // single step: ship barely moves, d stays ~as set
  };
  setD(55); // 55 > 49: chase mode
  ok(atk.engage === false, "at d=55 (beyond 0.7x range) stays in chase mode");
  setD(40); // 40 <= 49: engage
  ok(atk.engage === true, "at d=40 engages broadside hold");
  setD(55); // back out: hysteresis keeps it engaged (55 <= 63)
  ok(atk.engage === true, "at d=55 still engaged (hysteresis, no flip-flop)");
  setD(75); // 75 > 63: break off
  ok(atk.engage === false, "at d=75 breaks off to chase");
}

console.log("== noenemy debug flag ==");
{
  const st = BS.newMatch(99, 0, { noEnemy: true });
  ok(!st.ships.some(s => s.side === "E"), "no enemy ships spawned with noEnemy");
  ok(st.batteries.length > 0 && st.batteries.every(b => b.inert), "batteries present but inert");
  const s = st.ships[0];
  BS.orderMove(st, [s.id], 0, 60, false);
  stepFor(st, 5);
  const hpBefore = s.hp;
  stepFor(st, 30);
  ok(s.hp === hpBefore, "inert batteries never fire");
}

console.log("== local wind field ==");
{
  ok(BS.SHIPCLS.sloop.speed === 28, "sloop speed 28 (2026-10-09 user verdict)");
  // symmetry: SHIPCLS is shared, so both sides get the faster sloop
  const st = BS.newMatch(7, 0);
  const ps = st.ships.find(s => s.side === "P" && s.cls === "sloop");
  const es = st.ships.find(s => s.side === "E" && s.cls === "sloop");
  ok(ps && es && BS.SHIPCLS[ps.cls].speed === BS.SHIPCLS[es.cls].speed, "sloop speed identical for both sides");
}
{
  // open water: windAt ≈ global within the noise bounds
  const st = BS.newMatch(7, 0); // global wind 0
  const w = BS.windAt(st, 200, 300); // far from all land
  ok(!BS.inLand(200, 300), "test setup: (200,300) is open water");
  ok(BS.angDiff(w.ang, 0) <= 0.16, "open-water direction ≈ global (±noise)",
     "off=" + BS.angNorm(w.ang).toFixed(3));
  ok(w.mag >= 0.91 && w.mag <= 1.09, "open-water magnitude ≈ 1 (±noise)",
     "mag=" + w.mag.toFixed(3));
}
{
  // lee of island 1: wind toward +x puts (-161,142) downwind of (-221,142) r≈35
  const st = BS.newMatch(7, Math.PI / 2);
  const w = BS.windAt(st, -161, 142);
  ok(!BS.inLand(-161, 142), "test setup: lee sample point is water");
  ok(w.mag < 0.8, "lee of an island: wind shadow strengthened (~0.68)",
     "mag=" + w.mag.toFixed(3));
  ok(w.mag >= 0.60, "lee magnitude respects the new lower clamp", "mag=" + w.mag.toFixed(3));
}
{
  // channel: harbor bay (0,-120) with wind blowing into the bay (toward -z)
  const st = BS.newMatch(7, Math.PI);
  const w = BS.windAt(st, 0, -120);
  ok(!BS.inLand(0, -120), "test setup: bay center is water");
  ok(w.mag > 1.5, "channel boost strengthened by user verdict (was ~1.48)",
     "mag=" + w.mag.toFixed(3));
  ok(w.mag <= 1.70, "channel magnitude respects the new upper clamp", "mag=" + w.mag.toFixed(3));
}
{
  // continuity: fine samples across a coast-crossing line, no jumps
  const st = BS.newMatch(7, Math.PI);
  let dA = 0, dM = 0, pa = null, pm = 0;
  for (let x = -200; x <= 200; x += 2) {
    const w = BS.windAt(st, x, -100);
    if (pa !== null) {
      dA = Math.max(dA, BS.angDiff(w.ang, pa));
      dM = Math.max(dM, Math.abs(w.mag - pm));
    }
    pa = w.ang; pm = w.mag;
  }
  ok(dA < 0.08 && dM < 0.08, "windAt is continuous across cells",
     "max dAng=" + dA.toFixed(4) + " dMag=" + dM.toFixed(4));
}
{
  // edges/corners never NaN; deterministic per seed
  const st = BS.newMatch(123, 0.7);
  for (const [x, z] of [[-1500, -1500], [1500, 1500], [-1500, 1500], [1500, -1500], [1500, 0], [0, -1500]]) {
    const w = BS.windAt(st, x, z);
    if (!(isFinite(w.ang) && isFinite(w.mag))) {
      ok(false, "windAt finite at edges/corners", "(" + x + "," + z + ")");
    }
  }
  ok(true, "windAt finite at edges/corners");
  const a = BS.newMatch(4242, 1.1), b = BS.newMatch(4242, 1.1);
  const qa = BS.windAt(a, 37, -211), qb = BS.windAt(b, 37, -211);
  ok(qa.ang === qb.ang && qa.mag === qb.mag, "wind field is deterministic per seed");
}
{
  // local wind actually steers ships: with global wind dead calm downwind,
  // a ship in a deflected coastal cell feels the local angle.
  const st = BS.newMatch(7, 0);
  const w = BS.windAt(st, 0, -40); // near the mainland's south coast
  ok(Math.abs(BS.angNorm(w.ang)) > 0.05, "coastal cell bends the wind off global",
     "off=" + BS.angNorm(w.ang).toFixed(3));
}

console.log("== expanded ocean (2026-10-08) ==");
{
  // New islands: in the water ring, >=200u from every existing feature.
  const feats = [];
  for (const s of [[0, 420], [-80, 440], [80, 440], [-150, 415], [150, 415]]) feats.push({ x: s[0], z: s[1], tag: "player spawn" });
  for (const s of [[0, 38], [-70, 57], [70, 57], [133, 95]]) feats.push({ x: s[0], z: s[1], tag: "enemy spawn" });
  for (const s of [[-142, 79], [142, 79], [0, -6]]) feats.push({ x: s[0], z: s[1], tag: "patrol" });
  feats.push({ x: 0, z: -120, tag: "zone" }, { x: -88, z: -76, tag: "battery" }, { x: 88, z: -76, tag: "battery" });
  feats.push({ x: -221, z: 142, tag: "island1" }, { x: 228, z: -16, tag: "island2" });
  const news = BS.ISLANDS.slice(2);
  ok(news.length === 4, "four new islands", "got=" + news.length);
  let ringOk = true, clearOk = true, clearMin = 1e9, clearTag = "";
  for (const isl of news) {
    // ring: inside ±1400 and at least one coord beyond the old ±480 water
    const inRing = Math.abs(isl.x) < 1400 && Math.abs(isl.z) < 1400 &&
                   (Math.abs(isl.x) > 480 || Math.abs(isl.z) > 480);
    if (!inRing) ringOk = false;
    for (const f of feats) {
      const d = BS.dist(isl.x, isl.z, f.x, f.z) - isl.r;
      if (d < clearMin) { clearMin = d; clearTag = f.tag; }
      if (d < 200) clearOk = false;
    }
    // also clear of the mainland polygon (sampled)
    for (let x = -411; x <= 411; x += 40) for (let z = -411; z <= -63; z += 40) {
      if (BS.pointInPoly(x, z, BS.LAND_POLY)) {
        const d = BS.dist(isl.x, isl.z, x, z) - isl.r;
        if (d < clearMin) { clearMin = d; clearTag = "mainland"; }
        if (d < 200) clearOk = false;
      }
    }
  }
  ok(ringOk, "new islands sit in the expanded water ring");
  ok(clearOk, "new islands >=200u clear of all existing features", "min=" + clearMin.toFixed(0) + " (" + clearTag + ")");
  ok(news.every(isl => !BS.inLand(isl.x + isl.r + 10, isl.z)), "water just outside each new island");
}
{
  // A* routes around the new east island (950,150,r42): no waypoint on land,
  // no leg crossing land, and the ship actually sails it.
  const st = BS.newMatch(80, Math.PI / 2); // wind toward +x: course east is downwind
  const s = st.ships[4];
  st.ships.forEach(x => { if (x.side === "E") { x.x = -1400; x.z = 1400; } });
  s.x = 700; s.z = 150; s.heading = Math.PI / 2; s.speed = 0; s.order = { type: "hold" };
  BS.orderMove(st, [s.id], 1200, 150, false);
  ok(s.path.length >= 1, "route around east island builds", "legs=" + s.path.length);
  let bad = 0, cross = 0, prev = [700, 150];
  for (const p of s.path) {
    if (BS.inLand(p[0], p[1])) bad++;
    if (!BS.segWalkable(prev[0], prev[1], p[0], p[1])) cross++;
    prev = p;
  }
  ok(bad === 0, "no waypoint on the new island");
  ok(cross === 0, "no leg crosses the new island");
  let entered = 0, t = 0;
  while (t < 300 && BS.dist(s.x, s.z, 1200, 150) > 12) {
    BS.step(st, 0.2); t += 0.2;
    if (BS.inLand(s.x, s.z)) entered++;
  }
  ok(BS.dist(s.x, s.z, 1200, 150) <= 12, "ship sails around the new island", "t=" + t.toFixed(0));
  ok(entered === 0, "ship never entered land en route");
}
{
  // windAt is defined and smooth at the far corner; lee exists behind a new island.
  const st = BS.newMatch(81, Math.PI / 2); // wind blowing toward +x (east)
  const w = BS.windAt(st, 1400, 1400);
  ok(isFinite(w.ang) && isFinite(w.mag) && w.mag >= 0.60 && w.mag <= 1.70,
     "windAt finite and clamped at (1400,1400)", "mag=" + w.mag.toFixed(3));
  const lee = BS.windAt(st, 1025, 150); // 75u downwind of east island (950,150,r42)
  ok(lee.mag < 1.0, "lee exists behind the new east island", "mag=" + lee.mag.toFixed(3));
  let dM = 0, pm = null;
  for (let x = 1300; x <= 1450; x += 5) {
    const m = BS.windAt(st, x, 1400).mag;
    if (pm !== null) dM = Math.max(dM, Math.abs(m - pm));
    pm = m;
  }
  ok(dM < 0.08, "wind field smooth at the far corner", "max dMag=" + dM.toFixed(4));
}
{
  // Fog works at far coords: a ship teleported to (1400,1400) explores there.
  const st = BS.newMatch(82, 0);
  const s = st.ships[4];
  s.x = 1400; s.z = 1400;
  const v = BS.computeVisibility(st);
  let any = 0;
  for (let k = 0; k < v.vis.length; k++) if (v.vis[k]) any++;
  ok(any > 0, "visibility stamps at far coords", "cells=" + any);
  for (let k = 0; k < 10; k++) BS.step(st, 0.2); // exp stamps during step()
  ok(st.fow.exp.some(e => e), "explored stamps at far coords");
}
{
  // A 2800u dead-upwind trek actually arrives (200-leg budget).
  const st = BS.newMatch(83, 0); // wind toward +z: course north (-z) is dead upwind
  const s = st.ships[4]; // sloop, speed 21
  st.ships.forEach(x => { if (x.side === "E") { x.x = -1400; x.z = 1400; } });
  s.x = 0; s.z = 1400; s.heading = Math.PI; s.speed = 0; s.order = { type: "hold" };
  BS.orderMove(st, [s.id], 0, -1400, false);
  ok(s.path.length > 50, "long upwind trek builds many tack legs", "legs=" + s.path.length);
  ok(s.path.every(p => !BS.inLand(p[0], p[1])), "no tack waypoint on land");
  const t = timeToArrive(st, s, 0, -1400);
  ok(BS.dist(s.x, s.z, 0, -1400) <= 12, "ship arrives after the long upwind trek", "t=" + t.toFixed(0));
}
{
  // playable() is false beyond the new bounds.
  ok(!BS.playable(1505, 0, 0), "playable false beyond 1500");
  ok(!BS.playable(0, -1505, 0), "playable false beyond -1500");
  ok(BS.playable(1450, 1450, 0), "playable true at (1450,1450)");
  ok(!BS.playable(950, 150, 0), "playable false on the new east island");
}

console.log("== shot types: split damage (2026-10-08) ==");
{
  const st = BS.newMatch(101, 0);
  const from = (shot) => ({ kind: "ship", cls: "frigate", shot });
  // chain: 35% hull + 120% rigging
  const t1 = st.ships[0]; const hp1 = t1.hp;
  BS.damageUnit(st, t1, 20, from("chain"));
  ok(t1.rigging === 76, "chain: 120% to rigging", "rig=" + t1.rigging);
  ok(Math.abs((hp1 - t1.hp) - 7) < 1e-9, "chain: 35% to hull", "dmg=" + (hp1 - t1.hp));
  ok(t1.crew === 100, "chain: crew untouched");
  // grape: 30% hull + 120% crew
  const t2 = st.ships[1]; const hp2 = t2.hp;
  BS.damageUnit(st, t2, 20, from("grape"));
  ok(t2.crew === 76, "grape: 120% to crew", "crew=" + t2.crew);
  ok(Math.abs((hp2 - t2.hp) - 6) < 1e-9, "grape: 30% to hull", "dmg=" + (hp2 - t2.hp));
  ok(t2.rigging === 100, "grape: rigging untouched");
  // round: hull only
  const t3 = st.ships[2]; const hp3 = t3.hp;
  BS.damageUnit(st, t3, 20, from("round"));
  ok(t3.hp === hp3 - 20 && t3.rigging === 100 && t3.crew === 100, "round: hull only");
  // batteries have no rigging/crew pools: chain still only hurts hull
  const bat = st.batteries[0]; const bhp = bat.hp;
  BS.damageUnit(st, bat, 20, from("chain"));
  ok(Math.abs((bhp - bat.hp) - 7) < 1e-9, "chain vs battery: 35% hull, no pools", "dmg=" + (bhp - bat.hp));
  // shot range multipliers
  ok(BS.effRangeOf({ kind: "ship", cls: "frigate", shot: "round" }) === 70, "round: full range");
  ok(BS.effRangeOf({ kind: "ship", cls: "frigate", shot: "chain" }) === 70 * 0.8, "chain: 0.8x range");
  ok(BS.effRangeOf({ kind: "ship", cls: "frigate", shot: "grape" }) === 70 * 0.55, "grape: 0.55x range");
  // setShot applies to a selection (groups)
  BS.setShot(st, [t1.id, t2.id], "grape");
  ok(t1.shot === "grape" && t2.shot === "grape" && t3.shot === "round", "setShot applies to given ids");
  BS.setShot(st, [t1.id], "banana");
  ok(t1.shot === "grape", "invalid shot type ignored");
}

console.log("== damage degrades capability (2026-10-08) ==");
{
  const st = BS.newMatch(102, 0);
  const s = st.ships[4];
  const f0 = BS.shipFactors(s);
  ok(f0.spd === 1 && f0.turn === 1 && f0.rld === 1 && f0.acc === 1, "undamaged: all factors 1");
  s.rigging = 0;
  const f1 = BS.shipFactors(s);
  ok(Math.abs(f1.spd - 0.55) < 1e-9, "dismasted: speed x0.55", "spd=" + f1.spd);
  ok(Math.abs(f1.turn - 0.6) < 1e-9, "dismasted: turn x0.6", "turn=" + f1.turn);
  s.crew = 0;
  const f2 = BS.shipFactors(s);
  ok(Math.abs(f2.rld - 1.8) < 1e-9, "no crew: reloads x1.8", "rld=" + f2.rld);
  ok(Math.abs(f2.acc - 0.65) < 1e-9, "no crew: accuracy x0.65", "acc=" + f2.acc);
}
{
  // behavioral: a dismasted sloop crawls downwind vs a fresh one
  const mk = (rig) => {
    const st = BS.newMatch(103, 0); // wind toward +z
    const s = st.ships[4];
    s.x = 0; s.z = 0; s.heading = 0; s.speed = 0; s.rigging = rig;
    st.ships.forEach(x => { if (x !== s) { x.x = 1400; x.z = 1400; x.gunsFree = false; } });
    st.batteries.forEach(b => { b.x = 1400; b.z = -1400; });
    return { st, s };
  };
  const a = mk(100), b = mk(0);
  BS.orderMove(a.st, [a.s.id], 0, 500, false);
  BS.orderMove(b.st, [b.s.id], 0, 500, false);
  stepFor(a.st, 10); stepFor(b.st, 10);
  ok(b.s.z < a.s.z * 0.7, "dismasted ship much slower downwind",
     "full=" + a.s.z.toFixed(0) + " dismasted=" + b.s.z.toFixed(0));
}
{
  // behavioral: depleted crew reloads slower
  const st = BS.newMatch(104, 0);
  const a = st.ships[4], b = st.ships[3];
  a.crew = 0; b.crew = 100;
  a.reloadL = 8; b.reloadL = 8;
  for (const s of st.ships) { s.order = { type: "hold" }; s.gunsFree = false; }
  stepFor(st, 4);
  ok(a.reloadL > b.reloadL + 1, "crewless ship reloads slower",
     "crew0=" + a.reloadL.toFixed(2) + " full=" + b.reloadL.toFixed(2));
}

console.log("== patience dial + perpendicularity (2026-10-09) ==");
{
  const st = BS.newMatch(105, 0);
  const a = st.ships[0]; // player sol, range 82, reload 12
  a.x = 0; a.z = 0; a.heading = 0; a.gunsFree = true;
  const e = st.ships[5];
  st.ships.forEach(s => { if (s !== a && s !== e) { s.x = 1400; s.z = 1400; } });
  st.batteries.forEach(b => { b.x = 1400; b.z = -1400; });
  // pure curves (invented 2026-10-09, tunable)
  ok(BS.patienceDmg(0) === 0.5, "patience 0 -> x0.5 damage (fast, weak)");
  ok(BS.patienceDmg(0.5) === 1.0, "patience 0.5 -> base damage");
  ok(BS.patienceDmg(1) === 1.5, "patience 1 -> x1.5 damage (slow, alpha)");
  const arc = BS.TUNE.broadsideArc;
  ok(Math.abs(BS.perpBonus(0) - 1.5) < 1e-9, "perpBonus x1.5 at exact perpendicular");
  ok(Math.abs(BS.perpBonus(arc) - 1.0) < 1e-9, "perpBonus x1.0 at the arc edge");
  ok(Math.abs(BS.perpBonus(arc / 2) - 1.25) < 1e-9, "perpBonus linear between");
  // NO withholding: a mediocre solution fires as soon as the cycle completes
  e.x = 60; e.z = 0; e.heading = 0; e.hp = e.maxHp; // d=60, broadside-on: hc~0.57
  a.reloadL = 0; a.reloadR = 0; a.patience = 0.6;
  st.events.length = 0;
  BS.step(st, 0.2);
  ok(st.events.some(ev => ev.k === "fire" && ev.id === a.id), "fires a mediocre solution when the cycle completes (no withholding)");
  // cycle durations: p=0 -> 0.5x, p=0.5 -> 1x, p=1 -> 1.5x class reload.
  // Target is due +x: only the R broadside bears (rel=+90°), so assert reloadR;
  // reloadL must stay 0 (per-broadside independence).
  for (const [p, mul] of [[0, 0.5], [0.5, 1.0], [1, 1.5]]) {
    a.patience = p; a.reloadL = 0; a.reloadR = 0; a.cycL = 1; a.cycR = 1;
    e.hp = e.maxHp; e.x = 60; e.z = 0;
    BS.step(st, 0.2);
    ok(Math.abs(a.reloadR - 12 * mul) < 1e-9,
       "patience " + p + " sets cycle " + mul + "x reload", "reloadR=" + a.reloadR);
    ok(a.reloadL === 0, "broadside without a solution stays loaded (patience " + p + ")");
  }
  // damage scales with patience: mean hull damage per hit at p=1 is 3x p=0
  // (1.5/0.5), same geometry -> same hc/aspect/range terms.
  const meanDmg = (p) => {
    const rng = BS.mulberry32(7);
    const shooter = { kind: "ship", cls: "sol", x: 0, z: 0, shot: "round", patience: p };
    const tgt = { kind: "ship", cls: "sol", x: 30, z: 0, heading: 0 };
    let sum = 0, n = 0;
    for (let i = 0; i < 4000; i++) {
      // replicate tryFireBroadside's dmgScale wiring for a dev=0 shot
      const r = BS.shotOutcome(rng, shooter, tgt, BS.patienceDmg(p) * BS.perpBonus(0));
      if (r.hit) { sum += r.dmg; n++; }
    }
    return sum / n;
  };
  const ratio = meanDmg(1) / meanDmg(0);
  ok(ratio > 2.7 && ratio < 3.3, "p=1 hits ~3x harder than p=0 (alpha vs chip)", "ratio=" + ratio.toFixed(2));
  // setPatience clamps + applies to groups
  BS.setPatience(st, [a.id], 9);
  ok(a.patience === 1, "patience clamps to 1.0");
  BS.setPatience(st, [a.id], -3);
  ok(a.patience === 0, "patience clamps to 0.0");
}

console.log("== repair at anchor (2026-10-08) ==");
{
  const st = BS.newMatch(106, 0);
  const s = st.ships[0]; // sol
  s.x = 0; s.z = 400; s.hp = 100; s.rigging = 50; s.crew = 50;
  BS.orderAnchor(st, [s.id]);
  for (const e of st.ships) if (e.side === "E") { e.x = 1400; e.z = -1400; e.order = { type: "hold" }; }
  for (const p of st.ships) if (p.side === "P" && p !== s) { p.x = 0; p.z = 420; p.order = { type: "hold" }; }
  stepFor(st, 2);
  ok(s.hp === 100 && !s.repairing, "no repair before the 3s grace", "hp=" + s.hp);
  stepFor(st, 2);
  ok(s.repairing && s.hp > 100, "repair starts after 3s unseen + anchored", "hp=" + s.hp.toFixed(1));
  ok(s.rigging > 50 && s.crew > 50, "rigging and crew repair too",
     "rig=" + s.rigging.toFixed(1) + " crew=" + s.crew.toFixed(1));
  const hpMid = s.hp;
  const e = st.ships[5];
  e.x = 0; e.z = 430; // 30u away: inside the sol's 65u vision
  stepFor(st, 2);
  ok(!s.repairing && s.repairT === 0, "sighting an enemy resets the grace period");
  ok(s.hp === hpMid, "no repair while threatened");
  // weighing anchor also resets
  e.x = 1400; e.z = -1400;
  stepFor(st, 11); // grace rebuilds, repairing resumes
  ok(s.repairing, "grace rebuilds after the threat leaves");
  BS.orderWeighAnchor(st, [s.id]);
  BS.step(st, 0.2);
  ok(!s.repairing && s.repairT === 0, "weighing anchor stops repairs");
}

console.log("== enemy doctrine AI (2026-10-08) ==");
{
  // GUARD: no threats -> the fleet holds station near the harbor.
  const st = BS.newMatch(201, 0);
  stepFor(st, 60);
  let held = true, nearest = 1e9;
  for (const e of st.ships) {
    if (e.side !== "E") continue;
    if (BS.dist(e.x, e.z, 0, -120) > 350) held = false;
    for (const p of st.ships) {
      if (p.side !== "P" || !p.alive) continue;
      nearest = Math.min(nearest, BS.dist(e.x, e.z, p.x, p.z));
    }
    ok(e.ai.stance === "GUARD", "enemy holds GUARD with no threat", "id=" + e.id + " stance=" + e.ai.stance);
  }
  ok(held, "enemy fleet holds station near the harbor");
  ok(nearest > 300, "nobody chased the idle player fleet", "nearest=" + nearest.toFixed(0));
}
{
  // PURSUE: bloodlust ship chases a damaged visible enemy; cool head holds.
  const st = BS.newMatch(202, 0);
  const e1 = st.ships[6], e2 = st.ships[7]; // enemy frigates
  e1.x = 0; e1.z = -100; e2.x = 60; e2.z = -100;
  e1.ai.bloodlust = 0.99; e2.ai.bloodlust = 0.0;
  const p = st.ships[1]; // player frigate
  p.x = 0; p.z = -40; p.hp = p.maxHp * 0.4; p.order = { type: "hold" };
  st.ships.forEach(s => { if (s !== e1 && s !== e2 && s !== p) { s.x = 1400; s.z = 1400; } });
  st.batteries.forEach(b => { b.x = 1400; b.z = -1400; });
  e1.ai.thinkT = 0; e2.ai.thinkT = 0;
  BS.step(st, 0.2);
  ok(e1.ai.stance === "PURSUE" && e1.ai.targetId === p.id, "bloodlust ship pursues the damaged enemy");
  ok(e2.ai.stance === "GUARD", "cool-headed ship holds station");
  // break-off: target escapes >600u past the goal
  p.x = 0; p.z = 700;
  e1.ai.thinkT = 0;
  BS.step(st, 0.2);
  ok(e1.ai.stance === "GUARD", "pursuit breaks off past 600u from the goal");
}
{
  // claims: 4 AI ships split 2-and-2 across two visible targets (no 4v1).
  const st = BS.newMatch(203, 0);
  const es = st.ships.filter(s => s.side === "E");
  es.forEach((e, i) => { e.x = -30 + i * 20; e.z = -60; e.ai.bloodlust = 0.0; e.ai.thinkT = 0; });
  const p1 = st.ships[0], p2 = st.ships[1];
  p1.x = 0; p1.z = -40; p1.order = { type: "hold" };
  p2.x = 40; p2.z = -40; p2.order = { type: "hold" };
  st.ships.forEach(s => { if (!es.includes(s) && s !== p1 && s !== p2) { s.x = 1400; s.z = 1400; } });
  st.batteries.forEach(b => { b.x = 1400; b.z = -1400; });
  BS.step(st, 0.3);
  const targets = es.map(e => e.ai.targetId);
  const distinct = new Set(targets.filter(id => id));
  ok(distinct.size >= 2, "claims spread 4 ships across 2+ targets", JSON.stringify(targets));
  ok(targets.every(id => !id || id === p1.id || id === p2.id), "all claimed targets are visible enemies");
  const c1 = targets.filter(id => id === p1.id).length;
  ok(c1 <= 2, "no more than 2 claimants per target at bloodlust 0", "p1 claims=" + c1);
}
{
  // (2026-10-09 user verdict: enemies never repair; cripples <10% hull get a
  // one-time flee roll, chance = 1 - bloodlust, routing to the goal area.)
  const st = BS.newMatch(204, 0);
  const e = st.ships[6]; // enemy frigate
  e.x = 0; e.z = -60; e.hp = e.maxHp * 0.09; e.ai.bloodlust = 0; // craven: always flees
  st.ships.forEach(s => { if (s !== e && s.side === "P") { s.x = 1400; s.z = 1400; } });
  st.batteries.forEach(b => { b.x = 1400; b.z = -1400; });
  e.ai.thinkT = 0;
  BS.step(st, 0.2);
  ok(e.ai.stance === "WITHDRAW", "crippled craven ship routs");
  ok(e.ai.targetId === 0, "routing ship drops its target");
  let t = 0;
  while (t < 90 && e.ai.stance === "WITHDRAW") { BS.step(st, 0.2); t += 0.2; }
  ok(e.ai.stance === "GUARD", "routing ship rejoins the defense at the goal", "t=" + t.toFixed(0));
  const hp0 = e.hp;
  stepFor(st, 10);
  ok(!e.repairing && e.hp <= hp0, "routed ship never repairs", "hp " + hp0.toFixed(1) + " -> " + e.hp.toFixed(1));
}
{
  // hothead (<10% hull, bloodlust 1) fights to the death: no rout, no repair.
  const st = BS.newMatch(214, 0);
  const e = st.ships[6];
  e.x = 0; e.z = -60; e.hp = e.maxHp * 0.09; e.ai.bloodlust = 1;
  st.ships.forEach(s => { if (s !== e && s.side === "P") { s.x = 1400; s.z = 1400; } });
  st.batteries.forEach(b => { b.x = 1400; b.z = -1400; });
  e.ai.thinkT = 0;
  stepFor(st, 10);
  ok(e.ai.stance !== "WITHDRAW", "hothead never routs");
  ok(e.ai.fleeDecided === true, "the flee roll happened exactly once");
}

console.log("== 60s doctrine sim: no beaching, no deathball, stances shift ==");
{
  const st = BS.newMatch(205, 0);
  const p = st.ships[1]; // player frigate probes the harbor
  p.x = 0; p.z = 100; p.heading = Math.PI; p.speed = 0;
  BS.orderMove(st, [p.id], 0, -100, false);
  st.ships.forEach(s => { if (s !== p) s.order = { type: "hold" }; });
  const stances = new Set();
  let beached = 0, maxClaims = 0;
  for (let t = 0; t < 120; t++) {
    BS.step(st, 0.5);
    const counts = {};
    for (const e of st.ships) {
      if (e.side !== "E" || !e.alive) continue;
      stances.add(e.ai.stance);
      if (BS.inLand(e.x, e.z)) beached++;
      if (e.ai.targetId) {
        counts[e.ai.targetId] = (counts[e.ai.targetId] || 0) + 1;
        maxClaims = Math.max(maxClaims, counts[e.ai.targetId]);
      }
    }
  }
  ok(stances.has("INTERCEPT") || stances.has("PURSUE"), "doctrine reacted to the probe",
     "stances=" + [...stances].join(","));
  ok(beached === 0, "no AI ship beached in 60s");
  ok(maxClaims <= 3, "claim coordination: at most 3 ships on one target (2 + a bloodlusty 3rd)",
     "maxClaims=" + maxClaims);
}

console.log("== turn rates + longer ranges + vision-gated fire (2026-10-08) ==");
{
  // class table (invented 2026-10-08, tunable): turns x0.7, ranges +25%
  ok(BS.SHIPCLS.sloop.turn === 0.81 && BS.SHIPCLS.frigate.turn === 0.56 &&
     BS.SHIPCLS.sol.turn === 0.39, "turn rates x0.7 across the board");
  ok(BS.SHIPCLS.sloop.range === 58 && BS.SHIPCLS.frigate.range === 70 &&
     BS.SHIPCLS.sol.range === 82, "base gun ranges +25%");
  ok(BS.TUNE.batteryRange === 98, "battery range +25%");
  ok(BS.effRangeOf({ kind: "ship", cls: "sol", shot: "chain" }) === 82 * 0.8, "chain on new sol base");
  ok(BS.effRangeOf({ kind: "ship", cls: "sol", shot: "grape" }) === 82 * 0.55, "grape on new sol base");
  // behavioral: a sloop at speed ordered directly astern turns at ~0.81 rad/s;
  // from rest it turns at the 20% anti-stall floor (way-dependent, 2026-10-09)
  const st = BS.newMatch(306, 0);
  st.wind = Math.PI / 2; // beam reach on the test course: no no-go falloff
  const s = st.ships[4]; // sloop
  s.x = 0; s.z = 0; s.heading = 0; s.speed = 21; s.order = { type: "hold" };
  st.ships.forEach(o => { if (o !== s) { o.x = 1400; o.z = 1400; } });
  st.batteries.forEach(b => { b.x = 1400; b.z = -1400; });
  BS.orderMove(st, [s.id], 0, -60, false); // directly astern: pure ~180° turn first
  const h0 = s.heading;
  BS.step(st, 2.0);
  const turned = Math.abs(BS.angDiff(s.heading, h0));
  ok(turned > 1.2 && turned < 1.9, "sloop at speed turns ~0.81 rad/s (1.6 rad in 2s)",
     "turned=" + turned.toFixed(2) + " rad");
}
{
  // vision gating: a sol (range 82, vision 65) holds fire at a 75u target
  const st = BS.newMatch(307, 0);
  const a = st.ships[0]; // player sol
  a.x = 0; a.z = 0; a.heading = 0; a.reloadR = 0; a.gunsFree = true;
  const e = st.ships[5];
  e.hp = e.maxHp; e.heading = 0; e.x = 75; e.z = 0; // abeam starboard, in range, beyond vision
  st.ships.forEach(s => { if (s !== a && s !== e) { s.x = 1400; s.z = 1400; } });
  st.batteries.forEach(b => { b.x = 1400; b.z = -1400; });
  st.events.length = 0;
  BS.step(st, 0.2);
  ok(!st.events.some(ev => ev.k === "fire" && ev.id === a.id),
     "sol holds fire at 75u: inside 82u range but beyond 65u vision");
}
{
  // frigate (range 70, vision 80) fires at 68u: inside both
  const st = BS.newMatch(308, 0);
  const f = st.ships.find(s => s.side === "P" && s.cls === "frigate");
  f.x = 0; f.z = 0; f.heading = 0; f.reloadR = 0; f.gunsFree = true;
  const e = st.ships[5];
  e.hp = e.maxHp; e.heading = 0; e.x = 68; e.z = 0; // inside 70u range and 80u vision: fires
  st.ships.forEach(s => { if (s !== f && s !== e) { s.x = 1400; s.z = 1400; } });
  st.batteries.forEach(b => { b.x = 1400; b.z = -1400; });
  st.events.length = 0;
  BS.step(st, 0.2);
  ok(st.events.some(ev => ev.k === "fire" && ev.id === f.id),
     "frigate fires at 68u: inside 70u range and 80u vision");
}
{
  // batteries are exempt from the vision gate (static, revealed once explored)
  const st = BS.newMatch(309, 0);
  const s = st.ships[4]; // player sloop
  s.x = 2; s.z = -76; s.hp = s.maxHp; // 90u from battery 0 at (-88,-76): in 98u range
  st.ships.forEach(x => { if (x !== s) { x.x = 1400; x.z = 1400; } });
  st.batteries[1].x = 1400; st.batteries[1].z = 1400; // silence the far battery
  st.batteries[0].reload = 0;
  st.events.length = 0;
  BS.step(st, 0.5);
  ok(st.events.some(ev => ev.k === "fire" && ev.side === "B"),
     "battery fires at 90u (exempt from vision gate)");
}

console.log("== perp wiring + readiness + turn rates (2026-10-09) ==");
{
  // wiring: tryFireBroadside applies perpBonus from the true bearing dev.
  // Player sol vs a pinned battery: exactly abeam (dev=0) vs arc edge.
  // Mean damage per HIT should differ by ~1.5x (1.5/1.0).
  const st = BS.newMatch(409, 0);
  const a = st.ships[0]; // sol, 10 guns, range 82
  a.x = 0; a.z = 0; a.heading = 0; a.gunsFree = true; a.patience = 0.5;
  const b = st.batteries[0];
  st.ships.forEach(s => { if (s !== a) { s.x = 4000; s.z = 4000; } });
  st.batteries.forEach(x => { if (x !== b) { x.x = 4000; x.z = -4000; } });
  b.reload = 1e9; // don't shoot back during measurement
  const meanPerHit = (bx, bz) => {
    b.x = bx; b.z = bz; b.hp = b.maxHp; b.alive = true;
    let sum = 0, n = 0;
    for (let i = 0; i < 60; i++) {
      st.events.length = 0;
      a.reloadR = 0;
      BS.step(st, 0.05);
      for (const ev of st.events) if (ev.k === "hit" && ev.id === b.id) { sum += ev.dmg; n++; }
    }
    return sum / n;
  };
  const m0 = meanPerHit(30, 0); // dev = 0
  const mE = meanPerHit(29.84, 3.12); // dev ~= arc (6 deg)
  const ratio = m0 / mE;
  ok(ratio > 1.35 && ratio < 1.65, "perpBonus wiring: abeam hits ~1.5x arc-edge hits", "ratio=" + ratio.toFixed(2));
  // 10 degrees off the beam: outside the 6-degree arc -> no firing at all
  b.x = 29.54; b.z = 5.24; b.hp = b.maxHp; b.alive = true; // bearing 80 deg
  a.reloadR = 0;
  st.events.length = 0;
  BS.step(st, 0.5);
  ok(!st.events.some(ev => ev.k === "fire" && ev.id === a.id), "no fire 10deg off beam (6deg arc)");
}

console.log("== dispersed cannons (2026-10-09) ==");
{
  // gunOffsets: even, centered, over 75% of hull length; n=1 -> [0]
  const sol = BS.SHIPCLS.sol; // 10 guns, len 19
  const offs = BS.gunOffsets(sol);
  ok(offs.length === 10, "sol has 10 gun offsets");
  ok(Math.abs(offs[0] + offs[9]) < 1e-9, "offsets centered", "offs[0]=" + offs[0].toFixed(3));
  ok(Math.abs(offs[9] - 0.375 * 19) < 1e-9, "span = 75% of hull length");
  let even = true;
  for (let i = 1; i < 9; i++) if (Math.abs((offs[i] - offs[i - 1]) - (offs[1] - offs[0])) > 1e-9) even = false;
  ok(even, "offsets evenly spaced");
  ok(JSON.stringify(BS.gunOffsets({ guns: 1, len: 11 })) === "[0]", "single gun -> [0]");
}
{
  // gunHitsTarget geometry. Firer at origin, heading 0 (bow = +z); R beam = +x.
  const st = BS.newMatch(500, 0);
  const a = st.ships[0]; // sol
  a.x = 0; a.z = 0; a.heading = 0;
  const t = st.ships[5]; // enemy frigate: len 15, beam 5.2
  const c = BS.SHIPCLS.sol;
  // perfect broadside-to-broadside at 40u: every gun bears (E = 7.5 > max |off| 7.125)
  t.x = 40; t.z = 0; t.heading = 0;
  const allHit = BS.gunOffsets(c).every(off => BS.gunHitsTarget(a, "R", off, t).hit);
  ok(allHit, "perfect broadside-to-broadside: all guns bear");
  // target shifted 10u toward the bow: stern guns' rays pass astern of her
  t.x = 40; t.z = 10;
  const gated = BS.gunOffsets(c).map(off => BS.gunHitsTarget(a, "R", off, t).hit);
  const nHit = gated.filter(Boolean).length;
  ok(nHit > 0 && nHit < c.guns, "lateral offset: some guns bear, stern guns miss", "hit=" + nHit + "/10");
  ok(!gated[0] && gated[9], "stern-most gun misses, bow-most gun hits");
  // bow-on target at 40u: only a beam-wide sliver (E = 2.6) bears
  t.x = 40; t.z = 0; t.heading = Math.PI / 2; // bow pointing at the firer
  const nBow = BS.gunOffsets(c).filter(off => BS.gunHitsTarget(a, "R", off, t).hit).length;
  ok(nBow >= 2 && nBow <= 5, "bow-on: only center guns bear", "hit=" + nBow + "/10");
  // battery target: E = 7
  const b = st.batteries[0];
  b.x = 40; b.z = 0; b.hp = b.maxHp; b.alive = true;
  const nBat = BS.gunOffsets(c).filter(off => BS.gunHitsTarget(a, "R", off, b).hit).length;
  ok(nBat === 8, "battery dead abeam: outer guns just miss (E=7 < 7.125)", "hit=" + nBat + "/10");
}
{
  // tryFireBroadside statistical: perfect setup ≈ guns × hc hits over seeds;
  // 6°-off at long range materially fewer. Counts "hit" events per broadside.
  const shots = (seed, tx, tz, thead) => {
    const st = BS.newMatch(seed, 0);
    const a = st.ships[0]; // sol, 10 guns
    a.x = 0; a.z = 0; a.heading = 0; a.gunsFree = true; a.patience = 0.5;
    a.order = { type: "hold" }; a.speed = 0;
    const t = st.ships[5]; // enemy frigate
    t.x = tx; t.z = tz; t.heading = thead; t.hp = t.maxHp; t.rigging = 100; t.crew = 100;
    st.ships.forEach(s => { if (s !== a && s !== t) { s.x = 4000; s.z = 4000; } });
    st.batteries.forEach(b => { b.x = 4000; b.z = -4000; });
    st.events.length = 0;
    a.reloadR = 0;
    BS.step(st, 0.05);
    return st.events.filter(ev => ev.k === "hit" && ev.id === t.id).length;
  };
  let sum = 0;
  const N = 40;
  for (let seed = 0; seed < N; seed++) sum += shots(600 + seed, 30, 0, 0);
  const mean = sum / N;
  // hc at 30u broadside-to-broadside ≈ 0.9 - falloff; expect ≈ 10 × hc
  ok(mean > 6 && mean <= 10, "perfect setup: ≈ guns×hc hits per broadside", "mean=" + mean.toFixed(2));
  let sumOff = 0;
  for (let seed = 0; seed < N; seed++) {
    // 6° off the beam at 70u (near max range 82): geometric gate + arc edge
    const d = 70, ang = Math.PI / 2 - 6 * Math.PI / 180;
    sumOff += shots(700 + seed, d * Math.sin(ang), d * Math.cos(ang), 0);
  }
  const meanOff = sumOff / N;
  ok(meanOff < mean * 0.7, "6°-off at long range: materially fewer hits", "mean=" + meanOff.toFixed(2) + " vs " + mean.toFixed(2));
}
{
  // fireReadiness = patience × MIN over broadsides of clamp(elapsed/cycle):
  // the bar is a fixed 0-100% scale; it climbs 0 → patience and turns full
  // green AT the patience level (the firing point). Least-ready broadside, so
  // a loaded-holding side can't pin it at full.
  const st = BS.newMatch(401, 0);
  const s = st.ships[0]; // sol, reload 12; default patience 0.6 -> cycle 13.2
  s.order = { type: "hold" };
  ok(Math.abs(BS.SHIPCLS.sol.reload * 1.1 - s.cycL) < 1e-9, "cycle init = reload*(0.5+0.6)");
  ok(Math.abs(BS.fireReadiness(st, s) - 0.6) < 1e-9, "loaded broadside => readiness = patience (0.6)");
  s.reloadL = 6.6; s.reloadR = 6.6; // half the 13.2 cycle elapsed, both sides
  ok(Math.abs(BS.fireReadiness(st, s) - 0.3) < 1e-9, "half cycle => 0.5 × patience = 0.3");
  s.patience = 1; s.reloadL = 18; s.reloadR = 18; s.cycL = 18; s.cycR = 18; // just fired at patience 1
  ok(BS.fireReadiness(st, s) === 0, "just fired => 0.0");
  s.reloadL = 0; s.reloadR = 0; // loaded and waiting at patience 1: bar reaches the top
  ok(BS.fireReadiness(st, s) === 1, "patience 1.0 loaded => 1.0 (full green at top)");
  s.patience = 0.6; // back to default: loaded => 0.6
  ok(Math.abs(BS.fireReadiness(st, s) - 0.6) < 1e-9, "patience 0.6 loaded => green at 60% of bar");
  // asymmetric: starboard loaded+holding must NOT pin the bar after port fired.
  s.patience = 1; s.reloadL = 18; s.reloadR = 0; // port just fired, starboard loaded
  ok(BS.fireReadiness(st, s) === 0, "one side fired => bar restarts at 0 despite other side loaded");
  s.reloadL = 9; // port half through its cycle
  ok(Math.abs(BS.fireReadiness(st, s) - 0.5) < 1e-9, "bar climbs with the cycling side");
  const dead = st.ships[1]; dead.alive = false;
  ok(BS.fireReadiness(st, dead) === 0, "dead ship => readiness 0");
}
{
  // range rings follow effRangeOf per shot type (game.js scales unit circles by this)
  const st = BS.newMatch(402, 0);
  const s = st.ships[4]; // player sloop, base range 58
  ok(BS.effRangeOf(s) === 58, "ring radius = base range on round shot");
  BS.setShot(st, [s.id], "chain");
  ok(BS.effRangeOf(s) === 58 * 0.8, "ring shrinks with chain shot");
  BS.setShot(st, [s.id], "grape");
  ok(Math.abs(BS.effRangeOf(s) - 58 * 0.55) < 1e-9, "ring shrinks with grape shot");
}
{
  // way-dependent turning (2026-10-09, invented/tunable: 0.2 floor, 0.6 band).
  // Stopped -> 20% turn (anti-stall); >=60% of class base speed -> full turn.
  const st = BS.newMatch(501, 0); // windOverride 0
  const s = st.ships[4]; // sloop: turn 0.81 rad/s, base speed 21
  const rateAt = (spd) => {
    s.heading = 0; s.x = 0; s.z = 0; s.speed = spd;
    BS.orderMove(st, [s.id], 100, 0, false); // waypoint due +x: wantH = 90deg off
    for (let i = 0; i < 20; i++) {
      s.speed = spd; s.x = 0; s.z = 0; // pin: isolate turning from translation
      BS.step(st, 0.05);
    }
    return BS.angNorm(s.heading) / 1.0; // rad/s over 1s
  };
  const r0 = rateAt(0);
  ok(r0 > 0.28 && r0 < 0.37, "stopped ship turns at ~40% (anti-stall floor)", "rate=" + r0.toFixed(3));
  const rFull = rateAt(0.4 * BS.SHIPCLS.sloop.speed); // 0.4 * class speed
  ok(rFull > 0.75 && rFull < 0.87, "at 40% base speed turns at ~full rate", "rate=" + rFull.toFixed(3));
  const rMax = rateAt(BS.SHIPCLS.sloop.speed);
  ok(rMax > 0.75 && rMax < 0.87, "at full speed turn rate clamps at 1.0x", "rate=" + rMax.toFixed(3));
}
{
  // hc=1.0 still reachable (hitChance unchanged): dead-astern rake at
  // hull-separation distance, per class pair.
  for (const [sc, tc] of [["frigate", "frigate"], ["sol", "frigate"], ["sloop", "sloop"]]) {
    const rs = BS.SHIPCLS[sc], rt = BS.SHIPCLS[tc];
    const dmin = rs.radius + rt.radius;
    const s = { kind: "ship", cls: sc, x: 0, z: -dmin, rigging: 100, crew: 100 };
    const t = { kind: "ship", cls: tc, x: 0, z: 0, heading: 0, rigging: 100, crew: 100 };
    ok(BS.hitChance(s, t) === 1, sc + " reaches hc=1.0 on " + tc + " stern at separation (" + dmin + "u)");
  }
}

console.log("== way-dependent turning + corner carving + irons glide (2026-10-09) ==");
{
  // (a) turn-rate curve via exported steerToward: 0.4x stopped, full at >=0.4x class speed.
  // (e) rotate-in-place still penalized: stationary 180 takes >=2x longer than at full way.
  const st = BS.newMatch(3001, 0);
  const s = st.ships[1]; // frigate: turn 0.56, base speed 11
  const wdir = st.wind;
  s.rigging = 100; s.crew = 100;
  function rateAt(spd) {
    s.x = 0; s.z = 800; s.heading = BS.angNorm(wdir + Math.PI); s.speed = spd;
    for (let i = 0; i < 10; i++) { s.speed = spd; BS.steerToward(st, s, 0.1, wdir, 1); }
    return Math.abs(BS.angDiff(BS.angNorm(wdir + Math.PI), s.heading)) / 1.0;
  }
  const base = BS.SHIPCLS.frigate.turn;
  const r0 = rateAt(0), rBand = rateAt(0.4 * 11), rFull = rateAt(11), rOver = rateAt(20);
  ok(Math.abs(r0 / base - 0.4) < 0.06, "stopped turn rate is 0.4x base", r0.toFixed(3) + " vs " + base);
  ok(Math.abs(rBand / base - 1.0) < 0.06, "full turn authority at 0.4x class speed", rBand.toFixed(3));
  ok(Math.abs(rOver - rFull) < 0.03, "turn rate clamps above the 0.4x band", rOver.toFixed(3));
  ok(rFull / r0 >= 2, "stationary 180 takes >=2x longer than at full way (rotate-in-place penalized)",
    (rFull / r0).toFixed(2) + "x");
}
{
  // (b) tack through irons: dead-upwind order, first tack turn keeps >=25% way (was wallowing to 0).
  const st = BS.newMatch(7, 0);
  const s = st.ships[4]; // sloop, base 21
  s.x = 0; s.z = 60; s.heading = 133 * Math.PI / 180; s.speed = 0.4 * 21; s.order = { type: "hold" };
  st.ships.forEach(x => { if (x !== s && x.side === "E") { x.x = 400; x.z = 400; } });
  st.batteries.forEach(b => { b.x = 400; b.z = 400; });
  BS.orderMove(st, [s.id], 0, -5, false);
  const L0 = s.path.length;
  let t = 0;
  while (t < 120 && s.path.length >= L0) { BS.step(st, 0.2); t += 0.2; }
  ok(s.path.length < L0, "tack: first tack point rounded");
  let minSpd = Infinity, t1 = 0, done = false;
  while (t1 < 120 && !done) {
    BS.step(st, 0.2); t1 += 0.2;
    minSpd = Math.min(minSpd, s.speed);
    if (!s.path.length) done = true;
    else {
      const b = BS.bearing(s.x, s.z, s.path[0][0], s.path[0][1]);
      if (Math.abs(BS.angDiff(b, s.heading)) < 25 * Math.PI / 180) done = true;
    }
  }
  ok(done, "tack: turn onto the new leg completes");
  ok(minSpd >= 0.25 * 21, "tack through irons keeps >=25% class speed (no wallow)", "min=" + minSpd.toFixed(2));
}
{
  // (c) upwind arrival does NOT regress vs the old curve (old bound: 47s).
  const st = BS.newMatch(7, 0);
  const s = st.ships[0];
  s.x = 0; s.z = 60; s.heading = Math.PI; s.speed = 0;
  st.ships.forEach(x => { if (x !== s && x.side === "E") { x.x = 120; x.z = 120; } });
  st.batteries.forEach(b => { b.x = 120; b.z = -120; });
  BS.orderMove(st, [s.id], 0, -5, false);
  let t = 0;
  while (t < 900 && BS.dist(s.x, s.z, 0, -5) > 10) { BS.step(st, 0.2); t += 0.2; }
  ok(t < 47, "upwind arrival within the old 47s bound", t.toFixed(0) + "s");
}
{
  // (d) corner carving: 90-degree waypoint pair, track stays wide and fast.
  const st = BS.newMatch(7, 0);
  const s = st.ships[4]; // sloop
  s.x = 0; s.z = 0; s.heading = 0; s.speed = 15; s.order = { type: "move" };
  s.path = [[0, 100], [100, 100]];
  st.ships.forEach(x => { if (x !== s && x.side === "E") { x.x = 400; x.z = 400; } });
  st.batteries.forEach(b => { b.x = 400; b.z = 400; });
  let minD = Infinity, spdAtMin = 0, t = 0;
  while (t < 60 && s.path.length) {
    BS.step(st, 0.1); t += 0.1;
    const d = BS.dist(s.x, s.z, 0, 100);
    if (d < minD) { minD = d; spdAtMin = s.speed; }
  }
  ok(minD >= 8, "carved corner: track stays >=8u from the waypoint", minD.toFixed(2) + "u");
  ok(spdAtMin >= 0.6 * 15, "carved corner: keeps >=60% entry speed at the corner", spdAtMin.toFixed(2));
}

{
  // guns held => +15% speed (gun crews work the sails)
  const st = BS.newMatch(7, 0);
  const s = st.ships[0];
  s.x = 0; s.z = 0; s.heading = 0; s.speed = 0;
  st.windF = null; // uniform wind for a clean measurement
  st.wind = Math.PI / 2; // beam reach: sailEff = 1
  BS.orderMove(st, [s.id], 0, 600);
  s.gunsFree = true;
  for (let t = 0; t < 40; t += 0.1) BS.step(st, 0.1);
  const freeSpd = s.speed;
  s.speed = 0; s.x = 0; s.z = 0; s.heading = 0; s.gunsFree = false;
  BS.orderMove(st, [s.id], 0, 600);
  for (let t = 0; t < 40; t += 0.1) BS.step(st, 0.1);
  const heldSpd = s.speed;
  ok(freeSpd > 1 && Math.abs(heldSpd / freeSpd - 1.15) < 0.03,
    "held guns give +15% speed", freeSpd.toFixed(2) + " -> " + heldSpd.toFixed(2));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
