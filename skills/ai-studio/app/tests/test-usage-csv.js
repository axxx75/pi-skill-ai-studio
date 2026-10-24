#!/usr/bin/env node
/**
 * test-usage-csv.js — test del parser CSV della Console OpenCode (parseOcUsageCsv).
 *
 * Perché esiste: il CSV ha user_name libero (può contenere virgole e virgolette) e
 * cost_micro_cents da convertire in USD (÷1e8). Un errore qui sbaglia la spesa mostrata.
 * Il parser vive in server.js (non esportato): lo si estrae dal sorgente e si esegue.
 *
 * Uso:  node tests/test-usage-csv.js     Exit: 0 = OK, 1 = fallito.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
const start = src.indexOf('function parseOcUsageCsv');
const end = src.indexOf('/** Dati OpenCode Go remoti');
if (start < 0 || end < start) { console.error('parser non trovato in server.js'); process.exit(1); }
const parse = new Function(src.slice(start, end) + '\nreturn parseOcUsageCsv;')();

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
};

const HEAD = 'day,user_type,user_id,user_name,provider,model,requests,input_tokens,output_tokens,' +
             'cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,cost_micro_cents';
const csv = [
  HEAD,
  '2026-10-23,service_account,svc_1,"Legacy: a, b (test)",opencode-go,glm-5.3,8,1000,500,2000,0,0,100000000',
  '2026-10-23,service_account,svc_1,plain,opencode-go,glm-5.3,2,0,0,0,0,0,50000000',
  '2026-10-22,service_account,svc_1,"e ""quoted"" name",opencode-go,deepseek-v4.1-flash,3,10,20,30,0,0,25000000',
].join('\r\n'); // la Console serve CRLF

const r = parse(csv);
check('nessun errore', !r.error, r.error);
check('virgola dentro le virgolette non spezza la riga', r.by_model[0].requests === 10, JSON.stringify(r.by_model[0]));
check('virgolette escapate ("" )', r.days.length === 2, r.days.length + ' giorni');
check('USD = micro_cents / 1e8', r.total === 1.75, r.total);
check('total', r.total === 1.75, r.total);
check('today (nessuna riga di oggi se la data non è 2026-10-23)', typeof r.today === 'number', r.today);
check('media/giorno', r.avg_day === 0.875, r.avg_day);
check('ordinamento per modello per spesa', r.by_model.map((m) => m.model).join(',') === 'glm-5.3,deepseek-v4.1-flash', r.by_model.map((m) => m.model).join(','));
check('token aggregati', r.by_model[0].cacheRead === 2000, r.by_model[0].cacheRead);
check('CSV vuoto → errore gestito', !!parse('').error);

process.exit(failures ? 1 : 0);
