// Game data mirrored from the Riftline client (snippets/riftline-*.liquid).
// Weapon numbers are copied 1:1 from the client's WD / KA tables so online combat
// uses exactly the same damage, fire rate, magazine and reload values as single player.
import { readFileSync } from 'node:fs';

export const WEAPONS = {
  rifle:   { name: 'Raptor AR', price: 2900, mag: 30, res: 90, rate: 0.1,  auto: true,  dmg: 30,  hd: 110, rl: 2.1, spd: 6,   range: 240 },
  deagle:  { name: 'Deagle',    price: 0,    mag: 7,  res: 35, rate: 0.3,  auto: false, dmg: 55,  hd: 150, rl: 1.6, spd: 6.6, range: 240 },
  shotgun: { name: 'Bruiser',   price: 1600, mag: 6,  res: 24, rate: 0.85, auto: false, dmg: 20,  hd: 40,  rl: 2.4, spd: 6.2, range: 60, pel: 8 },
  sniper:  { name: 'Longbow',   price: 4700, mag: 5,  res: 20, rate: 1.3,  auto: false, dmg: 150, hd: 250, rl: 2.6, spd: 5.4, range: 240 },
};
// Karambit attacks (client KA table): animation length d, hit moment, damage and reach.
export const KNIFE = {
  slashA: { d: 0.55, dmg: 40, range: 2 },
  slashB: { d: 0.55, dmg: 40, range: 2 },
  heavy:  { d: 0.95, dmg: 85, range: 1.7 },
};
export const AMMO_PRICE = 200;
export const WEAPON_IDS = ['knife', 'deagle', 'rifle', 'shotgun', 'sniper'];

// Economy (online only). Round 1 uses the same starting credits as single player.
export const ECON = { start: 3900, roundBase: 1900, winBonus: 800, kill: 300, head: 100, max: 9000 };

export const MODES = {
  '1v1': { size: 1, label: '1v1 Duel' },
  '2v2': { size: 2, label: '2v2 Team Match' },
  '3v3': { size: 3, label: '3v3 Team Match' },
};

// Same armour rule the client uses when the player is damaged (hurt()).
export function applyArmor(hp, ar, d) {
  const abs = ar > 0 ? d * 0.5 : 0;
  ar = Math.max(0, ar - abs);
  hp -= Math.round(d - abs * 0.8);
  return { hp, ar };
}

// ---- Maps ---------------------------------------------------------------------------
const COLS = JSON.parse(readFileSync(new URL('./mapcols.json', import.meta.url), 'utf8'));

function sst(a, b, v) { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); }
function g2(x, z, cx, cz, r) { const dx = x - cx, dz = z - cz; return Math.exp(-(dx * dx + dz * dz) / (r * r)); }
function wadiZ(x) { return -58 + Math.sin(x * 0.05) * 6; }
function oasisHeight(x, z) {
  const d = Math.sqrt(x * x + z * z);
  let h = (Math.sin(x * 0.08) * Math.cos(z * 0.07) * 0.6 + Math.sin(x * 0.023 + z * 0.031) * 1.2) * 0.45;
  h += Math.sin(x * 0.13 + z * 0.05) * Math.cos(z * 0.11) * 0.7 * sst(38, 60, d);
  h -= 2.8 * Math.exp(-Math.pow(z - wadiZ(x), 2) / 32) * sst(35, 45, d);
  h += 5.2 * (1 - sst(9, 16, Math.hypot(x + 52, z - 26)));
  h += 7 * g2(x, z, 58, -12, 14) + 3 * g2(x, z, 64, 4, 10);
  h -= 1.8 * g2(x, z, 40, 40, 8);
  if (d > 84) h += Math.pow(d - 84, 1.5) * 0.3;
  return h;
}
function cyberHeight(x, z) { const d = Math.sqrt(x * x + z * z); return d > 72 ? (d - 72) * 2 : 0; }

// Spawns: team 0 (Alpha) and team 1 (Bravo), three spots each, facing each other.
// yaw 0 looks toward -Z in the client, PI looks toward +Z.
export const MAPS = {
  oasis: {
    name: 'Oasis Town', rad: 84, maxSpeed: 12, height: oasisHeight, cols: COLS.oasis,
    spawns: [[[-4, 40], [0, 41.5], [4, 40]], [[-4, -42], [0, -43.5], [4, -42]]], yaw: [0, Math.PI],
  },
  cyber: {
    name: 'Neon District', rad: 69, maxSpeed: 60, height: cyberHeight, cols: COLS.cyber,
    spawns: [[[-4, 54], [0, 55.5], [4, 54]], [[-4, -54], [0, -55.5], [4, -54]]], yaw: [0, Math.PI],
  },
};
export const MAP_IDS = Object.keys(MAPS);

// Player hitboxes (metres, relative to feet). Match the online character model, which is
// the raider model scaled to 0.91 so its eyes line up with the first-person camera (1.62 m).
export const HITBOX = {
  head: { y: 1.64, r: 0.17 },
  torso: { y0: 0.78, y1: 1.54, r: 0.29 },
  legs: { y0: 0, y1: 0.8, r: 0.23 },
};
export const EYE = 1.62;
