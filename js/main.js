// Arranque: pista, mundo 3D, coches, simulación, director de cámaras, HUD y flujo del fin de semana.
import * as THREE from 'three';
import { buildTrack, HALF_W, CIRCUITS } from './track.js';
import { Sim, DT } from './sim.js';
import { buildWorld } from './world.js';
import { buildScenery } from './scenery.js';
import { buildCar } from './carModel.js';
import { Director } from './director.js';
import { UI, NEXT } from './ui.js';
import * as TX from './textures.js';
import { EngineAudio } from './audio.js';
import { Radio } from './radio.js';
import { Manager } from './manager.js';
import { Replay } from './replay.js';
import { TEAMS } from './teams.js';
import { buildWeather } from './weather.js';
import { buildFx } from './fx.js';
import { lobby, MP, pendingRejoin } from './net.js';

// solo se guardan los ajustes: lo aprendido empieza de cero cada fin de semana (cada uno es un mundo)
const SETTINGS = 'ngp-settings-v1';
const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
const msg = (t) => { const el = document.getElementById('loadMsg'); if (el) el.textContent = t; };
// (con la ventana en segundo plano no hay requestAnimationFrame: el temporizador hace que la carga siga igual)
const frame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 100); });

const params = new URLSearchParams(location.search);
const DEFAULT_SPEED = { FP: 1, FP2: 1, Q1: 1, Q2: 1, Q3: 1, RACE: 1 };

// vertical (móvil de pie o pantalla dividida): el 3D arriba y la interfaz debajo, en pestañas (ver body.portrait en el CSS)
{
  const mq = matchMedia('(max-aspect-ratio: 1/1)');
  const set = () => { document.body.classList.toggle('portrait', mq.matches); window.dispatchEvent(new Event('portrait')); };
  set(); mq.addEventListener('change', set);
}

