/* BROADSIDE — three.js rendering + input + UI. Browser only. Uses global BS from logic.js. */
(() => {
"use strict";

/* ============================== helpers ============================== */
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
function canvasTex(size, draw) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  draw(cv.getContext("2d"), size);
  const t = new THREE.CanvasTexture(cv);
  t.encoding = THREE.sRGBEncoding;
  return t;
}

/* ============================== three setup ============================== */
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfdde6);
scene.fog = new THREE.Fog(0xcfdde6, 2500, 7000); // scaled for the expanded ocean (2026-10-08)

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 12000);

// Soft flat lighting (2026-10-08 user verdict): gentle face variation, no blowout.
const hemi = new THREE.HemisphereLight(0xcfe2ee, 0x39525f, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1da, 0.55);
sun.position.set(95, 150, 55);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -520; sun.shadow.camera.right = 520;
sun.shadow.camera.top = 520; sun.shadow.camera.bottom = -520;
sun.shadow.camera.near = 20; sun.shadow.camera.far = 1000;
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(sun.target); // required: the shadow box follows the camera target (below)
scene.add(new THREE.AmbientLight(0xffffff, 0.3));

/* ============================== water ============================== */
// Flat matte sea — near-gray with the slightest blue (2026-10-08 user verdict).
// Color tuned empirically: r147 legacy color mode makes the rig hot, so the
// material is much darker than the rendered target ~(172,182,190).
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(3400, 3400), // covers the expanded ocean (±1500) with margin
  new THREE.MeshLambertMaterial({ color: 0x444b51 })
);
water.rotation.x = -Math.PI / 2;
water.receiveShadow = true;
scene.add(water);

/* ============================== fog of war overlay ============================== */
// Canvas over world [-FOW_HALF,FOW_HALF]^2 (constants unified from BS —
// 2026-10-08), drawn as a flat plane above the masts.
// unexplored -> dense white (hides everything); explored but out of vision ->
// steel-blue veil (terrain shows through, ships don't); visible -> clear.
const FOG_N = BS.FOW_N, FOG_HALF = BS.FOW_HALF, FOG_WORLD = 2 * FOG_HALF;
const fogCanvas = document.createElement("canvas");
fogCanvas.width = fogCanvas.height = FOG_N;
const fogCtx = fogCanvas.getContext("2d");
const fogImg = fogCtx.createImageData(FOG_N, FOG_N);
const fogTex = new THREE.CanvasTexture(fogCanvas);
fogTex.magFilter = THREE.LinearFilter; // GPU bilinear smoothing: sub-cell
fogTex.minFilter = THREE.LinearFilter; // soft edges on the 512 canvas
fogTex.generateMipmaps = false;
const fogMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(FOG_WORLD, FOG_WORLD),
  new THREE.MeshBasicMaterial({ map: fogTex, transparent: true, depthWrite: false, fog: false })
);
fogMesh.rotation.x = -Math.PI / 2;
fogMesh.position.y = 30;
fogMesh.renderOrder = 20;
fogMesh.raycast = () => {}; // never intercept taps; pickWater raycasts the sea directly
scene.add(fogMesh);
function fowCellAt(x, z) {
  const i = Math.floor((x + FOG_HALF) / (2 * FOG_HALF) * FOG_N);
  const j = Math.floor((z + FOG_HALF) / (2 * FOG_HALF) * FOG_N);
  if (i < 0 || i >= FOG_N || j < 0 || j >= FOG_N) return -1;
  return j * FOG_N + i;
}
let visStamp = 0;
const expSoft = new Float32Array(FOG_N * FOG_N); // presentation-only soft explored edge
const seenSoft = new Float32Array(FOG_N * FOG_N); // presentation-only soft visible edge
function updateFog() {
  // Feathered fog (2026-10-08): BS.computeVisibility returns the binary
  // gameplay grid (vis) plus a soft seen[] field — 1 inside visionR-feather,
  // smoothstep-falling to 0 at visionR+feather. Alpha fades with (1-seen),
  // so the clear-disc edge glides with the ship instead of jumping in cell
  // steps; bilinear texture filtering smooths the rest. Runs every 0.1s so
  // the edge tracks the ship smoothly.
  const v = BS.computeVisibility(st);
  const vis = v.vis, seen = v.seen, exp = st.fow.exp;
  const d = fogImg.data;
  // soften the explored boundary (2026-10-09): exp is binary per 5.9u cell, which
  // made the white/veil edge look blocky. A 3x3 box blur gives a ~3-cell ramp;
  // GPU bilinear filtering smooths the rest. Presentation only — gameplay keeps
  // using the binary exp grid.
  for (let cy = 0; cy < FOG_N; cy++) {
    const y0 = Math.max(0, cy - 1) * FOG_N, y1 = Math.min(FOG_N - 1, cy + 1) * FOG_N;
    const yc = cy * FOG_N;
    for (let cx = 0; cx < FOG_N; cx++) {
      const x0 = Math.max(0, cx - 1), x1 = Math.min(FOG_N - 1, cx + 1);
      let sum = exp[y0 + x0] + exp[y0 + cx] + exp[y0 + x1] +
                exp[yc + x0] + exp[yc + cx] + exp[yc + x1] +
                exp[y1 + x0] + exp[y1 + cx] + exp[y1 + x1];
      expSoft[yc + cx] = sum / 9;
    }
  }
  // soften the visible edge too (2026-10-09): same 3x3 treatment as the
  // explored edge, so the veil->clear transition melts instead of stepping
  for (let cy = 0; cy < FOG_N; cy++) {
    const y0 = Math.max(0, cy - 1) * FOG_N, y1 = Math.min(FOG_N - 1, cy + 1) * FOG_N;
    const yc = cy * FOG_N;
    for (let cx = 0; cx < FOG_N; cx++) {
      const x0 = Math.max(0, cx - 1), x1 = Math.min(FOG_N - 1, cx + 1);
      let sum = seen[y0 + x0] + seen[y0 + cx] + seen[y0 + x1] +
                seen[yc + x0] + seen[yc + cx] + seen[yc + x1] +
                seen[y1 + x0] + seen[y1 + cx] + seen[y1 + x1];
      seenSoft[yc + cx] = sum / 9;
    }
  }
  for (let cy = 0; cy < FOG_N; cy++) {
    const base = cy * FOG_N;
    for (let cx = 0; cx < FOG_N; cx++) {
      const ci = base + cx, o = ci * 4;
      const s = seenSoft[ci], e = expSoft[ci];
      // white (unexplored) crossfades to the steel-blue veil (explored, unseen)
      // as e goes 0->1; both fade to clear as s goes 0->1
      d[o] = 135 + Math.round(120 * (1 - e));
      d[o + 1] = 155 + Math.round(100 * (1 - e));
      d[o + 2] = 175 + Math.round(80 * (1 - e));
      d[o + 3] = Math.round(245 * (1 - e) + 140 * e * (1 - s));
    }
  }
  fogCtx.putImageData(fogImg, 0, 0);
  fogTex.needsUpdate = true;
  visStamp++;
  // enemy SHIP meshes show only inside current player vision; their floating
  // bars (scene-level groups) must hide too, or they'd give away positions
  for (const s of st.ships) {
    if (s.side !== "E" || s.kind !== "ship") continue;
    const mesh = shipMeshes.get(s.id);
    if (!mesh || mesh.userData.sinking) continue;
    const ci = fowCellAt(s.x, s.z);
    const seenNow = s.alive && ci >= 0 && !!vis[ci];
    mesh.visible = seenNow;
    mesh.userData.fogVis = seenNow;
  }
  // enemy BATTERIES are structures: show once their cell is explored
  for (let bi = 0; bi < st.batteries.length; bi++) {
    const b = st.batteries[bi], bm = batteryMeshes[bi];
    if (!bm) continue;
    const ci = fowCellAt(b.x, b.z);
    const explored = ci >= 0 && !!exp[ci];
    bm.userData.explored = explored;
    if (b.alive) bm.visible = explored;
  }
}

/* ============================== land ============================== */
const marbleTex = canvasTex(256, (g, s) => {
  g.fillStyle = "#f4f1e8"; g.fillRect(0, 0, s, s);
  g.strokeStyle = "rgba(170,168,160,0.28)"; g.lineWidth = 1.4;
  for (let i = 0; i < 16; i++) {
    g.beginPath();
    let x = Math.random() * s, y = Math.random() * s;
    g.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += (Math.random() - 0.5) * 120; y += (Math.random() - 0.5) * 120;
      g.quadraticCurveTo(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 60, x, y);
    }
    g.stroke();
  }
});
marbleTex.wrapS = marbleTex.wrapT = THREE.RepeatWrapping;
const marbleMat = new THREE.MeshStandardMaterial({ map: marbleTex, roughness: 0.55, metalness: 0.04 });
const marbleDark = new THREE.MeshStandardMaterial({ color: 0xe3ded2, roughness: 0.7 });

