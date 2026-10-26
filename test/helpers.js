import crypto from 'node:crypto';
import { createServer } from '../src/server.js';
import { T } from '../src/game.js';

// Fast timings for tests
export function fastTimers() {
  Object.assign(T, { BUY: 300, BUY_LIVE: 15000, ROUND_END: 300, RESULTS: 400, LOAD_MAX: 3000, GRACE_LOBBY: 1500, GRACE_QUEUE: 800, GRACE_MATCH: 1500, HOST_HANDOFF: 700, EMPTY_PRIVATE: 2000, FORFEIT: 1200 });
}

export async function startServer(extra = {}) {
  const s = createServer({ port: 0, quiet: true, ...extra });
  const port = await s.listen();
  return { s, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TC {
  constructor(url, { name = 'Tester', char = 0, sk } = {}) {
    this.url = url; this.name = name; this.char = char;
    this.sk = sk || crypto.randomBytes(16).toString('hex');
    this.msgs = []; this.waiters = []; this.room = null; this.closed = false;
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'room') this.room = m;
      if (m.t === 'snap') { this.lastSnap = m; return; }
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(m); }
    };
    this.ws.onclose = () => { this.closed = true; };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.send({ t: 'hello', v: 1, sk: this.sk, name: this.name, char: this.char });
    await this.wait((m) => m.t === 'welcome');
    return this;
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  wait(pred, ms = 3000, fromStart = false) {
    if (typeof pred === 'string') { const t = pred; pred = (m) => m.t === t; }
    if (fromStart) { const f = this.msgs.find(pred); if (f) return Promise.resolve(f); }
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i > -1) { this.waiters.splice(i, 1); rej(new Error(`${this.name}: timeout waiting (${pred})`)); } }, ms);
    });
  }
  roomWhere(pred, ms = 3000) {
    if (this.room && pred(this.room)) return Promise.resolve(this.room);
    return this.wait((m) => m.t === 'room' && pred(m), ms);
  }
  close() { try { this.ws.close(); } catch {} }
  me() { return this.room?.players.find((p) => p.id === this.room.you); }
}

export async function clients(url, n, prefix = 'P') {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await new TC(url, { name: `${prefix}${i + 1}`, char: i % 6 }).connect());
  return out;
}
