// Riftline multiplayer server: HTTP (health) + WebSocket game protocol.
import http from 'node:http';
import { acceptUpgrade, rejectUpgrade } from './ws.js';
import { Hub, T, cleanName, CHAR_COUNT } from './game.js';
import { MODES, MAP_IDS } from './data.js';

const PROTOCOL = 1;

export function createServer(opts = {}) {
  const cfg = {
    port: Number(opts.port ?? process.env.PORT ?? 2567),
    origins: (opts.origins ?? process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    maxPerIp: Number(opts.maxPerIp ?? process.env.MAX_CONN_PER_IP ?? 16),
    maxConns: Number(opts.maxConns ?? process.env.MAX_CONNECTIONS ?? 1500),
    trustProxy: (opts.trustProxy ?? process.env.TRUST_PROXY ?? '1') !== '0',
    quiet: opts.quiet ?? false,
  };
  const log = (...a) => { if (!cfg.quiet) console.log(new Date().toISOString(), ...a); };
  const hub = new Hub({ log });
  const clients = new Set();
  const perIp = new Map();

  function originAllowed(origin) {
    if (!cfg.origins.length || cfg.origins.includes('*')) return true;
    if (!origin) return false;
    return cfg.origins.some((o) => {
      if (o.startsWith('*.')) { try { return new URL(origin).hostname.endsWith(o.slice(1)); } catch { return false; } }
      return o === origin;
    });
  }

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (url === '/health' || url === '/') {
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ ok: true, game: 'riftline', protocol: PROTOCOL, ...hub.stats() }));
    }
    res.writeHead(404, headers); res.end('{"ok":false}');
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const ip = (cfg.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
    if (!originAllowed(req.headers.origin)) { log('rejected origin', req.headers.origin); return rejectUpgrade(socket, 403, 'Forbidden'); }
    if (clients.size >= cfg.maxConns) return rejectUpgrade(socket, 503, 'Busy');
    if ((perIp.get(ip) || 0) >= cfg.maxPerIp) return rejectUpgrade(socket, 429, 'Too Many Connections');
    const ws = acceptUpgrade(req, socket, head, { maxPayload: 8 * 1024 });
    if (!ws) return;
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    const c = new Client(ws, ip);
    clients.add(c);
    ws.on('close', () => {
      clients.delete(c);
      const n = (perIp.get(ip) || 1) - 1; if (n > 0) perIp.set(ip, n); else perIp.delete(ip);
      c.onClose();
    });
  });

  class Client {
    constructor(ws, ip) {
      this.ws = ws; this.ip = ip; this.sk = null; this.room = null; this.seat = null;
      this.tokens = 120; this.lastRefill = Date.now(); this.strikes = 0; this.closed = false;
      this.helloTimer = setTimeout(() => { if (!this.sk) this.kick('timeout', 'No hello'); }, 10000);
      ws.on('message', (txt) => this.onMessage(txt));
    }
    send(obj) { this.sendRaw(JSON.stringify(obj)); }
    sendRaw(raw, droppable) {
      if (this.closed || !this.ws.open) return;
      if (this.ws.buffered > 1024 * 1024) return this.ws.terminate();
      if (droppable && this.ws.buffered > 128 * 1024) return; // slow connection: skip a snapshot
      this.ws.send(raw);
    }
    kick(code, msg) { this.send({ t: 'err', code, msg }); this.closed = true; this.ws.close(4000, code); }
    err(code, msg) { this.send({ t: 'err', code, msg: msg || code }); }
    strike(n) { this.strikes += n; if (this.strikes > 300) this.kick('abuse', 'Too many invalid messages'); }

    onClose() {
      clearTimeout(this.helloTimer);
      this.closed = true;
      if (this.room && this.seat && this.seat.client === this) this.room.onDisconnect(this.seat);
    }

    onMessage(txt) {
      const t = Date.now();
      this.tokens = Math.min(120, this.tokens + (t - this.lastRefill) * 0.06); // 60 msgs/s sustained
      this.lastRefill = t;
      if (this.tokens < 1) return this.strike(1);
      this.tokens--;
      let m;
      try { m = JSON.parse(txt); } catch { return this.strike(10); }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return this.strike(10);
      if (!this.sk && m.t !== 'hello') return this.strike(5);
      try { this.route(m); } catch (e) { log('handler error', m.t, e); this.strike(5); }
    }

    route(m) {
      const room = this.room, seat = this.seat;
      switch (m.t) {
        case 'hello': return this.hello(m);
        case 'ping': if (typeof m.c === 'number') { if (seat && typeof m.r === 'number') seat.ping = Math.max(0, Math.min(999, Math.round(m.r))); this.send({ t: 'pong', c: m.c, s: Math.round(performance.now()) }); } return;
        case 'q': return this.queue(m);
        case 'create': return this.create(m);
        case 'join': return this.join(m);
        case 'leave': hub.leaveCurrent(this, 'left'); return;
        case 'prof': return this.profile(m);
      }
      if (!room || !seat) return this.err('no_room', 'You are not in a lobby');
      let e = null;
      switch (m.t) {
        case 'set': e = room.setSettings(seat, { mode: m.mode, map: m.map, rounds: m.rounds, rtime: m.rtime, open: m.open }); break;
        case 'team': e = room.setTeam(seat, typeof m.id === 'string' ? m.id : null, m.team); break;
        case 'balance': e = room.balance(seat); break;
        case 'kick': e = room.kick(seat, String(m.id || '')); break;
        case 'ready': e = room.setReady(seat, m.v); break;
        case 'start': e = room.requestStart(seat); break;
        case 'close': if (!room.isHost(seat)) e = 'not_host'; else room.close('closed_by_host'); break;
        case 'loaded': e = room.onLoaded(seat, m.map); break;
        case 'st': return room.onState(seat, m);
        case 'fire': return room.onFire(seat, m);
        case 'melee': return room.onMelee(seat, m);
        case 'rl': return room.onReload(seat);
        case 'ws': return room.onSwitch(seat, m);
        case 'buy': return room.onBuy(seat, m);
        default: return this.strike(5);
      }
      if (e) this.err(e); else if (!room.closed) room.sendRoom();
    }

    profileOk(m) {
      const name = cleanName(m.name) || ('Guest' + Math.floor(1000 + Math.random() * 9000));
      const ch = Number.isInteger(m.char) && m.char >= 0 && m.char < CHAR_COUNT ? m.char : 0;
      return { name, char: ch };
    }

    hello(m) {
      if (this.sk) return;
      if (m.v !== PROTOCOL) return this.kick('version', 'Please refresh the page to update the game');
      if (typeof m.sk !== 'string' || !/^[a-f0-9]{32}$/.test(m.sk)) return this.kick('bad_session', 'Invalid session');
      clearTimeout(this.helloTimer);
      this.sk = m.sk;
      this.profileData = this.profileOk(m);
      this.send({ t: 'welcome', s: Math.round(performance.now()), modes: Object.keys(MODES), maps: MAP_IDS });
      const ex = hub.sessions.get(this.sk);
      if (ex && !ex.room.closed) ex.room.reattach(ex.seat, this);
    }

    profile(m) {
      this.profileData = this.profileOk(m);
      if (this.room && this.seat) {
        const others = [...this.room.seats.values()].filter((s) => s !== this.seat);
        let n = this.profileData.name;
        if (others.some((s) => s.name.toLowerCase() === n.toLowerCase())) n = this.room.uniqueName(n);
        this.seat.name = n; this.seat.char = this.profileData.char; this.room.dirty = true;
      }
    }

    queue(m) {
      if (!MODES[m.mode]) return this.err('bad_mode');
      const room = hub.findMatch(this, m.mode);
      if (!room) return this.err('server_full', 'The server is full right now. Try again soon.');
      if (this.room !== room) room.addSeat(this, this.profileData.name, this.profileData.char);
      room.sendRoom();
    }

    create(m) {
      if (!MODES[m.mode]) return this.err('bad_mode');
      const map = MAP_IDS.includes(m.map) ? m.map : MAP_IDS[0];
      hub.leaveCurrent(this, 'left');
      const room = hub.createRoom({ priv: true, mode: m.mode, map, rounds: [3, 5, 7].includes(m.rounds) ? m.rounds : 5, rtime: [60, 90, 120].includes(m.rtime) ? m.rtime : 90 });
      if (!room) return this.err('server_full', 'The server is full right now. Try again soon.');
      room.addSeat(this, this.profileData.name, this.profileData.char);
      room.sendRoom();
    }

    join(m) {
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!hub.codeAttemptAllowed(this.ip)) return this.err('rate_limited', 'Too many attempts. Wait a minute and try again.');
      const room = hub.rooms.get(code);
      if (!room || room.closed) { hub.codeFailed(this.ip); return this.err('not_found', 'That lobby does not exist or has closed.'); }
      if (this.room === room) return room.sendRoom(this.seat);
      if (room.banned.has(this.sk)) return this.err('kicked', 'You were removed from this lobby.');
      const why = room.canJoin();
      if (why === 'full') return this.err('full', 'That lobby is full.');
      if (why) return this.err(why, 'That lobby is not accepting players.');
      hub.leaveCurrent(this, 'left');
      room.addSeat(this, this.profileData.name, this.profileData.char);
      room.sendRoom();
    }
  }

  const tick = setInterval(() => hub.tick(), T.TICK);
  const ping = setInterval(() => {
    const n = Date.now();
    for (const c of clients) {
      if (n - c.ws.lastPong > 45000) { c.ws.terminate(); continue; }
      c.ws.ping();
    }
  }, 15000);

  return {
    hub, server, cfg,
    listen() { return new Promise((r) => server.listen(cfg.port, () => { log(`Riftline server listening on :${server.address().port}`); r(server.address().port); })); },
    close() { clearInterval(tick); clearInterval(ping); for (const c of clients) c.ws.terminate(); return new Promise((r) => server.close(() => r())); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = createServer();
  s.listen();
  const stop = () => { s.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
