#!/usr/bin/env node
/**
 * test-oc-pricing.js — test del parser del listino OpenCode Go (parseOcConfig).
 *
 * Perché esiste: il listino non è più una tabella statica in server.js, arriva da
 * GET /console/api/config. Se il parser sbaglia la mappa, i prezzi nella pagina
 * Modelli diventano zero o i modelli spariscono, senza nessun errore a runtime.
 * Il parser vive in server.js (non esportato): lo si estrae dal sorgente e si esegue.
 *
 * Uso:  node tests/test-oc-pricing.js     Exit: 0 = OK, 1 = fallito.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
const start = src.indexOf('function parseOcConfig');
const end = src.indexOf('/** Listino in cache');
if (start < 0 || end < start) { console.error('parseOcConfig non trovato in server.js'); process.exit(1); }
const parse = new Function(src.slice(start, end) + '\nreturn parseOcConfig;')();

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
};

// Forma reale (ridotta) di /console/api/config: due provider, solo opencode-go ci interessa.
const payload = {
  config: {
    provider: {
      opencode: { models: { 'claude-opus-5': { name: 'Claude Opus 5', cost: { input: 99, output: 99 } } } },
      'opencode-go': {
        models: {
          'glm-5.3': { name: 'GLM-5.3', cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0.5 } },
          'mimo-v2.6-flash': { name: 'MiMo-V2.6-Flash', cost: { input: 0.14, output: 0.28, cache_read: 0.0028 } },
          'beam-free': { name: 'Beam Free', cost: { input: 0, output: 0, cache_read: 0 } },
          'muse-spark-1.3-contributor': { name: 'Muse Spark 1.3 Contributor', cost: { input: 0.1, output: 0.2 } },
          'no-cost': { name: 'Senza cost' },
        },
      },
    },
  },
};

const p = parse(payload);
check('il provider "opencode" (non Go) è ignorato', !p['claude-opus-5']);
check('modelli Go presenti', Object.keys(p).length === 5, Object.keys(p).join(','));
check('prezzi input/output', p['glm-5.3'].input === 1.4 && p['glm-5.3'].output === 4.4);
check('cache_read mappato', p['glm-5.3'].cacheRead === 0.26);
check('cache_write mappato', p['glm-5.3'].cacheWrite === 0.5);
check('cache_write assente → 0', p['mimo-v2.6-flash'].cacheWrite === 0);
check('nome preservato', p['mimo-v2.6-flash'].name === 'MiMo-V2.6-Flash');
check('contributor → train', p['muse-spark-1.3-contributor'].train === true);
check('non contributor → no train', p['glm-5.3'].train === false);
check('modello free: input/output 0', p['beam-free'].input === 0 && p['beam-free'].output === 0);
check('cost assente → zeri, non crash', p['no-cost'].input === 0 && p['no-cost'].name === 'Senza cost');
check('payload vuoto → mappa vuota', Object.keys(parse({})).length === 0);
check('payload null → mappa vuota', Object.keys(parse(null)).length === 0);

console.log(failures ? '\nFALLITO: ' + failures + ' check' : '\nOK — ' + 'parseOcConfig');
process.exit(failures ? 1 : 0);