async function main(choice) {
  const quality = choice.quality, trackId = choice.track;
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('ngp-brains')) localStorage.removeItem(k); } catch { /* sin almacenamiento */ }
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'low' ? 0.85 : 1.25));
  // (el tamaño sale del propio lienzo: en vertical solo ocupa la parte de arriba, ver body.portrait)
  renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = CIRCUITS[trackId].night ? 1.05 : CIRCUITS[trackId].sunset ? 0.95 : CIRCUITS[trackId].autumn ? 0.9 : CIRCUITS[trackId].coast ? 0.7 : 0.82;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  TX.setAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, (canvas.clientWidth || window.innerWidth) / (canvas.clientHeight || window.innerHeight), 0.08, 14000);

  msg('Trazando el circuito…'); await frame();
  const T = buildTrack(trackId);
  msg('Levantando gradas, boxes y escapatorias…'); await frame();
  const world = buildWorld(T, scene, renderer, quality);
  // ajuste de visibilidad (ver LOOK en textures.js): b más luz; c y d algo más de luz y de relleno en las sombras
  { const L = TX.LOOK; if (L !== 'a') { renderer.toneMappingExposure *= L === 'b' ? 1.28 : 1.1; if (world.hemi) world.hemi.intensity *= L === 'b' ? 1.3 : 1.2; } }
  const exposure0 = renderer.toneMappingExposure;   // (el túnel la sube y la baja: el ojo se adapta; ver coast.js)
  msg('Plantando bosques y montando el paddock…'); await frame();
  const scenery = buildScenery(T, scene, world, quality, world.sunDir);
  msg('Preparando los 22 monoplazas…'); await frame();
  const weatherFx = buildWeather(scene, world, scenery, renderer, camera, quality);
  world.autoOccluders(scene);
  // (multijugador: la misma semilla en todas las máquinas -> el mismo fin de semana)
  const sim = new Sim(T, { raceLaps: choice.raceLaps, brains: {}, seed: choice.mp?.seed });
  sim.weatherMode = choice.weather;
  // libres más cortas (portada): menos espera; los pilotos aprenden menos vueltas
  if (choice.fpMin && choice.fpMin !== 60) sim.fpDur = choice.fpMin * 60;
  const visuals = sim.cars.map((car) => { const v = buildCar(car.team, car.drv); scene.add(v.root); return v; });
  const fx = buildFx(scene, T, sim, visuals, world);

  const director = new Director(camera, renderer.domElement, T, sim, world, visuals);
  scenery.addCameraTowers(director.trackCams);

  // precarga en la GPU: todo (geometrías, texturas, shaders, las dos versiones de cada coche) se sube ahora, en la
  // pantalla de carga; si no, cada plano nuevo que descubría otra zona del circuito daba un tirón de 50-180 ms
  msg('Cargando en la tarjeta gráfica…'); await frame();
  {
    const culled = [], hidden = [];
    scene.traverse((o) => {
      if (o.isMesh || o.isPoints || o.isLine || o.isSprite) { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } }
      if (!o.visible) { hidden.push(o); o.visible = true; }
    });
    scene.traverse((o) => { for (const m of [].concat(o.material || [])) for (const k in m) if (m[k]?.isTexture) renderer.initTexture(m[k]); });
    camera.position.set(0, 300, 0); camera.lookAt(0, 0, 0);
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    for (const o of culled) o.frustumCulled = true;
    for (const o of hidden) o.visible = false;
  }
  const app = {
    sim, T, director, speed: 1, lastSpeed: 1, skipping: false, audio: new EngineAudio(),
    setSpeed(s) { if (s > 0) this.lastSpeed = s; this.speed = s; ui.syncButtons(); this.mp?.renderPlayers(); },
    // lo que pide el jugador: en solitario se hace; en multijugador pausar es inmediato y lo demás se vota
    reqSpeed(s) {
      if (!this.mp) { this.setSpeed(s); return; }
      if (s === 0) this.mp.cmd({ k: 'pause' }); else this.mp.propose('speed', s);
    },
    skip() { if (this.mp) this.mp.propose('skip'); else this.doSkip(); },
    nextSession() { if (this.mp) this.mp.propose(sim.session?.id === 'RACE' ? 'lobby' : 'next'); else this.doNext(); },
    restart() { if (this.mp) this.mp.propose('lobby'); else location.reload(); },   // fin de semana nuevo: pilotos sin nada aprendido
    // un paso de simulación (y lo que los muros revisan en cada paso)
    stepOnce() { sim.step(); for (const m of this.managers) m.tickLogic(); },
    // (multijugador) se ha cargado la copia del estado del anfitrión: coches y paneles, a lo nuevo
    afterResync() {
      for (const v of visuals) v.teleport = true;
      for (const m of this.managers) if (!m.headless) { m.html = null; m.gHTML = null; m.render(); if (m.gOpen) m.renderGarage(); }
      if (!sim.session?.done) document.getElementById('nextBar')?.remove();
      ui.syncButtons();
    },
    managers: [],
    doSkip() {
      if (sim.session?.done) return;
      // hasta el final de la sesión los muros no deciden: sus coches salen, paran y cambian gomas como los de la IA
      sim.gridHold = false; sim.autoMgr = true; this.skipping = true;
      for (const m of this.managers) m.alerts = [];
      document.getElementById('skipBar')?.remove(); const d = document.createElement('div'); d.id = 'skipBar';
      d.innerHTML = `<b>Simulando el resto de la sesión…</b>${this.managers.length ? '<small>Tu equipo lo lleva la IA hasta el final</small>' : ''}<div class="track"><i></i></div>`;
      document.getElementById('hud').appendChild(d);
    },
    doNext() {
      const cur = sim.session?.id;
      let nx = cur ? NEXT[cur] : 'FP';
      if (cur === 'RACE' || !nx) { if (this.mp) this.mp.backToLobby(); else location.reload(); return; }
      document.querySelectorAll('.modal').forEach((m) => m.remove()); document.getElementById('nextBar')?.remove();
      startSession(nx);
    },
  };
  const ui = new UI(app);
  const radio = app.radio = new Radio(sim, director, app);
  const replay = app.replay = new Replay(app, sim, director);
  app.fx = fx;

  function startSession(id) {
    sim.startSession(id);
    app.setSpeed(DEFAULT_SPEED[id]);
    director.setAuto(true);
    if (id === 'RACE') { director.focus = sim.raceOrder[0]; director.type = 'heli'; director.first = true; }
    else { director.focus = sim.cars[0]; director.type = 'track'; }
  }

  sim.on((e) => {
    if (e.type === 'sessionEnd') {
      app.skipping = false; document.getElementById('skipBar')?.remove();
      setTimeout(() => ui.results(e.id, e.cls), app.speed > 4 ? 300 : 2500);
    }
  });

  // --- colocación de los coches cada frame
  const P = [0, 0, 0], P2 = [0, 0, 0];
  let simLead = 0;
  const camWorld = new THREE.Vector3();
  function place(car, V, dt, realDt) {
    const root = V.root;
    // detalle según tamaño en pantalla (distancia corregida por el zoom), con histéresis
    const eff = camera.position.distanceTo(root.position) * Math.tan((camera.fov * Math.PI) / 360) / Math.tan(Math.PI / 6);
    if (V.detailed && eff > 110) { V.detailed = false; V.hi.visible = false; V.lo.visible = true; }
    else if (!V.detailed && eff < 85) { V.detailed = true; V.hi.visible = true; V.lo.visible = false; }
    const inGarage = car.state === 'garage' || car.out;
    if (inGarage) {
      const box = T.pit.boxes[TEAMS.indexOf(car.team)];
      const first = sim.cars.find((c) => c.team === car.team) === car;
      const s = box.s + (first ? 4.5 : -4.5);
      T.pos(s, T.pit.d - 16, P);
      const i = T.idx(s);
      root.position.set(P[0], P[1] + 0.02, P[2]);
      root.rotation.set(0, Math.atan2(T.lx[i], T.lz[i]), 0, 'YXZ');
      V.body.rotation.set(0, 0, 0); V.teleport = true;
      return;
    }
    // interpolación: se dibuja donde estará tras el tiempo aún no simulado (evita saltos de 0/2 pasos por fotograma)
    const lead = (car.inPit && car.pitPhase === 'stop') || car.state === 'grid' ? 0 : simLead;   // parado en la parrilla: sin extrapolar
    // saltos de lado de la física (al apartarse de otro coche que ya estaba encima: hasta 2 m en un paso): se dibujan como
    // un deslizamiento de ~0,15 s en vez de un teletransporte
    if (car.jumpD) { V.offD = V.teleport ? 0 : (V.offD || 0) - car.jumpD; car.jumpD = 0; }
    if (V.offD) { V.offD *= Math.exp(-realDt * 14); if (Math.abs(V.offD) < 0.01) V.offD = 0; }
    const sv = car.s + (car.vs ?? car.v) * lead, dv = car.d + (V.offD || 0) + (car.inPit ? 0 : (car.d - (car.dPrev ?? car.d)) / DT * lead);
    T.pos(sv, dv, P);
    const i = T.idx(sv);
    const trackYaw = Math.atan2(T.lerp(T.tx, sv), T.lerp(T.tz, sv));
    // el rumbo relativo y el giro de volante se suavizan (la física trabaja a pasos discretos)
    const k = 1 - Math.exp(-realDt * 10);
    if (V.visYaw == null || V.teleport) { V.visYaw = car.yaw; V.visSteer = car.steer; V.teleport = false; }
    V.visYaw += (car.yaw - V.visYaw) * k;
    V.visSteer += (car.steer - V.visSteer) * (1 - Math.exp(-realDt * 8));
    T.pos(sv + 2, dv, P2); const yA = P2[1]; T.pos(sv - 2, dv, P2);
    const grade = (yA - P2[1]) / 4;
    const bank = Math.abs(dv) <= T.hwAt(sv) + 0.5 ? T.lerp(T.bank, sv) : 0;
    root.position.set(P[0], P[1], P[2]);
    root.rotation.set(-Math.atan(grade), trackYaw + V.visYaw + car.slide, -bank, 'YXZ');
    V.body.rotation.set(car.pitch, 0, car.roll * 0.6);
    // ruedas
    // giro de rueda: por encima de ~1/4 de vuelta por fotograma se ve estroboscópico -> se limita
    const spin = Math.min((car.v * dt) / 0.36, 0.9);
    for (const w of V.wheels) { w.spin.rotation.x += spin; if (w.front) w.steer.rotation.y = THREE.MathUtils.clamp(V.visSteer * 0.5, -0.38, 0.38); }
    // volante: unas 6 veces el ángulo de las ruedas (hasta ~130°), con el contravolante de las derrapadas
    if (V.swheel && V.detailed) V.swheel.rotation.z = THREE.MathUtils.clamp(-V.visSteer * 3, -2.3, 2.3);
    for (const w of V.loWheels) w.rotation.x += spin;
    V.flap.rotation.x += ((car.drs ? -0.55 : 0) - V.flap.rotation.x) * Math.min(1, dt * 12);
    // luz trasera: parpadea en el pit lane, con VSC o despacio; con pista mojada, encendida siempre
    const blink = (car.inPit || sim.flag === 'VSC' || car.v < 15) && Math.floor(performance.now() / 250) % 2 === 0;
    V.rain.material.emissiveIntensity = blink ? 3 : (sim.wx?.wet ?? 0) > 0.15 ? 2.2 : 0;
    V.setCompound(car.tyre.c, car.v > 22);
  }

  // --- bucle
  const fit = () => { const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  window.addEventListener('resize', fit); window.addEventListener('portrait', fit);
  let last = performance.now(), acc = 0, skipFrame = 0;
  const focusPos = new THREE.Vector3();
  let lastFrame = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    lastFrame = performance.now();
    try { tick(now); } catch (e) { console.error(e); }
  }
  function tick(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (app.mp) {
      // multijugador: el ritmo lo marca el anfitrión (ver net.js)
      acc = app.mp.drive(dt);
      if (app.skipping) {
        skipFrame = (skipFrame + 1) % 4;
        const ss = sim.session, prog = !ss ? 0 : ss.id === 'RACE' ? (sim.raceOrder?.[0]?.lap ?? 0) / sim.raceLaps : sim.t / (ss.dur + 60);
        const bar = document.querySelector('#skipBar i'); if (bar) bar.style.width = `${Math.min(100, prog * 100)}%`;
      }
    } else if (app.skipping && sim.session && !sim.session.done) {
      // misma simulación que viéndola (paso de 1/60 s), pero casi todo el tiempo para simular: tandas de 150 ms y solo se
      // dibuja 1 de cada 3 (~2 imágenes por segundo; con 70 ms y 1 de 4 se iba un 12 % en dibujar)
      const t0 = performance.now();
      while (performance.now() - t0 < 150 && !sim.session.done) for (let k = 0; k < 30; k++) app.stepOnce();
      skipFrame = (skipFrame + 1) % 3;
      const ss = sim.session;
      const prog = ss.id === 'RACE' ? (sim.raceOrder?.[0]?.lap ?? 0) / sim.raceLaps : sim.t / (ss.dur + 60);
      const bar = document.querySelector('#skipBar i'); if (bar) bar.style.width = `${Math.min(100, prog * 100)}%`;
    } else if (replay.active) {
      acc = 0;                                             // repetición: la carrera se congela
    } else if (sim.session && !sim.session.done) {
      acc += dt * app.speed;
      let n = 0; const maxSteps = 60 * 40;
      while (acc >= DT && n < maxSteps) { app.stepOnce(); acc -= DT; n++; }
      if (n >= maxSteps) acc = 0;
    }
    if (!app.skipping) replay.record();
    const replaying = replay.update(dt);
    simLead = replaying || app.skipping || !sim.session || sim.session.done || (app.mp && app.speed === 0) ? 0 : Math.max(0, Math.min(DT, acc));
    if (app.skipping && skipFrame !== 0) { ui.update(dt); return; }
    sim.cars.forEach((car, k) => place(car, visuals[k], dt * (replaying ? replay.rate : app.speed || 0), dt));
    director.update(dt);
    weatherFx.update(dt, sim, director.type, visuals);
    fx.update(dt);
    focusPos.copy(visuals[director.focus.i].root.position);
    world.update(dt, sim, focusPos, camera.position);
    scenery.update(dt, focusPos, camera.position);
    if (world.exposureK) renderer.toneMappingExposure = exposure0 * world.exposureK;
    app.audio.tunnel = world.tunnelK || 0;
    app.audio.update(director.focus, director.type, camera, focusPos, app.skipping ? 99 : replaying ? 1 : app.speed, sim, visuals);
    radio.update(dt, app.skipping ? 99 : app.speed);
    app.manager?.update(dt);
    ui.update(dt);
    renderer.render(scene, camera);
  }

  // --- empieza
  document.getElementById('loading').remove();
  if (choice.mode === 'mgr') { app.manager = new Manager(sim, director, choice.team, app); app.managers = [app.manager]; director.setFocus(app.manager.cars[0]); }
  if (choice.mode === 'mp') {
    // un muro por jugador con equipo, en el mismo orden en todas las máquinas; solo el tuyo tiene panel
    const info = choice.mp;
    app.mp = new MP(app, info);
    for (const p of info.players) {
      if (!p.team) continue;
      const m = new Manager(sim, director, p.team, app, { headless: p.id !== info.myId });
      app.managers.push(m);
      if (p.id === info.myId) app.manager = m;
    }
    if (app.manager) director.setFocus(app.manager.cars[0]);
    app.audio.start(); ui.syncButtons();
    startSession('FP');
    // el invitado no avanza hasta que el anfitrión lo diga; el anfitrión, hasta que todos hayan cargado
    requestAnimationFrame(loop);
    // con la ventana minimizada o en otra pestaña no hay requestAnimationFrame: un reloj en un worker (que el navegador no
    // frena) sigue avanzando la simulación, para no congelar la partida de los demás
    try {
      const wk = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 50)'], { type: 'text/javascript' })));
      let lastBg = performance.now();
      wk.onmessage = () => {
        const now = performance.now();
        if (now - lastFrame < 250) { lastBg = now; return; }   // hay fotogramas: avanza el bucle normal
        const dt = Math.min(0.25, (now - lastBg) / 1000); lastBg = now; last = now;
        try { app.mp.drive(dt); } catch (e) { console.error(e); }
      };
    } catch { /* sin workers: solo avanza con la ventana a la vista */ }
    window.__app = app; window.__sim = sim;
    return;
  }
  app.audio.start(); ui.syncButtons();
  if (!params.get('autostart')) startSession(params.get('start') || 'FP');
  if (params.get('autostart')) { ui.closeModal(); startSession(params.get('autostart')); }
  requestAnimationFrame(loop);
  window.__app = app; window.__vis = visuals; window.__world = world; window.__sim = sim; window.__dir = director; window.__scene = scene; window.__THREE = THREE; window.__renderer = renderer; window.__fx = fx;
}

