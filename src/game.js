// Riftline multiplayer: hub (sessions, matchmaking, lobby codes) and rooms (lobby + match).
// Server-authoritative for: seats, teams, host permissions, round/match state, money,
// weapon ownership, ammo, reload timing, fire rate, hit detection, damage, health,
// deaths, scores and results. Movement is client-predicted and server-validated.
import crypto from 'node:crypto';
import { WEAPONS, KNIFE, AMMO_PRICE, ECON, MODES, MAPS, MAP_IDS, EYE, applyArmor } from './data.js';
import { rayPlayer, worldBlock, norm3, forward } from './geom.js';

export const T = {
  BUY: 8000,            // freeze + buy time at the start of each round
  BUY_LIVE: 15000,      // buying is still allowed this long into the live round
  ROUND_END: 4500,
  RESULTS: 12000,
  LOAD_MAX: 35000,      // max wait for everyone to load the map
  GRACE_LOBBY: 30000,   // reconnect window in a private lobby
  GRACE_QUEUE: 10000,   // reconnect window in a public queue
  GRACE_MATCH: 90000,   // reconnect window during a match
  HOST_HANDOFF: 20000,  // a disconnected host keeps the crown this long in the lobby
  EMPTY_PRIVATE: 180000,// private lobby with nobody connected closes after this
  FORFEIT: 90000,       // a team with nobody connected for this long forfeits
  MAX_AGE: 6 * 3600e3,
  TICK: 50,             // 20 Hz simulation / snapshot rate
};
export const ROUNDS_OPTIONS = [3, 5, 7];
export const RTIME_OPTIONS = [60, 90, 120];
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CHARS = 6; // character models available on the client (0..5)
const W_IDX = { knife: 0, deagle: 1, rifle: 2, shotgun: 3, sniper: 4 };

const now = () => Math.round(performance.now());
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(fin);

export function cleanName(n) {
  if (typeof n !== 'string') return '';
  n = n.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '');
  n = n.replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16).trim();
  return n.length >= 2 ? n : '';
}

let seatCounter = 0;

export class Room {
  constructor(hub, { code, priv, mode, map, rounds, rtime }) {
    this.hub = hub;
    this.code = code;
    this.priv = !!priv;
    this.open = false;            // private lobbies can be opened to matchmaking by the host
    this.mode = mode;
    this.map = map;
    this.rounds = rounds;
    this.rtime = rtime;
    this.seats = new Map();       // seatId -> seat
    this.host = null;
    this.phase = priv ? 'lobby' : 'queue';
    this.phaseEnd = 0;
    this.round = 0;
    this.score = [0, 0];
    this.matchNo = 0;
    this.created = now();
    this.emptySince = now();
    this.banned = new Set();
    this.dirty = true;
    this.roomSentAt = 0;
    this.closed = false;
  }

  get max() { return MODES[this.mode].size * 2; }
  get teamSize() { return MODES[this.mode].size; }
  get inMatch() { return ['loading', 'buy', 'live', 'roundEnd', 'results'].includes(this.phase); }
  teamCount(t) { let n = 0; for (const s of this.seats.values()) if (s.team === t) n++; return n; }
  connectedSeats() { return [...this.seats.values()].filter((s) => s.connected); }

  // ---------------- membership ----------------
  canJoin() {
    if (this.closed) return 'closed';
    if (this.seats.size >= this.max) return 'full';
    if (!this.priv && this.phase !== 'queue') return 'in_progress';
    return null;
  }

  addSeat(client, name, char) {
    const seat = {
      id: 'p' + (++seatCounter).toString(36), sk: client.sk, name: this.uniqueName(name), char,
      team: this.pickTeam(), ready: false, client, connected: true, dcAt: 0, joined: now(),
      ping: 0, k: 0, d: 0, hs: 0, dmg: 0,
      alive: false, hp: 100, ar: 100, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, anim: 0,
      w: 'deagle', prim: null, inv: {}, money: ECON.start, keepPrim: false,
      lastPosT: 0, hist: [], spawn: null, frozen: false, loaded: false,
      reloadEnd: 0, reloadW: null, drawEnd: 0, lastCt: null, shotLog: [], meleeNext: 0, strikes: 0,
    };
    this.seats.set(seat.id, seat);
    if (!this.host) this.host = seat.id;
    this.hub.sessions.set(client.sk, { room: this, seat });
    client.room = this; client.seat = seat;
    this.emptySince = 0;
    this.dirty = true;
    this.hub.log(`room ${this.code}: ${seat.name} joined (${this.seats.size}/${this.max})`);
    if (this.inMatch) this.sendState(seat);
    if (!this.priv && this.phase === 'queue' && this.seats.size >= this.max) this.startMatch();
    return seat;
  }

