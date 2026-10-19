// Radios piloto ⇄ equipo, de estrategia: salen de los eventos de la sim para el coche enfocado (y los dos del
// equipo en el mánager). Se ven en un panel del HUD y, con el sonido puesto y a velocidad normal, se oyen: pitido de radio y
// voz sintetizada del navegador (speechSynthesis), más grave el ingeniero que el piloto.
import { COMPOUNDS } from './teams.js';
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export class Radio {
  constructor(sim, dir, app) {
    this.sim = sim; this.dir = dir; this.app = app;
    this.q = []; this.cur = null; this.curT = 0; this.gap = 0;
    this.last = new Map();           // última radio por coche y tipo (para no repetir)
    this.voices = [];
    const sv = () => { this.voices = (window.speechSynthesis?.getVoices() || []).filter((v) => /^es/i.test(v.lang)); };
    if (window.speechSynthesis) { sv(); window.speechSynthesis.onvoiceschanged = sv; }
    const el = this.el = document.createElement('div'); el.id = 'radio';
    document.getElementById('hud').appendChild(el);
    sim.on((e) => this.onEvent(e));
  }

  // radios «mías»: el coche enfocado y, en el mánager, los dos del equipo
  mine(c) { return c === this.dir.focus || !!this.app.manager?.cars.includes(c); }
  // mánager: las decisiones (parar, cubrir, gomas de agua, defender) le llegan como avisos con respuesta, no como radio
  mgr(c) { return !!this.app.manager?.cars.includes(c); }
  once(car, key, secs) {
    const k = car.code + key, t = this.sim.t, prev = this.last.get(k);
    if (prev != null && t - prev < secs && t >= prev) return false;
    this.last.set(k, t); return true;
  }
  say(car, lines, prio = 1) {
    // lines: [['d'|'e', texto], ...]  d = piloto, e = ingeniero
    if (this.q.length > 4) this.q = this.q.filter((m) => m.prio > prio);
    this.q.push({ car, lines, prio, t: this.sim.t });
    this.q.sort((a, b) => b.prio - a.prio);
  }
  // compuesto que se pondrá en la próxima parada
  nextTyre(c) { return c.wxC || c.strategy?.stints[c.stint + 1]?.c || c.tyre.c; }
  inWindow(c) { const st = c.strategy?.stints[c.stint]; return !!st && c.stint < c.strategy.stints.length - 1 && c.lap + 3 >= st.to; }
  // vecinos en carrera: el de delante y el de detrás en la clasificación
  around(c) { const o = this.sim.raceOrder || [], k = o.indexOf(c); return { ah: k > 0 ? o[k - 1] : null, bh: k >= 0 && k < o.length - 1 ? o[k + 1] : null }; }
  // próximo cambio en el guion del tiempo
  forecast() {
    const W = this.sim.wx; if (!W?.ev) return null;
    const nx = W.ev.find((e) => e.t > this.sim.t); if (!nx) return null;
    return { mins: Math.max(1, Math.round((nx.t - this.sim.t) / 60)), rain: nx.rain, more: nx.rain > W.target + 0.05 };
  }

  // Solo radios de estrategia: plan, ventana de parada, rivales que paran, huecos que se abren o se cierran,
  // degradación, lluvia, VSC y daños que obligan a parar. Nada de «buen adelantamiento».
  onEvent(e) {
    const s = this.sim, c = e.car, race = s.session?.id === 'RACE', f = this.dir.focus;
    const T = (x) => COMPOUNDS[x]?.name.toLowerCase() || x;
    if (e.type === 'start') {
      for (const m of this.app.manager?.cars || [f]) {
        const st = m.strategy?.stints || []; if (!st.length) continue;
        const plan = st.map((x) => T(x.c)).join(' → ');
        this.say(m, [['e', st.length > 1 ? `Plan A: ${plan}. Parada hacia la vuelta ${st[0].to}.` : `Plan: sin paradas con ${T(st[0].c)}. Cuida la goma.`], ['d', 'Copiado.']], 2);
      }
      return;
    }
    if (e.type === 'vscEnding' && race) {
      for (const m of this.app.manager?.cars || [f]) if (m && !m.retired && !m.finished && !m.inPit) this.say(m, [['e', 'VSC terminando. Prepárate, sin adelantar hasta la verde.']], 2);
    }
    if (e.type === 'flag' && race) {
      for (const m of this.app.manager?.cars || [f]) {
        if (!m || m.retired || m.finished) continue;
        if (e.flag === 'VSC' && this.mgr(m)) continue;
        if (e.flag === 'VSC') this.say(m, [['e', this.inWindow(m) || m.tyre.wear > 0.45 ? `VSC, VSC. Box, box: parada barata. Ponemos ${T(this.nextTyre(m))}.` : 'VSC. Nos quedamos fuera, respeta el delta.']], 3);
        else if (e.flag === 'GREEN' && this.once(m, 'green', 20)) this.say(m, [['e', 'Verde, verde. Fuera VSC.']], 2);
      }
      return;
    }
    if (e.type === 'weather') {
      const fc = this.forecast();
      if (e.what === 'rainStart' && f && !this.mgr(f) && this.once(f, 'rain', 90)) this.say(f, [['d', pick(['Empieza a llover.', 'Gotas en la visera.'])], ['e', fc && fc.more ? `Copiado. El radar dice que irá a más en ${fc.mins === 1 ? 'un minuto' : `unos ${fc.mins} minutos`}. Preparamos intermedios.` : 'Copiado. Es poca cosa según el radar: seguimos con lisos.']], 2);
      else if (e.what === 'rainStop' && f && this.once(f, 'dry', 90)) this.say(f, [['e', 'Ha parado de llover. En cuanto se seque la trazada, lisos. Dinos qué notas.']], 2);
      return;
    }
    if (!c || !this.mine(c)) {
      // un rival directo entra a boxes: cubrir o alargar
      if (race && e.type === 'pitin' && c) for (const m of this.app.manager?.cars || [f]) {
        if (!m || m.inPit || m.retired || this.mgr(m)) continue;
        const { ah, bh } = this.around(m);
        if ((c === ah && s.gapTo(m, c) < 3) || (c === bh && s.gapTo(c, m) < 3)) {
          if (!this.once(m, 'rivalpit', 20)) continue;
          const cover = this.inWindow(m) || m.tyre.wear > 0.5;
          this.say(m, [['e', c === bh
            ? (cover ? `${c.code} para detrás. Box esta vuelta para cubrir el undercut.` : `${c.code} para detrás. Nos quedamos fuera: empuja ahora, tienes que abrir hueco.`)
            : (cover ? `${c.code} entra delante. Box la próxima, vamos a por el undercut.` : `${c.code} entra delante. Alargamos: vueltas limpias, a por el overcut.`)]], 2);
        }
      }
      return;
    }
    const eng = c.drv.first;
    switch (e.type) {
      case 'debris':
        if (e.broken && this.once(c, 'dmg' + e.part, 60)) {
          const what = e.part === 'fw' ? 'el alerón delantero' : e.part === 'rw' ? 'el alerón trasero' : 'la suspensión';
          if (this.mgr(c)) this.say(c, [['d', `Tengo daños, ${what}.`]], 3);
          else this.say(c, [['d', `Tengo daños, ${what}.`], ['e', race ? `Box, box. Cambiamos ${e.part === 'susp' ? 'lo que podamos' : 'el alerón'} y ponemos ${T(this.nextTyre(c))}.` : 'Recibido, vuelve a boxes.']], 3);
        }
        break;
      case 'retire':
        this.say(c, [['e', e.why === 'accidente' ? `${eng}, ¿estás bien? Carrera terminada.` : 'Para el coche. Se acabó, lo siento.']], 4);
        break;
      case 'pitin':
        if (race && !(this.mgr(c) && c.mgr.stopNow)) this.say(c, [['e', `Box, box. Ponemos ${T(this.nextTyre(c))}.`], ['d', 'Copiado.']], 2);
        break;
      case 'pitdone':
        if (race) setTimeout(() => {
          const { ah } = this.around(c), g = ah ? s.gapTo(c, ah) : 0;
          this.say(c, [['e', `${e.time.toFixed(1)} segundos. Sales P${c.pos}${ah ? `, ${ah.code} a ${g.toFixed(1)} delante` : ''}. ${ah && g < 1.5 ? 'Ojo, tráfico: ataca con goma fría con cuidado.' : 'Empuja estas dos vueltas.'}`]], 2);
        }, 1500);
        break;
      case 'knockout':
        this.say(c, [['e', `Fuera en ${s.session.id}, P${c.pos}. No ha sido suficiente, lo siento.`]], 3);
        break;
      case 'limits':
        if (!race && this.once(c, 'lim', 60)) this.say(c, [['e', 'Vuelta anulada por límites de pista. Hay que hacer otra.']], 2);
        break;
      case 'finish':
        this.say(c, [['e', c.finishPos === 1 ? `¡Ganamos, ${eng}! ¡La estrategia ha funcionado!` : `P${e.pos}. ${e.pos <= 3 ? '¡Podio!' : e.pos <= 10 ? 'Puntos.' : 'Hoy no ha podido ser.'}`]], 4);
        break;
      case 'lap':
        if (race) this.raceLap(c); else if (s.session?.id?.startsWith('Q')) this.qualiLap(c, e);
        break;
    }
  }

  // en cada vuelta de carrera: una sola radio como mucho, la más importante
  raceLap(c) {
    const s = this.sim, left = s.raceLaps - c.lap, { ah, bh } = this.around(c);
    const gA = ah ? s.gapTo(c, ah) : null, gB = bh && !bh.retired ? s.gapTo(bh, c) : null;
    const pA = c.rgA, pB = c.rgB; c.rgA = gA; c.rgB = gB;
    const T = (x) => COMPOUNDS[x]?.name.toLowerCase() || x;
    const st = c.strategy?.stints[c.stint], fc = this.forecast(), slick = !COMPOUNDS[c.tyre.c].wet;
    if (c.inPit || c.finished) return;
    if (left === 5 && this.once(c, 'five', 999)) {
      const bits = [gB != null ? `${gB.toFixed(1)} sobre ${bh.code}` : null, gA != null ? `${gA.toFixed(1)} a ${ah.code}` : null].filter(Boolean).join(', ');
      this.say(c, [['e', `Cinco vueltas. ${bits}. ${gA != null && gA < 2 ? 'Todo lo que tengas.' : 'Gestiona y trae el coche.'}`]], 2); return;
    }
    if (this.mgr(c)) {
      // mánager: solo información (las decisiones van por avisos)
      if (st && this.inWindow(c) && this.once(c, 'win' + c.stint, 999)) this.say(c, [['e', `Se abre la ventana: el plan dice box en la vuelta ${st.to}, ${T(this.nextTyre(c))}.`]], 2);
      return;
    }
    if (slick && fc && fc.more && fc.rain > 0.25 && fc.mins <= 6 && this.once(c, 'radar', 200)) {
      this.say(c, [['e', `Radar: lluvia ${fc.rain > 0.6 ? 'fuerte' : 'moderada'} en ${fc.mins === 1 ? 'un minuto' : `unos ${fc.mins} minutos`}. ${this.inWindow(c) ? 'Retrasamos la parada para ir directos a intermedios.' : 'Seguimos, te avisamos.'}`]], 2); return;
    }
    if (st && this.inWindow(c) && this.once(c, 'win' + c.stint, 999)) {
      this.say(c, [['e', `Se abre la ventana. Box hacia la vuelta ${st.to}, ${T(this.nextTyre(c))}. ${gB != null && gB < 2.5 ? `Vigila a ${bh.code}: puede intentar el undercut.` : ''}`]], 2); return;
    }
    if (gB != null && pB != null && gB < 2.5 && pB - gB > 0.25 && this.once(c, 'def', 150)) {
      const d = pB - gB, n = Math.max(1, Math.ceil((gB - 1) / d));
      this.say(c, [['e', gB < 1 ? `${bh.code} en DRS, a ${gB.toFixed(1)}. Te recupera ${d.toFixed(1)} por vuelta: protege las frenadas.` : `${bh.code} a ${gB.toFixed(1)}, te recupera ${d.toFixed(1)} por vuelta. En ${n} ${n === 1 ? 'vuelta' : 'vueltas'} le tienes en DRS.`], ['d', pick(['Entendido.', 'Tengo las gomas justas.', 'Vale, cubro.'])]], 1); return;
    }
    if (gA != null && pA != null && gA < 4 && gA > 1 && pA - gA > 0.25 && this.once(c, 'att', 150)) {
      const d = pA - gA, n = Math.max(1, Math.ceil((gA - 1) / d));
      this.say(c, [['e', `${ah.code} a ${gA.toFixed(1)}. Eres ${d.toFixed(1)} más rápido: en ${n} ${n === 1 ? 'vuelta' : 'vueltas'} estás en DRS.`]], 1); return;
    }
    if (c.tyre.wear > 0.58 && left > 3 && !this.inWindow(c) && this.once(c, 'deg', 240)) {
      const stop = c.stint < (c.strategy?.stints.length || 1) - 1;
      this.say(c, [['d', pick(['Las gomas se acaban.', 'Pierdo mucho detrás.'])], ['e', stop ? `Copiado. Adelantamos la parada, box en ${Math.max(1, Math.min(3, (st?.to || c.lap) - c.lap))} vueltas.` : `Entendido. Quedan ${left}: gestiona, no hay otra parada.`]], 2);
    }
  }

  // clasificación: tras cada vuelta buena, dónde está respecto al corte
  qualiLap(c, e) {
    const s = this.sim, id = s.session.id, cut = { Q1: 16, Q2: 10 }[id];
    if (!e.best || !isFinite(c.best)) return;
    const cls = s.classification(), p = cls.indexOf(c) + 1, ref = cut ? cls[cut - 1] : cls[0];
    if (!this.once(c, 'q' + id, 40)) return;
    if (!cut) { this.say(c, [['e', p === 1 ? 'P1, provisional pole. Otra vuelta si hay goma.' : `P${p}, a ${(c.best - cls[0].best).toFixed(3)} de la pole.`]], 2); return; }
    const out = cls[cut];
    if (p <= cut) this.say(c, [['e', `P${p}. ${out && isFinite(out.best) ? `${(out.best - c.best).toFixed(3)} sobre el corte.` : ''} ${p > cut - 3 ? 'Justo: habrá que salir otra vez.' : 'Estamos cómodos.'}`]], 2);
    else this.say(c, [['e', `P${p}, fuera. Te faltan ${(c.best - ref.best).toFixed(3)} para P${cut}. Otra vuelta, ya.`]], 2);
  }

  update(dt, speed) {
    const el = this.el;
    this.gap -= dt;
    if (this.cur) {
      this.curT -= dt;
      if (this.curT <= 0) { this.cur = null; el.classList.remove('on'); this.gap = 0.6; }
      return;
    }
    // mensajes viejos (la sim va rápida) se descartan
    while (this.q.length && this.sim.t - this.q[0].t > 25) this.q.shift();
    if (this.gap > 0 || !this.q.length) return;
    const m = this.cur = this.q.shift();
    const c = m.car, col = c.team.c1 === '#141414' ? c.team.c2 : c.team.c1;
    el.innerHTML = `<div class="rh"><span class="bar" style="background:${col}"></span><b>${c.code}</b><span>Radio · ${c.team.short}</span><i class="wave"><em></em><em></em><em></em><em></em></i></div>` +
      m.lines.map(([w, t]) => `<p class="${w}"><span>${w === 'd' ? c.drv.last : 'Ingeniero'}</span>${t}</p>`).join('');
    // justo debajo de la torre de tiempos (su alto cambia con la sesión); en pantallas bajas, donde taparía la ficha
    // del piloto, a la derecha de la torre y a ras de su parte de abajo
    const tw = document.getElementById('tower')?.getBoundingClientRect(), cd = document.getElementById('card')?.getBoundingClientRect();
    if (tw) {
      const h = el.offsetHeight || 110, lim = cd && cd.height ? cd.top - 10 : innerHeight - 16;
      const below = tw.bottom + 10 + h <= lim;
      el.style.left = `${below ? tw.left : tw.right + 10}px`;
      el.style.top = `${below ? tw.bottom + 10 : Math.max(16, tw.bottom - h)}px`;
    }
    el.classList.add('on');
    const txt = m.lines.reduce((n, [, t]) => n + t.length, 0);
    this.curT = Math.max(3.5, 1.2 + txt * 0.07);
    if (this.app.audio?.on && speed > 0 && speed <= 2) this.speak(m);
  }

  speak(m) {
    const ss = window.speechSynthesis; if (!ss) return;
    this.beep();
    ss.cancel();
    const v = this.voices;
    m.lines.forEach(([w, t], k) => {
      const u = new SpeechSynthesisUtterance(t);
      u.lang = 'es-ES'; if (v.length) u.voice = v[(w === 'd' ? 1 : 0) % v.length];
      u.rate = w === 'd' ? 1.15 : 1.05; u.pitch = w === 'd' ? 1.1 : 0.8; u.volume = 0.9;
      if (k === m.lines.length - 1) u.onend = () => this.beep(0.7);
      ss.speak(u);
    });
  }

  // pitido de radio (dos tonos cortos con algo de ruido)
  beep(g = 1) {
    try {
      const ctx = this.ctx || (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
      const t = ctx.currentTime, out = ctx.createGain(); out.gain.value = 0.06 * g; out.connect(ctx.destination);
      [[1200, 0], [900, 0.07]].forEach(([fq, d]) => {
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = fq;
        const e = ctx.createGain(); e.gain.setValueAtTime(0, t + d); e.gain.linearRampToValueAtTime(1, t + d + 0.005); e.gain.setValueAtTime(1, t + d + 0.05); e.gain.linearRampToValueAtTime(0, t + d + 0.06);
        o.connect(e).connect(out); o.start(t + d); o.stop(t + d + 0.07);
      });
    } catch { /* sin audio */ }
  }
}
