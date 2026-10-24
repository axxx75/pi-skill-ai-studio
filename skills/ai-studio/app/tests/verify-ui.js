#!/usr/bin/env node
/**
 * verify-ui.js — valida il JavaScript che il server EMETTE, non il sorgente.
 *
 * Perché esiste: server.js costruisce la pagina dentro un template literal. Un `\n`
 * scritto nel codice client diventa un a capo reale e rompe il JS del browser: la
 * pagina resta su "Caricamento" e `node --check server.js` non lo vede. Questo script
 * prende la pagina servita, ne estrae lo <script> inline, ne valida la sintassi e ne
 * esegue le funzioni di render con un DOM finto e i dati veri delle API.
 *
 * Uso:  node tests/verify-ui.js [--url http://localhost:8888]
 * Exit: 0 = tutti i check passati, 1 = almeno un check fallito.
 *
 * Non copre CSS/layout (serve un browser): copre sintassi, errori a runtime nel render,
 * struttura del DOM prodotto e shape dei dati consumati.
 */
'use strict';

const BASE = (() => {
  const i = process.argv.indexOf('--url');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'http://localhost:8888';
})();

let failures = 0;
const pass = (name) => console.log('  ✓ ' + name);
const fail = (name, extra) => { failures++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); };
const check = (name, cond, extra) => (cond ? pass(name) : fail(name, extra));

async function getText(url) {
  const r = await fetch(new URL(url, BASE));
  if (!r.ok) throw new Error('HTTP ' + r.status + ' su ' + url);
  return r.text();
}

function makeDom() {
  const el = () => ({
    innerHTML: '', textContent: '', value: '', style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {}, setAttribute() {}, addEventListener() {}, removeChild() {},
    set href(v) {}, click() {},
  });
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, el()); return nodes.get(id); };
  return {
    getElementById: get,
    createElement: el,
    querySelector: el,
    querySelectorAll: () => [],
    body: el(),
    addEventListener() {},
    nodes,
  };
}