// --- pantalla de inicio: sale al momento, sin construir nada (el circuito elegido se carga al empezar)
async function startScreen() {
  await document.fonts?.ready;
  const settings = readJSON(SETTINGS) || {};
  const quality = params.get('q') || settings.quality || 'high';
  const trackId = CIRCUITS[params.get('track')] ? params.get('track') : CIRCUITS[settings.track] ? settings.track : 'gp';
  const laps = +(params.get('laps') || settings.raceLaps || 20), wx = params.get('wx') || settings.weather || 'random';
  const fpMin = [60, 30, 15].includes(+settings.fpMin) ? +settings.fpMin : 60;
  const loading = document.getElementById('loading'); loading.style.display = 'none'; document.body.classList.add('menu');
  // circuitos: dibujo del trazado de cada uno (del eje real), longitud y curvas
  const trackCard = (c) => {
    const TT = buildTrack(c.id);
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < TT.N; i += 10) { x0 = Math.min(x0, TT.x[i]); x1 = Math.max(x1, TT.x[i]); z0 = Math.min(z0, TT.z[i]); z1 = Math.max(z1, TT.z[i]); }
    const W = 150, H = 96, k = Math.min((W - 12) / (x1 - x0), (H - 12) / (z1 - z0)), ox = (W - (x1 - x0) * k) / 2, oz = (H - (z1 - z0) * k) / 2;
    let d = ''; for (let i = 0; i < TT.N; i += 12) d += `${i ? 'L' : 'M'}${(ox + (TT.x[i] - x0) * k).toFixed(1)},${(oz + (TT.z[i] - z0) * k).toFixed(1)}`;
    const sx = ox + (TT.x[0] - x0) * k, sz = oz + (TT.z[0] - z0) * k;
    return `<button class="tcard ${c.id === trackId ? 'on' : ''}" data-track="${c.id}"><svg viewBox="0 0 ${W} ${H}"><path d="${d}Z"/><circle cx="${sx.toFixed(1)}" cy="${sz.toFixed(1)}" r="3.2"/></svg>
      <b>${c.name}</b><span>${c.place}</span><em>${(TT.L / 1000).toFixed(2)} km · ${TT.corners.length} curvas</em></button>`;
  };
  const seg = (id, opts, cur) => `<div class="seg" data-for="${id}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const hidden = (id, opts, cur) => `<select id="${id}" hidden>${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const O = {
    iLaps: [10, 15, 20, 30].map((l) => [l, l]),
    iFP: [[60, '1 h'], [30, '30 min'], [15, '15 min']],
    iWx: [['random', 'Aleatorio'], ['dry', 'Seco'], ['mixed', 'Chubascos'], ['wet', 'Lluvia']],
    iMode: [['watch', 'Espectador'], ['mgr', 'Mánager'], ['mp', 'Multijugador']],
    iQ: [['high', 'Alta'], ['low', 'Baja']],
  };
  const rejoin = pendingRejoin();
  const HINT = {
    mgr: 'Llevas a los dos pilotos desde el muro: salidas a pista, reglaje, plan de paradas, ritmo, motor y órdenes de equipo.',
    watch: 'La retransmisión se realiza sola; puedes elegir piloto y plano cuando quieras.',
    mp: 'Cada amigo lleva su equipo en el mismo fin de semana. Uno crea la partida (el anfitrión) y el resto se une con su dirección.',
  };
  const curMode = rejoin ? 'mp' : ['mgr', 'mp'].includes(settings.mode) ? settings.mode : 'watch', curTeam = TEAMS.some((t) => t.id === settings.team) ? settings.team : TEAMS[0].id;
  const intro = document.createElement('div'); intro.className = 'modal'; document.body.appendChild(intro);
  intro.innerHTML = `<div class="sheet"><div class="start">
      <div class="st-l">
        <div class="logo">F1 AI <i>Manager</i></div>
        <p class="tag">Veintidós pilotos con IA que aprenden dando vueltas. Buscan la trazada en libres, la exprimen en clasificación y pelean en carrera. Cada fin de semana empiezan de cero.</p>
        <h3>Circuito</h3>
        <div class="tcards">${Object.values(CIRCUITS).map(trackCard).join('')}</div>
        <h3>El fin de semana</h3>
        <div class="sched"><div><b>Libres 1 y 2</b><span id="schedFP">${fpMin === 60 ? '1 h' : fpMin + ' min'} cada una · buscan trazada y límite</span></div><div><b>Clasificación</b><span>Q1 12′ · Q2 10′ · Q3 9′</span></div><div><b>Carrera</b><span id="schedLaps">${laps} vueltas · paradas y peleas</span></div></div>
      </div>
      <div class="st-r">
        <h3>Modo</h3>${seg('iMode', O.iMode, curMode)}
        <div class="teams ${curMode === 'mgr' ? '' : 'off'}">${TEAMS.map((t) => `<button data-team="${t.id}" class="${t.id === curTeam ? 'on' : ''}" title="${t.name}"><i style="background:${t.c1}"></i><i style="background:${t.c2}"></i><span>${t.short}</span></button>`).join('')}</div>
        <div class="mpbox ${curMode === 'mp' ? '' : 'off'}">
          <label>Tu nombre<input id="mpName" maxlength="20" autocomplete="off" value="${(rejoin?.name || settings.mpName || '').replace(/"/g, '')}" placeholder="Piloto"></label>
          <button class="btn" id="mpHost">Crear partida (anfitrión)</button>
          <label>Dirección del anfitrión<input id="mpAddr" autocomplete="off" value="${(rejoin?.role === 'join' ? rejoin.addr : settings.mpAddr || (location.hostname && !['localhost', '127.0.0.1'].includes(location.hostname) ? location.host : '')).replace(/"/g, '')}" placeholder="192.168.1.20:8765"></label>
          <button class="btn ghost" id="mpJoin">Unirse a una partida</button>
          <p class="hint mpErr"></p>
        </div>
        <p class="hint">${HINT[curMode]}</p>
        <div class="spOnly ${curMode === 'mp' ? 'off' : ''}">
        <h3>Tiempo</h3>${seg('iWx', O.iWx, wx)}
        <h3>Vueltas de carrera</h3>${seg('iLaps', O.iLaps, laps)}
        <h3>Duración de los libres</h3>${seg('iFP', O.iFP, fpMin)}
        <h3>Calidad gráfica</h3>${seg('iQ', O.iQ, quality)}
        <button class="btn go" id="iGo">Empezar el fin de semana</button>
        </div>
        <p class="keys"><b>A</b> auto · <b>1–8</b> planos · <b>Espacio</b> pausa · <b>+/−</b> velocidad · <b>R</b> repetición · <b>L</b> aprendizaje · <b>Esc</b> menú · <b>G</b> garaje (mánager)</p>
      </div>
      ${hidden('iTrack', Object.values(CIRCUITS).map((c) => [c.id, c.name]), trackId)}${hidden('iLaps', O.iLaps, laps)}${hidden('iFP', O.iFP, fpMin)}${hidden('iWx', O.iWx, wx)}${hidden('iMode', O.iMode, curMode)}${hidden('iQ', O.iQ, quality)}${hidden('iTeam', TEAMS.map((t) => [t.id, t.name]), curTeam)}
    </div></div>`;
  intro.querySelector('.sheet').classList.add('startSheet');
  // los controles visibles mueven los <select> ocultos (que son los que se leen al empezar)
  intro.querySelectorAll('.seg').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    const s = intro.querySelector('#' + g.dataset.for); s.value = b.dataset.v; s.dispatchEvent(new Event('change'));
    if (g.dataset.for === 'iLaps') intro.querySelector('#schedLaps').textContent = `${b.dataset.v} vueltas · paradas y peleas`;
    if (g.dataset.for === 'iFP') intro.querySelector('#schedFP').textContent = `${b.dataset.v === '60' ? '1 h' : b.dataset.v + ' min'} cada una · buscan trazada y límite`;
  }));
  intro.querySelectorAll('[data-team]').forEach((b) => (b.onclick = () => { intro.querySelectorAll('[data-team]').forEach((x) => x.classList.toggle('on', x === b)); intro.querySelector('#iTeam').value = b.dataset.team; }));
  // elegir circuito no carga nada: se carga al empezar
  const pickTrack = (id) => { intro.querySelectorAll('[data-track]').forEach((x) => x.classList.toggle('on', x.dataset.track === id)); intro.querySelector('#iTrack').value = id; };
  intro.querySelectorAll('[data-track]').forEach((b) => (b.onclick = () => pickTrack(b.dataset.track)));
  intro.querySelector('#iTrack').onchange = (e) => pickTrack(e.target.value);
  intro.querySelector('#iMode').onchange = (e) => {
    const m = e.target.value;
    intro.querySelector('.teams').classList.toggle('off', m !== 'mgr');
    intro.querySelector('.mpbox').classList.toggle('off', m !== 'mp');
    intro.querySelector('.spOnly').classList.toggle('off', m === 'mp');
    intro.querySelector('.st-r > .hint').textContent = HINT[m];
  };
  // multijugador: la columna derecha pasa a ser la sala; el circuito se sigue eligiendo a la izquierda (el anfitrión)
  const mpStart = (role, retry) => {
    const name = intro.querySelector('#mpName').value.trim() || 'Piloto', addr = intro.querySelector('#mpAddr').value.trim();
    const err = intro.querySelector('.mpErr');
    if (location.protocol === 'file:') { err.textContent = 'Para jugar en red abre el juego con el ejecutable (servidor), no como archivo.'; return null; }
    if (role === 'join' && !addr) { err.textContent = 'Escribe la dirección que te pase el anfitrión (por ejemplo 192.168.1.20:8765).'; return null; }
    writeJSON(SETTINGS, { ...readJSON(SETTINGS), mode: 'mp', mpName: name, mpAddr: role === 'join' ? addr : readJSON(SETTINGS)?.mpAddr });
    const v = (id) => intro.querySelector('#' + id).value;
    const ui = {
      root: intro.querySelector('.st-r'),
      getSettings: () => ({ track: v('iTrack'), weather: v('iWx'), raceLaps: +v('iLaps'), fpMin: +v('iFP'), quality: v('iQ') }),
      setSettings: (s) => {
        if (s.track && s.track !== v('iTrack')) pickTrack(s.track);
        if (s.weather) intro.querySelector('#iWx').value = s.weather;
        if (s.fpMin) { intro.querySelector('#iFP').value = s.fpMin; intro.querySelector('#schedFP').textContent = `${+s.fpMin === 60 ? '1 h' : s.fpMin + ' min'} cada una · buscan trazada y límite`; }
        if (s.raceLaps) { intro.querySelector('#iLaps').value = s.raceLaps; intro.querySelector('#schedLaps').textContent = `${s.raceLaps} vueltas · paradas y peleas`; }
        if (s.quality) intro.querySelector('#iQ').value = s.quality;
      },
      lockLeft: (on) => intro.querySelector('.st-l').classList.toggle('locked', on),
    };
    return lobby(ui, { role, name, addr, retry });
  };
  return new Promise((resolve) => {
    const goMP = (p) => p?.then((choice) => {
      intro.remove(); loading.style.display = ''; document.body.classList.remove('menu');
      resolve(choice);
    }, () => location.reload());
    intro.querySelector('#mpHost').onclick = () => goMP(mpStart('host'));
    intro.querySelector('#mpJoin').onclick = () => goMP(mpStart('join'));
    const go = () => {
      const v = (id) => intro.querySelector('#' + id).value;
      const choice = { quality: v('iQ'), track: v('iTrack'), raceLaps: +v('iLaps'), weather: v('iWx'), mode: v('iMode'), team: v('iTeam'), fpMin: +v('iFP') };
      writeJSON(SETTINGS, { ...settings, ...choice });
      intro.remove(); loading.style.display = ''; document.body.classList.remove('menu');
      resolve(choice);
    };
    intro.querySelector('#iGo').onclick = go;
    if (params.get('autostart')) go();
    // volver a la sala o reconectar tras recargar: se entra solo
    else if (rejoin) goMP(mpStart(rejoin.role, true));
  });
}

startScreen().then(main).catch((e) => { console.error(e); const el = document.getElementById('loadMsg'); if (el) el.textContent = 'Error: ' + e.message; });
