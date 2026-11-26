// Distance and direction between two places, calculated by code (never by the model).
// Straight-line only: the travel pack has no street network.

const R = 6371000; // mean Earth radius, metres
const rad = (d) => (d * Math.PI) / 180;
const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const WALK_M_PER_MIN = 80; // about 4.8 km/h

/** Great-circle distance in metres (haversine). */
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north (0..360). */
export function bearingDeg(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 8-point compass word for a bearing. */
export const compass = (deg) => DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export function distanceText(m) {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** One leg from a to b, ready for a data line: "430 m north-east, about 5 min on foot (straight line)". */
export function leg(a, b) {
  const meters = distanceM(a, b);
  if (meters < 40) return { meters, dir: null, minutes: 0, text: 'right here (under 50 m)' };
  const dir = compass(bearingDeg(a, b));
  const minutes = Math.max(1, Math.round(meters / WALK_M_PER_MIN));
  return { meters, dir, minutes, text: `${distanceText(meters)} ${dir}, about ${minutes} min on foot (straight line)` };
}
