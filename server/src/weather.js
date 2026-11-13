// Meteo dal servizio gratuito Open-Meteo (nessuna chiave). Si attiva solo quando l'utente ne parla.
// La città arriva dalla frase ("che tempo fa a Klagenfurt"); se manca si usa l'ultima chiesta
// oppure il luogo "casa" salvato.

import { kvGet, kvSet } from './db.js';
import { listPlaces } from './places.js';

export const WEATHER_WORDS = /(meteo|che tempo|tempo fa|tempo far|previsioni|piov|pioggia|nevic|neve\b|temporal|temperatur|quanti gradi|ombrello|vento|grandin|nuvol|soleggiat|umidit)/i;

const PREP = new Set(['a', 'ad', 'per', 'su', 'in', 'di', 'da']);
const STOP_AFTER = new Set('e ed che com come è sara sarà fa farà fara c\'è ci il lo la oggi tempo meteo previsioni piove nevica'.split(' '));
const NOT_CITY = new Set('oggi domani dopodomani stasera stanotte stamattina casa questo questa quella settimana weekend fine mattina sera pomeriggio notte ora adesso qui lì là fuori giorno giorni ore'.split(' '));

/** "che tempo fa a Klagenfurt domani" -> "Klagenfurt". Ritorna '' se non trova un nome di luogo. */
export function cityFrom(text) {
  const words = String(text || '').replace(/[?!.,;:]+/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length - 1; i++) {
    if (!PREP.has(words[i].toLowerCase())) continue;
    const out = [];
    for (const w of words.slice(i + 1, i + 6)) {
      const low = w.toLowerCase();
      if (NOT_CITY.has(low) || STOP_AFTER.has(low)) break;
      out.push(w);
    }
    if (out.length && out[0].length >= 3) return out.join(' ');
  }
  return '';
}

const WMO = {
  0: 'sereno', 1: 'quasi sereno', 2: 'poco nuvoloso', 3: 'coperto', 45: 'nebbia', 48: 'nebbia con brina',
  51: 'pioviggine leggera', 53: 'pioviggine', 55: 'pioviggine fitta', 56: 'pioviggine gelata', 57: 'pioviggine gelata',
  61: 'pioggia leggera', 63: 'pioggia', 65: 'pioggia forte', 66: 'pioggia gelata', 67: 'pioggia gelata forte',
  71: 'neve leggera', 73: 'neve', 75: 'neve forte', 77: 'nevischio', 80: 'rovesci leggeri', 81: 'rovesci', 82: 'rovesci violenti',
  85: 'rovesci di neve', 86: 'forti rovesci di neve', 95: 'temporale', 96: 'temporale con grandine', 99: 'temporale con grandine forte',
};
export const describe = (code) => WMO[code] ?? 'variabile';

async function getJson(fetchFn, url) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 5000) : null;
  try {
    const r = await fetchFn(url, ctl ? { signal: ctl.signal } : undefined);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}

async function geocode(fetchFn, name) {
  const j = await getJson(fetchFn, `https://geocoding-api.open-meteo.com/v1/search?count=1&language=it&format=json&name=${encodeURIComponent(name)}`);
  const r = j?.results?.[0];
  return r ? { name: r.name + (r.country ? `, ${r.country}` : ''), lat: r.latitude, lon: r.longitude } : null;
}

/** Dove guardare il meteo: città nella frase, poi l'ultima chiesta, poi "casa". */
async function whereFor(db, fetchFn, text) {
  const asked = cityFrom(text);
  if (asked) {
    const g = await geocode(fetchFn, asked) || (asked.includes(' ') ? await geocode(fetchFn, asked.split(' ')[0]) : null);
    if (g) { kvSet(db, 'weatherCity', g); return g; }
  }
  const last = kvGet(db, 'weatherCity', null);
  if (last) return last;
  const places = listPlaces(db);
  const home = places.find(p => p.key === 'casa') || places[0];
  return home ? { name: home.name, lat: home.lat, lon: home.lon } : null;
}

/** Blocco di contesto con il meteo attuale e dei prossimi 3 giorni, oppure una nota se non è disponibile. */
export async function weatherContext(db, fetchFn, text) {
  const where = await whereFor(db, fetchFn, text);
  if (!where) return 'METEO: non so ancora dove si trova l\'utente. Chiedigli la città (poi la ricorderò).';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${where.lat}&longitude=${where.lon}&timezone=auto&forecast_days=3`
    + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,relative_humidity_2m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max';
  const j = await getJson(fetchFn, url);
  if (!j?.current) return `METEO: il servizio meteo non risponde in questo momento (${where.name}). Dillo all'utente.`;
  const c = j.current, d = j.daily || {};
  const r1 = (n) => Math.round(Number(n));
  const days = (d.time || []).map((t, i) => `${['oggi', 'domani', 'dopodomani'][i] || t}: ${describe(d.weather_code?.[i])}, ${r1(d.temperature_2m_min?.[i])}–${r1(d.temperature_2m_max?.[i])}°C, pioggia ${r1(d.precipitation_probability_max?.[i] ?? 0)}%`);
  return `METEO REALE ADESSO A ${where.name.toUpperCase()} (dati Open-Meteo, usali per rispondere): ${describe(c.weather_code)}, ${r1(c.temperature_2m)}°C (percepiti ${r1(c.apparent_temperature)}°C), vento ${r1(c.wind_speed_10m)} km/h, umidità ${r1(c.relative_humidity_2m)}%.\nPREVISIONI: ${days.join('; ')}.`;
}
