// Simulación: física en coordenadas de pista (s, d), pelea en pista, boxes, sesiones y cronometraje.
// No depende de three.js: corre igual en el navegador que en node (para calibrar).
import { HALF_W, CAR_HALF, between } from './track.js';
import { TEAMS, DRIVERS, COMPOUNDS, teamById, shuffleWeekend } from './teams.js';
import { newBrain, buildLine, lineGeometry, degSlope, addDeg, gauss, NODE_STEP, nodeSpan, ensureWet } from './brain.js';

// (24/09: algo menos de agarre y bastante menos carga aerodinámica: en las curvas rápidas iban a 6,5-7 g; ahora ~6)
const G = 9.81, MU = 1.53, AERO = 0.0038, MASS = 798, CD = 0.96, ROLL = 160, POWER = 0.96;
const BRK = 0.67;           // fracción del agarre usable frenando
// aceleración en 5ª, 6ª y 7ª (≈200-305 km/h): un 8 % menos de empuje (transiciones suaves)
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// (desde 3.ª, a partir de ~130 km/h, un 7 % menos: empujaba demasiado en las marchas largas)
const gearPowerX = (v) => (1 - 0.08 * sstep(52, 57, v) * (1 - sstep(82, 87, v))) * (1 - 0.07 * sstep(34, 38, v));
// (atajos para los tramos planos: mismos números exactos, sin las tres sstep en cada muestra del modelo del piloto)
const GP_HI = gearPowerX(45), GP_MID = gearPowerX(70);
export const gearPower = (v) => (v <= 34 ? 1 : v >= 38 && v <= 52 ? GP_HI : v >= 57 && v <= 82 ? GP_MID : v >= 87 ? GP_HI : gearPowerX(v));
const TRAC = 0.58;          // fracción del agarre usable acelerando
const LIMN = HALF_W - CAR_HALF - 0.25; // límite lateral de los nodos de trazada (donde la pista es estrecha, menos: clampN)
const CP_STEP = 50;         // checkpoints de cronometraje
const LEN = 5.6;            // largo del coche
const SEP = 2.15;           // separación lateral mínima entre ejes de coches
const EXEC_SD = 0.026;      // variación de una entrada a otra (se multiplica por 1,3 − consistencia)
export let DT = 1 / 60;
// paso de simulación: 1/60 s viendo la sesión; al saltarla se puede usar uno más largo
export function setDT(dt) { DT = dt; }

