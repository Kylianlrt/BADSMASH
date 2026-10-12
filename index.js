// BADSMASH — extraction de données depuis une photo / un PDF avec Claude.
// La clé API reste côté serveur (jamais dans le navigateur).
//
// Déploiement :
//   firebase functions:secrets:set ANTHROPIC_API_KEY
//   firebase functions:secrets:set IMPORT_PASSWORD     (le mot de passe admin)
//   firebase deploy --only functions
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const IMPORT_PASSWORD = defineSecret('IMPORT_PASSWORD');

const MODEL = 'claude-sonnet-5-5';

const TOOL = {
  name: 'enregistrer_donnees',
  description: "Enregistre les données de badminton lues dans le document. Ne renseigner que ce qui est réellement lisible ; laisser vide sinon.",
  input_schema: {
    type: 'object',
    properties: {
      clubs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nom: { type: 'string' },
            ville: { type: 'string' },
            departement: { type: 'string', description: 'Code du département (ex: 12, 2A, 974). Vide si inconnu.' }
          },
          required: ['nom']
        }
      },
      joueurs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            prenom: { type: 'string' },
            nom: { type: 'string' },
            genre: { type: 'string', enum: ['H', 'F', ''] },
            club: { type: 'string', description: 'Nom du club tel qu\'écrit' },
            pays: { type: 'string' },
            ptsSimple: { type: 'number' },
            ptsDouble: { type: 'number' },
            ptsMixte: { type: 'number' }
          },
          required: ['nom']
        }
      },
      tournoi: {
        type: 'object',
        properties: {
          nom: { type: 'string' },
          date: { type: 'string', description: 'AAAA-MM-JJ' },
          dateFin: { type: 'string', description: 'AAAA-MM-JJ' },
          lieu: { type: 'string' }
        }
      },
      matchs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tableau: { type: 'string', enum: ['simple', 'double', 'mixte'] },
            date: { type: 'string', description: 'AAAA-MM-JJ' },
            camp1: { type: 'array', items: { type: 'string' }, description: '1 nom (simple) ou 2 noms (double/mixte), "Prénom Nom"' },
            camp2: { type: 'array', items: { type: 'string' } },
            sets: { type: 'array', items: { type: 'string' }, description: 'Scores du point de vue camp1-camp2, ex: "21-15". 2 ou 3 sets.' },
            vainqueur: { type: 'integer', enum: [0, 1, 2], description: '1 = camp1, 2 = camp2, 0 = inconnu' }
          },
          required: ['camp1', 'camp2']
        }
      }
    }
  }
};

const MODES = {
  auto: "Détecte ce que contient le document (clubs, joueurs, tournoi, résultats de matchs) et remplis les champs correspondants.",
  clubs: "Extrais uniquement la liste des CLUBS.",
  joueurs: "Extrais uniquement la liste des JOUEURS (avec leur club si indiqué).",
  tournoi: "Extrais les informations du TOURNOI (nom, dates, lieu) et, si présents, les joueurs, clubs et résultats.",
  matchs: "Extrais uniquement les MATCHS / RÉSULTATS (joueurs de chaque camp, scores set par set, vainqueur)."
};

exports.extraire = onRequest(
  { secrets: [ANTHROPIC_API_KEY, IMPORT_PASSWORD], cors: true, region: 'europe-west1', memory: '512MiB', timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST uniquement' });
    if (req.get('x-import-password') !== IMPORT_PASSWORD.value()) return res.status(401).json({ error: 'Mot de passe incorrect' });

    const { mode = 'auto', files = [] } = req.body || {};
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'Aucun fichier' });
    if (files.length > 6) return res.status(400).json({ error: '6 fichiers maximum' });

    const content = [];
    for (const f of files) {
      if (!f || !f.data || !f.type) continue;
      if (f.type === 'application/pdf') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } });
      } else if (/^image\/(jpeg|png|webp|gif)$/.test(f.type)) {
        content.push({ type: 'image', source: { type: 'base64', media_type: f.type, data: f.data } });
      }
    }
    if (!content.length) return res.status(400).json({ error: 'Format non supporté (photo ou PDF)' });

    content.push({
      type: 'text',
      text: `${MODES[mode] || MODES.auto}\n\nRègles : ne rien inventer ; ne pas deviner un score illisible (le laisser de côté) ; écrire les noms "Prénom Nom" avec la casse normale ; les scores sont dans l'ordre camp1-camp2. Appelle l'outil enregistrer_donnees.`
    });

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY.value(),
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 8000,
          tools: [TOOL],
          tool_choice: { type: 'tool', name: 'enregistrer_donnees' },
          messages: [{ role: 'user', content }]
        })
      });
      const j = await r.json();
      if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'Erreur API' });
      const tu = (j.content || []).find(b => b.type === 'tool_use');
      return res.json({ data: tu ? tu.input : {} });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);