  uniqueName(n) {
    const names = new Set([...this.seats.values()].map((s) => s.name.toLowerCase()));
    if (!names.has(n.toLowerCase())) return n;
    for (let i = 2; i < 99; i++) { const c = (n.slice(0, 13) + ' ' + i); if (!names.has(c.toLowerCase())) return c; }
    return n.slice(0, 10) + ' ' + crypto.randomInt(100, 999);
  }

  pickTeam() {
    const a = this.teamCount(0), b = this.teamCount(1);
    if (a < b) return 0;
    if (b < a) return 1;
    return crypto.randomInt(2);
  }

  reattach(seat, client) {
    if (seat.client && seat.client !== client) seat.client.kick('replaced', 'This game was opened somewhere else');
    seat.client = client; seat.connected = true; seat.dcAt = 0;
    client.room = this; client.seat = seat;
    this.emptySince = 0;
    this.dirty = true;
    this.hub.log(`room ${this.code}: ${seat.name} reconnected`);
    this.sendRoom(seat);
    if (this.inMatch) this.sendState(seat);
  }

  onDisconnect(seat) {
    seat.connected = false; seat.dcAt = now(); seat.client = null;
    this.dirty = true;
    if (!this.connectedSeats().length) this.emptySince = now();
  }

  removeSeat(seat, reason) {
    if (!this.seats.has(seat.id)) return;
    this.seats.delete(seat.id);
    if (this.hub.sessions.get(seat.sk)?.seat === seat) this.hub.sessions.delete(seat.sk);
    if (seat.client) {
      seat.client.room = null; seat.client.seat = null;
      seat.client.send({ t: 'left', reason });
    }
    this.hub.log(`room ${this.code}: ${seat.name} removed (${reason})`);
    if (this.host === seat.id) this.transferHost();
    this.dirty = true;
    if (!this.seats.size) return this.close('empty');
    if (this.inMatch) {
      if (seat.alive) { seat.alive = false; this.checkRoundEnd(); }
      this.checkForfeit();
    } else if (!this.priv && this.phase === 'queue') {
      // nothing else to do: the slot is free again for matchmaking
    }
  }