export function mulberry(seed) {
  // (el estado va en f.s y no escondido en el cierre: así se puede copiar al resincronizar el multijugador)
  const f = () => { let a = f.s | 0; a = (a + 0x6D2B79F5) | 0; f.s = a; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.s = seed >>> 0;
  return f;
}

// Elipse de agarre: fracción del agarre longitudinal que queda libre cuando la curva ya usa r del lateral
const ellipse = (r) => (r >= 0.993 ? 0.12 : Math.max(0.12, Math.sqrt(1 - r * r)));

function vCorner(k, mu, aero) {
  const kk = Math.abs(k); const den = kk - mu * aero;
  if (den <= 1e-6) return 110; return Math.min(110, Math.sqrt(mu * G / den));
}

// Agarre de cada compuesto según el agua en pista (0 seco … 1 empapado). Lisos: se hunden en cuanto hay agua.
// Intermedio: el mejor con pista húmeda; lluvia extrema: el único que evacúa con mucha agua.
export function wetGrip(c, w) {
  if (c === 'I') return 0.875 - 0.26 * Math.pow(Math.max(0, w - 0.5), 1.15) - 0.05 * Math.max(0, 0.12 - w) / 0.12;
  if (c === 'W') return 0.805 - 0.03 * Math.max(0, 0.3 - w);
  // (curva suave al principio: con cuatro gotas apenas se pierde; empapado, igual que antes)
  return 1 - 0.64 * Math.pow(w, 1.05);
}
// neumático que conviene con esa cantidad de agua
export const idealTyre = (w) => (w < 0.2 ? null : w < 0.78 ? 'I' : 'W');

// Palancas del mánager. Ritmo: g = agarre que saca de la goma (atacar la lleva más caliente y con más deslizamiento:
// agarra más pero se gasta mucho más), k = límite que se pone, wear = desgaste, sd = variación de una curva a otra (errores).
// (solo subir el límite, sin más agarre, hacía que atacar fuese más lento: se pasaba en las frenadas) Motor: pw = potencia; ers = batería por vuelta (− gasta, + recarga). Pelea: ganas de atacar y de defender.
export const MGR = {
  pace: { push: { g: 1.02, k: 1, wear: 1.8, sd: 1.45 }, normal: { g: 1, k: 1, wear: 1, sd: 1 }, save: { g: 0.985, k: 0.985, wear: 0.5, sd: 0.75 } },
  ers: { boost: { pw: 1.06, ers: -0.5 }, normal: { pw: 1, ers: 0.04 }, charge: { pw: 0.955, ers: 0.4 } },
  fight: { calm: { will: -0.35, dive: 0.4, def: false }, normal: { will: 0, dive: 1, def: true }, hard: { will: 0.3, dive: 1.6, def: true } },
  WEAR_K: 0.58,   // desgaste medio por vuelta en carrera = compuesto.wear × WEAR_K / vueltas (tools/wearlap.mjs)
};

export const isFP = (id) => id === 'FP' || id === 'FP2';
export const SESSIONS = {
  FP: { label: 'Entrenamientos 1', short: 'FP', dur: 60 * 60 },
  FP2: { label: 'Entrenamientos 2', short: 'FP2', dur: 60 * 60 },
  Q1: { label: 'Clasificación · Q1', short: 'Q1', dur: 12 * 60, cut: 16 },
  Q2: { label: 'Clasificación · Q2', short: 'Q2', dur: 10 * 60, cut: 10 },
  Q3: { label: 'Clasificación · Q3', short: 'Q3', dur: 9 * 60, cut: 0 },
  RACE: { label: 'Carrera', short: 'RACE', dur: 0 },
};

const T0 = (s, L) => s / L;
// ¿participa en el tráfico? (aparcados tras abandonar y coches en el garaje no)
const live = (o) => !o.out && o.state !== 'garage' && !o.parked;

export class Sim {
  constructor(T, opts = {}) {
    this.T = T;
    this.rng = mulberry(opts.seed ?? (Date.now() & 0xffffff));
    if (!opts.noShuffle) shuffleWeekend(this.rng); // coches y aprendizaje repartidos al azar este fin de semana (el simulador del mánager no)
    this.raceLaps = opts.raceLaps ?? 20;
    this.weekend = opts.weekend ?? 1;
    this.events = [];
    this.listeners = [];
    this.t = 0;           // tiempo de sesión
    this.nCP = Math.floor(T.L / CP_STEP);
    // agarre real de cada zona (peralte, baches, asfalto): los pilotos no lo saben
    const zr = mulberry(1234);
    this.zoneTrue = T.zones.map(() => 0.975 + zr() * 0.05);
    this.evo = 0; // goma acumulada en la pista (vueltas)
    // siguiente zona por delante de cada muestra y rango de nodos de cada zona
    T.zoneNext = T.zoneNext || (() => {
      const zn = new Int16Array(T.N);
      for (let i = 0; i < T.N; i++) { let bd = Infinity; for (const zz of T.zones) { const d = T.ahead(i * T.ds, zz.a); if (d > 0.5 && d < bd) { bd = d; zn[i] = zz.id; } } }
      return zn;
    })();
    const nN = Math.round(T.L / NODE_STEP), stepN = T.L / nN;
    this.zRange = T.zones.map((zz) => { const lo = Math.ceil(zz.a / stepN); return [lo, Math.ceil((zz.a + zz.len) / stepN) - 1]; });
    const brains = opts.brains || {};
    // (opts.only: solo ese piloto; lo usa el simulador del equipo del mánager)
    this.cars = DRIVERS.filter((d) => !opts.only || d.code === opts.only).map((drv, i) => this.makeCar(drv, i, brains[drv.code]));
    this.session = null;
    this.flag = 'GREEN'; this.vscT = 0; this.vscEnd = false;
    this.fastest = null;
  }

  on(fn) { this.listeners.push(fn); }
  emit(ev) { ev.t = this.t; ev.session = this.session?.id; this.events.push(ev); if (this.events.length > 400) this.events.shift(); for (const f of this.listeners) f(ev); }

  makeCar(drv, i, brain) {
    const T = this.T;
    const team = teamById[drv.team];
    const car = {
      i, drv, team, code: drv.code,
      brain: brain && brain.v === 3 && brain.nodes.length === Math.round(T.L / NODE_STEP) ? brain : newBrain(T, drv, this.rng),
      line: new Float64Array(T.N), kl: new Float64Array(T.N), len: new Float64Array(T.N), vprof: new Float64Array(T.N),
      s: 0, lap: 0, dist: 0, v: 0, d: 0, dev: 0, devV: 0, devTarget: 0, targetAbs: 0,
      a: 0, alat: 0, lock: 0, throttle: 0, brake: 0, gear: 1, rpm: 0, steer: 0, yaw: 0, slide: 0, pitch: 0, roll: 0, psi: 0, beta: 0, exec: 1,
      state: 'garage', inPit: true, pitPhase: 'box', pitT: 0, pitReq: false, stopTime: 0, stops: 0,
      tyre: { c: 'M', wear: 0, temp: 0.4, age: 0, used: new Set() }, fuel: 20, dmg: 0, parts: { fw: 0, rw: 0, susp: 0 },
      drs: false, drsOk: false, mode: 'free', target: null, defMoved: false, dive: 0, squeeze: 0,
      mistake: null, off: 0, retired: false, finished: false, finishT: 0,
      lapStart: 0, sectorStart: 0, curSectors: [0, 0, 0], sector: 0, lastLap: 0, best: Infinity, bestSec: [Infinity, Infinity, Infinity], laps: [],
      lapClean: true, lapKind: 'out', runLaps: 0, plan: null, lapCP: [], cpK: -1, delta: null,
      cpt: [], zoneIn: -1, zoneT0: 0, zoneClean: true, zoneMist: false, cand: null,
      pos: 0, gridPos: 0, lastPos: 0, thinkT: this.rng() * 0.1, wobble: 1, muPlan: MU,
      hist: [], // posiciones en carrera por vuelta
      stats: { ot: 0, lost: 0 },
    };
    ensureWet(car.brain, drv, this.rng); car.kb = car.brain;
    this.rebuildLine(car);
    return car;
  }

  rebuildLine(car) {
    car.work = Float64Array.from(car.kb.nodes); car.cand = null; car.candNext = null; car.alt = null;
    buildLine(this.T, { nodes: car.work }, car.line);
    lineGeometry(this.T, car.line, car.kl, car.len);
    this.rebuildProfile(car);
  }

  // compromiso con el que va a atacar la zona z (el candidato que esté probando, si lo hay)
  commitAt(car, z) {
    if (car.cand && car.cand.z === z) return car.cand.commit;
    if (car.candNext && car.candNext.z === z) return car.candNext.commit;
    return car.kb.commit[z];
  }

  // Lo que el piloto cree que agarra el coche ahora (sabe su neumático, no el agarre real)
  plannedMu(car) {
    return MU * this.gripK(car) * this.paceG(car) * (1 + 0.018 * (car.drv.pace - 0.88)) * this.tyreGrip(car, true) * this.evoFactor() * (1 - 0.00035 * car.fuel) * this.wxCare(car);
  }
  // prudencia con condiciones cambiantes: si le cae agua encima con lisos, o la pista está a medio secar, levanta algo
  wxCare(car) {
    const W = this.wx; if (!W || (W.rain < 0.02 && W.wet < 0.02)) return 1;
    if (COMPOUNDS[car.tyre.c].wet) return 1;
    const unc = Math.max(Math.min(1, W.rain * 2.5) * (1 - Math.min(1, (car.wetEst || 0) * 2.5)), Math.min(1, (W.wet - W.line) * 2.5) * 0.6);
    // con lisos y la pista ya mojada sabe que hay charcos: deja margen (hasta un ~8 %)
    const pud = Math.min(1, Math.max(0, (car.wetEst || 0) - 0.08) * 3.5);
    return (1 - 0.017 * unc * (1.2 - 0.6 * car.drv.agg)) * (1 - 0.08 * pud * (1.15 - 0.4 * car.drv.agg));
  }
  evoFactor() { return 0.986 + 0.014 * (1 - Math.exp(-this.evo / 350)); }

  tyreGrip(car, known) {
    const t = car.tyre, C = COMPOUNDS[t.c];
    let g = C.grip * (1 - 0.07 * t.wear) * wetGrip(t.c, known ? car.wetEst ?? 0 : this.wetAt(car));
    if (t.wear > 0.72) g *= Math.max(0.72, 1 - (t.wear - 0.72) * 1.15);
    if (t.flat) g *= 1 - 0.025 * t.flat;                          // goma cuadrada por un bloqueo
    const temp = Math.min(1, t.temp + (known ? 0.02 : 0));
    g *= 0.9 + 0.1 * temp;
    return g;
  }

  // Perfil de velocidad planificado (límite en curva + frenada hacia atrás). zone: recálculo local.
  rebuildProfile(car, zone = null) {
    const T = this.T, N = T.N, v = car.vprof, kl = car.kl, len = car.len;
    const mu0 = this.plannedMu(car);
    car.muPlan = mu0;
    const aero = AERO * this.aeroK(car), drag = CD * this.dragK(car) / (MASS + car.fuel);
    const muAt = (i) => { const z = T.zoneOf[i]; return z < 0 ? mu0 : mu0 * this.commitAt(car, z); };
    let i0 = 0, cnt = N, passes = 2;
    if (zone) { i0 = T.idx(zone.a - 700); cnt = Math.min(N, Math.round(zone.len + 760)); passes = 1; }
    for (let q = 0; q < cnt; q++) { const i = (i0 + q) % N; v[i] = vCorner(kl[i], muAt(i), aero); }
    for (let pass = 0; pass < passes; pass++) {
      for (let q = cnt - 1; q >= 0; q--) {
        const i = (i0 + q) % N;
        const n = (i + 1) % N; const vn = v[n];
        const cap = muAt(i) * (G + aero * vn * vn);
        const dec = BRK * cap * ellipse(vn * vn * Math.abs(kl[i]) / cap) + drag * vn * vn;
        const lim = Math.sqrt(vn * vn + 2 * dec * len[i]);
        if (lim < v[i]) v[i] = lim;
      }
    }
  }

  // ---------------------------------------------------------------- sesiones
  startSession(id) {
    const T = this.T;
    this.session = { id, ...SESSIONS[id], phase: 'run', t0: 0, done: false };
    if (isFP(id) && this.fpDur) this.session.dur = this.fpDur;   // libres más cortas (opción de la portada)
    this.gravel = []; this.barrierHits = [];
    this.autoMgr = false;   // «Saltar»: los equipos del mánager los lleva la IA hasta el final de la sesión (ver mgrHand)
    this.t = 0; this.flag = 'GREEN'; this.vscT = 0; this.vscEnd = false; this.initWeather(id); this.fastest = null; this.sessionBestSec = null; this.zoneBest = null; this.bestCP = null;
    const isRace = id === 'RACE';
    const active = this.activeCars(id);
    for (const car of this.cars) {
      car.best = Infinity; car.bestSec = [Infinity, Infinity, Infinity]; car.laps = []; car.lastLap = 0;
      car.cpt = []; car.hist = []; car.finished = false; car.stops = 0; car.passedBy = null; car.dmg = 0; car.parts = { fw: 0, rw: 0, susp: 0 }; car.mistake = null; car.off = 0;
      car.zoneIn = -1; car.planned = -1; car.mode = 'free'; car.drs = false; car.slide = 0; car.v = 0; car.dev = 0; car.devV = 0; car.psi = 0; car.beta = 0; car.excursion = false;
      car.wetEst = this.wx.wet; car.wxC = null; car.wxPit = false; car.wxBias = null; this.pickKB(car);
      car.sector = 0; car.sectorStart = this.t; car.curSectors = [0, 0, 0]; car.prevSectors = []; car.secCol = []; car.prevSecCol = []; car.delta = null; car.deltaOwn = null; car.bestCP = null;   // (antes arrastraba los sectores de la sesión anterior: S1 negativo)
      car.ers = 1; car.lapW0 = 0;
      car.stats = { ot: 0, lost: 0 }; car.runLaps = 0; car.pitReq = false; car.devTarget = 0; car.retired = false; car.otTry = null; car.parked = false; car.parkSide = 0;
      car.out = !active.includes(car);
      if (isRace) {
        // la parrilla la marca el orden de clasificación
      } else {
        car.state = 'garage'; car.inPit = true; car.pitPhase = 'box';
        const box = T.pit.boxes[TEAMS.indexOf(car.team)];
        car.s = box.s + (car.drv === DRIVERS.find((d) => d.team === car.team.id) ? 5 : -5); car.d = T.pit.d - 9; car.lap = 0;
        car.tyre = { c: 'M', wear: 0, temp: 0.4, age: 0, used: new Set() };
        car.fuel = 30;
        car.plan = car.mgr ? null : this.makePlan(car, id);
        if (car.mgr) { car.mgr.go = null; car.mgr.boxReq = false; }
      }
    }
    for (const car of this.cars) this.rebuildLine(car);
    if (isRace) this.setupGrid();
    this.emit({ type: 'session', id });
  }

  activeCars(id) {
    if (!this.qualiOrder) this.qualiOrder = this.cars.slice();
    if (id === 'Q2') return this.qualiOrder.slice(0, 16);
    if (id === 'Q3') return this.qualiOrder.slice(0, 10);
    return this.cars.slice();
  }

  // ¿las decisiones de este coche las toma el mánager? (no mientras se salta la sesión: entonces lo lleva la IA)
  mgrHand(car) { return !!car.mgr && !this.autoMgr; }
  // plan de la IA para un coche del mánager a mitad de sesión (al darle a «Saltar»)
  autoPlan(car) {
    const id = this.session.id, p = this.makePlan(car, id);
    // clasificación con tiempo ya marcado: solo queda la salida final
    if (!isFP(id) && isFinite(car.best)) p.idx = 1;
    return p;
  }
  makePlan(car, id) {
    const r = this.rng;
    if (isFP(id)) {
      // tandas: aprender, simulación de clasificación, tanda larga
      const first = 5 + r() * 90;
      return {
        runs: [
          { c: 'M', laps: 6 + Math.floor(r() * 3), fuel: 40, go: first, kind: 'learn' },
          { c: 'S', laps: 2, fuel: 15, go: 0, kind: 'quali' },
          { c: r() < 0.5 ? 'H' : 'M', laps: 7 + Math.floor(r() * 3), fuel: 60, go: 0, kind: 'long' },
          { c: 'S', laps: 4, fuel: 35, go: 0, kind: 'long' },
          { c: 'M', laps: 30, fuel: 40, go: 0, kind: 'learn' },
        ], idx: 0, gap: 20 + r() * 35,
      };
    }
    const dur = SESSIONS[id].dur;
    // clasificación: 2 salidas (hasta 2 vueltas lanzadas en la primera); la segunda, al final, con la pista mejor
    return {
      runs: [
        { c: 'S', laps: 2, fuel: 14, go: 8 + r() * (id === 'Q3' ? 50 : 90), kind: 'quali' },
        { c: 'S', laps: 1, fuel: 9, go: dur - 230 - r() * 40, kind: 'quali' },
      ], idx: 0,
    };
  }

  setupGrid() {
    const T = this.T;
    const order = this.qualiOrder || this.cars.slice();
    order.forEach((car, p) => {
      const g = T.grid[p];
      car.state = 'grid'; car.inPit = false; car.yaw = 0; car.psi = 0; car.beta = 0; car.slide = 0; car.devV = 0; car.steer = 0; car.pitch = 0; car.roll = 0; car.mistake = null; car.s = g.s; car.d = g.d; car.dPrev = g.d; car.vs = null; car.dev = g.d - car.line[T.idx(g.s)]; car.devTarget = car.dev;
      car.targetAbs = g.d; car.gridD = g.d; car.v = 0; car.lap = -1; car.dist = car.s - T.L; car.gridPos = p + 1; car.pos = p + 1; car.lastPos = p + 1;
      car.fuel = 100; car.retired = false; car.out = false; car.lapKind = 'race'; car.mode = 'free';
      car.strategy = this.chooseStrategy(car);
      const wc = idealTyre(this.wx.wet + (this.wx.target > 0.3 ? 0.08 : 0));
      if (wc) car.strategy.stints = [{ c: wc, from: 0, to: this.raceLaps }];
      const dr = car.mgr?.draft;
      if (dr && dr.length && dr[dr.length - 1].to === this.raceLaps) car.strategy.stints = dr.map((x) => ({ ...x }));
      car.tyre = { c: car.strategy.stints[0].c, wear: wc ? 0 : car.qualiWear ?? 0.05, temp: 0.75, age: wc ? 0 : 1, used: new Set([car.strategy.stints[0].c]) };
      car.stint = 0; car.lapW0 = car.tyre.wear;
      if (car.mgr) { car.mgr.stopNow = false; car.mgr.stopsLog = []; car.mgr.plan0 = car.strategy.stints.map((x) => ({ ...x })); }
      car.lapStart = 0; car.sector = 0; car.sectorStart = 0;
      this.rebuildProfile(car);
    });
    this.raceOrder = order.slice();
    this.session.phase = 'grid'; this.lights = 0; this.lightsT = 0; this.lightsOut = 3 + 5 + this.rng() * 2.2;
  }

  // Estrategia: combina degradación que ha medido el piloto con la previa del equipo
  chooseStrategy(car) {
    const laps = this.raceLaps, r = this.rng;
    const baseDeg = { S: 0.22, M: 0.12, H: 0.075 };
    const slope = {}; for (const c of 'SMH') slope[c] = degSlope(car.brain, c, baseDeg[c] * 20 / laps);
    const pace = { S: 0, M: 0.5, H: 0.9 };
    const life = { S: 0.42, M: 0.72, H: 1.1 }; // fracción de carrera antes del precipicio
    const pitLoss = 21;
    const cands = [];
    const HARD = { S: 0, M: 1, H: 2 }, warm = { S: 0.4, M: 0.8, H: 1.6 };   // (calentar la goma en la vuelta de salida)
    const add = (stints) => {
      let t = 0, ok = true;
      for (const st of stints) {
        const n = st.to - st.from;
        if (n > life[st.c] * laps + 1) ok = false;
        t += st.from > 0 ? warm[st.c] : 0;
        for (let a = 0; a < n; a++) t += pace[st.c] + slope[st.c] * a + (a > life[st.c] * laps * 0.9 ? 1.5 : 0);
      }
      // con criterio: la goma más dura nunca para la tanda más corta (nada de duros 6 vueltas y luego blandos 7)
      for (const x of stints) for (const y of stints) if (HARD[x.c] > HARD[y.c] && x.to - x.from < y.to - y.from + 1) ok = false;
      t += (stints.length - 1) * pitLoss;
      if (ok && new Set(stints.map((s) => s.c)).size >= 2) cands.push({ stints, t: t + gauss(r) * 3 * (1.2 - car.drv.cons) });
    };
    for (const a of 'SMH') for (const b of 'SMH') {
      for (let p = Math.round(laps * 0.3); p <= Math.round(laps * 0.72); p++) add([{ c: a, from: 0, to: p }, { c: b, from: p, to: laps }]);
    }
    for (const a of 'SM') for (const b of 'SMH') for (const c of 'SMH')
      for (let p1 = Math.round(laps * 0.25); p1 <= Math.round(laps * 0.4); p1++) for (let p2 = p1 + Math.round(laps * 0.25); p2 <= laps - Math.round(laps * 0.22); p2++)
        add([{ c: a, from: 0, to: p1 }, { c: b, from: p1, to: p2 }, { c: c, from: p2, to: laps }]);
    // variedad: se agrupan por tipo (compuestos y número de paradas) y cada piloto elige tipo según su carácter
    // (los agresivos tiran a blandos y dos paradas; los constantes, a duros y una), no solo el más rápido
    const types = new Map();
    for (const c of cands) {
      const k = c.stints.map((x) => x.c).join('-');
      if (!types.has(k)) types.set(k, []);
      types.get(k).push(c);
    }
    const agg = car.drv.agg - 0.6, cons = car.drv.cons - 0.8, teamB = ((car.team.id || '').charCodeAt(0) % 5 - 2) * 0.6;
    let tBest = Infinity; for (const c of cands) tBest = Math.min(tBest, c.t);
    const opts = [];
    for (const [k, list] of types) {
      list.sort((x, y) => x.t - y.t);
      // dentro del tipo, una de las buenas (la vuelta de parada varía)
      const c = list[Math.min(list.length - 1, Math.floor(r() * Math.min(5, list.length)))];
      const nS = (k.match(/S/g) || []).length, nH = (k.match(/H/g) || []).length, stops = c.stints.length - 1;
      const taste = (nS * 1.5 + (stops - 1) * 2) * agg * 6 + nH * cons * 20 + (stops - 1) * teamB - (c.t - tBest) / 3.5;
      opts.push({ c, w: Math.exp(taste + gauss(r) * 0.7) });
    }
    let sum = 0; for (const o of opts) sum += o.w;
    let x = r() * sum, pick = null;
    for (const o of opts) { x -= o.w; if (x <= 0) { pick = o.c; break; } }
    pick = pick || opts[0]?.c || { stints: [{ c: 'M', from: 0, to: Math.round(laps / 2) }, { c: 'H', from: Math.round(laps / 2), to: laps }] };
    return { stints: pick.stints.map((s) => ({ ...s })), est: pick.t };
  }

  // ---------------------------------------------------------------- tiempo: lluvia y agua en pista
  // mode: 'dry' | 'mixed' | 'wet' | 'random'. Guion de la sesión: momentos en que cambia la intensidad de la lluvia.
  initWeather(id) {
    const r = this.rng, mode = this.weatherMode || 'random';
    const dur = id === 'RACE' ? this.raceLaps * 95 : SESSIONS[id].dur;
    let kind = mode;
    if (mode === 'random') { const x = r(), dry = this.T.meta?.autumn ? 0.6 : this.T.meta?.coast ? 0.9 : 0.82; kind = x < dry ? 'dry' : x < dry + (1 - dry) * 0.72 ? 'mixed' : 'wet'; }
    // en el bosque el chubasco no cubre todo el circuito: un núcleo que se desplaza despacio a lo largo de la vuelta
    this.cell = this.T.meta?.autumn ? { s0: r() * this.T.L, v: (r() < 0.5 ? -1 : 1) * this.T.L / (1500 + r() * 1500) } : null;
    const ev = [];
    if (kind === 'wet') {
      ev.push({ t: 0, rain: 0.45 + r() * 0.5 });
      if (r() < 0.55) ev.push({ t: dur * (0.3 + r() * 0.4), rain: r() * 0.2 });
    } else if (kind === 'mixed') {
      const a = dur * (0.12 + r() * 0.4);
      ev.push({ t: 0, rain: 0 }, { t: a, rain: 0.3 + r() * 0.65 }, { t: a + dur * (0.18 + r() * 0.3), rain: r() < 0.6 ? 0 : 0.12 });
    } else ev.push({ t: 0, rain: 0 });
    const w0 = kind === 'wet' ? Math.min(1, ev[0].rain * 1.1) : 0;
    this.wx = { kind, ev, next: 1, rain: ev[0].rain, target: ev[0].rain, wet: w0, line: w0, noDRS: w0 > 0.3 };
  }

  updateWeather() {
    const W = this.wx;
    while (W.next < W.ev.length && this.t >= W.ev[W.next].t) {
      const prev = W.target; W.target = W.ev[W.next++].rain;
      this.emit({ type: 'weather', what: W.target > prev + 0.05 ? (prev < 0.05 ? 'rainStart' : 'rainMore') : W.target < 0.05 ? 'rainStop' : 'rainLess' });
    }
    W.rain += (W.target - W.rain) * DT / 45;
    // agua: la lluvia moja rápido; seca despacio, y la trazada antes (los coches la barren)
    const eq = Math.min(1, W.rain * 1.12);
    const traffic = this.session.id === 'RACE' ? 1.6 : 1;
    W.wet += (eq - W.wet) * DT / (eq > W.wet ? 70 : 440);
    W.line += (eq - W.line) * DT / (eq > W.line ? 70 : 330 / traffic);
    if (W.line > W.wet) W.line = W.wet;
    const nd = W.line > 0.3 || (W.noDRS && W.line > 0.2);
    if (nd !== W.noDRS) { W.noDRS = nd; this.emit({ type: 'weather', what: nd ? 'drsOff' : 'drsOn' }); }
  }
  // agua donde pisa el coche: por la trazada seca antes; fuera de ella, más charcos
  wetAt(car) {
    const W = this.wx; if (!W || W.wet < 1e-3) return 0;
    const off = Math.min(1, Math.max(0, (Math.abs(car.dev || 0) - 1.8) / 3));
    return Math.min(1, (W.line + (W.wet - W.line) * off) * this.puddle(car.s) * this.rainCell(car.s));
  }
  // nodo j de n de una trazada, dentro de la pista (su anchura en ese punto)
  clampN(j, n, v) { const T = this.T, lim = Math.min(LIMN, T.hwAt(j * T.L / n) - CAR_HALF - 0.25); return Math.max(-lim, Math.min(lim, v)); }
  // cuánta agua hay en s respecto a la media de la vuelta (1 en todos los circuitos menos el bosque): entre 0,5 y 1,8,
  // con media ~1, así que el piloto (que estima por la media) llega al núcleo del chubasco con más agarre del que hay
  rainCell(s) {
    const C = this.cell; if (!C) return 1;
    const L = this.T.L, c = ((C.s0 + C.v * this.t) % L + L) % L;
    let d = Math.abs(s - c); d = Math.min(d, L - d);
    const w = 0.22 * L; return 0.5 + 1.3 * Math.exp(-(d / w) * (d / w));
  }
  // charcos y ríos: en unas pocas curvas (distintas cada sesión) se acumula más agua de la que el piloto espera
  // por lo que ve en el resto de la pista; ahí es donde se sale o hace un trompo
  puddle(s) {
    const T = this.T, z = T.zoneOf[T.idx(s)]; if (z < 0) return 1;
    if (this.pudSess !== this.session) {
      this.pudSess = this.session; let r = (this.seed || 1) * 7919 + (this.session?.id || '').length * 104729 + Math.floor(this.t);
      const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
      this.pud = T.zones.map(() => { const u = rnd(); return u < 0.2 ? 1.14 + 0.14 * rnd() : u < 0.45 ? 1.05 : 0.96; });
    }
    return this.pud[z];
  }
  // lo que el piloto cree que hay de agua (le llega con retraso; los agresivos la subestiman) y si cambia de gomas
  senseWet(car) {
    if (car.inPit) return;                                      // en el pit lane no se ve cómo está la pista
    // lo que hay en la trazada (fuera de ella lo ve: ver offWet)
    const real = this.wx.line;
    // (con lisos sobre agua lo nota enseguida: la goma no agarra)
    const lag = (4 + 14 * (1 - car.drv.cons)) * (!COMPOUNDS[car.tyre.c].wet && real > 0.2 ? 0.5 : 1);
    car.wetEst += (real * (1 - 0.16 * (car.drv.agg - 0.6)) - car.wetEst) * 0.1 / lag;
    if (this.pickKB(car)) return;
    if ((this.wx.wet > 0.005 || car.wetEst > 0.005) && Math.abs(this.plannedMu(car) - car.muPlan) > car.muPlan * 0.012) this.rebuildProfile(car);
  }
  // seco o mojado: cambia de «memoria» (trazada y compromiso por curva) cuando cree que ha cambiado la pista
  pickKB(car) {
    const wet = car.kb !== car.brain, est = car.wetEst || 0;
    if (wet ? est > 0.18 : est < 0.3) return false;
    car.kb = wet ? car.brain : ensureWet(car.brain, car.drv, this.rng);
    this.rebuildLine(car);
    return true;
  }
  // agarre que espera fuera de la trazada respecto a sobre ella (ve que hay más agua; se queda algo corto)
  offWet(car, dev) {
    const W = this.wx; if (W.wet - W.line < 0.02) return 1;
    const off = Math.min(1, Math.max(0, (Math.abs(dev) - 1.8) / 3)); if (off <= 0) return 1;
    const est = car.wetEst || 0;
    return wetGrip(car.tyre.c, est + (W.wet - W.line) * off * 0.95) / wetGrip(car.tyre.c, est);
  }
  // la otra memoria (para lo poco que pasa de una a otra)
  otherKB(car) { return car.kb === car.brain ? car.brain.wet : car.brain; }
  // ¿cambiar de neumático por el agua? null = no; 'I' / 'W' / 'slick'
  wxTyre(car) {
    const W = this.wx, c = car.tyre.c, wet = COMPOUNDS[c].wet;
    // cada piloto (y cada carrera) apuesta distinto: unos paran a la primera gota, otros aguantan con lisos
    // (y cada equipo tiene su tendencia: unos muro arriesgan siempre, otros van a lo seguro)
    if (car.wxBias == null) car.wxBias = gauss(this.rng) * 0.11 + (((car.team.id || '').charCodeAt(1) % 5) - 2) * 0.04;
    // y cada muro lee el radar a su manera: cuánto pesa lo que viene (más lluvia o que pare) frente a lo que hay ya
    if (car.wxRead == null) car.wxRead = 0.1 + 0.5 * this.rng();
    const est = car.wetEst + (W.target - W.rain) * car.wxRead;
    // (acotado: con un sesgo grande el umbral salía negativo y en seco pedía intermedios tras la vuelta de salida)
    const brave = Math.max(-1.2, Math.min(1.2, car.drv.agg - 0.7 + car.wxBias / 0.1));
    // a gomas de agua: con poca agua la decisión es dudosa y los umbrales se separan más (unos paran a la primera, otros
    // aguantan con lisos si creen que para); antes casi todos entraban en la misma vuelta
    const easing = W.target < W.rain - 0.05 ? 0.08 * Math.max(0, brave) : 0;
    if (!wet && est > Math.max(0.12, Math.min(0.5, 0.26 + 0.17 * brave + easing))) return est > 0.85 ? 'W' : 'I';
    // de intermedio a lluvia (y vuelta) cuesta una parada: solo si queda carrera para amortizarla, y muchos aguantan
    const left = this.session.id === 'RACE' ? this.raceLaps - car.lap : 99;
    if (c === 'I' && est > 0.9 + 0.1 * brave && left > 6) return 'W';
    if (c === 'W' && est < 0.6 - 0.08 * brave && left > 3) return 'I';
    if (wet && est < 0.15 + 0.07 * brave && W.target < 0.1) return 'slick';
    return null;
  }

  // ---------------------------------------------------------------- bucle principal
  step() {
    const ss = this.session; if (!ss || ss.done) return;
    if (this.gridHold && ss.id === 'RACE' && ss.phase === 'grid') return;   // mánager: la parrilla espera a que dé la salida
    this.t += DT;
    const T = this.T;
    this.updateWeather();
    if (ss.id === 'RACE') this.raceControl(); else this.practiceControl();
    if (this.vscT > 0) {
      this.vscT -= DT;
      // como en la F1: aviso de «VSC terminando» y verde unos segundos después (sigue prohibido adelantar hasta la verde)
      if (this.vscT <= 10 && !this.vscEnd) { this.vscEnd = true; this.emit({ type: 'vscEnding' }); }
      if (this.vscT <= 0) { this.flag = 'GREEN'; this.emit({ type: 'flag', flag: 'GREEN' }); }
    }
    const cars = this.cars;
    // vuelta que no sirve de referencia (neutralizada o con paso por boxes): fuera de la gráfica de aprendizaje y de la degradación
    { const neutral = this.flag !== 'GREEN'; for (const c of cars) if (neutral || c.inPit) c.lapFlag = true; }
    this.buildNeighbors();
    // tiempo de la vuelta pegado al de delante (a menos de ~0,8 s): en carrera, si es mucho, la vuelta es de tráfico, no de ritmo
    // (solo si va en su misma línea: aire sucio o le frena; uno al lado apartándose para dejarle pasar no es tráfico)
    for (const c of cars) { const n0 = c.nb[0]; if (n0 && !c.inPit && n0.rel < Math.max(15, c.v * 0.8) && Math.abs(n0.o.d - c.d) < 2.6) c.trafT = (c.trafT || 0) + DT; if (c.mode === 'yield' && !c.inPit) c.yieldT = (c.yieldT || 0) + DT; }
    // vecinos (distancia relativa en pista) una vez por paso
    for (const car of cars) {
      if (car.out || car.state === 'garage') continue;
      car.thinkT -= DT;
      if (car.thinkT <= 0) { car.thinkT = 0.1; this.think(car); }
    }
    for (const car of cars) {
      if (car.out || car.state === 'garage' || car.state === 'grid') continue;
      this.physics(car);
    }
    this.collide();
    if (ss.id === 'RACE') this.updateOrder();
  }

  // lista de coches cercanos (-80 m .. +210 m) de cada coche, con el orden en pista
  buildNeighbors() {
    const T = this.T;
    const act = this.sorted || (this.sorted = []);
    act.length = 0;
    for (const c of this.cars) { if (!c.nb) c.nb = []; c.nb.length = 0; if (live(c)) act.push(c); }
    act.sort((a, b) => a.s - b.s);
    const n = act.length;
    for (let k = 0; k < n; k++) {
      const c = act[k];
      for (let j = 1; j < n; j++) {
        const o = act[(k + j) % n]; const rel = T.ahead(c.s, o.s);
        if (rel > 210) break;
        c.nb.push({ o, rel });
      }
      for (let j = 1; j < n; j++) {
        const o = act[(k - j + n) % n]; const rel = -T.ahead(o.s, c.s);
        if (rel < -80) break;
        if (c.nb.some((e) => e.o === o)) break;
        c.nb.push({ o, rel });
      }
    }
  }

  // ------------------------------------------------------------ control de sesión
  practiceControl() {
    const ss = this.session;
    const over = this.t >= ss.dur;
    if (over && ss.phase === 'run') { ss.phase = 'flag'; this.emit({ type: 'chequered' }); }
    let anyOut = false;
    for (const car of this.cars) {
      if (car.out) continue;
      if (car.retired) {
        // en libres/clasificación la grúa lo devuelve al garaje
        if (this.t - car.retiredT > 25) {
          car.retired = false; car.parked = false; car.parkSide = 0; this.enterGarage(car);
          if (!isFP(ss.id) && car.plan) car.plan.idx = 99;
        }
        continue;
      }
      if (car.state !== 'garage') { anyOut = true; continue; }
      if (this.mgrHand(car)) {
        const go = car.mgr.go;
        if (go && !over) { this.leaveGarage(car, go); car.mgr.go = null; }
        continue;
      }
      if (!car.plan && car.mgr) car.plan = this.autoPlan(car);
      const p = car.plan; if (!p || over) continue;
      const run = p.runs[p.idx]; if (!run) continue;
      if (run.go === 0) run.go = this.t + (p.gap ?? 30) + this.rng() * 40;
      const left = ss.dur - this.t;
      if (left < 105) continue;
      // clasificación: solo sale si le da tiempo a la vuelta de salida y a empezar la lanzada antes de la bandera
      if (!isFP(ss.id) && left < (isFinite(car.best) ? car.best : this.T.L / 62) * 1.18 + 10) continue;
      // en clasificación, si no sale ya no le da tiempo; y sin tiempo marcado, sale antes
      const late = !isFP(ss.id) && p.idx === p.runs.length - 1 && (left < 200 || (!isFinite(car.best) && this.t > run.go - 150));
      if (this.t >= run.go || late) this.leaveGarage(car, run);
    }
    if (ss.phase === 'flag' && !anyOut) this.endSession();
  }

  leaveGarage(car, run) {
    car.sector = 0; car.sectorStart = this.t; car.curSectors = [0, 0, 0];
    const T = this.T;
    const wc = idealTyre(car.wetEst = this.wx.wet);
    if (this.mgrHand(car)) { /* goma que elige el mánager */ } else if (wc) run = { ...run, c: wc }; else if (COMPOUNDS[run.c].wet) run = { ...run, c: 'S' };
    const fresh = this.mgrHand(car) ? run.fresh || car.tyre.c !== run.c : run.kind === 'quali' || car.tyre.c !== run.c || car.tyre.wear > 0.5;
    if (fresh) car.tyre = { c: run.c, wear: 0, temp: 0.55, age: 0, used: car.tyre.used };
    car.tyre.used.add(run.c);
    car.fuel = run.fuel; car.run = run; car.runLaps = 0; car.runGood = false;
    car.state = 'track'; car.inPit = true; car.pitPhase = 'out'; car.d = T.pit.d - 3.5; car.v = 0; car.psi = 0; car.beta = 0;
    const box = T.pit.boxes[TEAMS.indexOf(car.team)]; car.s = box.s;
    car.lapKind = 'out'; car.lapClean = false; car.pitReq = false; car.lapW0 = car.tyre.wear; car.pushN = 0; car.testRun = !!(this.mgrHand(car) && run.test);
    this.rebuildProfile(car);
    this.emit({ type: 'leave', car });
  }

  endSession() {
    const ss = this.session; ss.done = true; ss.phase = 'done';
    const cls = this.classification();
    if (ss.id.startsWith('Q')) {
      if (ss.id === 'Q1') this.qualiOrder = cls.slice();
      else {
        const top = cls.slice(0, ss.id === 'Q2' ? 16 : 10);
        this.qualiOrder = top.concat(this.qualiOrder.slice(top.length));
      }
      const cut = SESSIONS[ss.id].cut;
      if (cut) for (const car of cls.slice(cut)) this.emit({ type: 'knockout', car });
    }
    for (const car of this.cars) {
      if (isFinite(car.best)) car.brain.bestHist.push({ w: this.weekend, s: ss.id, t: car.best });
      if (car.brain.bestHist.length > 60) car.brain.bestHist.shift();
    }
    this.emit({ type: 'sessionEnd', id: ss.id, cls });
  }

  raceControl() {
    const ss = this.session;
    if (ss.phase === 'grid') {
      if (this.t > 3) { ss.phase = 'lights'; this.lightsT = this.t; }
      return;
    }
    if (ss.phase === 'lights') {
      const el = this.t - this.lightsT;
      const n = Math.min(5, Math.floor(el));
      if (n !== this.lights && el < 5.5) { this.lights = n; this.emit({ type: 'light', n }); }
      if (el >= this.lightsOut - 3) {
        ss.phase = 'green'; this.lights = 0; this.raceStart = this.t;
        for (const car of this.cars) {
          if (car.out) continue;
          car.state = 'track'; car.react = Math.max(0.12, 0.2 + gauss(this.rng) * 0.05 + (0.9 - car.drv.cons) * 0.15);
          car.launch = Math.min(1.05, 0.93 + this.rng() * 0.08 + car.drv.cons * 0.04); car.lapStart = this.t; car.sectorStart = this.t;
        }
        this.emit({ type: 'start' });
      }
      return;
    }
    if (ss.phase === 'green' || ss.phase === 'flag') {
      const running = this.cars.filter((c) => !c.out && !c.retired && !c.finished);
      if (ss.phase === 'flag' && running.length === 0) this.endSession();
      if (ss.phase === 'flag' && this.t - this.flagT > 150) { for (const c of running) c.finished = true; this.endSession(); }
    }
  }

  // --------------------------------------------------------------------- IA táctica
  think(car) {
    const T = this.T, ss = this.session;
    if (car.retired || car.state === 'grid') return;
    this.senseWet(car);
    const race = ss.id === 'RACE';
    const i = T.idx(car.s);
    if (race && this.mgrHand(car) && car.strategy) this.mgrPit(car);
    if (car.inPit) return;
    const P = Math.max(15, Math.min(55, car.v * 0.8));
    const sP = car.s + P; const lineP = car.line[T.idx(sP)];
    const nc = T.corners[T.nextCorner[i]];
    const toCorner = T.ahead(car.s, nc.sIn);
    const brakeDist = Math.max(40, (car.v * car.v - 900) / (2 * 38));
    const inside = nc.dir;
    const onStraight = T.zoneOf[i] < 0 || toCorner > brakeDist + 80;
    const vsc = this.flag !== 'GREEN';

    // vecinos
    const near = [];
    for (const { o, rel } of car.nb) {
      if (o.inPit && Math.abs(o.d) > HALF_W + 1) continue;
      if (rel > -60 && rel < 160) near.push({ o, rel });
    }
    // ceder: doblados y vueltas lentas frente a vueltas rápidas
    let yieldTo = null;
    for (const { o, rel } of near) {
      if (rel > -5 || rel < -140) continue;
      const lapping = race && o.dist - car.dist > T.L * 0.5;
      // libres/clasificación: cede el que no va en vuelta rápida, el que ya la ha estropeado o el que la lleva bastante peor
      const worse = car.lapKind === 'push' && (!car.lapClean || (o.lapClean && car.delta != null && o.delta != null && car.delta > o.delta + 0.8));
      const fightM = car.mgr?.fight;
      // (mánager: con pelea agresiva no cede en libres ni en clasificación; prudente se aparta ante cualquiera que llegue lanzado)
      const slowLap = !race && fightM !== 'hard' && o.lapKind === 'push' && (car.lapKind !== 'push' || worse || (fightM === 'calm' && o.v > car.v + 2));
      // órdenes de equipo (mánager): deja pasar al compañero que viene detrás
      // (una orden por equipo: en multijugador hay varios muros)
      const swap = race && this.teamOrders?.[car.team.id]?.yield === car && o.team === car.team && rel > -60;
      // libres: se apartan para el coche del mánager que viene lanzado en modo consistente (si no, ~45 % de sus vueltas con tráfico)
      const courtesy = !race && !car.mgr && o.testRun && o.lapKind === 'push' && rel > -110;
      if (courtesy && o.v > car.v - 8) { yieldTo = o; break; }
      if ((lapping || slowLap || swap) && o.v > car.v - 4) { yieldTo = o; break; }
    }
    // atacar
    let tgt = null;
    // órdenes de equipo «mantener posiciones»: no ataca al compañero
    const hold = race && car.mgr && this.teamOrders?.[car.team.id]?.hold;
    for (const { o, rel } of near) {
      if (rel <= 0 || rel > 110) continue;
      if (hold && o.team === car.team) continue;
      if (!tgt || rel < tgt.rel) tgt = { o, rel };
    }
    const fight = car.mgr ? MGR.fight[car.mgr.fight] : MGR.fight.normal;
    car.mode = 'free'; car.target = null; car.dive = 0; car.squeeze = 0; car.gripAdv = 1;
    if (yieldTo && !vsc) car.mode = 'yield';   // con VSC no se adelanta, tampoco para doblar
    else if (tgt && !vsc && car.mistake == null) {
      const o = tgt.o; const gapT = tgt.rel / Math.max(20, car.v);
      const faster = car.v - o.v;
      const lap1 = race && car.lap < 1 && this.t - this.raceStart < 35;
      // al que le acaba de pasar no le ataca enseguida salvo que sea claramente más rápido (nada de devolvérsela en la recta)
      const just = race && o === car.passedBy && this.t - car.passedT < 14 && faster < 4;
      // (libres/clasificación: con pelea agresiva del mánager se quita de encima a cualquiera algo más lento)
      const want = just ? false : race ? (lap1 ? gapT < 0.4 && faster > 1.5 : gapT < 1.0 && (faster > -1 || gapT < 0.5)) : (car.lapKind === 'push' && o.lapKind !== 'push') || (gapT < 0.6 && faster > 2) || (car.mgr?.fight === 'hard' && gapT < 1.2 && faster > 0.3);
      const zone = T.zones[nc.id];
      const ot = car.brain.ot[zone.id];
      const belief = (ot.w + 1) / (ot.t + 2);
      // ventaja clara de agarre (sobre todo en mojado: intermedios contra lisos): en curva va mucho más rápido y lo sabe
      const adv = race ? this.tyreGrip(car, true) / Math.max(0.3, this.tyreGrip(o, true)) : 1;
      car.gripAdv = adv;
      const willing = car.drv.agg * 0.55 + belief * 0.6 + (o.dmg > 0 ? 0.3 : 0) + (race && o.tyre.wear - car.tyre.wear) * 0.8 + Math.max(0, adv - 1) * 4 + fight.will;
      // en plena recta, con margen hasta la frenada y más velocidad que él: lo intenta ahí mismo aunque no se fíe de la curva
      // (las ganas dependían solo de cómo le había ido adelantando en la curva siguiente: se quedaba detrás toda la recta)
      const straightPass = race && !lap1 && !just && onStraight && toCorner > brakeDist + 180 && faster > 0.3 && gapT < 0.8;
      if ((want || (race && !lap1 && !just && adv > 1.06 && gapT < 1.2)) && (willing > 0.55 || !race || straightPass)) { car.mode = 'attack'; car.target = o; }
    }
    // plan de ataque para la próxima curva (se mantiene mientras se está en ella)
    const zNow = T.zoneOf[i];
    if (car.mode === 'attack') {
      const keep = car.atk && car.atk.o === car.target && (car.atk.z === nc.id || car.atk.z === zNow);
      if (!keep) car.atk = race ? this.choosePlan(car, nc) : { type: 'inside', z: nc.id, o: car.target };
      car.atk.o = car.target;
    } else if (!(car.atk && zNow === car.atk.z)) car.atk = null;
    car.exitBoost = 0; car.brakeEarly = 1; car.followGap = 0;
    const plan = car.atk?.type;
    if (car.atk && race) {
      const ac = T.corners[car.atk.z], az = T.zones[car.atk.z];
      const inAtk = zNow === car.atk.z;
      const pastApex = inAtk && T.ahead(ac.apex, car.s) < T.ahead(ac.apex, az.b);
      const approaching = !inAtk && T.ahead(car.s, ac.sIn) < brakeDist + 60;
      // por dentro / por fuera / cruce: cambia a la trazada alternativa que ha ido aprendiendo para esa curva
      if ((plan === 'inside' || plan === 'outside' || plan === 'cutback') && (!inAtk || !car.alt) && car.target &&
        (inAtk || T.ahead(car.s, az.a) < 260) && T.rel(car.s, car.target.s) < Math.max(25, car.v * 0.9)) this.setAlt(car, car.atk.z, plan);
      if (plan === 'cutback') { if (!car.alt && (approaching || (inAtk && !pastApex))) car.brakeEarly = 0.985; if (pastApex) car.exitBoost = 0.015; }
      if (plan === 'exit') { if (approaching || inAtk) car.followGap = car.v * 0.32; if (pastApex) car.exitBoost = 0.014; }
      car.atkPhase = pastApex ? 'exit' : inAtk || approaching ? 'corner' : 'setup';
    }
    if (car.alt && zNow !== car.alt.z && !(car.atk && car.atk.z === car.alt.z)) this.clearAlt(car);
    // defender
    if (race && car.mode !== 'yield' && !vsc && fight.def) {
      for (const { o, rel } of near) {
        if (rel < -45 || rel > -4) continue;
        if (o.mode === 'attack' && o.target === car && o.v >= car.v - 2) {
          // con mucha menos goma (lisos contra intermedios en mojado) no hay defensa posible: no cierra la puerta
          if (o.gripAdv > 1.12) continue;
          if (car.mode !== 'attack') car.mode = 'defend';
          car.attacker = o; break;
        }
      }
    }
    if (T.zoneOf[i] >= 0 && toCorner > 400) car.defMoved = false;

    // --- elección de carril
    const hwC = Math.min(T.hwAt(car.s), T.hwAt(car.s + 25)), lim = hwC - CAR_HALF - 0.15;
    const yMove = T.zoneOf[i] < 0 && toCorner > brakeDist + 40;   // ceder apartándose: solo en recta
    const wl = car.alt ? 0.1 : car.mode === 'attack' ? 0.03 : car.mode === 'defend' ? 0.05 : car.mode === 'yield' && yMove ? 0.015 : 0.12;
    // primera vuelta: el pelotón se ordena en fila en vez de ir tres en paralelo por toda la pista
    const lap1 = race && car.lap < 1 && this.raceStart != null && this.t - this.raceStart < 60;
    const wlx = lap1 && !car.alt ? Math.max(wl, 0.09) : wl;
    let best = 0, bestC = Infinity, bestK = 0, nK = 0;
    const LC = this.laneC || (this.laneC = new Float64Array(64));
    const curAbs = car.targetAbs;
    const rejoin = car.off > 0.2;
    // lado al que se aparta al ceder: se decide al empezar a ceder y se mantiene (la trazada cruza la pista por debajo)
    if (car.mode === 'yield') { if (!car.ySide || this.t - car.ySideT > 1) car.ySide = Math.sign(car.d - lineP) || 1; car.ySideT = this.t; }
    const ySide = car.ySide || 1;
    const zc = T.zoneOf[i] >= 0 ? T.corners[T.zoneOf[i]] : null;
    const fastC = race && !car.alt && zc && car.vprof[T.idx(zc.apex)] > 45;
    const startK = race && this.raceStart != null && car.gridD != null ? Math.max(0, 1 - (this.t - this.raceStart) / 4.5) : 0;
    for (let dc = -lim; dc <= lim + 1e-6; dc += 0.5) {
      let c = wlx * (dc - lineP) * (dc - lineP) + 0.03 * (dc - curAbs) * (dc - curAbs);
      if (Math.abs(dc) > hwC - 1.6) c += 1.2 * (Math.abs(dc) - (hwC - 1.6));
      if (car.mode === 'attack' && car.target && !car.alt) {
        const k = (1 + car.drv.craft) / hwC;
        const tgtSide = Math.sign(car.target.d - car.d) || 1;
        if ((plan === 'inside' || !plan) && toCorner < 320 && toCorner > 0) c -= 0.35 * inside * dc * k;
        else if (plan === 'outside' && (toCorner < 320 || car.atkPhase !== 'setup')) c += 0.35 * inside * dc * k;
        else if (plan === 'cutback') {
          if (car.atkPhase === 'exit') c -= 0.45 * -tgtSide * dc * k;            // cruzar por el lado contrario al rival
          else if (toCorner < 320) c += 0.2 * inside * dc * k;                   // entrar abierto, sin tirarse
        }
      }
      // ceder: apartarse de la trazada por el lado en el que ya va (no cruzar la pista entera delante del que llega)
      // (en la curva no: ahí sigue su trazada levantando el pie; apartarse al límite en plena curva lo sacaba de la pista)
      if (car.mode === 'yield' && yMove) c -= 0.35 * Math.max(0, ySide * (dc - lineP));
      // arrancada: cada uno sigue por su fila los primeros segundos y luego se va juntando
      if (startK > 0) c += 0.6 * startK * (dc - car.gridD) * (dc - car.gridD);
      for (const { o, rel } of near) {
        const dj = 0.5 * o.d + 0.5 * o.targetAbs;
        const g = Math.abs(dc - dj);
        if (Math.abs(rel) < LEN + 1.2) {
          if (Math.abs(dc - o.d) < SEP + 0.25) c += 400;
          if ((o.d - car.d) * (o.d - dc) < 0 && Math.abs(o.d - car.d) > 0.3) c += 400;
        } else if (rel > 0) {
          // con mucha más goma que él (intermedios contra lisos en mojado) no espera detrás: se pone al lado en la curva,
          // en un carril limpio (con solo SEP + 0,4 se quedaba medio solapado y el tope de seguir le frenaba igual)
          const clearAdv = car.mode === 'attack' && car.target === o && car.gripAdv > 1.06;
          // (pasando en recta: con un carril bien separado; medio solapado le seguía frenando el «no comérselo»)
          const wide = car.mode === 'attack' && car.target === o && onStraight && (car.passOut === o || rel < 12 + Math.max(0, car.v - o.v) * 3);
          if (g < SEP + (wide ? 1.3 : clearAdv && !onStraight ? 1.4 : 0.4)) {
            const closing = car.v - o.v;
            // en curva rápida, detrás y por su trazada (fuera de ella tenía que levantar: frenaba mucho siguiendo a otro)
            if (fastC && !clearAdv) c += 0.25 * (1 - Math.min(rel, 110) / 130);
            else if (car.mode === 'attack' && car.target === o) {
              // (con ventaja clara no se esconde al rebufo: en mojado no hay DRS y en recta los lisos corren igual; se abre antes)
              // en recta: al rebufo mientras está lejos; cuando ya se le echa encima (tendría que levantar), sale a pasarle en la
              // misma recta (antes se quedaba detrás hasta la frenada y lo intentaba todo con un «dive bomb» en la curva)
              // (una vez fuera, sigue fuera hasta la frenada: si no, al perder el rebufo volvía detrás y repetía toda la recta)
              const pullOut = onStraight && toCorner > brakeDist * 0.6 && (car.passOut === o || rel < 12 + Math.max(0, closing) * 3);
              if (pullOut) { car.passOutNext = o; c += 9 * (1 - Math.min(rel, 110) / 130); }
              else if (onStraight && toCorner > brakeDist + (clearAdv ? 260 : 110) && rel < 60) c -= clearAdv ? 0.3 : 1.2;
              else if ((plan === 'exit' || plan === 'cutback') && car.atkPhase !== 'exit' && !clearAdv) c += 0.3; // paciencia: detrás hasta la salida
              else c += 7 * (1 - Math.min(rel, 110) / 130);
            } else {
              c += (closing > 1.5 ? 4 : 0.4) * (1 - Math.min(rel, 130) / 140);
            }
          }
        } else if (rel < 0 && rel > -45) {
          if (car.mode === 'defend' && o === car.attacker && !car.defMoved && toCorner < 380 && toCorner > brakeDist) {
            // un solo movimiento: tapar el interior antes de la frenada
            if (Math.abs(dc - inside * 3.5) < 1.2 && dc * inside > 0) c -= 1.4 * car.drv.craft;
          }
          if (car.mode === 'yield' && o === yieldTo && g < 3) c += 3;
        }
      }
      if (rejoin) c += 0.4 * Math.abs(dc - car.d);
      LC[nK] = c;
      if (c < bestC) { bestC = c; best = dc; bestK = nK; }
      nK++;
    }
    // afinar entre carriles de 0,5 m (parábola por los tres mejores): si no, el objetivo saltaba 0,5 m de una décima a otra
    if (bestK > 0 && bestK < nK - 1) {
      const cm = LC[bestK - 1], cp = LC[bestK + 1], den = cm - 2 * bestC + cp;
      if (den > 1e-9 && cp - bestC < 5 && cm - bestC < 5) best += 0.5 * Math.max(-0.5, Math.min(0.5, 0.5 * (cm - cp) / den));
    }
    if (car.mode === 'defend' && Math.abs(best - curAbs) > 1.5 && toCorner < 380) car.defMoved = true;
    car.passOut = car.passOutNext || null; car.passOutNext = null;
    car.targetAbs = best;
    car.devTarget = Math.max(-2 * HALF_W, Math.min(2 * HALF_W, best - lineP));

    // prioridad en la frenada: quien va por fuera y detrás, cede
    for (const { o, rel } of near) {
      if (Math.abs(rel) > LEN + 0.5) continue;
      if (T.zoneOf[i] < 0 && toCorner > brakeDist + 40) continue;
      const outside = Math.sign(car.d - o.d) === -inside;
      if (outside && rel > 1.0 && !(car.mode === 'attack' && car.target === o && car.gripAdv > 1.06)) car.squeeze = 0.035 * (1.2 - car.drv.agg * 0.4);
      if (!outside && rel > 2.5) car.squeeze = 0.02;
      if (!outside && rel <= 2.5 && car.mode === 'attack') car.dive = (0.006 + 0.012 * car.drv.agg) * fight.dive;
    }
    if (car.mode === 'attack' && car.target && !car.otTry) {
      car.otTry = { o: car.target, zone: car.atk?.z ?? nc.id, plan: car.atk?.type || 'inside', t: this.t, gap: T.rel(car.s, car.target.s) };
    }
  }

  // ------------------------------------------------------------------ física
  physics(car) {
    const T = this.T, ss = this.session, race = ss.id === 'RACE';
    if (car.retired) {
      car.v = Math.max(0, car.v - 14 * DT); car.s = T.wrap(car.s + car.v * DT); car.dist += car.v * DT;
      car.vs = car.v; car.dPrev = car.d; car.slide = car.slide || 0;
      if (car.inPit) { car.parked = true; return; }
      const side = car.parkSide || (car.parkSide = car.d >= 0 ? 1 : -1);
      const goal = side * Math.min(T.hwAt(car.s) + 9, T.wallIn(car.s, side) - 1.2);
      car.d += Math.max(-3 * DT, Math.min(3 * DT, goal - car.d));
      car.dev = car.d - car.line[T.idx(car.s)];
      if (Math.abs(car.d - goal) < 0.1 && car.v < 1) car.parked = true;
      return;
    }
    if (car.mistake && car.mistake.type === 'spin') return this.spinTiming(car);
    const i = T.idx(car.s);
    const z = T.zoneOf[i];
    const team = car.team;
    let target = car.vprof[T.idx(car.s + Math.max(2, car.v * DT * 3))];

    // --- modos de conducción
    if (race && ss.phase === 'green' && this.t - this.raceStart < car.react) target = 0;
    if (car.lapKind === 'out') target *= car.inPit ? 1 : 0.86;
    if (car.lapKind === 'in' || car.lapKind === 'cool') target *= 0.8;
    if (car.finished) target *= 0.7;
    if (!race && car.lapKind === 'out') {
      // hacer hueco para la vuelta rápida
      for (const { o, rel } of car.nb) {
        if (o.inPit) continue;
        if (rel > 0 && rel < 200 && o.lapKind !== 'in') { target *= 0.9; break; }
      }
    }
    if (car.mode === 'yield') target *= 0.93;
    // VSC: bastante más lento en todas partes (en curva también: antes a 0,62 del perfil las curvas lentas casi no cambiaban)
    if (this.flag === 'VSC') target = Math.min(target, car.vprof[i] * 0.55, 18 + car.vprof[i] * 0.3);
    if (race && car.state === 'track' && !car.inPit && car.lap < 0 && this.t - this.raceStart < 8) target *= 1; // arrancada
    let mult = 1; // multiplicadores de intención (para medir cuánto se pasa del límite)
    if (car.dive && z >= 0) { target *= 1 + car.dive; mult *= 1 + car.dive; }
    if (car.brakeEarly && car.brakeEarly < 1) { target *= car.brakeEarly; mult *= car.brakeEarly; }
    if (car.exitBoost) target *= 1 + car.exitBoost * 0.6;
    if (car.squeeze) { target *= 1 - car.squeeze; mult *= 1 - car.squeeze; }
    if (car.mistake) target *= car.mistake.slow;

    // fuera de la trazada: la curva real es otra
    const dev = car.dev;
    if (Math.abs(dev) <= 0.6) car.olT = 0;
    else if (!car.inPit && (car.olT = (car.olT || 0) - 1) <= 0) {
      car.olT = 4; car.olCap = Infinity;
      const aero = AERO * this.aeroK(car), mu = car.muPlan * 0.97 * this.offWet(car, dev);
      const vv = car.v;
      const dec = BRK * mu * (G + aero * vv * vv * 0.6);
      // (el desvío no se queda fijo: vuelve hacia el carril que ha elegido en unos 35 m; antes suponía que seguía igual de
      // desviado toda la curva y, siguiendo a otro en curva rápida, levantaba de más)
      const dT = car.devTarget ?? dev, Pq = Math.max(10, Math.min(42, 8 + vv * 0.42)) * 1.3;
      for (let q = 0; q < 170; q += 6) {
        const j = T.idx(car.s + q); const kl = car.kl[j], dq = dev + (dT - dev) * Math.min(1, q / Pq);
        const kk = kl / Math.max(0.3, 1 - kl * dq);
        const vl = vCorner(kk, mu * (T.zoneOf[j] >= 0 ? car.kb.commit[T.zoneOf[j]] : 1), aero);
        const va = Math.sqrt(vl * vl + 2 * dec * q);
        if (va < car.olCap) car.olCap = va;
      }
    }
    if (Math.abs(dev) > 0.6 && !car.inPit && car.olCap < target) target = car.olCap;
    // pit lane
    if (car.inPit) target = this.pitTarget(car, target);

    // seguir al de delante sin comérselo
    for (const { o, rel } of car.nb) {
      if (car.inPit !== o.inPit && !(o.inPit && Math.abs(o.d) < HALF_W + 1)) continue;
      if (rel <= 0 || rel > 90) continue;
      const lat = Math.abs(o.d - car.d);
      const latT = Math.abs(o.targetAbs - car.targetAbs);
      if (lat < SEP + 0.1 || (latT < SEP && lat < SEP + 1.5 && rel < 25 && car.passOut !== o)) {
        const gap0 = LEN + 1.0 + car.v * 0.05 + (o === car.target ? car.followGap || 0 : 0);
        const cap = o.v + (rel - gap0) * 1.4;
        if (cap < target) { target = Math.max(0, cap); if (race && z < 0 && car.mode === 'attack' && cap < car.v - 0.5) this.stuckT = (this.stuckT || 0) + DT; }
      } else if (this.flag === 'VSC' && !car.inPit && !o.inPit && !o.retired && !o.mistake && o.v > 4 && rel < 40) {
        // VSC: prohibido adelantar; aunque vaya por otro carril se queda detrás (antes el más rápido le alcanzaba y pasaba)
        const cap = o.v + (rel - LEN - 6) * 1.4;
        if (cap < target) target = Math.max(0, cap);
      }
    }
    if (car.state === 'grid') target = 0;

    // --- agarre real
    const tg = this.tyreGrip(car, false);
    let dirty = 1, tow = 1;
    for (const { o, rel } of car.nb) {
      if (o.inPit) continue;
      if (rel <= 0 || rel > 95) continue;
      const lat = Math.abs(o.d - car.d);
      if (rel < 35 && lat < 3) dirty = Math.min(dirty, 1 - 0.075 * (1 - rel / 35) * (1 - lat / 3));
      // rebufo: más fuerte y desde más lejos que antes (apenas se notaba); pero no detrás del que le acaba de pasar
      // (con rebufo y DRS se lo devolvía en la recta siguiente)
      if (lat < 2.4 && !(o === car.passedBy && this.t - car.passedT < 10)) tow = Math.min(tow, 1 - 0.2 * Math.pow(1 - rel / 95, 1.15));
    }
    // el piloto sabe que con aire sucio agarra menos (los buenos lo compensan mejor)
    let dk = 1;
    if (dirty < 1) { dk = Math.sqrt(1 - (1 - dirty) * (0.7 + 0.3 * car.drv.craft)); target *= dk; mult *= dk; }
    let save = 1; // en carrera, cuidando gomas: algo menos de ritmo y de agarre usado
    const pace = car.mgr && !car.inPit ? car.mgr.pace : null;
    // mánager (en todas las sesiones): atacar aprieta más (más desgaste y errores); cuidar va bastante más despacio
    if (pace && pace !== 'normal') { save = MGR.pace[pace].k; target *= save; mult *= save; }
    else if (race && car.mode === 'free' && this.raceLaps - car.lap > 2) { save = 0.994 + 0.004 * (1 - car.drv.tyre); target *= save; mult *= save; }
    // cuánto aprieta en esta curva (varía de una vuelta a otra: de ahí salen los errores)
    const exec = z >= 0 && z === car.zoneIn ? car.exec || 1 : 1;
    if (exec !== 1) target *= Math.sqrt(exec);
    const offLine = z >= 0 && Math.abs(dev) > 2.2 && !car.inPit ? 1 - Math.min(0.045, (Math.abs(dev) - 2.2) * 0.012) : 1; // gomas sueltas fuera de la trazada
    // superficie: pista, arcén asfaltado, hierba, grava, asfalto pintado
    const ad = Math.abs(car.d), hwS = T.hwAt(car.s);
    let surfMu = 1, surfDrag = 0;
    if (!car.inPit && ad > hwS + 1.6) {
      const st = ad > hwS + 3 ? T.surface(car.s, car.d >= 0 ? 1 : -1) : 2;
      surfMu = (st === 0 ? 0.55 : st === 1 ? 0.5 : st === 2 ? 0.88 : 0.92) * (1 - 0.3 * this.wx.wet);
      surfDrag = (st === 1 ? 9 : st === 0 ? 2.5 : 0) * Math.min(1, car.v / 30);   // la grava frena mucho a alta velocidad; despacio se sale
      if (st === 1 && car.v > 6) { car.gravelT = this.t; car.gravelSide = car.d >= 0 ? 1 : -1; }
    } else if (!car.inPit) {
      // vuelve a la pista con las ruedas llenas de grava: la deja esparcida unos metros (resbala hasta que se limpia)
      if (car.gravelT != null && this.t - car.gravelT < 2 && ad < hwS + 0.5) { this.dropGravel(car); car.gravelT = null; }
      surfMu *= this.gravelGrip(car);
    }
    const talent = 1 + 0.018 * (car.drv.pace - 0.88);
    const muTrue = (1 + (car.exitBoost || 0)) * MU * this.gripK(car) * this.paceG(car) * talent * tg * this.evoFactor() * (1 - 0.00035 * car.fuel) *
      (z >= 0 ? this.zoneTrue[z] : 1) * dirty * offLine * surfMu * car.wobble;   // (los daños no cambian cómo va: solo se ven)
    const aero = AERO * this.aeroK(car) * (car.drs ? 0.8 : 1);
    // rebufo con inercia: al salir de detrás para pasar no se pierde de golpe sino en ~1,5 s (el «tirachinas»);
    // si se perdía de golpe, a mitad de recta dejaba de ganar metros y el adelantamiento acababa en la curva
    car.towK = Math.min(tow, (car.towK ?? 1) + DT * 0.13);
    const drag = CD * this.dragK(car) * (car.drs ? 0.8 : 1) * car.towK;   // (DRS: 0,87 → 0,8, ~+12 km/h: con menos no daba para pasar en recta)
    const v = Math.max(0.1, car.v);
    const down = G + aero * v * v;
    const capT = muTrue * down;                                   // agarre que hay de verdad
    // agarre que el piloto cree que tiene: en las curvas, el que se atreve a usar (compromiso aprendido × cómo ataca esta entrada)
    // fuera de la trazada ve que hay más agua (no es exacto: se queda corto un poco)
    const offW = car.inPit ? 1 : this.offWet(car, dev);
    const capP = offW * (car.inPit ? capT * 0.9 : z >= 0 ? car.muPlan * this.commitAt(car, z) * exec * dk * dk * save * save * surfMu * offLine * down : capT * 0.97);

    // --- dirección: persigue un punto de su trazada (más su desvío) a una distancia que crece con la velocidad
    const Ls = T.lerp(car.line, car.s);
    let kCmd = 0, kFF = 0;
    if (!car.inPit) {
      const Pp = Math.max(10, Math.min(42, 8 + v * 0.42));
      const dLs = (T.lerp(car.line, car.s + 1.5) - T.lerp(car.line, car.s - 1.5)) / 3;
      const psiL = Math.atan(dLs / Math.max(0.3, 1 - T.k[i] * Ls));
      // (curvatura media de ~15 m para el volante: la Catmull-Rom cambia de curvatura a saltos en cada nodo y el volante bailaba
      // cada 15 m en las curvas rápidas; la velocidad de paso sí usa la curvatura local, que en el vértice es la que manda)
      const e = car.d - Ls, pe = car.psi - psiL, klI = (car.kl[i] + car.kl[T.idx(car.s - 5)] + car.kl[T.idx(car.s + 5)]) / 3;
      kFF = klI / Math.max(0.3, 1 - klI * e);
      // su punto (trazada + desvío), pero nunca fuera de la pista: el desvío se elige respecto a la trazada unos metros
      // por delante y, si la trazada cruza la pista, sumado a la de aquí acababa fuera (salidas sin error de verdad)
      const lim = Math.min(T.hwAt(car.s), T.hwAt(car.s + 10)) - CAR_HALF - 0.15;
      const err = Math.max(-lim, Math.min(lim, Ls + car.devTarget)) - car.d;
      car.laneErr = err;
      // corrección hacia su punto: nunca más de un tercio del agarre (cambiar de carril no es tirar el coche)
      const fbMax = 0.35 * capP / (v * v);
      // a poca velocidad no apunta más de unos grados fuera de su trazada (en la salida, no cruzarse de lado a lado)
      // (fuera de la pista no: un coche lento en la escapatoria tardaría una eternidad en volver)
      const hMax = Math.abs(car.d) > T.hwAt(car.s) + 0.5 ? Infinity : (0.05 + 0.007 * v) * Pp;
      const de = Math.max(-hMax, Math.min(hMax, err));
      // velocidad lateral hacia su carril: la de la persecución, pero nunca más de la que puede frenar con esa corrección
      // (antes, al cambiar mucho de carril, se echaba de lado a tope y se pasaba unos metros: salía de la pista sin error)
      const vlat = v * Math.sin(pe), vWant = Math.sign(de) * Math.min(v * Math.abs(de) / Pp, Math.sqrt(2 * 0.45 * fbMax * v * v * Math.abs(de)));
      kCmd = kFF + Math.max(-fbMax, Math.min(fbMax, 2 * (vWant - vlat) / (Pp * v)));
    } else kCmd = kFF = T.k[i];
    // si no le da para el giro que necesita, levanta y frena hasta la velocidad a la que sí (se abre lo justo)
    const kAbs = car.inPit ? Math.abs(kFF) : Math.abs(car.kl[i] / Math.max(0.3, 1 - car.kl[i] * (car.d - Ls)));
    if (kAbs > 1e-4 && !car.inPit) { const vF = Math.sqrt(capP / kAbs) * 1.01; if (vF < target) target = vF; }
    let ayCmd = v * v * kCmd;
    if (Math.abs(ayCmd) > capP) ayCmd = Math.sign(ayCmd) * capP;   // no pide más giro del que cree que hay
    // si llega pasado de velocidad, sacrifica giro para poder frenar (cuanto más pasado, más prioridad al freno)
    const over = (v - target) / Math.max(10, target);
    if (over > 0.004 && !car.inPit) {
      const bMin = Math.min(0.85, 0.15 + over * 9);
      const latMax = capP * Math.sqrt(1 - bMin * bMin);
      if (Math.abs(ayCmd) > latMax) ayCmd = Math.sign(ayCmd) * latMax;
    }
    const rl = Math.min(1, Math.abs(ayCmd) / capP);

    // --- longitudinal: lo que pide a los neumáticos (dentro de su elipse de agarre)
    const mass = MASS + car.fuel;
    const res = (drag * v * v + ROLL) / mass;
    let axT;
    if (v < target - 0.05) {
      const pw = team.power * 1000 * POWER * gearPower(v) * (car.lapKind === 'cool' ? 0.8 : 1) * this.ersK(car) / (mass * Math.max(v, 8));
      const launch = race && car.lap < 0 && this.t - this.raceStart < 4 ? car.launch : 1;
      // al acelerar siente la tracción de verdad (con un pequeño margen)
      axT = Math.min(launch * TRAC * Math.min(capP, capT * 0.985) * ellipse(rl), pw, (target - v) / DT + res);
      // el pedal no es un interruptor: se pisa en rampa (más despacio saliendo de curva y en mojado; los finos, más
      // suave) y marca lo que de verdad se usa de la potencia: a la salida, limitado por la tracción, va a medio gas
      const want = Math.min(1, Math.max(0.08, axT / pw));
      const rate = (1.8 + 2.4 * (1 - rl)) * (1 - 0.4 * Math.min(1, this.wx.wet * 3)) * (0.85 + 0.3 * car.drv.cons);
      const thr = Math.min(want, (car.throttle || 0) + rate * DT);
      if (thr < want) axT = Math.min(axT, thr * pw);
      if (car.kick && rl > 0.3 && thr > 0.35 && v < 65 && !car.inPit) { car.beta += (Math.sign(ayCmd) || 1) * car.kick; car.kick = 0; }
      car.throttle = thr; car.brake = 0;
    } else {
      const want = (v - target) / DT - res;
      axT = -Math.max(0, Math.min(BRK * capP * ellipse(rl), want));
      car.throttle = want < 2 ? 0.2 : 0; car.brake = Math.min(1, -axT / 45);
    }
    // --- neumáticos: si se pide más de lo que hay, se reparte y sobra un exceso E
    const axCap = axT >= 0 ? TRAC * capT : BRK * capT;
    const u = (axT / axCap) ** 2 + (ayCmd / capT) ** 2;
    let E = 0, ay = ayCmd, ax = axT;
    if (u > 1) { const sq = Math.sqrt(u); E = sq - 1; ay /= sq; ax /= sq; }
    const lon = Math.min(1, Math.abs(axT) / axCap);
    // bloqueo: frenando fuerte con exceso, se bloquean las delanteras (humo, el morro deja de girar y frena algo menos);
    // si dura, cuadra la goma (vibra y agarra un poco menos el resto de la tanda)
    const lockRaw = axT < 0 && E > 0.015 && lon > 0.55 && v > 12 ? Math.min(1, E * 5 + (lon - 0.55)) : 0;
    car.lock += ((lockRaw > car.lock ? lockRaw : lockRaw * 0.5) - car.lock) * Math.min(1, DT * 18);
    if (car.lock > 0.05) {
      ay *= 1 - 0.55 * car.lock; ax *= 1 - 0.12 * car.lock;
      car.tyre.flat = Math.min(1, (car.tyre.flat || 0) + car.lock * DT * 0.05 * (0.6 + v / 80));
      if (!car.lockOn && car.lock > 0.3) { car.lockOn = true; this.lstat(car).locks++; this.emit({ type: 'lockup', car, corner: this.cornerAt(car.s), sev: car.lock }); }
    } else if (car.lock < 0.02) { car.lock = 0; car.lockOn = false; }
    // el exceso hace deslizar la trasera (frenando o acelerando fuerte) o el morro (a medio gas: se abre)
    const overs = axT < 0 ? 0.25 + 0.55 * lon : 0.25 + 0.65 * lon;
    // cazar el coche con contravolante (el tacto se aprende aparte en seco y en mojado)
    const F = car.brain.feel, wm = Math.min(1, this.wx.wet * 3), feel = F ? F.d * (1 - wm) + F.w * wm : 0.5;
    const rec = (3.2 + 3.5 * car.drv.cons) * (0.75 + 0.25 * Math.min(1, v / 45)) * (0.94 + 0.12 * feel);
    const bdot = (Math.sign(ayCmd) || 1) * 30 * overs * E * (0.3 + 0.7 * rl) - rec * car.beta + 16 * car.beta * Math.abs(car.beta);
    car.beta += bdot * DT;
    // en el pit lane no hay trompo que lo corte: se endereza (si entraba cruzado, el término cuadrático se disparaba)
    if (car.inPit) car.beta = Math.max(-0.3, Math.min(0.3, car.beta * (1 - Math.min(1, DT * 8))));
    if (Math.abs(car.beta) < 1e-4) car.beta = 0;
    if (car.zoneIn >= 0) car.zoneSlide = (car.zoneSlide || 0) + (E + Math.abs(car.beta)) * DT;
    // cada derrape cazado enseña tacto: sobre todo para estas condiciones, algo para las otras
    if (F && Math.abs(car.beta) > 0.1 && !car.inPit) {
      const g = DT * 0.0025 * (0.5 + car.drv.learn), a = wm > 0.5 ? 'w' : 'd', o = a === 'w' ? 'd' : 'w';
      F[a] = Math.min(1, F[a] + g * (1 - F[a])); F[o] = Math.min(1, F[o] + g * 0.25 * (1 - F[o]));
    }
    if (Math.abs(car.beta) > 0.1) car.slideOn = true;
    else if (car.slideOn && Math.abs(car.beta) < 0.04) { car.slideOn = false; this.lstat(car).catches++; this.learnNote(car, 'caza', car.zoneIn, 0); }
    if (Math.abs(car.beta) > 0.45 && !car.inPit) { car.slideOn = false; this.startSpin(car, ay / Math.max(1, v * v), Math.abs(bdot)); return this.spinTiming(car); }

    // --- avance
    let acc = ax - res - surfDrag - Math.abs(car.beta) * 14;
    if (car.v < 0.05 && acc < 0) acc = 0;
    car.a = acc;
    car.v = Math.max(0, car.v + acc * DT);
    const kAct = v > 1 ? ay / (v * v) : kCmd;
    car.alat = Math.abs(ay);
    const kc = T.k[i], prevS = car.s, prevDist = car.dist, prevD = car.d;
    const sdot = car.v * Math.cos(car.psi) / Math.max(0.3, 1 - kc * car.d);
    const ds = sdot * DT;
    car.s = T.wrap(car.s + ds); car.dist += ds; car.vs = sdot;   // avance real por la pista (para interpolar al dibujar)
    if (car.inPit) this.pitLateral(car);
    else {
      car.psi += (car.v * kAct - kc * sdot) * DT;
      car.d += car.v * Math.sin(car.psi) * DT;
      this.lateralLimits(car, prevD);
    }
    car.dPrev = prevD;

    // --- neumáticos y gasolina
    const load = Math.min(1.2, car.alat / capT);
    const slideWear = Math.min(0.3, E + Math.abs(car.beta));
    const C = COMPOUNDS[car.tyre.c];
    const mg = 1.12 - car.drv.tyre * 0.3;
    const wearScale = race ? 1 / (this.raceLaps * T.L) : 1 / (20 * T.L);
    // gomas de lluvia en seco: se cuecen y se deshacen; lisos en mojado: se enfrían
    const wAt = this.wetAt(car), dryCook = C.wet ? 1 + Math.max(0, 0.25 - wAt) * (car.tyre.c === 'W' ? 22 : 12) : 1;
    car.tyre.wear += ds * C.wear * wearScale * (0.5 + 0.7 * load * load + slideWear * 6 + (car.brake > 0.5 ? 0.25 : 0)) * mg * 1.05 * dryCook * (car.mgr ? MGR.pace[car.mgr.pace].wear * (1 + 0.1 * (car.susp || 0)) : 1);
    // batería: el modo ataque la vacía, recargar la llena (en el garaje se carga entera)
    if (car.mgr) car.ers = Math.max(0, Math.min(1, car.ers + MGR.ers[car.mgr.ers].ers * ds / T.L));
    const heat = (0.004 + 0.018 * load + 0.006 * car.brake) * C.warm * (C.wet ? 1 : 1 - 0.55 * wAt);
    car.tyre.temp += (heat * (1.15 - car.tyre.temp) - 0.0025 * car.tyre.temp * (car.v < 25 ? 3 : 1)) * DT * 5;
    car.tyre.temp = Math.max(0.2, Math.min(1.1, car.tyre.temp));
    if (race) car.fuel = Math.max(0, car.fuel - ds * 100 / (this.raceLaps * T.L) * 1.01);
    else car.fuel = Math.max(1, car.fuel - ds * 1.7 / T.L);

    // --- DRS
    const kl0 = car.kl[i], kk = kl0 / Math.max(0.3, 1 - kl0 * dev);
    const dz = T.inDRS[car.idx = T.idx(car.s)];
    const drsAllowed = this.flag === 'GREEN' && (!race || car.lap >= 2) && !this.wx.noDRS;
    // el DRS se cierra antes de cualquier curva que sin el alerón no se pueda pasar a esta velocidad (mira ~1,3 s por delante)
    let drsSafe = !!(dz || car.drs) && vCorner(kk, muTrue, AERO * this.aeroK(car) * 0.8) > car.v * 1.06;
    for (let q = 15; drsSafe && q < 40 + car.v * 1.3; q += 15) if (vCorner(car.kl[T.idx(car.s + q)], muTrue, AERO * this.aeroK(car) * 0.8) < car.v * 1.06) drsSafe = false;
    if (car.drs && !drsSafe) car.drs = false;
    else if (dz && car.drsOk && drsAllowed && car.brake === 0 && !car.inPit && drsSafe) car.drs = true;
    else if (car.drs && (car.brake > 0 || !dz)) { car.drs = false; if (!dz) car.drsOk = false; }
    for (const zn of T.drs) {
      if (between(T, zn.detect, prevS, car.s) && T.ahead(prevS, car.s) < 50) {
        if (!race) car.drsOk = true;
        else {
          const ah = this.carAheadOnTrack(car);
          car.drsOk = ah && this.trackGap(car, ah) < 1.0;
        }
      }
    }

    // --- telemetría para la cámara/HUD
    const kmh = car.v * 3.6;
    const gears = [0, 95, 130, 165, 200, 240, 275, 310, 358];
    let g = 1; while (g < 8 && kmh > gears[g]) g++; car.gear = car.v < 0.5 ? (car.state === 'grid' ? 1 : 0) : g;
    const lo = gears[g - 1], hi = gears[g];
    car.rpm = 7000 + 5200 * Math.min(1, (kmh - lo) / Math.max(1, hi - lo));
    car.steer = car.inPit ? 0 : Math.atan(3.6 * kAct) * 2.2 - car.beta * 1.6;          // con contravolante si desliza
    car.pitch += ((-acc / 60) * 0.02 - car.pitch) * 0.2;
    car.roll += ((-(kAct > 0 ? 1 : -1) * Math.min(1, car.alat / 40)) * 0.02 - car.roll) * 0.2;
    car.slide = car.beta;
    if (car.mistake) this.updateMistake(car);
    // se abre en la curva sin querer (subviraje): el piloto lo nota y el cerebro también
    if (E > 0.01 && car.zoneIn >= 0 && !car.zoneWide && Math.abs(car.laneErr || 0) > 2.5) { car.zoneWide = true; this.flagMistake(car, 'wide'); }

    this.timing(car, prevS, prevDist, i);
  }

  spinTiming(car) {
    const T = this.T, prevS = car.s, prevDist = car.dist, i0 = T.idx(car.s);
    this.spinStep(car); car.idx = T.idx(car.s);
    if (!car.retired) this.timing(car, prevS, prevDist, i0);
  }

  // Tras mover el coche: no pisar a los de al lado, límites de pista, escapatoria y barreras
  lateralLimits(car, prevD) {
    const T = this.T;
    let d = car.d;
    for (const { o, rel } of car.nb) {
      if (o.inPit || o.state === 'grid') continue;
      if (Math.abs(rel) > LEN + 0.6) continue;
      const sgn = Math.sign(prevD - o.d) || (car.i < o.i ? 1 : -1);
      // (si el otro ya estaba encima, p. ej. al llegarle por detrás solapado, salta de lado hasta 2 m en un paso: la IA
      // cuenta con ello para no chocar; el dibujo lo suaviza, ver visD en main.js)
      if (sgn > 0 && d < o.d + SEP) { car.jumpD = (car.jumpD || 0) + o.d + SEP - d; d = o.d + SEP; if (car.psi < 0) car.psi *= 0.3; }
      if (sgn < 0 && d > o.d - SEP) { car.jumpD = (car.jumpD || 0) + o.d - SEP - d; d = o.d - SEP; if (car.psi > 0) car.psi *= 0.3; }
    }

    // barrera (en la recta de meta, el muro del pit)
    const side = d >= 0 ? 1 : -1, B = T.wallIn(car.s, side) - 1.1;
    if (Math.abs(d) > B) { d = side * B; car.d = d; this.hitWall(car, side); d = car.d; }
    car.d = d;
    car.psi = Math.max(-1.2, Math.min(1.2, car.psi));
    car.dev = d - T.lerp(car.line, car.s);
    car.devV = (d - prevD) / DT;
    car.yaw = car.psi;
    const ad = Math.abs(d), hwS = T.hwAt(car.s);
    car.off = ad > hwS + 0.3 ? car.off + DT : Math.max(0, car.off - DT * 2);
    if (ad > hwS + 1.05 && car.lapClean && !car.mistake) {
      car.lapClean = false;
      if (car.lapKind === 'push') this.emit({ type: 'limits', car, corner: this.cornerAt(car.s) });
    } else if (ad > hwS + 1.05) car.lapClean = false;
    // se sale de la pista del todo (las cuatro ruedas en la escapatoria)
    if (!car.excursion && ad > hwS + 2.2 && !car.retired) {
      car.excursion = true; this.flagMistake(car, 'off');
    }
    else if (car.excursion && ad < hwS) car.excursion = false;
  }

  // Contra la barrera fuera de un trompo: roce (rebota y pierde velocidad), golpe (trompo y daños) o accidente
  hitWall(car, side) {
    // (el tecpro amortigua: el mismo golpe hace menos daño que contra el hormigón)
    const T = this.T, soft = T.soft(car.s, side) && T.wall(car.s, side) === T.barrier(car.s, side);
    const vn = (car.v * Math.abs(Math.sin(car.psi)) + 0.4) * (soft ? 0.8 : 1);
    if (vn > 3) { this.emit({ type: 'contact', car, wall: true, sev: vn }); this.barrierHit(car, side, vn); }
    if (vn > 22 || (vn > 15 && this.rng() < 0.35)) { this.damage(car, 'susp', 1); this.damage(car, 'fw', 0.8); car.v = 0; car.mistake = null; this.retire(car, 'accidente'); return; }
    if (vn > 6) { this.damage(car, 'susp', vn > 10 ? 0.35 : 0.15); if (Math.abs(car.psi) > 0.25) this.damage(car, 'fw', vn * 0.04); }
    car.v *= 1 - Math.min(0.35, vn * 0.025);
    car.psi = -side * Math.abs(car.psi) * 0.25;
    if (vn > 10 && this.rng() < 0.6) { car.beta = -side * 0.5; this.startSpin(car, 0, 2); }
  }

  // Error que el piloto nota (se abre, se sale): aprende a apretar menos en esa curva
  flagMistake(car, type) {
    const zi = this.T.zoneOf[this.T.idx(car.s)];
    if (zi >= 0) { const d = (type === 'wide' ? 0.35 : 1) * (0.003 + 0.004 * car.drv.learn); car.kb.commit[zi] -= d; this.otherKB(car).commit[zi] -= d * 0.2; }
    if (type !== 'wide') { car.lapClean = false; car.zoneMist = true; }
    car.brain.mistakes++; this.lstat(car).mist++;
    if (!car.mistake) car.mistake = { type, t: 0, dur: type === 'off' ? 2.5 : 1.2, slow: type === 'off' ? 0.85 : 1 };
    this.emit({ type: 'mistake', car, kind: type, crash: false, corner: this.cornerAt(car.s) });
  }

  // Trompo: la trasera se ha ido del todo. k0: curvatura que llevaba; w0: velocidad de giro inicial
  startSpin(car, k0, w0) {
    if (car.mistake?.type === 'spin' || car.retired) return;
    const hi = car.v > 50, dir = Math.sign(car.beta) || 1;
    car.mistake = {
      type: 'spin', t: 0, slow: 1, out: -Math.sign(k0 || car.beta || 1), dir,
      psi: car.psi, k0: k0 || 0, v0: car.v, rot: car.beta, w: Math.min(3, Math.abs(w0 || 0)),
      wMax: (hi ? 2.1 : 2.6) * (0.8 + this.rng() * 0.4), phase: 'slide', stopT: 0,
    };
    car.lapClean = false; car.zoneMist = true; car.brain.mistakes++; this.lstat(car).mist++;
    const zi = this.T.zoneOf[this.T.idx(car.s)];
    if (zi >= 0) { const d = 0.003 + 0.004 * car.drv.learn; car.kb.commit[zi] -= d; this.otherKB(car).commit[zi] -= d * 0.2; }
    this.emit({ type: 'mistake', car, kind: 'spin', crash: false, corner: this.cornerAt(car.s) });
  }

  updateMistake(car) {
    const m = car.mistake; m.t += DT;
    if (m.t > m.dur) car.mistake = null;
  }

  // Trompo: movimiento libre (sin seguir la trazada). La velocidad conserva su dirección en el mundo
  // mientras la pista gira bajo el coche; frena según la superficie; si llega a la barrera, impacto.
  spinStep(car) {
    const T = this.T, m = car.mistake; m.t += DT;
    car.dPrev = car.d;
    const side = Math.sign(car.d) || m.out;
    const offT = Math.abs(car.d) > T.hwAt(car.s) + 0.3;
    const surf = offT ? T.surface(car.s, side) : -1;           // -1 pista, 0 hierba, 1 grava, 2 asfalto pintado
    if (surf === 1 && car.v > 4) { car.gravelT = this.t; car.gravelSide = side; }
    const v = car.v;
    if (m.phase === 'slide') {
      const dec = surf === 1 ? 19 : surf === 0 ? 6 : surf === 2 ? 10 : 11 + Math.min(6, v * 0.08); // de lado frena mucho; la grava, más; la hierba patina
      car.v = Math.max(0, v - dec * DT);
      const kc = T.k[T.idx(car.s)], fac = Math.max(0.3, 1 - kc * car.d);
      const grip = Math.max(0, 1 - m.t / 1.0) * 0.65;         // al principio aún gira algo con la curva
      const ds = v * Math.cos(m.psi) * DT / fac;
      m.psi += (m.k0 * grip * v * DT) - kc * ds;
      m.psi = Math.max(-1.45, Math.min(1.45, m.psi));
      car.s = T.wrap(car.s + ds); car.dist += ds; car.vs = ds / DT;
      car.d += v * Math.sin(m.psi) * DT;
      // giro sobre sí mismo: arranca progresivo y se apaga al perder velocidad (en grava, antes)
      const wT = m.wMax * Math.min(1, m.t / 0.6) * (0.25 + 0.75 * Math.min(1, v / Math.max(10, m.v0))) * (surf === 1 ? 0.6 : 1);
      m.w += (wT - m.w) * Math.min(1, DT * 4);
      if (v < 6) m.w *= 1 - DT * 2.5;
      m.rot += m.dir * m.w * DT;
      // barrera
      const B = T.wallIn(car.s, side) - 1.1;
      if (Math.abs(car.d) > B) {
        car.d = side * B;
        const vn = v * (Math.abs(Math.sin(m.psi)) + 0.1);    // velocidad de impacto contra la barrera
        if (vn > 3) { this.emit({ type: 'contact', car, wall: true, sev: vn }); this.barrierHit(car, side, vn); }
        // de lado o de culo contra el muro: trasero y suspensión; de frente, el alerón delantero
        const tail = Math.cos(m.rot) < 0;
        if (vn > 24 || (vn > 17 && this.rng() < 0.3)) { this.damage(car, 'susp', 1); this.damage(car, tail ? 'rw' : 'fw', 1); car.v = 0; m.phase = 'stop'; this.retire(car, 'accidente'); car.mistake = null; return; }
        if (vn > 7) { this.damage(car, 'susp', 0.25); this.damage(car, tail ? 'rw' : 'fw', vn * 0.05); }
        car.v *= 0.35; m.psi *= -0.3; m.w *= 0.5;
      }
      if (car.v < 1.2) { car.v = 0; m.phase = 'stop'; m.stopT = m.t; }
    } else {
      car.vs = 0;
      // parado: en la grava puede quedarse atascado; si no, gira el coche y vuelve
      // (solo si se para metido en la grava, y no tantos: con un 30 % de los trompos que acababan en grava se quedaban
      // muchos más que en la F1 de verdad)
      if (m.stuck == null) m.stuck = surf === 1 && Math.abs(car.d) > T.hwAt(car.s) + 5 && this.rng() < 0.12;
      if (m.stuck && m.t - m.stopT > 2) { this.retire(car, 'atascado en la grava'); car.mistake = null; return; }
      const k = Math.min(1, DT * 1.6);
      const goal = Math.round(m.rot / (2 * Math.PI)) * 2 * Math.PI;
      m.rot += (goal - m.rot) * k; m.psi += (0 - m.psi) * k;
      if (m.t - m.stopT > 2.2) { car.mistake = null; car.slide = 0; car.yaw = 0; car.psi = 0; car.beta = 0; car.devTarget = 0; car.dev = car.d - T.lerp(car.line, car.s); car.devV = 0; car.vs = null; return; }
    }
    car.slide = m.rot; car.yaw = m.psi;
    car.throttle = 0; car.brake = 1; car.a = (car.v - v) / DT; car.drs = false;
    car.gear = car.v < 0.5 ? 0 : Math.max(1, car.gear); car.rpm = Math.max(4500, car.rpm - 6000 * DT);
    car.off = offT ? car.off + DT : 0; car.lapClean = false;
    car.tyre.wear += car.v * DT / T.L * 0.02;
  }

  // daños por piezas: alerón delantero (fw), trasero (rw) y suspensión (susp), 0-1. dmg = el peor (lo que ya usaban
  // ritmo, paradas y abandonos). Cada pieza que se rompe suelta trozos (evento 'debris' para lo visual).
  damage(car, part, amt) {
    if (amt <= 0 || car.out) return;
    const P = car.parts, before = P[part];
    P[part] = Math.min(1, P[part] + amt);
    car.dmg = Math.max(car.dmg, P.fw * 0.7, P.rw * 0.8, P.susp);
    const broken = before < 0.5 && P[part] >= 0.5;
    this.emit({ type: 'debris', car, part, sev: P[part] - before, broken, s: car.s, d: car.d });
    // libres y clasificación: con una pieza rota vuelve al garaje a cambiarla (el del mánager, si se lo dice: aviso)
    if (broken && this.session.id !== 'RACE' && !this.mgrHand(car) && !car.inPit && !car.retired) { car.lapKind = 'in'; car.pitReq = true; }
  }

  // grava en la pista: parche que se va limpiando con el tiempo y con cada coche que pasa por encima
  dropGravel(car) {
    const g = { s: car.s, d: car.gravelSide * (this.T.hwAt(car.s) - 2), len: 25 + car.v * 0.8, w: 3.5, amt: 1, t: this.t };
    this.gravel.push(g); if (this.gravel.length > 30) this.gravel.shift();
    this.emit({ type: 'gravel', car, ...g });
  }
  gravelGrip(car) {
    let mu = 1;
    for (let k = this.gravel.length - 1; k >= 0; k--) {
      const g = this.gravel[k];
      const amt = g.amt - (this.t - g.t) / 300;
      if (amt <= 0) { this.gravel.splice(k, 1); continue; }
      const rel = this.T.rel(g.s, car.s);
      if (rel > -2 && rel < g.len && Math.abs(car.d - g.d) < g.w) { mu = Math.min(mu, 1 - 0.14 * amt); g.amt -= DT * 0.03; }
    }
    return mu;
  }

  // golpe contra la barrera: se apunta para que las barreras (TecPro, neumáticos) se vean movidas
  barrierHit(car, side, sev) {
    const h = { s: car.s, d: car.d, side, sev, t: this.t, car };
    this.barrierHits.push(h); if (this.barrierHits.length > 60) this.barrierHits.shift();
    this.emit({ type: 'barrier', ...h });
  }

  retire(car, why) {
    car.retired = true; car.retiredWhy = why; car.retiredT = this.t; car.v *= 0.3; car.drs = false; car.vs = car.v; car.beta = 0;
    this.emit({ type: 'retire', car, why });
    if (this.session.id === 'RACE' && !car.inPit) {
      // (con otro VSC en marcha se alarga para retirar también este; antes acababa a su hora con el segundo coche en pista)
      const dur = 70 + this.rng() * 30;
      if (this.flag === 'GREEN') { this.flag = 'VSC'; this.vscT = dur; this.vscEnd = false; this.emit({ type: 'flag', flag: 'VSC' }); }
      else { this.vscT = Math.max(this.vscT, dur); this.vscEnd = false; }
    }
  }

  // ------------------------------------------------------------------ boxes
  pitTarget(car, target) {
    const T = this.T, p = T.pit;
    const box = T.pit.boxes[TEAMS.indexOf(car.team)];
    if (car.pitPhase === 'in') {
      const toLimit = T.ahead(car.s, p.limitA);
      if (toLimit < 400) target = Math.min(target, Math.sqrt(p.speed * p.speed + 2 * 10 * Math.max(0, toLimit - 25)));   // (a 20 m/s² pisaba la línea a ~110 km/h: cambiando de carril no frena tanto)
      if (between(T, car.s, p.limitA, p.limitB)) target = Math.min(target, p.speed);
      const toBox = T.ahead(car.s, box.s);
      if (toBox < 300) target = Math.min(target, Math.sqrt(2 * 7 * Math.max(0, toBox - 0.5)));
      if (toBox < 0.8 || (toBox > T.L - 3)) { car.pitPhase = 'stop'; car.v = 0; car.pitT = 0; this.beginStop(car); return 0; }
    } else if (car.pitPhase === 'stop') {
      target = 0; car.v = 0; car.pitT += DT;
      if (car.pitT >= car.stopTime) {
        // suelta segura: no salir si viene alguien por el carril rápido
        const busy = this.cars.some((o) => o !== car && o.team !== car.team && o.inPit && live(o) && o.v > 5 && (o.pitPhase === 'in' || o.pitPhase === 'out') && T.rel(car.s, o.s) < 4 && T.rel(car.s, o.s) > -110);   // (45 m no daba: tarda ~4 s en llegar al carril y el otro llega antes)
        if (!busy) this.endStop(car);
      }
    } else if (car.pitPhase === 'out') {
      target = Math.min(target, between(T, car.s, p.limitA, p.limitB) ? p.speed : target);
      if (between(T, car.s, p.limitA, p.limitB) && car.v < p.speed) target = p.speed;
      if (between(T, car.s, p.exitB, T.wrap(p.exitB + 40))) { car.inPit = false; car.wetEst = Math.max(car.wetEst || 0, this.wx.line * 0.7); car.dev = car.d - car.line[T.idx(car.s)]; car.devTarget = car.dev; car.targetAbs = car.d; }
    } else if (car.pitPhase === 'box') target = 0;
    return target;
  }

  pitLateral(car) {
    const T = this.T, p = T.pit;
    const i = T.idx(car.s);
    const lineD = car.line[i] + car.dev;
    const fast = p.fastD, boxD = p.d - 3.5;
    let d;
    const ramp = (a, b) => Math.min(1, Math.max(0, T.ahead(a, car.s) / T.ahead(a, b)));
    if (car.pitPhase === 'in') {
      const box = T.pit.boxes[TEAMS.indexOf(car.team)];
      const toBox = T.ahead(car.s, box.s);
      // transición suave desde donde y hacia donde iba al decidir hasta el borde, recta (antes mezclaba con car.dev, que se
      // reescribe cada paso: se tiraba al borde en ~30 m, y seguir la trazada lo hacía temblar)
      if (between(T, car.s, p.decide, p.entryA)) {
        const s0 = car.pitS0 ?? p.decide, f = ramp(s0, p.entryA), e = f * f * (3 - 2 * f), m0 = Math.max(-0.3, Math.min(0.3, car.pitM0 ?? 0));
        const tau = car.pitTau ?? 15, carry = m0 * tau * (1 - Math.exp(-T.ahead(s0, car.s) / tau)); // conserva el ángulo con que llegaba y lo pierde en ~0,6 s
        d = ((car.pitD0 ?? lineD) + carry) * (1 - e) + p.edgeD * e;
      }
      else d = p.laneD(car.s);
      if (toBox < 40) { const f = Math.min(1, (40 - toBox) / 25); d = fast + (boxD - fast) * f * f * (3 - 2 * f); }
    } else if (car.pitPhase === 'stop' || car.pitPhase === 'box') d = boxD;
    else {
      // salida
      const box = T.pit.boxes[TEAMS.indexOf(car.team)];
      const fromBox = T.ahead(box.s, car.s);
      d = fromBox < 30 ? boxD + (fast - boxD) * (fromBox / 30) : fast;
      if (between(T, car.s, p.exitA, p.exitB)) d = p.laneD(car.s);
      if (between(T, car.s, p.exitB, T.wrap(p.exitB + 40))) d = p.edgeD;
    }
    const prev = car.d; car.dPrev = prev;
    car.d = d; car.dev = d - car.line[i];
    car.yaw = car.psi = Math.max(-0.5, Math.min(0.5, Math.atan2((d - prev) / DT, Math.max(6, car.v))));
  }

  beginStop(car) {
    const r = this.rng;
    const base = car.team.crew + gauss(r) * 0.18;
    // fallos del equipo, igual de probables para todos: 1 de cada 10 parada de ~4 s, y alguna rara de desastre
    const u = r(), slow = u < 0.02 ? 4 + r() * 5 : u < 0.12 ? 1.2 + r() * 1.5 : 0;
    // (las piezas rotas se cambian sin perder tiempo: los daños solo se ven)
    car.stopTime = Math.max(1.8, base + slow);
    if (this.session.id !== 'RACE') { this.enterGarage(car); return; }
    this.emit({ type: 'pitstop', car, time: car.stopTime });
  }

  enterGarage(car) {
    car.state = 'garage'; car.pitPhase = 'box'; car.v = 0; car.inPit = true; car.drs = false; car.mistake = null; car.slide = 0; car.psi = 0; car.beta = 0;
    car.d = this.T.pit.d - 9; car.lapKind = 'out'; car.pitReq = false; car.ers = 1; car.testRun = false;
    car.dmg = 0; car.parts = { fw: 0, rw: 0, susp: 0 };   // en el garaje se arregla todo
    if (car.mgr) { car.mgr.boxReq = false; this.emit({ type: 'garage', car }); }
    if (car.plan) {
      car.plan.idx++; let nx = car.plan.runs[car.plan.idx]; if (nx && isFP(this.session.id)) nx.go = 0;
      // entró a cambiar gomas por el tiempo: vuelve a salir enseguida (en clasificación, con una salida más)
      if (car.wxPit) {
        car.wxPit = false;
        if (!nx) car.plan.runs.push(nx = { c: 'S', laps: 2, fuel: 14, go: 0, kind: 'quali' });
        nx.go = this.t + 12 + this.rng() * 25;
      }
    }
  }

  // lo que queda de carrera tras una parada fuera de plan (daños, pinchazo): antes seguía con el compuesto previsto para
  // más tarde (duros cambiados por blandos en la vuelta 5 y blandos hasta el final)
  replan(car) {
    const laps = this.raceLaps, left = laps - car.lap, used = car.tyre.used;
    const life = { S: 0.42, M: 0.72, H: 1.1 }, pace = { S: 0, M: 0.5, H: 0.9 }, baseDeg = { S: 0.22, M: 0.12, H: 0.075 };
    const cost = (c, n) => {
      if (n > life[c] * laps + 1) return Infinity;
      const sl = degSlope(car.brain, c, baseDeg[c] * 20 / laps); let t = 0;
      for (let a = 0; a < n; a++) t += pace[c] + sl * a; return t;
    };
    const legal = (cs) => used.has('I') || used.has('W') || used.size >= 2 || cs.some((c) => !used.has(c));
    let best = null;
    for (const a of 'SMH') {
      if (legal([a])) { const t = cost(a, left); if (!best || t < best.t) best = { t, st: [{ c: a, from: car.lap, to: laps }] }; }
      for (const b of 'SMH') {
        if (!legal([a, b])) continue;
        for (let p = car.lap + Math.max(3, Math.round(left * 0.3)); p <= laps - Math.max(3, Math.round(left * 0.3)); p++) {
          const t = cost(a, p - car.lap) + cost(b, laps - p) + 21;
          if (!best || t < best.t) best = { t, st: [{ c: a, from: car.lap, to: p }, { c: b, from: p, to: laps }] };
        }
      }
    }
    if (best && isFinite(best.t)) car.strategy.stints = car.strategy.stints.slice(0, car.stint).concat(best.st);
  }

  endStop(car) {
    const ss = this.session;
    if (ss.id === 'RACE') {
      car.stint++;
      const M = car.mgr;
      if (M) {
        // mánager: la goma que diga su plan, sin más
        // vuelta de la parada: la de entrada (si el box está antes de la meta, aún no ha sumado la vuelta)
        const box = this.T.pit.boxes[TEAMS.indexOf(car.team)], L = box.s > this.T.L * 0.5 ? car.lap + 1 : car.lap;
        if (!car.strategy.stints[car.stint]) car.strategy.stints.push({ c: car.tyre.c, from: L, to: this.raceLaps });
        this.mgrFixPlan(car, L);
        let c = car.strategy.stints[car.stint].c;
        if (this.autoMgr) {
          // simulando, la IA decide por el tiempo como en los demás equipos: gomas de agua si llueve, lisos al secarse
          const left = this.raceLaps - L, wet = idealTyre(Math.max(car.wetEst || 0, this.wx.line));
          const wc = car.wxC === 'slick' ? (left < this.raceLaps * 0.42 ? 'S' : left < this.raceLaps * 0.7 ? 'M' : 'H') : car.wxC || (wet && !COMPOUNDS[c].wet ? wet : null);
          if (wc) { c = wc; car.strategy.stints = car.strategy.stints.slice(0, car.stint).concat([{ c, from: L, to: this.raceLaps }]); }
          car.wxC = null;
        }
        M.stopNow = false;
        M.stopsLog.push({ lap: L, from: car.tyre.c, c, wear: car.tyre.wear, time: car.stopTime, pos: car.pos });
        car.tyre = { c, wear: 0, temp: 0.6, age: 0, used: car.tyre.used };
        car.tyre.used.add(c); car.stops++; car.dmg = 0; car.parts = { fw: 0, rw: 0, susp: 0 }; car.pitReq = false;
        car.pitPhase = 'out'; car.lapKind = 'race';
        this.rebuildProfile(car);
        this.emit({ type: 'pitdone', car, time: car.stopTime, c });
        return;
      }
      // parada adelantada más de 3 vueltas a lo previsto (y no por el tiempo): se rehace el plan desde aquí
      const was = car.strategy.stints[car.stint - 1];
      if (!car.wxC && was && car.lap + 3 < was.to && this.raceLaps - car.lap > 2) this.replan(car);
      let next = car.strategy.stints[car.stint] || { c: car.tyre.c === 'H' ? 'M' : 'H' };
      if (car.wxC) {
        // cambio por el tiempo: el resto de la carrera con ese neumático (a lisos: el que aguante hasta el final)
        const left = this.raceLaps - car.lap;
        const c = car.wxC === 'slick' ? (left < this.raceLaps * 0.42 ? 'S' : left < this.raceLaps * 0.7 ? 'M' : 'H') : car.wxC;
        car.strategy.stints = car.strategy.stints.slice(0, car.stint).concat([{ c, from: car.lap, to: this.raceLaps }]);
        next = car.strategy.stints[car.stint]; car.wxC = null;
      }
      let c = next.c;
      // parada por otra cosa (daños, desgaste) con la pista mojada: gomas de agua, no el compuesto seco del plan
      // (salían con duros a pista empapada y trompeaban vuelta tras vuelta)
      const wc = idealTyre(Math.max(car.wetEst || 0, this.wx.line));
      if (wc && !COMPOUNDS[c].wet) { c = wc; car.strategy.stints = car.strategy.stints.slice(0, car.stint).concat([{ c, from: car.lap, to: this.raceLaps }]); }
      car.tyre = { c, wear: 0, temp: 0.6, age: 0, used: car.tyre.used };
      car.tyre.used.add(c); car.stops++; car.dmg = 0; car.parts = { fw: 0, rw: 0, susp: 0 }; car.pitReq = false;
      car.pitPhase = 'out'; car.lapKind = 'race';
      this.rebuildProfile(car);
      this.emit({ type: 'pitdone', car, time: car.stopTime, c });
    }
  }

  // Entrar al box: se decide al pasar por la línea de decisión antes de la entrada
  checkPitEntry(car, prevS) {
    const T = this.T, p = T.pit;
    if (car.inPit || !car.pitReq) return;
    if (between(T, p.decide, prevS, car.s) && T.ahead(prevS, car.s) < 50) {
      car.inPit = true; car.pitPhase = 'in'; car.drs = false;
      car.pitD0 = car.d; car.pitS0 = car.s; car.pitTau = Math.max(8, car.v * 0.6); car.pitM0 = (car.d - (car.dPrev ?? car.d)) / Math.max(0.5, T.ahead(prevS, car.s));
      this.emit({ type: 'pitin', car });
    }
  }

  // ---------------------------------------------------------------- cronometraje
  timing(car, prevS, prevDist, i) {
    const T = this.T, ss = this.session, race = ss.id === 'RACE';
    this.checkPitEntry(car, prevS);
    // zonas de aprendizaje
    const z = T.zoneOf[car.idx];
    if (z !== car.zoneIn) {
      if (car.zoneIn >= 0) this.zoneExit(car, car.zoneIn);
      if (z >= 0 && T.ahead(T.zones[z].a, car.s) < 30) this.zoneEnter(car, z);
      else car.zoneIn = -1;
    }
    // la trazada de la próxima curva se decide antes de llegar (para poder cambiar el punto de entrada)
    const zn = T.zoneNext[car.idx];
    if (zn !== car.planned && T.ahead(car.s, T.zones[zn].a) < 250) { car.planned = zn; this.planZone(car, zn); }
    if (car.zoneIn >= 0) {
      for (const { o, rel } of car.nb) {
        if (o.inPit) continue;
        if (rel > -8 && rel < 70) { car.zoneClean = false; break; }
      }
      if (car.mode !== 'free' || car.inPit) car.zoneClean = false;
    }
    // sectores
    for (let k = 1; k < 3; k++) {
      if (between(T, T.sectors[k], prevS, car.s) && T.ahead(prevS, car.s) < 50 && car.sector === k - 1) {
        const st = this.t - car.sectorStart; car.curSectors[k - 1] = st; car.sectorStart = this.t; car.sector = k;
        this.sectorDone(car, k - 1, st);
      }
    }
    // checkpoints (carrera)
    if (race) {
      const c0 = Math.floor(prevDist / CP_STEP), c1 = Math.floor(car.dist / CP_STEP);
      for (let c = c0 + 1; c <= c1; c++) {
        const frac = (c * CP_STEP - prevDist) / Math.max(1e-6, car.dist - prevDist);
        if (c >= 0) car.cpt[c] = this.t - DT + DT * frac;
      }
    }
    // libres/clasificación: tiempo en cada punto de la vuelta lanzada y diferencia en vivo con la mejor de la sesión
    if (!race && car.lapKind === 'push' && !car.inPit) {
      const k1 = Math.floor(car.s / CP_STEP);
      if (k1 !== car.cpK && car.s > prevS && T.ahead(prevS, car.s) < 30) {
        car.cpK = k1; car.lapCP[k1] = this.t - car.lapStart;
        const ref = this.bestCP; car.delta = ref && ref[k1] != null && car.lapClean ? car.lapCP[k1] - ref[k1] : null;
        const own = car.bestCP; car.deltaOwn = own && own[k1] != null && car.lapClean ? car.lapCP[k1] - own[k1] : null;   // con su mejor vuelta
      }
    }
    // línea de meta
    if (prevS > T.L - 60 && car.s < 60) this.lineCross(car);
  }

  sectorDone(car, k, st) {
    if (car.lapKind !== 'push' && car.lapKind !== 'race') return;
    if (st < car.bestSec[k]) car.bestSec[k] = st;
    const all = this.sessionBestSec || (this.sessionBestSec = [Infinity, Infinity, Infinity]);
    let col = 'yellow';
    if (st <= car.bestSec[k]) col = 'green';
    if (st < all[k] && car.lapClean) { all[k] = st; col = 'purple'; }
    car.secCol = car.secCol || []; car.secCol[k] = col;
    this.emit({ type: 'sector', car, k, time: st, col });
  }

  lineCross(car) {
    const T = this.T, ss = this.session, race = ss.id === 'RACE';
    const lapT = this.t - car.lapStart;
    const k = 2;
    if (car.sector === 2) {
      const st = this.t - car.sectorStart; car.curSectors[2] = st; this.sectorDone(car, 2, st);
    }
    const wasKind = car.lapKind;
    const valid = (wasKind === 'push' || wasKind === 'race') && car.sector === 2 && !car.inPit;
    car.lapBad = wasKind === 'push' ? 'error' : null;   // (lo afina abajo si la vuelta es válida)
    car.lap++;
    this.evo += 1 / 20;
    car.tyre.age++;
    if (race) car.dist = car.lap * T.L + car.s;
    if (valid) {
      car.lastLap = lapT; car.laps.push(lapT);
      const clean = car.lapClean;
      if (lapT < car.best && (clean || race)) { car.best = lapT; if (!race) car.bestCP = car.lapCP.slice(); }
      if (clean) car.runGood = true;
      if (clean || race) {
        if (!this.fastest || lapT < this.fastest.t) {
          const had = !!this.fastest; this.fastest = { car, t: lapT, lap: car.lap };
          if (!race) this.bestCP = car.lapCP.slice();
          if (had || !race) this.emit({ type: 'fastest', car, time: lapT });
        }
      }
      // también en carrera (si no, el panel de aprendizaje salía vacío), salvo las dos primeras: la salida parada y el pelotón aún agrupado (8–15 s más lentas)
      const traffic = race && (car.trafT || 0) > lapT * 0.3;
      // (mánager en libres y clasificación: también es de tráfico si ha cedido el paso o ha ido pegado a otro: no sirve para comparar)
      const trafM = !race && ((car.yieldT || 0) > 0.6 || (car.trafT || 0) > lapT * 0.25);
      if (wasKind === 'push') car.lapBad = !clean ? 'error' : trafM ? 'tráfico' : null;
      // mánager: cada vuelta de su equipo, con goma, desgaste, gasolina y reglaje (pestaña de rendimiento)
      // (tiempo corregido: sin la gasolina y con la pista como si ya tuviera toda la goma: si no, lo de más tarde siempre parece mejor)
      if (car.mgr) car.mgr.laps.push({ s: ss.id, lap: car.lap, t: lapT, tf: (lapT - car.fuel * 0.03) * Math.sqrt(this.evoFactor()), test: !!car.testRun, c: car.tyre.c, w0: car.lapW0, w1: car.tyre.wear, age: car.tyre.age,
        trim: car.trim || 0, susp: car.susp || 0, pace: car.mgr.pace, ers: car.mgr.ers, ok: clean && !car.lapFlag && !traffic && !trafM && !(race && car.lap <= 1), wet: this.wx.line > 0.15, water: this.wx.line,
        fuel: car.fuel, sec: car.curSectors.slice(), know: car.brain.acc, why: !clean ? 'error' : car.lapFlag ? 'bandera/boxes' : traffic || trafM ? 'tráfico' : race && car.lap <= 1 ? 'salida' : '' });
      if (clean && !car.lapFlag && !traffic && !(race && car.lap <= 2)) {
        car.brain.laps++;
        car.brain.lapHist.push({ w: this.weekend, s: ss.id, t: lapT, wet: car.kb !== car.brain, c: car.tyre.c });
        if (car.brain.lapHist.length > 200) car.brain.lapHist.shift();
      }
      // degradación: tiempo corregido por gasolina frente a edad del neumático
      if (clean && isFP(ss.id) && car.run?.kind === 'long' && this.wx.wet < 0.05) addDeg(car.brain, car.tyre.c, car.tyre.age, lapT - car.fuel * 0.03);
      if (race && clean && !car.lapFlag && car.tyre.age > 1 && this.wx.wet < 0.05) addDeg(car.brain, car.tyre.c, car.tyre.age, lapT - car.fuel * 0.03);
      this.emit({ type: 'lap', car, time: lapT, best: lapT === car.best });
    }
    car.prevSectors = car.curSectors.slice(); car.prevSecCol = (car.secCol || []).slice();
    car.lapStart = this.t; car.sectorStart = this.t; car.sector = 0; car.lapClean = true; car.lapFlag = false; car.trafT = 0; car.yieldT = 0; car.secCol = [];
    car.lapCP = []; car.cpK = -1; car.delta = null; car.deltaOwn = null; car.lapW0 = car.tyre.wear;
    car.wobble = 1 + gauss(this.rng) * 0.0035 * (1.25 - car.drv.cons) * (1 + 2.2 * this.wx.wet);
    if (race) this.raceLap(car); else this.practiceLap(car);
    this.rebuildProfile(car);
  }

  practiceLap(car) {
    const ss = this.session;
    const run = car.run; car.runLaps++;
    const flag = ss.phase !== 'run';
    if (flag && !car.inPit) car.finished = true;   // cruza la meta con la bandera: bandera de cuadros en la tabla
    if (car.lapKind === 'out' && car.inPit) { car.runLaps--; return; }
    if (this.mgrHand(car)) {
      const M = car.mgr, was = car.lapKind;
      // lanzadas: la que sale con error o tráfico no cuenta y se repite (salvo que el mánager diga que vale: aviso 'badlap')
      if (was === 'push') {
        if (car.lapBad && run.kind === 'quali' && run.repeat !== false) this.emit({ type: 'badlap', car, why: car.lapBad });
        else car.pushN = (car.pushN || 0) + 1;
      }
      if (flag || M.boxReq || (run.laps && car.pushN >= run.laps) || was === 'in') { car.lapKind = 'in'; car.pitReq = true; return; }
      // vuelta rápida: lanzada y (si se quiere) vuelta tranquila para enfriar; tanda: todas seguidas. El mánager puede
      // decidir la siguiente vuelta en directo (M.nextLap)
      // (probado y descartado: esperar en el garaje a un hueco o ir despacio una vuelta para abrirlo; con 22 coches a ritmos
      // parecidos el tráfico llega igual durante la tanda: ~45 % de lanzadas con tráfico en todos los casos)
      car.lapKind = M.nextLap || (run.kind === 'quali' && was === 'push' && run.cool !== false ? 'cool' : 'push');
      M.nextLap = null;
      return;
    }
    if (car.lapKind === 'out') car.lapKind = 'push';
    else if (car.lapKind === 'push' || car.lapKind === 'cool') {
      if (isFP(ss.id)) {
        if (car.runLaps >= run.laps + 1 || flag) { car.lapKind = 'in'; car.pitReq = true; }
        else if (run.kind === 'quali' && car.lapKind === 'push' && this.rng() < 0.5) car.lapKind = 'cool';
        else car.lapKind = 'push';
      } else {
        // clasificación: otra vuelta lanzada si la ha fallado o si tenía previstas dos, y si le da tiempo antes de la bandera
        const est = isFinite(car.best) ? car.best : 88, left = ss.dur - this.t;
        const pushes = car.runLaps - 1;
        const again = !flag && left > est + 5 && car.tyre.wear < 0.3 && (pushes < run.laps || (!car.runGood && pushes < run.laps + 1));
        if (again) car.lapKind = 'push';
        else { car.lapKind = 'in'; car.pitReq = true; }
      }
    }
    if (flag && car.lapKind !== 'in') { car.lapKind = 'in'; car.pitReq = true; }
    // gomas equivocadas para el agua que hay: a boxes a cambiarlas
    if (!flag && car.lapKind !== 'in' && this.wxTyre(car)) { car.lapKind = 'in'; car.pitReq = true; car.wxPit = true; }
  }

  raceLap(car) {
    const ss = this.session, T = this.T;
    if (car.lap >= 0) car.hist.push(car.pos);
    if (car.lap === 0) car.lapKind = 'race';
    if (ss.phase === 'flag' && !car.finished && !car.retired) {
      car.finished = true; car.finishT = this.t; car.finishPos = ++this.finishCount;
      this.emit({ type: 'finish', car, pos: car.finishPos });
      return;
    }
    if (car.lap >= this.raceLaps && ss.phase === 'green') {
      ss.phase = 'flag'; this.flagT = this.t; this.finishCount = 1;
      car.finished = true; car.finishT = this.t; car.finishPos = 1;
      this.emit({ type: 'chequered', car });
      this.emit({ type: 'finish', car, pos: 1 });
      return;
    }
    this.pitDecision(car);
  }

  // reglaje (mánager). Alerón: -1 poca carga (más punta) … +1 mucha carga (más paso por curva).
  // Suspensión: -1 blanda (más agarre mecánico en lentas, cuida la goma) … +1 dura (plataforma estable: más carga en rápidas, gasta más)
  aeroK(car) { return car.team.aero * (1 + 0.07 * (car.trim || 0)) * (1 + 0.05 * (car.susp || 0)); }
  dragK(car) { return car.team.drag * (1 + 0.14 * (car.trim || 0)); }
  gripK(car) { return car.team.grip * (1 - 0.01 * (car.susp || 0)); }
  paceG(car) { return car.mgr ? MGR.pace[car.mgr.pace].g : 1; }
  // modo motor del mánager (sin batería, el ataque no da nada)
  ersK(car) { const M = car.mgr; if (!M || car.inPit) return 1; const e = MGR.ers[M.ers]; return e.pw > 1 && car.ers <= 0 ? 1 : e.pw; }

  // mánager: la estrategia es suya. Para cuando lo pide el plan o cuando le dice «para en esta vuelta»; nada más
  // (ni lluvia, ni daños, ni rivales: eso le llega como aviso)
  mgrPit(car) {
    const M = car.mgr; if (car.inPit || car.finished || car.retired) return;
    const left = this.raceLaps - car.lap, sts = car.strategy.stints, st = sts[car.stint];
    // solo para cuando lo pide el mánager: la parada del plan es un aviso, no una orden (le molestaba que sus coches
    // entrasen solos con el plan sugerido o con las gomas gastadas)
    car.pitReq = left > 0 && !!M.stopNow && !!st;
  }
  // «para en esta vuelta»: la tanda actual acaba aquí y la siguiente empieza ya (con su goma, o con la que se pida)
  mgrStopNow(car, c) {
    const M = car.mgr, sts = car.strategy?.stints; if (!M || !sts) return;
    M.stopNow = true;
    if (!sts[car.stint + 1]) sts.push({ c: c || car.tyre.c, from: car.lap + 1, to: this.raceLaps });
    else if (c) sts[car.stint + 1].c = c;
  }
  // ajusta el plan a la vuelta real de la parada (la tanda que empieza conserva su final; las de después se empujan si hace falta)
  mgrFixPlan(car, L) {
    const sts = car.strategy.stints;
    if (sts[car.stint - 1]) sts[car.stint - 1].to = L;
    if (sts[car.stint]) sts[car.stint].from = L;
    for (let k = car.stint; k < sts.length; k++) {
      if (k > car.stint) sts[k].from = sts[k - 1].to;
      if (sts[k].to <= sts[k].from) sts[k].to = Math.min(this.raceLaps, sts[k].from + 1);
    }
    while (sts.length > car.stint + 1 && sts[sts.length - 1].from >= this.raceLaps) sts.pop();
    sts[sts.length - 1].to = this.raceLaps;
  }

  // ¿parar esta vuelta? plan + desgaste real + reacción al rival + VSC barato

  pitDecision(car) {
    const T = this.T;
    if (car.finished || car.retired) return;
    const lapsLeft = this.raceLaps - car.lap;
    const st = car.strategy.stints[car.stint];
    if (!st) return;
    const needNew = car.tyre.used.size < 2 && !car.tyre.used.has('I') && !car.tyre.used.has('W');
    if (this.mgrHand(car)) return this.mgrPit(car);
    let want = false;
    if (car.stint < car.strategy.stints.length - 1 && car.lap + 1 >= st.to) want = true;
    if (car.tyre.wear > 0.8 && lapsLeft > 2) want = true;
    if (car.dmg > 0.3 && lapsLeft > 1) want = true;
    // undercut / cubrir: el de delante ha parado y estamos en ventana
    const inWindow = car.stint < car.strategy.stints.length - 1 && car.lap + 3 >= st.to;
    const ah = this.carAheadOnTrack(car);
    if (inWindow && this.rng() < 0.4 * car.drv.craft) want = true;
    if (this.flag === 'VSC' && inWindow) want = true;
    if (lapsLeft <= 1 && !needNew && car.tyre.wear < 0.9) want = false;
    if (needNew && lapsLeft <= 3) want = true;
    const wx = this.wxTyre(car);
    if (wx && lapsLeft > 0) { car.pitReq = true; car.wxC = wx; return; }
    // empieza a llover y va con lisos: la parada prevista se aguanta hasta la de gomas de agua (salvo gomas muertas)
    const W = this.wx;
    if (want && !COMPOUNDS[car.tyre.c].wet && (W.rain > 0.08 || W.target > 0.25) && car.tyre.wear < 0.85 && car.dmg <= 0.3) want = false;
    if (want && lapsLeft > 0) {
      car.pitReq = true;
      if (!car.strategy.stints[car.stint + 1]) {
        const opts = ['H', 'M', 'S'].filter((c) => lapsLeft <= [1.05, 0.72, 0.45][['H', 'M', 'S'].indexOf(c)] * this.raceLaps + 1);
        let c = opts.find((x) => !car.tyre.used.has(x)) || opts[opts.length - 1] || 'H';
        if (lapsLeft < this.raceLaps * 0.35) c = !car.tyre.used.has('S') || car.tyre.used.size >= 2 ? 'S' : c;
        car.strategy.stints.push({ c, from: car.lap, to: this.raceLaps });
      }
    }
  }

  // Modelo interno del piloto: tiempo que cree que tardaría en la zona z con esos nodos (frenada + aceleración,
  // con la elipse de agarre). modelPrep calcula la ventana entera; modelNode solo el tramo que mueve un nodo.
  modelPrep(car, nodes, z) {
    const T = this.T, N = T.N, zone = T.zones[z];
    if (!this.mL) { this.mL = new Float64Array(N); this.mK = new Float64Array(N); this.mLen = new Float64Array(N); this.mV = new Float64Array(N); }
    const w0 = T.idx(zone.a - 90), wl = Math.round(zone.len + 190), L = this.mL;
    for (let q = -14; q < wl + 14; q++) { const i = ((w0 + q) % N + N) % N; L[i] = car.line[i]; }
    buildLine(T, { nodes }, L, w0, wl);
    lineGeometry(T, L, this.mK, this.mLen, w0, wl);
    this.mw = { w0, wl };
  }
  // recalcula el tramo que mueve el nodo j; con save guarda antes lo que había para poder deshacerlo con modelUndo
  modelNode(nodes, j, save) {
    const T = this.T, N = T.N, [a, cnt] = nodeSpan(T, nodes.length, j, j);
    if (save) {
      const B = this.mBak || (this.mBak = { L: new Float64Array(600), K: new Float64Array(600), E: new Float64Array(600) });
      for (let q = -10; q < cnt + 10; q++) { const i = ((a + q) % N + N) % N; B.L[q + 10] = this.mL[i]; B.K[q + 10] = this.mK[i]; B.E[q + 10] = this.mLen[i]; }
      B.a = a; B.cnt = cnt;
    }
    buildLine(T, { nodes }, this.mL, a, cnt); lineGeometry(T, this.mL, this.mK, this.mLen, a, cnt);
  }
  modelUndo() {
    const N = this.T.N, B = this.mBak, { a, cnt } = B;
    for (let q = -10; q < cnt + 10; q++) { const i = ((a + q) % N + N) % N; this.mL[i] = B.L[q + 10]; this.mK[i] = B.K[q + 10]; this.mLen[i] = B.E[q + 10]; }
  }
  modelRun(car, nodes, z) {
    const T = this.T, N = T.N, K = this.mK, LEN = this.mLen, V = this.mV, { w0, wl } = this.mw;
    const aero = AERO * this.aeroK(car), mass = MASS + car.fuel, drag = CD * this.dragK(car) / mass, inDRS = T.inDRS, zoneOf = T.zoneOf;
    // agarre que cree tener en cada muestra de la ventana
    const MUA = this.mMu || (this.mMu = new Float64Array(N));
    const muZ = car.muPlan * this.commitAt(car, z), mu0 = car.muPlan, commit = car.kb.commit;
    // (y sabe que en las rectas de DRS irá con el alerón abierto: menos carga)
    for (let q = 0; q < wl; q++) {
      const i = (w0 + q) % N, zz = zoneOf[i], mu = MUA[i] = zz === z ? muZ : zz < 0 ? mu0 : mu0 * commit[zz];
      V[i] = vCorner(K[i], mu, inDRS[i] ? aero * 0.8 : aero);
    }
    // frenada hacia atrás desde la salida de la ventana (con la elipse de agarre)
    let vn = car.vprof[(w0 + wl) % N];
    for (let q = wl - 1; q >= 0; q--) {
      const i = (w0 + q) % N, v2 = vn * vn, cap = MUA[i] * (G + aero * v2);
      const r = v2 * Math.abs(K[i]) / cap, el = r >= 0.993 ? 0.12 : Math.max(0.12, Math.sqrt(1 - r * r));
      const lim = Math.sqrt(v2 + 2 * (BRK * cap * el + drag * v2) * LEN[i]);
      if (lim < V[i]) V[i] = lim; vn = V[i];
    }
    // aceleración hacia delante
    let v = Math.min(V[w0], car.vprof[w0]), t = 0;
    const pw = car.team.power * 1000 * POWER / mass, roll = ROLL / mass;
    for (let q = 0; q < wl; q++) {
      const i = (w0 + q) % N, v2 = v * v, cap = MUA[i] * (G + aero * v2);
      const r = v2 * Math.abs(K[i]) / cap, el = r >= 0.993 ? 0.12 : Math.max(0.12, Math.sqrt(1 - r * r));
      const a = Math.min(TRAC * cap * el, pw * gearPower(v) / (v > 8 ? v : 8)) - drag * v2 - roll;
      const vf = Math.sqrt(Math.max(1, v2 + 2 * (a > 0 ? a : 0) * LEN[i]));
      const vi = V[i] < vf ? V[i] : vf;
      t += LEN[i] / Math.max(1, (v + vi) / 2); v = vi;
    }
    // trazada suave: los zigzags cuestan goma y estabilidad (penaliza la segunda diferencia de los nodos)
    const [lo, hi] = this.zRange[z], n = nodes.length;
    let pen = 0;
    for (let j = lo - 2; j <= hi + 2; j++) { const a = nodes[((j - 1) % n + n) % n], b = nodes[((j % n) + n) % n], c = nodes[(j + 1) % n]; const d2 = a - 2 * b + c; pen += d2 * d2; }
    return t + pen * 0.00095;   // (nodos cada 15 m: la segunda diferencia sale menor que con 20)
  }
  modelTime(car, nodes, z) { this.modelPrep(car, nodes, z); return this.modelRun(car, nodes, z); }

  // ------------------------------------------------------------ planes de adelantamiento
  // inside: tirarse por dentro · outside: por fuera en curva rápida/larga · cutback: entrar abierto y cruzar a la salida
  // exit: dejar hueco en curva lenta para salir mejor y pasar con rebufo en la recta
  choosePlan(car, nc) {
    const ot = car.brain.ot[nc.id];
    if (!ot.p) ot.p = { inside: { t: 0, w: 0 }, outside: { t: 0, w: 0 }, cutback: { t: 0, w: 0 }, exit: { t: 0, w: 0 } };
    const R = nc.radius, T = this.T;
    const next = T.corners[(nc.id + 1) % T.corners.length];
    const straightAfter = T.ahead(nc.sOut, next.sIn);
    const prior = {
      inside: R < 60 ? 0.6 : 0.45,
      outside: R > 70 ? 0.5 : R > 40 ? 0.28 : 0.12,
      cutback: R < 60 ? 0.42 : 0.2,
      exit: R < 55 && straightAfter > 500 ? 0.55 : straightAfter > 350 ? 0.3 : 0.1,
    };
    const tgt = car.target;
    if (tgt && tgt.mode === 'defend' && tgt.defMoved) { prior.cutback += 0.2; prior.outside += 0.12; prior.inside -= 0.2; }
    let best = 'inside', bs = -1;
    for (const k of Object.keys(prior)) {
      const st = ot.p[k];
      const learned = (st.w + prior[k] * 2) / (st.t + 2);
      const sc = learned + (this.rng() - 0.5) * 0.25 * (1.2 - car.drv.craft) + (k === 'inside' ? car.drv.agg * 0.08 : 0) + (k === 'cutback' || k === 'exit' ? car.drv.craft * 0.06 : 0);
      if (sc > bs) { bs = sc; best = k; }
    }
    return { type: best, z: nc.id, o: tgt };
  }

  planResult(car, tr, win) {
    const ot = car.brain.ot[tr.zone]; if (!ot) return;
    ot.t++; if (win) ot.w++;
    if (!ot.p) ot.p = { inside: { t: 0, w: 0 }, outside: { t: 0, w: 0 }, cutback: { t: 0, w: 0 }, exit: { t: 0, w: 0 } };
    const st = ot.p[tr.plan || 'inside']; st.t++; if (win) st.w++;
  }

  // ------------------------------------------------------------ aprendizaje
  // Los nodos de la trazada en uso (car.work) = los del cerebro + lo que se esté probando (candidato)
  // o la trazada alternativa de ataque. Todo se escribe por rangos de nodos de una zona.
  writeNodes(car, lo, hi, vals) {
    const n = car.work.length;
    for (let j = lo; j <= hi; j++) car.work[j % n] = vals ? vals[j - lo] : car.kb.nodes[j % n];
    const [i0, cnt] = nodeSpan(this.T, n, lo, hi);
    buildLine(this.T, { nodes: car.work }, car.line, i0, cnt); lineGeometry(this.T, car.line, car.kl, car.len, i0, cnt);
    car.dev = car.d - this.T.lerp(car.line, car.s);
  }

  revertCand(car, c) {
    if (c.vals) this.writeNodes(car, c.lo, c.hi, null);
    this.rebuildProfile(car, this.T.zones[c.z]);
  }

  // Búsqueda local con el modelo interno: mueve cada nodo ±h y se queda con lo que cree más rápido.
  // x: nodos completos (se modifica). cons(j, v): restricción del nodo j. frac: fracción de nodos que revisa.
  refine(car, z, x, lo, hi, h, frac, cons, t0) {
    const n = x.length;
    this.modelPrep(car, x, z);
    let best = t0 ?? this.modelRun(car, x, z), improved = false;
    for (let j = lo; j <= hi; j++) {
      if (this.rng() > frac) continue;
      const idx = j % n, o = x[idx];
      for (const sg of this.rng() < 0.5 ? [1, -1] : [-1, 1]) {
        let v = this.clampN(j, n, o + sg * h);
        if (cons) v = cons(j, v);
        if (Math.abs(v - o) < 1e-3) continue;
        x[idx] = v; this.modelNode(x, idx, true);
        const t = this.modelRun(car, x, z);
        if (t < best - 2e-4) { best = t; improved = true; break; }
        x[idx] = o; this.modelUndo();
      }
    }
    return { t: best, improved };
  }

  // Trazadas alternativas para adelantar (por dentro, por fuera, cruce): obligan a ir a un lado de la
  // trazada buena en un tramo de la curva; el resto lo optimiza el piloto con su modelo.
  altCons(car, z, type) {
    const T = this.T, c = T.corners[z], inside = c.dir, n = car.kb.nodes.length, step = T.L / n;
    const apexU = T.rel(c.sIn, c.apex), outU = T.rel(c.sIn, c.sOut);
    const [u0, u1, side, m] = type === 'inside' ? [-60, apexU * 0.6, inside, 3.2]
      : type === 'outside' ? [-25, apexU + 12, -inside, 3.2]
      : [apexU - 5, outU + 35, inside, 3.0];
    return (j, v) => {
      const u = T.rel(c.sIn, T.wrap(j * step));
      if (u < u0 || u > u1) return v;
      const r = car.kb.nodes[j % n];
      return this.clampN(j, n, side * (v - r) < m ? r + side * m : v);
    };
  }

  altEntry(car, z, type) {
    const b = car.brain; if (!b.alt) b.alt = [];
    if (!b.alt[z]) b.alt[z] = {};
    let e = b.alt[z][type];
    const [lo, hi] = this.zRange[z], n = b.nodes.length;
    // se guarda como desplazamiento respecto a la trazada buena: si esta mejora, la alternativa la sigue
    if (!e || !e.dv || e.dv.length !== hi - lo + 1) {
      const cons = this.altCons(car, z, type);
      e = b.alt[z][type] = { dv: [], h: 1.5, n: 0 };
      for (let j = lo; j <= hi; j++) e.dv.push(cons(j, b.nodes[j % n]) - b.nodes[j % n]);
    }
    return e;
  }

  altNodes(car, z, type, e) {
    const [lo, hi] = this.zRange[z], n = car.kb.nodes.length, cons = this.altCons(car, z, type), out = [];
    for (let j = lo; j <= hi; j++) out.push(cons(j, this.clampN(j, n, car.kb.nodes[j % n] + e.dv[j - lo])));
    return out;
  }

  // ensayo mental de una alternativa (sin tocar la pista)
  practiseAlt(car, z, type, sweeps) {
    const e = this.altEntry(car, z, type), [lo, hi] = this.zRange[z], n = car.work.length;
    const x = Float64Array.from(car.kb.nodes), cons = this.altCons(car, z, type);
    const v0 = this.altNodes(car, z, type, e);
    for (let j = lo; j <= hi; j++) x[j % n] = v0[j - lo];
    let t = this.modelTime(car, x, z);
    for (let k = 0; k < sweeps; k++) {
      const r = this.refine(car, z, x, lo, hi, e.h, 0.5 + 0.45 * car.drv.learn, cons, t); t = r.t;
      if (!r.improved) e.h = Math.max(0.1, e.h * 0.6);
    }
    for (let j = lo; j <= hi; j++) e.dv[j - lo] = x[j % n] - car.kb.nodes[j % n];
    e.n++;
  }

  setAlt(car, z, type) {
    if (car.alt && car.alt.z === z && car.alt.type === type) return;
    this.clearAlt(car);
    if (car.cand && car.cand.z === z) return;               // ya está en la curva probando otra cosa
    if (car.candNext && car.candNext.z === z) { this.revertCand(car, car.candNext); car.candNext = null; }
    const e = this.altEntry(car, z, type), [lo, hi] = this.zRange[z];
    this.writeNodes(car, lo, hi, this.altNodes(car, z, type, e));
    car.alt = { z, type };
    this.rebuildProfile(car, this.T.zones[z]);
  }

  clearAlt(car) {
    if (!car.alt) return;
    const [lo, hi] = this.zRange[car.alt.z];
    this.writeNodes(car, lo, hi, null);
    this.rebuildProfile(car, this.T.zones[car.alt.z]);
    car.alt = null;
  }

  // ~250 m antes de la zona: decide qué probar en ella (aún no ha empezado a frenar)
  planZone(car, z) {
    const T = this.T, ss = this.session, b = car.kb;
    if (car.candNext) { this.revertCand(car, car.candNext); car.candNext = null; }
    const phase = isFP(ss.id) ? 'FP' : ss.id === 'RACE' ? 'R' : 'Q';
    const pushing = car.lapKind === 'push' || car.lapKind === 'race';
    if (car.inPit || this.flag !== 'GREEN' || car.retired) return;
    // ensayo mental de las trazadas de ataque (en libres sobre todo, y en carrera cuando va en tráfico)
    const pAlt = phase === 'FP' ? 0.45 : phase === 'R' ? (car.mode === 'attack' ? 0.8 : 0.25) : 0.15;
    if (this.rng() < pAlt) {
      const types = ['inside', 'outside', 'cutback'];
      const e = types.map((ty) => this.altEntry(car, z, ty));
      const k = e.reduce((m, x, q) => (x.n < e[m].n ? q : m), 0);
      this.practiseAlt(car, z, types[k], 1);
    }
    if (!pushing || car.mode !== 'free' || (car.alt && car.alt.z === z) || car.testRun) return;   // (modo consistente: nada de pruebas en pista)
    const pExp = phase === 'FP' ? 0.9 : phase === 'Q' ? 0.35 : 0.25;
    if (this.rng() >= pExp) return;
    const zone = T.zones[z], [lo, hi] = this.zRange[z], n = car.work.length;
    const exp = b.zoneN[z];
    const scale = phase === 'FP' ? 1 : phase === 'Q' ? 0.45 : 0.3;
    // compromiso (cuánto agarre usa): sesgo hacia arriba para buscar el límite
    const sc = (0.016 * Math.exp(-exp / 40) + 0.005) * scale * (1.2 - 0.4 * car.drv.learn);
    const cand = { z, lo, hi, vals: null, commit: b.commit[z] + gauss(this.rng) * sc + sc * 0.45, pred: 0, imit: null, t0: this.t };
    // trazada: parte de la suya, mira la del más rápido en esa curva y la pule con su modelo interno
    const x = Float64Array.from(b.nodes);
    const base = this.modelTime(car, x, z);
    let bestT = base, bestX = null;
    const zb = this.zBest(car)?.[z];
    if (zb && zb.code !== car.code && b.zoneBase[z] > 0 && zb.t < b.zoneBase[z] - 0.015 && this.rng() < (phase === 'FP' ? 0.5 : 0.3)) {
      const y = Float64Array.from(x), f = 0.35 + this.rng() * 0.5;
      for (let j = lo; j <= hi; j++) y[j % n] += (zb.nodes[j % n] - y[j % n]) * f;
      const t = this.modelTime(car, y, z);
      if (t < bestT) { bestT = t; bestX = y; cand.imit = zb.code; }
    }
    // idea nueva: un bache suave en algún punto de la curva
    for (let k = 0; k < (phase === 'FP' ? 3 : 1); k++) {
      const y = Float64Array.from(bestX || x);
      const center = lo + Math.floor(this.rng() * (hi - lo + 1)), width = 1.2 + this.rng() * 2.5;
      const amp = gauss(this.rng) * (1.4 * Math.exp(-exp / 50) + 0.3) * scale;
      for (let j = lo; j <= hi; j++) y[j % n] = this.clampN(j, n, y[j % n] + amp * Math.exp(-((j - center) ** 2) / (2 * width * width)));
      const t = this.modelTime(car, y, z);
      if (t < bestT) { bestT = t; bestX = y; cand.imit = null; }
    }
    // pulido: búsqueda local nodo a nodo (el paso se afina con la experiencia en esa curva)
    if (!b.zh) b.zh = new Array(T.zones.length).fill(1.4);
    const y = Float64Array.from(bestX || x);
    const sweeps = phase === 'FP' ? 2 : 1;
    let t = bestT;
    for (let k = 0; k < sweeps; k++) {
      const r = this.refine(car, z, y, lo, hi, b.zh[z] * scale ** 0.5, 0.35 + 0.5 * car.drv.learn, null, t); t = r.t;
      if (!r.improved) b.zh[z] = Math.max(0.08, b.zh[z] * 0.65);
    }
    if (t < bestT) { bestT = t; bestX = y; }
    if (bestX && base - bestT > 0.002) {
      cand.vals = []; for (let j = lo; j <= hi; j++) cand.vals.push(bestX[j % n]);
      cand.pred = base - bestT;
    } else cand.imit = null;
    car.candNext = cand;
    if (cand.vals) this.writeNodes(car, lo, hi, cand.vals);
    this.rebuildProfile(car, zone);
  }

  zoneEnter(car, z) {
    car.zoneIn = z; car.zoneT0 = this.t; car.zoneClean = !car.inPit && car.mistake == null; car.zoneMist = false; car.zoneSlide = 0; car.zoneWide = false;
    // cuánto aprieta en esta entrada: nunca igual (los constantes varían menos); bajo presión, algo más
    const ss = this.session, press = ss.id === 'RACE' ? (car.mode === 'attack' || car.mode === 'defend' ? 0.006 : 0) : car.lapKind === 'push' && !isFP(ss.id) ? 0.003 : 0;
    // en libres busca el límite (más variación), en una vuelta de clasificación arriesga, y con agua le cuesta más medir
    const explore = car.testRun ? 1 : isFP(ss.id) ? 1.7 : car.lapKind === 'push' ? 1.45 : 1;
    const wetSd = 1 + (COMPOUNDS[car.tyre.c].wet ? 0.9 : 0.4) * Math.min(1, this.wetAt(car) * 2);
    // (modo prueba del mánager: conduce de forma repetible, casi igual en cada curva)
    const sdM = (car.mgr ? MGR.pace[car.mgr.pace].sd : 1) * (car.testRun ? 0.35 : 1);
    car.exec = 1 + gauss(this.rng) * EXEC_SD * (1.3 - car.drv.cons) * Math.min(2.1, explore * wetSd) * sdM + press * (1.2 - car.drv.cons);
    car.zoneV0 = car.v;
    // a veces, al abrir gas a la salida, se le va la trasera (y la caza): más los agresivos y con agua
    const wet = COMPOUNDS[car.tyre.c].wet ? Math.min(1, this.wetAt(car) * 3) : 0;   // (con lisos en mojado ya tiene bastante)
    car.kick = !car.inPit && this.rng() < (car.testRun ? 0.004 : 0.016) * (0.6 + car.drv.agg) * (1 + 1.5 * wet) * (ss.id === 'RACE' ? 1 : 1.3) ? 0.08 + this.rng() * (0.17 + 0.15 * wet) : 0;
    const c = car.candNext;
    if (c && c.z === z) {
      car.candNext = null;
      if (car.mode === 'free' && !car.inPit && this.flag === 'GREEN') { car.cand = c; car.cand.t0 = this.t; }
      else this.revertCand(car, c);
    }
  }

  // mejores pasos por curva de la sesión, aparte en seco y en mojado
  zBest(car, make) {
    const k = car.kb === car.brain ? 'zoneBest' : 'zoneBestW';
    if (make && !this[k]) this[k] = [];
    return this[k];
  }
  // ¿se puede aprender ahora? en seco con la pista seca; en mojado con gomas de agua y la pista mojada y estable
  canLearn(car) {
    const W = this.wx;
    if (car.kb === car.brain) return W.wet <= 0.06;
    return COMPOUNDS[car.tyre.c].wet && W.line > 0.25 && Math.abs(W.target - W.rain) < 0.2 && Math.abs(this.wetAt(car) - (car.wetEst || 0)) < 0.12;
  }

  // estadísticas de aprendizaje por condición (seco d / mojado w) y registro de lo último que han aprendido
  lstat(car) {
    const B = car.brain, k = car.kb === car.brain ? 'd' : 'w';
    B.cs ||= { d: { exp: 0, acc: 0, mist: 0, locks: 0, catches: 0, xfer: 0 }, w: { exp: 0, acc: 0, mist: 0, locks: 0, catches: 0, xfer: 0 } };
    return B.cs[k];
  }
  learnNote(car, kind, z, gain) {
    const L = this.learnLog ||= [];
    L.push({ t: this.t, sess: this.session?.id, car, kind, corner: z != null && z >= 0 ? this.T.corners[z]?.name : '', gain, wet: car.kb !== car.brain });
    if (L.length > 300) L.shift();
  }

  zoneExit(car, z) {
    const b = car.kb, B = car.brain;
    const t = this.t - car.zoneT0;
    // normalizar por agarre y velocidad de entrada
    const norm = t * Math.sqrt(car.muPlan * car.wobble / MU) * (1 + (car.zoneV0 - (car.zoneVref?.[z] ?? car.zoneV0)) * 0.002);
    const cand0 = car.cand; car.cand = null;
    if (!this.canLearn(car)) {
      if (cand0?.vals) this.writeNodes(car, cand0.lo, cand0.hi, null);
      if (cand0) this.rebuildProfile(car, this.T.zones[z]);
      if (car.otTry && car.otTry.zone === z) { this.planResult(car, car.otTry, false); car.otTry = null; }
      car.zoneIn = -1; return;
    }
    const cand = cand0;
    const clean = car.zoneClean && !car.zoneMist;
    if (car.alt && car.alt.z === z) this.clearAlt(car);
    if (cand) {
      B.exp++; this.lstat(car).exp++;
      let accept = false;
      if (clean && b.zoneN[z] > 0 && norm < b.zoneBase[z] - 0.008) accept = true;
      // trazada que su modelo da por mejor: basta con que la pista no la desmienta
      if (cand.pred && clean && b.zoneN[z] > 0 && norm < b.zoneBase[z] + 0.015 && car.zoneSlide < 0.04) accept = true;
      if (clean && b.zoneN[z] === 0) accept = true;
      if (car.zoneMist) { b.commit[z] = Math.min(b.commit[z], cand.commit) - 0.012 * (0.6 + car.drv.learn * 0.6); this.learnNote(car, 'prudente', z, 0); }
      else if (car.zoneSlide > 0.04 && cand.commit > b.commit[z]) accept = false;
      if (accept) {
        // un poco de lo aprendido vale también para la otra condición
        const o = this.otherKB(car), n = b.nodes.length;
        o.commit[z] += (cand.commit - b.commit[z]) * 0.15;
        if (cand.vals) for (let j = cand.lo; j <= cand.hi; j++) o.nodes[j % n] += (cand.vals[j - cand.lo] - b.nodes[j % n]) * 0.12;
        B.acc++; b.commit[z] = cand.commit; cand.accepted = true;
        const st = this.lstat(car); st.acc++; st.xfer++;
        this.learnNote(car, cand.vals ? (cand.imit ? 'copia' : 'trazada') : 'limite', z, b.zoneN[z] > 0 ? Math.max(0, b.zoneBase[z] - norm) : 0);
        if (cand.vals) for (let j = cand.lo; j <= cand.hi; j++) b.nodes[j % n] = cand.vals[j - cand.lo];
        if (cand.imit) B.imit = (B.imit || 0) + 1;
        b.zoneBase[z] = b.zoneN[z] > 0 ? b.zoneBase[z] * 0.5 + norm * 0.5 : norm; b.zoneN[z]++;
      } else if (cand.vals) this.writeNodes(car, cand.lo, cand.hi, null);
      if (clean && !accept && b.zoneN[z] > 0) b.zoneBase[z] = b.zoneBase[z] * 0.9 + norm * 0.1;
      this.rebuildProfile(car, this.T.zones[z]);
    } else if (clean && (car.lapKind === 'push' || car.lapKind === 'race')) {
      if (b.zoneN[z] === 0) { b.zoneBase[z] = norm; b.zoneN[z] = 1; }
      else b.zoneBase[z] = b.zoneBase[z] * 0.8 + norm * 0.2;
    }
    car.zoneVref = car.zoneVref || []; car.zoneVref[z] = car.zoneV0;
    // mejor paso por curva visto en la sesión (lo que los demás pueden estudiar)
    if (clean && (!cand || cand.accepted || !cand.vals)) {
      const zbs = this.zBest(car, true), zb = zbs[z];
      if (!zb || norm < zb.t) zbs[z] = { t: norm, code: car.code, nodes: b.nodes.slice(), commit: b.commit[z] };
    }
    // ¿salió el adelantamiento?
    if (car.otTry && car.otTry.zone === z) {
      // el plan "a la salida" se resuelve en la recta siguiente: se da por perdido una zona después
      if (car.otTry.plan === 'exit' && !car.otTry.late) car.otTry.late = true;
      else { this.planResult(car, car.otTry, false); car.otTry = null; }
    } else if (car.otTry && car.otTry.late) { this.planResult(car, car.otTry, false); car.otTry = null; }
    car.zoneIn = -1;
  }

  // ---------------------------------------------------------------- contactos
  collide() {
    const T = this.T, cars = this.cars;
    const racing = this.session.id !== 'RACE' || this.session.phase === 'green' || this.session.phase === 'flag';
    if (!racing) return;
    for (let a = 0; a < cars.length; a++) {
      const A = cars[a]; if (!live(A) || A.state === 'grid') continue;
      for (let b = a + 1; b < cars.length; b++) {
        const B = cars[b]; if (!live(B) || B.state === 'grid') continue;
        if (A.inPit !== B.inPit) continue;
        const rel = T.rel(A.s, B.s);
        if (Math.abs(rel) > LEN) continue;
        const lat = Math.abs(A.d - B.d);
        if (lat >= 2.0) continue;
        const front = rel > 0 ? B : A, back = rel > 0 ? A : B;
        const absRel = Math.abs(rel);
        if (lat > 1.0 && absRel < LEN * 0.8) {
          // roce lateral: se separan
          const push = (2.0 - lat) / 2 + 0.02; const sgn = Math.sign(A.d - B.d) || 1;
          // (solo si se acercan: al separarse también hay velocidad de lado y contaba como choque)
          const latClose = sgn * ((B.d - B.dPrev) - (A.d - A.dPrev)) / DT;
          if (!A.inPit) { A.dev += sgn * push; A.d += sgn * push; A.devV = 0; A.jumpD = (A.jumpD || 0) + sgn * push; }
          if (!B.inPit) { B.dev -= sgn * push; B.d -= sgn * push; B.devV = 0; B.jumpD = (B.jumpD || 0) - sgn * push; }
          if (latClose > 2.5 && !A.inPit) this.contact(back, front, latClose * 1.6);
        } else {
          const closing = back.v - front.v;
          // alcance: el de delante sale empujado y el de detrás rebota un poco (antes se pegaba a su velocidad sin más y
          // no parecía que hubiera choque)
          if (closing > 1 && !front.inPit && !back.inPit) front.v += Math.min(4, closing * 0.35);
          back.v = Math.max(0, Math.min(back.v, front.v - 0.3 - (back.inPit ? 0 : Math.min(3, Math.max(0, closing) * 0.2))));
          // en el pit lane también se hace cola (antes se atravesaban); el que está parado en su box no se mueve
          const still = back.pitPhase === 'stop' || back.pitPhase === 'box';
          // (en el pit lane poco a poco: un salto de s movía de golpe su trazado lateral en la rampa)
          if (!back.inPit || !still) { const shift = Math.min(back.inPit ? 0.05 : 1e9, LEN + 0.05 - absRel); back.s = T.wrap(back.s - shift); back.dist -= shift; }
          if (closing > 3 && !back.inPit) this.contact(back, front, closing);
        }
      }
    }
    this.collideParked();
  }

  // coches abandonados aparcados en la escapatoria: obstáculos fijos (antes los que se salían allí los atravesaban)
  collideParked() {
    const T = this.T, cars = this.cars;
    for (const P of cars) {
      if (!P.parked || P.inPit || P.out || P.state !== 'track') continue;
      for (const C of cars) {
        if (C === P || !live(C) || C.inPit || C.state !== 'track') continue;
        const rel = T.rel(P.s, C.s), lat = Math.abs(C.d - P.d);
        if (Math.abs(rel) > LEN || lat >= 2.0) continue;
        if (lat > 1.0 && Math.abs(rel) < LEN * 0.8) {
          const sgn = Math.sign(C.d - P.d) || -Math.sign(P.d) || 1, push = 2.02 - lat;
          C.d += sgn * push; C.dev += sgn * push; C.devV = 0;
        } else {
          // de frente contra el coche parado: se queda detrás (o delante si ya lo había pasado)
          const sgn = rel > 0 ? 1 : -1, shift = LEN + 0.05 - Math.abs(rel);
          C.s = T.wrap(C.s + sgn * shift); C.dist += sgn * shift;
          if (C.v > 6 && this.t - (C.lastContact || -9) > 2) {
            C.lastContact = this.t; this.emit({ type: 'contact', car: C, other: P, sev: C.v * 0.4 });
            this.damage(C, 'fw', Math.min(1, C.v * 0.03));
          }
          C.v = Math.min(C.v, 2);
        }
      }
    }
  }

  contact(back, front, sev) {
    if (this.t - (back.lastContact || -9) < 2) return;
    back.lastContact = this.t; front.lastContact = this.t;
    const r = this.rng();
    this.emit({ type: 'contact', car: back, other: front, sev });
    if (sev > 3) { this.damage(back, 'fw', sev > 7 ? 0.5 + sev * 0.02 : sev * 0.04); this.damage(front, 'rw', sev > 9 ? sev * 0.03 : 0); }
    if (sev > 11 && r < 0.3) { front.beta = (this.rng() < 0.5 ? 1 : -1) * 0.5; this.startSpin(front, 0, 2.5); }
    if (sev > 16 && r < 0.25) this.retire(back, 'daños');
    if (back.dmg > 0.3 && this.session.id === 'RACE') back.pitReq = true;
  }

  // ------------------------------------------------------------ orden y gaps
  updateOrder() {
    const cars = this.cars.filter((c) => !c.out);
    const L = this.T.L;
    const key = (c) => c.retired ? -1e9 + c.dist : c.finished ? c.lap * 1e7 + (1e6 - c.finishT) : (c.lap + 1) * 1e7 - 5e6 + (T0(c.s, L)) * 1e6;
    cars.sort((a, b) => key(b) - key(a));
    cars.forEach((c, p) => { c.pos = p + 1; });
    const ss = this.session;
    if ((ss.phase === 'green' || ss.phase === 'flag') && this.t - this.raceStart > 4) {
      // un adelantamiento cuenta cuando se consolida (2,5 s delante o ya separados): los vaivenes de lado a lado no
      const pr = this.pairs || (this.pairs = new Map());
      // (con uno en boxes el orden entre ellos se olvida: al salir por detrás de otro se contaba como adelantamiento en pista)
      for (const c of cars) if (c.inPit) for (const o of cars) if (o !== c) pr.delete(Math.min(c.i, o.i) * 32 + Math.max(c.i, o.i));
      for (let a = 0; a < cars.length; a++) {
        const A = cars[a]; if (A.inPit || A.retired || A.finished) continue;
        for (let b = a + 1; b < cars.length; b++) {
          const B = cars[b]; if (B.inPit || B.retired || B.finished) continue;
          const rel = this.T.rel(A.s, B.s);
          const lo = A.i < B.i ? A : B, hi = lo === A ? B : A;
          const key = lo.i * 32 + hi.i;
          const st = pr.get(key);
          const far = Math.abs(rel) > 60;
          if (st && st.cur !== st.conf && (far || this.t - st.since > 2.5)) {
            const c = st.cur === 1 ? hi : lo, o = st.cur === 1 ? lo : hi;
            st.conf = st.cur;
            if (!st.lapped) {
              const how = st.how;
              c.stats.ot++; o.stats.lost++; o.passedBy = c; o.passedT = this.t;
              this.emit({ type: 'overtake', car: c, other: o, pos: c.pos, corner: st.corner || this.cornerAt(c.s), how, plan: st.plan, where: st.where });
            }
          }
          if (far || Math.abs(rel) < LEN + 2) continue;      // lejos, o en paralelo: aún no se ha resuelto
          const now = (rel > 0) === (lo === A) ? 1 : -1;      // 1 = el de índice alto va delante
          if (!st) { pr.set(key, { cur: now, conf: now, since: this.t }); continue; }
          if (now !== st.cur) {
            const c = now === 1 ? hi : lo, o = now === 1 ? lo : hi;
            st.cur = now; st.since = this.t; st.how = o.mistake ? 'error' : o.mode === 'yield' ? 'cede' : 'pista'; st.corner = this.cornerAt(c.s);
            // dónde: en plena recta, en la frenada (150 m antes de la curva) o en la curva
            { const T = this.T, i = T.idx(c.s), toC = T.ahead(c.s, T.corners[T.nextCorner[i]].sIn); st.where = T.zoneOf[i] >= 0 ? 'curva' : toC < 150 ? 'frenada' : 'recta'; }
            // el plan de ataque se da por bueno en el momento de pasar (la confirmación llega luego, quizá fuera de la curva)
            const ot = c.otTry; st.plan = ot && ot.o === o ? ot.plan : c.atk?.type;
            if (ot && ot.o === o) { this.planResult(c, ot, true); c.otTry = null; }
            st.lapped = Math.round((B.dist - A.dist - rel) / this.T.L) !== 0;  // doblados: no cuenta
          }
        }
      }
    }
    for (const c of cars) c.lastPos = c.pos;
    this.raceOrder = cars;
  }

  carAheadOnTrack(car) {
    let best = null, bd = 1e9;
    for (const o of this.cars) {
      if (o === car || !live(o) || o.inPit) continue;
      const rel = this.T.ahead(car.s, o.s); if (rel > 0 && rel < bd) { bd = rel; best = o; }
    }
    return best;
  }

  // segundos que A lleva de retraso respecto a B en el punto de pista donde está A
  gapTo(A, B, d = A.dist) {
    if (this.session.id !== 'RACE') return (A.best - B.best) || 0;
    const c = Math.floor(d / CP_STEP);
    const t0 = B.cpt[c], t1 = B.cpt[c + 1];
    if (t0 == null) return 0;
    const f = (d - c * CP_STEP) / CP_STEP;
    const tb = t1 != null ? t0 + (t1 - t0) * f : t0 + f * CP_STEP / Math.max(20, B.v);
    return Math.max(0, this.t - tb);
  }
  // lo mismo con el coche de delante en pista, aunque sea un doblado (para el DRS: antes, contra un doblado, el hueco
  // daba 0 y abría el alerón con él a cientos de metros)
  trackGap(A, B) { return this.gapTo(A, B, B.dist - this.T.ahead(A.s, B.s)); }

  classification() {
    if (!this.session) return this.cars.slice();
    const id = this.session.id;
    if (id === 'RACE') return (this.raceOrder || this.cars).slice();
    const act = this.cars.filter((c) => !c.out);
    const rest = this.cars.filter((c) => c.out);
    const bk = (c) => (isFinite(c.best) ? c.best : 1e6 + c.i);
    act.sort((a, b) => bk(a) - bk(b));
    if (id === 'Q2' || id === 'Q3') return act; // los eliminados se añaden al final en endSession
    return act.concat(rest);
  }

  cornerAt(s) {
    const T = this.T;
    for (const c of T.corners) if (T.ahead(T.wrap(c.sIn - 200), s) < T.ahead(T.wrap(c.sIn - 200), c.sOut) + 40) return c.name;
    return '';
  }

  brains() { const o = {}; for (const c of this.cars) o[c.code] = c.brain; return o; }
}