function shapeFromXZ(poly) {
  const sh = new THREE.Shape();
  poly.forEach((p, i) => { i ? sh.lineTo(p[0], -p[1]) : sh.moveTo(p[0], -p[1]); });
  sh.closePath();
  return sh;
}
{
  const geo = new THREE.ExtrudeGeometry(shapeFromXZ(BS.LAND_POLY), {
    depth: 5, bevelEnabled: true, bevelThickness: 1.6, bevelSize: 1.6, bevelSegments: 2,
  });
  geo.rotateX(-Math.PI / 2);
  const land = new THREE.Mesh(geo, marbleMat);
  land.castShadow = land.receiveShadow = true;
  scene.add(land);
}
for (const isl of BS.ISLANDS) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(isl.r, isl.r * 1.18, 22, 22), marbleMat);
  m.position.set(isl.x, 3.8, isl.z);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
}

/* ---- fort: walls, towers, city ---- */
const fortGroup = new THREE.Group();
scene.add(fortGroup);
function wallRun(x1, z1, x2, z2) {
  const len = Math.hypot(x2 - x1, z2 - z1);
  const w = new THREE.Mesh(new THREE.BoxGeometry(len, 12, 7), marbleDark);
  w.position.set((x1 + x2) / 2, 12, (z1 + z2) / 2);
  w.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
  w.castShadow = w.receiveShadow = true;
  fortGroup.add(w);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(len, 2.2, 8.4), marbleMat);
  cap.position.set((x1 + x2) / 2, 18.9, (z1 + z2) / 2);
  cap.rotation.y = w.rotation.y;
  cap.castShadow = true;
  fortGroup.add(cap);
}
// bay walls follow the scaled harbor mouth (BS coords already scaled by MAP_S)
wallRun(79, -63, 79, -174);
wallRun(-79, -63, -79, -174);
wallRun(-79, -174, 79, -174);
// city: instanced white blocks on the land behind the bay
{
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const matA = new THREE.MeshStandardMaterial({ color: 0xf6f3ea, roughness: 0.8 });
  const matB = new THREE.MeshStandardMaterial({ color: 0xd9d5c7, roughness: 0.8 });
  const spots = [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let guard = 0;
  // city spreads over the scaled landmass behind the bay (invented density: 450 blocks)
  while (spots.length < 450 && guard++ < 12000) {
    const x = (rnd() * 2 - 1) * 354, z = -196 - rnd() * 190;
    if (Math.abs(x) < 108) continue; // keep the bay approach clear
    spots.push({ x, z, w: 9.5 + rnd() * 11, h: 8 + rnd() * 19, d: 9.5 + rnd() * 11 });
  }
  const mk = (list, mat) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const m4 = new THREE.Matrix4();
    list.forEach((sp, i) => {
      m4.makeScale(sp.w, sp.h, sp.d);
      m4.setPosition(sp.x, 6 + sp.h / 2, sp.z);
      im.setMatrixAt(i, m4);
    });
    im.castShadow = im.receiveShadow = true;
    fortGroup.add(im);
  };
  mk(spots.filter((_, i) => i % 2 === 0), matA);
  mk(spots.filter((_, i) => i % 2 === 1), matB);
}
// battery towers (visual) — logic batteries live in BS state. Sizes scaled
// with the map (x~3.16) so the towers keep their old proportions.
const batteryMeshes = [];
{
  const spots = BS.BATTERY_SPOTS;
  for (const sp of spots) {
    const g = new THREE.Group();
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(13, 15.5, 36, 12), marbleDark);
    tower.position.y = 18; tower.castShadow = tower.receiveShadow = true;
    g.add(tower);
    const gun = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.9, 15, 8),
      new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.5, metalness: 0.5 }));
    gun.rotation.z = Math.PI / 2 - 0.12;
    gun.position.set(0, 37.5, 7.5);
    gun.castShadow = true;
    g.add(gun);
    g.position.set(sp.x, 0, sp.z);
    g.userData.isBatteryVisual = true;
    // hp bar
    const bbar = new THREE.Group();
    const bbg = new THREE.Mesh(new THREE.PlaneGeometry(28, 3.5),
      new THREE.MeshBasicMaterial({ color: 0x10181d, transparent: true, opacity: 0.65, depthTest: false }));
    const bfg = new THREE.Mesh(new THREE.PlaneGeometry(28, 2.6),
      new THREE.MeshBasicMaterial({ color: 0xff6b5e, transparent: true, opacity: 0.95, depthTest: false }));
    bfg.position.z = 0.01;
    bbar.add(bbg); bbar.add(bfg);
    bbar.position.y = 48;
    bbar.visible = false;
    bbar.renderOrder = 5;
    g.add(bbar);
    g.userData.bar = bbar; g.userData.fg = bfg; g.userData.bg = bbg;
    fortGroup.add(g);
    batteryMeshes.push(g);
  }
}

/* ---- capture zone ring ---- */
const zoneGroup = new THREE.Group();
{
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(BS.ZONE.r - 2, BS.ZONE.r, 72),
    new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.5;
  zoneGroup.add(ring);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(BS.ZONE.r - 2, 48),
    new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.10, side: THREE.DoubleSide })
  );
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.4;
  zoneGroup.add(disc);
  zoneGroup.position.set(BS.ZONE.x, 0, BS.ZONE.z);
  scene.add(zoneGroup);
}

