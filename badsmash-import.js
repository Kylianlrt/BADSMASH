/* BADSMASH — Import automatique (photo / PDF) : clubs, joueurs, tournois, matchs.
   Ajoute l'onglet « Import » à admin.html. Lit le document via la fonction Cloud « extraire »,
   affiche un APERÇU modifiable, puis enregistre dans Firebase uniquement ce qui est coché. */
(function () {
    'use strict';
    // Lecture gratuite via l'API Gemini de Google (clé gratuite, sans carte bancaire).
    // Plusieurs noms de modèles sont essayés dans l'ordre : Google en renomme / retire régulièrement.
    const MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash'];
    const KEY_STORE = 'badsmash_gemini_key';
    const MAX_BYTES = 14 * 1024 * 1024;

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const today = () => new Date().toISOString().slice(0, 10);
    const $ = (s, r) => (r || document).querySelector(s);

    let files = [];           // [{name, type, data(base64), size}]
    let st = null;            // état de l'aperçu

    /* ---------- Accès aux données de l'admin ---------- */
    const API = () => window.BSImport;
    const caches = () => API().caches();

    function findPlayer(name) {
        const n = norm(name); if (!n) return null;
        const J = caches().joueurs;
        return Object.keys(J).find(id => {
            const j = J[id];
            return norm(j.prenom + ' ' + j.nom) === n || norm(j.nom + ' ' + j.prenom) === n;
        }) || null;
    }
    function findClub(name, ville) {
        const n = norm(name); if (!n) return null;
        const v = norm(ville), C = caches().clubs;
        return Object.keys(C).find(id => norm(C[id].nom) === n && (!v || !norm(C[id].ville) || norm(C[id].ville) === v)) || null;
    }
    /* ---- Détection des matchs déjà enregistrés ---- */
    const parts = s => String(s || '').split('/').map(x => x.trim()).filter(Boolean);
    const setsKey = arr => arr.map(x => { const p = BS.parseSet(x); return p && p !== 'bad' ? p.a + '-' + p.b : ''; }).filter(Boolean).join('/');
    const setsSwap = arr => arr.map(x => { const p = BS.parseSet(x); return p && p !== 'bad' ? p.b + '-' + p.a : ''; }).filter(Boolean).join('/');
    const sameTeam = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
    function findDupMatch(m) {
        const i1 = parts(m.camp1).map(findPlayer), i2 = parts(m.camp2).map(findPlayer);
        if (!i1.length || !i2.length || [...i1, ...i2].some(x => !x)) return null; // joueur inconnu => forcément nouveau
        const sets = BS.splitScore(m.sets), a = setsKey(sets), b = setsSwap(sets), M = caches().matchs || {};
        return Object.keys(M).find(id => {
            const x = M[id], t1 = x.equipe1 || [x.j1], t2 = x.equipe2 || [x.j2];
            if (!t1[0] || !t2[0]) return false;
            if (x.date && m.date && x.date !== m.date) return false;
            const xs = setsKey([x.set1, x.set2, x.set3]);
            return (sameTeam(t1, i1) && sameTeam(t2, i2) && xs === a) || (sameTeam(t1, i2) && sameTeam(t2, i1) && xs === b);
        }) || null;
    }
    const matchSig = m => [m.tableau, m.date, [norm(m.camp1), norm(m.camp2)].sort().join('|')].join('#');
    function findTournoi(name) {
        const n = norm(name); if (!n) return null;
        const T = caches().tournois;
        return Object.keys(T).find(id => norm(T[id].nom) === n) || null;
    }
    function splitName(full) {
        const t = String(full || '').trim().split(/\s+/);
        if (t.length < 2) return { prenom: '', nom: t[0] || '' };
        // "DUPONT Jean" (nom en majuscules en premier) -> nom/prénom inversés
        if (t[0] === t[0].toUpperCase() && t[0].length > 1 && t[t.length - 1] !== t[t.length - 1].toUpperCase()) {
            return { nom: t[0], prenom: t.slice(1).join(' ') };
        }
        return { prenom: t[0], nom: t.slice(1).join(' ') };
    }
    function regionOfDept(code) {
        const R = API().regions;
        for (const reg of Object.keys(R)) {
            const hit = R[reg].find(d => d[0] === String(code).toUpperCase());
            if (hit) return { region: reg, departement: hit[0], departementNom: hit[1] };
        }
        return null;
    }

    /* ---------- Fichiers ---------- */
    function readFile(file) {
        return new Promise((resolve, reject) => {
            if (file.type === 'application/pdf') {
                const fr = new FileReader();
                fr.onload = () => resolve({ name: file.name, type: file.type, data: String(fr.result).split(',')[1] });
                fr.onerror = reject; fr.readAsDataURL(file);
            } else if (file.type.startsWith('image/')) {
                const img = new Image(), url = URL.createObjectURL(file);
                img.onload = () => {
                    const max = 1800, k = Math.min(1, max / Math.max(img.width, img.height));
                    const c = document.createElement('canvas');
                    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
                    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                    URL.revokeObjectURL(url);
                    resolve({ name: file.name, type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
                };
                img.onerror = () => reject(new Error('Image illisible : ' + file.name));
                img.src = url;
            } else reject(new Error('Format non supporté : ' + file.name + ' (photo ou PDF uniquement)'));
        });
    }
    async function addFiles(list) {
        const msg = $('#imp-msg');
        for (const f of list) {
            try { files.push(await readFile(f)); } catch (e) { msg.textContent = '⚠️ ' + e.message; }
        }
        renderFiles();
    }
    function renderFiles() {
        $('#imp-files').innerHTML = files.map((f, i) =>
            `<span class="imp-chip">${f.type === 'application/pdf' ? '📄' : '🖼️'} ${esc(f.name)} <button type="button" data-rm="${i}" title="Retirer">✕</button></span>`).join('');
        $('#imp-go').disabled = !files.length;
    }

    /* ---------- Analyse (Gemini, gratuit) ---------- */
    const MODE_TXT = {
        auto: "Détecte ce que contient le document (clubs, joueurs, tournoi, résultats de matchs) et remplis les champs correspondants.",
        clubs: "Extrais uniquement la liste des CLUBS.",
        joueurs: "Extrais uniquement la liste des JOUEURS (avec leur club si indiqué).",
        tournoi: "Extrais les informations du TOURNOI (nom, dates, lieu) et, si présents, les joueurs, clubs et résultats.",
        matchs: "Extrais uniquement les MATCHS / RÉSULTATS (joueurs de chaque camp, scores set par set, vainqueur)."
    };
    const PROMPT = mode => `${MODE_TXT[mode] || MODE_TXT.auto}

Réponds UNIQUEMENT avec un objet JSON (sans texte autour) de cette forme exacte, en omettant les parties absentes du document :
{
 "clubs": [{"nom": "", "ville": "", "departement": "code département ex: 12, 2A, 974 ou vide"}],
 "joueurs": [{"prenom": "", "nom": "", "genre": "H" ou "F" ou "", "club": "", "ptsSimple": 0, "ptsDouble": 0, "ptsMixte": 0}],
 "tournoi": {"nom": "", "date": "AAAA-MM-JJ", "dateFin": "AAAA-MM-JJ", "lieu": ""},
 "matchs": [{"tableau": "simple" | "double" | "mixte", "date": "AAAA-MM-JJ", "camp1": ["Prénom Nom", "..."], "camp2": ["Prénom Nom", "..."], "sets": ["21-15", "18-21", "21-19"], "vainqueur": 1 ou 2 ou 0}]
}
Règles : ne rien inventer ; si un score est illisible, ne pas le deviner (le laisser de côté) ; noms écrits "Prénom Nom" avec la casse normale ; les scores sont dans l'ordre camp1-camp2 ; 1 nom par camp en simple, 2 en double/mixte ; vainqueur : 1 = camp1, 2 = camp2, 0 = inconnu.`;

    function parseJson(txt) {
        const t = String(txt || '').replace(/```json|```/g, '').trim();
        try { return JSON.parse(t); } catch (e) {
            const i = t.indexOf('{'), j = t.lastIndexOf('}');
            if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e2) { /* tombe plus bas */ } }
            throw new Error('La réponse de l\'IA n\'a pas pu être lue. Réessayez (ou avec une photo plus nette).');
        }
    }
    async function callGemini(key, mode) {
        const parts = files.map(f => ({ inline_data: { mime_type: f.type, data: f.data } }));
        parts.push({ text: PROMPT(mode) });
        const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } });
        let lastErr = null;
        for (const model of MODELS) {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body
            });
            const j = await r.json().catch(() => ({}));
            if (r.ok) {
                const txt = (((j.candidates || [])[0] || {}).content || {}).parts;
                if (!txt) throw new Error('Réponse vide (le document a peut-être été refusé). Essayez une autre photo.');
                return parseJson(txt.map(x => x.text || '').join(''));
            }
            const m = (j.error && j.error.message) || ('Erreur ' + r.status);
            if (r.status === 404) { lastErr = new Error('Modèle indisponible : ' + model); continue; }  // on essaie le suivant
            if (r.status === 429) throw new Error('Limite gratuite atteinte (quelques analyses par minute / par jour). Patientez une minute puis réessayez.');
            if (r.status === 400 && /api key/i.test(m)) throw new Error('Clé API invalide. Recréez-en une sur aistudio.google.com/apikey.');
            if (r.status === 403 || r.status === 401) throw new Error('Clé refusée par Google : ' + m);
            throw new Error(m);
        }
        throw lastErr || new Error('Aucun modèle disponible.');
    }
    async function analyse() {
        const msg = $('#imp-msg'), btn = $('#imp-go');
        const key = ($('#imp-key').value || '').trim();
        if (!key) { msg.textContent = '⚠️ Collez d\'abord votre clé gratuite Gemini (lien ci-dessus).'; return; }
        try { localStorage.setItem(KEY_STORE, key); } catch (e) { /* ignore */ }
        const total = files.reduce((n, f) => n + f.data.length, 0);
        if (total > MAX_BYTES) { msg.textContent = '⚠️ Fichiers trop lourds. Envoyez-en moins à la fois.'; return; }
        btn.disabled = true; msg.textContent = '⏳ Lecture du document en cours… (10 à 40 secondes)';
        $('#imp-preview').innerHTML = '';
        try {
            const d = await callGemini(key, $('#imp-mode').value);
            buildState({ clubs: [].concat(d.clubs || []), joueurs: [].concat(d.joueurs || []), tournoi: d.tournoi || null, matchs: [].concat(d.matchs || []) });
            msg.textContent = '';
            renderPreview();
        } catch (e) {
            msg.textContent = (e instanceof TypeError) ? '❌ Connexion impossible (internet, ou extension qui bloque googleapis.com).' : '❌ ' + e.message;
        } finally { btn.disabled = !files.length; }
    }

    function buildState(d) {
        st = { clubs: [], joueurs: [], tournoi: null, matchs: [], rattache: '' };
        const seenC = new Set(), seenP = new Set(), seenM = new Set();
        (d.clubs || []).forEach(c => {
            const k = norm(c.nom) + '#' + norm(c.ville);
            if (seenC.has(k)) return; seenC.add(k);
            const dup = findClub(c.nom, c.ville);
            st.clubs.push({ on: !dup, dup, nom: c.nom || '', ville: c.ville || '', dept: c.departement || '' });
        });
        (d.joueurs || []).forEach(p => {
            const k = norm((p.prenom || '') + ' ' + (p.nom || ''));
            if (seenP.has(k)) return; seenP.add(k);
            const dup = findPlayer((p.prenom || '') + ' ' + (p.nom || ''));
            st.joueurs.push({ on: !dup, dup, prenom: p.prenom || '', nom: p.nom || '', genre: p.genre || '', club: p.club || '', pays: p.pays || '',
                ptsSimple: p.ptsSimple || 0, ptsDouble: p.ptsDouble || 0, ptsMixte: p.ptsMixte || 0 });
        });
        if (d.tournoi && d.tournoi.nom) {
            const dup = findTournoi(d.tournoi.nom);
            st.tournoi = { on: !dup, dup, nom: d.tournoi.nom, date: d.tournoi.date || '', dateFin: d.tournoi.dateFin || d.tournoi.date || '', lieu: d.tournoi.lieu || '' };
        }
        (d.matchs || []).forEach(m => {
            const mm = { tableau: m.tableau || ((m.camp1 || []).length > 1 ? 'double' : 'simple'), date: m.date || (st.tournoi && st.tournoi.date) || today(),
                camp1: (m.camp1 || []).join(' / '), camp2: (m.camp2 || []).join(' / '), sets: (m.sets || []).join(' / '), vainqueur: m.vainqueur || 0 };
            const sig = matchSig(mm) + '#' + setsKey(BS.splitScore(mm.sets));
            if (seenM.has(sig)) return; seenM.add(sig);
            mm.dup = findDupMatch(mm); mm.on = !mm.dup;
            st.matchs.push(mm);
        });
        st.rattache = st.tournoi ? 'new' : '';
    }

    /* ---------- Aperçu ---------- */
    function matchInfo(m) {
        const r = BS.evalSets(BS.splitScore(m.sets));
        const w = r.status === 'done' ? r.winner : (m.vainqueur || 0);
        const names = [...m.camp1.split('/'), ...m.camp2.split('/')].map(s => s.trim()).filter(Boolean);
        const need = (m.tableau === 'simple' ? 1 : 2);
        const problems = [];
        if (m.camp1.split('/').filter(s => s.trim()).length !== need || m.camp2.split('/').filter(s => s.trim()).length !== need) problems.push(`${need} joueur(s) par camp attendu(s)`);
        if (!w) problems.push('vainqueur inconnu');
        if (r.status !== 'empty' && !r.ok) problems.push(r.msg);
        const created = names.filter(n => !findPlayer(n) && !st.joueurs.some(p => p.on && norm(p.prenom + ' ' + p.nom) === norm(n))).length;
        return { winner: w, problems, created, sets: r };
    }

    function section(title, count, body) {
        return `<div class="imp-sec"><h3>${title} <small>${count}</small></h3>${body}</div>`;
    }
    const chk = (k, i, on, dup) => `<input type="checkbox" data-k="${k}" data-i="${i}" data-f="on" ${on && !dup ? 'checked' : ''} ${dup ? 'disabled title="Déjà en base : ne sera pas recréé"' : ''}>`;
    const inp = (k, i, f, v, w) => `<input type="text" data-k="${k}" data-i="${i}" data-f="${f}" value="${esc(v)}" style="${w ? 'width:' + w : ''}">`;

    function renderPreview() {
        const P = $('#imp-preview');
        if (!st || (!st.clubs.length && !st.joueurs.length && !st.tournoi && !st.matchs.length)) {
            P.innerHTML = '<p class="imp-empty">Rien d\'exploitable n\'a été trouvé. Essayez une photo plus nette / mieux cadrée, ou choisissez un type précis.</p>'; return;
        }
        let h = '';
        if (st.tournoi) {
            const t = st.tournoi;
            h += section('🏆 Tournoi', t.dup ? '(existe déjà)' : '(nouveau)', `<div class="imp-row">${chk('tournoi', 0, t.on, t.dup)}
                ${inp('tournoi', 0, 'nom', t.nom, '220px')} <input type="date" data-k="tournoi" data-i="0" data-f="date" value="${esc(t.date)}">
                <input type="date" data-k="tournoi" data-i="0" data-f="dateFin" value="${esc(t.dateFin)}"> ${inp('tournoi', 0, 'lieu', t.lieu, '160px')}
                ${t.dup ? '<span class="imp-badge dup">déjà en base</span>' : '<span class="imp-badge new">à créer</span>'}</div>`);
        }
        if (st.clubs.length) {
            h += section('🏢 Clubs', st.clubs.length, st.clubs.map((c, i) => {
                const rg = c.dept && regionOfDept(c.dept);
                return `<div class="imp-row">${chk('clubs', i, c.on, c.dup)} ${inp('clubs', i, 'nom', c.nom, '200px')} ${inp('clubs', i, 'ville', c.ville, '130px')} ${inp('clubs', i, 'dept', c.dept, '60px')}
                ${c.dup ? '<span class="imp-badge dup">déjà en base</span>' : '<span class="imp-badge new">à créer</span>'}
                ${!c.dup && !rg ? '<span class="imp-badge warn">région/dépt. à compléter</span>' : ''}</div>`;
            }).join(''));
        }
        if (st.joueurs.length) {
            h += section('👥 Joueurs', st.joueurs.length, st.joueurs.map((p, i) => `<div class="imp-row">${chk('joueurs', i, p.on, p.dup)}
                ${inp('joueurs', i, 'prenom', p.prenom, '110px')} ${inp('joueurs', i, 'nom', p.nom, '130px')}
                <select data-k="joueurs" data-i="${i}" data-f="genre"><option value="">?</option><option value="H" ${p.genre === 'H' ? 'selected' : ''}>H</option><option value="F" ${p.genre === 'F' ? 'selected' : ''}>F</option></select>
                ${inp('joueurs', i, 'club', p.club, '160px')}
                ${p.dup ? '<span class="imp-badge dup">déjà en base</span>' : '<span class="imp-badge new">à créer</span>'}
                ${p.club && !findClub(p.club) && !st.clubs.some(c => c.on && norm(c.nom) === norm(p.club)) ? '<span class="imp-badge warn">club inconnu</span>' : ''}</div>`).join(''));
        }
        if (st.matchs.length) {
            const T = caches().tournois, C = caches().clubs;
            const opts = `<option value="">— choisir —</option>${st.tournoi ? '<option value="new">Tournoi du document</option>' : ''}
                <optgroup label="Tournois existants">${Object.keys(T).map(id => `<option value="t:${id}">${esc(T[id].nom)}</option>`).join('')}</optgroup>
                <optgroup label="Matchs de club">${Object.keys(C).map(id => `<option value="c:${id}">${esc(C[id].nom)}</option>`).join('')}</optgroup>`;
            h += section('🏸 Matchs', st.matchs.length, `<div class="imp-row"><label>Rattacher à :</label> <select id="imp-rattache">${opts}</select></div>` +
                st.matchs.map((m, i) => {
                    const info = matchInfo(m);
                    m.dup = findDupMatch(m); if (m.dup) m.on = false;
                    return `<div class="imp-row" ${m.dup ? 'style="opacity:.6"' : ''}>${chk('matchs', i, m.on, m.dup)}
                    <select data-k="matchs" data-i="${i}" data-f="tableau">${['simple', 'double', 'mixte'].map(t => `<option ${m.tableau === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
                    <input type="date" data-k="matchs" data-i="${i}" data-f="date" value="${esc(m.date)}">
                    ${inp('matchs', i, 'camp1', m.camp1, '170px')} <b>vs</b> ${inp('matchs', i, 'camp2', m.camp2, '170px')}
                    ${inp('matchs', i, 'sets', m.sets, '150px')}
                    ${m.dup ? '<span class="imp-badge dup">déjà en base — ignoré</span>' : ''}
                    ${info.winner ? `<span class="imp-badge ok">🏆 camp ${info.winner}</span>` : ''}
                    ${info.created ? `<span class="imp-badge new">+${info.created} joueur(s) créé(s)</span>` : ''}
                    ${m.dup ? '' : info.problems.map(x => `<span class="imp-badge bad">${esc(x)}</span>`).join('')}</div>`;
                }).join(''));
        }
        h += `<div class="imp-actions"><button type="button" id="imp-save" class="imp-primary">✅ Enregistrer la sélection</button><span id="imp-save-msg"></span></div>`;
        P.innerHTML = h;
        const rs = $('#imp-rattache'); if (rs) rs.value = st.rattache;
    }

    /* ---------- Enregistrement ---------- */
    async function save() {
        const out = $('#imp-save-msg'), btn = $('#imp-save');
        const { db, ref, push } = API();
        const create = (path, data) => push(ref(db, path), data);
        const rat = ($('#imp-rattache') || {}).value || '';
        const matchsOn = st.matchs.filter(m => m.on && !findDupMatch(m));
        if (matchsOn.length && !rat) { out.textContent = '⚠️ Choisissez à quoi rattacher les matchs (tournoi ou club).'; return; }
        const bad = matchsOn.filter(m => matchInfo(m).problems.length);
        if (bad.length && !confirm(`${bad.length} match(s) ont des problèmes et seront IGNORÉS. Continuer ?`)) return;
        btn.disabled = true; out.textContent = '⏳ Enregistrement…';
        const rep = { skipped: 0, clubs: 0, joueurs: 0, tournoi: 0, matchs: 0, auto: 0, ignores: bad.length };
        try {
            // 1. Clubs
            const clubId = {}; // nom normalisé -> id
            for (const c of st.clubs) {
                const ex = findClub(c.nom, c.ville);
                if (ex) { clubId[norm(c.nom)] = ex; if (c.on) rep.skipped++; continue; }   // déjà en base : on réutilise, on ne crée pas
                if (!c.on || !c.nom.trim()) continue;
                const rg = regionOfDept(c.dept) || { region: '', departement: '', departementNom: '' };
                const r = await create('clubs', { nom: c.nom.trim(), ville: c.ville.trim(), ...rg });
                clubId[norm(c.nom)] = r.key; rep.clubs++;
            }
            // 2. Tournoi
            let tournoiId = null;
            if (st.tournoi && findTournoi(st.tournoi.nom)) { tournoiId = findTournoi(st.tournoi.nom); rep.skipped++; }
            else if (st.tournoi && st.tournoi.on) {
                const t = st.tournoi;
                const r = await create('tournois', { nom: t.nom.trim(), date: t.date, dateFin: t.dateFin || t.date, lieu: t.lieu.trim(), visible: false });
                tournoiId = r.key; rep.tournoi = 1;
            }
            // 3. Joueurs
            const pid = {}; // "prenom nom" normalisé -> id
            for (const p of st.joueurs) {
                const full = p.prenom + ' ' + p.nom, ex = findPlayer(full);
                if (ex) { pid[norm(full)] = ex; if (p.on) rep.skipped++; continue; }         // déjà en base
                if (!p.on || !(p.nom.trim() || p.prenom.trim()) || pid[norm(full)]) continue;
                const cid = findClub(p.club) || clubId[norm(p.club)] || '';
                const r = await create('joueurs', {
                    nom: p.nom.trim(), prenom: p.prenom.trim(), genre: p.genre, typeCompte: 'externe', hasAccount: false, isPro: false,
                    identifiant: null, password: null, clubId: cid, pays: null,
                    ptsSimple: +p.ptsSimple || 0, ptsDouble: +p.ptsDouble || 0, ptsMixte: +p.ptsMixte || 0
                });
                pid[norm(p.prenom + ' ' + p.nom)] = r.key; rep.joueurs++;
            }
            const resolve = async name => {
                const k = norm(name);
                const id = findPlayer(name) || pid[k];
                if (id) return id;
                const s = splitName(name);
                const r = await create('joueurs', { nom: s.nom, prenom: s.prenom, genre: '', typeCompte: 'externe', hasAccount: false, isPro: false,
                    identifiant: null, password: null, clubId: '', pays: null, ptsSimple: 0, ptsDouble: 0, ptsMixte: 0 });
                pid[k] = r.key; rep.auto++; return r.key;
            };
            // 4. Matchs
            let type = 'tournoi', tId = null, cId = null;
            if (rat === 'new') tId = tournoiId;
            else if (rat.startsWith('t:')) tId = rat.slice(2);
            else if (rat.startsWith('c:')) { type = 'club'; cId = rat.slice(2); }
            const done = new Set();
            for (const m of st.matchs.filter(m => m.on && findDupMatch(m))) rep.skipped++;
            for (const m of matchsOn) {
                const info = matchInfo(m);
                if (info.problems.length) continue;
                const sig = matchSig(m) + '#' + setsKey(BS.splitScore(m.sets));
                if (done.has(sig)) { rep.skipped++; continue; } done.add(sig);
                const sets = BS.splitScore(m.sets);
                const c1 = m.camp1.split('/').map(s => s.trim()).filter(Boolean), c2 = m.camp2.split('/').map(s => s.trim()).filter(Boolean);
                const data = { type, tournoiId: type === 'tournoi' ? tId : null, clubId: type === 'club' ? cId : null, tableauType: m.tableau,
                    date: m.date || today(), set1: sets[0], set2: sets[1], set3: sets[2], timestamp: Date.now() };
                if (m.tableau === 'simple') {
                    data.j1 = await resolve(c1[0]); data.j2 = await resolve(c2[0]);
                    data.vainqueur = info.winner === 1 ? data.j1 : data.j2;
                } else {
                    data.equipe1 = [await resolve(c1[0]), await resolve(c1[1])];
                    data.equipe2 = [await resolve(c2[0]), await resolve(c2[1])];
                    data.vainqueur = info.winner === 1 ? 'e1' : 'e2';
                }
                await create('matchs', data); rep.matchs++;
            }
            $('#imp-preview').innerHTML = `<div class="imp-done">✅ Import terminé : ${rep.clubs} club(s), ${rep.joueurs} joueur(s), ${rep.tournoi} tournoi, ${rep.matchs} match(s).
                ${rep.auto ? `<br>ℹ️ ${rep.auto} joueur(s) inconnu(s) créé(s) automatiquement depuis les matchs (genre et club à compléter dans l'onglet Joueurs).` : ''}
                ${rep.skipped ? `<br>♻️ ${rep.skipped} élément(s) déjà en base : non recréé(s), l'existant a été réutilisé.` : ''}
                ${rep.ignores ? `<br>⚠️ ${rep.ignores} match(s) ignoré(s) (problèmes détectés).` : ''}
                ${rep.clubs ? '<br>ℹ️ Vérifiez la région / le département des nouveaux clubs dans l\'onglet Clubs.' : ''}</div>`;
            st = null; files = []; renderFiles();
        } catch (e) {
            out.textContent = '❌ ' + e.message; btn.disabled = false;
        }
    }

    /* ---------- Interface ---------- */
    const CSS = `
    #tab-import .imp-drop{border:2px dashed var(--border);border-radius:14px;padding:26px;text-align:center;cursor:pointer;color:var(--sub);transition:.2s}
    #tab-import .imp-drop.over,#tab-import .imp-drop:hover{border-color:var(--green);color:var(--text)}
    #tab-import .imp-chip{display:inline-flex;gap:6px;align-items:center;background:rgba(148,163,184,.15);border-radius:999px;padding:4px 10px;margin:4px 6px 0 0;font-size:.82rem}
    #tab-import .imp-chip button{all:unset;cursor:pointer;color:var(--danger);font-weight:700}
    #tab-import .imp-top{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:14px 0}
    #tab-import .imp-top label{display:block;font-size:.8rem;color:var(--sub);margin-bottom:4px}
    #tab-import .imp-sec{margin-top:22px}
    #tab-import .imp-sec h3 small{color:var(--sub);font-weight:500}
    #tab-import .imp-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)}
    #tab-import .imp-row input[type=text],#tab-import .imp-row input[type=date],#tab-import .imp-row select{min-height:36px;padding:6px 8px;font-size:.88rem;border-radius:8px}
    #tab-import .imp-row input[type=checkbox]{width:18px;height:18px;min-height:0}
    #tab-import .imp-badge{font-size:.72rem;font-weight:700;border-radius:999px;padding:3px 9px;background:rgba(148,163,184,.18)}
    #tab-import .imp-badge.new{background:rgba(34,197,94,.18);color:#22c55e}
    #tab-import .imp-badge.ok{background:rgba(246,185,59,.2);color:#f6b93b}
    #tab-import .imp-badge.dup{background:rgba(79,143,209,.2);color:#4f8fd1}
    #tab-import .imp-badge.warn{background:rgba(246,185,59,.2);color:#f6b93b}
    #tab-import .imp-badge.bad{background:rgba(239,61,78,.18);color:#ef3d4e}
    #tab-import .imp-actions{margin-top:22px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    #tab-import .imp-primary{background:var(--green);color:#fff;border:0;border-radius:10px;padding:12px 20px;font-weight:700;cursor:pointer}
    #tab-import .imp-primary:disabled{opacity:.5;cursor:not-allowed}
    #tab-import .imp-done{padding:16px;border-radius:12px;background:rgba(34,197,94,.12);line-height:1.7}
    #tab-import #imp-msg,#tab-import #imp-save-msg{font-size:.9rem}`;

    function mount() {
        const nav = $('.nav-tabs'); if (!nav || $('#tab-import')) return;
        const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'btn-tab'; btn.dataset.tab = 'tab-import'; btn.textContent = '📥 Import';
        nav.appendChild(btn);
        const tab = document.createElement('div');
        tab.id = 'tab-import'; tab.className = 'tab-content card';
        tab.innerHTML = `<h2>📥 Import automatique depuis une photo ou un document</h2>
            <p style="color:var(--sub);margin:6px 0 14px">Envoyez une photo (feuille de match, tableau, liste d'engagés, affiche…) ou un PDF. Le site lit le document, vous montre ce qu'il a trouvé,
            et n'enregistre <b>que ce que vous validez</b>.</p>
            <label class="imp-drop" id="imp-drop"><input type="file" id="imp-file" accept="image/*,application/pdf" multiple hidden>
                📷 Glissez vos fichiers ici ou cliquez pour choisir<br><small>Photos (JPG/PNG) ou PDF — 6 fichiers max</small></label>
            <div id="imp-files"></div>
            <div class="imp-top">
                <div><label for="imp-mode">Le document contient…</label>
                    <select id="imp-mode"><option value="auto">Détecter automatiquement</option><option value="matchs">Des résultats de matchs</option>
                    <option value="joueurs">Une liste de joueurs</option><option value="clubs">Une liste de clubs</option><option value="tournoi">Un tournoi (infos + résultats)</option></select></div>
                <div><label for="imp-key">Clé gratuite Gemini <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:var(--accent)">(l'obtenir)</a></label>
                    <input type="password" id="imp-key" autocomplete="off" placeholder="AIza…" style="min-width:230px"></div>
                <button type="button" id="imp-go" class="imp-primary" disabled>🔍 Analyser</button>
            </div>
            <div id="imp-msg"></div><div id="imp-preview"></div>`;
        const tabs = document.querySelectorAll('.tab-content'); tabs[tabs.length - 1].after(tab);

        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active'); tab.classList.add('active');
        });
        try { $('#imp-key').value = localStorage.getItem(KEY_STORE) || ''; } catch (e) { /* ignore */ }
        const drop = $('#imp-drop'), fi = $('#imp-file');
        fi.addEventListener('change', () => { addFiles([...fi.files]); fi.value = ''; });
        ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
        drop.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
        $('#imp-files').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { files.splice(+b.dataset.rm, 1); renderFiles(); } });
        $('#imp-go').addEventListener('click', analyse);

        const P = $('#imp-preview');
        P.addEventListener('input', e => {
            const t = e.target; if (!t.dataset.k || !st) return;
            const row = t.dataset.k === 'tournoi' ? st.tournoi : st[t.dataset.k][+t.dataset.i];
            if (t.dataset.f === 'on') row.on = t.checked; else row[t.dataset.f] = t.value;
        });
        // rafraîchit les badges quand on quitte un champ (évite de perdre le focus en tapant)
        P.addEventListener('change', e => {
            if (e.target.id === 'imp-rattache') { st.rattache = e.target.value; return; }
            if (e.target.dataset && e.target.dataset.k) { const keep = ($('#imp-rattache') || {}).value; renderPreview(); const r = $('#imp-rattache'); if (r && keep) r.value = keep; }
        });
        P.addEventListener('click', e => { if (e.target.id === 'imp-save') save(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();