// HUD estilo retransmisión: torre de tiempos, ficha y telemetría, peleas, avisos, mapa, semáforo,
// paneles de resultados y de aprendizaje.
import { COMPOUNDS, TEAMS } from './teams.js';
import { SESSIONS, isFP } from './sim.js';
import { CAM_TYPES, CAM_LABEL } from './director.js';
import { degSlope, buildLine } from './brain.js';
import { theoLap } from './theo.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtLap = (t) => (isFinite(t) && t > 0 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}` : '—');
const fmtGap = (t) => (t < 60 ? `+${t.toFixed(3)}` : `+${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`);
const tyreHTML = (c, age) => `<span class="tyre ${c}" title="${COMPOUNDS[c].name}${age != null ? ' · ' + age + ' vueltas' : ''}"><i>${c}</i></span>`;
const PLAN = { inside: 'por dentro', outside: 'por fuera', cutback: 'cruce a la salida', exit: 'rebufo a la salida' };
const NEXT = { FP: 'FP2', FP2: 'Q1', Q1: 'Q2', Q2: 'Q3', Q3: 'RACE' };
const NEXT_LABEL = { FP: 'Ir a Libres 2', FP2: 'Ir a la clasificación', Q1: 'Ir a la Q2', Q2: 'Ir a la Q3', Q3: 'Ir a la carrera', RACE: 'Nuevo fin de semana' };

