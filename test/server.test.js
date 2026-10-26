import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fastTimers, startServer, TC, clients, sleep } from './helpers.js';
import { MAPS, WEAPONS, applyArmor } from '../src/data.js';
import { worldBlock, rayPlayer } from '../src/geom.js';

fastTimers();
let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.s.close(); });

const H = (x, z, map = 'oasis') => MAPS[map].height(x, z);

async function walk(c, from, to, map = 'oasis') {
  const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 1.8);
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + (to[0] - from[0]) * i / steps, z = from[1] + (to[1] - from[1]) * i / steps;
    c.send({ t: 'st', x, y: H(x, z, map), z, yaw: 0, pitch: 0, f: 1, a: 0 });
    await sleep(60);
  }
  return [to[0], H(to[0], to[1], map), to[1]];
}

function aim(o, p) {
  const v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]], l = Math.hypot(...v);
  const d = v.map((x) => x / l);
  return { d, yaw: Math.atan2(-d[0], -d[2]), pitch: Math.asin(d[1]) };
}

async function privateMatch(n, mode, map = 'oasis') {
  const cs = await clients(srv.url, n, mode + '-');
  const [host, ...rest] = cs;
  host.send({ t: 'create', mode, map, rounds: 3, rtime: 60 });
  const r = await host.roomWhere((m) => !!m.code);
  for (const c of rest) { c.send({ t: 'join', code: r.code }); await c.roomWhere((m) => m.code === r.code); }
  await host.roomWhere((m) => m.players.length === n);
  for (const c of rest) c.send({ t: 'ready', v: true });
  await host.roomWhere((m) => m.players.filter((p) => p.ready).length === n - 1);
  host.send({ t: 'start' });
  for (const c of cs) await c.roomWhere((m) => m.phase === 'loading');
  for (const c of cs) c.send({ t: 'loaded', map });
  const spawns = [];
  for (const c of cs) spawns.push(await c.wait((m) => m.t === 'spawn' && m.alive, 3000, true));
  for (const c of cs) await c.roomWhere((m) => m.phase === 'live', 3000);
  return { cs, code: r.code, spawns };
}

test('health endpoint responds', async () => {
  const r = await fetch(srv.http + '/health').then((x) => x.json());
  assert.equal(r.ok, true);
  assert.equal(r.game, 'riftline');
});

test('private lobby: create, join by code, capacity enforced, wrong code rejected', async () => {
  const [a, b, c] = await clients(srv.url, 3, 'cap');
  a.send({ t: 'create', mode: '1v1', map: 'oasis' });
  const r = await a.roomWhere((m) => !!m.code);
  assert.match(r.code, /^[A-Z2-9]{6}$/);
  assert.equal(r.priv, true);
  b.send({ t: 'join', code: r.code.toLowerCase() });
  await b.roomWhere((m) => m.code === r.code && m.players.length === 2);
  const ra = await a.roomWhere((m) => m.players.length === 2);
  assert.notEqual(ra.players[0].team, ra.players[1].team, 'auto balance puts players on opposite teams');
  c.send({ t: 'join', code: r.code });
  const e = await c.wait('err');
  assert.equal(e.code, 'full');
  c.send({ t: 'join', code: 'ZZZZZZ' });
  assert.equal((await c.wait('err')).code, 'not_found');
  [a, b, c].forEach((x) => x.close());
});

test('host-only actions are enforced on the server', async () => {
  const [a, b] = await clients(srv.url, 2, 'perm');
  a.send({ t: 'create', mode: '2v2', map: 'oasis' });
  const r = await a.roomWhere((m) => !!m.code);
  b.send({ t: 'join', code: r.code });
  const rb = await b.roomWhere((m) => m.players.length === 2);
  for (const msg of [{ t: 'set', map: 'cyber' }, { t: 'start' }, { t: 'kick', id: rb.host }, { t: 'close' }, { t: 'team', id: rb.host, team: 1 }]) {
    b.send(msg);
    assert.equal((await b.wait('err')).code, 'not_host', JSON.stringify(msg));
  }
  // host can change settings, start requires everyone ready
  a.send({ t: 'set', map: 'cyber', rounds: 7 });
  const r2 = await b.roomWhere((m) => m.map === 'cyber' && m.rounds === 7);
  assert.equal(r2.map, 'cyber');
  a.send({ t: 'start' });
  assert.equal((await a.wait('err')).code, 'not_ready');
  [a, b].forEach((x) => x.close());
});

