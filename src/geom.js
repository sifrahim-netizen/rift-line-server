// Ray tests used for server-side hit validation.
import { HITBOX } from './data.js';

// Ray vs axis-aligned box. Returns entry distance or Infinity.
export function rayBox(o, d, x0, x1, y0, y1, z0, z1, maxT) {
  let tmin = 0, tmax = maxT;
  const lo = [x0, y0, z0], hi = [x1, y1, z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo[i] || o[i] > hi[i]) return Infinity; continue; }
    let t1 = (lo[i] - o[i]) / d[i], t2 = (hi[i] - o[i]) / d[i];
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

export function raySphere(o, d, cx, cy, cz, r) {
  const ox = o[0] - cx, oy = o[1] - cy, oz = o[2] - cz;
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  return -b + s >= 0 ? 0 : Infinity;
}

// Ray vs vertical cylinder (axis along Y) between y0 and y1.
export function rayCyl(o, d, cx, cz, y0, y1, r) {
  const ox = o[0] - cx, oz = o[2] - cz;
  const a = d[0] * d[0] + d[2] * d[2];
  let best = Infinity;
  if (a > 1e-9) {
    const b = ox * d[0] + oz * d[2];
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / a, (-b + s) / a]) {
        if (t < 0) continue;
        const y = o[1] + d[1] * t;
        if (y >= y0 && y <= y1) { best = Math.min(best, t); break; }
      }
    }
  }
  // caps
  if (Math.abs(d[1]) > 1e-9) {
    for (const yc of [y0, y1]) {
      const t = (yc - o[1]) / d[1];
      if (t < 0 || t >= best) continue;
      const x = ox + d[0] * t, z = oz + d[2] * t;
      if (x * x + z * z <= r * r) best = t;
    }
  }
  return best;
}

// Returns { t, head } for a player standing with feet at (x, y, z), or null.
export function rayPlayer(o, d, x, y, z, maxT, inflate = 0.03) {
  const H = HITBOX;
  const th = raySphere(o, d, x, y + H.head.y, z, H.head.r + inflate);
  const tt = rayCyl(o, d, x, z, y + H.torso.y0, y + H.torso.y1, H.torso.r + inflate);
  const tl = rayCyl(o, d, x, z, y + H.legs.y0, y + H.legs.y1, H.legs.r + inflate);
  const tb = Math.min(tt, tl);
  if (th <= maxT && th <= tb + 0.02) return { t: th, head: true };
  if (tb <= maxT) return { t: tb, head: false };
  return null;
}

// First blocking distance along the ray from map boxes and terrain, or maxT.
export function worldBlock(map, o, d, maxT) {
  let best = maxT;
  const cols = map.cols;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    const t = rayBox(o, d, c[0], c[1], -60, c[4], c[2], c[3], best);
    if (t < best) best = t;
  }
  // terrain: march along the ray, starting a little in front of the muzzle
  const step = 0.6;
  for (let t = 0.8; t < best; t += step) {
    const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
    if (y < map.height(x, z) - 0.12) { best = Math.max(0, t - step * 0.5); break; }
  }
  return best;
}

export function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 1e-6)) return null;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// Forward vector for the client's camera convention (rotation order YXZ).
export function forward(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
