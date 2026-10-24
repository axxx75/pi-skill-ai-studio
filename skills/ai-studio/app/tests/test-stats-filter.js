#!/usr/bin/env node
/**
 * test-stats-filter.js — test della generalizzazione: totali solo per i provider
 * supportati, scorciatoie inesistenti nascoste, catalogo assente = prezzi n/d.
 *
 * Perché esiste: Stats somma tutti i modelli trovati nei JSONL. Senza filtro, sessioni
 * con provider diversi da openrouter/opencode-go (es. `router` dei subagent) entrano nei
 * totali e nei costi. Qui si avvia il server su una porta libera con 2 sessioni finte,
 * una supportata e una no, e si verificano le risposte API.
 *
 * Uso:  node app/tests/test-stats-filter.js     Exit: 0 = OK, 1 = fallito.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-studio-filter-'));

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
};
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

function seedSessions() {
  const dir = path.join(TMP, 'sessions', '--demo--');
  fs.mkdirSync(dir, { recursive: true });
  const write = (id, provider, model, cost) => {
    const lines = [
      { type: 'session', version: 3, id, timestamp: '2026-01-01T10:00:00.000Z', cwd: '/tmp/demo' },
      { type: 'message', timestamp: '2026-01-01T10:00:01.000Z', message: { role: 'assistant', provider, model, usage: { input: 1, output: 1, totalTokens: 2, cost: { total: cost } }, content: [] } },
    ];
    fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  write('supported', 'openrouter', 'openai/gpt-5', 1);
  write('unsupported', 'router', 'anonimo', 5);
  // pi scrive i risultati dei tool con role "toolResult" (non "tool"): deve contare come msg tool
  const withTool = [
    { type: 'session', version: 3, id: 'withtool', timestamp: '2026-01-02T10:00:00.000Z', cwd: '/tmp/demo' },
    { type: 'message', timestamp: '2026-01-02T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'ciao' }] } },
    { type: 'message', timestamp: '2026-01-02T10:00:02.000Z', message: { role: 'assistant', provider: 'openrouter', model: 'openai/gpt-5', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, content: [] } },
    { type: 'message', timestamp: '2026-01-02T10:00:03.000Z', message: { role: 'toolResult', toolCallId: 't1', toolName: 'bash', isError: false, durationMs: 42, content: [] } },
  ];
  fs.writeFileSync(path.join(dir, 'withtool.jsonl'), withTool.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

async function main() {
  seedSessions();
  const agentDir = path.join(TMP, 'agent'); // senza auth.json e senza models-store.json
  fs.mkdirSync(agentDir, { recursive: true });
  const config = path.join(TMP, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    shortcuts: [
      { name: 'existing', label: 'OK', root: path.join(TMP, 'sessions') },
      { name: 'missing', label: 'NOPE', root: path.join(TMP, 'does-not-exist') },
    ],
  }));

  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      AI_STUDIO_SESSIONS_DIR: path.join(TMP, 'sessions'),
      AI_STUDIO_STATS_DIR: path.join(TMP, 'stats'),
      AI_STUDIO_CONFIG: config,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));

  const base = 'http://127.0.0.1:' + port;
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await fetch(base + '/')).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    if (!up) { check('server avviato', false, base); return finish(); }
    check('server avviato su porta libera', true);

    const stats = await (await fetch(base + '/api/stats')).json();
    check('totali: solo sessioni supportate', stats.summary.sessions === 2, String(stats.summary.sessions));
    check('totali: costo esclude il provider non supportato', stats.summary.totalCost === 1, String(stats.summary.totalCost));
    check('totali: token esclusi', stats.summary.totalTokens === 4, String(stats.summary.totalTokens));
    check('totali: "non supportati" conta la sessione esclusa', stats.summary.unsupportedSessions === 1, String(stats.summary.unsupportedSessions));
    check('byModel: solo provider supportati', stats.byModel.length === 1 && stats.byModel[0].model.startsWith('openrouter/'), JSON.stringify(stats.byModel.map((m) => m.model)));
    check('tabella sessioni: solo le supportate', stats.sessions.length === 2, String(stats.sessions.length));
    check('msg tool: role toolResult contato', stats.summary.toolMsgs === 1, String(stats.summary.toolMsgs));
    check('msg user: contati', stats.summary.userMsgs === 1, String(stats.summary.userMsgs));

    const html = await (await fetch(base + '/')).text();
    check('sidebar: scorciatoia esistente mostrata', html.includes("openScope('existing')"));
    check('sidebar: scorciatoia inesistente nascosta', !html.includes("openScope('missing')"));

    const frontier = await (await fetch(base + '/api/frontier')).json();
    check('catalogo assente: prezzi n/d', frontier.catalog === false && /n\/d/.test(frontier.note || ''), JSON.stringify(frontier).slice(0, 120));

    const doc = await (await fetch(base + '/api/doctor')).json();
    const catalog = (doc.checks || []).find((c) => c.name === 'catalogo modelli') || {};
    check('doctor: catalogo assente = WARN', catalog.status === 'WARN', catalog.status + ' ' + catalog.detail);
    const portCheck = (doc.checks || []).find((c) => c.name === 'porta libera') || {};
    check('doctor: la propria porta è un PASS', portCheck.status === 'PASS', portCheck.detail);
  } finally {
    child.kill();
  }
  finish();
}

function finish() {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' CHECK FALLITI' : 'TUTTI I CHECK OK'));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('errore imprevisto: ' + e.stack); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