test('public matchmaking never places strangers into a private lobby', async () => {
  const [host, q1, q2] = await clients(srv.url, 3, 'mm');
  host.send({ t: 'create', mode: '1v1', map: 'oasis' });
  const pr = await host.roomWhere((m) => !!m.code);
  q1.send({ t: 'q', mode: '1v1' });
  const r1 = await q1.roomWhere((m) => !!m.code);
  assert.notEqual(r1.code, pr.code);
  assert.equal(r1.priv, false);
  q2.send({ t: 'q', mode: '1v1' });
  const r2 = await q2.roomWhere((m) => !!m.code);
  assert.equal(r2.code, r1.code, 'second queued player joins the same public room');
  await q1.roomWhere((m) => m.phase === 'loading');
  const hr = await host.roomWhere(() => true);
  assert.equal(hr.players.length, 1, 'private lobby untouched');
  [host, q1, q2].forEach((x) => x.close());
});

test('2v2 and 3v3 public queues fill with balanced teams', async () => {
  for (const [mode, n] of [['2v2', 4], ['3v3', 6]]) {
    const cs = await clients(srv.url, n, mode);
    for (const c of cs) c.send({ t: 'q', mode });
    const r = await cs[0].roomWhere((m) => m.players.length === n && m.phase === 'loading');
    assert.equal(r.mode, mode);
    assert.equal(r.players.filter((p) => p.team === 0).length, n / 2);
    assert.equal(r.players.filter((p) => p.team === 1).length, n / 2);
    const extra = await new TC(srv.url, { name: 'late' }).connect();
    extra.send({ t: 'q', mode });
    const er = await extra.roomWhere(() => true);
    assert.notEqual(er.code, r.code, 'a full / started room is never joined');
    [...cs, extra].forEach((x) => x.close());
  }
});

test('team changes respect max team size; kick bans the player from that lobby', async () => {
  const [a, b, c] = await clients(srv.url, 3, 'team');
  a.send({ t: 'create', mode: '1v1', map: 'oasis' });
  const r = await a.roomWhere((m) => !!m.code);
  b.send({ t: 'join', code: r.code });
  const rb = await b.roomWhere((m) => m.players.length === 2);
  const other = 1 - rb.players.find((p) => p.id === rb.you).team;
  b.send({ t: 'team', team: other });
  assert.equal((await b.wait('err')).code, 'team_full');
  a.send({ t: 'kick', id: rb.you });
  assert.equal((await b.wait('left')).reason, 'kicked');
  b.send({ t: 'join', code: r.code });
  assert.equal((await b.wait('err')).code, 'kicked');
  [a, b, c].forEach((x) => x.close());
});

test('geometry: walls block bullets, open ground does not', () => {
  const map = MAPS.oasis;
  // a straight shot across open sand near the Alpha spawn
  const o = [0, H(0, 40) + 1.62, 40];
  assert.ok(worldBlock(map, o, [0, 0, -1], 5) >= 5 - 1e-6);
  // shoot into the first collision box from just outside it
  const c = map.cols[0];
  const cx = (c[0] + c[1]) / 2, cz = (c[2] + c[3]) / 2, y = Math.min(c[4] - 0.3, H(cx, cz) + 0.8);
  const start = [c[1] + 3, y, cz];
  const t = worldBlock(map, start, [-1, 0, 0], 20);
  assert.ok(t < 3.2 && t > 2.8, 'wall hit at ~3m, got ' + t);
  // hitbox: head vs body
  assert.equal(rayPlayer([0, 1.64, 5], [0, 0, -1], 0, 0, 0, 50).head, true);
  assert.equal(rayPlayer([0, 1.1, 5], [0, 0, -1], 0, 0, 0, 50).head, false);
  assert.equal(rayPlayer([0, 1.1, 5], [0, 0, 1], 0, 0, 0, 50), null);
});

test('combat: server validates fire rate, ammo, damage, kills and round scoring', async () => {
  const { cs: [a, b], spawns: [sa, sb] } = await privateMatch(2, '1v1');
  // walk B to 6 m in front of A (straight line, server validates speed)
  const f = [-Math.sin(sa.yaw), -Math.cos(sa.yaw)];
  const target = [sa.x + f[0] * 6, sa.z + f[1] * 6];
  const bp = await walk(b, [sb.x, sb.z], target);
  await sleep(150);
  const o = [sa.x, sa.y + 1.62, sa.z];
  const shot = (ct, pt = [bp[0], bp[1] + 1.2, bp[2]]) => { const q = aim(o, pt); a.send({ t: 'fire', w: 'deagle', o, d: [q.d], yaw: q.yaw, pitch: q.pitch, ct }); };
  shot(1000);
  const hit = await a.wait('hit', 3000, true);
  const hurt = await b.wait('hurt', 3000, true);
  const exp = applyArmor(100, 100, WEAPONS.deagle.dmg);
  assert.equal(hurt.hp, exp.hp, 'deagle body shot uses the game damage + armour rule');
  assert.equal(hit.dmg, 100 - exp.hp);
  assert.equal(hit.head, false);
  // too fast: rejected and ammo corrected (still 6 left)
  shot(1050);
  const fix = await a.wait('ammo', 3000, true);
  assert.equal(fix.a, 6);
  // headshot then finish
  shot(1400, [bp[0], bp[1] + 1.64, bp[2]]);
  const h2 = await a.wait((m) => m.t === 'hit' && m.head, 3000, true);
  assert.equal(h2.head, true);
  let ct = 1800;
  let kill = null;
  const kp = a.wait('kill', 4000, true);
  kill = a.msgs.find((m) => m.t === 'kill');
  while (!kill) { shot(ct); ct += 350; await sleep(80); kill = a.msgs.find((m) => m.t === 'kill'); if (ct > 5000) break; }
  const k = await kp;
  assert.equal(k.k, a.room.you);
  const rend = await a.wait('rend', 3000, true);
  assert.equal(rend.winner, a.me().team);
  assert.equal(rend.score[a.me().team], 1);
  // dead players cannot shoot; next round respawns both
  const sp = await b.wait((m) => m.t === 'spawn' && m.round === 2, 3000);
  assert.equal(sp.alive, true);
  assert.equal(sp.hp, 100);
  a.close(); b.close();
});

