// The sky over a photo: where the sun was when it was taken, which of Mapbox
// Standard's light presets that looks like, and how its weather is drawn.
//
// Pure functions, no map: globe.js applies what these return.

const RAD = Math.PI / 180;

/** Seconds east of UTC at the photo. Open-Meteo knows the real time zone,
 *  daylight saving included; without it, the longitude's solar zone is close
 *  enough to tell day from night. */
export function utcOffset(lon, weather) {
  if (weather && Number.isFinite(weather.utc_offset)) return weather.utc_offset;
  return Math.round(lon / 15) * 3600;
}

/** Sun elevation in degrees and whether it is still rising (morning).
 *  `wallTs` is the camera's wall clock stored as if UTC, as the whole app does
 *  (see backend/photometa.wall_ts). Low-precision solar ephemeris - good to a
 *  fraction of a degree, which is far finer than four light presets need. */
export function sun(wallTs, lat, lon, offsetS) {
  const utcMs = (wallTs - offsetS) * 1000;
  const d = utcMs / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15;
  let ha = (((gmst + lon - ra) % 360) + 540) % 360 - 180;
  const elev = Math.asin(Math.sin(lat * RAD) * Math.sin(dec)
    + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha * RAD)) / RAD;
  return { elevation: elev, morning: ha < 0 };
}

/** Which light preset a moment looks like. The golden hour and civil twilight
 *  are dawn or dusk; past nautical twilight is night. */
export function lightFor(wallTs, lat, lon, weather) {
  if (wallTs == null) return null;
  const s = sun(wallTs, lat, lon, utcOffset(lon, weather));
  if (s.elevation > 8) return 'day';
  if (s.elevation < -5) return 'night';
  return s.morning ? 'dawn' : 'dusk';
}

const ICONS = { clear: '☀', cloudy: '⛅', overcast: '☁', fog: '🌫', rain: '🌧', snow: '❄', storm: '⛈' };

export function icon(w, night) {
  if (!w) return '';
  if (night && w.sky === 'clear') return '☾';
  return ICONS[w.sky] || '';
}

/** "🌧 Light rain · 14°C · 1.2 mm · wind 18 km/h" */
export function describe(w, { short = false, night = false } = {}) {
  if (!w) return '';
  const parts = [`${icon(w, night)} ${w.label}`.trim()];
  if (w.temp != null) parts.push(`${Math.round(w.temp)}°C`);
  if (short) return parts.join(' · ');
  if (w.precip) parts.push(`${w.precip} mm`);
  if (w.cloud != null && w.sky !== 'clear') parts.push(`${w.cloud}% cloud`);
  if (w.wind != null) parts.push(`wind ${Math.round(w.wind)} km/h`);
  if (w.humidity != null) parts.push(`${w.humidity}% humidity`);
  return parts.join(' · ');
}

// Particles only close in: from orbit, rain over a whole continent reads as
// static on the screen.
const fadeIn = (peak) => ['interpolate', ['linear'], ['zoom'], 10, 0, 13, peak];

/** What Mapbox GL draws for a weather: rain or snow particles, and fog that
 *  closes in for fog and thickens under cloud. Null fields mean "clear it". */
export function effects(w) {
  if (!w) return { rain: null, snow: null, fog: null, mood: null };
  const mm = Math.max(w.precip || 0, w.rain || 0);
  const out = { rain: null, snow: null, fog: null, mood: null };
  if (w.sky === 'rain' || w.sky === 'storm') {
    const strength = Math.min(1, 0.35 + mm / 4);
    out.rain = {
      density: fadeIn(Math.min(0.9, 0.3 + mm / 5)),
      intensity: strength,
      color: w.sky === 'storm' ? '#7a8290' : '#a8adbc',
      opacity: 0.7,
      vignette: fadeIn(w.sky === 'storm' ? 0.9 : 0.6),
      'vignette-color': '#464646',
      direction: [0, 80],
      'droplet-size': [2.6, 18.2],
      'distortion-strength': 0.7,
      'center-thinning': 0,
    };
  }
  if (w.sky === 'snow') {
    out.snow = {
      density: fadeIn(Math.min(0.95, 0.45 + (w.snow || 0) / 2)),
      intensity: 1,
      'center-thinning': 0.1,
      direction: [0, 50],
      opacity: 1,
      color: '#ffffff',
      'flake-size': 0.71,
      vignette: fadeIn(0.3),
      'vignette-color': '#ffffff',
    };
  }
  const grey = { color: '#bfc4cc', 'high-color': '#5a6370', 'horizon-blend': 0.3 };
  if (w.sky === 'fog') out.fog = { ...grey, range: [-0.5, 1.2], 'horizon-blend': 0.5 };
  else if (w.sky === 'storm') out.fog = { color: '#6b717c', 'high-color': '#2e333b', 'horizon-blend': 0.4, range: [0, 4] };
  else if (w.sky === 'overcast' || w.sky === 'rain' || w.sky === 'snow') out.fog = { ...grey, range: [0.4, 6] };
  // Grey days look washed out, so the map does too, unless the person chose a
  // theme of their own.
  if (['overcast', 'fog', 'rain', 'snow', 'storm'].includes(w.sky)) out.mood = 'faded';
  return out;
}
