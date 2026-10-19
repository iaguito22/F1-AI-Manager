// Multijugador: cada amigo lleva su equipo en el mismo fin de semana y todos ven la misma carrera.
// Cómo funciona (lockstep): todas las máquinas simulan exactamente lo mismo (misma semilla, mismo paso fijo). El anfitrión
// marca el ritmo: avisa de por qué paso va y reparte cada orden de un muro con el paso en el que se aplica; los demás nunca
// van por delante de él y aplican cada orden en ese mismo paso. Así solo viajan las órdenes, no el estado de 22 coches.
// Seguro antidesincronización: cada 5 s se compara una huella del estado; si algún invitado no coincide, el anfitrión le
// manda una copia completa del estado (js/snapshot.js) y sigue desde ahí. La misma copia sirve para volver a entrar a
// mitad de partida (con el mismo nombre se recupera el equipo).
// Lo que afecta a todos (velocidad, saltar la sesión, pasar a la siguiente, volver a la sala) se vota; pausar es inmediato.
import { TEAMS } from './teams.js';
import { CIRCUITS } from './track.js';
import { snapshot, restore } from './snapshot.js';

const HASH_EVERY = 300;          // cada 5 s de simulación se comprueba que todos llevan lo mismo
const VOTE_MS = 30000;
const SNAP_CHUNK = 256 * 1024;
const NEXT_LABEL = { FP: 'Ir a Libres 2', FP2: 'Ir a la clasificación', Q1: 'Ir a la Q2', Q2: 'Ir a la Q3', Q3: 'Ir a la carrera', RACE: 'Volver a la sala' };
const WX_N = { random: 'Aleatorio', dry: 'Seco', mixed: 'Chubascos', wet: 'Lluvia' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const teamOf = (id) => TEAMS.find((t) => t.id === id);
const REJOIN = 'mp-rejoin';
// nombres únicos en la sala (al reconectar, el nombre es lo que identifica al jugador y le devuelve su equipo)
function uniqueName(players, name) {
  const base = String(name || 'Jugador').trim().slice(0, 18) || 'Jugador', used = new Set(players.map((p) => p.name.toLowerCase()));
  let n = base, k = 2; while (used.has(n.toLowerCase())) n = `${base} ${k++}`;
  return n;
}

// gzip con lo que trae el navegador
async function gzip(str) { return new Uint8Array(await new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); }
async function gunzip(u8) { return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); }

