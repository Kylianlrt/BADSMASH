/* BADSMASH Coach — logique de la page coach.html
   Aucune dépendance. Les vidéos ne quittent jamais l'ordinateur ; les analyses sont
   stockées dans IndexedDB, isolées par joueur (champ userId + filtre systématique). */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Accès
  const userId = localStorage.getItem('badsmash_user_id');
  if (!userId) { window.location.href = 'connexion.html?redirect=coach.html'; return; }
  // Si le joueur se déconnecte ailleurs (autre onglet) ou revient avec le bouton « précédent », on ferme l'accès à Coach.
  // NB : contrôle de navigation côté navigateur uniquement, pas une sécurité serveur.
  const stillLogged = () => { try { return !!localStorage.getItem('badsmash_user_id'); } catch (e) { return false; } };
  window.addEventListener('storage', e => { if (e.key === 'badsmash_user_id' && !stillLogged()) window.location.replace('connexion.html?redirect=coach.html'); });
  window.addEventListener('pageshow', e => { if (e.persisted && !stillLogged()) window.location.replace('connexion.html?redirect=coach.html'); });

  const { CATEGORIES, EXERCISES } = window.COACH_DATA;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const catLabel = id => (CATEGORIES.find(c => c.id === id) || {}).label || id;
  const KIND = { fort: 'Point fort', faible: 'Point faible', neutre: 'Neutre' };
  const KIND_COLOR = { fort: '#22c55e', faible: '#ef3d4e', neutre: '#4f8fd1' };
  const LEVEL = { debutant: 'Débutant', intermediaire: 'Intermédiaire', confirme: 'Confirmé' };
  const FORMAT = { simple: 'Simple', double: 'Double' };
  const WEIGHT = { 1: 3, 2: 2, 3: 1 };
  const MAX_SIZE = 4 * 1024 * 1024 * 1024;
  const OK_EXT = ['mp4', 'm4v', 'mov', 'webm', 'ogv'];
  const CLIP_BEFORE = 3, CLIP_AFTER = 5, SHAPE_WINDOW = 3;

  const state = {
    list: [], cur: null, wsOpen: false,
    pending: null,            // { file, handle } choisi dans le formulaire de création
    video: { id: null, file: null, url: null },
    fps: 30, fpsMeasured: false, fpsSamples: [],
    tool: null, shapes: [], drawing: null, editingId: null, selAnn: null,
    plan: 'session', view: 'dashboard', dbOk: true,
    debrief: { filter: 'all', index: 0, auto: false, end: 0 }
  };

  // ---------------------------------------------------------------- Utilitaires
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
    const p = n => String(n).padStart(2, '0');
    return (h ? h + ':' + p(m) : p(m)) + ':' + p(s) + '.' + p(cs);
  }
  function parseTime(str) {
    const s = String(str).trim().replace(',', '.');
    if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN;
    const parts = s.split(':').map(Number);
    return parts.reduce((acc, v) => acc * 60 + v, 0);
  }
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg; el.setAttribute('role', 'status');
    document.body.appendChild(el); setTimeout(() => el.remove(), 2200);
  }
  const newId = p => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const slug = s => String(s || 'analyse').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'analyse';
  const analysisDate = a => a.date || new Date(a.createdAt).toISOString().slice(0, 10);

  // ---------------------------------------------------------------- IndexedDB (avec repli mémoire)
  let dbPromise = null;
  const mem = { analyses: new Map(), handles: new Map() };
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB indisponible'));
      const r = indexedDB.open('badsmash_coach', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('analyses', { keyPath: 'id' }).createIndex('userId', 'userId');
        db.createObjectStore('handles');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }).catch(err => { state.dbOk = false; console.warn('Coach : stockage persistant indisponible', err); return null; });
    return dbPromise;
  }
  async function run(store, mode, fn) {
    const db = await openDB();
    if (!db) return undefined;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async function dbList() {
    const rows = await run('analyses', 'readonly', s => s.index('userId').getAll(userId));
    const list = state.dbOk ? (rows || []) : [...mem.analyses.values()].filter(a => a.userId === userId);
    return list.filter(a => a.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async function dbPut(a) {
    if (a.userId !== userId) return; // sécurité : jamais d'écriture pour un autre joueur
    if (!state.dbOk) { mem.analyses.set(a.id, JSON.parse(JSON.stringify(a))); return; }
    await run('analyses', 'readwrite', s => s.put(JSON.parse(JSON.stringify(a))));
  }
  async function dbDelete(id) {
    if (!state.dbOk) { mem.analyses.delete(id); mem.handles.delete(id); return; }
    await run('analyses', 'readwrite', s => s.delete(id));
    await run('handles', 'readwrite', s => s.delete(id));
  }
  async function putHandle(id, h) {
    if (!h) return;
    try { if (!state.dbOk) mem.handles.set(id, h); else await run('handles', 'readwrite', s => s.put(h, id)); } catch (e) { /* handle non clonable : on se rabat sur la réimportation manuelle */ }
  }
  async function getHandle(id) {
    try { return state.dbOk ? await run('handles', 'readonly', s => s.get(id)) : mem.handles.get(id); } catch (e) { return null; }
  }
  async function refreshList() { state.list = await dbList(); }
  let saveTimer = null;
  async function persist(quiet) {
    if (!state.cur) return;
    state.cur.updatedAt = Date.now();
    try { await dbPut(state.cur); if (!quiet) toast('Enregistré'); }
    catch (e) { toast('Échec de l\'enregistrement (espace de stockage ?)'); }
  }

  // ---------------------------------------------------------------- Thème
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); $('themeToggle').textContent = t === 'light' ? '☀️' : '🌙'; localStorage.setItem('badsmash_theme', t); }
  $('themeToggle').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'));
  (function () {
    const saved = localStorage.getItem('badsmash_theme');
    const light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(saved || (light ? 'light' : 'dark'));
  })();

  // Nom du joueur (lecture seule dans Firebase, comme mon-espace.html)
  (async function () {
    $('who').textContent = 'Joueur';
    try {
      const cfg = { apiKey: 'AIzaSyD5qiseJI4b-CwIGzKi8XYA6pSPqiMRV24', authDomain: 'badsmash-a5580.firebaseapp.com', projectId: 'badsmash-a5580', storageBucket: 'badsmash-a5580.firebasestorage.app', messagingSenderId: '9725882238', appId: '1:9725882238:web:1c1cdb40da0218f2828d2f', databaseURL: 'https://badsmash-a5580-default-rtdb.firebaseio.com' };
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js');
      const { getDatabase, ref, get } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js');
      const snap = await get(ref(getDatabase(initializeApp(cfg)), 'joueurs/' + userId));
      const j = snap.val();
      if (j) $('who').textContent = `${j.prenom || ''} ${j.nom || ''}`.trim() || 'Joueur';
    } catch (e) { /* hors ligne : le nom n'est pas indispensable */ }
  })();

  // ---------------------------------------------------------------- Navigation
  function showView(name) {
    state.view = name;
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    $('view-' + name).classList.remove('hidden');
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name !== 'analyse') $('video').pause();
    if (name !== 'debrief') { const dv = $('db-video'); if (dv) dv.pause(); }
    ({ dashboard: renderDashboard, analyse: renderAnalyse, rapport: renderReport, plan: renderPlan, debrief: renderDebrief, historique: renderHistory })[name]();
  }
  $('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) showView(b.dataset.view); });

  // Sélecteur d'analyse commun aux vues Rapport / Plan / Débriefing
  function pickerHTML() {
    if (!state.list.length) return '';
    return `<div class="form-group no-print"><label for="an-pick">Analyse</label><select id="an-pick">${state.list.map(a => `<option value="${a.id}" ${state.cur && state.cur.id === a.id ? 'selected' : ''}>${esc(a.title)} · ${esc(analysisDate(a))} · ${FORMAT[a.format]}</option>`).join('')}</select></div>`;
  }
  function bindPicker(rerender) {
    const p = $('an-pick'); if (!p) return;
    p.addEventListener('change', () => { selectAnalysis(p.value); rerender(); });
  }
  function selectAnalysis(id) {
    const a = state.list.find(x => x.id === id);
    if (!a) return;
    if (!state.cur || state.cur.id !== a.id) { state.cur = a; state.wsOpen = false; state.selAnn = null; state.editingId = null; }
  }
  function ensureCurrent() {
    if (state.cur && state.list.find(a => a.id === state.cur.id)) { state.cur = state.list.find(a => a.id === state.cur.id); return true; }
    if (state.list.length) { state.cur = state.list[0]; return true; }
    state.cur = null; return false;
  }
  const noAnalysisHTML = '<div class="empty">Aucune analyse pour le moment.<br>Importez une vidéo dans l\'onglet <b>Analyser</b> pour commencer.</div>';

  // ---------------------------------------------------------------- Tableau de bord
  const goalKey = () => `badsmash_coachgoals_${userId}`;
  const readGoals = () => { try { return JSON.parse(localStorage.getItem(goalKey()) || '[]'); } catch (e) { return []; } };
  const writeGoals = g => localStorage.setItem(goalKey(), JSON.stringify(g));

  function renderGoals() {
    const g = readGoals();
    $('goals-list').innerHTML = g.length ? g.map(x => `<div class="goal ${x.done ? 'done' : ''}"><input type="checkbox" data-goal="${x.id}" ${x.done ? 'checked' : ''} aria-label="Objectif atteint"><span>${esc(x.text)}</span><button class="btn-small danger" data-goal-del="${x.id}" aria-label="Supprimer l'objectif">✕</button></div>`).join('') : '<p class="muted">Aucun objectif pour l\'instant.</p>';
  }
  $('goals-list').addEventListener('click', e => {
    const id = e.target.dataset.goal || e.target.dataset.goalDel; if (!id) return;
    let g = readGoals();
    if (e.target.dataset.goalDel) g = g.filter(x => x.id !== id); else g = g.map(x => x.id === id ? { ...x, done: e.target.checked } : x);
    writeGoals(g); renderGoals();
  });
  function addGoal() {
    const v = $('goal-input').value.trim(); if (!v) return;
    writeGoals([...readGoals(), { id: newId('g'), text: v, done: false }]); $('goal-input').value = ''; renderGoals();
  }
  $('goal-add').addEventListener('click', addGoal);
  $('goal-input').addEventListener('keydown', e => { if (e.key === 'Enter') addGoal(); });

  async function renderDashboard() {
    await refreshList();
    const totalObs = state.list.reduce((n, a) => n + a.annotations.length, 0);
    const last = state.list[0];
    const rep = last ? buildReport(last) : null;
    $('dash-stats').innerHTML = `
      <div class="stat-box"><div class="title">Analyses</div><div class="val">${state.list.length}</div></div>
      <div class="stat-box"><div class="title">Observations notées</div><div class="val">${totalObs}</div></div>
      <div class="stat-box"><div class="title">Dernière analyse</div><div class="val sm">${last ? esc(last.title) : '—'}</div></div>
      <div class="stat-box"><div class="title">Priorité n°1 actuelle</div><div class="val sm">${rep && rep.top[0] ? esc(catLabel(rep.top[0].cat)) : '—'}</div></div>`;
    $('btn-resume').classList.toggle('hidden', !last);
    $('dash-recent').innerHTML = state.list.length ? state.list.slice(0, 4).map(histItemHTML).join('') : noAnalysisHTML;
    bindHistoryActions($('dash-recent'));
    renderGoals();
    if (!state.dbOk) $('dash-recent').insertAdjacentHTML('afterbegin', '<div class="notice warn">Le stockage du navigateur est indisponible (navigation privée ?). Vos analyses seront perdues à la fermeture : pensez à utiliser « Exporter (JSON) ».</div>');
  }
  $('btn-new').addEventListener('click', () => { state.wsOpen = false; resetSetup(); showView('analyse'); });
  $('btn-resume').addEventListener('click', async () => { await refreshList(); if (state.list[0]) openAnalysis(state.list[0].id); });

  // ---------------------------------------------------------------- Vidéo : validation et chargement
  function validateFile(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (f.size > MAX_SIZE) return 'Fichier trop volumineux (' + (f.size / 1e9).toFixed(1) + ' Go). Limite : 4 Go. Découpez ou compressez la vidéo.';
    if (!(f.type.startsWith('video/') || OK_EXT.includes(ext))) return `Format « .${ext || '?'} » non pris en charge. Importez un fichier MP4, WebM ou MOV.`;
    if (['mkv', 'avi', 'wmv', 'flv', 'ts'].includes(ext)) return `Les navigateurs ne lisent pas le format .${ext}. Convertissez-le en MP4 : ffmpeg -i entree.${ext} -c:v libx264 -c:a aac sortie.mp4`;
    return '';
  }
  const CODEC_HELP = 'Ce fichier ne peut pas être lu par le navigateur (codec non pris en charge, par exemple HEVC/H.265 ou fichier corrompu). Convertissez-le en MP4 H.264 : ffmpeg -i entree.mp4 -c:v libx264 -c:a aac sortie.mp4';

  function probe(file) {
    return new Promise(resolve => {
      const v = document.createElement('video'); const url = URL.createObjectURL(file);
      const done = r => { clearTimeout(t); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); resolve(r); };
      const t = setTimeout(() => done({ ok: false, error: 'Lecture impossible (délai dépassé).' }), 10000);
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => done(v.videoWidth ? { ok: true, duration: v.duration } : { ok: false, error: CODEC_HELP });
      v.onerror = () => done({ ok: false, error: CODEC_HELP });
      v.src = url;
    });
  }

  function useFile(file) {
    if (state.video.url) URL.revokeObjectURL(state.video.url);
    state.video = { id: state.cur ? state.cur.id : null, file, url: URL.createObjectURL(file) };
    state.fpsMeasured = false; state.fpsSamples = []; state.fps = 30;
    const v = $('video'); v.src = state.video.url; v.playbackRate = +$('speed').value;
    $('stage-msg').classList.add('hidden');
    updateFpsInfo();
  }
  function updateFpsInfo() { $('fps-info').textContent = state.fpsMeasured ? `${state.fps.toFixed(2)} i/s (mesuré)` : '30 i/s par défaut (affiné à la lecture)'; }

  // ---------------------------------------------------------------- Création d'une analyse
  function resetSetup() {
    state.pending = null; $('file-info').textContent = ''; $('btn-create').disabled = true; $('setup-error').classList.add('hidden');
    ['f-title', 'f-opp', 'f-objectives', 'f-notes'].forEach(i => $(i).value = '');
    $('f-date').value = new Date().toISOString().slice(0, 10);
  }
  function setupError(msg) { const e = $('setup-error'); e.textContent = msg; e.classList.toggle('hidden', !msg); }

  async function chooseForSetup(file, handle) {
    setupError(''); state.pending = null; $('btn-create').disabled = true;
    const err = validateFile(file);
    if (err) { $('file-info').textContent = ''; return setupError(err); }
    $('file-info').textContent = `${file.name} · ${(file.size / 1e6).toFixed(1)} Mo · vérification…`;
    const r = await probe(file);
    if (!r.ok) { $('file-info').textContent = ''; return setupError(r.error); }
    state.pending = { file, handle, duration: r.duration };
    $('file-info').textContent = `${file.name} · ${(file.size / 1e6).toFixed(1)} Mo · ${fmt(r.duration)}`;
    if (!$('f-title').value) $('f-title').value = file.name.replace(/\.[^.]+$/, '');
    if (file.size > 2e9) setupError('Fichier volumineux : la lecture peut être lente sur un ordinateur modeste.');
    $('btn-create').disabled = false;
  }

  async function pickFile() {
    if (window.showOpenFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Vidéos', accept: { 'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.ogv'] } }] });
        return { file: await h.getFile(), handle: h };
      } catch (e) { if (e.name === 'AbortError') return null; }
    }
    return new Promise(resolve => {
      const inp = $('file-input'); inp.value = '';
      inp.onchange = () => resolve(inp.files[0] ? { file: inp.files[0], handle: null } : null);
      inp.click();
    });
  }
  $('dropzone').addEventListener('click', async () => { const r = await pickFile(); if (r) chooseForSetup(r.file, r.handle); });
  $('dropzone').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('dropzone').click(); } });
  ['dragenter', 'dragover'].forEach(ev => $('dropzone').addEventListener(ev, e => { e.preventDefault(); $('dropzone').classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => $('dropzone').addEventListener(ev, e => { e.preventDefault(); $('dropzone').classList.remove('over'); }));
  $('dropzone').addEventListener('drop', async e => {
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    let handle = null;
    if (item && item.getAsFileSystemHandle) { try { handle = await item.getAsFileSystemHandle(); } catch (x) { handle = null; } }
    const file = handle && handle.kind === 'file' ? await handle.getFile() : e.dataTransfer.files[0];
    if (!file) return;
    chooseForSetup(file, handle && handle.kind === 'file' ? handle : null);
  });

  $('btn-create').addEventListener('click', async () => {
    if (!state.pending) return;
    const { file, handle, duration } = state.pending;
    const a = {
      id: newId('an'), userId, title: $('f-title').value.trim() || file.name, date: $('f-date').value, format: $('f-format').value,
      level: $('f-level').value, opponent: $('f-opp').value.trim(), objectives: $('f-objectives').value.trim(), notes: $('f-notes').value.trim(),
      video: { name: file.name, size: file.size, duration, lastModified: file.lastModified }, annotations: [], createdAt: Date.now(), updatedAt: Date.now()
    };
    try { await dbPut(a); } catch (e) { return setupError('Impossible d\'enregistrer l\'analyse : espace de stockage insuffisant ?'); }
    await putHandle(a.id, handle);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    await refreshList(); state.cur = a; state.wsOpen = true; state.pending = null;
    useFile(file); renderAnalyse();
  });

  // ---------------------------------------------------------------- Ouverture d'une analyse
  async function openAnalysis(id) {
    await refreshList(); selectAnalysis(id);
    state.cur = state.list.find(a => a.id === id); state.wsOpen = true;
    state.selAnn = null; state.editingId = null; state.shapes = [];
    if (state.video.id !== state.cur.id) { $('video').removeAttribute('src'); await tryAutoLoad(state.cur); }
    showView('analyse');
  }
  async function tryAutoLoad(a) {
    const h = await getHandle(a.id);
    if (h && h.queryPermission) {
      try { if ((await h.queryPermission({ mode: 'read' })) === 'granted') { useFile(await h.getFile()); return true; } } catch (e) { /* ignore */ }
    }
    return false;
  }
  function relinkUI(container, a, onLoaded) {
    container.innerHTML = `<div><b>Vidéo à retrouver</b><br><span class="muted" style="color:#9aa9c4">${esc(a.video.name)} · ${(a.video.size / 1e6).toFixed(1)} Mo</span></div>
      <div id="rl-err" style="color:#ef3d4e;font-size:.85rem;max-width:520px"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><button class="btn-main" id="rl-auth" style="display:none">Autoriser l'accès au fichier</button><button class="btn-small" id="rl-pick">Choisir le fichier…</button></div>
      <div class="muted" style="color:#9aa9c4;max-width:460px">Pour des raisons de sécurité, le navigateur ne conserve pas la vidéo elle-même. Vos annotations sont intactes.</div>`;
    container.classList.remove('hidden');
    const err = m => { container.querySelector('#rl-err').textContent = m; };
    const accept = async file => {
      const bad = validateFile(file); if (bad) return err(bad);
      const sameish = file.name === a.video.name || file.size === a.video.size;
      if (!sameish && !confirm('Ce fichier ne ressemble pas à la vidéo analysée (nom et taille différents). Les repères temporels risquent d\'être faux. L\'utiliser quand même ?')) return;
      const r = await probe(file); if (!r.ok) return err(r.error);
      useFile(file); state.video.id = a.id; onLoaded();
    };
    getHandle(a.id).then(h => {
      if (!h || !h.requestPermission) return;
      const b = container.querySelector('#rl-auth'); b.style.display = '';
      b.onclick = async () => { try { if ((await h.requestPermission({ mode: 'read' })) === 'granted') return accept(await h.getFile()); err('Accès refusé.'); } catch (e) { err('Le fichier a été déplacé ou supprimé : choisissez-le manuellement.'); } };
    });
    container.querySelector('#rl-pick').onclick = async () => { const r = await pickFile(); if (r) { accept(r.file); if (r.handle) putHandle(a.id, r.handle); } };
  }

  // ---------------------------------------------------------------- Dessin sur la vidéo
  function contentRect(v, cw, ch) {
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9, s = Math.min(cw / vw, ch / vh);
    return { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
  }
  function drawShape(ctx, r, sh, color, dashed) {
    const X = v => r.x + v * r.w, Y = v => r.y + v * r.h;
    ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round';
    if (dashed) ctx.setLineDash([8, 6]);
    if (sh.type === 'arrow') {
      const x1 = X(sh.x1), y1 = Y(sh.y1), x2 = X(sh.x2), y2 = Y(sh.y2), ang = Math.atan2(y2 - y1, x2 - x1), hl = 16;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - hl * Math.cos(ang - .4), y2 - hl * Math.sin(ang - .4)); ctx.lineTo(x2 - hl * Math.cos(ang + .4), y2 - hl * Math.sin(ang + .4)); ctx.closePath(); ctx.fill();
    } else if (sh.type === 'circle') {
      const cx = X(sh.x1), cy = Y(sh.y1), rad = Math.hypot(X(sh.x2) - cx, Y(sh.y2) - cy);
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.globalAlpha = .15; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
    } else if (sh.type === 'zone') {
      const x = Math.min(X(sh.x1), X(sh.x2)), y = Math.min(Y(sh.y1), Y(sh.y2)), w = Math.abs(X(sh.x2) - X(sh.x1)), h = Math.abs(Y(sh.y2) - Y(sh.y1));
      ctx.globalAlpha = .18; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
  }
  function makeStage(video, canvas, getLayers) {
    function draw() {
      const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const r = contentRect(video, w, h);
      getLayers().forEach(l => l.shapes.forEach(s => drawShape(ctx, r, s, l.color, l.dashed)));
    }
    if (window.ResizeObserver) new ResizeObserver(draw).observe(canvas);
    video.addEventListener('loadedmetadata', draw);
    return { draw, rect: () => contentRect(video, canvas.clientWidth, canvas.clientHeight) };
  }

  const video = $('video'), overlay = $('overlay');
  const stage = makeStage(video, overlay, () => {
    const layers = [];
    if (state.cur) {
      const t = video.currentTime || 0;
      state.cur.annotations.forEach(a => { if (a.shapes && a.shapes.length && t >= a.t - 0.1 && t <= a.t + SHAPE_WINDOW) layers.push({ shapes: a.shapes, color: KIND_COLOR[a.kind] }); });
    }
    if (state.shapes.length) layers.push({ shapes: state.shapes, color: '#f6b93b', dashed: true });
    if (state.drawing) layers.push({ shapes: [state.drawing], color: '#f6b93b' });
    return layers;
  });

  function pt(e) {
    const b = overlay.getBoundingClientRect(), r = stage.rect();
    const c = v => Math.max(0, Math.min(1, v));
    return { x: c((e.clientX - b.left - r.x) / r.w), y: c((e.clientY - b.top - r.y) / r.h) };
  }
  overlay.addEventListener('pointerdown', e => {
    if (!state.tool) return;
    video.pause(); overlay.setPointerCapture(e.pointerId);
    const p = pt(e); state.drawing = { type: state.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y }; stage.draw();
  });
  overlay.addEventListener('pointermove', e => { if (!state.drawing) return; const p = pt(e); state.drawing.x2 = p.x; state.drawing.y2 = p.y; stage.draw(); });
  overlay.addEventListener('pointerup', () => {
    if (!state.drawing) return;
    const d = state.drawing; state.drawing = null;
    if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 0.015) state.shapes.push(d);
    updateShapesInfo(); stage.draw();
  });
  document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
    state.tool = state.tool === b.dataset.tool ? null : b.dataset.tool;
    document.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x.dataset.tool === state.tool));
    overlay.classList.toggle('drawing', !!state.tool);
  }));
  $('btn-clear-shapes').addEventListener('click', () => { state.shapes = []; updateShapesInfo(); stage.draw(); });
  function updateShapesInfo() { $('a-shapes-info').textContent = state.shapes.length ? `${state.shapes.length} annotation(s) visuelle(s) seront jointes à cette observation.` : 'Astuce : dessinez une flèche, un cercle ou une zone sur l\'image avant d\'enregistrer.'; }

  // ---------------------------------------------------------------- Lecteur et contrôles
  let raf = 0, scrubbing = false;
  function tick() {
    const d = video.duration || 0, t = video.currentTime || 0;
    $('tc').textContent = `${fmt(t)} / ${fmt(d)}`;
    if (!scrubbing) $('scrub').value = d ? Math.round(t / d * 1000) : 0;
    const head = $('timeline').querySelector('.head'); if (head) head.style.left = (d ? t / d * 100 : 0) + '%';
    $('c-play').textContent = video.paused ? '▶ Lecture' : '❚❚ Pause';
    stage.draw();
    cancelAnimationFrame(raf); if (!video.paused) raf = requestAnimationFrame(tick);
  }
  ['timeupdate', 'seeked', 'play', 'pause', 'loadedmetadata', 'durationchange'].forEach(ev => video.addEventListener(ev, tick));
  video.addEventListener('pause', syncTimeField); video.addEventListener('seeked', syncTimeField);
  function syncTimeField() { if (!state.editingId && document.activeElement !== $('a-time')) $('a-time').value = fmt(video.currentTime); }
  video.addEventListener('loadedmetadata', renderTimeline);
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    const m = $('stage-msg'); m.innerHTML = `<div style="max-width:520px;line-height:1.5">${esc(CODEC_HELP)}</div>`; m.classList.remove('hidden');
  });
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    let last = null;
    const cb = (now, meta) => {
      if (last !== null && meta.mediaTime > last && meta.mediaTime - last < 0.2) {
        state.fpsSamples.push(meta.mediaTime - last);
        if (state.fpsSamples.length > 40) state.fpsSamples.shift();
        if (state.fpsSamples.length >= 15) {
          const s = [...state.fpsSamples].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)], f = 1 / med;
          if (f >= 10 && f <= 120) { state.fps = f; if (!state.fpsMeasured) { state.fpsMeasured = true; updateFpsInfo(); } }
        }
      }
      last = meta.mediaTime; video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
  }
  function seek(t) { video.pause(); video.currentTime = Math.max(0, Math.min(video.duration || 0, t)); }
  function stepFrame(dir) { video.pause(); const idx = Math.floor((video.currentTime || 0) * state.fps + 1e-4); seek((idx + dir + 0.5) / state.fps); }
  $('c-play').addEventListener('click', () => { video.paused ? video.play().catch(() => { }) : video.pause(); });
  $('c-prev').addEventListener('click', () => stepFrame(-1));
  $('c-next').addEventListener('click', () => stepFrame(1));
  $('c-back').addEventListener('click', () => seek(video.currentTime - 5));
  $('c-fwd').addEventListener('click', () => seek(video.currentTime + 5));
  $('speed').addEventListener('change', e => { video.playbackRate = +e.target.value; });
  $('scrub').addEventListener('input', e => { scrubbing = true; if (video.duration) video.currentTime = +e.target.value / 1000 * video.duration; });
  $('scrub').addEventListener('change', () => { scrubbing = false; });
  $('timeline').addEventListener('click', e => {
    if (e.target.closest('.mk') || !video.duration) return;
    const b = $('timeline').getBoundingClientRect(); seek((e.clientX - b.left) / b.width * video.duration);
  });
  $('a-now').addEventListener('click', () => { $('a-time').value = fmt(video.currentTime); });
  document.addEventListener('keydown', e => {
    if (state.view !== 'analyse' || !state.wsOpen || /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''))) return;
    if (e.key === ' ') { e.preventDefault(); $('c-play').click(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? seek(video.currentTime - 5) : stepFrame(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? seek(video.currentTime + 5) : stepFrame(1); }
    else if (e.key.toLowerCase() === 'a') { e.preventDefault(); video.pause(); $('a-time').value = fmt(video.currentTime); $('a-comment').focus(); }
  });

  // ---------------------------------------------------------------- Annotations
  function fillCategorySelects() {
    const groups = [...new Set(CATEGORIES.map(c => c.group))];
    $('a-cat').innerHTML = groups.map(g => `<optgroup label="${g}">${CATEGORIES.filter(c => c.group === g).map(c => `<option value="${c.id}">${c.label}</option>`).join('')}</optgroup>`).join('');
    $('flt-cat').innerHTML = '<option value="">Tous types</option>' + CATEGORIES.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
  }
  fillCategorySelects();

  function renderAnalyse() {
    const open = !!(state.cur && state.wsOpen);
    $('setup').classList.toggle('hidden', open); $('workspace').classList.toggle('hidden', !open);
    if (!open) { if (!state.pending) resetSetupIfEmpty(); return; }
    const a = state.cur;
    $('ws-title').textContent = a.title;
    $('ws-meta').textContent = `${FORMAT[a.format]} · ${LEVEL[a.level]} · ${analysisDate(a)}${a.opponent ? ' · vs ' + a.opponent : ''}`;
    if (state.video.id === a.id && state.video.url) $('stage-msg').classList.add('hidden');
    else relinkUI($('stage-msg'), a, () => { renderAnalyse(); });
    renderTimeline(); renderAnnList(); updateShapesInfo(); tick();
  }
  function resetSetupIfEmpty() { if (!$('f-date').value) $('f-date').value = new Date().toISOString().slice(0, 10); }

  function renderTimeline() {
    const tl = $('timeline'), d = video.duration || (state.cur && state.cur.video.duration) || 0;
    tl.innerHTML = '<div class="head"></div>';
    if (!state.cur || !d) return;
    state.cur.annotations.forEach(a => {
      const b = document.createElement('button');
      b.className = `mk ${a.kind} p${a.priority}${state.selAnn === a.id ? ' sel' : ''}`;
      b.style.left = (a.t / d * 100) + '%'; b.title = `${fmt(a.t)} · ${catLabel(a.cat)} · ${KIND[a.kind]}`; b.setAttribute('aria-label', b.title);
      b.addEventListener('click', e => { e.stopPropagation(); gotoAnn(a.id); });
      tl.appendChild(b);
    });
  }
  function gotoAnn(id) {
    const a = state.cur.annotations.find(x => x.id === id); if (!a) return;
    state.selAnn = id; seek(a.t); renderTimeline(); renderAnnList();
    const el = $('ann-list').querySelector(`[data-ann="${id}"]`); if (el) el.scrollIntoView({ block: 'nearest' });
  }
  function renderAnnList() {
    const a = state.cur, fk = $('flt-kind').value, fc = $('flt-cat').value;
    const items = a.annotations.filter(x => (!fk || x.kind === fk) && (!fc || x.cat === fc));
    $('ann-count').textContent = `${items.length}/${a.annotations.length}`;
    $('ann-list').innerHTML = items.length ? items.map(x => `
      <div class="ann ${x.kind} ${state.selAnn === x.id ? 'sel' : ''}" data-ann="${x.id}">
        <div class="top"><button class="tc" data-go="${x.id}">${fmt(x.t)}</button><span class="tag">${esc(catLabel(x.cat))}</span><span class="tag">${KIND[x.kind]}</span><span class="tag ${x.priority === 1 ? 'p1' : ''}">P${x.priority}</span>${x.shapes && x.shapes.length ? '<span class="tag">✎ ' + x.shapes.length + '</span>' : ''}</div>
        ${x.shot ? `<div class="txt"><b>${esc(x.shot)}</b></div>` : ''}
        ${x.comment ? `<div class="txt">${esc(x.comment)}</div>` : ''}
        ${x.correction ? `<div class="fix">→ ${esc(x.correction)}</div>` : ''}
        <div class="acts"><button class="btn-small" data-edit="${x.id}">Modifier</button><button class="btn-small danger" data-del="${x.id}">Supprimer</button></div>
      </div>`).join('') : '<div class="empty">Aucune observation.<br>Mettez la vidéo en pause sur un moment important et remplissez le formulaire.</div>';
  }
  $('flt-kind').addEventListener('change', renderAnnList); $('flt-cat').addEventListener('change', renderAnnList);
  $('ann-list').addEventListener('click', e => {
    const g = e.target.closest('[data-go]'), ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (g) gotoAnn(g.dataset.go);
    if (ed) startEdit(ed.dataset.edit);
    if (del && confirm('Supprimer cette observation ?')) {
      state.cur.annotations = state.cur.annotations.filter(x => x.id !== del.dataset.del);
      if (state.editingId === del.dataset.del) cancelEdit();
      persist(true); renderTimeline(); renderAnnList(); toast('Observation supprimée');
    }
  });

  function aErr(m) { const e = $('a-err'); e.textContent = m; e.classList.toggle('hidden', !m); }
  function startEdit(id) {
    const x = state.cur.annotations.find(a => a.id === id); if (!x) return;
    state.editingId = id; $('form-title').textContent = 'Modifier l\'observation'; $('a-cancel').classList.remove('hidden');
    $('a-time').value = fmt(x.t); $('a-cat').value = x.cat; $('a-shot').value = x.shot || ''; $('a-comment').value = x.comment || ''; $('a-fix').value = x.correction || ''; $('a-prio').value = x.priority;
    document.querySelector(`input[name=a-kind][value=${x.kind}]`).checked = true;
    state.shapes = (x.shapes || []).map(s => ({ ...s })); updateShapesInfo(); gotoAnn(id);
    $('a-time').scrollIntoView({ block: 'center' });
  }
  function cancelEdit() {
    state.editingId = null; $('form-title').textContent = 'Nouvelle observation'; $('a-cancel').classList.add('hidden');
    ['a-shot', 'a-comment', 'a-fix'].forEach(i => $(i).value = ''); $('a-prio').value = '2'; state.shapes = []; updateShapesInfo(); aErr(''); stage.draw();
  }
  $('a-cancel').addEventListener('click', cancelEdit);
  $('a-save').addEventListener('click', () => {
    aErr('');
    const t = parseTime($('a-time').value), dur = video.duration || state.cur.video.duration || Infinity;
    if (isNaN(t)) return aErr('Moment invalide : utilisez le format mm:ss.cc (ex : 01:23.50).');
    if (t > dur + 0.5) return aErr('Ce moment dépasse la durée de la vidéo (' + fmt(dur) + ').');
    const comment = $('a-comment').value.trim(), correction = $('a-fix').value.trim(), shot = $('a-shot').value.trim();
    if (!comment && !correction && !shot) return aErr('Décrivez le coup, votre constat ou la correction.');
    const kind = document.querySelector('input[name=a-kind]:checked').value;
    const obj = { id: state.editingId || newId('o'), t: Math.round(t * 100) / 100, cat: $('a-cat').value, kind, shot, comment, correction, priority: +$('a-prio').value, shapes: state.shapes.map(s => ({ ...s })) };
    if (state.editingId) state.cur.annotations = state.cur.annotations.map(a => a.id === obj.id ? obj : a); else state.cur.annotations.push(obj);
    state.cur.annotations.sort((a, b) => a.t - b.t);
    state.selAnn = obj.id; cancelEdit(); persist(); renderTimeline(); renderAnnList();
  });
  $('btn-close-analysis').addEventListener('click', () => { video.pause(); state.wsOpen = false; state.editingId = null; resetSetup(); renderAnalyse(); });

  // ---------------------------------------------------------------- Rapport
  function buildReport(a) {
    const by = {};
    a.annotations.forEach(x => { (by[x.cat] = by[x.cat] || { cat: x.cat, fort: [], faible: [], neutre: [] })[x.kind].push(x); });
    const cats = Object.values(by);
    const weak = cats.filter(c => c.faible.length).map(c => ({ ...c, score: c.faible.reduce((s, x) => s + WEIGHT[x.priority], 0), count: c.faible.length }))
      .sort((p, q) => q.score - p.score || q.count - p.count);
    const strong = cats.filter(c => c.fort.length).map(c => ({ ...c, count: c.fort.length })).sort((p, q) => q.count - p.count);
    const count = k => a.annotations.filter(x => x.kind === k).length;
    return { by, weak, strong, top: weak.slice(0, 3), n: a.annotations.length, nf: count('fort'), nw: count('faible'), nn: count('neutre') };
  }
  const tcBtn = (t, id) => `<button class="tcb" data-seek="${t}" data-ann="${id || ''}" title="Voir dans la vidéo">${fmt(t)}</button>`;
  function appliesTo(ex, format) {
    if (format === 'simple' && (/double/i.test(ex.title) || /^Pas de variante/.test(ex.solo))) return false;
    if (format === 'double' && /en simple/i.test(ex.title)) return false;
    return true;
  }
  function exercisesFor(cat, a) { const all = EXERCISES.filter(e => e.cat === cat); const ok = all.filter(e => appliesTo(e, a.format)); return ok.length ? ok : all; }
  function levelNote(a) {
    return { debutant: 'Niveau débutant : réduisez le volume de moitié et privilégiez la qualité du geste à la vitesse.', intermediaire: '', confirme: 'Niveau confirmé : ajoutez une contrainte de temps ou de précision (zone réduite, tempo élevé).' }[a.level];
  }
  function exHTML(ex, a, open) {
    const ln = levelNote(a);
    return `<details class="ex" ${open ? 'open' : ''}><summary><span>${esc(ex.title)}</span><span class="tag">${esc(catLabel(ex.cat))}</span></summary><div class="body">
      <p><b>Compétence travaillée :</b> ${esc(ex.skill)}</p><p><b>Objectif :</b> ${esc(ex.goal)}</p>
      <b>Consignes</b><ol>${ex.steps.map(s => `<li style="background:none;border:0;padding:0;margin:0">${esc(s)}</li>`).join('')}</ol>
      <p><b>Durée / répétitions :</b> ${esc(ex.dose)}</p>
      <b>Erreurs à éviter</b><ul style="list-style:disc">${ex.mistakes.map(s => `<li style="background:none;border:0;padding:0;margin:0">${esc(s)}</li>`).join('')}</ul>
      <p><b>Critère de réussite :</b> ${esc(ex.success)}</p>
      <p><b>Seul :</b> ${esc(ex.solo)}</p><p><b>Avec partenaire :</b> ${esc(ex.partner)}</p>
      ${a.format === 'double' && ex.double ? `<p><b>En double :</b> ${esc(ex.double)}</p>` : ''}
      ${ln ? `<p><b>Adaptation :</b> ${esc(ln)}</p>` : ''}</div></details>`;
  }
  function reportEmptyReason(a, r) {
    if (!r.n) return 'Cette analyse ne contient encore aucune observation. Ajoutez-en dans l\'onglet Analyser : le rapport se construit uniquement à partir d\'elles.';
    if (!r.nw) return 'Aucun point faible n\'est annoté : Coach ne peut établir ni priorités ni plan d\'entraînement. Ajoutez des observations « Point faible » pour en obtenir.';
    return '';
  }

  function renderReport() {
    const body = $('report-body');
    if (!ensureCurrent()) { body.innerHTML = noAnalysisHTML; return; }
    const a = state.cur, r = buildReport(a), why = reportEmptyReason(a, r);
    let h = pickerHTML();
    h += `<p class="muted" style="margin-bottom:10px">${esc(a.title)} · ${FORMAT[a.format]} · ${LEVEL[a.level]} · ${esc(analysisDate(a))}${a.opponent ? ' · vs ' + esc(a.opponent) : ''}</p>`;
    if (a.objectives) h += `<div class="notice"><b>Objectifs fixés :</b> ${esc(a.objectives)}</div>`;
    h += `<div class="grid-3" style="margin-bottom:14px"><div class="stat-box"><div class="title">Observations</div><div class="val">${r.n}</div></div><div class="stat-box"><div class="title">Points forts</div><div class="val" style="color:var(--fort)">${r.nf}</div></div><div class="stat-box"><div class="title">Points faibles</div><div class="val" style="color:var(--faible)">${r.nw}</div></div></div>`;
    h += '<p class="muted" style="margin-bottom:14px">Ces chiffres reflètent les observations que vous avez notées, pas une mesure automatique du match.</p>';
    if (why) { body.innerHTML = h + `<div class="notice warn">${why}</div>`; bindPicker(renderReport); return; }
    if (r.n < 5) h += '<div class="notice warn">Peu d\'observations (moins de 5) : les priorités ci-dessous sont indicatives. Plus vous annotez, plus elles sont fiables.</div>';

    h += '<h3>Les trois priorités</h3>' + r.top.map((c, i) => `<div class="report-block prio"><div class="n">${i + 1}</div><div><h3>${esc(catLabel(c.cat))} <span class="tag">${c.count} observation(s)</span></h3><div class="muted">Retenu parce que vous l'avez signalé ${c.count} fois (pondération par priorité : ${c.score}).</div></div></div>`).join('');

    h += '<h3 style="margin-top:18px">Points faibles et preuves</h3>' + r.weak.map(c => `<div class="report-block"><h3>${esc(catLabel(c.cat))}</h3><ul>${c.faible.map(x => `<li>${tcBtn(x.t, x.id)} ${x.shot ? '<b>' + esc(x.shot) + '</b> — ' : ''}${esc(x.comment)}${x.correction ? `<div class="muted">Correction : ${esc(x.correction)}</div>` : ''}</li>`).join('')}</ul></div>`).join('');

    h += '<h3 style="margin-top:18px">Points forts</h3>' + (r.strong.length ? r.strong.map(c => `<div class="report-block"><h3>${esc(catLabel(c.cat))}</h3><ul>${c.fort.map(x => `<li>${tcBtn(x.t, x.id)} ${x.shot ? '<b>' + esc(x.shot) + '</b> — ' : ''}${esc(x.comment)}</li>`).join('')}</ul></div>`).join('') : '<p class="muted">Aucun point fort annoté. Pensez aussi à noter ce qui fonctionne : c\'est ce sur quoi vous pouvez vous appuyer.</p>');

    const fixes = a.annotations.filter(x => x.kind === 'faible' && x.correction);
    h += '<h3 style="margin-top:18px">Corrections techniques</h3>' + (fixes.length ? `<div class="report-block"><ul>${fixes.sort((p, q) => p.priority - q.priority || p.t - q.t).map(x => `<li>${tcBtn(x.t, x.id)} <b>${esc(catLabel(x.cat))}</b> (P${x.priority}) — ${esc(x.correction)}</li>`).join('')}</ul></div>` : '<p class="muted">Aucune correction rédigée. Complétez le champ « Correction ou conseil » de vos points faibles.</p>');

    h += '<h3 style="margin-top:18px">Exercices recommandés</h3>' + r.top.map(c => `<div class="muted" style="margin:8px 0 4px">Pour : ${esc(catLabel(c.cat))}</div>` + exercisesFor(c.cat, a).map(e => exHTML(e, a, false)).join('')).join('');
    body.innerHTML = h; bindPicker(renderReport);
  }
  $('report-body').addEventListener('click', e => {
    const b = e.target.closest('[data-seek]'); if (!b) return;
    state.wsOpen = true; showView('analyse');
    const go = () => { seek(+b.dataset.seek); if (b.dataset.ann) { state.selAnn = b.dataset.ann; renderTimeline(); renderAnnList(); } };
    if (state.video.id === state.cur.id) { if (video.readyState >= 1) go(); else video.addEventListener('loadedmetadata', go, { once: true }); }
    else tryAutoLoad(state.cur).then(ok => { if (ok) { renderAnalyse(); video.addEventListener('loadedmetadata', go, { once: true }); } });
  });
  $('btn-print').addEventListener('click', () => window.print());
  function exportAnalysis(a) {
    const blob = new Blob([JSON.stringify({ badsmashCoach: 1, analysis: a }, null, 2)], { type: 'application/json' });
    const l = document.createElement('a'); l.href = URL.createObjectURL(blob); l.download = `badsmash-coach-${slug(a.title)}.json`; l.click(); setTimeout(() => URL.revokeObjectURL(l.href), 2000);
  }
  $('btn-export').addEventListener('click', () => { if (state.cur) exportAnalysis(state.cur); });

  // ---------------------------------------------------------------- Plan d'entraînement
  $('plan-tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-plan]'); if (!b) return;
    state.plan = b.dataset.plan; renderPlan();
  });
  function renderPlan() {
    document.querySelectorAll('#plan-tabs button').forEach(b => b.classList.toggle('on', b.dataset.plan === state.plan));
    const body = $('plan-body');
    if (!ensureCurrent()) { body.innerHTML = noAnalysisHTML; return; }
    const a = state.cur, r = buildReport(a), why = reportEmptyReason(a, r);
    let h = pickerHTML();
    if (why) { body.innerHTML = h + `<div class="notice warn">${why}</div>`; bindPicker(renderPlan); return; }
    const P = r.top, ex = (i, n) => { const l = exercisesFor(P[i % P.length].cat, a); return l[n % l.length]; };
    const own = c => c.faible.filter(x => x.correction).slice(0, 3).map(x => `<li>${tcBtn(x.t, x.id)} ${esc(x.correction)}</li>`).join('');
    const exLine = e => `<b>${esc(e.title)}</b> <span class="muted">(${esc(e.dose)})</span>`;
    h += `<p class="muted" style="margin-bottom:12px">Plan construit à partir de vos ${r.nw} point(s) faible(s) annoté(s) : ${P.map(c => esc(catLabel(c.cat))).join(', ')}.${levelNote(a) ? ' ' + esc(levelNote(a)) : ''}</p>`;

    if (state.plan === 'session') {
      const blocks = [[10, 'Échauffement', 'Mobilité épaules et hanches, déplacements légers, 20 clears sans enjeu.', null]];
      blocks.push([25, 'Priorité 1 · ' + catLabel(P[0].cat), '', ex(0, 0)]);
      if (P.length > 1) blocks.push([20, 'Priorité 2 · ' + catLabel(P[1].cat), '', ex(1, 0)]); else blocks.push([20, 'Renforcement · ' + catLabel(P[0].cat), '', ex(0, 1)]);
      if (P.length > 2) blocks.push([10, 'Priorité 3 · ' + catLabel(P[2].cat), '', ex(2, 0)]);
      blocks.push([10, 'Jeu à thème', 'Jouez des points en appliquant une seule consigne : ' + (P[0].faible.find(x => x.correction) ? P[0].faible.find(x => x.correction).correction : 'votre priorité n°1') + '.', null]);
      blocks.push([5, 'Bilan', 'Notez pour chaque exercice si le critère de réussite est atteint (oui / non). Ces notes servent de base à votre prochaine analyse.', null]);
      h += `<div class="stat-box" style="margin-bottom:12px"><div class="title">Durée totale</div><div class="val">${blocks.reduce((s, b) => s + b[0], 0)} min</div></div>`;
      h += blocks.map(b => `<div class="report-block"><h3>${b[0]} min · ${esc(b[1])}</h3>${b[2] ? `<p class="muted">${esc(b[2])}</p>` : ''}${b[3] ? exHTML(b[3], a, true) : ''}</div>`).join('');
      const ownHtml = P.map(c => own(c) ? `<div class="muted" style="margin-top:8px">Vos corrections — ${esc(catLabel(c.cat))}</div><ul style="list-style:none">${own(c)}</ul>` : '').join('');
      if (ownHtml) h += `<div class="report-block"><h3>Rappel de vos propres corrections</h3>${ownHtml}</div>`;
    } else if (state.plan === '7') {
      const rows = [
        ['J1', `Priorité 1 (${catLabel(P[0].cat)}) : ${exLine(ex(0, 0))}`],
        ['J2', P.length > 1 ? `Priorité 2 (${catLabel(P[1].cat)}) : ${exLine(ex(1, 0))}` : `Renforcement (${catLabel(P[0].cat)}) : ${exLine(ex(0, 1))}`],
        ['J3', 'Repos actif. Revoyez dans l\'onglet Débriefing les passages de priorité 1 (15 min) et notez ce que vous changeriez.'],
        ['J4', `Priorité 1, variante : ${exLine(ex(0, 1))}`],
        ['J5', P.length > 2 ? `Priorité 3 (${catLabel(P[2].cat)}) : ${exLine(ex(2, 0))}` : `Priorité 2, variante : ${exLine(ex(1, 1))}`],
        ['J6', 'Match à thème : appliquez la consigne de la priorité 1, puis celle de la priorité 2 si le premier set se passe bien. Notez les critères de réussite atteints.'],
        ['J7', 'Repos complet.']
      ];
      h += '<div>' + rows.map(x => `<div class="day"><div class="d">${x[0]}</div><div>${x[1]}</div></div>`).join('') + '</div>';
      h += '<h3 style="margin:16px 0 8px">Détail des exercices</h3>' + uniqueEx([ex(0, 0), ex(1, 0), ex(0, 1), ex(2, 0), ex(1, 1)]).map(e => exHTML(e, a, false)).join('');
    } else {
      const w = i => P[i % P.length], wk = (n, c, t0, t1) => `<div class="report-block"><h3>Semaine ${n} · ${esc(c)}</h3>${t0}${t1}</div>`;
      const d = (j, t) => `<div class="day"><div class="d">${j}</div><div>${t}</div></div>`;
      h += wk(1, 'Priorité 1 · ' + catLabel(w(0).cat), d('Séance 1', exLine(ex(0, 0))), d('Séance 2', exLine(ex(0, 1))) + d('Séance 3', 'Jeu à thème sur la consigne n°1, 20 minutes.'));
      h += wk(2, P.length > 1 ? 'Priorité 2 · ' + catLabel(w(1).cat) : 'Consolidation · ' + catLabel(w(0).cat), d('Séance 1', exLine(ex(1, 0))), d('Séance 2', exLine(ex(1, 1))) + d('Séance 3', 'Jeu à thème : consignes n°1 et n°2 combinées.'));
      h += wk(3, P.length > 2 ? 'Priorité 3 · ' + catLabel(w(2).cat) : 'Intégration', d('Séance 1', exLine(ex(2, 0))), d('Séance 2', exLine(ex(2, 1))) + d('Séance 3', 'Matchs d\'entraînement en appliquant vos trois consignes.'));
      h += wk(4, 'Consolidation et bilan', d('Séance 1', 'Reprenez l\'exercice le moins bien réussi des semaines 1 à 3.'), d('Séance 2', 'Séance mixte : un exercice par priorité.') + d('J28–J30', 'Filmez un nouveau match <b>au même format (' + FORMAT[a.format].toLowerCase() + ')</b>, analysez-le dans Coach puis comparez-le à celui-ci dans l\'onglet Historique.'));
      h += '<h3 style="margin:16px 0 8px">Détail des exercices</h3>' + uniqueEx(P.flatMap((c, i) => [ex(i, 0), ex(i, 1)])).map(e => exHTML(e, a, false)).join('');
    }
    body.innerHTML = h; bindPicker(renderPlan);
  }
  const uniqueEx = l => l.filter((e, i) => l.findIndex(x => x.id === e.id) === i);
  $('plan-body').addEventListener('click', e => { if (e.target.closest('[data-seek]')) $('report-body').dispatchEvent(new MouseEvent('click', { bubbles: false })) || reportSeek(e.target.closest('[data-seek]')); });
  function reportSeek(btn) { $('report-body').innerHTML = ''; /* pas utilisé */ }

  // ---------------------------------------------------------------- Débriefing interactif
  function dbItems(a) {
    const f = state.debrief.filter;
    return a.annotations.filter(x => f === 'all' || (f === 'faible' && x.kind === 'faible') || (f === 'fort' && x.kind === 'fort') || (f === 'p1' && x.priority === 1));
  }
  function renderDebrief() {
    const wrap = $('debrief-wrap');
    if (!ensureCurrent()) { wrap.innerHTML = '<div class="card">' + noAnalysisHTML + '</div>'; return; }
    const a = state.cur, items = dbItems(a);
    let h = `<div class="card">${pickerHTML()}<div class="notice">Ce lecteur enchaîne les passages de votre vidéo originale (${CLIP_BEFORE} s avant et ${CLIP_AFTER} s après chaque observation), avec vos commentaires et annotations. Il ne produit pas encore de fichier vidéo : l'export monté avec FFmpeg est une étape ultérieure.</div>
      <div class="row" style="grid-template-columns:auto auto 1fr; align-items:center"><select id="db-filter" aria-label="Passages à revoir"><option value="all">Toutes les observations</option><option value="faible">Points faibles</option><option value="p1">Priorité 1</option><option value="fort">Points forts</option></select><label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" id="db-auto"> Enchaîner automatiquement</label><span></span></div></div>`;
    if (!a.annotations.length) { wrap.innerHTML = h + '<div class="card"><div class="empty">Aucune observation à débriefer. Annotez d\'abord la vidéo.</div></div>'; bindDebriefTop(); return; }
    if (!items.length) { wrap.innerHTML = h + '<div class="card"><div class="empty">Aucun passage ne correspond à ce filtre.</div></div>'; bindDebriefTop(); return; }
    h += `<div class="debrief"><div><div class="stage-wrap"><div class="stage"><video id="db-video" playsinline preload="metadata"></video><canvas id="db-overlay"></canvas><div class="stage-msg hidden" id="db-msg"></div></div><div class="controls"><div class="progressbar"><i id="db-prog"></i></div><div class="ctrl-row"><button class="btn-small" id="db-prev">◀ Précédent</button><button class="btn-main" id="db-replay" style="padding:7px 16px">↻ Rejouer</button><button class="btn-small" id="db-next">Suivant ▶</button><span class="spacer"></span><span class="timecode" id="db-tc"></span></div></div></div></div>
      <div class="db-card" id="db-card"></div></div>
      <div class="card" style="margin-top:18px"><h2>Séquence <span class="muted">${items.length} passage(s)</span></h2><div id="db-seq" class="ann-list" style="max-height:260px"></div></div>`;
    wrap.innerHTML = h; bindDebriefTop();
    $('db-filter').value = state.debrief.filter; $('db-auto').checked = state.debrief.auto;
    if (state.debrief.index >= items.length) state.debrief.index = 0;
    $('db-seq').innerHTML = items.map((x, i) => `<div class="ann ${x.kind}" data-i="${i}" style="cursor:pointer"><div class="top"><span class="tc">${fmt(x.t)}</span><span class="tag">${esc(catLabel(x.cat))}</span><span class="tag ${x.priority === 1 ? 'p1' : ''}">P${x.priority}</span></div><div class="txt">${esc(x.shot || x.comment || x.correction)}</div></div>`).join('');
    $('db-seq').addEventListener('click', e => { const c = e.target.closest('[data-i]'); if (c) playClip(+c.dataset.i); });
    const dv = $('db-video'), dstage = makeStage(dv, $('db-overlay'), () => {
      const cur = dbItems(state.cur)[state.debrief.index]; if (!cur || !cur.shapes || !cur.shapes.length) return [];
      return dv.currentTime >= cur.t - 0.1 && dv.currentTime <= state.debrief.end ? [{ shapes: cur.shapes, color: KIND_COLOR[cur.kind] }] : [];
    });
    dv.addEventListener('timeupdate', () => {
      const cur = dbItems(state.cur)[state.debrief.index]; if (!cur) return;
      const start = Math.max(0, cur.t - CLIP_BEFORE), end = state.debrief.end;
      $('db-prog').style.width = Math.max(0, Math.min(100, (dv.currentTime - start) / (end - start || 1) * 100)) + '%';
      $('db-tc').textContent = fmt(dv.currentTime);
      if (!dv.paused && dv.currentTime >= end) { dv.pause(); if (state.debrief.auto && state.debrief.index < dbItems(state.cur).length - 1) playClip(state.debrief.index + 1); }
      dstage.draw();
    });
    dv.addEventListener('seeked', () => dstage.draw());
    $('db-prev').onclick = () => playClip(Math.max(0, state.debrief.index - 1));
    $('db-next').onclick = () => playClip(Math.min(items.length - 1, state.debrief.index + 1));
    $('db-replay').onclick = () => playClip(state.debrief.index);
    const ready = () => { dv.src = state.video.url; showClipCard(); dv.addEventListener('loadedmetadata', () => playClip(state.debrief.index, true), { once: true }); $('db-msg').classList.add('hidden'); };
    if (state.video.id === a.id && state.video.url) ready();
    else { showClipCard(); tryAutoLoad(a).then(ok => { if (ok) ready(); else relinkUI($('db-msg'), a, ready); }); }
  }
  function bindDebriefTop() {
    bindPicker(renderDebrief);
    $('db-filter').onchange = e => { state.debrief.filter = e.target.value; state.debrief.index = 0; renderDebrief(); };
    $('db-auto').onchange = e => { state.debrief.auto = e.target.checked; };
  }
  function showClipCard() {
    const a = state.cur, items = dbItems(a), x = items[state.debrief.index]; if (!x) return;
    const exs = exercisesFor(x.cat, a), e0 = exs[0];
    $('db-card').innerHTML = `<div class="muted">Passage ${state.debrief.index + 1} / ${items.length}</div>
      <h3 style="margin-top:4px">${esc(catLabel(x.cat))} <span class="tag">${KIND[x.kind]}</span> <span class="tag ${x.priority === 1 ? 'p1' : ''}">P${x.priority}</span></h3>
      <div class="timecode" style="margin-bottom:8px">${fmt(x.t)}</div>
      ${x.shot ? `<p><b>${esc(x.shot)}</b></p>` : ''}${x.comment ? `<p class="lead" style="font-size:.9rem;margin-bottom:8px">${esc(x.comment)}</p>` : ''}
      ${x.correction ? `<div class="notice"><b>À corriger :</b> ${esc(x.correction)}</div>` : ''}
      ${x.kind === 'faible' && e0 ? `<div class="muted" style="margin-bottom:6px">Exercice conseillé pour ce point :</div>${exHTML(e0, a, false)}` : ''}`;
  }
  function playClip(i, noAutoplay) {
    const a = state.cur, items = dbItems(a), x = items[i]; if (!x) return;
    state.debrief.index = i;
    const dv = $('db-video'), start = Math.max(0, x.t - CLIP_BEFORE);
    state.debrief.end = Math.min(dv.duration || x.t + CLIP_AFTER, x.t + CLIP_AFTER);
    dv.currentTime = start; if (!noAutoplay) dv.play().catch(() => { });
    showClipCard();
    $('db-seq').querySelectorAll('.ann').forEach(el => el.classList.toggle('sel', +el.dataset.i === i));
  }

  // ---------------------------------------------------------------- Historique et comparaison
  function histItemHTML(a) {
    const r = buildReport(a);
    return `<div class="hist-item"><div><div class="t">${esc(a.title)}</div><div class="muted">${esc(analysisDate(a))} · ${FORMAT[a.format]} · ${LEVEL[a.level]} · ${r.n} observation(s) (${r.nf} fortes, ${r.nw} faibles)${a.video ? ' · ' + esc(a.video.name) : ''}</div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn-small" data-open="${a.id}">Ouvrir</button><button class="btn-small" data-rep="${a.id}">Rapport</button><button class="btn-small" data-exp="${a.id}">Exporter</button><button class="btn-small danger" data-rm="${a.id}">Supprimer</button></div></div>`;
  }
  function bindHistoryActions(root) {
    root.onclick = async e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.open) openAnalysis(t.dataset.open);
      else if (t.dataset.rep) { selectAnalysis(t.dataset.rep); showView('rapport'); }
      else if (t.dataset.exp) exportAnalysis(state.list.find(a => a.id === t.dataset.exp));
      else if (t.dataset.rm) {
        const a = state.list.find(x => x.id === t.dataset.rm);
        if (!confirm(`Supprimer définitivement « ${a.title} » et ses ${a.annotations.length} observation(s) ?`)) return;
        await dbDelete(a.id); if (state.cur && state.cur.id === a.id) { state.cur = null; state.wsOpen = false; }
        if (state.video.id === a.id) { if (state.video.url) URL.revokeObjectURL(state.video.url); state.video = { id: null, file: null, url: null }; video.removeAttribute('src'); }
        await refreshList(); showView(state.view); toast('Analyse supprimée');
      }
    };
  }
  async function renderHistory() {
    await refreshList();
    $('history-body').innerHTML = (state.list.length ? state.list.map(histItemHTML).join('') : noAnalysisHTML) +
      `<div style="margin-top:12px"><button class="btn-small" id="btn-import">Importer une analyse (JSON)</button><input type="file" id="import-input" accept="application/json,.json" class="hidden"></div>`;
    bindHistoryActions($('history-body'));
    $('btn-import').onclick = () => $('import-input').click();
    $('import-input').onchange = importJSON;
    renderCompare();
  }
  async function importJSON(e) {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text()), a = d && d.analysis;
      if (!a || !Array.isArray(a.annotations) || !a.title || !a.video) throw new Error('structure');
      a.annotations = a.annotations.filter(x => x && isFinite(x.t) && CATEGORIES.some(c => c.id === x.cat) && KIND[x.kind]).map(x => ({ id: newId('o'), t: +x.t, cat: x.cat, kind: x.kind, shot: String(x.shot || ''), comment: String(x.comment || ''), correction: String(x.correction || ''), priority: [1, 2, 3].includes(x.priority) ? x.priority : 2, shapes: Array.isArray(x.shapes) ? x.shapes.filter(s => ['arrow', 'circle', 'zone'].includes(s.type)) : [] }));
      Object.assign(a, { id: newId('an'), userId, format: FORMAT[a.format] ? a.format : 'simple', level: LEVEL[a.level] ? a.level : 'intermediaire', createdAt: Date.now(), updatedAt: Date.now() });
      await dbPut(a); toast('Analyse importée : rattachez la vidéo en l\'ouvrant.'); renderHistory();
    } catch (err) { toast('Fichier invalide : ce n\'est pas une analyse BADSMASH Coach.'); }
  }
  function renderCompare() {
    const box = $('compare-body');
    if (state.list.length < 2) { box.innerHTML = '<p class="muted">Il faut au moins deux analyses pour les comparer.</p>'; return; }
    const sorted = [...state.list].sort((p, q) => analysisDate(p).localeCompare(analysisDate(q)));
    const opts = id => sorted.map(a => `<option value="${a.id}" ${a.id === id ? 'selected' : ''}>${esc(a.title)} · ${esc(analysisDate(a))}</option>`).join('');
    const A0 = sorted[sorted.length - 2].id, B0 = sorted[sorted.length - 1].id;
    box.innerHTML = `<div class="row" style="margin-bottom:12px"><div><label for="cmp-a">Match le plus ancien</label><select id="cmp-a">${opts(A0)}</select></div><div><label for="cmp-b">Match le plus récent</label><select id="cmp-b">${opts(B0)}</select></div></div><div id="cmp-out"></div>`;
    const draw = () => {
      const A = state.list.find(x => x.id === $('cmp-a').value), B = state.list.find(x => x.id === $('cmp-b').value);
      const out = $('cmp-out');
      if (A.id === B.id) { out.innerHTML = '<div class="notice warn">Choisissez deux analyses différentes.</div>'; return; }
      const same = A.format === B.format;
      const ra = buildReport(A), rb = buildReport(B);
      let h = same ? '' : `<div class="notice warn">Un match en ${FORMAT[A.format].toLowerCase()} et un match en ${FORMAT[B.format].toLowerCase()} ne sont pas comparables : aucune évolution n'est calculée, les chiffres sont juste affichés côte à côte.</div>`;
      const cells = c => { const x = ra.by[c] || { fort: [], faible: [] }, y = rb.by[c] || { fort: [], faible: [] }; return [x, y]; };
      const rows = CATEGORIES.filter(c => ra.by[c.id] || rb.by[c.id]).map(c => {
        const [x, y] = cells(c.id), nx = x.fort.length + x.faible.length, ny = y.fort.length + y.faible.length;
        let evo = '<span class="muted">non comparable</span>';
        if (same && nx >= 3 && ny >= 3) {
          const d = Math.round((y.fort.length / ny - x.fort.length / nx) * 100);
          evo = d > 0 ? `<b style="color:var(--fort)">▲ +${d} pts</b>` : d < 0 ? `<b style="color:var(--faible)">▼ ${d} pts</b>` : '=';
        }
        return `<tr><td>${esc(c.label)}</td><td>${x.fort.length} / ${x.faible.length}</td><td>${y.fort.length} / ${y.faible.length}</td><td>${evo}</td></tr>`;
      }).join('');
      h += `<div style="overflow-x:auto"><table class="cmp"><thead><tr><th>Type</th><th>Ancien (forts / faibles)</th><th>Récent (forts / faibles)</th><th>Part de points forts</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">Aucune observation.</td></tr>'}</tbody></table></div>
        <p class="muted" style="margin-top:10px">Une évolution n'est affichée que si le format est identique et si les deux matchs comptent au moins 3 observations dans la catégorie. Elle repose sur ce que vous avez choisi d'annoter, pas sur une mesure automatique : lisez-la comme un indice, pas comme une preuve.</p>`;
      out.innerHTML = h;
    };
    $('cmp-a').onchange = draw; $('cmp-b').onchange = draw; draw();
  }

  // ---------------------------------------------------------------- Démarrage
  window.addEventListener('beforeunload', () => { if (state.video.url) URL.revokeObjectURL(state.video.url); });
  (async function init() {
    await openDB(); await refreshList();
    resetSetup(); showView('dashboard');
  })();
})();