/* ============================== ships ============================== */
const SIDE_COLOR = { P: 0x07501a, E: 0x820a06 };
// ^ materials are much darker than the faction colors they render as
// (0x07501a renders ≈ 0x2f9e5f green, 0x820a06 renders ≈ 0xc23b2e red):
// r147 legacy color mode + the soft fill rig lifts everything, so the
// material must be dark for the main faces to read as one solid color.
// Single solid faction color (2026-10-08 user verdict): EVERY ship part —
// hull, waterline stripe, deck, stern castle, masts, yards, sails, bowsprit —
// renders in this one color. No emblems.
// Low-poly hull: a box with the bow (+x) vertices pulled toward the
// centerline, flat-shaded. Reads clearly as a sailing ship.
function taperedBox(len, h, beam, taper) {
  const g = new THREE.BoxGeometry(len, h, beam, 6, 1, 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = (x + len / 2) / len; // 0 stern → 1 bow
    if (t > 0.5) {
      const k = (t - 0.5) / 0.5;
      pos.setZ(i, pos.getZ(i) * (1 - Math.pow(k, 1.35) * taper));
    }
  }
  g.computeVertexNormals();
  return g;
}
function flatMat(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.02, flatShading: true });
}
const GROUP_COLORS = [0xffd34d, 0x4dd7ff, 0xb06bff, 0xff9a3d, 0x7dff6b];
const GROUP_CSS = ["#ffd34d", "#4dd7ff", "#b06bff", "#ff9a3d", "#7dff6b"];
function buildShipMesh(ship) {
  const c = BS.SHIPCLS[ship.cls], side = ship.side;
  const g = new THREE.Group();       // yaw + position
  const tilt = new THREE.Group();    // heel/pitch/bob
  g.add(tilt);
  const L = c.len, W = c.beam;
  const hullM = flatMat(SIDE_COLOR[side]);
  const sailM = new THREE.MeshStandardMaterial({
    color: SIDE_COLOR[side], side: THREE.DoubleSide, roughness: 0.85, flatShading: true,
  });
  const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); mesh.castShadow = true; tilt.add(mesh); return mesh; };
  // waterline stripe (same faction color, slightly wider than hull)
  add(new THREE.Mesh(taperedBox(L * 1.0, 0.8, W * 1.06, 0.9), hullM), 0, 0.55, 0);
  // hull — solid faction color
  add(new THREE.Mesh(taperedBox(L, 3.4, W, 0.95), hullM), 0, 2.2, 0);
  // gunwale band + deck (same color)
  add(new THREE.Mesh(taperedBox(L * 0.86, 0.55, W * 0.9, 0.9), hullM), -0.3, 4.1, 0);
  const deck = add(new THREE.Mesh(new THREE.BoxGeometry(L * 0.8, 0.3, W * 0.74), hullM), -0.3, 4.45, 0);
  deck.castShadow = false;
  // stern castle on bigger ships (same color)
  if (ship.cls !== "sloop") {
    add(new THREE.Mesh(new THREE.BoxGeometry(L * 0.24, 2.0, W * 0.66), hullM), -L * 0.33, 5.4, 0);
    add(new THREE.Mesh(new THREE.BoxGeometry(L * 0.26, 0.35, W * 0.7), hullM), -L * 0.33, 6.55, 0);
  }
  // bowsprit (same color)
  const bow = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 6, 6), hullM);
  bow.position.set(L / 2 + 1.8, 5.4, 0);
  bow.rotation.z = -1.02;
  tilt.add(bow);
  // masts (low-segment cylinders) + yards + sails (all same color)
  const mastH = { sloop: 12, frigate: 15, sol: 18 }[ship.cls];
  const mastXs = ship.cls === "sloop" ? [1.0] : ship.cls === "frigate" ? [-3.2, 3.4] : [-5.2, 0.2, 5.4];
  const SW = W * 2.0, SH = mastH * 0.42;
  for (const mx of mastXs) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, mastH, 6), hullM);
    mast.position.set(mx, 4.4 + mastH / 2, 0); mast.castShadow = true;
    tilt.add(mast);
    const sg = new THREE.PlaneGeometry(SW, SH, 6, 1);
    const pos = sg.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) / SW + 0.5;
      pos.setZ(i, Math.sin(u * Math.PI) * 1.1); // billow
    }
    sg.computeVertexNormals();
    const sail = new THREE.Mesh(sg, sailM);
    sail.rotation.y = Math.PI / 2; // span across the ship (local z)
    sail.position.set(mx + 0.5, 4.4 + mastH * 0.62, 0);
    sail.castShadow = true;
    tilt.add(sail);
    for (const yy of [4.4 + mastH * 0.62 - SH / 2, 4.4 + mastH * 0.62 + SH / 2]) {
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, SW * 1.04, 6), hullM);
      yard.rotation.x = Math.PI / 2;
      yard.position.set(mx + 0.5, yy, 0);
      tilt.add(yard);
    }
  }
  // selection ring (pale) + control-group ring (group color)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(W + 2.2, W + 3.2, 40),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.55;
  ring.visible = false;
  g.add(ring);
  const gring = new THREE.Mesh(
    new THREE.RingGeometry(W + 3.8, W + 4.9, 40),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
  );
  gring.rotation.x = -Math.PI / 2; gring.position.y = 0.5;
  gring.visible = false;
  g.add(gring);
  // horizontal readiness bar, floating above the ship (billboarded, scene level
  // so a plain camera-quaternion copy works). Track + fill + a yellow tick
  // marking the patience setting — the fill climbs to the tick and turns
  // green there. (2026-10-09: readiness moved here from the vertical bar.)
  const readyW = L * 0.95, readyY = 4.4 + mastH + 5;
  const rdG = new THREE.Group();
  const rdBg = new THREE.Mesh(new THREE.PlaneGeometry(readyW, 1.15),
    new THREE.MeshBasicMaterial({ color: 0x10181d, transparent: true, opacity: 0.65, depthTest: false }));
  const rdFgGeo = new THREE.PlaneGeometry(readyW, 0.8);
  rdFgGeo.translate(readyW / 2, 0, 0); // origin at left edge: scale.x grows rightward
  const rdFg = new THREE.Mesh(rdFgGeo,
    new THREE.MeshBasicMaterial({ color: 0xffcf5e, transparent: true, opacity: 0.95, depthTest: false }));
  rdFg.position.set(-readyW / 2, 0, 0.01);
  const rdTick = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 1.8),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.95, depthTest: false }));
  rdTick.position.z = 0.02;
  rdG.add(rdBg); rdG.add(rdFg); rdG.add(rdTick);
  rdG.renderOrder = 5;
  rdG.raycast = () => {}; rdBg.raycast = () => {}; rdFg.raycast = () => {}; rdTick.raycast = () => {};
  shipRoot.add(rdG);
  // debug range ring (unit circle, scaled to effRangeOf each frame)
  const rring = new THREE.LineLoop(rangeRingGeo, rangeRingMat[side]);
  rring.position.y = 1.5;
  rring.renderOrder = 24;
  rring.visible = false;
  rring.raycast = () => {}; // never intercept taps
  g.add(rring);

  g.userData = { shipId: ship.id, tilt, ring, gring, rring, rdG, rdFg, rdTick, readyW, readyY,
    phase: Math.random() * 7, sinking: 0 };
  return g;
}
const shipMeshes = new Map(); // id -> mesh
const shipRoot = new THREE.Group();
scene.add(shipRoot);

/* ---- debug range rings: one shared unit-circle geometry, faction materials.
   Each ship gets a LineLoop child scaled to its effective gun range every
   frame (so chain/grape shrink it live). Visible only with the debug overlay. */
const rangeRingGeo = (() => {
  const pts = [];
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
})();
const rangeRingMat = {
  P: new THREE.LineBasicMaterial({ color: 0x51ff7a, transparent: true, opacity: 0.6, depthTest: false }),
  E: new THREE.LineBasicMaterial({ color: 0xc23b2e, transparent: true, opacity: 0.3, depthTest: false }),
};

/* ============================== effects ============================== */
const puffTex = canvasTex(128, (g, s) => {
  const gr = g.createRadialGradient(s/2, s/2, 2, s/2, s/2, s/2);
  gr.addColorStop(0, "rgba(255,255,255,0.9)");
  gr.addColorStop(0.5, "rgba(255,255,255,0.35)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
});
const ringTex = canvasTex(128, (g, s) => {
  g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 7;
  g.beginPath(); g.arc(s/2, s/2, s/2 - 8, 0, 7); g.stroke();
});
const puffs = [];        // {spr, t, life, grow, fade0}
const projectiles = [];  // {mesh, t, dur, fx,fy,fz, tx,tz, kind}
const pendingFx = [];    // {t, fn} delayed visuals
function addPuff(x, y, z, opts) {
  const o = opts || {};
  const mat = new THREE.SpriteMaterial({
    map: o.ring ? ringTex : puffTex,
    color: o.color || 0xffffff, transparent: true,
    opacity: o.opacity !== undefined ? o.opacity : 0.85, depthWrite: false,
  });
  const spr = new THREE.Sprite(mat);
  const s0 = o.size || 6;
  spr.position.set(x, y, z);
  spr.scale.set(s0, s0, 1);
  if (o.flat) { spr.position.y = 0.5; }
  scene.add(spr);
  puffs.push({ spr, t: 0, life: o.life || 0.9, grow: o.grow || 14, flat: !!o.flat });
}
function addProjectile(fx, fz, tx, tz, big) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(big ? 0.7 : 0.45, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0x222226 }));
  scene.add(mesh);
  projectiles.push({
    mesh, t: 0, dur: 0.38,
    fx, fy: 3.2, fz, tx, ty: 2.2, tz,
  });
}
function updateFx(dt) {
  for (let i = pendingFx.length - 1; i >= 0; i--) {
    pendingFx[i].t -= dt;
    if (pendingFx[i].t <= 0) { pendingFx[i].fn(); pendingFx.splice(i, 1); }
  }
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i];
    p.t += dt;
    const k = p.t / p.life;
    if (k >= 1) { scene.remove(p.spr); p.spr.material.dispose(); puffs.splice(i, 1); continue; }
    const s = p.spr.scale.x + p.grow * dt;
    p.spr.scale.set(s, s, 1);
    p.spr.material.opacity = 0.85 * (1 - k);
    if (!p.flat) p.spr.position.y += dt * 2.5;
  }
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.t += dt;
    const k = Math.min(1, pr.t / pr.dur);
    pr.mesh.position.set(
      pr.fx + (pr.tx - pr.fx) * k,
      pr.fy + (pr.ty - pr.fy) * k + Math.sin(k * Math.PI) * 6,
      pr.fz + (pr.tz - pr.fz) * k
    );
    if (k >= 1) { scene.remove(pr.mesh); pr.mesh.geometry.dispose(); pr.mesh.material.dispose(); projectiles.splice(i, 1); }
  }
}

/* ============================== game state ============================== */
const windDeg = params.has("wind") ? parseFloat(params.get("wind")) * Math.PI / 180 : undefined;
const seed = params.has("seed") ? parseInt(params.get("seed"), 10) : (Math.random() * 1e9) | 0;
let st = BS.newMatch(seed, windDeg, { noEnemy: params.has("noenemy") });
if (params.has("noenemy")) {
  const badge = document.createElement("div");
  badge.textContent = "ENEMIES OFF — debug";
  badge.style.cssText = "position:fixed;top:64px;left:10px;z-index:30;background:#a33;color:#fff;font:11px system-ui;padding:4px 8px;border-radius:4px;pointer-events:none;";
  document.body.appendChild(badge);
}
for (const s of st.ships) {
  const mesh = buildShipMesh(s);
  mesh.userData.shipId = s.id;
  shipRoot.add(mesh);
  shipMeshes.set(s.id, mesh);
  // vertical pool bars (ALL ships — friendly and enemy): Hull / Rigging / Crew
  // floating beside the ship at y=20, billboarded. (2026-10-09: these replace
  // the old vertical readiness bar; readiness moved to the horizontal bar.)
  {
    const poolG = new THREE.Group();
    const defs = [
      { color: 0x6fe07f }, // hull
      { color: 0x5eb7ff }, // rigging
      { color: 0xffcf5e }, // crew
    ];
    const fills = [];
    defs.forEach((pd, i) => {
      const pbg = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 7.2),
        new THREE.MeshBasicMaterial({ color: 0x10181d, transparent: true, opacity: 0.6, depthTest: false }));
      const pfgGeo = new THREE.PlaneGeometry(0.85, 6.8);
      pfgGeo.translate(0, 3.4, 0); // origin at bottom-center: scale.y grows upward
      const pfg = new THREE.Mesh(pfgGeo,
        new THREE.MeshBasicMaterial({ color: pd.color, transparent: true, opacity: 0.95, depthTest: false }));
      pfg.position.set(0, -3.4, 0.01);
      const holder = new THREE.Group();
      holder.add(pbg); holder.add(pfg);
      holder.position.x = (i - 1) * 1.45;
      pbg.raycast = () => {}; pfg.raycast = () => {};
      poolG.add(holder);
      fills.push(pfg);
    });
    poolG.renderOrder = 6;
    poolG.raycast = () => {};
    shipRoot.add(poolG);
    mesh.userData.poolG = poolG;
    mesh.userData.poolFills = fills;
  }
}

