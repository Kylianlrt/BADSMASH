/* BADSMASH — helpers partagés : couleurs de genre + saisie des sets (3 encadrés) */
(function () {
    'use strict';
    const BS = (window.BS = window.BS || {});

    /* ---------- Genre ---------- */
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    BS.esc = esc;

    // 'h' | 'f' | ''
    BS.gender = function (j) {
        if (!j) return '';
        const v = String(typeof j === 'string' ? j : (j.genre || j.sexe || '')).trim().toUpperCase();
        if (['H', 'HOMME', 'M', 'MALE'].includes(v)) return 'h';
        if (['F', 'FEMME', 'D', 'DAME', 'FEMALE'].includes(v)) return 'f';
        return '';
    };
    BS.gClass = function (j) { const g = BS.gender(j); return g ? 'g-' + g : ''; };
    // Nom surligné
    BS.chip = function (name, j, extra) {
        return `<span class="pl ${BS.gClass(j)} ${extra || ''}">${esc(name)}</span>`;
    };
    BS.legend = function () {
        return '<span class="g-legend"><span class="lh"><i></i>Hommes</span><span class="lf"><i></i>Femmes</span></span>';
    };

    /* ---------- Sets ---------- */
    // "21-15" | "21:15" | "21 15" | "21/15" -> {a,b} ; '' -> null ; autre -> 'bad'
    BS.parseSet = function (str) {
        const s = String(str == null ? '' : str).trim();
        if (!s) return null;
        const m = s.match(/^(\d{1,2})\s*[-:\/ ]\s*(\d{1,2})$/);
        if (!m) return 'bad';
        const a = +m[1], b = +m[2];
        if (a === b) return 'bad';
        return { a, b };
    };
    const setWinner = p => (p && p !== 'bad') ? (p.a > p.b ? 1 : 2) : 0;

    // vals = [s1, s2, s3] (chaînes). Retourne l'état de validation.
    BS.evalSets = function (vals) {
        const raw = [0, 1, 2].map(i => String(vals[i] || '').trim());
        const p = raw.map(BS.parseSet);
        const res = { status: 'empty', ok: true, winner: 0, disable3: false, needThird: false, bad: [false, false, false], msg: '', w1: 0, w2: 0, sets: raw };
        if (!raw[0] && !raw[1] && !raw[2]) { res.msg = 'Saisir le set 1 et le set 2 (ex. 21-15).'; return res; }
        p.forEach((x, i) => { if (x === 'bad') res.bad[i] = true; });
        if (res.bad.some(Boolean)) {
            res.status = 'bad'; res.ok = false;
            res.msg = 'Format invalide : écrire « 21-15 » (deux scores différents).';
            return res;
        }
        if (!p[0] || !p[1]) {
            res.status = 'need12'; res.ok = false;
            res.msg = 'Les sets 1 et 2 sont obligatoires.';
            return res;
        }
        const w1 = setWinner(p[0]), w2 = setWinner(p[1]);
        if (w1 === w2) {
            // 2-0 : pas de 3e set
            res.disable3 = true;
            if (raw[2]) { res.status = 'bad'; res.ok = false; res.bad[2] = true; res.msg = 'Un joueur a déjà gagné les 2 premiers sets : pas de 3e set.'; return res; }
            res.status = 'done'; res.winner = w1; res.msg = 'Victoire 2-0 — 3e set inutile.';
            return res;
        }
        // 1-1 : 3e set obligatoire
        res.needThird = true;
        if (!p[2]) { res.status = 'need3'; res.ok = false; res.msg = 'Un set partout : le 3e set est OBLIGATOIRE.'; return res; }
        res.status = 'done'; res.winner = setWinner(p[2]); res.msg = 'Victoire 2-1.';
        return res;
    };

    // Compte de sets gagnés (pour affichage)
    BS.tally = function (vals) {
        let a = 0, b = 0;
        [0, 1, 2].forEach(i => { const p = BS.parseSet(vals[i]); if (p && p !== 'bad') { p.a > p.b ? a++ : b++; } });
        return [a, b];
    };

    // HTML d'un groupe de 3 encadrés. prefix = préfixe d'id (optionnel). values = [s1,s2,s3]
    BS.setsHtml = function (prefix, values, opts) {
        opts = opts || {};
        const v = values || ['', '', ''];
        const id = i => prefix ? ` id="${prefix}${i}"` : '';
        const cell = i => `<label class="set-cell"><span>Set ${i}</span><input type="text" class="set-box" data-set="${i}"${id(i)} value="${esc(v[i - 1] || '')}" placeholder="${i === 3 ? '(si 1-1)' : '21-15'}" inputmode="numeric" maxlength="5" autocomplete="off"></label>`;
        return `<div class="sets-box ${opts.wide ? 'sets-wide' : ''}">${cell(1)}${cell(2)}${cell(3)}<div class="sets-hint"></div></div>`;
    };

    function boxes(root) { return [1, 2, 3].map(i => root.querySelector(`.set-box[data-set="${i}"]`)); }

    BS.readSets = function (root) {
        const b = boxes(root);
        const vals = b.map(x => (x && !x.disabled ? x.value : ''));
        const r = BS.evalSets(vals);
        r.vals = vals.map((x, i) => {
            const p = BS.parseSet(x);
            return p && p !== 'bad' ? `${p.a}-${p.b}` : String(x || '').trim();
        });
        r.score = r.vals.filter(Boolean).join(' / ');
        return r;
    };

    // Met à jour l'état visuel (3e set désactivé / obligatoire / erreurs)
    BS.refreshSets = function (root) {
        const b = boxes(root);
        if (b.some(x => !x)) return null;
        // état avec tout, y compris 3e set même désactivé
        let r = BS.evalSets(b.map(x => x.value));
        // 2-0 : le 3e set n'a pas lieu d'être -> on le vide et on le grise
        if (r.disable3 && b[2].value) { b[2].value = ''; r = BS.evalSets(b.map(x => x.value)); }
        const hint = root.querySelector('.sets-hint');
        b.forEach(x => x.classList.remove('need', 'bad'));
        if (r.disable3 && !b[2].value) { b[2].disabled = true; }
        else { b[2].disabled = false; }
        if (r.status === 'need3') b[2].classList.add('need');
        if (r.status === 'need12') { if (!b[0].value.trim()) b[0].classList.add('need'); if (!b[1].value.trim()) b[1].classList.add('need'); }
        r.bad.forEach((x, i) => { if (x) b[i].classList.add('bad'); });
        if (hint) {
            hint.className = 'sets-hint ' + (r.status === 'need3' || r.status === 'need12' ? 'need' : r.status === 'bad' ? 'bad' : r.status === 'done' ? 'ok' : '');
            hint.textContent = r.msg;
        }
        return r;
    };

    // Active la logique sur un conteneur .sets-box (appeler après insertion dans le DOM)
    BS.bindSets = function (root, onChange) {
        if (!root || root._bsBound) { if (root) BS.refreshSets(root); return; }
        root._bsBound = true;
        const fire = () => { const r = BS.refreshSets(root); if (onChange) onChange(r, root); };
        boxes(root).forEach(x => {
            if (!x) return;
            x.addEventListener('input', fire);
            x.addEventListener('blur', () => {
                const p = BS.parseSet(x.value);
                if (p && p !== 'bad') x.value = `${p.a}-${p.b}`;
                fire();
            });
        });
        fire();
    };
    BS.bindAllSets = function (scope, onChange) {
        (scope || document).querySelectorAll('.sets-box').forEach(r => BS.bindSets(r, onChange));
    };

    BS.setSets = function (root, values) {
        boxes(root).forEach((x, i) => { if (x) x.value = (values && values[i]) || ''; });
        BS.refreshSets(root);
    };
    BS.clearSets = function (root) { BS.setSets(root, ['', '', '']); };

    // Ancien format stocké "21-15 / 21-18" -> ['21-15','21-18','']
    BS.splitScore = function (score) {
        const parts = String(score || '').split(/\s*[\/|;,]\s*/).map(s => s.trim()).filter(Boolean);
        return [parts[0] || '', parts[1] || '', parts[2] || ''];
    };
    BS.formatScore = function (vals) { return vals.map(s => String(s || '').trim()).filter(Boolean).join(' / '); };
    // Vainqueur depuis un score stocké : 1 | 2 | 0
    BS.winnerFromScore = function (score) {
        const r = BS.evalSets(BS.splitScore(score));
        return r.status === 'done' ? r.winner : 0;
    };

    /* ---------- Listes déroulantes teintées ---------- */
    function tint(sel) {
        const o = sel.options && sel.options[sel.selectedIndex];
        sel.classList.remove('g-h', 'g-f');
        if (!o) return;
        if (o.classList.contains('g-h')) sel.classList.add('g-h');
        else if (o.classList.contains('g-f')) sel.classList.add('g-f');
    }
    BS.tintSelects = function (scope) {
        (scope || document).querySelectorAll('select').forEach(s => {
            if (s.querySelector('option.g-h, option.g-f')) tint(s);
        });
    };
    document.addEventListener('change', e => { if (e.target && e.target.tagName === 'SELECT') tint(e.target); }, true);
    let pending = false;
    const schedule = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; BS.tintSelects(); }); };
    function start() {
        BS.tintSelects();
        try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
        setInterval(() => BS.tintSelects(), 800); // valeurs changées par code
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