// ---------------------------------------------------------------- conexión (WebSocket al servidor del anfitrión)
// El servidor solo reenvía: lo del anfitrión a los demás y lo de los demás al anfitrión.
// Direcciones: «192.168.1.20:8765» (misma red) o el enlace de Internet «https://algo.trycloudflare.com».
export class Conn {
  constructor(addr) {
    const raw = String(addr || location.host).trim();
    let secure = /^(https|wss):\/\//i.test(raw);
    const plain = /^(http|ws):\/\//i.test(raw);
    let a = raw.replace(/^(https?|wss?):\/\//i, '').replace(/\/.*$/, '');
    if (!secure && !plain) secure = (a === location.host && location.protocol === 'https:') || /\.trycloudflare\.com$/i.test(a);
    if (!secure && !/:\d+$/.test(a) && !/^\[.*\]$/.test(a)) a += ':' + (location.port || 8765);
    this.addr = secure ? 'https://' + a : a; this.url = `${secure ? 'wss' : 'ws'}://${a}/ws`;
  }
  open(role, name) {
    return new Promise((res, rej) => {
      let done = false;
      const fail = (msg) => { if (!done) { done = true; rej(new Error(msg)); } };
      let ws;
      try { ws = this.ws = new WebSocket(this.url); } catch { fail('Dirección no válida'); return; }
      ws.binaryType = 'arraybuffer';
      const to = setTimeout(() => { fail(`No responde ${this.addr}`); try { ws.close(); } catch { /* */ } }, 9000);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', role, name }));
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') { if (done) this.onbin?.(new Uint8Array(ev.data)); return; }
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (!done) {
          if (m.t === 'welcome') { done = true; clearTimeout(to); this.id = m.id; res(m); }
          else if (m.t === 'error') { clearTimeout(to); fail(m.msg); ws.close(); }
          return;
        }
        this.onmsg?.(m);
      };
      ws.onerror = () => { clearTimeout(to); fail(`No se puede conectar con ${this.addr}`); };
      ws.onclose = () => { clearTimeout(to); if (!done) fail('Conexión cerrada'); else this.onclose?.(); };
    });
  }
  raw(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
  // anfitrión: a todos (to = null) o a uno
  send(m, to = null) { this.raw({ t: 'send', to, m }); }
  sendBin(to, u8) {
    if (this.ws?.readyState !== 1) return;
    const b = new Uint8Array(4 + u8.length); new DataView(b.buffer).setUint32(0, to == null ? 0xffffffff : to); b.set(u8, 4);
    this.ws.send(b);
  }
  close() { try { this.ws?.close(); } catch { /* */ } }
}

// ---------------------------------------------------------------- sala (antes de empezar)
// ui: { root (columna derecha), getSettings(), setSettings(s), lockLeft(on) } que da la pantalla de inicio
export function lobby(ui, { role, name, addr, retry }) {
  const host = role === 'host';
  const conn = new Conn(host ? location.host : addr);
  const root = ui.root;
  const state = { players: [], settings: ui.getSettings(), started: false };
  const tun = { state: 'off' };
  let myId = 0, myReady = false, myTeam = null, quality = ui.getSettings().quality || 'high';
  try { sessionStorage.removeItem(REJOIN); } catch { /* */ }

  return new Promise((resolve, reject) => {
    const status = (t, bad) => { const el = root.querySelector('.mpStatus'); if (el) { el.textContent = t; el.classList.toggle('bad', !!bad); } };
    root.innerHTML = `<h3>Multijugador</h3><p class="hint mpStatus">${host ? 'Creando la sala…' : `Conectando con ${esc(conn.addr)}…`}</p>
      <button class="btn ghost mpBack">Volver</button>`;
    root.querySelector('.mpBack').onclick = () => { conn.close(); reject(new Error('back')); };

    // reintentos al unirse (al volver a la sala o al reconectar, el anfitrión puede tardar un poco)
    let tries = retry ? 15 : 1;
    const connect = () => conn.open(role, name).then(onWelcome, (e) => {
      if (--tries > 0) { status(`${e.message}. Reintentando…`); setTimeout(connect, 1500); return; }
      status(e.message, true);
    });
    connect();

    function onWelcome(w) {
      myId = w.id;
      if (host) {
        state.players = [{ id: 0, name, team: firstFree(), ready: true }];
        myTeam = state.players[0].team;
        conn.onmsg = hostMsg;
        // los ajustes del circuito se leen de la pantalla de inicio (el anfitrión los cambia ahí)
        const iv = setInterval(() => {
          if (state.started) { clearInterval(iv); return; }
          const s = ui.getSettings(); quality = s.quality;
          const sh = { track: s.track, weather: s.weather, raceLaps: s.raceLaps, fpMin: s.fpMin };
          if (JSON.stringify(sh) !== JSON.stringify(state.settings)) { state.settings = sh; broadcast(); }
        }, 400);
        { const g = ui.getSettings(); state.settings = { track: g.track, weather: g.weather, raceLaps: g.raceLaps, fpMin: g.fpMin }; }
        fetch('/info').then((r) => r.json()).then((inf) => { state.ips = inf.ips || []; state.port = inf.port; render(); }).catch(() => { /* sin info */ });
        pollTunnel(false);
      } else {
        ui.lockLeft(true);
        conn.onmsg = clientMsg;
        conn.raw({ t: 'hi' });
      }
      conn.onclose = () => { if (!state.started) { status('Se ha cerrado la conexión con la sala.', true); ui.lockLeft(false); } };
      render();
    }
    // enlace para Internet (túnel de Cloudflare que arranca el servidor)
    function pollTunnel(start) {
      fetch('/tunnel', { method: start ? 'POST' : 'GET' }).then((r) => r.json()).then((t) => {
        const was = tun.state + tun.url + tun.got; Object.assign(tun, t);
        if (was !== tun.state + tun.url + tun.got) render();
        if (!state.started && ['downloading', 'starting'].includes(t.state)) setTimeout(() => pollTunnel(false), 700);
      }).catch(() => { /* servidor antiguo o sin túnel */ });
    }

    function firstFree() { const used = new Set(state.players.map((p) => p.team)); return TEAMS.find((t) => !used.has(t.id))?.id ?? null; }
    function broadcast() { conn.send({ t: 'lobby', players: state.players, settings: state.settings }); render(); }
    function hostMsg(m) {
      if (m.t === 'join') {
        state.players.push({ id: m.id, name: uniqueName(state.players, m.name), team: firstFree(), ready: false });
        broadcast();
      } else if (m.t === 'leave') {
        state.players = state.players.filter((p) => p.id !== m.id); broadcast();
      } else if (m.t === 'from') {
        const p = state.players.find((x) => x.id === m.id), q = m.m || {};
        if (!p) return;
        if (q.t === 'hi') broadcast();
        else if (q.t === 'pick') { if (q.team == null || (teamOf(q.team) && !state.players.some((x) => x !== p && x.team === q.team))) { p.team = q.team ?? null; p.ready = false; } broadcast(); }
        else if (q.t === 'ready') { p.ready = !!q.v; broadcast(); }
      }
    }
    function clientMsg(m) {
      if (m.t === 'lobby') {
        state.players = m.players; state.settings = m.settings; ui.setSettings(m.settings);
        const me = state.players.find((p) => p.id === myId); myTeam = me?.team ?? null; myReady = !!me?.ready;
        render();
      } else if (m.t === 'start') begin(m);
      else if (m.t === 'hostLeft') { status('El anfitrión ha cerrado la sala.', true); ui.lockLeft(false); }
    }

    function netHTML() {
      const lan = state.ips?.length ? state.ips.map((ip) => `<b>http://${esc(ip)}:${state.port}</b>`).join(' · ') : `<b>${esc(location.host)}</b>`;
      const pct = tun.size ? ` ${Math.round((tun.got / tun.size) * 100)} %` : '';
      const online = tun.state === 'on' && tun.url ? `<b class="mpLink">${esc(tun.url)}</b><button class="btn ghost mpCopy">Copiar enlace</button>`
        : tun.state === 'downloading' ? `<span>Descargando el conector de Cloudflare (solo la primera vez)…${pct}</span>`
          : tun.state === 'starting' ? '<span>Creando el enlace…</span>'
            : `${tun.err ? `<span class="bad">${esc(tun.err)}</span>` : ''}<button class="btn mpTun">Crear enlace para jugar por Internet</button>`;
      return `<div class="mpNet"><div><span class="k">Misma red (casa)</span>${lan}</div><div><span class="k">Por internet · sin abrir puertos</span>${online}</div>
        <p class="hint">Tus amigos abren la dirección en Chrome o Edge (no instalan nada), o ejecutan el juego y pulsan «Unirse» con ella.</p></div>`;
    }
    function render() {
      if (state.started) return;
      const s = state.settings || {}, tr = CIRCUITS[s.track];
      const taken = new Map(state.players.filter((p) => p.team).map((p) => [p.team, p]));
      const allReady = state.players.length > 0 && state.players.every((p) => p.ready || p.id === 0);
      root.innerHTML = `<h3>${host ? 'Tu sala' : 'Sala de ' + esc(state.players.find((p) => p.id === 0)?.name || 'anfitrión')}</h3>
        ${host ? netHTML() : `<p class="hint mpAddr">${tr ? esc(tr.name) : '—'} · ${WX_N[s.weather] || '—'} · libres de ${+s.fpMin && +s.fpMin !== 60 ? s.fpMin + ' min' : '1 h'} · ${s.raceLaps || '—'} vueltas de carrera</p>`}
        <div class="mpList">${state.players.map((p) => { const t = teamOf(p.team); return `<div class="mpP ${p.id === myId ? 'me' : ''}"><i style="background:${t ? t.c1 : '#555'}"></i><b>${esc(p.name)}${p.id === 0 ? ' <small>anfitrión</small>' : ''}${p.id === myId ? ' <small>tú</small>' : ''}</b><span>${t ? esc(t.name) : 'Espectador'}</span><em class="${p.ready || p.id === 0 ? 'ok' : ''}">${p.id === 0 ? '' : p.ready ? 'Listo' : 'eligiendo'}</em></div>`; }).join('')}</div>
        <h3>Tu equipo</h3>
        <div class="teams mpTeams">${TEAMS.map((t) => { const o = taken.get(t.id), mine = o && o.id === myId; return `<button data-team="${t.id}" class="${mine ? 'on' : ''}" ${o && !mine ? 'disabled' : ''} title="${esc(t.name)}${o && !mine ? ' · ' + esc(o.name) : ''}"><i style="background:${t.c1}"></i><i style="background:${t.c2}"></i><span>${o && !mine ? esc(o.name) : t.short}</span></button>`; }).join('')}<button data-team="" class="${myTeam ? '' : 'on'}"><span>Espectador</span></button></div>
        ${host ? `<h3>Tiempo</h3>${seg('mpWx', Object.entries(WX_N), s.weather)}<h3>Vueltas de carrera</h3>${seg('mpLaps', [10, 15, 20, 30].map((l) => [l, l]), s.raceLaps)}<h3>Duración de los libres</h3>${seg('mpFp', [[60, '1 h'], [30, '30 min'], [15, '15 min']], s.fpMin || 60)}` : ''}
        <h3>Calidad gráfica (solo en tu equipo)</h3>${seg('mpQ', [['high', 'Alta'], ['low', 'Baja']], quality)}
        ${host ? `<button class="btn go mpGo" ${allReady ? '' : 'disabled'}>${allReady ? 'Empezar el fin de semana' : 'Esperando a que todos estén listos…'}</button>`
          : `<button class="btn go mpReady ${myReady ? 'ghost' : ''}">${myReady ? 'Listo · esperando al anfitrión (pulsa para cancelar)' : 'Estoy listo'}</button>`}
        <p class="hint mpStatus"></p>
        <button class="btn ghost mpBack">Salir de la sala</button>`;
      root.querySelector('.mpBack').onclick = () => { conn.close(); ui.lockLeft(false); reject(new Error('back')); };
      root.querySelectorAll('[data-team]').forEach((b) => (b.onclick = () => {
        const team = b.dataset.team || null;
        if (host) { const me = state.players[0]; if (team == null || !state.players.some((x) => x !== me && x.team === team)) me.team = team; myTeam = me.team; broadcast(); }
        else { conn.raw({ t: 'pick', team }); }
      }));
      bindSeg('mpQ', (v) => { quality = v; ui.setSettings({ quality: v }); });
      if (host) {
        bindSeg('mpWx', (v) => ui.setSettings({ weather: v }));
        bindSeg('mpLaps', (v) => ui.setSettings({ raceLaps: +v }));
        bindSeg('mpFp', (v) => ui.setSettings({ fpMin: +v }));
        const tb = root.querySelector('.mpTun'); if (tb) tb.onclick = () => { tun.state = 'starting'; tun.err = null; render(); pollTunnel(true); };
        const cb = root.querySelector('.mpCopy'); if (cb) cb.onclick = () => { navigator.clipboard?.writeText(tun.url).then(() => { cb.textContent = 'Copiado'; }, () => { /* */ }); };
        root.querySelector('.mpGo').onclick = () => {
          if (!state.players.every((p) => p.ready || p.id === 0)) return;
          const seed = (Math.random() * 0xffffff) | 0;
          const m = { t: 'start', seed, settings: state.settings, players: state.players.map(({ id, name, team }) => ({ id, name, team })) };
          conn.send(m); begin(m);
        };
      } else {
        root.querySelector('.mpReady').onclick = () => { myReady = !myReady; conn.raw({ t: 'ready', v: myReady }); render(); };
      }
    }
    function seg(id, opts, cur) { return `<div class="seg" data-mp="${id}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${l}</button>`).join('')}</div>`; }
    function bindSeg(id, fn) {
      const g = root.querySelector(`[data-mp="${id}"]`); if (!g) return;
      g.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); fn(b.dataset.v); };
    }
    function begin(m) {
      if (state.started) return;
      state.started = true; conn.onclose = null;
      // lo que llegue mientras se construye el circuito se guarda para el juego
      const early = []; conn.onmsg = (x) => early.push(x); conn.onbin = (b) => early.push({ bin: b });
      const players = m.players.slice();          // (el orden lo fija el anfitrión: es el de los muros en todas las máquinas)
      const me = players.find((p) => p.id === myId);
      if (m.late) ui.setSettings(m.settings);
      resolve({
        quality, track: m.settings.track, raceLaps: +m.settings.raceLaps, fpMin: +m.settings.fpMin || 60, weather: m.settings.weather, mode: 'mp', team: me?.team ?? null,
        mp: { conn, isHost: host, myId, players, online: m.online, seed: m.seed, settings: m.settings, late: !!m.late, early, rejoin: { role, name: me?.name || name, addr: conn.addr }, tunnel: tun.url },
      });
    }
  });
}

// ---------------------------------------------------------------- partida en marcha
export class MP {
  // app: { sim, managers, stepOnce(), setSpeed(), doSkip(), doNext(), afterResync(), speed, skipping }
  constructor(app, info) {
    this.app = app; this.conn = info.conn; this.host = info.isHost; this.myId = info.myId; this.rejoin = info.rejoin;
    this.seed = info.seed; this.settings = info.settings; this.link = info.tunnel || null;
    this.players = info.players; this.online = new Set(info.online || this.players.map((p) => p.id));
    this.n = 0; this.known = 0; this.pending = []; this.acc = 0; this.lastSent = -1; this.seq = 0;
    this.loaded = new Set([this.myId]); this.started = !this.host; this.t0 = performance.now();
    this.hashes = new Map(); this.vote = null; this.vid = 0; this.lostConn = false;
    this.snapId = 0; this.snapAt = {}; this.rx = null;
    this.snapWait = !!info.late;               // entra a mitad: espera la copia del estado del anfitrión
    this.joined = !info.late;
    this.buildHUD();
    this.conn.onmsg = (m) => this.onMsg(m);
    this.conn.onbin = (b) => this.onBin(b);
    this.conn.onclose = () => this.lost('Se ha perdido la conexión con el anfitrión.');
    for (const m of info.early || []) { if (m.bin) this.onBin(m.bin); else this.onMsg(m); }
    if (!this.host) {
      this.conn.raw({ t: 'loaded', snap: this.snapWait });
      // si se recarga la página sin querer, vuelve a entrar sola (y recupera su equipo)
      window.addEventListener('pagehide', () => { if (!this.leaving) try { sessionStorage.setItem(REJOIN, JSON.stringify(this.rejoin)); } catch { /* */ } });
    } else if (!this.link) fetch('/tunnel').then((r) => r.json()).then((t) => { if (t.url) { this.link = t.url; this.renderPlayers(); } }).catch(() => { /* */ });
    document.getElementById('bReplay')?.classList.add('hidden');
  }
  me() { return this.players.find((p) => p.id === this.myId); }
  nameOf(id) { return this.players.find((p) => p.id === id)?.name || '¿?'; }
  playing() { return this.players.filter((p) => this.online.has(p.id)); }
  // quién vota: conectados y ya dentro de la partida
  voters() { return this.playing().filter((p) => !this.host || this.loaded.has(p.id)).map((p) => p.id); }

  // ------------------------------------------------ órdenes
  // pedir algo: el anfitrión lo aplica ya; los demás se lo piden a él
  cmd(c) {
    if (this.host) this.hostReq(c, this.myId);
    else this.conn.raw({ t: 'req', c });
  }
  propose(kind, v) { this.cmd({ k: 'propose', kind, v }); }
  answer(yes) { if (this.vote) this.cmd({ k: 'ans', id: this.vote.id, yes }); }

  // (anfitrión) lo que pide un jugador: órdenes de su muro, pausa, propuestas, votos y copias del estado
  hostReq(c, from) {
    if (!c || typeof c !== 'object') return;
    const p = this.players.find((x) => x.id === from); if (!p) return;
    if (c.k === 'mgr') { if (p.team && c.team === p.team) this.apply({ ...c }); }
    else if (c.k === 'pause') { if (this.app.speed !== 0) this.apply({ k: 'speed', v: 0, by: p.name }); }
    else if (c.k === 'propose') this.hostPropose(c.kind, c.v, from);
    else if (c.k === 'ans') { if (this.vote && this.vote.id === c.id) { (c.yes ? this.vote.yes : this.vote.no).add(from); this.checkVote(); } }
    else if (c.k === 'snap' && from !== this.myId) this.sendSnap(from);
  }
  // (anfitrión) se aplica en el paso actual y se reparte (con su número de orden)
  apply(c) {
    this.flushTick();
    this.seq++;
    this.exec(c);
    this.conn.send({ t: 'c', n: this.n, s: this.seq, c });
  }
  // en todas las máquinas, en el mismo paso
  exec(c) {
    const app = this.app, sim = app.sim;
    switch (c.k) {
      case 'mgr': { const m = app.managers.find((x) => x.teamId === c.team); m?.exec(c); break; }
      case 'speed':
        app.setSpeed(c.v);
        this.toast(c.v === 0 ? `${c.by || 'Alguien'} ha pausado la sesión` : `Velocidad ${c.v}×`);
        break;
      case 'skip': app.doSkip(); this.toast('Simulando el resto de la sesión…'); break;
      case 'next': app.doNext(); break;
      case 'drop': {
        // un jugador se ha ido: su equipo sigue con lo último que mandó y no se le espera en la parrilla
        (sim.dropped ||= new Set()).add(c.team);
        const ms = app.managers, ready = sim.gridReady || new Set();
        const s = sim.session;
        if (s?.id === 'RACE' && s.phase === 'grid' && sim.gridHold && ms.every((m) => ready.has(m.teamId) || sim.dropped.has(m.teamId))) { sim.gridHold = false; for (const m of ms) m.release(); }
        break;
      }
      case 'undrop': sim.dropped?.delete(c.team); break;
      case 'lobby': this.backToLobby(); break;
    }
  }
  backToLobby() {
    try { sessionStorage.setItem(REJOIN, JSON.stringify(this.rejoin)); } catch { /* */ }
    this.leaving = true;
    setTimeout(() => location.reload(), this.host ? 600 : 1500);
  }

  // ------------------------------------------------ copia del estado (resincronizar / entrar a mitad)
  async sendSnap(to) {
    const now = performance.now();
    if ((this.snapAt[to] || 0) > now - 3000) return;
    this.snapAt[to] = now;
    this.flushTick();
    const t0 = performance.now();
    const text = JSON.stringify({ n: this.n, seq: this.seq, speed: this.app.speed, skipping: !!this.app.skipping, snap: snapshot(this.app.sim) });
    const data = await gzip(text);
    const id = ++this.snapId, total = Math.ceil(data.length / SNAP_CHUNK);
    for (let i = 0; i < total; i++) {
      const part = data.subarray(i * SNAP_CHUNK, (i + 1) * SNAP_CHUNK), b = new Uint8Array(8 + part.length), dv = new DataView(b.buffer);
      dv.setUint32(0, id); dv.setUint16(4, i); dv.setUint16(6, total); b.set(part, 8);
      this.conn.sendBin(to, b);
    }
    console.info(`copia del estado a ${this.nameOf(to)}: ${(data.length / 1e6).toFixed(2)} MB en ${Math.round(performance.now() - t0)} ms`);
  }
  onBin(u8) {
    if (this.host || u8.length < 8) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), id = dv.getUint32(0), i = dv.getUint16(4), total = dv.getUint16(6);
    if (!this.rx || this.rx.id !== id) this.rx = { id, total, parts: new Array(total), got: 0 };
    this.snapWait = true;                      // mientras llega la copia no se avanza
    if (!this.rx.parts[i]) { this.rx.parts[i] = u8.slice(8); this.rx.got++; }
    this.setWait(`Sincronizando con el anfitrión… ${Math.round((this.rx.got / total) * 100)} %`);
    if (this.rx.got === total) { const parts = this.rx.parts; this.rx = null; this.loadSnap(parts); }
  }
  async loadSnap(parts) {
    try {
      const len = parts.reduce((a, p) => a + p.length, 0), all = new Uint8Array(len);
      let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      const s = JSON.parse(await gunzip(all));
      restore(this.app.sim, s.snap);
      this.n = s.n; if (this.known < s.n) this.known = s.n; this.acc = 0;
      // las órdenes que ya venían dentro de la copia no se repiten
      this.pending = this.pending.filter((m) => (m.s ?? 0) > s.seq);
      this.hashes.clear();
      const app = this.app;
      app.setSpeed(s.speed);
      if (s.skipping && !app.skipping) app.doSkip();
      else if (!s.skipping && app.skipping) { app.skipping = false; document.getElementById('skipBar')?.remove(); }
      app.afterResync?.();
      document.getElementById('mpFlag-desync')?.remove();
      this.toast(this.joined ? 'Corregida una diferencia con el anfitrión' : 'Dentro de la partida');
      this.joined = true;
    } catch (e) { console.error('copia del estado', e); this.toast('No se ha podido cargar la copia del anfitrión; se vuelve a pedir.'); this.askSnap(true); return; }
    this.snapWait = false; this.snapAsked = 0;
  }
  // (invitado) pedir la copia al anfitrión
  askSnap(force) {
    const now = performance.now();
    if (!force && this.snapAsked && now - this.snapAsked < 15000) return;
    this.snapAsked = now; this.snapWait = true;
    this.conn.raw({ t: 'req', c: { k: 'snap' } });
    // si no llega, se vuelve a seguir con lo que hay (y la siguiente huella lo volverá a pedir)
    setTimeout(() => { if (this.snapWait && !this.rx && performance.now() - this.snapAsked >= 29000) this.snapWait = false; }, 30000);
  }

  // ------------------------------------------------ votaciones (las lleva el anfitrión)
  voteLabel(kind, v) {
    const ss = this.app.sim.session;
    if (kind === 'speed') return this.app.speed === 0 ? `Seguir a ${v}×` : `Velocidad ${v}×`;
    if (kind === 'skip') return 'Saltar al final de la sesión';
    if (kind === 'next') return NEXT_LABEL[ss?.id] || 'Siguiente sesión';
    if (kind === 'lobby') return 'Volver a la sala (fin de semana nuevo)';
    return kind;
  }
  hostPropose(kind, v, from) {
    const ss = this.app.sim.session;
    if (!['speed', 'skip', 'next', 'lobby'].includes(kind)) return;
    if (kind === 'speed') { v = +v; if (![1, 2, 4, 8, 16, 32].includes(v) || v === this.app.speed) return; }
    if (kind === 'skip' && (!ss || ss.done || this.app.skipping)) return;
    if (kind === 'next' && !ss?.done) return;
    if (this.vote) {
      // la misma propuesta cuenta como un sí
      if (this.vote.kind === kind && String(this.vote.v) === String(v)) { this.vote.yes.add(from); this.checkVote(); }
      else this.whisper(from, 'Ya hay una votación en marcha.');
      return;
    }
    this.vote = { id: ++this.vid, kind, v, byId: from, by: this.nameOf(from), label: this.voteLabel(kind, v), yes: new Set([from]), no: new Set(), t0: performance.now() };
    this.checkVote();
  }
  checkVote() {
    const V = this.vote; if (!V) return;
    const need = this.voters();
    let res = null;
    if (V.no.size) res = 'no';
    else if (need.every((id) => V.yes.has(id))) res = 'ok';
    else if (performance.now() - V.t0 > VOTE_MS) res = 'timeout';
    if (!res) { this.sendVote(); return; }
    this.vote = null;
    this.conn.send({ t: 'vote', vote: null, res, label: V.label }); this.onVote(null, res, V.label);
    if (res !== 'ok') return;
    if (V.kind === 'speed') this.apply({ k: 'speed', v: V.v, by: V.by });
    else if (V.kind === 'skip') { if (!this.app.sim.session?.done) this.apply({ k: 'skip' }); }
    else if (V.kind === 'next') { if (this.app.sim.session?.done) this.apply({ k: 'next' }); }
    else if (V.kind === 'lobby') this.apply({ k: 'lobby' });
  }
  sendVote() {
    const V = this.vote, need = this.voters();
    const pub = V && { id: V.id, kind: V.kind, label: V.label, by: V.by, yes: [...V.yes], need, left: Math.max(0, Math.ceil((VOTE_MS - (performance.now() - V.t0)) / 1000)) };
    this.conn.send({ t: 'vote', vote: pub }); this.onVote(pub);
  }
  whisper(id, text) { if (id === this.myId) this.toast(text); else this.conn.send({ t: 'toast', text }, id); }

  // ------------------------------------------------ mensajes
  sharePlayers() { this.conn.send({ t: 'players', players: this.players, online: [...this.online] }); this.renderPlayers(); }
  onMsg(m) {
    if (this.host) {
      if (m.t === 'from') {
        const q = m.m || {};
        if (q.t === 'req') this.hostReq(q.c, m.id);
        else if (q.t === 'loaded') { this.loaded.add(m.id); this.renderPlayers(); if (q.snap) this.sendSnap(m.id); }
      } else if (m.t === 'join') this.lateJoin(m.id, String(m.name || 'Jugador').slice(0, 20));
      else if (m.t === 'leave') {
        if (!this.online.has(m.id)) return;
        this.online.delete(m.id); this.loaded.delete(m.id);
        const p = this.players.find((x) => x.id === m.id);
        this.sharePlayers(); this.toast(`${this.nameOf(m.id)} se ha desconectado. Su equipo sigue con sus últimas órdenes; puede volver a entrar con el mismo nombre.`);
        if (p?.team) this.apply({ k: 'drop', team: p.team });
        // su propuesta se cae con él
        if (this.vote?.byId === m.id) { const l = this.vote.label; this.vote = null; this.conn.send({ t: 'vote', vote: null, res: 'no', label: l }); this.onVote(null, 'no', l); }
        this.checkVote();
      }
      return;
    }
    switch (m.t) {
      case 'k': if (m.n > this.known) this.known = m.n; break;
      case 'c': this.pending.push(m); if (m.n > this.known) this.known = m.n; break;
      case 'h': if (!this.snapWait) this.checkHash(m.n, m.h, true); break;
      case 'vote': this.onVote(m.vote, m.res, m.label); break;
      case 'toast': this.toast(m.text); break;
      case 'players': {
        const before = new Set(this.online);
        this.players = m.players; this.online = new Set(m.online);
        for (const p of this.players) {
          if (before.has(p.id) && !this.online.has(p.id)) this.toast(`${p.name} se ha desconectado. Su equipo sigue con sus últimas órdenes.`);
          if (!before.has(p.id) && this.online.has(p.id) && p.id !== this.myId) this.toast(`${p.name} ha entrado en la partida`);
        }
        this.renderPlayers(); break;
      }
      case 'go': this.started = true; this.renderPlayers(); break;
      case 'hostLeft': if (!this.leaving) this.lost('El anfitrión ha salido de la partida.'); break;
    }
  }
  // (anfitrión) alguien entra con la partida en marcha: si ya jugaba (mismo nombre) recupera su equipo; si no, mira
  lateJoin(id, name) {
    // (los nombres son únicos: el mismo nombre es el mismo jugador, aunque su conexión vieja aún no se haya cerrado)
    let p = this.players.find((x) => x.name.toLowerCase() === name.trim().toLowerCase() && x.id !== this.myId);
    if (p) { this.online.delete(p.id); this.loaded.delete(p.id); p.id = id; }
    else { p = { id, name: uniqueName(this.players, name), team: null }; this.players.push(p); }
    this.online.add(id);
    this.conn.send({ t: 'start', late: true, seed: this.seed, settings: this.settings, players: this.players, online: [...this.online] }, id);
    this.sharePlayers();
    if (p.team && this.app.sim.dropped?.has(p.team)) this.apply({ k: 'undrop', team: p.team });
    this.toast(`${name} ${p.team ? 'vuelve a la partida' : 'entra como espectador'}`);
  }

  // ------------------------------------------------ avance de la simulación (cada fotograma)
  stepOne() {
    this.app.stepOnce(); this.n++;
    if (this.n % HASH_EVERY === 0) {
      const h = this.hash();
      if (this.host) this.conn.send({ t: 'h', n: this.n, h }); else this.checkHash(this.n, h, false);
    }
  }
  flushTick() { if (this.host && this.n !== this.lastSent) { this.lastSent = this.n; this.conn.send({ t: 'k', n: this.n }); } }
  applyDue() {
    while (this.pending.length && this.pending[0].n <= this.n) {
      const m = this.pending.shift();
      if (m.n < this.n) { console.warn('orden tardía', m); this.askSnap(); }
      this.exec(m.c);
    }
  }
  // devuelve el tiempo aún no simulado (para dibujar los coches sin saltos)
  drive(dt) {
    const app = this.app, sim = app.sim, DT = 1 / 60;
    if (this.host) {
      if (this.vote && performance.now() - this.vote.t0 > VOTE_MS) this.checkVote();
      else if (this.vote && (this._vt = (this._vt || 0) + dt) > 1) { this._vt = 0; this.sendVote(); }
      if (!this.started) {
        const waiting = this.playing().filter((p) => !this.loaded.has(p.id));
        if (!waiting.length || performance.now() - this.t0 > 120000) { this.started = true; this.conn.send({ t: 'go' }); this.renderPlayers(); }
        else { this.setWait(`Esperando a que carguen: ${waiting.map((p) => esc(p.name)).join(', ')}…`); return 0; }
      }
      this.setWait('');
      if (!sim.session || sim.session.done) { this.flushTick(); return 0; }
      if (app.skipping) {
        const t0 = performance.now();
        while (performance.now() - t0 < 70 && !sim.session.done) for (let k = 0; k < 30 && !sim.session.done; k++) this.stepOne();
        this.acc = 0;
      } else {
        this.acc += dt * app.speed;
        let k = 0; while (this.acc >= DT && k < 2400) { this.stepOne(); this.acc -= DT; k++; }
        if (k >= 2400) this.acc = 0;
      }
      this.flushTick();
      return this.acc;
    }
    // invitado: nunca por delante del anfitrión
    if (this.snapWait) { if (!this.rx) this.setWait(this.joined ? 'Corrigiendo una diferencia con el anfitrión…' : 'Entrando en la partida…'); return 0; }
    this.applyDue();
    const lag = this.known - this.n;
    this.setWait(this.lostConn ? '' : lag > 600 && !app.skipping ? `Alcanzando al anfitrión… (${Math.round(lag / 60)} s)` : '');
    if (app.skipping || lag > 60 * Math.max(1, app.speed) * 0.75) {
      // muy por detrás (o saltando la sesión): a toda máquina con un límite de tiempo por fotograma
      const t0 = performance.now(), budget = app.skipping ? 70 : 40;
      while (this.n < this.known && performance.now() - t0 < budget && !this.snapWait) for (let k = 0; k < 20 && this.n < this.known && !this.snapWait; k++) { this.applyDue(); this.stepOne(); }
      this.acc = 0;
    } else {
      this.acc += dt * app.speed;
      while (this.acc >= DT && this.n < this.known && !this.snapWait) { this.applyDue(); this.stepOne(); this.acc -= DT; }
      if (this.n >= this.known) this.acc = Math.min(this.acc, DT);
    }
    if (!this.snapWait) this.applyDue();
    return this.acc;
  }

  // huella del estado: si no coincide con la del anfitrión, las simulaciones se han separado -> se pide la copia
  hash() {
    let h = 2166136261 >>> 0;
    const mix = (x) => { h ^= x | 0; h = Math.imul(h, 16777619) >>> 0; };
    const sim = this.app.sim;
    mix(Math.round(sim.t * 100)); mix(sim.rng.s); mix(sim.raceOrder ? sim.raceOrder.length : -1);
    for (const c of sim.cars) {
      mix(Math.round(c.s * 100)); mix(Math.round(c.d * 1000)); mix(Math.round(c.v * 1000)); mix(c.lap); mix(Math.round(c.tyre.wear * 1e6));
      mix(c.laps.length); mix(c.brain.acc || 0); mix(c.stint || 0); mix(c.pitReq ? 1 : 0); mix(Math.round((c.fuel || 0) * 100));
    }
    return h;
  }
  checkHash(n, h, fromHost) {
    const e = this.hashes.get(n) || {};
    if (fromHost) e.host = h; else e.mine = h;
    if (e.host != null && e.mine != null) {
      this.hashes.delete(n);
      if (e.host !== e.mine) { console.warn('Diferencia con el anfitrión en el paso', n, e); this.flag('desync', 'Corrigiendo una diferencia con el anfitrión…'); this.askSnap(); }
    } else this.hashes.set(n, e);
    if (this.hashes.size > 60) this.hashes.delete(this.hashes.keys().next().value);
  }

  lost(text) {
    if (this.leaving || this.lostConn) return;
    this.lostConn = true; this.app.setSpeed(0);
    const d = document.createElement('div'); d.className = 'modal mpLost';
    d.innerHTML = `<div class="sheet pauseSheet"><div class="pause"><div class="ph"><span class="kicker">Multijugador</span><b>Conexión perdida</b><span>${esc(text)}</span></div>
      ${this.host ? '' : '<button class="btn big" id="mpRe">Reconectar (recuperas tu equipo)</button>'}
      <button class="btn ${this.host ? 'big' : 'ghost'}" id="mpReload">Volver al menú</button></div></div>`;
    document.body.appendChild(d);
    d.querySelector('#mpReload').onclick = () => { this.leaving = true; try { sessionStorage.removeItem(REJOIN); } catch { /* */ } location.reload(); };
    d.querySelector('#mpRe')?.addEventListener('click', () => { this.leaving = true; try { sessionStorage.setItem(REJOIN, JSON.stringify(this.rejoin)); } catch { /* */ } location.reload(); });
  }

  // ------------------------------------------------ interfaz: jugadores, pausa, votación y avisos
  buildHUD() {
    const hud = document.getElementById('hud');
    this.el = document.createElement('div'); this.el.id = 'mpBar';
    this.el.innerHTML = '<div class="mpPl"></div><div class="mpWait hidden"></div>';
    hud.appendChild(this.el);
    this.vel = document.createElement('div'); this.vel.id = 'mpVote'; this.vel.className = 'hidden'; hud.appendChild(this.vel);
    this.tel = document.createElement('div'); this.tel.id = 'mpToasts'; hud.appendChild(this.tel);
    this.vel.addEventListener('pointerdown', (e) => { const b = e.target.closest('[data-vote]'); if (b) { e.preventDefault(); this.answer(b.dataset.vote === '1'); this.renderVote(); } });
    this.renderPlayers();
  }
  renderPlayers() {
    const paused = this.app.speed === 0 && this.app.sim?.session && !this.app.sim.session.done;
    this.el.querySelector('.mpPl').innerHTML = `<div class="mpH">Multijugador${paused ? ' · <b>en pausa</b>' : ''}</div>` + this.players.map((p) => {
      const t = teamOf(p.team), on = this.online.has(p.id);
      return `<div class="mpP ${on ? '' : 'off'} ${p.id === this.myId ? 'me' : ''}"><i style="background:${t ? t.c1 : '#555'}"></i><b>${esc(p.name)}</b><span>${on ? (t ? esc(t.short) : 'espect.') : 'desconectado'}</span></div>`;
    }).join('') + (this.host && this.link ? `<div class="mpLinkS" title="Enlace para volver a entrar por Internet">${esc(this.link.replace('https://', ''))}</div>` : '');
  }
  setWait(t) {
    if (t === this._wait) return; this._wait = t;
    const w = this.el.querySelector('.mpWait'); w.classList.toggle('hidden', !t); w.innerHTML = t;
  }
  onVote(v, res, label) {
    this.vote = this.host ? this.vote : v;
    this.pubVote = v;
    if (!v && res) this.toast(res === 'ok' ? `Aprobado: ${label}` : res === 'no' ? `Rechazado: ${label}` : `Sin respuesta de todos: ${label}`);
    this.renderVote();
  }
  renderVote() {
    const v = this.pubVote;
    this.vel.classList.toggle('hidden', !v);
    if (!v) return;
    const voted = v.yes.includes(this.myId);
    this.vel.innerHTML = `<div class="vq"><span class="k">Votación · ${esc(v.by)} propone</span><b>${esc(v.label)}</b><span class="vn">${v.yes.length}/${v.need.length} a favor · ${v.left} s</span></div>
      ${voted ? '<span class="vw">Has votado sí. Esperando al resto…</span>' : '<button class="btn" data-vote="1">Sí</button><button class="btn ghost" data-vote="0">No</button>'}`;
  }
  toast(text) {
    const d = document.createElement('div'); d.className = 'mpT'; d.textContent = text;
    this.tel.appendChild(d); setTimeout(() => d.remove(), 4500);
    while (this.tel.children.length > 4) this.tel.firstChild.remove();
    this.renderPlayers();
  }
  flag(id, text) {
    let d = document.getElementById('mpFlag-' + id);
    if (!d) { d = document.createElement('div'); d.id = 'mpFlag-' + id; d.className = 'mpFlag'; this.el.appendChild(d); }
    d.textContent = text;
  }
}

// ---------------------------------------------------------------- volver a la sala / reconectar tras recargar
export function pendingRejoin() {
  try { const r = JSON.parse(sessionStorage.getItem(REJOIN) || 'null'); return r && r.role ? r : null; } catch { return null; }
}