let running = false;
let selection = [];      // selected player ship ids
let pendingOrder = null; // 'move' | 'attack' | 'patrol'
let simAcc = 0;
const SIM_DT = 1 / 60;

/* ============================== camera ============================== */
const camT = { x: 0, z: 420 }; // start over the fleet (spawns far south now)
let camDist = 300;
function updateCamera() {
  const y = camDist * 0.95, back = camDist * 0.72;
  camera.position.set(camT.x, y, camT.z + back);
  camera.lookAt(camT.x, 0, camT.z);
  // Shadow box follows the camera target (2026-10-08): the expanded ocean is
  // far bigger than the ±520 shadow box, so re-center it every frame to keep
  // shadows crisp wherever the player is looking.
  sun.position.set(camT.x + 95, 150, camT.z + 55);
  sun.target.position.set(camT.x, 0, camT.z);
  sun.target.updateMatrixWorld();
}
updateCamera();

/* ============================== input ============================== */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const pointers = new Map();
let downInfo = null; // {x, y, t, moved}
let pinchD0 = 0, pinchDist0 = 0;

function screenToNdc(x, y) {
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
}
function pickShip(x, y) {
  screenToNdc(x, y);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(shipRoot.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o && !(o.userData && o.userData.shipId)) o = o.parent;
    // skip ships hidden by fog of war (their group is set invisible)
    if (o && o.visible) {
      const s = BS.unitById(st, o.userData.shipId);
      if (s && s.alive && !o.userData.sinking) return s;
    }
  }
  return null;
}
function pickBattery(x, y) {
  screenToNdc(x, y);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(fortGroup.children, true);
  if (!hits.length) return null;
  // nearest alive enemy battery to the hit point (must be explored/visible)
  let best = null, bd = 1e9;
  const p = hits[0].point;
  for (let bi = 0; bi < st.batteries.length; bi++) {
    const b = st.batteries[bi];
    if (!b.alive || b.side !== "E") continue;
    if (batteryMeshes[bi] && !batteryMeshes[bi].visible) continue;
    const d = BS.dist(p.x, p.z, b.x, b.z);
    if (d < bd && d < 24) { bd = d; best = b; }
  }
  return best;
}
function pickWater(x, y) {
  screenToNdc(x, y);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(water, false);
  return hits.length ? hits[0].point : null;
}
function playerSelection() {
  return selection.map(id => BS.unitById(st, id)).filter(s => s && s.alive);
}
function issueTap(wx, wz, targetShip, targetBattery) {
  const sel = playerSelection();
  if (targetShip && targetShip.side === "P") {
    if (targetShip.group > 0) {
      // tapping a grouped ship selects the whole control group
      selection = BS.groupShips(st, targetShip.group);
      showHint("Group " + targetShip.group + " selected (" + selection.length + " ships)");
    } else {
      // tap selects ONLY this ship — replace the selection (no toggle).
      // Multi-select happens through control groups, not tap-accumulation.
      // (No hint: the selection ring + ship card already show the state.)
      selection = [targetShip.id];
    }
    pendingOrder = null;
    hideGroupFan();
    refreshButtons();
    return;
  }
  if (!sel.length) return;
  const tgt = targetShip || targetBattery;
  if (tgt && (targetShip ? targetShip.side === "E" : true)) {
    BS.orderAttack(st, selection.slice(), tgt.id);
    pendingOrder = null;
  } else if (pendingOrder === "patrol" || pendingOrder === "move" || !pendingOrder) {
    if (pendingOrder === "patrol") {
      BS.patrolAddPoint(st, selection.slice(), wx, wz);
      showHint("Patrol point added — tap more water, or Patrol again to finish");
      return; // stay in patrol mode
    }
    BS.orderMove(st, selection.slice(), wx, wz, pendingOrder === "attackmove");
    pendingOrder = null;
  } else if (pendingOrder === "attack") {
    // attack with no target: treat as attack-move to water
    BS.orderMove(st, selection.slice(), wx, wz, true);
    pendingOrder = null;
  }
  refreshButtons();
}
function onTap(x, y) {
  const s = pickShip(x, y);
  if (s) { issueTap(0, 0, s, null); return; }
  const b = pickBattery(x, y);
  const w = pickWater(x, y);
  if (b && playerSelection().length) { issueTap(0, 0, null, b); return; }
  if (w) issueTap(w.x, w.z, null, null);
}
canvas.addEventListener("pointerdown", e => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) downInfo = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
  if (pointers.size === 2) {
    const p = [...pointers.values()];
    pinchD0 = camDist;
    pinchDist0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  }
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", e => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 1 && downInfo) {
    if (Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y) > 10) downInfo.moved = true;
    if (downInfo.moved) {
      // drag to pan
      const wpp = (2 * camDist * Math.tan(camera.fov * Math.PI / 360)) / window.innerHeight;
      camT.x = BS.clamp(camT.x - dx * wpp, -1450, 1450);
      camT.z = BS.clamp(camT.z - dy * wpp / 0.8, -1450, 1450);
      updateCamera();
    }
  } else if (pointers.size === 2) {
    const q = [...pointers.values()];
    const d = Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y);
    if (pinchDist0 > 0) {
      camDist = BS.clamp(pinchD0 * pinchDist0 / Math.max(40, d), 80, 800);
      updateCamera();
    }
  }
});
function onLongPress(x, y) {
  // long-press on one of your ships: drop it from its control group, select just it
  const s = pickShip(x, y);
  if (s && s.side === "P") {
    if (s.group > 0) {
      const g = s.group;
      BS.leaveGroup(st, [s.id]);
      showHint("Removed from group " + g);
    }
    selection = [s.id];
    pendingOrder = null;
    hideGroupFan();
    refreshButtons();
  }
}
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size === 0 && downInfo) {
    const dt = performance.now() - downInfo.t;
    if (!downInfo.moved) {
      if (dt >= 500) onLongPress(e.clientX, e.clientY);
      else onTap(e.clientX, e.clientY);
    }
    downInfo = null;
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  camDist = BS.clamp(camDist * (1 + e.deltaY * 0.001), 80, 800);
  updateCamera();
}, { passive: false });
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
window.addEventListener("keydown", e => {
  if (e.key === "Escape") { pendingOrder = null; selection = []; refreshButtons(); }
});
document.addEventListener("gesturestart", e => e.preventDefault());
document.addEventListener("dblclick", e => e.preventDefault());