// color del dorsal en la ficha: el más luminoso de los dos del equipo (con el c2 oscuro, p. ej. azul marino, no se leía)
const lum = (h) => { const n = parseInt(h.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
const numCol = (t) => (t.c2 === '#FFFFFF' || lum(t.c1) > lum(t.c2) ? t.c1 : t.c2);

export class UI {
  constructor(app) {
    this.app = app; this.sim = app.sim; this.T = app.T; this.dir = app.director;
    this.mode = 'interval'; this.acc = 0; this.accCard = 0;
    this.buildControls();
    this.buildMap();
    $('towerHead').onclick = () => { this.mode = this.mode === 'interval' ? 'leader' : 'interval'; this.acc = 1; };
    $('rows').onclick = (e) => { const li = e.target.closest('li'); if (li) this.dir.setFocus(this.sim.cars[+li.dataset.i]); };
    this.sim.on((e) => this.onEvent(e));
    this.dir.onChange(() => this.syncButtons());
    // aprendizaje: vuelta teórica de cada piloto al acabar cada vuelta (ver theo.js), en tiempo del fin de semana
    this.theoHist = new Map(); this.theoOff = 0;
    this.sim.on((e) => this.recordTheo(e));
  }

  recordTheo(e) {
    const sim = this.sim, add = (car) => {
      const r = theoLap(this.T, car.kb), H = this.theoHist.get(car) || [];
      H.push({ x: this.theoOff + sim.t, pct: r.pct, line: r.line, att: r.att, wet: car.kb !== car.brain });
      if (H.length > 400) H.shift();
      this.theoHist.set(car, H);
    };
    // carrera: tandas reales de cada coche y paradas (para las estadísticas del final)
    if (e.type === 'session' && e.id === 'RACE') this.raceLog = { stints: new Map(sim.cars.map((c) => [c, [{ c: c.tyre.c, from: 0 }]])), stops: [], retired: new Map(), ot: new Map() };
    if (this.raceLog && sim.session?.id === 'RACE') {
      if (e.type === 'pitdone') { this.raceLog.stints.get(e.car)?.push({ c: e.c || e.car.tyre.c, from: Math.max(0, e.car.lap) }); this.raceLog.stops.push({ car: e.car, lap: e.car.lap, time: e.time }); }
      if (e.type === 'retire') this.raceLog.retired.set(e.car, Math.max(0, e.car.lap));
      // (solo los de verdad: no los que se apartan cediendo ni los que se aprovechan de un error)
      if (e.type === 'overtake' && e.how === 'pista') this.raceLog.ot.set(e.car, (this.raceLog.ot.get(e.car) || 0) + 1);
    }
    if (e.type === 'sessionEnd') this.theoOff += sim.t;
    else if (e.type === 'session') { for (const c of sim.cars) if (c.kb) add(c); }
    else if (e.type === 'lap' && e.car.kb) add(e.car);
  }

  // ---------------------------------------------------------- controles
  buildControls() {
    const c = $('controls');
    const camBtns = CAM_TYPES.map((t) => `<button data-cam="${t}">${CAM_LABEL[t]}</button>`).join('');
    c.innerHTML = `
      <div class="grp"><button id="bAuto" class="on" title="Realización automática (A)">Auto</button><button id="bAutoD" title="Automática pegada al piloto elegido: solo cambia de plano (P)">Auto piloto</button>${camBtns}</div>
      <div class="grp"><button id="bPrev" title="Piloto anterior ([)">‹</button><span class="lbl" id="focusLbl">—</span><button id="bNext" title="Piloto siguiente (])">›</button></div>
      <div class="spacer"></div>
      <div class="grp" id="speeds"><button id="bReplay" title="Repetición de los últimos 12 s del piloto enfocado (R)">Repetir</button>${[0, 1, 2, 4, 8, 16, 32].map((s) => `<button data-speed="${s}">${s === 0 ? 'II' : s + '×'}</button>`).join('')}</div>
 <div class="grp"><button id="bSound" title="Sonido de motor (M)">Sonido</button><button id="bSkip" title="Simular el resto de la sesión a máxima velocidad">Saltar</button><button id="bLearn" class="red" title="Qué han aprendido los pilotos (L)">IA · Aprendizaje</button></div>`;
    c.querySelectorAll('[data-cam]').forEach((b) => (b.onclick = () => this.dir.setType(b.dataset.cam)));
    c.querySelectorAll('[data-speed]').forEach((b) => (b.onclick = () => this.app.reqSpeed(+b.dataset.speed)));
    $('bAuto').onclick = () => this.dir.setAuto(!(this.dir.auto && !this.dir.lockFocus));
    $('bAutoD').onclick = () => this.dir.setAutoDriver(!this.dir.lockFocus);
    $('qlive').onclick = (e) => { const q = e.target.closest('.ql'); if (q) this.dir.setFocus(this.sim.cars[+q.dataset.i]); };
    $('bPrev').onclick = () => this.cycle(-1); $('bNext').onclick = () => this.cycle(1);
    $('bSkip').onclick = () => this.app.skip();
    $('bSound').onclick = () => { this.app.audio.toggle(); this.syncButtons(); };
    $('bLearn').onclick = () => this.showLearning();
    $('bReplay').onclick = () => { if (this.app.mp) return; const R = this.app.replay; if (R?.active) R.stop(); else R?.replayLast(); };
    // vertical: pestañas bajo la imagen (Muro solo en mánager) y un botón de menú, que en el móvil no hay Esc
    if (!$('ptabs')) {
      const t = document.createElement('div'); t.id = 'ptabs';
      t.innerHTML = [['wall', 'Muro'], ['times', 'Tiempos'], ['car', 'Piloto'], ['map', 'Mapa']].map(([k, l]) => `<button data-pt="${k}">${l}<em></em></button>`).join('') + '<button data-pt="menu" title="Menú" style="flex:0 0 46px">☰</button>';
      $('hud').appendChild(t);
      t.onclick = (e) => { const k = e.target.closest('button')?.dataset.pt; if (k === 'menu') this.pauseMenu(); else if (k) this.setTab(k, true); };
      requestAnimationFrame(() => this.setTab(null));
    }
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'a') this.dir.setAuto(!(this.dir.auto && !this.dir.lockFocus));
      else if (k === 'p') this.dir.setAutoDriver(!this.dir.lockFocus);
      else if (k >= '1' && k <= '9') this.dir.setType(CAM_TYPES[+k - 1]);
      else if (k === '[' || k === 'arrowleft') this.cycle(-1);
      else if (k === ']' || k === 'arrowright') this.cycle(1);
      else if (k === ' ') { e.preventDefault(); this.app.reqSpeed(this.app.speed === 0 ? this.app.lastSpeed || 1 : 0); }
      else if (k === '+' || k === '=') this.app.reqSpeed(Math.min(32, Math.max(1, this.app.speed * 2)));
      else if (k === '-') this.app.reqSpeed(Math.max(1, this.app.speed / 2));
      else if (k === 'l') this.showLearning();
      else if (k === 'r' && !this.app.mp) { const R = this.app.replay; if (R?.active) R.stop(); else R?.replayLast(); }
      else if (k === 'm') { this.app.audio.toggle(); this.syncButtons(); }
      else if (k === 'h') $('hud').classList.toggle('hidden');
      else if (k === 'escape') { if (document.querySelector('.modal')) this.closeModal(); else this.pauseMenu(); }
    });
  }
  // pestaña del panel vertical (se recuerda por modo; el Muro solo existe en mánager)
  setTab(k, save = false) {
    const mgr = document.body.classList.contains('mgr'), key = 'ngp-ptab-' + (mgr ? 'mgr' : 'watch');
    if (!k) { try { k = localStorage.getItem(key); } catch { k = null; } }
    if (!k || (k === 'wall' && !mgr)) k = mgr ? 'wall' : 'times';
    if (k === 'times' && matchMedia('(min-width: 700px)').matches) k = mgr ? 'wall' : 'car';   // (en ancho los tiempos están siempre)
    document.body.dataset.pt = k;
    for (const b of document.querySelectorAll('#ptabs [data-pt]')) b.classList.toggle('on', b.dataset.pt === k);
    if (save) try { localStorage.setItem(key, k); } catch { /* sin almacenamiento */ }
  }
  cycle(dir) {
    const list = this.order().filter((c) => !c.out);
    const i = list.indexOf(this.dir.focus);
    this.dir.setFocus(list[(i + dir + list.length) % list.length]);
  }
  syncButtons() {
    $('bAuto').classList.toggle('on', this.dir.auto && !this.dir.lockFocus);
    $('bAutoD').classList.toggle('on', !!this.dir.lockFocus);
    $('bSound').classList.toggle('on', !!this.app.audio?.on); $('bSound').textContent = this.app.audio?.on ? 'Sonido ON' : 'Sonido OFF';
    document.querySelectorAll('[data-cam]').forEach((b) => b.classList.toggle('on', b.dataset.cam === this.dir.type));
    document.body.dataset.cam = this.dir.type;   // (la T-cam tiene el volante abajo, donde van las tarjetas de sectores)
    document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', +b.dataset.speed === this.app.speed));
    const f = this.dir.focus; $('focusLbl').textContent = f ? f.code : '—';
    $('camLabel').textContent = `${CAM_LABEL[this.dir.type]} · ${f ? f.drv.last : ''}${this.dir.lockFocus ? ' · auto piloto' : this.dir.auto ? ' · auto' : ''}`;
  }

  // ---------------------------------------------------------- orden
  order() {
    const sim = this.sim;
    if (sim.session?.id === 'RACE') return (sim.raceOrder || sim.cars).slice();
    const cls = sim.classification();
    if (sim.session?.id === 'Q2' || sim.session?.id === 'Q3') {
      const out = (sim.qualiOrder || []).filter((c) => c.out);
      return cls.concat(out.filter((c) => !cls.includes(c)));
    }
    return cls;
  }

  // ---------------------------------------------------------- torre
  tower() {
    const sim = this.sim, ss = sim.session; if (!ss) return;
    const race = ss.id === 'RACE';
    const order = this.order();
    $('sessName').textContent = race ? `Vuelta ${Math.max(1, Math.min(sim.raceLaps, (order[0]?.lap ?? 0) + 1))}/${sim.raceLaps}` : ss.short === 'FP' ? 'Libres 1' : ss.short === 'FP2' ? 'Libres 2' : ss.short;
    $('sessSub').textContent = race ? (this.mode === 'interval' ? 'Intervalo' : 'Líder') : isFP(ss.short) ? 'Entrenamientos' : 'Clasificación';
    const cut = SESSIONS[ss.id]?.cut;
    const best = order.find((c) => isFinite(c.best))?.best;
    let html = '';
    order.forEach((car, p) => {
      let gap = '', tag = '', cls = '', gapCls = '';
      if (race) {
        if (car.retired) { gap = '<span class="tag dnf" style="position:static">Fuera</span>'; cls = 'out'; }
        else if (p === 0) gap = car.finished ? 'Ganador' : 'Líder';
        else {
          const ref = this.mode === 'interval' ? order[p - 1] : order[0];
          const laps = Math.floor((ref.dist - car.dist) / this.T.L + (ref.finished && !car.finished ? 0 : 0.0001));
          if (laps >= 1) gap = `+${laps} ${laps === 1 ? 'vuelta' : 'vueltas'}`;
          else gap = fmtGap(sim.gapTo(car, ref));
        }
        if (car.inPit && !car.retired && !car.finished) gap = '<span class="tag pit" style="position:static">Pit</span>';
        if (sim.session.phase === 'grid' || sim.session.phase === 'lights') gap = p === 0 ? 'Pole' : '';
        if (this.sim.fastest?.car === car) gapCls = 'purple';
      } else {
        if (isFinite(car.best)) gap = p === 0 ? fmtLap(car.best) : fmtGap(car.best - best);
        else gap = '—';
        if (car.state === 'garage' && !car.out) gap = '<span class="tag pit" style="position:static">Box</span> ' + gap;
        if (car.lapKind === 'push' && car.state !== 'garage' && car.secCol) gap = `<span class="secs">${[0, 1, 2].map((k) => `<i class="${car.secCol?.[k] || ''}"></i>`).join('')}</span>` + gap;
        if (car.out) cls = 'out';
        if (cut && p === cut) cls += ' cut';
        if (cut && p >= cut && !car.out) cls += ' danger';
        if (p === 0 && isFinite(car.best)) gapCls = 'purple';
      }
      // última vuelta: morada si es la más rápida de la sesión, verde si es su mejor
      const llCls = car.lastLap > 0 && sim.fastest?.car === car && Math.abs(sim.fastest.t - car.lastLap) < 1e-6 ? 'purple' : car.lastLap > 0 && Math.abs(car.best - car.lastLap) < 1e-6 ? 'pb' : '';
      if (car === this.dir.focus) cls += ' focus';
      if (car.finished && !car.retired) cls += ' fin';
      const up = race && car.gridPos && car.pos < car.gridPos && !car.retired ? '<span class="up">▲</span>' : '';
      // (sin tiempo en libres o clasificación no tiene posición: antes se numeraban todos en el orden de la lista)
      html += `<li data-i="${car.i}" class="${cls}"><span class="p">${race || isFinite(car.best) ? p + 1 : '–'}</span><span class="bar" style="background:${car.team.c1}"></span><span class="code">${car.code}</span><span class="gap ${gapCls}">${gap}</span><span class="ll ${llCls}" title="Última vuelta">${car.lastLap > 0 ? fmtLap(car.lastLap) : ''}</span>${tyreHTML(car.tyre.c)}${tag}${up}${car.finished && !car.retired ? '<span class="chq" title="Ha cruzado la meta"></span>' : ''}</li>`;
    });
    $('rows').innerHTML = html;
    // barra de sesión
    let k = 'Tiempo', v = '--:--';
    if (race) { k = 'Vuelta'; v = `${Math.max(1, Math.min(sim.raceLaps, (order[0]?.lap ?? 0) + 1))} / ${sim.raceLaps}`; }
    else { const left = Math.max(0, ss.dur - sim.t); v = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`; k = SESSIONS[ss.id].label; }
    $('sbK').textContent = k; $('sbV').textContent = v;
    const flag = $('flag');
    const chq = ss.phase === 'flag' || ss.phase === 'done';
    flag.className = chq ? 'CHQ' : sim.flag;
    const pre = race && (ss.phase === 'grid' || ss.phase === 'lights');
    flag.textContent = chq ? '' : pre ? 'Parrilla' : sim.flag === 'VSC' ? 'VSC' : 'Verde';
    if (pre) flag.className = 'PRE';
    // tiempo: lluvia y agua en pista
    const wx = sim.wx, wxEl = $('wx');
    if (wx && wxEl) {
      const on = wx.rain > 0.03 || wx.wet > 0.05 || wx.target > 0.05;
      wxEl.classList.toggle('hidden', !on);
      if (on) {
        const lbl = wx.rain > 0.55 ? 'Lluvia fuerte' : wx.rain > 0.2 ? 'Lluvia' : wx.rain > 0.03 ? 'Llovizna' : wx.wet > 0.05 ? 'Secándose' : 'Nubes';
        wxEl.innerHTML = `<span class="ic">${wx.rain > 0.03 ? '☂' : '☁'}</span><span class="l">${lbl}</span><span class="w" title="Agua en la trazada">${Math.round(wx.line * 100)}%</span>${wx.noDRS ? '<span class="d">Sin DRS</span>' : ''}`;
      }
    }
  }

  // ---------------------------------------------------------- ficha + telemetría
  card() {
    const car = this.dir.focus, sim = this.sim; if (!car || !sim.session) return;
    const race = sim.session.id === 'RACE';
    const order = this.order(); const p = order.indexOf(car);
    const ahead = order[p - 1], behind = order[p + 1];
    const gA = race ? (ahead ? fmtGap(sim.gapTo(car, ahead)) : '—') : (isFinite(car.best) && order[0] !== car && isFinite(order[0].best) ? fmtGap(car.best - order[0].best) : '—');
    const gB = race && behind && !behind.retired ? fmtGap(sim.gapTo(behind, car)) : '—';
    const b = car.brain;
    const commit = b.commit.reduce((a, c) => a + c, 0) / b.commit.length;
    let mode = '';
    if (car.retired) mode = 'Abandono';
    else if (car.state === 'garage') mode = 'En el garaje';
    else if (car.inPit) mode = car.pitPhase === 'stop' ? 'Parada en boxes' : car.pitPhase === 'in' ? 'Entrando en boxes' : 'Saliendo de boxes';
    else if (car.mistake) mode = { wide: 'Se abre en la curva', off: 'Se sale de la pista', spin: '¡Trompo!' }[car.mistake.type];
    else if (car.mode === 'attack' && car.target) mode = `Atacando a ${car.target.code}${car.atk ? ' · ' + PLAN[car.atk.type] : ''}`;
    else if (car.mode === 'defend') mode = `Defendiendo de ${car.attacker?.code || ''}`;
    else if (car.mode === 'yield') mode = 'Dejando pasar';
    else if (car.cand) mode = `Probando trazada en ${this.T.zones[car.cand.z].corner.name}`;
    else mode = race ? (car.finished ? 'Bandera a cuadros' : 'Ritmo de carrera') : { push: 'Vuelta rápida', out: 'Vuelta de salida', in: 'Vuelta de entrada', cool: 'Enfriando' }[car.lapKind] || '';
    $('card').innerHTML = `
      <div class="top"><div class="pos">${race || isFinite(car.best) ? p + 1 : '–'}</div><div class="stripe" style="background:${car.team.c1}"></div>
        <div class="who"><span class="n">${esc(car.drv.first)} · ${esc(car.team.name)}</span><span class="ln">${esc(car.drv.last)}</span></div>
        <div class="num" style="color:${numCol(car.team)}">${car.drv.num}</div></div>
      ${this.deltaRow(car, race)}
      <div class="info">
        <div><span class="k">Neumático</span><span class="v">${tyreHTML(car.tyre.c)} ${Math.round((1 - car.tyre.wear) * 100)}%</span></div>
        <div><span class="k">${race ? 'Delante' : 'A P1'}</span><span class="v">${gA}</span></div>
        <div><span class="k">${race ? 'Detrás' : 'Vueltas'}</span><span class="v">${race ? gB : car.laps.length}</span></div>
        <div><span class="k">Mejor</span><span class="v">${fmtLap(car.best)}</span></div>
      </div>
      <div class="secrow">${[0, 1, 2].map((k) => this.sectorCell(car, k)).join('')}<div class="sec last"><span class="k">Última</span><b>${fmtLap(car.lastLap)}</b></div></div>
      <div class="mode"><span>${mode}</span><span>IA: ${b.exp} pruebas · ${b.acc} mejoras · límite ${(commit * 100).toFixed(1)}%</span></div>`;
  }
  // libres y clasificación: diferencia en vivo del que se está viendo, con la mejor de la sesión y con la suya
  deltaRow(car, race) {
    if (race || car.lapKind !== 'push' || car.inPit || car.state === 'garage') return '';
    const f = (d) => (d == null ? '—' : `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(3)}`);
    const c = (d) => (d == null ? 'none' : d < 0 ? 'good' : 'bad');
    const p1 = car.delta, own = car.deltaOwn;
    const p1c = p1 == null ? 'none' : p1 < 0 ? 'purple' : c(own);
    if (!car.lapClean) return '<div class="delta"><span class="k">Delta</span><b class="none">vuelta anulada</b></div>';
    return `<div class="delta"><span class="k">Delta P1</span><b class="${p1c}">${f(p1)}</b><span class="k">Su mejor</span><b class="${c(own)}">${f(own)}</b></div>`;
  }
  // sector k de la vuelta en curso (o de la anterior si aún no ha pasado por él), con su color
  sectorCell(car, k) {
    const cur = car.sector > k;
    const t = cur ? car.curSectors[k] : car.prevSectors?.[k];
    const col = cur ? car.secCol?.[k] : car.prevSecCol?.[k];
    const live = car.sector === k && car.state !== 'garage' && !car.inPit;
    const run = live ? Math.max(0, this.sim.t - car.sectorStart) : null;
    return `<div class="sec ${col || ''} ${live ? 'live' : ''}"><span class="k">S${k + 1}</span><b>${live ? run.toFixed(1) : t ? t.toFixed(3) : '—'}</b></div>`;
  }

  tele() {
    const car = this.dir.focus; if (!car) return;
    const kmh = Math.round(car.v * 3.6);
    const drs = car.drs ? 'on' : car.drsOk ? 'ok' : '';
    $('tele').innerHTML = `
      <div class="spd"><b>${kmh}</b><span>KM/H</span><div class="gear">${car.gear === 0 ? 'N' : car.gear}</div></div>
      <div class="rpm"><i style="clip-path: inset(0 ${100 - Math.max(0, Math.min(100, (car.rpm - 6500) / 58))}% 0 0)"></i></div>
      <div class="pedals"><span>Acel.</span><div class="ped thr"><i style="width:${Math.round(car.throttle * 100)}%"></i></div><span>Freno</span><div class="ped brk"><i style="width:${Math.round(car.brake * 100)}%"></i></div></div>
      <div class="row"><span class="pill ${drs}">DRS</span>${car.inPit ? '<span class="pill pit">Limitador</span>' : ''}<span class="pill">${car.tyre.age} vtas</span><span class="pill">${Math.round(car.fuel)} kg</span></div>`;
  }

  // ---------------------------------------------------------- pelea
  battle() {
    const sim = this.sim, el = $('battle');
    const car = this.dir.focus;
    const ph = sim.session?.phase;
    if (!car || sim.session?.id !== 'RACE' || car.inPit || car.retired || ph === 'grid' || ph === 'lights' || sim.t - (sim.raceStart ?? 1e9) < 8) { el.classList.add('hidden'); return; }
    const order = this.order(); const p = order.indexOf(car);
    let a = null, b = null;
    const ah = order[p - 1], bh = order[p + 1];
    if (ah && !ah.inPit && sim.gapTo(car, ah) < 1.0 && Math.abs(car.lap - ah.lap) <= 1) { a = ah; b = car; }
    else if (bh && !bh.inPit && !bh.retired && sim.gapTo(bh, car) < 1.0) { a = car; b = bh; }
    if (!a) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `<div class="ttl">Lucha por P${order.indexOf(a) + 1}</div><div class="d"><i style="background:${a.team.c1}"></i>${a.code}</div><div class="gap">${sim.gapTo(b, a).toFixed(3)}</div><div class="d"><i style="background:${b.team.c1}"></i>${b.code}</div>`;
  }

  // ---------------------------------------------------------- clasificación: los 3 mejores en vuelta lanzada
  qualiLive() {
    const sim = this.sim, ss = sim.session, el = $('qlive');
    const on = ss && ss.id.startsWith('Q') && !ss.done;
    const best = sim.fastest?.t;
    const cls = on ? sim.classification() : [];
    const posOf = (t) => { let p = cls.findIndex((c) => !(c.best <= t)); return (p < 0 ? cls.length : p) + 1; };
    const list = on ? sim.cars.filter((c) => !c.out && c.state !== 'garage' && !c.inPit && c.lapKind === 'push' && c.lapClean && !c.retired) : [];
    // orden: los que van a mejor tiempo proyectado; sin referencia, los que más han avanzado
    const key = (c) => (c.delta != null && best ? best + c.delta : 1e4 - c.cpK);
    list.sort((a, b) => key(a) - key(b));
    const top = list.slice(0, 3);
    el.classList.toggle('hidden', !top.length);
    if (!top.length) return;
    el.innerHTML = top.map((c) => {
      let dl = '<span class="dl none">—</span>', pos = '–';
      if (c.delta != null && best) {
        const d = c.delta, own = isFinite(c.best) ? c.best - best : null;
        const cls2 = d < 0 ? 'purple' : own != null && d < own ? 'up' : 'down';
        dl = `<span class="dl ${cls2}">${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(3)}</span>`;
        pos = 'P' + posOf(best + d);
      }
      const secs = [0, 1, 2].map((k) => {
        const done = c.sector > k, live = c.sector === k;
        const t = done ? c.curSectors[k].toFixed(3) : live ? Math.max(0, sim.t - c.sectorStart).toFixed(1) : '—';
        return `<div class="${done ? c.secCol?.[k] || '' : ''} ${live ? 'live' : ''}"><span>S${k + 1}</span><b>${t}</b></div>`;
      }).join('');
      return `<div class="ql ${c === this.dir.focus ? 'focus' : ''}" data-i="${c.i}"><div class="top"><span class="p">${pos}</span><i style="background:${c.team.c1}"></i><b>${c.code}</b>${dl}</div><div class="secs">${secs}</div></div>`;
    }).join('');
  }

  // ---------------------------------------------------------- avisos
  note(cls, tag, html, ms = 5000) {
    const feed = $('feed');
    const d = document.createElement('div'); d.className = `note ${cls}`; d.innerHTML = `<span class="t">${tag}</span><span>${html}</span>`;
    feed.prepend(d);
    while (feed.children.length > 4) feed.lastChild.remove();   // (debajo va la radio)
    setTimeout(() => d.remove(), ms);
  }
  onEvent(e) {
    const sim = this.sim, race = sim.session?.id === 'RACE';
    const c = e.car;
    switch (e.type) {
      case 'overtake': if (e.how === 'pista' && (e.pos <= 12 || c === this.dir.focus)) this.note('green', 'Adelantamiento', `<b>${c.code}</b> pasa a <b>${e.other.code}</b>${e.plan && e.plan !== 'inside' ? ' ' + PLAN[e.plan] : ''}${e.corner ? ' en ' + e.corner : ''} · P${e.pos}`); break;
      case 'pitdone': this.note('blue', 'Parada', `<b>${c.code}</b> ${e.time.toFixed(1)} s · ${COMPOUNDS[e.c].name.toLowerCase()}`); break;
      case 'fastest': this.note('purple', race ? 'Vuelta rápida' : 'Mejor tiempo', `<b>${c.code}</b> ${fmtLap(e.time)}`); break;
      case 'mistake': if (e.kind !== 'wide' || c === this.dir.focus) this.note('yellow', e.kind === 'spin' ? 'Trompo' : e.kind === 'off' ? 'Fuera de pista' : 'Se abre', `<b>${c.code}</b>${e.corner ? ' en ' + e.corner : ''}`); break;
      case 'retire': this.note('red', 'Abandono', `<b>${c.code}</b> · ${e.why}`, 8000); break;
      case 'contact': if (e.wall) { if (e.sev > 7) this.note('yellow', 'Contra la barrera', `<b>${c.code}</b> golpea la barrera`); } else if (e.sev > 7) this.note('yellow', 'Toque', `<b>${c.code}</b> y <b>${e.other.code}</b>`); break;
      case 'limits': if (!race) this.note('yellow', 'Tiempo borrado', `<b>${c.code}</b> · límites de pista${e.corner ? ' en ' + e.corner : ''}`); break;
      case 'knockout': this.note('red', 'Eliminado', `<b>${c.code}</b> fuera en ${sim.session.id}`, 7000); break;
      case 'flag': this.note(e.flag === 'VSC' ? 'yellow' : 'green', e.flag === 'VSC' ? 'VSC' : 'Pista libre', e.flag === 'VSC' ? 'Coche de seguridad virtual' : 'Bandera verde'); break;
      case 'vscEnding': this.note('yellow', 'VSC terminando', 'Bandera verde en unos segundos'); break;
      case 'chequered': this.note('green', 'Bandera', race && c ? `<b>${c.code}</b> gana el Gran Premio` : 'Fin de la sesión', 8000); break;
      case 'start': this.go('¡Semáforo apagado!'); break;
      case 'weather': {
        const W = { rainStart: ['Empieza a llover', 'La pista se va a mojar'], rainMore: ['Llueve más', 'Más agua en la pista'], rainLess: ['Llueve menos', 'La lluvia afloja'], rainStop: ['Deja de llover', 'La trazada empezará a secarse'], drsOff: ['Sin DRS', 'Pista mojada'], drsOn: ['DRS activado', 'La pista se ha secado'] }[e.what];
        if (W) this.note(e.what === 'drsOn' || e.what === 'rainStop' ? 'green' : 'blue', W[0], W[1], 7000);
        break;
      }
      case 'lap': if (!race && c === this.dir.focus && this.dir.auto) this.lapPop(c, e); break;
      case 'session': $('feed').innerHTML = ''; this.note('green', 'Sesión', SESSIONS[e.id].label); break;
    }
  }
  // tiempo de vuelta del coche que se está viendo (libres/clasificación): posición y diferencia
  lapPop(c, e) {
    const sim = this.sim, cls = sim.classification().filter((x) => isFinite(x.best));
    const p = cls.indexOf(c) + 1, cut = SESSIONS[sim.session.id].cut;
    let tag, cl;
    if (!e.best) { tag = `Sin mejorar · P${p}`; cl = 'down'; }
    else if (p === 1) { tag = cls[1] ? `P1 · −${(cls[1].best - c.best).toFixed(3)}` : 'P1'; cl = 'purple'; }
    else { tag = `P${p} · +${(c.best - cls[0].best).toFixed(3)}`; cl = cut && p > cut ? 'red' : 'up'; }
    const zone = e.best && cut && !isFP(sim.session.id) ? (p > cut ? 'Zona de eliminación' : p > cut - 3 ? 'Por poco dentro' : '') : '';
    $('lapPop')?.remove();
    const d = document.createElement('div'); d.id = 'lapPop';
    d.innerHTML = `<i style="background:${c.team.c1}"></i><b>${c.code}</b><span class="t">${fmtLap(e.time)}</span><span class="r ${cl}">${tag}</span>${zone ? `<span class="z">${zone}</span>` : ''}`;
    $('hud').appendChild(d); setTimeout(() => d.remove(), 4200);
  }
  go(txt) { const d = document.createElement('div'); d.id = 'goBanner'; d.textContent = txt; $('hud').appendChild(d); setTimeout(() => d.remove(), 2500); }

  lights() {
    const sim = this.sim, el = $('lights');
    const on = sim.session?.id === 'RACE' && (sim.session.phase === 'lights' || sim.session.phase === 'grid');
    el.classList.toggle('hidden', !on);
    if (on) el.innerHTML = [0, 1, 2, 3, 4].map((k) => `<div class="pod ${k < sim.lights ? 'on' : ''}"><i></i><i></i><i></i><i></i></div>`).join('');
  }

  // ---------------------------------------------------------- mapa
  buildMap() {
    const T = this.T, cv = $('map');
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < T.N; i += 5) { x0 = Math.min(x0, T.x[i]); x1 = Math.max(x1, T.x[i]); z0 = Math.min(z0, T.z[i]); z1 = Math.max(z1, T.z[i]); }
    const pad = 36, W = cv.width, H = cv.height;
    const sc = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (z1 - z0));
    this.mapXY = (x, z) => [pad + (x - x0) * sc + ((W - 2 * pad) - (x1 - x0) * sc) / 2, pad + (z - z0) * sc + ((H - 2 * pad) - (z1 - z0) * sc) / 2];
    const path = new Path2D();
    for (let i = 0; i <= T.N; i += 4) { const [x, y] = this.mapXY(T.x[i % T.N], T.z[i % T.N]); i ? path.lineTo(x, y) : path.moveTo(x, y); }
    path.closePath(); this.mapPath = path;
    // número de cada curva, por fuera del vértice
    const A = [0, 0, 0], B = [0, 0, 0];
    this.mapTurns = T.corners.map((c, n) => {
      T.pos(c.apex, 0, A); T.pos(c.apex, -c.dir * 10, B);
      const [ax, ay] = this.mapXY(A[0], A[2]), [bx, by] = this.mapXY(B[0], B[2]);
      const l = Math.hypot(bx - ax, by - ay) || 1;
      return [ax + (bx - ax) / l * 17, ay + (by - ay) / l * 17, String(n + 1)];
    });
  }
  map() {
    const cv = $('map'), g = cv.getContext('2d'), T = this.T, P = [0, 0, 0];
    g.clearRect(0, 0, cv.width, cv.height);
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 14; g.stroke(this.mapPath);
    g.strokeStyle = '#e8e8ee'; g.lineWidth = 5; g.stroke(this.mapPath);
    g.font = '700 19px Figtree, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.8)';
    for (const [x, y, t] of this.mapTurns) g.fillText(t, x, y);
    g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    // sectores
    const cols = ['#ff4b45', '#3d8bff', '#ffd23f'];
    T.sectors.forEach((s, k) => { T.pos(s, 0, P); const [x, y] = this.mapXY(P[0], P[2]); g.fillStyle = cols[k]; g.fillRect(x - 3, y - 3, 6, 6); });
    const order = this.order().slice().reverse();
    for (const car of order) {
      if (car.out || car.state === 'garage') continue;
      T.pos(car.s, car.d, P); const [x, y] = this.mapXY(P[0], P[2]);
      const f = car === this.dir.focus;
      g.beginPath(); g.arc(x, y, f ? 9 : 6, 0, 7); g.fillStyle = car.team.c1; g.fill();
      g.lineWidth = f ? 3 : 1.5; g.strokeStyle = f ? '#fff' : 'rgba(255,255,255,0.7)'; g.stroke();
      if (f) { g.font = '800 20px Figtree, Arial'; g.fillStyle = '#fff'; g.fillText(car.code, x + 12, y - 8); }
    }
  }

  // ---------------------------------------------------------- bucle
  update(dt) {
    this.acc += dt; this.accCard += dt;
    if (this.acc > 0.25) { this.acc = 0; this.tower(); this.battle(); this.lights(); this.map(); this.syncButtons(); this.nextBar(); }
    if (this.accCard > 0.08) { this.accCard = 0; this.card(); this.tele(); this.qualiLive(); }
  }

  // ---------------------------------------------------------- paneles
  // sesión terminada y resultados cerrados (por ejemplo tocando fuera): botón para volver a ellos y seguir
  // (antes, cerrados los resultados, no había forma de pasar a la siguiente sesión)
  nextBar() {
    const R = this.lastResults, show = !!(R && this.sim.session?.done && R[0] === this.sim.session.id && !document.querySelector('.modal'));
    let el = $('nextBar');
    if (!show) { el?.remove(); return; }
    if (el) return;
    el = document.createElement('div'); el.id = 'nextBar';
    el.innerHTML = `<span>Sesión terminada</span><button class="btn ghost" data-k="res">Ver resultados</button><button class="btn" data-k="next">${this.nextLabel(R[0])}</button>`;
    el.onclick = (e) => { const k = e.target.closest('button')?.dataset.k; if (k === 'res') this.results(...R); else if (k === 'next') { el.remove(); this.app.nextSession(); } };
    $('hud').appendChild(el);
  }

  // en multijugador pasar de sesión se vota (y tras la carrera se vuelve a la sala)
  nextLabel(id) { return this.app.mp ? (id === 'RACE' ? 'Proponer volver a la sala' : 'Proponer: ' + NEXT_LABEL[id].replace(/^Ir/, 'ir')) : NEXT_LABEL[id]; }
  closeModal() {
    document.querySelectorAll('.modal').forEach((m) => m.remove());
    if (this.pausedSpeed != null) { this.app.setSpeed(this.pausedSpeed); this.pausedSpeed = null; }
  }
  pauseMenu() {
    const was = this.app.speed, sim = this.sim, ss = sim.session;
    const what = ss ? `${SESSIONS[ss.id].label}${ss.id === 'RACE' ? ` · vuelta ${Math.max(1, (sim.raceOrder?.[0]?.lap ?? 0) + 1)} de ${sim.raceLaps}` : ''}` : '';
    const m = this.modal(`<div class="pause">
        <div class="ph"><span class="kicker">Pausa</span><b>${esc(this.T.meta.name)}</b><span>${what}</span></div>
        <button class="btn big" id="pGo">Seguir</button>
        <div class="prow"><button id="pReplay">Repetición</button><button id="pLearn">IA · Aprendizaje</button><button id="pSound">${this.app.audio?.on ? 'Silenciar' : 'Activar sonido'}</button></div>
        ${this.app.manager ? `<button class="ptog" id="pAl">Parar la sesión con cada aviso <b>${this.app.manager.pauseOnAlert ? 'Sí' : 'No'}</b></button>` : ''}
        <p class="keys"><b>A</b> auto · <b>1–8</b> planos · <b>Espacio</b> pausa · <b>+/−</b> velocidad · <b>R</b> repetición · <b>L</b> aprendizaje · <b>H</b> ocultar HUD</p>
        <button class="danger" id="pRestart">${this.app.mp ? 'Proponer volver a la sala' : 'Reiniciar fin de semana'}</button>
        <p class="warn">Los pilotos olvidan todo lo aprendido y se vuelve a la pantalla de inicio.</p>
      </div>`);
    m.querySelector('.sheet').classList.add('pauseSheet');
    // (multijugador: el menú no para la sesión de los demás; la pausa es el botón II)
    if (!this.app.mp) { this.pausedSpeed = was; this.app.setSpeed(0); } else m.querySelector('#pReplay').style.display = 'none';
    m.querySelector('#pGo').onclick = () => this.closeModal();
    m.querySelector('#pReplay').onclick = () => { this.closeModal(); this.app.replay?.replayLast(); };
    m.querySelector('#pLearn').onclick = () => this.showLearning();
    m.querySelector('#pSound').onclick = (e) => { this.app.audio.toggle(); this.syncButtons(); e.target.textContent = this.app.audio.on ? 'Silenciar' : 'Activar sonido'; };
    m.querySelector('#pRestart').onclick = () => this.app.restart();
    const pa = m.querySelector('#pAl'); if (pa) pa.onclick = () => { const M = this.app.manager; M.pauseOnAlert = !M.pauseOnAlert; M.renderAlerts(); pa.querySelector('b').textContent = M.pauseOnAlert ? 'Sí' : 'No'; };
  }
  modal(html) {
    this.closeModal();
    const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div class="sheet">${html}</div>`;
    m.addEventListener('click', (e) => { if (e.target === m) this.closeModal(); });
    document.body.appendChild(m); return m;
  }

  results(id, cls) {
    this.lastResults = [id, cls];
    const sim = this.sim, race = id === 'RACE';
    const best = cls.find((c) => isFinite(c.best))?.best;
    const rows = cls.map((c, p) => {
      let time;
      if (race) time = c.retired ? `<span class="pos-down">${c.retiredWhy === 'accidente' ? 'Accidente' : 'Abandono'}</span>` : p === 0 ? fmtLap(c.finishT - sim.raceStart) : (Math.floor((cls[0].dist - c.dist) / this.T.L) >= 1 ? `+${Math.floor((cls[0].dist - c.dist) / this.T.L)} v.` : fmtGap(c.finishT - cls[0].finishT));
      else time = isFinite(c.best) ? (p === 0 ? fmtLap(c.best) : fmtGap(c.best - best)) : 'Sin tiempo';
      const delta = race && c.gridPos ? c.gridPos - (p + 1) : 0;
      return `<tr><td class="num">${p + 1}</td><td><span class="bar" style="background:${c.team.c1}"></span><span class="code">${c.code}</span> ${esc(c.drv.first)} ${esc(c.drv.last)}</td><td>${esc(c.team.name)}</td><td class="num">${time}</td>
        ${race ? `<td class="num">${c.gridPos}</td><td class="num ${delta > 0 ? 'pos-up' : delta < 0 ? 'pos-down' : ''}">${delta > 0 ? '+' + delta : delta || '='}</td><td>${c.strategy.stints.slice(0, c.stint + 1).map((s) => tyreHTML(s.c)).join(' ')}</td><td class="num">${fmtLap(c.best)}</td>` : `<td class="num">${c.laps.length}</td><td class="num">${c.brain.acc}</td>`}</tr>`;
    }).join('');
    const head = race ? '<th>Pos</th><th>Piloto</th><th>Equipo</th><th class="num">Tiempo</th><th class="num">Salida</th><th class="num">±</th><th>Neumáticos</th><th class="num">Vuelta rápida</th>'
      : '<th>Pos</th><th>Piloto</th><th>Equipo</th><th class="num">Tiempo</th><th class="num">Vueltas</th><th class="num">Mejoras IA</th>';
    const cut = SESSIONS[id]?.cut;
    const title = race ? `Resultado · Gran Premio` : `Resultado · ${SESSIONS[id].label}`;
    const lead = race ? `Vuelta rápida: <b>${sim.fastest ? sim.fastest.car.code + ' ' + fmtLap(sim.fastest.t) : '—'}</b>. El próximo fin de semana los pilotos empiezan de cero.`
      : cut ? `Quedan eliminados del ${cut + 1}.º al ${id === 'Q1' ? 22 : 16}.º.` : id === 'Q3' ? `Pole para <b>${cls[0].drv.first} ${cls[0].drv.last}</b>.` : 'Los pilotos han probado trazadas y frenadas en cada curva. Mira el panel de IA para ver cuánto han mejorado.';
    const table = `<div class="tw"><table class="cls"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    const tabs = race ? `<div class="rtabs"><button data-t="cls" class="on">Clasificación</button><button data-t="stats">Estadísticas</button></div>` : '';
    const m = this.modal(`<header><span class="kicker">${race ? 'Carrera' : SESSIONS[id].short}</span><h2>${title}</h2><button class="btn ghost" id="mLearn">Ver aprendizaje</button><button class="btn" id="mNext">${this.nextLabel(id)}</button></header>
      <div class="body"><p class="lead">${lead}</p>${tabs}<div class="rpane" data-p="cls">${race && this.app.manager ? this.app.manager.summaryHTML(cls) : ''}${table}</div>${race ? `<div class="rpane hidden" data-p="stats">${this.raceStatsHTML(cls)}</div>` : ''}</div>`);
    m.querySelector('#mNext').onclick = () => { this.closeModal(); this.app.nextSession(); };
    m.querySelector('#mLearn').onclick = () => this.showLearning(true);
    if (race) {
      m.querySelector('.rtabs').onclick = (e) => {
        const t = e.target.closest('button')?.dataset.t; if (!t) return;
        m.querySelectorAll('.rtabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
        m.querySelectorAll('.rpane').forEach((p) => p.classList.toggle('hidden', p.dataset.p !== t));
        if (t === 'stats' && !m.dataset.drawn) { m.dataset.drawn = 1; this.drawRaceStats(m, cls); }
      };
    }
  }

  // ---------------------------------------------------------- estadísticas de la carrera
  raceStatsHTML(cls) {
    const sim = this.sim, fin = cls.filter((c) => !c.retired), L = this.raceLog;
    const card = (k, v, sub) => `<div class="rs-card"><span class="k">${k}</span><b>${v}</b><span class="s">${sub}</span></div>`;
    const who = (c) => `<span class="bar" style="background:${c.team.c1}"></span>${c.code}`;
    const otN = (c) => L?.ot.get(c) || 0, ot = sim.cars.slice().sort((a, b) => otN(b) - otN(a))[0];
    const gain = fin.map((c) => ({ c, g: c.gridPos - (cls.indexOf(c) + 1) })).sort((a, b) => b.g - a.g)[0];
    const stop = (L?.stops || []).slice().sort((a, b) => a.time - b.time)[0];
    const totOt = sim.cars.reduce((a, c) => a + otN(c), 0), ret = cls.filter((c) => c.retired).length;
    const cards = [
      card('Ganador', who(cls[0]), `${esc(cls[0].drv.first)} ${esc(cls[0].drv.last)} · salía ${cls[0].gridPos}.º`),
      card('Vuelta rápida', sim.fastest ? `${who(sim.fastest.car)} ${fmtLap(sim.fastest.t)}` : '—', sim.fastest ? `en la vuelta ${sim.fastest.lap ?? '—'}` : ''),
      card('Más adelantamientos', ot && otN(ot) ? `${who(ot)} ${otN(ot)}` : '—', `${totOt} en pista en toda la carrera`),
      card('Remontada', gain && gain.g > 0 ? `${who(gain.c)} +${gain.g}` : '—', gain && gain.g > 0 ? `de ${gain.c.gridPos}.º a ${cls.indexOf(gain.c) + 1}.º` : 'nadie ganó posiciones'),
      card('Parada más rápida', stop ? `${who(stop.car)} ${stop.time.toFixed(1)} s` : '—', `${(L?.stops || []).length} paradas · ${ret} abandono${ret === 1 ? '' : 's'}`),
    ].join('');
    return `<div class="rs-cards">${cards}</div>
      <div class="rs-box"><div class="rs-h">Posiciones vuelta a vuelta<span>pasa el ratón o toca un piloto para resaltarlo</span></div><canvas class="rs-chart" id="rsPos" width="1400" height="560"></canvas></div>
      <div class="rs-box"><div class="rs-h">Estrategias<span>tandas de neumáticos y vuelta de cada parada</span></div><div id="rsStrat"></div></div>
      <div class="rs-box"><div class="rs-h">Ritmo<span>tiempo de cada vuelta de los cinco primeros${this.dir.focus && cls.indexOf(this.dir.focus) > 4 ? ' y ' + this.dir.focus.code : ''} (sin la salida ni las paradas)</span></div><canvas class="rs-chart" id="rsPace" width="1400" height="420"></canvas></div>`;
  }

  drawRaceStats(m, cls) {
    const sim = this.sim, N = sim.raceLaps, L = this.raceLog;
    const colOf = (c) => (['#141414', '#111111', '#1C1C1C', '#1B2A6B', '#0B2A5B'].includes(c.team.c1) ? c.team.c2 : c.team.c1);
    const mine = new Set(this.app.managers?.flatMap((x) => x.cars) || []);
    // posiciones: una línea por coche (los del mánager y el enfocado, gruesas)
    const cv = m.querySelector('#rsPos'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const l0 = 54, r0 = 70, t0 = 16, b0 = 34, n = sim.cars.length;
    const X = (lap) => l0 + (lap / Math.max(1, N)) * (W - l0 - r0), Y = (p) => t0 + ((p - 1) / (n - 1)) * (H - t0 - b0);
    let hl = null;
    const draw = () => {
      g.clearRect(0, 0, W, H); g.font = '600 15px Figtree, sans-serif'; g.fillStyle = '#6b7280';
      for (let lap = 0; lap <= N; lap += Math.max(1, Math.round(N / 10))) { g.fillText(String(lap), X(lap) - 4, H - 10); g.strokeStyle = 'rgba(255,255,255,0.05)'; g.beginPath(); g.moveTo(X(lap), t0); g.lineTo(X(lap), H - b0); g.stroke(); }
      for (let p = 1; p <= n; p += p < 10 ? 1 : 2) g.fillText(String(p), 18, Y(p) + 5);
      const order = cls.slice().reverse();
      for (const c of order) {
        const pts = [c.gridPos, ...(c.hist || [])]; if (!pts.length) continue;
        const big = hl ? c === hl : mine.has(c) || c === this.dir.focus;
        g.globalAlpha = hl && c !== hl ? 0.18 : big ? 1 : 0.75; g.strokeStyle = colOf(c); g.lineWidth = big ? 4 : 2; g.beginPath();
        pts.forEach((p, k) => (k ? g.lineTo(X(k), Y(p)) : g.moveTo(X(0), Y(p)))); g.stroke();
        const end = pts[pts.length - 1], k = pts.length - 1;
        if (c.retired) { g.fillStyle = '#f87171'; g.fillText('✕', X(k) - 5, Y(end) + 5); }
        g.globalAlpha = hl && c !== hl ? 0.3 : 1; g.fillStyle = colOf(c); g.font = `${big ? 800 : 600} 14px Figtree, sans-serif`;
        if (!c.retired) g.fillText(c.code, W - r0 + 10, Y(cls.indexOf(c) + 1) + 5);
        g.font = '600 15px Figtree, sans-serif';
      }
      g.globalAlpha = 1;
    };
    draw();
    // (pointer: también vale tocar en el móvil)
    cv.onpointermove = cv.onpointerdown = (e) => {
      const r = cv.getBoundingClientRect(), y = ((e.clientY - r.top) / r.height) * H, x = ((e.clientX - r.left) / r.width) * W;
      const lap = Math.max(0, Math.min(N, Math.round(((x - l0) / (W - l0 - r0)) * N)));
      let best = null, bd = 1e9;
      for (const c of cls) { const p = lap === 0 ? c.gridPos : c.hist?.[Math.min(lap, c.hist.length) - 1]; if (p == null) continue; const d = Math.abs(Y(p) - y); if (d < bd) { bd = d; best = c; } }
      if (x > W - r0) { const p = Math.round(((y - t0) / (H - t0 - b0)) * (n - 1)) + 1; best = cls[p - 1] || best; }
      if (best !== hl) { hl = bd < 30 || x > W - r0 ? best : null; draw(); }
    };
    cv.onpointerleave = (e) => { if (e.pointerType === 'mouse') { hl = null; draw(); } };
    // estrategias: barra por piloto con sus tandas
    const strat = m.querySelector('#rsStrat');
    strat.innerHTML = cls.map((c) => {
      const S = L?.stints.get(c) || [{ c: c.tyre.c, from: 0 }], end = L?.retired.get(c) ?? N;
      const seg = S.map((s, k) => { const to = k + 1 < S.length ? S[k + 1].from : end, w = Math.max(0, to - s.from); return w ? `<i class="st" style="left:${(s.from / N) * 100}%;width:${(w / N) * 100}%;background:${COMPOUNDS[s.c].color};color:${'MH'.includes(s.c) ? '#111' : '#fff'}" title="${COMPOUNDS[s.c].name}: vueltas ${s.from + 1}-${to}">${w >= Math.max(2, N * 0.06) ? s.c : ''}</i>` : ''; }).join('');
      return `<div class="rs-st ${mine.has(c) ? 'me' : ''}"><span class="who"><span class="bar" style="background:${c.team.c1}"></span>${c.code}</span><span class="track">${seg}${c.retired ? `<em style="left:${(end / N) * 100}%">✕</em>` : ''}</span></div>`;
    }).join('') + `<div class="rs-st axis"><span class="who"></span><span class="track">${[0, 0.25, 0.5, 0.75, 1].map((f) => `<b style="left:${f * 100}%">${Math.round(f * N)}</b>`).join('')}</span></div>`;
    // ritmo: tiempos por vuelta (sin la 1.ª, las paradas ni lo que se sale de escala)
    const pc = m.querySelector('#rsPace'), q = pc.getContext('2d'), PW = pc.width, PH = pc.height;
    const who = cls.slice(0, 5); if (this.dir.focus && !who.includes(this.dir.focus)) who.push(this.dir.focus);
    const stopLaps = new Map(); for (const s of L?.stops || []) { if (!stopLaps.has(s.car)) stopLaps.set(s.car, new Set()); stopLaps.get(s.car).add(s.lap); stopLaps.get(s.car).add(s.lap + 1); }
    const series = who.map((c) => ({ c, pts: (c.laps || []).map((t, k) => ({ lap: k + 1, t })).filter((p) => p.lap > 1 && !stopLaps.get(c)?.has(p.lap)) })).filter((s) => s.pts.length);
    const ts = series.flatMap((s) => s.pts.map((p) => p.t)).sort((a, b) => a - b);
    if (!ts.length) return;
    const lo = ts[0] - 0.3, hi = Math.min(ts[ts.length - 1], ts[Math.floor(ts.length * 0.9)] + 1.5);
    const PX = (lap) => 70 + (lap / Math.max(1, N)) * (PW - 90), PY = (t) => 14 + ((Math.min(hi, t) - lo) / (hi - lo)) * (PH - 48);
    q.font = '600 15px Figtree, sans-serif';
    for (let k = 0; k <= 4; k++) { const t = lo + ((hi - lo) * k) / 4; q.fillStyle = '#6b7280'; q.fillText(fmtLap(t).slice(0, 8), 2, PY(t) + 5); q.strokeStyle = 'rgba(255,255,255,0.05)'; q.beginPath(); q.moveTo(70, PY(t)); q.lineTo(PW - 20, PY(t)); q.stroke(); }
    series.forEach((s, k) => {
      q.strokeStyle = colOf(s.c); q.lineWidth = s.c === this.dir.focus || mine.has(s.c) ? 3.5 : 2; q.beginPath();
      let prev = null; for (const p of s.pts) { if (prev && p.lap - prev.lap > 1) q.moveTo(PX(p.lap), PY(p.t)); else if (!prev) q.moveTo(PX(p.lap), PY(p.t)); else q.lineTo(PX(p.lap), PY(p.t)); prev = p; }
      q.stroke(); q.fillStyle = colOf(s.c); q.font = '800 14px Figtree, sans-serif'; q.fillText(s.c.code, 76 + k * 52, PH - 8);
    });
  }

  showLearning(fromResults = false) {
    const sim = this.sim;
    // seco o mojado: cada condición tiene su propia memoria (trazada, límite por curva y tiempos)
    if (this.learnCond == null) this.learnCond = (sim.wx?.line ?? 0) > 0.25 ? 'w' : 'd';
    const cond = this.learnCond, wetC = cond === 'w';
    const kbOf = (c) => (wetC ? c.brain.wet : c.brain);
    const laps = (c) => (c.brain.lapHist ? c.brain.lapHist.filter((l) => !!l.wet === wetC) : []);
    const bestOf = (c) => { const L = laps(c); return L.length ? Math.min(...L.map((l) => l.t)) : 999; };
    // dominio del circuito (vuelta teórica frente a la ideal, ver theo.js): lo aprendido sin tráfico, gasolina ni gomas
    const th = new Map(sim.cars.map((c) => [c, theoLap(this.T, kbOf(c))]));
    const hist = (c) => (this.theoHist.get(c) || []).filter((h) => h.wet === wetC);
    const cars = sim.cars.slice().sort((a, b) => th.get(b).pct - th.get(a).pct);
    const prior = { S: 0.22, M: 0.12, H: 0.075 };
    const zero = { exp: 0, acc: 0, mist: 0, locks: 0, catches: 0 };

    const teamAccent = (tm) => {
      if (!tm) return '#20E83B';
      const c = tm.c1;
      if (c === '#141414' || c === '#111111' || c === '#1C1C1C') return '#20E83B';
      if (c === '#1B2A6B' || c === '#0B2A5B') return '#4F86F7';
      if (c === '#0A5C45') return '#00D09C';
      if (c === '#C9CED3' || c === '#EDEDED' || c === '#F2F2F2') return '#E0E3E8';
      return c || '#FF8000';
    };

    let mostImprovedCar = null, maxGain = 0;
    let totalExp = 0, totalAcc = 0;
    let topAccCar = cars[0], maxAcc = -1;

    for (const c of sim.cars) {
      const b = c.brain, st = b.cs?.[cond] || zero;
      totalExp += st.exp || 0;
      totalAcc += st.acc || 0;
      if (st.acc > maxAcc) { maxAcc = st.acc; topAccCar = c; }
      const H = hist(c);
      if (H.length >= 2) { const g = th.get(c).pct - H[0].pct; if (g > maxGain) { maxGain = g; mostImprovedCar = c; } }
    }
    const avgPct = sim.cars.reduce((a, c) => a + th.get(c).pct, 0) / sim.cars.length;
    const avgLoss = sim.cars.reduce((a, c) => a + th.get(c).t - th.get(c).ideal, 0) / sim.cars.length;

    const f = this.dir.focus || sim.cars[0], fn = esc(f.drv.last);
    const fAccent = teamAccent(f.team);
    const fLaps = laps(f);

    let mostImpVal = '', mostImpSub = '';
    if (mostImprovedCar && maxGain > 0.05) {
      mostImpVal = `<span class="bar" style="background:${teamAccent(mostImprovedCar.team)}"></span><b>${mostImprovedCar.code}</b> <em>+${maxGain.toFixed(1)} pts</em>`;
      mostImpSub = `${esc(mostImprovedCar.drv.first)} ${esc(mostImprovedCar.drv.last)}: el que más dominio ha ganado en ${wetC ? 'mojado' : 'seco'}`;
    } else if (topAccCar && maxAcc > 0) {
      mostImpVal = `<span class="bar" style="background:${teamAccent(topAccCar.team)}"></span><b>${topAccCar.code}</b> (${maxAcc} mejoras)`;
      mostImpSub = `${esc(topAccCar.drv.first)} ${esc(topAccCar.drv.last)} es quien más cambios positivos ha validado`;
    } else {
      mostImpVal = `<span class="badge">Iniciando</span>`;
      mostImpSub = `Explorando los primeros puntos de frenada y trazada`;
    }

    const avgGainVal = `<b>${avgPct.toFixed(1)} %</b>`;
    const avgGainSub = `De media, a ${avgLoss.toFixed(2)} s de la vuelta ideal del circuito`;

    const totalTestsVal = totalExp > 0 ? `<b>${Math.round((totalAcc / totalExp) * 100)} %</b>` : `<span class="badge">Sin pruebas aún</span>`;
    const totalTestsSub = totalExp > 0 ? `${totalAcc} de ${totalExp} cambios probados en curva han ganado tiempo` : `Pruebas de trazada y frenada en cada curva`;
    // columnas sin datos todavía (degradación sin tandas largas, adelantamientos fuera de carrera): no se enseñan
    const showDeg = !wetC && cars.some((c) => 'SMH'.split('').some((x) => c.brain.deg[x].n >= 3));
    const showOt = cars.some((c) => c.brain.ot.some((o) => o.t > 0));

    const focusVal = `<span class="bar" style="background:${fAccent}"></span><b>${f.code}</b> <span style="font-size:13px;font-weight:700;color:#c0c3d0">${esc(f.drv.last)}</span>`;
    const fT = th.get(f);
    const focusSub = `<b>${fT.pct.toFixed(1)} %</b> de la ideal · pierde <b>${fT.line.toFixed(2)} s</b> en trazada y <b>${fT.att.toFixed(2)} s</b> en ataque`;

    const rows = cars.map((c, idx) => {
      const b = c.brain, kb = kbOf(c), st = b.cs?.[cond] || zero;
      const commit = kb && kb.commit ? kb.commit.reduce((a, x) => a + x, 0) / kb.commit.length : NaN;
      const L = laps(c);
      const bestL = L.length ? Math.min(...L.map((l) => l.t)) : Infinity;
      const firstL = L[0]?.t;
      const gain = firstL && isFinite(bestL) && firstL > bestL ? firstL - bestL : 0;
      const feel = b.feel ? b.feel[cond] : NaN;
      const ot = b.ot.reduce((a, o) => ({ t: a.t + o.t, w: a.w + o.w }), { t: 0, w: 0 });
      const deg = 'SMH'.split('').map((x) => (b.deg[x].n >= 3 ? degSlope(b, x, prior[x]).toFixed(2) : '·')).join(' / ');
      const cAccent = teamAccent(c.team);
      const isFocused = c === f;
      const pct = (x, lo, span) => Math.max(0, Math.min(100, ((x - lo) / span) * 100));

      return `<tr data-i="${c.i}" class="${isFocused ? 'hl' : ''}" title="Haz clic para seleccionar a ${c.code}">
        <td class="num" style="color:var(--muted);font-weight:700;">${idx + 1}</td>
        <td><span class="bar" style="background:${cAccent}"></span><span class="code">${c.code}</span> <span style="color:#b3b6c5;font-size:12px;margin-left:3px;">${esc(c.drv.first.charAt(0))}. ${esc(c.drv.last)}</span></td>
        <td class="num" style="font-weight:700;color:#fff">${th.get(c).pct.toFixed(1)} %</td>
        <td class="num"><span style="color:#93c5fd">${th.get(c).line.toFixed(2)}</span> <span style="color:var(--muted)">/</span> <span style="color:#fca5a5">${th.get(c).att.toFixed(2)}</span></td>
        <td class="num">${L.length}</td>
        <td class="num" title="${st.acc} mejoras aceptadas de ${st.exp} pruebas realizadas">${st.acc} <span style="color:var(--muted);font-size:11px">/ ${st.exp}</span></td>
        <td><div class="meter-wrap"><span class="meter"><i style="width:${pct(commit, 0.82, 0.20)}%;background:${cAccent}"></i></span><span style="font-size:11px;font-variant-numeric:tabular-nums">${isFinite(commit) ? (commit * 100).toFixed(1) + '%' : '—'}</span></div></td>
        <td><div class="meter-wrap"><span class="meter"><i style="width:${pct(feel, 0, 1)}%;background:#38BDF8"></i></span><span style="font-size:11px;font-variant-numeric:tabular-nums">${isFinite(feel) ? (feel * 100).toFixed(0) + '%' : '—'}</span></div></td>
        <td class="num" style="color:#fbbf24">${st.catches || 0}</td>
        <td class="num" style="color:#f87171">${st.locks || 0}</td>
        <td class="num" style="color:#fca5a5">${st.mist || 0}</td>
        ${showDeg ? `<td class="num"><span class="deg-pill">${deg}</span></td>` : ''}
        ${!showOt ? '' : `<td class="num">${ot.t ? `<span style="font-weight:700;color:${ot.w > 0 ? '#4ade80' : 'var(--muted)'}">${ot.w}</span><span style="color:var(--muted);font-size:11px">/${ot.t}</span>` : '<span style="color:var(--muted)">—</span>'}</td>`}
      </tr>`;
    }).join('');

    const feedList = (sim.learnLog || []).filter((e) => e.wet === wetC).slice(-20).reverse();
    const feed = feedList.map((e) => {
      const m = Math.floor(e.t / 60), sec = String(Math.floor(e.t % 60)).padStart(2, '0');
      const c = e.car, isMe = c === f, cAcc = teamAccent(c.team);
      const cornerStr = e.corner ? (e.corner.startsWith('Curva') ? e.corner : `Curva ${e.corner}`) : 'curva';
      let tagClass = 'tag-trazada', tagText = 'Trazada', desc = '';
      const gainStr = e.gain > 0.005 ? `−${e.gain.toFixed(2)} s` : '';

      if (e.kind === 'limite') {
        tagClass = 'tag-limite'; tagText = 'Frenada';
        desc = e.gain > 0.005 ? `<b>${c.code}</b> retrasa la frenada y entra con más velocidad en <em>${esc(cornerStr)}</em>` : `<b>${c.code}</b> arriesga más agarre en la frenada de <em>${esc(cornerStr)}</em>`;
      } else if (e.kind === 'trazada') {
        tagClass = 'tag-trazada'; tagText = 'Trazada';
        desc = e.gain > 0.005 ? `<b>${c.code}</b> optimiza el vértice y el paso por <em>${esc(cornerStr)}</em>` : `<b>${c.code}</b> ajusta la trayectoria en <em>${esc(cornerStr)}</em>`;
      } else if (e.kind === 'copia') {
        tagClass = 'tag-copia'; tagText = 'Referencia';
        desc = e.gain > 0.005 ? `<b>${c.code}</b> adopta la trazada óptima en <em>${esc(cornerStr)}</em>` : `<b>${c.code}</b> replica la línea ideal en <em>${esc(cornerStr)}</em>`;
      } else if (e.kind === 'caza') {
        tagClass = 'tag-caza'; tagText = 'Salvada';
        desc = `<b>${c.code}</b> salva un sobreviraje con contravolante en <em>${esc(cornerStr)}</em> (gana tacto)`;
      } else if (e.kind === 'prudente') {
        tagClass = 'tag-prudente'; tagText = 'Margen';
        desc = `<b>${c.code}</b> frena con más margen en <em>${esc(cornerStr)}</em> tras un aviso`;
      } else {
        desc = `<b>${c.code}</b> prueba una variación en <em>${esc(cornerStr)}</em>`;
      }

      return `<li class="learn-feed-item ${isMe ? 'me' : ''}">
        <span class="learn-feed-time">${({ FP: 'L1', FP2: 'L2', RACE: 'Carrera' })[e.sess || 'FP'] || e.sess} ${m}:${sec}</span>
        <span class="bar" style="background:${cAcc}"></span>
        <span class="learn-feed-tag ${tagClass}">${tagText}</span>
        <span class="learn-feed-desc">${desc}</span>
        ${gainStr ? `<span class="learn-feed-gain">${gainStr}</span>` : ''}
      </li>`;
    }).join('') || `<li class="learn-feed-empty">Aún no hay registros de aprendizaje en ${wetC ? 'mojado' : 'seco'}.</li>`;

    const noWet = wetC && !sim.cars.some((c) => c.brain.wet && c.brain.wet.laps > 0);

    const m = this.modal(`<header><span class="kicker">IA</span><h2>Aprendizaje y evolución en pista</h2>
        <div class="seg" id="lCond"><button data-c="d" class="${wetC ? '' : 'on'}">☀️ Seco</button><button data-c="w" class="${wetC ? 'on' : ''}">🌧️ Mojado</button></div>
        ${fromResults ? '<button class="btn ghost" id="mBack">Volver</button>' : ''}<button class="btn" id="mClose">Cerrar</button></header>
      <div class="body">
        <div class="learn-summary">
          <div class="learn-card hl">
            <div class="learn-card-lbl">Piloto más evolucionado</div>
            <div class="learn-card-val">${mostImpVal}</div>
            <div class="learn-card-sub">${mostImpSub}</div>
          </div>
          <div class="learn-card">
            <div class="learn-card-lbl">Dominio medio del pelotón</div>
            <div class="learn-card-val">${avgGainVal}</div>
            <div class="learn-card-sub">${avgGainSub}</div>
          </div>
          <div class="learn-card">
            <div class="learn-card-lbl">Cambios que funcionan</div>
            <div class="learn-card-val">${totalTestsVal}</div>
            <div class="learn-card-sub">${totalTestsSub}</div>
          </div>
          <div class="learn-card">
            <div class="learn-card-lbl">Piloto en foco (telemetría)</div>
            <div class="learn-card-val">${focusVal}</div>
            <div class="learn-card-sub">${focusSub}</div>
          </div>
        </div>

        ${noWet ? '<div class="learn-lead wet-info">🌧️ <b>Aún no se ha rodado sobre mojado:</b> la memoria de lluvia partirá de una estimación prudente basada en seco hasta que los pilotos acumulen vueltas con agua en pista.</div>' : '<div class="learn-lead"><b>Dominio</b>: la vuelta que daría cada piloto con su trazada y su ataque de ahora, solo en pista (sin tráfico, gasolina, gomas ni errores), frente a la ideal del circuito. Lo que le falta se reparte entre <b>trazada</b> (por dónde va) y <b>ataque</b> (cuánto agarre se atreve a usar en cada curva). Seco y mojado se aprenden por separado.</div>'}

        <div class="learn-grid">
          <div class="learn-box">
            <div class="learn-box-head"><h3 class="learn-box-title">Dominio del circuito · ${wetC ? 'Mojado' : 'Seco'}</h3><span class="learn-box-sub">${f.code} enfocado · — pelotón · % de la vuelta ideal</span></div>
            <canvas class="chart" id="lchart" width="1000" height="420"></canvas>
          </div>
          <div class="learn-box">
            <div class="learn-box-head"><h3 class="learn-box-title">Trazada de ${fn} frente a la ideal</h3><span class="learn-box-sub">Curva con mayor adaptación</span></div>
            <canvas class="chart" id="lline" width="1000" height="420"></canvas>
          </div>
        </div>

        <div class="learn-grid">
          <div class="learn-box">
            <div class="learn-box-head"><h3 class="learn-box-title">Nivel de ataque en curva · ${fn}</h3><span class="learn-box-sub">☀️ Seco vs 🌧️ Mojado (% de agarre usado)</span></div>
            <canvas class="chart" id="lcommit" width="1000" height="420"></canvas>
          </div>
          <div class="learn-box">
            <div class="learn-box-head"><h3 class="learn-box-title">Últimos aprendizajes en pista</h3><span class="learn-box-sub">${wetC ? '🌧️ Mojado' : '☀️ Seco'} (tiempo real)</span></div>
            <ul class="learn-feed lfeed">${feed}</ul>
          </div>
        </div>

        <div class="learn-sec-title"><span>Rendimiento y telemetría de aprendizaje · ${wetC ? 'Mojado' : 'Seco'}</span><span>Haz clic en una fila para enfocar al piloto</span></div>
        <div class="learn-tw tw"><table class="cls learn-table"><thead><tr>
          <th class="num" title="Posición según mejor vuelta registrada">#</th>
          <th title="Piloto y equipo">Piloto</th>
          <th class="num" title="Vuelta teórica frente a la ideal del circuito (sin tráfico, gasolina, gomas ni errores)">Dominio</th>
          <th class="num" title="Lo que pierde frente a la ideal por la trazada / por no apurar el agarre en las curvas">Trazada / Ataque</th>
          <th class="num" title="Número de vueltas limpias completadas">Vueltas</th>
          <th class="num" title="Mejoras consolidadas / Total de variaciones probadas en curva">Mejoras / Pruebas</th>
          <th title="Porcentaje medio de agarre al límite arriesgado en curva">Agarre Usado</th>
          <th title="Tacto y sensibilidad del piloto al límite de adherencia (aumenta salvando derrapes)">Tacto</th>
          <th class="num" title="Derrapes salvados con contravolante con éxito">Salvadas</th>
          <th class="num" title="Bloqueos de frenada delanteros">Bloqueos</th>
          <th class="num" title="Errores o pérdidas de control">Errores</th>
          ${!showDeg ? '' : '<th class="num" title="Degradación de neumático estimada en s/vuelta para Blando (S) / Medio (M) / Duro (H)">Degradación S/M/H</th>'}
          ${!showOt ? '' : '<th class="num" title="Adelantamientos aprendidos con éxito frente a intentos ensayados">Adelantamientos</th>'}
        </tr></thead><tbody>${rows}</tbody></table></div>
      </div>`);

    const sheet = m.querySelector('.sheet');
    if (sheet) sheet.classList.add('learnSheet');

    m.querySelector('#mClose').onclick = () => this.closeModal();
    m.querySelector('#lCond').onclick = (e) => {
      const c = e.target.closest('button')?.dataset.c;
      if (c && c !== this.learnCond) {
        this.learnCond = c;
        this.showLearning(fromResults);
      }
    };
    const back = m.querySelector('#mBack');
    if (back) back.onclick = () => {
      const e = sim.events.slice().reverse().find((x) => x.type === 'sessionEnd');
      if (e) this.results(e.id, e.cls);
    };
    m.querySelector('tbody').onclick = (e) => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.i != null) {
        const targetCar = sim.cars[+tr.dataset.i];
        if (targetCar) {
          this.dir.setFocus(targetCar);
          const currentScroll = sheet ? sheet.scrollTop : 0;
          this.showLearning(fromResults);
          const newSheet = document.querySelector('.sheet');
          if (newSheet) newSheet.scrollTop = currentScroll;
        }
      }
    };

    this.drawTheoChart(m.querySelector('#lchart'), wetC);
    this.drawLineChart(m.querySelector('#lline'), wetC);
    this.drawCommitChart(m.querySelector('#lcommit'));
  }

  drawCommitChart(cv) {
    if (!cv) return;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const car = this.dir.focus || this.sim.cars[0], b = car.brain, T = this.T;
    g.clearRect(0, 0, W, H);

    const teamAccent = (tm) => {
      if (!tm) return '#20E83B';
      const c = tm.c1;
      if (c === '#141414' || c === '#111111' || c === '#1C1C1C') return '#20E83B';
      if (c === '#1B2A6B' || c === '#0B2A5B') return '#4F86F7';
      if (c === '#0A5C45') return '#00D09C';
      if (c === '#C9CED3' || c === '#EDEDED' || c === '#F2F2F2') return '#E0E3E8';
      return c || '#FF8000';
    };

    const n = b.commit.length;
    const L = 65, R = 25, Tp = 35, B = 50;
    const bw = (W - L - R) / n;
    const lo = 0.75, hi = 1.05;
    const Y = (v) => Tp + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - Tp - B);

    g.font = '600 13px Figtree, sans-serif';
    g.fillStyle = '#8e92a4';
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;

    const ySteps = [0.80, 0.85, 0.90, 0.95, 1.00, 1.05];
    for (const v of ySteps) {
      const y = Y(v);
      g.beginPath();
      g.moveTo(L, y);
      g.lineTo(W - R, y);
      g.stroke();
      g.fillText(Math.round(v * 100) + '%', 15, y + 4);
    }

    const y100 = Y(1.0);
    g.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(L, y100);
    g.lineTo(W - R, y100);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = 'rgba(255, 255, 255, 0.45)';
    g.font = '700 11.5px Figtree, sans-serif';
    g.fillText('100% (Límite nominal)', W - R - 130, y100 - 5);

    const dryColor = teamAccent(car.team);
    const wetColor = '#38BDF8';
    const hasWet = !!b.wet;

    for (let z = 0; z < n; z++) {
      const x = L + z * bw;
      const wBar = Math.max(6, hasWet ? bw * 0.36 : bw * 0.55);
      const gap = hasWet ? 3 : 0;
      const yBase = H - B;

      const vDry = b.commit[z] || 0.88;
      const yDry = Y(vDry);
      const hDry = Math.max(6, yBase - yDry);
      const xDry = hasWet ? x + (bw - (wBar * 2 + gap)) / 2 : x + (bw - wBar) / 2;

      g.fillStyle = dryColor;
      g.beginPath();
      if (g.roundRect) g.roundRect(xDry, yDry, wBar, hDry, [3, 3, 0, 0]);
      else g.rect(xDry, yDry, wBar, hDry);
      g.fill();

      if (hasWet) {
        const vWet = b.wet.commit[z] || 0.85;
        const yWet = Y(vWet);
        const hWet = Math.max(6, yBase - yWet);
        const xWet = xDry + wBar + gap;

        g.fillStyle = wetColor;
        g.beginPath();
        if (g.roundRect) g.roundRect(xWet, yWet, wBar, hWet, [3, 3, 0, 0]);
        else g.rect(xWet, yWet, wBar, hWet);
        g.fill();
      }

      const cName = `T${z + 1}`;
      g.fillStyle = '#d9d9df';
      g.font = '700 13px Figtree, sans-serif';
      g.textAlign = 'center';
      g.fillText(cName, x + bw / 2, H - B + 18);

      const rawCorner = T.corners[z]?.name || '';
      const isNamed = rawCorner && !/^Curva\s*\d+$/i.test(rawCorner) && !/^T\d+$/i.test(rawCorner);
      if (isNamed && n <= 14) {
        g.fillStyle = '#8e92a4';
        g.font = '600 10px Figtree, sans-serif';
        const shortName = rawCorner.replace(/^Curva\s*/i, '').slice(0, 8);
        g.fillText(shortName, x + bw / 2, H - B + 32);
      }
    }
    g.textAlign = 'left';

    const legX = W - 280, legY = 16;
    g.fillStyle = dryColor;
    g.beginPath();
    if (g.roundRect) g.roundRect(legX, legY, 12, 12, 2);
    else g.fillRect(legX, legY, 12, 12);
    g.fill();
    g.fillStyle = '#d9d9df';
    g.font = '700 13px Figtree, sans-serif';
    g.fillText('☀️ Seco', legX + 18, legY + 11);

    g.fillStyle = wetColor;
    g.beginPath();
    if (g.roundRect) g.roundRect(legX + 110, legY, 12, 12, 2);
    else g.fillRect(legX + 110, legY, 12, 12);
    g.fill();
    g.fillStyle = '#d9d9df';
    g.fillText(hasWet ? '🌧️ Mojado' : '🌧️ Mojado (estimado)', legX + 128, legY + 11);
  }

  // dominio (% de la vuelta ideal) a lo largo del fin de semana: el enfocado destacado, el resto del pelotón tenue
  drawTheoChart(cv, wet = false) {
    if (!cv) return;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, sim = this.sim, f = this.dir.focus || sim.cars[0];
    g.clearRect(0, 0, W, H);
    const series = sim.cars.map((c) => ({ c, pts: (this.theoHist.get(c) || []).filter((h) => h.wet === wet) })).filter((s) => s.pts.length > 1);
    if (!series.length) {
      g.fillStyle = '#6b7280'; g.font = '600 22px Figtree, sans-serif'; g.textAlign = 'center';
      g.fillText(wet ? 'Aún no se ha rodado en mojado.' : 'Aún no hay vueltas: deja rodar la sesión.', W / 2, H / 2);
      g.textAlign = 'left'; return;
    }
    const all = series.flatMap((s) => s.pts), x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(x0 + 60, ...all.map((p) => p.x));
    const lo = Math.max(70, Math.floor(Math.min(...all.map((p) => p.pct)) - 1)), hi = Math.min(100, Math.ceil(Math.max(...all.map((p) => p.pct)) + 0.5));
    const L = 70, R = 30, Tp = 24, B = 40;
    const X = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R), Y = (v) => Tp + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - Tp - B);
    g.font = '600 15px Figtree, sans-serif'; g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4, y = Y(v);
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
      g.fillStyle = '#8e92a4'; g.fillText(`${v.toFixed(v % 1 ? 1 : 0)} %`, 10, y + 5);
    }
    g.fillStyle = '#6b7280'; g.font = '600 14px Figtree, sans-serif';
    g.fillText('tiempo en pista del fin de semana →', W - R - 230, H - 10);
    const line = (pts, col, w, alpha) => {
      g.globalAlpha = alpha; g.strokeStyle = col; g.lineWidth = w; g.beginPath();
      pts.forEach((p, k) => (k ? g.lineTo(X(p.x), Y(p.pct)) : g.moveTo(X(p.x), Y(p.pct)))); g.stroke(); g.globalAlpha = 1;
    };
    for (const s of series) if (s.c !== f) line(s.pts, '#9aa0b4', 1.5, 0.25);
    const fs = series.find((s) => s.c === f);
    if (fs) {
      const col = f.team.c1 === '#141414' ? '#20E83B' : f.team.c1;
      line(fs.pts, '#000', 6, 0.5); line(fs.pts, col, 3.5, 1);
      const p = fs.pts[fs.pts.length - 1];
      g.fillStyle = '#fff'; g.font = '800 17px Figtree, sans-serif'; g.fillText(`${f.code} ${p.pct.toFixed(1)} %`, Math.min(X(p.x) + 8, W - 120), Y(p.pct) - 8);
    }
  }

  drawLapChart(cv, wet = false) {
    if (!cv) return;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, sim = this.sim;
    g.clearRect(0, 0, W, H);

    const teamAccent = (tm) => {
      if (!tm) return '#20E83B';
      const c = tm.c1;
      if (c === '#141414' || c === '#111111' || c === '#1C1C1C') return '#20E83B';
      if (c === '#1B2A6B' || c === '#0B2A5B') return '#4F86F7';
      if (c === '#0A5C45') return '#00D09C';
      if (c === '#C9CED3' || c === '#EDEDED' || c === '#F2F2F2') return '#E0E3E8';
      return c || '#FF8000';
    };

    const series = sim.cars.map((c) => {
      const lps = (c.brain.lapHist || []).filter((l) => !!l.wet === wet);
      let m = Infinity;
      const pts = lps.map((l) => (m = Math.min(m, l.t)));
      return { c, pts, raw: lps.map((l) => l.t) };
    }).filter((s) => s.pts.length > 0);

    if (!series.length) {
      g.fillStyle = '#161822';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#6b7280';
      g.font = '600 22px Figtree, sans-serif';
      g.textAlign = 'center';
      g.fillText(wet ? '🌧️ Aún no hay vueltas cronometradas en mojado.' : '⏱️ Aún no hay vueltas limpias registradas.', W / 2, H / 2 - 10);
      g.font = '400 16px Figtree, sans-serif';
      g.fillStyle = '#4b5563';
      g.fillText('Deja rodar la sesión para observar el progreso y evolución de los pilotos.', W / 2, H / 2 + 20);
      g.textAlign = 'left';
      return;
    }

    const allPts = series.flatMap((s) => s.pts);
    const minT = Math.min(...allPts);
    const maxT = Math.max(...allPts);
    const lo = Math.max(30, minT - 0.4);
    const hi = Math.max(lo + 2.5, Math.min(maxT + 0.4, lo + 6.0));
    const maxLaps = Math.max(3, ...series.map((s) => s.pts.length));

    const L = 80, R = 110, Tp = 30, B = 45;
    const X = (i) => L + (i / Math.max(1, maxLaps - 1)) * (W - L - R);
    const Y = (t) => Tp + ((Math.max(lo, Math.min(hi, t)) - lo) / (hi - lo)) * (H - Tp - B);

    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    g.fillStyle = '#8e92a4';
    g.font = '600 15px Figtree, sans-serif';

    const nGrids = 4;
    for (let k = 0; k <= nGrids; k++) {
      const t = lo + ((hi - lo) * k) / nGrids;
      const y = Y(t);
      g.beginPath();
      g.moveTo(L, y);
      g.lineTo(W - R + 20, y);
      g.stroke();
      g.fillText(fmtLap(t).slice(0, 8), 10, y + 5);
    }

    g.font = '600 14px Figtree, sans-serif';
    g.fillStyle = '#6b7280';
    for (let i = 0; i < maxLaps; i++) {
      const x = X(i);
      if (maxLaps <= 15 || i % 2 === 0 || i === maxLaps - 1) {
        g.beginPath();
        g.moveTo(x, Tp);
        g.lineTo(x, H - B);
        g.stroke();
        g.fillText(`V${i + 1}`, x - 8, H - B + 22);
      }
    }

    g.font = '700 13px Figtree, sans-serif';
    g.fillStyle = '#8e92a4';
    g.fillText('▲ Más rápido', 10, Tp - 10);
    g.fillText('Vueltas cronometradas →', W - R - 130, H - 10);

    const focusCar = this.dir.focus || sim.cars[0];

    for (const s of series) {
      if (s.c === focusCar) continue;
      g.strokeStyle = teamAccent(s.c.team);
      g.globalAlpha = 0.22;
      g.lineWidth = 1.5;
      g.beginPath();
      s.pts.forEach((t, i) => (i ? g.lineTo(X(i), Y(t)) : g.moveTo(X(i), Y(t))));
      g.stroke();
    }

    const focusSeries = series.find((s) => s.c === focusCar);
    if (focusSeries && focusSeries.pts.length) {
      const accent = teamAccent(focusCar.team);
      g.globalAlpha = 1;
      g.strokeStyle = '#FFFFFF';
      g.lineWidth = 4;
      g.beginPath();
      focusSeries.pts.forEach((t, i) => (i ? g.lineTo(X(i), Y(t)) : g.moveTo(X(i), Y(t))));
      g.stroke();

      focusSeries.pts.forEach((t, i) => {
        const px = X(i), py = Y(t);
        g.fillStyle = accent;
        g.beginPath();
        g.arc(px, py, 5, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#FFFFFF';
        g.lineWidth = 2;
        g.stroke();
      });

      const lastIdx = focusSeries.pts.length - 1;
      const endX = X(lastIdx), endY = Y(focusSeries.pts[lastIdx]);
      const bestTimeStr = fmtLap(focusSeries.pts[lastIdx]).slice(0, 8);
      const badgeText = `${focusCar.code}  ${bestTimeStr}`;
      g.font = '800 14px Figtree, sans-serif';
      const textW = g.measureText(badgeText).width;

      g.fillStyle = 'rgba(18, 18, 25, 0.9)';
      g.beginPath();
      if (g.roundRect) g.roundRect(endX + 8, endY - 14, textW + 16, 26, 6);
      else g.fillRect(endX + 8, endY - 14, textW + 16, 26);
      g.fill();
      g.strokeStyle = accent;
      g.lineWidth = 1.5;
      g.stroke();

      g.fillStyle = '#FFFFFF';
      g.fillText(badgeText, endX + 16, endY + 4);
    }

    g.globalAlpha = 1;
  }

  drawLineChart(cv, wet = false) {
    if (!cv) return;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, T = this.T;
    const car = this.dir.focus || this.sim.cars[0];
    const kb = wet ? car.brain.wet : car.brain;
    g.clearRect(0, 0, W, H);

    if (!kb) {
      g.fillStyle = '#161822';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#6b7280';
      g.font = '600 20px Figtree, sans-serif';
      g.textAlign = 'center';
      g.fillText('🌧️ Aún no hay datos de trazada en mojado.', W / 2, H / 2);
      g.textAlign = 'left';
      return;
    }

    const teamAccent = (tm) => {
      if (!tm) return '#20E83B';
      const c = tm.c1;
      if (c === '#141414' || c === '#111111' || c === '#1C1C1C') return '#20E83B';
      if (c === '#1B2A6B' || c === '#0B2A5B') return '#4F86F7';
      if (c === '#0A5C45') return '#00D09C';
      if (c === '#C9CED3' || c === '#EDEDED' || c === '#F2F2F2') return '#E0E3E8';
      return c || '#FF8000';
    };

    const line = buildLine(T, kb, new Float32Array(T.N));

    let bz = T.zones[0], bd = -1;
    for (const z of T.zones) {
      let d = 0;
      for (let q = 0; q < z.len; q += 5) {
        const i = T.idx(z.a + q);
        d += Math.abs(line[i] - T.ideal[i]);
      }
      if (d / Math.max(1, z.len) > bd) {
        bd = d / Math.max(1, z.len);
        bz = z;
      }
    }

    const P = [0, 0, 0];
    let cx0 = 1e9, cx1 = -1e9, cz0 = 1e9, cz1 = -1e9;
    for (let q = -30; q <= bz.len + 30; q += 2) {
      T.pos(bz.a + q, 0, P);
      cx0 = Math.min(cx0, P[0]); cx1 = Math.max(cx1, P[0]);
      cz0 = Math.min(cz0, P[2]); cz1 = Math.max(cz1, P[2]);
    }

    const pad = 40;
    const sc = Math.min((W - 2 * pad) / Math.max(20, cx1 - cx0 + 20), (H - 2 * pad - 20) / Math.max(20, cz1 - cz0 + 20));
    const mx = (cx0 + cx1) / 2, mz = (cz0 + cz1) / 2;
    const XY = (x, z) => [W / 2 + (x - mx) * sc, H / 2 + (z - mz) * sc];

    const strokePath = (fn, col, w, dash = []) => {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.setLineDash(dash);
      g.beginPath();
      for (let q = -40; q <= bz.len + 40; q += 2) {
        T.pos(bz.a + q, fn(T.idx(bz.a + q)), P);
        const [x, y] = XY(P[0], P[2]);
        if (q === -40) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.setLineDash([]);
    };

    strokePath(() => 0, '#262835', T.halfW * 2 * sc);
    strokePath(() => T.halfW, 'rgba(255,255,255,0.25)', 2);
    strokePath(() => -T.halfW, 'rgba(255,255,255,0.25)', 2);
    strokePath((i) => T.ideal[i], 'rgba(255,255,255,0.45)', 3, [8, 6]);
    const drvCol = teamAccent(car.team);
    strokePath((i) => line[i], drvCol, 5);

    const cName = bz.corner?.name || `Curva ${bz.id + 1}`;
    g.fillStyle = '#FFFFFF';
    g.font = '800 20px Figtree, sans-serif';
    g.fillText(cName, 16, 28);

    g.fillStyle = '#8e92a4';
    g.font = '600 13px Figtree, sans-serif';
    g.fillText(`Desviación máx: ${(bd).toFixed(2)} m frente a la trazada óptima`, 16, 48);

    g.font = '600 13px Figtree, sans-serif';
    g.fillStyle = '#8e92a4';
    g.fillText('--- Trazada ideal (goma) · ━━━ Trazada elegida por ' + car.code, 16, H - 12);
  }
}

export { NEXT };
