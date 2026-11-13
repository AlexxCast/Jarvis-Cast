// Luoghi salvati (casa, palestra, lavoro...) per i promemoria "quando arrivo/esco".
// Le coordinate arrivano dal telefono; è il telefono ad accorgersi dell'arrivo e ad avvisare il server.

import { kvGet, kvSet } from './db.js';

export const placeKey = (name) => String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/^(a |al |alla |allo |in |da |dal |dalla |la |il |lo |l')/, '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40);

export function listPlaces(db) {
  const all = kvGet(db, 'places', {});
  return Object.entries(all).map(([key, p]) => ({ key, name: p.name, lat: p.lat, lon: p.lon, radius: p.radius }));
}

export function savePlace(db, { name, lat, lon, radius }) {
  const key = placeKey(name);
  const la = Number(lat), lo = Number(lon);
  if (!key || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  const all = kvGet(db, 'places', {});
  if (!all[key] && Object.keys(all).length >= 20) return null;
  const r = Math.round(Math.min(1000, Math.max(80, Number(radius) || 150)));
  all[key] = { name: String(name).trim().slice(0, 40), lat: la, lon: lo, radius: r };
  kvSet(db, 'places', all);
  return key;
}

export function deletePlace(db, key) {
  const all = kvGet(db, 'places', {});
  delete all[placeKey(key)];
  kvSet(db, 'places', all);
}

export function placesContext(db) {
  const list = listPlaces(db);
  return list.length ? 'LUOGHI SALVATI: ' + list.map(p => p.name).join(', ') : 'LUOGHI SALVATI: nessuno (per salvarne uno serve save_place mentre l\'utente si trova lì)';
}