/* ============================== orders UI ============================== */
let hintTimer = 0;
function showHint(txt, ms) {
  const h = $("hint");
  h.textContent = txt;
  h.style.display = "block";
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.style.display = "none", ms || 2600);
}
function arm(name) {
  pendingOrder = pendingOrder === name ? null : name;
  if (pendingOrder === "patrol") showHint("Tap water to add patrol points — tap Patrol again to finish");
  if (pendingOrder === "move") showHint("Tap water to move there");
  if (pendingOrder === "attack") showHint("Tap an enemy ship or battery — or water for attack-move");
  refreshButtons();
}
function refreshButtons() {
  const sel = playerSelection();
  const has = sel.length > 0;
  for (const id of ["bMove", "bAttack", "bPatrol", "bHold", "bAnchor", "bGroup", "bGuns", "bShot"])
    $(id).disabled = !has;
  $("bMove").classList.toggle("armed", pendingOrder === "move");
  $("bAttack").classList.toggle("armed", pendingOrder === "attack");
  $("bPatrol").classList.toggle("armed", pendingOrder === "patrol");
  const anyAnchored = sel.some(s => s.order.type === "anchored");
  $("bAnchor").textContent = anyAnchored ? "Weigh ⚓" : "Anchor ⚓";
  const anyHold = sel.some(s => !s.gunsFree);
  $("bGuns").textContent = anyHold ? "Guns: Hold" : "Guns: Free";
  // gunnery doctrine: shot button shows the selection's shot
  // (or Mix), slider shows its patience. Applies to the whole selection.
  $("fireRange").disabled = !has;
  if (has) {
    const shots = new Set(sel.map(s => s.shot || "round"));
    const cap = w => w[0].toUpperCase() + w.slice(1);
    $("bShot").textContent = "Shot: " + (shots.size === 1 ? cap(sel[0].shot || "round") : "Mix");
    const fr = $("fireRange");
    if (document.activeElement !== fr) {
      const v = Math.round((sel[0].patience === undefined ? 0.6 : sel[0].patience) * 100);
      fr.value = v;
      $("firelabel").textContent = "Patience " + v + "%";
    }
  }
  // selection panel
  const panel = $("selpanel");
  if (!sel.length) { panel.style.display = "none"; return; }
  panel.style.display = "block";
  const setBar = (id, frac) => { $(id).style.width = (100 * Math.max(0, Math.min(1, frac))) + "%"; };
  if (sel.length === 1) {
    const s = sel[0], c = BS.SHIPCLS[s.cls];
    $("selname").textContent = c.name + (s.group > 0 ? " · G" + s.group : "");
    $("selname").style.color = s.group > 0 ? GROUP_CSS[s.group - 1] : "#fff";
    setBar("selhull", s.hp / s.maxHp);
    setBar("selrig", (s.rigging === undefined ? 100 : s.rigging) / 100);
    setBar("selcrew", (s.crew === undefined ? 100 : s.crew) / 100);
    $("selsub").textContent = orderText(s)
      + (s.repairing ? " · 🔧 repairing" : "")
      + (s.gunsFree ? "" : " · guns held");
  } else {
    const g0 = sel[0].group;
    const sameGroup = g0 > 0 && sel.every(s => s.group === g0);
    $("selname").textContent = sel.length + " ships" + (sameGroup ? " · Group " + g0 : "");
    $("selname").style.color = sameGroup ? GROUP_CSS[g0 - 1] : "#fff";
    const avg = f => sel.reduce((a, s) => a + f(s), 0) / sel.length;
    setBar("selhull", avg(s => s.hp / s.maxHp));
    setBar("selrig", avg(s => (s.rigging === undefined ? 100 : s.rigging) / 100));
    setBar("selcrew", avg(s => (s.crew === undefined ? 100 : s.crew) / 100));
    const nRepair = sel.filter(s => s.repairing).length;
    $("selsub").textContent = nRepair ? "🔧 repairing ×" + nRepair : orderText(sel[0]);
  }
}
function orderText(s) {
  const o = s.order;
  switch (o.type) {
    case "move": return "sailing ⛵";
    case "attackmove": return "attack-move";
    case "patrol": return "patrolling (" + (o.points ? o.points.length : 0) + " pts)";
    case "hold": return "holding position";
    case "anchored": return "⚓ anchored — capturing?";
    case "weighing": return "weighing anchor…";
    case "attack": return "attacking";
    default: return o.type;
  }
}
$("bMove").onclick = () => arm("move");
/* ---- control-group fan-out ---- */
function hideGroupFan() { $("groupfan").classList.add("hidden"); }
function toggleGroupFan() {
  const fan = $("groupfan");
  if (!playerSelection().length) { hideGroupFan(); return; }
  fan.classList.toggle("hidden");
}
document.querySelectorAll("#groupfan .gbtn[data-g]").forEach(btn => {
  btn.onclick = () => {
    const n = parseInt(btn.getAttribute("data-g"), 10);
    BS.setGroup(st, selection.slice(), n);
    selection = BS.groupShips(st, n); // select the whole group immediately
    showHint("Group " + n + " selected (" + selection.length + " ships)");
    hideGroupFan();
    refreshButtons();
  };
});
$("gUngroup").onclick = () => {
  BS.leaveGroup(st, selection.slice());
  showHint("Removed from control groups");
  hideGroupFan();
  refreshButtons();
};
$("bAttack").onclick = () => arm("attack");
$("bPatrol").onclick = () => arm("patrol");
$("bHold").onclick = () => { BS.orderHold(st, selection.slice()); pendingOrder = null; refreshButtons(); };
$("bAnchor").onclick = () => {
  const sel = playerSelection();
  if (sel.some(s => s.order.type === "anchored")) BS.orderWeighAnchor(st, selection.slice());
  else BS.orderAnchor(st, selection.slice());
  pendingOrder = null; refreshButtons();
};
$("bGroup").onclick = () => { toggleGroupFan(); pendingOrder = null; refreshButtons(); };
$("bGuns").onclick = () => {
  const sel = playerSelection();
  const toHold = !sel.some(s => !s.gunsFree);
  BS.setGunsFree(st, selection.slice(), !toHold);
  pendingOrder = null; refreshButtons();
};
// gunnery doctrine: shot button cycles Round -> Chain -> Grape
// for the whole selection; the slider sets patience (0% = double rate, half
// damage; 100% = 1.5x cycle, x1.5 damage). Both apply to control groups too.
const SHOT_CYCLE = ["round", "chain", "grape"];
$("bShot").onclick = () => {
  const sel = playerSelection();
  if (!sel.length) return;
  const cur = sel[0].shot || "round";
  const next = SHOT_CYCLE[(SHOT_CYCLE.indexOf(cur) + 1) % SHOT_CYCLE.length];
  BS.setShot(st, selection.slice(), next);
  const names = { round: "Round shot — full hull damage, full range", chain: "Chain shot — shreds rigging (slows them), 0.8× range", grape: "Grape shot — shreds crew (slower reloads), 0.55× range" };
  showHint(names[next]);
  pendingOrder = null; refreshButtons();
};
$("fireRange").oninput = (e) => {
  const v = parseInt(e.target.value, 10);
  $("firelabel").textContent = "Patience " + v + "%";
  BS.setPatience(st, selection.slice(), v / 100);
};
refreshButtons();

/* ---- wind compass ---- */
{
  const cv = $("windcompass"), g = cv.getContext("2d");
  const S = 88, C = S / 2;
  g.clearRect(0, 0, S, S);
  g.strokeStyle = "rgba(255,255,255,0.85)"; g.lineWidth = 3;
  g.beginPath(); g.arc(C, C, C - 5, 0, 7); g.stroke();
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.font = "bold 13px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("N", C, 12); g.fillText("S", C, S - 12);
  g.fillText("W", 12, C); g.fillText("E", S - 12, C);
  // arrow points where the wind blows TOWARD. Screen up = -z (north).
  const a = st.wind;
  const ax = Math.sin(a), ay = Math.cos(a); // +y canvas = +z world (south)
  g.strokeStyle = "#ffd76a"; g.fillStyle = "#ffd76a"; g.lineWidth = 5;
  g.beginPath(); g.moveTo(C - ax * 10, C - ay * 10); g.lineTo(C + ax * 26, C + ay * 26); g.stroke();
  g.beginPath();
  const hx = C + ax * 26, hy = C + ay * 26;
  const pa = Math.atan2(ay, ax);
  g.moveTo(hx + Math.cos(pa) * 12, hy + Math.sin(pa) * 12);
  g.lineTo(hx + Math.cos(pa + 2.5) * 11, hy + Math.sin(pa + 2.5) * 11);
  g.lineTo(hx + Math.cos(pa - 2.5) * 11, hy + Math.sin(pa - 2.5) * 11);
  g.closePath(); g.fill();
}

/* ============================== wind debug overlay ============================== */
// 🌬️ button: one THREE.LineSegments (single draw call) with an arrow per wind
// grid square (120×120 on the expanded ocean): shaft along the local wind
// direction + 2 head barbs at the downwind end, hovering just above the
// water (y=2). Arrow length ∝
// magnitude normalized across the grid (min→shortest, max→longest);
// vertex colors pale blue (weak) → orange-red (strong). Grid is static per
// match, so this is built once. depthTest off + renderOrder above the fog:
// it's a debug overlay, it must stay visible.
let windOverlay = null;
function buildWindOverlay() {
  if (windOverlay) {
    scene.remove(windOverlay);
    windOverlay.geometry.dispose(); windOverlay.material.dispose();
  }
  const N = BS.WIND_N, CELL = (2 * BS.WIND_HALF) / N;
  const cells = [];
  let minM = 1e9, maxM = -1e9;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const cx = (i + 0.5) * CELL - BS.WIND_HALF, cz = (j + 0.5) * CELL - BS.WIND_HALF;
    const w = BS.windAt(st, cx, cz);
    cells.push({ cx, cz, ang: w.ang, mag: w.mag });
    if (w.mag < minM) minM = w.mag;
    if (w.mag > maxM) maxM = w.mag;
  }
  const pos = [], col = [];
  const cW = [0.72, 0.86, 0.95], cS = [1.0, 0.42, 0.22]; // weak pale blue → strong orange-red
  for (const c of cells) {
    const nrm = maxM > minM ? (c.mag - minM) / (maxM - minM) : 0.5;
    const len = (0.25 + 0.65 * nrm) * CELL; // 25%..90% of cell size
    const dx = Math.sin(c.ang), dz = Math.cos(c.ang);
    const tx = c.cx - dx * len / 2, tz = c.cz - dz * len / 2; // tail
    const hx = c.cx + dx * len / 2, hz = c.cz + dz * len / 2; // tip (downwind)
    const bl = len * 0.32;
    const b1a = c.ang + Math.PI - 0.45, b2a = c.ang + Math.PI + 0.45;
    const r = cW[0] + (cS[0] - cW[0]) * nrm;
    const g = cW[1] + (cS[1] - cW[1]) * nrm;
    const b = cW[2] + (cS[2] - cW[2]) * nrm;
    const Y = 2;
    pos.push(
      tx, Y, tz, hx, Y, hz,                                    // shaft
      hx, Y, hz, hx + Math.sin(b1a) * bl, Y, hz + Math.cos(b1a) * bl, // barb 1
      hx, Y, hz, hx + Math.sin(b2a) * bl, Y, hz + Math.cos(b2a) * bl  // barb 2
    );
    for (let k = 0; k < 6; k++) col.push(r, g, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false });
  windOverlay = new THREE.LineSegments(geo, mat);
  windOverlay.renderOrder = 25;
  windOverlay.raycast = () => {}; // never intercept taps
  windOverlay.visible = false;
  scene.add(windOverlay);
}
buildWindOverlay();
$("bWindDbg").onclick = () => {
  windOverlay.visible = !windOverlay.visible;
  $("bWindDbg").classList.toggle("armed", windOverlay.visible);
};