  transferHost() {
    const next = [...this.seats.values()].filter((s) => s.connected).sort((a, b) => a.joined - b.joined)[0]
      || [...this.seats.values()].sort((a, b) => a.joined - b.joined)[0];
    this.host = next ? next.id : null;
    if (next) { next.ready = false; this.broadcast({ t: 'note', msg: `${next.name} is now the host` }); }
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.seats.values()) {
      if (this.hub.sessions.get(s.sk)?.seat === s) this.hub.sessions.delete(s.sk);
      if (s.client) { s.client.room = null; s.client.seat = null; s.client.send({ t: 'left', reason }); }
    }
    this.seats.clear();
    this.hub.rooms.delete(this.code);
    this.hub.log(`room ${this.code} closed (${reason})`);
  }

  // ---------------- lobby actions (validated on the server) ----------------
  isHost(seat) { return seat && this.host === seat.id; }

  setSettings(seat, m) {
    if (!this.isHost(seat)) return 'not_host';
    if (this.phase !== 'lobby') return 'not_in_lobby';
    if (m.mode !== undefined) {
      if (!MODES[m.mode]) return 'bad_mode';
      const size = MODES[m.mode].size;
      if (this.seats.size > size * 2) return 'too_many_players';
      // re-balance if a team is now over the limit
      for (const t of [0, 1]) {
        while (this.teamCount(t) > size) {
          const mv = [...this.seats.values()].filter((s) => s.team === t).pop();
          mv.team = 1 - t;
        }
      }
      this.mode = m.mode;
    }
    if (m.map !== undefined) { if (!MAP_IDS.includes(m.map)) return 'bad_map'; this.map = m.map; }
    if (m.rounds !== undefined) { if (!ROUNDS_OPTIONS.includes(m.rounds)) return 'bad_rounds'; this.rounds = m.rounds; }
    if (m.rtime !== undefined) { if (!RTIME_OPTIONS.includes(m.rtime)) return 'bad_rtime'; this.rtime = m.rtime; }
    if (m.open !== undefined) this.open = !!m.open;
    for (const s of this.seats.values()) s.ready = false;
    this.dirty = true;
    return null;
  }

  setTeam(seat, targetId, team) {
    if (team !== 0 && team !== 1) return 'bad_team';
    if (this.phase !== 'lobby') return 'not_in_lobby';
    let target = seat;
    if (targetId && targetId !== seat.id) {
      if (!this.isHost(seat)) return 'not_host';
      target = this.seats.get(targetId);
      if (!target) return 'no_player';
    }
    if (target.team === team) return null;
    if (this.teamCount(team) >= this.teamSize) return 'team_full';
    target.team = team; target.ready = false;
    this.dirty = true;
    return null;
  }

  balance(seat) {
    if (!this.isHost(seat)) return 'not_host';
    if (this.phase !== 'lobby') return 'not_in_lobby';
    const list = [...this.seats.values()].sort((a, b) => a.joined - b.joined);
    list.forEach((s, i) => { s.team = i % 2; s.ready = false; });
    this.dirty = true;
    return null;
  }

  kick(seat, targetId) {
    if (!this.isHost(seat)) return 'not_host';
    const target = this.seats.get(targetId);
    if (!target || target === seat) return 'no_player';
    this.banned.add(target.sk);
    this.removeSeat(target, 'kicked');
    return null;
  }

  setReady(seat, v) {
    if (this.phase !== 'lobby') return 'not_in_lobby';
    seat.ready = !!v; this.dirty = true; return null;
  }

  requestStart(seat) {
    if (!this.isHost(seat)) return 'not_host';
    if (this.phase !== 'lobby') return 'not_in_lobby';
    if (!this.teamCount(0) || !this.teamCount(1)) return 'need_both_teams';
    for (const s of this.seats.values()) {
      if (!s.connected) return 'player_reconnecting';
      if (s.id !== this.host && !s.ready) return 'not_ready';
    }
    this.startMatch();
    return null;
  }

  // ---------------- match flow ----------------
  startMatch() {
    if (this.inMatch) return;          // never start twice
    this.matchNo++;
    this.round = 0; this.score = [0, 0];
    for (const s of this.seats.values()) {
      Object.assign(s, { k: 0, d: 0, hs: 0, dmg: 0, money: ECON.start, prim: null, keepPrim: false, alive: false, loaded: false, ready: false });
    }
    this.setPhase('loading', T.LOAD_MAX);
    this.hub.log(`room ${this.code}: match ${this.matchNo} starting (${this.mode} on ${this.map})`);
  }

  setPhase(p, dur) {
    this.phase = p;
    this.phaseEnd = dur ? now() + dur : 0;
    this.dirty = true;
  }

  onLoaded(seat, map) {
    if (map !== this.map) return 'wrong_map';
    seat.loaded = true;
    this.dirty = true;
    if (this.phase === 'loading') {
      const pending = [...this.seats.values()].filter((s) => !s.loaded && s.connected);
      if (!pending.length) this.startRound();
    } else if (this.inMatch) {
      this.sendState(seat);
    }
    return null;
  }

  startRound() {
    if (!this.teamCount(0) || !this.teamCount(1)) return this.endMatch(this.teamCount(0) ? 0 : 1, 'forfeit');
    this.round++;
    const map = MAPS[this.map];
    const idx = [0, 0];
    const order = [...this.seats.values()].sort((a, b) => a.joined - b.joined);
    for (const s of order) {
      const team = s.team;
      const sp = map.spawns[team][idx[team]++ % map.spawns[team].length];
      s.spawn = { x: sp[0], z: sp[1], y: map.height(sp[0], sp[1]), yaw: map.yaw[team] };
      s.reloadEnd = 0; s.reloadW = null; s.lastCt = null; s.shotLog = []; s.meleeNext = 0; s.drawEnd = 0;
      if (!s.loaded) { s.alive = false; continue; }
      if (!s.keepPrim) s.prim = null;
      s.keepPrim = false;
      s.alive = true; s.hp = 100; s.ar = 100; s.frozen = true;
      s.x = s.spawn.x; s.y = s.spawn.y; s.z = s.spawn.z; s.yaw = s.spawn.yaw; s.pitch = -0.03; s.flags = 1; s.anim = 0;
      s.hist = [[now(), s.x, s.y, s.z]]; s.lastPosT = now();
      s.inv = { deagle: { a: WEAPONS.deagle.mag, r: WEAPONS.deagle.res } };
      if (s.prim) s.inv[s.prim] = { a: WEAPONS[s.prim].mag, r: WEAPONS[s.prim].res };
      s.w = s.prim || 'deagle';
    }
    this.setPhase('buy', T.BUY);
    for (const s of this.seats.values()) this.sendState(s);
    this.broadcast({ t: 'round', n: this.round, score: this.score });
  }

  sendState(s) {
    if (!s.client) return;
    s.client.send({
      t: 'spawn', round: this.round, alive: s.alive, x: r2(s.x), y: r2(s.y), z: r2(s.z), yaw: r3(s.yaw),
      hp: s.hp, ar: Math.round(s.ar), money: s.money, prim: s.prim, w: s.w,
      inv: Object.fromEntries(Object.entries(s.inv).map(([k, v]) => [k, [v.a, v.r]])),
      frozen: this.phase === 'buy', map: this.map,
    });
  }

  aliveCount(t) { let n = 0; for (const s of this.seats.values()) if (s.team === t && s.alive) n++; return n; }

  checkRoundEnd() {
    if (this.phase !== 'live' && this.phase !== 'buy') return;
    const a = this.aliveCount(0), b = this.aliveCount(1);
    if (a && b) return;
    this.endRound(a ? 0 : b ? 1 : -1, 'elimination');
  }

  endRound(winner, reason) {
    if (this.phase === 'roundEnd' || this.phase === 'results') return;
    if (winner >= 0) this.score[winner]++;
    for (const s of this.seats.values()) {
      s.keepPrim = s.alive && !!s.prim;
      s.frozen = false;
      s.money = Math.min(ECON.max, s.money + ECON.roundBase + (s.team === winner ? ECON.winBonus : 0));
    }
    this.broadcast({ t: 'rend', winner, reason, score: this.score, round: this.round });
    this.setPhase('roundEnd', T.ROUND_END);
  }

  endMatch(winner, reason) {
    if (this.phase === 'results') return;
    this.setPhase('results', T.RESULTS);
    for (const s of this.seats.values()) { s.alive = false; s.frozen = false; }
    this.broadcast({
      t: 'results', winner, reason, score: this.score, mode: this.mode, map: this.map,
      players: [...this.seats.values()].map((s) => ({ id: s.id, name: s.name, team: s.team, char: s.char, k: s.k, d: s.d, hs: s.hs, dmg: Math.round(s.dmg) })),
    });
    this.hub.log(`room ${this.code}: match over, winner ${winner} (${reason}) ${this.score.join('-')}`);
  }

  checkForfeit() {
    if (!this.inMatch || this.phase === 'results') return;
    for (const t of [0, 1]) {
      if (!this.teamCount(t)) return this.endMatch(1 - t, 'forfeit');
    }
  }

  // ---------------- tick ----------------
  tick() {
    const n = now();
    // disconnect grace
    for (const s of [...this.seats.values()]) {
      if (s.connected) continue;
      const grace = this.inMatch ? T.GRACE_MATCH : this.priv ? T.GRACE_LOBBY : T.GRACE_QUEUE;
      if (n - s.dcAt > grace) { this.removeSeat(s, 'timeout'); if (this.closed) return; continue; }
      if (this.phase === 'lobby' && this.host === s.id && n - s.dcAt > T.HOST_HANDOFF && this.connectedSeats().length) { this.transferHost(); this.dirty = true; }
    }
    if (this.closed) return;
    // expiry
    if (!this.connectedSeats().length) {
      if (!this.emptySince) this.emptySince = n;
      const lim = this.priv ? T.EMPTY_PRIVATE : T.GRACE_QUEUE;
      if (n - this.emptySince > lim) return this.close('expired');
    }
    if (n - this.created > T.MAX_AGE && !this.inMatch) return this.close('expired');
    // forfeit when a whole team has been disconnected for too long
    if (this.inMatch && this.phase !== 'results') {
      for (const t of [0, 1]) {
        const team = [...this.seats.values()].filter((s) => s.team === t);
        if (team.length && team.every((s) => !s.connected && n - s.dcAt > T.FORFEIT)) { this.endMatch(1 - t, 'forfeit'); break; }
      }
    }
    // phase timers
    if (this.phaseEnd && n >= this.phaseEnd) {
      if (this.phase === 'loading') this.startRound();
      else if (this.phase === 'buy') { for (const s of this.seats.values()) s.frozen = false; this.setPhase('live', this.rtime * 1000); }
      else if (this.phase === 'live') this.timeUp();
      else if (this.phase === 'roundEnd') {
        if (Math.max(...this.score) >= this.rounds) this.endMatch(this.score[0] > this.score[1] ? 0 : 1, 'score');
        else this.startRound();
      } else if (this.phase === 'results') {
        if (this.priv) { this.setPhase('lobby', 0); for (const s of this.seats.values()) { s.ready = false; s.loaded = false; } }
        else return this.close('match_over');
      }
    }
    if (this.inMatch && this.phase !== 'loading') this.snapshot(n);
    if (this.dirty || n - this.roomSentAt > 3000) this.sendRoom();
  }

  timeUp() {
    const a = this.aliveCount(0), b = this.aliveCount(1);
    let w = -1;
    if (a !== b) w = a > b ? 0 : 1;
    else {
      const hp = [0, 0];
      for (const s of this.seats.values()) if (s.alive) hp[s.team] += s.hp;
      if (hp[0] !== hp[1]) w = hp[0] > hp[1] ? 0 : 1;
    }
    this.endRound(w, 'time');
  }

  snapshot(n) {
    const p = [];
    for (const s of this.seats.values()) {
      if (!s.loaded && !s.alive) continue;
      p.push([s.id, r2(s.x), r2(s.y), r2(s.z), r3(s.yaw), r3(s.pitch), W_IDX[s.w] ?? 1, s.flags | (s.connected ? 0 : 64), s.anim, s.alive ? 1 : 0]);
    }
    const msg = JSON.stringify({ t: 'snap', ts: n, p });
    for (const s of this.seats.values()) if (s.client && s.loaded) s.client.sendRaw(msg, true);
  }

  roomPayload() {
    return {
      t: 'room', code: this.code, priv: this.priv, open: this.open, mode: this.mode, map: this.map,
      rounds: this.rounds, rtime: this.rtime, host: this.host, phase: this.phase,
      left: this.phaseEnd ? Math.max(0, this.phaseEnd - now()) : 0, round: this.round, score: this.score, max: this.max,
      players: [...this.seats.values()].sort((a, b) => a.joined - b.joined).map((s) => ({
        id: s.id, name: s.name, char: s.char, team: s.team, ready: s.ready, conn: s.connected, ping: s.ping,
        k: s.k, d: s.d, alive: s.alive, loaded: s.loaded,
      })),
    };
  }

  sendRoom(only) {
    const base = this.roomPayload();
    const send = (s) => { if (s.client) s.client.send({ ...base, you: s.id, money: s.money }); };
    if (only) return send(only);
    for (const s of this.seats.values()) send(s);
    this.dirty = false; this.roomSentAt = now();
  }

  broadcast(msg, except) {
    const raw = JSON.stringify(msg);
    for (const s of this.seats.values()) if (s.client && s !== except) s.client.sendRaw(raw);
  }

  // ---------------- gameplay messages ----------------
  posAt(s, t) {
    const h = s.hist;
    if (!h.length) return [s.x, s.y, s.z];
    if (t <= h[0][0]) return [h[0][1], h[0][2], h[0][3]];
    for (let i = h.length - 1; i > 0; i--) {
      const b = h[i], a = h[i - 1];
      if (t >= a[0]) {
        if (t >= b[0]) return [b[1], b[2], b[3]];
        const u = (t - a[0]) / Math.max(1, b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
      }
    }
    return [s.x, s.y, s.z];
  }

  onState(s, m) {
    if (!this.inMatch || !s.alive) return;
    if (![m.x, m.y, m.z, m.yaw, m.pitch].every(fin)) return;
    const map = MAPS[this.map];
    const n = now();
    s.yaw = m.yaw % (Math.PI * 2); s.pitch = Math.max(-1.5, Math.min(1.5, m.pitch));
    s.flags = (m.f | 0) & 63; s.anim = (m.a | 0) & 7;
    let ok = Math.hypot(m.x, m.z) <= map.rad + 8 && m.y > -15 && m.y < 140;
    if (ok && s.frozen) ok = Math.hypot(m.x - s.spawn.x, m.z - s.spawn.z) < 1.2 && Math.abs(m.y - s.spawn.y) < 3;
    if (ok) {
      const dt = Math.min(1.2, (n - s.lastPosT) / 1000);
      const lim = map.maxSpeed * dt * 1.6 + 1.6;
      ok = Math.hypot(m.x - s.x, m.z - s.z) <= lim && Math.abs(m.y - s.y) <= Math.max(lim, 6 * dt + 2.5);
    }
    if (!ok) {
      s.strikes++;
      s.client?.send({ t: 'corr', x: r2(s.x), y: r2(s.y), z: r2(s.z) });
      return;
    }
    s.x = m.x; s.y = m.y; s.z = m.z; s.lastPosT = n;
    s.hist.push([n, s.x, s.y, s.z]);
    while (s.hist.length && n - s.hist[0][0] > 1000) s.hist.shift();
  }

  settleReload(s, n) {
    if (s.reloadEnd && n >= s.reloadEnd) {
      const it = s.inv[s.reloadW];
      if (it) { const w = WEAPONS[s.reloadW]; const take = Math.min(w.mag - it.a, it.r); it.a += take; it.r -= take; }
      s.reloadEnd = 0; s.reloadW = null;
    }
  }

  ammoFix(s, w) { const it = s.inv[w]; if (it) s.client?.send({ t: 'ammo', w, a: it.a, r: it.r }); }

  checkOrigin(s, o) {
    return vec3(o) && Math.hypot(o[0] - s.x, o[2] - s.z) <= 1.8 && o[1] - s.y > EYE - 1.6 && o[1] - s.y < EYE + 1.3;
  }

  onFire(s, m) {
    const n = now();
    if (this.phase !== 'live' || !s.alive || s.frozen) return;
    const w = WEAPONS[m.w];
    if (!w || m.w !== s.w || !s.inv[m.w]) return this.ammoFix(s, s.w);
    this.settleReload(s, n);
    if (s.reloadEnd || n < s.drawEnd) return this.ammoFix(s, m.w);
    const it = s.inv[m.w];
    if (it.a <= 0) return this.ammoFix(s, m.w);
    if (!fin(m.ct)) return;
    // fire rate: client timestamps for spacing (survives network jitter) + server-side window
    if (s.lastCt !== null && m.ct - s.lastCt < w.rate * 1000 * 0.9 - 4) return this.ammoFix(s, m.w);
    s.shotLog = s.shotLog.filter((t) => n - t < 1000);
    if (s.shotLog.length >= Math.ceil(1 / w.rate) + 2) return this.ammoFix(s, m.w);
    if (!this.checkOrigin(s, m.o) || !Array.isArray(m.d) || m.d.length < 1 || m.d.length > (w.pel || 1)) return this.ammoFix(s, m.w);
    const fwd = forward(fin(m.yaw) ? m.yaw : s.yaw, fin(m.pitch) ? m.pitch : s.pitch);
    const dirs = [];
    for (const d of m.d) {
      const v = vec3(d) && norm3(d);
      if (!v) return this.ammoFix(s, m.w);
      if (Math.acos(Math.max(-1, Math.min(1, v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2]))) > 0.6) return this.ammoFix(s, m.w);
      dirs.push(v);
    }
    it.a--; s.lastCt = m.ct; s.shotLog.push(n);
    const rt = fin(m.rt) ? Math.max(n - 500, Math.min(n, m.rt)) : n - 100;
    const map = MAPS[this.map];
    const dmgBy = new Map();
    const ends = [];
    for (const d of dirs) {
      const block = worldBlock(map, m.o, d, w.range);
      let best = null;
      for (const t of this.seats.values()) {
        if (t === s || !t.alive || t.team === s.team) continue;
        const p = this.posAt(t, rt);
        const h = rayPlayer(m.o, d, p[0], p[1], p[2], block);
        if (h && (!best || h.t < best.h.t)) best = { t, h };
      }
      const dist = best ? best.h.t : block;
      ends.push([r2(m.o[0] + d[0] * dist), r2(m.o[1] + d[1] * dist), r2(m.o[2] + d[2] * dist), best ? 1 : 0]);
      if (best) {
        let dm = best.h.head ? w.hd : w.dmg;
        if (w.pel) dm *= Math.max(0.25, 1 - best.h.t / 22);
        const cur = dmgBy.get(best.t) || { dm: 0, head: false, pt: ends[ends.length - 1] };
        cur.dm += dm; cur.head = cur.head || best.h.head;
        dmgBy.set(best.t, cur);
      }
    }
    this.broadcast({ t: 'shot', id: s.id, w: m.w, o: m.o.map(r2), e: ends }, s);
    for (const [t, v] of dmgBy) this.damage(s, t, v.dm, v.head, m.w, v.pt);
  }

  onMelee(s, m) {
    const n = now();
    if (this.phase !== 'live' || !s.alive || s.frozen || s.w !== 'knife') return;
    const k = KNIFE[m.k];
    if (!k || n < s.meleeNext || n < s.drawEnd) return;
    if (!this.checkOrigin(s, m.o) || !vec3(m.d)) return;
    const d = norm3(m.d);
    if (!d) return;
    s.meleeNext = n + k.d * 1000 * 0.8;
    const rt = fin(m.rt) ? Math.max(n - 500, Math.min(n, m.rt)) : n - 100;
    const map = MAPS[this.map];
    let best = null;
    for (const t of this.seats.values()) {
      if (t === s || !t.alive || t.team === s.team) continue;
      const p = this.posAt(t, rt);
      for (const hy of [1.2, 0.6, 1.62]) {
        const v = [p[0] - m.o[0], p[1] + hy - m.o[1], p[2] - m.o[2]];
        const dist = Math.hypot(v[0], v[1], v[2]);
        if (dist > k.range + 0.75) continue;
        const ang = dist < 0.4 ? 0 : Math.acos(Math.max(-1, Math.min(1, (v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) / dist)));
        if (ang > 0.75) continue;
        const dir = norm3(v);
        if (dir && worldBlock(map, m.o, dir, dist) < dist - 0.3) continue;
        if (!best || dist < best.dist) best = { t, dist, pt: [r2(p[0]), r2(p[1] + hy), r2(p[2])] };
        break;
      }
    }
    if (best) this.damage(s, best.t, k.dmg, false, 'knife', best.pt);
  }

  damage(s, t, dm, head, wpn, pt) {
    const before = t.hp;
    const r = applyArmor(t.hp, t.ar, dm);
    t.hp = Math.max(0, r.hp); t.ar = r.ar;
    const lost = before - t.hp;
    s.dmg += lost;
    const kill = t.hp <= 0;
    s.client?.send({ t: 'hit', id: t.id, dmg: lost, head, pt, kill });
    t.client?.send({ t: 'hurt', by: s.id, dmg: dm, hp: t.hp, ar: Math.round(t.ar), from: [r2(s.x), r2(s.z)] });
    if (kill) {
      t.alive = false; t.d++; s.k++; if (head) s.hs++;
      s.money = Math.min(ECON.max, s.money + ECON.kill + (head ? ECON.head : 0));
      this.broadcast({ t: 'kill', k: s.id, v: t.id, w: wpn, h: head });
      this.dirty = true;
      this.checkRoundEnd();
    }
  }

  onReload(s) {
    const n = now();
    if (!this.inMatch || !s.alive) return;
    const w = WEAPONS[s.w], it = s.inv[s.w];
    if (!w || !it) return;
    this.settleReload(s, n);
    if (s.reloadEnd || it.a >= w.mag || it.r <= 0) return;
    s.reloadW = s.w;
    s.reloadEnd = n + w.rl * 0.7 * 1000 - 150; // client refills at 70% of the reload animation
  }

  onSwitch(s, m) {
    const n = now();
    if (!this.inMatch || !s.alive) return;
    const w = m.w;
    if (w !== 'knife' && w !== 'deagle' && w !== s.prim) return s.client?.send({ t: 'wfix', w: s.w });
    if (w === s.w) return;
    this.settleReload(s, n);
    s.reloadEnd = 0; s.reloadW = null;
    s.w = w;
    s.drawEnd = n + (w === 'knife' ? 0.6 : 0.55) * 1000 * 0.7;
  }

  onBuy(s, m) {
    const n = now();
    const deny = (msg) => s.client?.send({ t: 'deny', msg, money: s.money });
    const window = this.phase === 'buy' || (this.phase === 'live' && this.phaseEnd - n > this.rtime * 1000 - T.BUY_LIVE);
    if (!s.alive) return deny('You can buy again next round');
    if (!window) return deny('Buying is only allowed at the start of a round');
    const id = m.w;
    if (id === 'ammo') {
      if (s.money < AMMO_PRICE) return deny('Not enough credits');
      s.money -= AMMO_PRICE;
      for (const k of Object.keys(s.inv)) s.inv[k] = { a: WEAPONS[k].mag, r: WEAPONS[k].res };
      s.reloadEnd = 0;
      return s.client?.send({ t: 'bought', w: 'ammo', money: s.money });
    }
    if (id === 'deagle') return s.client?.send({ t: 'bought', w: 'deagle', money: s.money, equip: true });
    const w = WEAPONS[id];
    if (!w || id === 'deagle') return deny('Unknown item');
    if (s.prim === id) return s.client?.send({ t: 'bought', w: id, money: s.money, equip: true });
    if (s.money < w.price) return deny('Not enough credits');
    s.money -= w.price;
    if (s.prim) delete s.inv[s.prim];
    s.prim = id; s.inv[id] = { a: w.mag, r: w.res };
    s.w = id; s.reloadEnd = 0; s.drawEnd = n + 550 * 0.7;
    s.client?.send({ t: 'bought', w: id, money: s.money });
  }
}

