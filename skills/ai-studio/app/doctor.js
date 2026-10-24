#!/usr/bin/env node
/**
 * doctor.js — diagnostica dell'installazione AI-studio.
 *
 * Perché esiste: la dashboard legge auth.json, il catalogo modelli, le sessioni e una
 * dir di stats. Se uno di questi manca, la UI mostra zeri o pagine vuote senza dire
 * perché. `doctor` controlla ogni dipendenza e dice cosa fare.
 *
 * Uso:  node app/doctor.js [--json]      Exit: 0 = nessun FAIL, 1 = almeno un FAIL.
 * API:  const doctor = require('./doctor.js'); await doctor.check()
 *
 * Env:  HOME, PI_CODING_AGENT_DIR, AI_STUDIO_SESSIONS_DIR, AI_STUDIO_STATS_DIR, PORT.
 * Voci WARN non fanno fallire il comando: sono opzionali o degradate (es. catalogo assente).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const HOME = process.env.HOME || os.homedir();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi', 'agent');
const SESSIONS_DIR = process.env.AI_STUDIO_SESSIONS_DIR || path.join(AGENT_DIR, 'sessions');
const STATS_DIR = process.env.AI_STUDIO_STATS_DIR || path.join(HOME, '.local', 'share', 'ai-studio', 'stats');
const AUTH_FILE = path.join(AGENT_DIR, 'auth.json');
const CATALOG_FILE = path.join(AGENT_DIR, 'models-store.json');
const SUPPORTED_PROVIDERS = ['openrouter', 'opencode-go'];

// Campi che la UI usa davvero. `toolCall` è un blocco dentro content dei messaggi assistant.
const FIELDS = [
  ['usage.cost', (m) => !!(m.usage && m.usage.cost && typeof m.usage.cost.total === 'number')],
  ['usage.totalTokens', (m) => !!(m.usage && typeof m.usage.totalTokens === 'number')],
  ['durationMs', (m) => typeof m.durationMs === 'number'],
  ['model', (m) => !!m.model],
  ['provider', (m) => !!m.provider],
  ['toolCall', (m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === 'toolCall')],
];

const cov = (n, total) => (total ? n + '/' + total + ' sessioni' : 'n/d');

function scanSessions(dir) {
  const out = { files: 0, sessions: 0, badLines: 0, filesWithBadLines: 0, coverage: {}, providers: {} };
  for (const [name] of FIELDS) out.coverage[name] = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      out.files++;
      let text;
      try { text = fs.readFileSync(fp, 'utf-8'); } catch { out.filesWithBadLines++; continue; }
      const flags = {};
      let isSession = false;
      let localBad = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { localBad++; continue; }
        if (o.type === 'session') isSession = true;
        if (o.type !== 'message') continue;
        const m = o.message || {};
        for (const [name, test] of FIELDS) if (test(m)) flags[name] = true;
        if (m.usage && m.provider) out.providers[m.provider] = (out.providers[m.provider] || 0) + 1;
      }
      out.badLines += localBad;
      if (localBad) out.filesWithBadLines++;
      if (!isSession) continue;
      out.sessions++;
      for (const [name] of FIELDS) if (flags[name]) out.coverage[name]++;
    }
  };
  walk(dir);
  return out;
}

function checkAuth() {
  let auth;
  try { auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); }
  catch (e) { return { status: 'FAIL', detail: AUTH_FILE + ': ' + e.message }; }
  const missing = SUPPORTED_PROVIDERS.filter((p) => !auth[p]);
  if (!missing.length) return { status: 'PASS', detail: AUTH_FILE + ' leggibile; provider: ' + SUPPORTED_PROVIDERS.join(', ') };
  if (missing.length === SUPPORTED_PROVIDERS.length) return { status: 'FAIL', detail: AUTH_FILE + ': nessun provider supportato (mancano ' + missing.join(', ') + ')' };
  return { status: 'WARN', detail: AUTH_FILE + ' leggibile; manca: ' + missing.join(', ') };
}

function checkCatalog() {
  try {
    const cat = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8'));
    const n = (((cat.openrouter || {}).models) || []).length;
    return { status: 'PASS', detail: CATALOG_FILE + ' (' + n + ' modelli openrouter)' };
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 'WARN', detail: CATALOG_FILE + ' assente (opzionale: prezzi n/d)' };
    return { status: 'WARN', detail: CATALOG_FILE + ' non leggibile (prezzi n/d): ' + e.message };
  }
}

function checkSessions() {
  let readable = true;
  try { fs.readdirSync(SESSIONS_DIR); } catch { readable = false; }
  if (!readable) return { status: 'FAIL', detail: SESSIONS_DIR + ' non leggibile' };
  const s = scanSessions(SESSIONS_DIR);
  if (!s.sessions) {
    return { status: 'WARN', detail: SESSIONS_DIR + ': ' + s.files + ' file .jsonl, nessuna sessione valida (' + s.badLines + ' righe illeggibili saltate)' };
  }
  return { status: 'PASS', detail: SESSIONS_DIR + ': ' + s.sessions + ' sessioni valide su ' + s.files + ' file .jsonl' };
}

function checkStatsDir() {
  const probe = path.join(STATS_DIR, '.doctor-' + process.pid);
  try {
    fs.mkdirSync(STATS_DIR, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { status: 'PASS', detail: STATS_DIR + ' scrivibile' };
  } catch (e) {
    return { status: 'FAIL', detail: STATS_DIR + ': ' + e.message };
  }
}

function checkPort(portNumber) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve({ status: 'FAIL', detail: '127.0.0.1:' + portNumber + ' non disponibile (' + (e.code || e.message) + ')' }));
    srv.once('listening', () => srv.close(() => resolve({ status: 'PASS', detail: '127.0.0.1:' + portNumber + ' libera' })));
    srv.listen(portNumber, '127.0.0.1');
  });
}

/**
 * @param {{port?:number, selfPort?:number}} [opts] selfPort = porta su cui gira il server
 *   che ha chiesto il check: in quel caso "occupata da sé" è un PASS, non un FAIL.
 */