/* ============================== events -> visuals ============================== */
function drainEvents() {
  for (const ev of st.events) {
    if (ev.k === "fire") {
      addPuff(ev.x, 3.4, ev.z, { color: 0xfff2c0, size: 5, life: 0.22, grow: 26 });
      addPuff(ev.x, 4.2, ev.z, { color: 0x9aa2a8, size: 4, life: 1.4, grow: 10 });
      // per-gun broadside events (dispersed cannons): the flashes walk along
      // the hull, one ball per gun. The old single-event broadsides (and
      // batteries) keep their 2-4 ball spread.
      const n = ev.perGun ? 1 : (ev.side === "B" ? 1 : 2 + Math.floor(Math.random() * 3));
      for (let i = 0; i < n; i++) {
        const jx = (Math.random() - 0.5) * 8, jz = (Math.random() - 0.5) * 8;
        addProjectile(ev.x, ev.z, ev.tx + jx, ev.tz + jz, ev.side === "B");
      }
    } else if (ev.k === "hit") {
      pendingFx.push({
        t: 0.38, fn: () => {
          addPuff(ev.tx, 3.5, ev.tz, { color: 0xff9a3c, size: 7, life: 0.5, grow: 22 });
          addPuff(ev.tx, 5, ev.tz, { color: 0x555049, size: 6, life: 1.1, grow: 12 });
        },
      });
      if (ev.sunk && ev.id) { /* sinking handled by the 'sunk' event below */ }
    } else if (ev.k === "miss") {
      pendingFx.push({
        t: 0.38, fn: () => {
          addPuff(ev.tx + (Math.random() - 0.5) * 6, 0, ev.tz + (Math.random() - 0.5) * 6,
            { ring: true, color: 0xffffff, size: 4, life: 0.7, grow: 16, flat: true, opacity: 0.7 });
        },
      });
    } else if (ev.k === "sunk") {
      if (ev.kind === "ship") {
        const mesh = shipMeshes.get(ev.id);
        if (mesh) mesh.userData.sinking = 0.001;
      } else if (ev.kind === "battery") {
        addPuff(ev.x, 8, ev.z, { color: 0xff9a3c, size: 12, life: 1.2, grow: 26 });
        addPuff(ev.x, 10, ev.z, { color: 0x555049, size: 10, life: 1.6, grow: 18 });
        const bi = st.batteries.findIndex(b => b.id === ev.id);
        if (bi >= 0 && batteryMeshes[bi]) {
          batteryMeshes[bi].visible = false;
        }
      }
    } else if (ev.k === "win" || ev.k === "lose") {
      showEnd(ev.k === "win");
    }
  }
  st.events.length = 0;
}
function showEnd(won) {
  running = false;
  $("endEmoji").textContent = won ? "🏆" : "💀";
  $("endTitle").textContent = won ? "HARBOR TAKEN" : "FLEET LOST";
  $("endSub").textContent = won
    ? "The fort has struck its colors. The harbor is yours."
    : "Your fleet lies on the seabed. The harbor holds.";
  $("endOverlay").classList.remove("hidden");
}
$("startBtn").onclick = () => { $("startOverlay").classList.add("hidden"); running = true; musicStart(); };
$("againBtn").onclick = () => location.reload();
if (params.has("fast")) { $("startOverlay").classList.add("hidden"); running = true; }

/* ============================== per-frame sync ============================== */
const tmpV = new THREE.Vector3();
const RDY_YELLOW = new THREE.Color(0xffcf5e), RDY_GREEN = new THREE.Color(0x51ff7a);
function syncShips(t, dt) {
  for (const s of st.ships) {
    const mesh = shipMeshes.get(s.id);
    if (!mesh) continue;
    const u = mesh.userData;
    // floating bars (all ships): horizontal readiness above, vertical pools beside.
    // Hidden with the ship under fog of war (fogVis false for unseen enemies).
    {
      const show = s.alive && !u.sinking && u.fogVis !== false;
      // readiness: horizontal bar above the ship; fill climbs 0 -> patience,
      // full green at the yellow tick = the firing point
      u.rdG.visible = show;
      if (show) {
        const rd = BS.fireReadiness(st, s);
        const pat = s.patience === undefined ? 0.6 : s.patience;
        u.rdG.position.set(s.x, u.readyY, s.z);
        u.rdG.quaternion.copy(camera.quaternion);
        u.rdFg.scale.x = Math.max(0.001, rd);
        u.rdFg.material.color.copy(RDY_YELLOW).lerp(RDY_GREEN, pat > 0.01 ? Math.min(1, rd / pat) : 1);
        u.rdTick.position.x = -u.readyW / 2 + pat * u.readyW;
        u.rdFg.visible = u.rdTick.visible = s.gunsFree !== false; // held guns: hollow bar
      }
      // pools: Hull / Rigging / Crew vertical bars beside the ship
      u.poolG.visible = show;
      if (show) {
        u.poolG.position.set(s.x + 8, 20, s.z);
        u.poolG.quaternion.copy(camera.quaternion);
        u.poolFills[0].scale.y = Math.max(0.001, Math.max(0, s.hp / s.maxHp));
        u.poolFills[1].scale.y = Math.max(0.001, (s.rigging === undefined ? 100 : s.rigging) / 100);
        u.poolFills[2].scale.y = Math.max(0.001, (s.crew === undefined ? 100 : s.crew) / 100);
      }
    }
    // debug range ring: scale the unit circle to this ship's effective range
    if (u.rring) {
      const rr = BS.effRangeOf(s);
      u.rring.scale.set(rr, 1, rr);
      // range rings: always in the wind-debug overlay; otherwise for
      // selected player ships (so you can see your own reach when ordering)
      u.rring.visible = windOverlay.visible || (s.side === "P" && selection.includes(s.id));
    }
    if (u.sinking) {
      u.sinking += dt;
      const k = Math.min(1, u.sinking / 2.6);
      mesh.position.y = -k * 9;
      u.tilt.rotation.x = k * 0.7;
      u.tilt.rotation.z = k * 0.25;
      if (k >= 1) mesh.visible = false;
      continue;
    }
    if (!s.alive) { mesh.visible = false; continue; }
    mesh.position.set(s.x, Math.sin(t * 0.9 + u.phase) * 0.35, s.z);
    mesh.rotation.y = s.heading - Math.PI / 2;
    // heel: lean into turns + slight wind heel
    const heel = BS.clamp(-s.speed * 0.012, -0.09, 0.09) + Math.sin(t * 0.7 + u.phase) * 0.015;
    u.tilt.rotation.x += (heel - u.tilt.rotation.x) * Math.min(1, dt * 3);
    u.tilt.rotation.z = Math.sin(t * 0.8 + u.phase) * 0.012;
    // selection ring + control-group ring
    u.ring.visible = selection.includes(s.id);
    if (s.group > 0) {
      u.gring.visible = true;
      u.gring.material.color.setHex(GROUP_COLORS[s.group - 1]);
    } else {
      u.gring.visible = false;
    }
  }
  // battery hp bars
  for (let i = 0; i < st.batteries.length; i++) {
    const b = st.batteries[i], bm = batteryMeshes[i];
    if (!bm) continue;
    const pct = Math.max(0, b.hp / b.maxHp);
    bm.userData.bar.visible = b.alive && pct < 0.999 && bm.userData.explored !== false;
    bm.userData.fg.scale.x = pct;
    bm.userData.fg.position.x = -bm.userData.bg.geometry.parameters.width * (1 - pct) / 2;
    bm.userData.bar.quaternion.copy(camera.quaternion);
  }
}