async function main() {
  console.log('verify-ui — ' + BASE + '\n');

  // 1. la pagina risponde e contiene uno script inline
  let html;
  try { html = await getText('/'); }
  catch (e) { console.log('  ✗ pagina non raggiungibile: ' + e.message); process.exit(1); }
  check('GET / risponde', html.length > 1000, html.length + ' byte');

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check('script inline presente', scripts.length === 1, scripts.length + ' blocchi');
  if (!scripts.length) process.exit(1);
  const inline = scripts[0];

  // 2. sintassi del JS emesso (il check che mancava)
  try {
    new Function(inline);
    pass('sintassi del JS emesso valida');
  } catch (e) {
    fail('sintassi del JS emesso', e.message);
    console.log('\nIl browser riceve questo errore e non esegue NULLA della pagina.');
    process.exit(1);
  }

  // 3. via la chiamata di init finale (aprirebbe una directory al load)
  const cut = inline.lastIndexOf("openScope('ai-studio');");
  const code = cut > 0 ? inline.slice(0, cut) : inline;

  // 4. dataset reale dalle API
  const apiNames = ['/api/stats', '/api/credits', '/api/credits/history'];
  const data = {};
  for (const name of apiNames) {
    try { data[name] = await (await fetch(new URL(name, BASE))).json(); }
    catch (e) { fail('GET ' + name, e.message); }
  }
  const sessions = (data['/api/stats'] || {}).sessions || [];
  check('API /api/stats risponde con sessioni', sessions.length > 0, sessions.length + ' sessioni');
  if (!sessions.length) { console.log('\nSenza sessioni il render non è verificabile.'); process.exit(1); }

  // 5. esegue il codice emesso con DOM finto e fetch instradato sul server
  const doc = makeDom();
  const routedFetch = (u) => fetch(new URL(String(u), BASE));
  const app = new Function(
    'document', 'window', 'fetch', 'URL', 'Blob', 'console', 'setInterval', 'setTimeout',
    code + '\nreturn { showStats, showCredits, exportStatsCsv, showFrontier, showModels, switchModelTab };'
  )(
    doc,
    { RATE: 0.92, matchMedia: () => ({ matches: false }), addEventListener() {} },
    routedFetch,
    { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    function BlobStub(parts) { this.parts = parts; },
    console, () => 0, () => 0
  );

  const content = () => doc.getElementById('content').innerHTML;

  try {
    await app.showStats();
    pass('showStats() eseguita senza eccezioni');
  } catch (e) {
    fail('showStats()', e.message);
    return finish();
  }
  let h = content();
  check('stats: tabella sessioni renderizzata', h.includes('class="clickable"'));
  const rowCount = (h.match(/class="clickable"/g) || []).length;
  check('stats: una riga per sessione', rowCount === sessions.length, rowCount + ' vs ' + sessions.length);
  check('stats: colonne In/Out/Cache', ['>In<', '>Out<', '>Cache<'].every((c) => h.includes(c)));
  check('stats: header ordinabili', /sortStats\(\d+\)/.test(h));
  check('stats: bottone CSV', h.includes('exportStatsCsv()'));
  check('stats: bottone frontiera', h.includes('showFrontier()'));

  // popup frontiera: si apre, carica /api/frontier e renderizza le barre
  try {
    await app.showFrontier();
    pass('showFrontier() eseguita senza eccezioni');
  } catch (e) {
    fail('showFrontier()', e.message);
  }
  const fb = (doc.nodes.get('frontier-body') || {}).innerHTML || '';
  check('frontiera: barre renderizzate', (fb.match(/frontier-bar/g) || []).length >= 2, (fb.match(/frontier-bar/g) || []).length + ' barre');
  check('frontiera: listino reale usato', fb.includes('Claude Opus'));
  check('frontiera: spesa reale inclusa', fb.includes('Spesa REALE'));

  doc.getElementById('content').innerHTML = '';
  try {
    await app.showCredits();
    pass('showCredits() eseguita senza eccezioni');
  } catch (e) {
    fail('showCredits()', e.message);
    return finish();
  }
  h = content();
  check('crediti: sezione Storico e trend', h.includes('Storico e trend'));
  check('crediti: stato storico esplicito',
        h.includes('Nessun dato') || h.includes('da domani') || h.includes('<svg') || h.includes('<rect'));
  const go = ((data['/api/credits'] || {}).ocgo || {}).go || {};
  check('crediti: quota Go (rolling/mese) dal payload', !!(go.quota && go.quota.rolling && go.quota.monthly), JSON.stringify(go.reason || null));
  check('crediti: spesa reale Console', !!(go.usage && typeof go.usage.total === 'number'), (go.usage || {}).error || '');
  check('crediti: sezione Quota del piano renderizzata', h.includes('Quota del piano'));
  check('crediti: nessun messaggio obsoleto Budgets: Read', !h.includes('Budgets: Read'));

  // tab Modelli: il listino OpenCode Go arriva dall'API, non da una tabella statica
  doc.getElementById('content').innerHTML = '';
  try {
    await app.showModels();
    app.switchModelTab(1);
    pass('showModels() + tab OpenCode Go eseguiti senza eccezioni');
  } catch (e) {
    fail('showModels()', e.message);
    return finish();
  }
  h = content();
  const ocRows = Math.max(0, (h.match(/<tr>/g) || []).length - 1);
  check('modelli: tab OpenCode Go popolato dal listino live', ocRows >= 20, ocRows + ' righe');
  // nota: escapeHtml passa da document.createElement, che qui è uno stub → i testi escapati
  // non compaiono nell'HTML: si verificano solo i marker letterali (classi, stringhe statiche).
  check('modelli: nota listino live presente', h.includes('listino live'));
  check('modelli: celle prezzo renderizzate', (h.match(/class="num">/g) || []).length > 50,
        (h.match(/class="num">/g) || []).length + ' celle');
  check('modelli: nessun errore in pagina', !h.includes('class="error"'));
  check('modelli: nessuna colonna "Limite €/mese" (niente listino statico)', !h.includes('Limite €/mese'));

  // 6. export CSV: header + una riga per sessione
  doc.getElementById('content').innerHTML = '';
  let csv = null;
  try {
    const app2 = new Function(
      'document', 'window', 'fetch', 'URL', 'Blob', 'console', 'setInterval', 'setTimeout',
      code + '\nreturn { showStats, exportStatsCsv };'
    )(doc, { RATE: 0.92 }, routedFetch, { createObjectURL: () => '', revokeObjectURL() {} },
      function (parts) { csv = parts[0]; }, console, () => 0, () => 0);
    await app2.showStats();
    app2.exportStatsCsv();
    pass('exportStatsCsv() eseguita senza eccezioni');
  } catch (e) {
    fail('exportStatsCsv()', e.message);
    return finish();
  }
  const lines = (csv || '').split('\n');
  check('CSV generato', lines.length > 1, lines.length + ' righe');
  check('CSV: header + righe', lines.length === sessions.length + 1, lines.length + ' vs ' + (sessions.length + 1));
  check('CSV: 13 colonne', lines[0].split(',').length === 13, lines[0].split(',').length + ' colonne');

  finish();
}

function finish() {
  console.log('\n' + (failures ? failures + ' CHECK FALLITI' : 'TUTTI I CHECK OK'));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('errore imprevisto: ' + e.stack); process.exit(1); });