export class Hub {
  constructor({ log = console.log } = {}) {
    this.rooms = new Map();     // code -> Room
    this.sessions = new Map();  // sk -> { room, seat }
    this.log = log;
    this.codeFails = new Map(); // ip -> [timestamps]
  }

  newCode() {
    for (let i = 0; i < 50; i++) {
      let c = '';
      for (let j = 0; j < 6; j++) c += CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('could not allocate a lobby code');
  }

  createRoom(opts) {
    if (this.rooms.size >= 400) return null;
    const room = new Room(this, { code: this.newCode(), ...opts });
    this.rooms.set(room.code, room);
    this.log(`room ${room.code} created (${room.priv ? 'private' : 'public'} ${room.mode} ${room.map})`);
    return room;
  }

  leaveCurrent(client, reason = 'left') {
    const cur = this.sessions.get(client.sk);
    if (cur) cur.room.removeSeat(cur.seat, reason);
  }

  // public matchmaking: never places anyone into a private lobby unless its host opened it
  findMatch(client, mode) {
    const cur = this.sessions.get(client.sk);
    if (cur && !cur.room.priv && cur.room.mode === mode && cur.room.phase === 'queue') return cur.room;
    this.leaveCurrent(client, 'left');
    let best = null;
    for (const r of this.rooms.values()) {
      if (r.closed || r.mode !== mode || r.banned.has(client.sk)) continue;
      const okPublic = !r.priv && r.phase === 'queue';
      const okOpen = r.priv && r.open && r.phase === 'lobby';
      if (!(okPublic || okOpen) || r.seats.size >= r.max) continue;
      if (!best || r.seats.size > best.seats.size) best = r;
    }
    return best || this.createRoom({ priv: false, mode, map: MAP_IDS[crypto.randomInt(MAP_IDS.length)], rounds: 4, rtime: 90 });
  }

  codeAttemptAllowed(ip) {
    const n = now();
    const list = (this.codeFails.get(ip) || []).filter((t) => n - t < 60000);
    this.codeFails.set(ip, list);
    return list.length < 15;
  }

  codeFailed(ip) { (this.codeFails.get(ip) || this.codeFails.set(ip, []).get(ip)).push(now()); }

  tick() {
    for (const r of [...this.rooms.values()]) { try { r.tick(); } catch (e) { this.log('room tick error', r.code, e); } }
    if (Math.random() < 0.01) { const n = now(); for (const [ip, l] of this.codeFails) if (!l.some((t) => n - t < 60000)) this.codeFails.delete(ip); }
  }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) players += r.seats.size;
    return { rooms: this.rooms.size, players };
  }
}

export const CHAR_COUNT = CHARS;