test('teleport / speed hack is corrected by the server', async () => {
  const { cs: [a, b], spawns: [sa] } = await privateMatch(2, '1v1');
  const far = [-sa.x, 0, -sa.z * 1.3];
  a.send({ t: 'st', x: far[0], y: 0, z: far[2], yaw: 0, pitch: 0, f: 1, a: 0 });
  const c = await a.wait('corr');
  assert.ok(Math.hypot(c.x - sa.x, c.z - sa.z) < 0.01, 'snapped back to the last valid position');
  a.close(); b.close();
});

test('reconnect within the grace window keeps the seat; duplicate tab replaces the old socket', async () => {
  const [a, b] = await clients(srv.url, 2, 'rc');
  a.send({ t: 'create', mode: '1v1', map: 'oasis' });
  const r = await a.roomWhere((m) => !!m.code);
  b.send({ t: 'join', code: r.code });
  const rb = await b.roomWhere((m) => m.players.length === 2);
  const bid = rb.you;
  b.close();
  await a.roomWhere((m) => m.players.find((p) => p.id === bid && !p.conn));
  const b2 = await new TC(srv.url, { name: 'rc2', sk: b.sk }).connect();
  const rb2 = await b2.roomWhere((m) => m.code === r.code);
  assert.equal(rb2.you, bid, 'same seat restored');
  await a.roomWhere((m) => m.players.find((p) => p.id === bid && p.conn));
  // the same session opened again replaces the older connection
  const b3 = await new TC(srv.url, { name: 'rc3', sk: b.sk }).connect();
  await b3.roomWhere((m) => m.code === r.code);
  await b2.wait((m) => m.t === 'err' && m.code === 'replaced');
  a.close(); b3.close();
});

test('host leaving hands the lobby to another player; empty lobby expires', async () => {
  const [a, b] = await clients(srv.url, 2, 'hh');
  a.send({ t: 'create', mode: '1v1', map: 'oasis' });
  const r = await a.roomWhere((m) => !!m.code);
  b.send({ t: 'join', code: r.code });
  const rb = await b.roomWhere((m) => m.players.length === 2);
  a.send({ t: 'leave' });
  const after = await b.roomWhere((m) => m.players.length === 1);
  assert.equal(after.host, rb.you);
  b.close();
  await sleep(4500);
  const c = await new TC(srv.url, { name: 'late' }).connect();
  c.send({ t: 'join', code: r.code });
  assert.equal((await c.wait('err')).code, 'not_found', 'expired lobby is gone');
  c.close();
});

test('malformed and flood messages do not crash the server', async () => {
  const c = await new TC(srv.url, { name: 'fuzz' }).connect();
  c.ws.send('not json');
  c.ws.send('{"t":5}');
  c.send({ t: 'fire', w: 'rifle', o: 'x', d: 7 });
  c.send({ t: 'join', code: { a: 1 } });
  c.send({ t: 'set', mode: '9v9' });
  c.send({ t: 'create', mode: 'nope' });
  assert.equal((await c.wait((m) => m.t === 'err' && m.code === 'bad_mode')).code, 'bad_mode');
  for (let i = 0; i < 400; i++) c.send({ t: 'ping', c: i });
  await sleep(300);
  const ok = await fetch(srv.http + '/health').then((x) => x.json());
  assert.equal(ok.ok, true);
  c.close();
});

test('forfeit: a team that leaves mid-match loses', async () => {
  const { cs: [a, b] } = await privateMatch(2, '1v1');
  b.send({ t: 'leave' });
  const res = await a.wait('results', 3000);
  assert.equal(res.reason, 'forfeit');
  assert.equal(res.winner, a.me().team);
  a.close(); b.close();
});