/* ---- path / waypoint visuals for selection ---- */
const pathGroup = new THREE.Group();
scene.add(pathGroup);
const wpGeo = new THREE.SphereGeometry(4, 10, 10);
const wpMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });
function syncPaths() {
  while (pathGroup.children.length) {
    const c = pathGroup.children.pop();
    pathGroup.remove(c);
  }
  for (const id of selection) {
    const s = BS.unitById(st, id);
    if (!s || !s.alive || !s.path.length) continue;
    const pts = [new THREE.Vector3(s.x, 1, s.z)];
    for (const p of s.path) pts.push(new THREE.Vector3(p[0], 1, p[1]));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: 0xffe9a8, dashSize: 8, gapSize: 7, transparent: true, opacity: 0.8 })
    );
    line.computeLineDistances();
    pathGroup.add(line);
    for (const p of s.path) {
      const m = new THREE.Mesh(wpGeo, wpMat);
      m.position.set(p[0], 1, p[1]);
      pathGroup.add(m);
    }
  }
}

/* ============================== HUD ============================== */
function syncHud() {
  let p = 0, e = 0;
  for (const s of st.ships) {
    if (!s.alive) continue;
    if (s.side === "P") p++; else e++;
  }
  $("pcount").textContent = p;
  $("ecount").textContent = e;
  const z = st.zone;
  const show = z.owner !== "P" && (z.progress > 0 || st.ships.some(s => s.alive && s.side === "P" && BS.dist(s.x, s.z, z.x, z.z) < z.r * 2));
  $("capwrap").style.display = show ? "block" : "none";
  $("capfill").style.width = (100 * z.progress) + "%";
  zoneGroup.children[0].material.opacity = 0.45 + 0.2 * Math.sin(performance.now() / 400);
  refreshButtons();
}

/* ============================== music ============================== */
// Two folders of mp3s (music/sailing/ + music/combat/), scanned at build time
// into music.json, with an inlined window.__MUSIC_FALLBACK copy as backup.
// Mood follows enemy visibility: quick fade to combat when a red ship is
// seen, 5s grace then a slow fade back to sailing. (2026-10-09 user verdict)
const MUSIC = {
  lists: { sailing: [], combat: [] },
  lastPlayed: { sailing: null, combat: null },
  errCount: { sailing: 0, combat: 0 },
  dead: { sailing: false, combat: false }, // a mood that failed every file: stop trying (2026-10-09)
  els: {},
  mood: "sailing",
  baseVol: { sailing: 0.45, combat: 0.5625 }, // 75% of the original 0.6/0.75 (2026-10-09)
  quietT: 99,
  lastCheckMs: 0,
  started: false,
  vol: 1, // user volume multiplier from the slider, 0..1 (persisted)
};
try {
  const v = localStorage.getItem("bs_music_vol");
  if (v !== null) MUSIC.vol = Math.max(0, Math.min(1, parseFloat(v)));
  else if (localStorage.getItem("bs_music_muted") === "1") MUSIC.vol = 0; // migrate old mute toggle
} catch (e) {}

function musicPick(m) {
  const list = MUSIC.lists[m];
  if (!list.length) return null;
  let pick;
  if (list.length === 1) pick = list[0];
  else {
    let guard = 0; // never the same track twice in a row per mood
    do { pick = list[(Math.random() * list.length) | 0]; guard++; }
    while (pick === MUSIC.lastPlayed[m] && guard < 20);
  }
  MUSIC.lastPlayed[m] = pick;
  return pick;
}

function musicStartTrack(m) {
  const file = musicPick(m);
  if (!file) return; // empty mood list -> silence, no error
  const el = MUSIC.els[m];
  el.src = encodeURI(file); // manifest holds paths relative to index.html
  el.volume = 0; // fades back in via the ramp in musicTick
  const pr = el.play();
  if (pr && pr.catch) pr.catch(() => {});
}

function enemiesVisible() {
  for (const e of st.ships) {
    if (!e.alive || e.side !== "E") continue;
    for (const p of st.ships) {
      if (!p.alive || p.side !== "P") continue;
      if (BS.dist(e.x, e.z, p.x, p.z) <= BS.SHIPCLS[p.cls].vision) return true;
    }
  }
  return false;
}

function musicInit() {
  for (const m of ["sailing", "combat"]) {
    const el = new Audio();
    el.preload = "auto";
    el.addEventListener("ended", () => musicStartTrack(m)); // next random track
    el.addEventListener("playing", () => { MUSIC.errCount[m] = 0; }); // a success clears the failure streak
    el.addEventListener("error", () => {
      // missing/corrupt file: try the next one; once every file in the mood
      // has failed, stop trying entirely (2026-10-09 user verdict)
      MUSIC.errCount[m]++;
      if (MUSIC.errCount[m] <= MUSIC.lists[m].length) musicStartTrack(m);
      else MUSIC.dead[m] = true;
    });
    MUSIC.els[m] = el;
  }
  const apply = j => {
    if (j && Array.isArray(j.sailing)) MUSIC.lists.sailing = j.sailing.slice();
    if (j && Array.isArray(j.combat)) MUSIC.lists.combat = j.combat.slice();
  };
  // music.json sits next to index.html (GitHub Pages). On file:// the fetch
  // fails and we use the copy inlined by build.py instead.
  fetch("music.json")
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(apply)
    .catch(() => { if (window.__MUSIC_FALLBACK) apply(window.__MUSIC_FALLBACK); });
  const slider = $("volSlider"), vicon = $("volIcon");
  const paintVol = () => {
    slider.value = Math.round(MUSIC.vol * 100);
    vicon.textContent = MUSIC.vol > 0 ? "🔊" : "🔇";
  };
  paintVol();
  slider.addEventListener("input", () => {
    MUSIC.vol = slider.value / 100;
    try { localStorage.setItem("bs_music_vol", String(MUSIC.vol)); } catch (e) {}
    vicon.textContent = MUSIC.vol > 0 ? "🔊" : "🔇";
  });
}

function musicStart() {
  // from the SET SAIL click — browsers require a user gesture for audio
  if (MUSIC.started) return;
  MUSIC.started = true;
  MUSIC.mood = "sailing";
  MUSIC.quietT = 99;
  if (MUSIC.vol > 0) musicStartTrack("sailing");
}

function musicTick(dt) {
  if (!MUSIC.started) return;
  // mood check on wall-clock (~2Hz): frame dt is clamped, so a slow device
  // must not stretch the 5s grace period
  const nowMs = performance.now();
  if (!MUSIC.lastCheckMs) MUSIC.lastCheckMs = nowMs;
  if (nowMs - MUSIC.lastCheckMs >= 500) {
    const gap = (nowMs - MUSIC.lastCheckMs) / 1000;
    MUSIC.lastCheckMs = nowMs;
    if (enemiesVisible()) { MUSIC.mood = "combat"; MUSIC.quietT = 0; }
    else {
      MUSIC.quietT += gap;
      if (MUSIC.quietT >= 5) MUSIC.mood = "sailing";
    }
  }
  const fadeT = MUSIC.mood === "combat" ? 2.0 : 5.0; // audible crossfades both ways (2026-10-09)
  for (const m of ["sailing", "combat"]) {
    const el = MUSIC.els[m];
    const active = MUSIC.vol > 0 && MUSIC.mood === m && MUSIC.lists[m].length > 0 && !MUSIC.dead[m];
    const tgt = active ? MUSIC.baseVol[m] * MUSIC.vol : 0;
    if (active && el.paused) {
      if (el.currentSrc) { const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } // resume: keep the crossfade continuous
      else musicStartTrack(m);
    }
    const v = el.volume;
    if (v !== tgt) {
      const step = dt * MUSIC.baseVol[m] / fadeT;
      el.volume = v < tgt ? Math.min(tgt, v + step) : Math.max(tgt, v - step);
      if (el.volume === 0 && !active) el.pause();
    } else if (!active && !el.paused) {
      el.pause();
    }
  }
}
musicInit();