async function check(opts) {
  const o = opts || {};
  const portNumber = Number(o.port || process.env.PORT) || 8888;
  const checks = [];

  const nodeMajor = Number(String(process.versions.node).split('.')[0]);
  checks.push({ name: 'node >= 18', ...(nodeMajor >= 18
    ? { status: 'PASS', detail: 'v' + process.versions.node }
    : { status: 'FAIL', detail: 'v' + process.versions.node + ': serve Node >= 18' }) });

  checks.push({ name: 'auth.json + provider', ...checkAuth() });
  checks.push({ name: 'catalogo modelli', ...checkCatalog() });
  checks.push({ name: 'sessions dir', ...checkSessions() });

  const scan = scanSessions(SESSIONS_DIR);
  const detail = FIELDS.map(([name]) => name + ' ' + cov(scan.coverage[name], scan.sessions)).join(' · ');
  checks.push({ name: 'copertura campi', status: scan.sessions ? 'PASS' : 'WARN', detail: scan.sessions ? detail : 'n/d: nessuna sessione' });
  const providers = Object.keys(scan.providers).sort();
  checks.push({
    name: 'righe JSONL illeggibili',
    status: scan.badLines ? 'WARN' : 'PASS',
    detail: scan.badLines ? scan.badLines + ' righe saltate (' + scan.filesWithBadLines + ' file)' : '0 righe saltate' + (providers.length ? ' · provider visti: ' + providers.join(', ') : ''),
  });

  checks.push({ name: 'stats dir', ...checkStatsDir() });

  const portCheck = (o.selfPort && Number(o.selfPort) === portNumber)
    ? { status: 'PASS', detail: '127.0.0.1:' + portNumber + ' in ascolto (questa istanza)' }
    : await checkPort(portNumber);
  checks.push({ name: 'porta libera', ...portCheck });

  return {
    ok: !checks.some((c) => c.status === 'FAIL'),
    checks,
    env: { home: HOME, agentDir: AGENT_DIR, sessionsDir: SESSIONS_DIR, statsDir: STATS_DIR, port: portNumber },
  };
}

module.exports = { check };

if (require.main === module) {
  check().then((report) => {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('AI-studio doctor\n');
      for (const c of report.checks) {
        console.log('  ' + c.status.padEnd(4) + '  ' + c.name.padEnd(24) + '  ' + c.detail);
      }
      const fail = report.checks.filter((c) => c.status === 'FAIL').length;
      const warn = report.checks.filter((c) => c.status === 'WARN').length;
      console.log('\nEsito: ' + (report.ok ? 'OK' : 'FALLITO') + ' (' + fail + ' FAIL, ' + warn + ' WARN)');
    }
    process.exit(report.ok ? 0 : 1);
  }).catch((e) => { console.error('doctor: ' + e.stack); process.exit(1); });
}
