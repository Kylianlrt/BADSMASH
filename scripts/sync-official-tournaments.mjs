/**
 * Synchronise les tournois publiés par BadNet vers Firebase RTDB, sans API.
 * La liste publique BadNet sert à découvrir les évènements. Chaque fiche est
 * relue et n'est importée que si elle affiche un numéro Poona, la référence
 * fédérale affichée par BadNet.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const BADNET_HOME = 'https://badnet.fr/';
const MAX_EVENTS = Math.min(Math.max(Number(process.env.BADNET_MAX_EVENTS || 40), 1), 100);
const REQUEST_DELAY_MS = 700;
const dryRun = process.env.SYNC_DRY_RUN === '1';

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!dryRun && (!serviceAccount || !process.env.FIREBASE_DATABASE_URL)) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT et FIREBASE_DATABASE_URL sont requis.');
}

if (!dryRun) {
  initializeApp({ credential: cert(JSON.parse(serviceAccount)), databaseURL: process.env.FIREBASE_DATABASE_URL });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function decodeHtml(value) {
  return String(value)
    .replaceAll('&quot;', '"').replaceAll('&#039;', "'").replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function frenchDates(label) {
  const months = { janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10, décembre: 11, decembre: 11 };
  const normalized = String(label || '').toLowerCase();
  const monthName = Object.keys(months).find(month => new RegExp(`\\b${month}\\b`).test(normalized));
  const year = normalized.match(/\\b(20\\d{2})\\b/)?.[1];
  const days = [...normalized.matchAll(/\\b([0-3]?\\d)\\b/g)].map(match => Number(match[1])).filter(day => day >= 1 && day <= 31);
  if (!monthName || !year || !days.length) return { dateDebut: '', dateFin: '' };
  const iso = day => new Date(Date.UTC(Number(year), months[monthName], day)).toISOString().slice(0, 10);
  return { dateDebut: iso(days[0]), dateFin: iso(days.at(-1)) };
}

async function fetchHtml(url) {
  const response = await fetch(url, { 
    headers: { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
    } 
  });
  if (!response.ok) throw new Error(`BadNet a répondu HTTP ${response.status} pour ${url}`);
  return response.text();
}

function discoverEvents(html) {
  // Recherche l'attribut data-markers indépendamment de l'ordre exact des classes HTML
  const markerMatch = html.match(/data-markers="([^"]*)"/i) || html.match(/data-markers='([^']*)'/i);
  if (!markerMatch) throw new Error('La liste publique BadNet n’a pas été trouvée.');
  
  let rawJson = decodeHtml(markerMatch[1]);

  try {
    return JSON.parse(rawJson)
      .filter(event => !/\bamical\b/i.test(String(event.name || '')))
      .slice(0, MAX_EVENTS);
  } catch (e) {
    throw new Error('Erreur lors du parsing JSON des tournois BadNet : ' + e.message);
  }
}

function poonaNumber(html) {
  const text = decodeHtml(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  return text.match(/N[°ºo]?\s*Poona\s*(\d+)/i)?.[1] || null;
}

async function verifyAndNormalise(event) {
  const sourceEventId = String(event.id || '');
  if (!sourceEventId) return null;
  const sourceUrl = `https://badnet.fr/tournoi/public?eventid=${encodeURIComponent(sourceEventId)}`;
  const poonaId = poonaNumber(await fetchHtml(sourceUrl));
  if (!poonaId) return null;
  const { dateDebut, dateFin } = frenchDates(event.date);
  return {
    officiel: true, source: 'badnet', sourceEventId, sourceUrl,
    ebadUrl: `https://badnet.fr/tournoi/public/ebad?eventid=${encodeURIComponent(sourceEventId)}`,
    poonaId, nom: String(event.name || event.title || 'Tournoi BadNet'),
    lieu: String(event.place || ''), date: String(event.date || ''), dateDebut, dateFin,
    categories: String(event.catages || '').trim(), classements: String(event.clt || '').trim(),
    updatedAt: new Date().toISOString()
  };
}

const candidates = discoverEvents(await fetchHtml(BADNET_HOME));
const imported = [];

// Une seule requête à la fois, espacée : pas de charge brutale sur BadNet.
for (const event of candidates) {
  const tournoi = await verifyAndNormalise(event);
  if (tournoi) imported.push(tournoi);
  await wait(REQUEST_DELAY_MS);
}

if (!imported.length) throw new Error('Aucun tournoi doté d’un numéro Poona n’a été trouvé : la base est inchangée.');

const updates = {};
for (const tournoi of imported) updates[`badnet_${tournoi.sourceEventId}`] = tournoi;
if (!dryRun) await getDatabase().ref('tournoisOfficiels').update(updates);
console.log(`${imported.length}/${candidates.length} tournoi(s) officiels BadNet synchronisé(s).`);