/* ============================== wind wisps ============================== */
// Transient wispy streaks drifting over the water to show local wind flow
// (2026-10-09 user verdict). Each wisp is a few overlapping sinusoidal cloud
// strokes, ~2x ship length, that appears in a random place, drifts downwind,
// and fades out after a few seconds — high turnover keeps the target density
// shimmering rather than parked. Distribution is map-wide and zoom-independent;
// spawn candidates are weighted toward local-wind disturbance, so wisps gather
// where the wind bends and shears near land and thin out over uniform open
// water. Density etc. are tunable live: __bs.wispTune("count", 120).
const WISPS = {
  count: 875,    // 500 + 75% (2026-10-09)
  len: 60,       // doubled 2026-10-09
  width: 4,
  maxOp: 1.0,
  lifeMin: 5, lifeMax: 10, // doubled 2026-10-09
  drift: 14,     // u/s at wind mag 1 — brisk flow (tunable, 2026-10-09)
};
// phone-debug overrides: ?wisps=400&wispOp=0.9&wispLen=60
{
  const q = new URLSearchParams(location.search);
  const qc = parseInt(q.get("wisps") || "", 10);
  if (qc >= 0) WISPS.count = Math.min(600, qc);
  const qo = parseFloat(q.get("wispOp") || "");
  if (qo >= 0) WISPS.maxOp = Math.min(1, qo);
  const ql = parseFloat(q.get("wispLen") || "");
  if (ql > 0) WISPS.len = Math.min(200, ql);
}
// each wisp is a handful of overlapping sinusoidal strokes, soft at the ends
function makeWispTex() {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext("2d");
  const n = 4 + (Math.random() * 2 | 0);
  for (let i = 0; i < n; i++) {
    const yBase = 32 + (Math.random() - 0.5) * 30;
    const amp = 3 + Math.random() * 7;
    const freq = 1 + Math.random() * 2;
    const ph = Math.random() * Math.PI * 2;
    const alpha = 0.28 + Math.random() * 0.24; // doubled 2026-10-09
    const g = ctx.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255," + alpha.toFixed(3) + ")");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.5 + Math.random() * 2.5;
    ctx.shadowColor = "rgba(255,255,255,0.5)";
    ctx.shadowBlur = 5;
    ctx.beginPath();
    for (let x = 0; x <= 256; x += 4) {
      const y = yBase + amp * Math.sin((x / 256) * Math.PI * 2 * freq + ph);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // vertical falloff so edges melt away
  ctx.globalCompositeOperation = "destination-in";
  ctx.shadowBlur = 0;
  const v = ctx.createLinearGradient(0, 0, 0, 64);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(0.35, "rgba(0,0,0,1)");
  v.addColorStop(0.65, "rgba(0,0,0,1)");
  v.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, 256, 64);
  const t = new THREE.CanvasTexture(cv);
  t.encoding = THREE.sRGBEncoding;
  return t;
}
const wispTexs = [makeWispTex(), makeWispTex(), makeWispTex()]; // a few variants
const wisps = [];
// how disturbed the local wind is vs the global wind: 0 = uniform
function windDisturb(x, z) {
  const w = BS.windAt(st, x, z);
  return Math.abs(BS.angDiff(w.ang, st.wind)) / Math.PI + Math.abs(w.mag - 1) * 0.8;
}
function wispSpawn(w, initial) {
  // map-wide distribution (2026-10-09 user verdict): sample candidates across
  // the whole ocean and keep the most disturbed (never on land), so the field
  // keeps its distribution no matter the zoom — disturbed areas (island shear,
  // channels) get more, uniform open water gets fewer
  let bx = 0, bz = 0, bd = -1;
  for (let k = 0; k < 16; k++) {
    const x = (Math.random() * 2 - 1) * 1350, z = (Math.random() * 2 - 1) * 1350;
    if (BS.inLand(x, z)) continue;
    const d = windDisturb(x, z) + Math.random() * 0.15;
    if (d > bd) { bd = d; bx = x; bz = z; }
  }
  if (bd < 0) return false;
  const wnd = BS.windAt(st, bx, bz);
  w.x = bx; w.z = bz; w.ang = wnd.ang; w.mag = wnd.mag;
  w.life = WISPS.lifeMin + Math.random() * (WISPS.lifeMax - WISPS.lifeMin);
  w.age = initial ? Math.random() * w.life : 0;
  w.phase = Math.random() * Math.PI * 2;
  w.oscF = 1.5 + Math.random() * 2;
  return true;
}
function wispAdd() {
  const mat = new THREE.MeshBasicMaterial({ map: wispTexs[(Math.random() * wispTexs.length) | 0],
    transparent: true, opacity: 0, depthWrite: false });
  const mesh = new THREE.Mesh(wispGeo, mat);
  mesh.renderOrder = 2;
  mesh.raycast = () => {};
  scene.add(mesh);
  const w = { mesh, x: 0, z: 0, ang: 0, mag: 1, age: 0, life: 1, phase: 0, oscF: 2 };
  wispSpawn(w, true);
  wisps.push(w);
  return w;
}
const wispGeo = (() => {
  const geo = new THREE.PlaneGeometry(WISPS.len, WISPS.width);
  geo.rotateX(-Math.PI / 2); // lie flat; streak along local X
  return geo;
})();
function wispsInit() {
  for (let i = 0; i < WISPS.count; i++) wispAdd();
}
function wispsTick(dt) {
  for (const w of wisps) {
    w.age += dt;
    // land is only checked at spawn: lives are short and drift is slow, so a
    // wisp can't travel far enough to matter
    if (w.age >= w.life || Math.abs(w.x) > 1450 || Math.abs(w.z) > 1450) {
      if (!wispSpawn(w, false)) { w.mesh.material.opacity = 0; }
      continue;
    }
    const wnd = BS.windAt(st, w.x, w.z); // follow bends as they drift
    w.ang = wnd.ang; w.mag = wnd.mag;
    const sp = WISPS.drift * w.mag;
    w.x += Math.sin(w.ang) * sp * dt;
    w.z += Math.cos(w.ang) * sp * dt;
    const env = Math.sin(Math.PI * w.age / w.life); // fade in and out
    const osc = 0.65 + 0.35 * Math.sin(w.age * w.oscF + w.phase); // the shimmer
    w.mesh.material.opacity = WISPS.maxOp * env * osc;
    const wob = Math.sin(w.age * 0.9 + w.phase) * 2; // gentle lateral wobble
    w.mesh.position.set(w.x + Math.cos(w.ang) * wob, 0.7, w.z - Math.sin(w.ang) * wob);
    w.mesh.rotation.y = w.ang - Math.PI / 2;
  }
}
wispsInit();

/* ============================== main loop ============================== */
let lastT = performance.now();
let frameN = 0;
let fogAcc = 1; // start > interval so fog paints on the first frame
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (running && !st.result) {
    simAcc += dt;
    let n = 0;
    while (simAcc >= SIM_DT && n < 5) { BS.step(st, SIM_DT); simAcc -= SIM_DT; n++; }
    drainEvents();
  }
  const t = now / 1000;
  syncShips(t, dt);
  frameN++;
  if (frameN % 6 === 0) syncPaths();
  fogAcc += dt;
  if (fogAcc >= 0.1) { fogAcc = 0; updateFog(); } // time-based, not frame-based
  updateFx(dt);
  musicTick(dt);
  wispsTick(dt);
  if (frameN % 20 === 0) syncHud();
  renderer.render(scene, camera);
}
frame();

/* ============================== debug ============================== */
window.__bs = {
  BS, THREE, camera, scene,
  get st() { return st; },
  get selection() { return selection.slice(); },
  // wind-wisp tuning (live): __bs.wispTune("count", 120), ("maxOp", 0.3), ...
  wispTune(k, v) {
    if (k === "count") {
      const n = Math.max(0, Math.min(400, v | 0));
      while (wisps.length < n) wispAdd();
      while (wisps.length > n) {
        const w = wisps.pop();
        scene.remove(w.mesh);
        w.mesh.material.dispose();
      }
      WISPS.count = n;
      return wisps.length;
    }
    WISPS[k] = v;
    return WISPS[k];
  },
  wispDisturb(x, z) { return windDisturb(x, z); },
  select(id) { selection = [id]; refreshButtons(); },
  selectMany(ids) { selection = ids.slice(); refreshButtons(); },
  clearSel() { selection = []; refreshButtons(); },
  tapWorld(x, z) { issueTap(x, z, null, null); },
  tapShip(id) { const s = BS.unitById(st, id); if (s) issueTap(0, 0, s, null); },
  longPressShip(id) {
    const s = BS.unitById(st, id);
    if (s) { const p = this.project(s.x, 4, s.z); onLongPress(p[0], p[1]); }
  },
  camTo(x, z, dist) { camT.x = x; camT.z = z; if (dist) camDist = dist; updateCamera(); },
  project(x, y, z) {
    tmpV.set(x, y, z).project(camera);
    return [Math.round((tmpV.x + 1) / 2 * window.innerWidth), Math.round((1 - tmpV.y) / 2 * window.innerHeight)];
  },
  start() { $("startOverlay").classList.add("hidden"); running = true; },
  toggleWindDbg() { $("bWindDbg").click(); return windOverlay.visible; },
  ringRadii() { return st.ships.map(s => ({ id: s.id, r: BS.effRangeOf(s) })); },
  readiness(id) { const s = BS.unitById(st, id); return s ? BS.fireReadiness(st, s) : null; },
  music: MUSIC,
  orderAttack(ids, tid) { BS.orderAttack(st, ids, tid); },
  simulate(secs) {
    // run the sim fast without rendering (for tests); then drain events
    const n = Math.ceil(secs / SIM_DT);
    for (let i = 0; i < n; i++) BS.step(st, SIM_DT);
    drainEvents();
  },
  shipMeshes,
};
})();
