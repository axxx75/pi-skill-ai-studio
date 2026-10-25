#!/usr/bin/env node
/**
 * AI-studio Explorer — server web per navigare AI-studio e il backend pi
 * Zero dipendenze: usa solo http e fs built-in di Node.js
 * Avvio: node server.js  (porta 8888, fallback 8889)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const trace = require('./trace.js');
const doctor = require('./doctor.js');

const HOME = process.env.HOME || os.homedir();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi', 'agent');
const SESSIONS_DIR = process.env.AI_STUDIO_SESSIONS_DIR || path.join(AGENT_DIR, 'sessions');
const STATS_DIR = process.env.AI_STUDIO_STATS_DIR || path.join(HOME, '.local', 'share', 'ai-studio', 'stats');
const CONFIG_FILE = process.env.AI_STUDIO_CONFIG || path.join(HOME, '.config', 'ai-studio', 'config.json');
// app -> skills/ai-studio -> skills -> radice del pacchetto (se installata da sola, resta la skill dir)
const PKG_ROOT = path.join(__dirname, '..', '..', '..');
// 'deepseek': record legacy (sessione 01a1560f) con usage senza `provider` dichiarato ->
// trace.js forma la chiave dal solo modello (che contiene gia' uno slash). Senza qui la
// sessione finisce in 'non supportati' e i totali Stats perdono ~0.5% (divergenza vs
// la dashboard storica, rimossa 2026-10-25 su richiesta di Axxx).
const SUPPORTED_PROVIDERS = ['openrouter', 'opencode-go', 'deepseek'];

// Scorciatoie predefinite. Override (facoltativo) in AI_STUDIO_CONFIG, default
// ~/.config/ai-studio/config.json: {"shortcuts":[{name,label,root}],"quicks":[{label,path,section}]}.
// Una voce la cui dir/file non esiste viene scartata: niente link morti nella sidebar.
const DEFAULT_SHORTCUTS = [
  { name: 'ai-studio', label: '📁 AI-studio', root: path.join(HOME, 'PI', 'AI-studio') },
  { name: 'pi-memory', label: '🧠 pi-memory', root: path.join(AGENT_DIR, 'memory') },
  { name: 'pi-config', label: '⚙️ pi-config', root: AGENT_DIR },
  { name: 'pi-skills', label: '🛠️ pi-skills', root: path.join(AGENT_DIR, 'skills') },
  { name: 'pi-web-ui', label: '🌐 pi-web-ui', root: path.join(HOME, '.pi-web') },
  { name: 'pi-docs', label: '📄 PI-docs', root: path.join(HOME, 'PI') },
];
const DEFAULT_QUICKS = [
  { label: 'AI-studio README', path: path.join(PKG_ROOT, 'README.md'), section: 'Quick' },
  { label: 'MEMORY.md', path: path.join(AGENT_DIR, 'memory', 'MEMORY.md'), section: 'Quick' },
  { label: 'settings.json', path: path.join(AGENT_DIR, 'settings.json'), section: 'Quick' },
  { label: 'SETUP.md', path: path.join(HOME, 'PI', 'ecosystem', 'SETUP.md'), section: 'Quick' },
  { label: '.bashrc', path: path.join(HOME, '.bashrc'), section: 'Quick' },
  { label: 'Daily logs', path: path.join(AGENT_DIR, 'memory', 'daily'), section: 'Log' },
  { label: 'pi-web-ui log', path: '/tmp/pi-web-ui.log', section: 'Log' },
];

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; }
}
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const CONFIG = loadConfig();
const SHORTCUTS = (Array.isArray(CONFIG.shortcuts) ? CONFIG.shortcuts : DEFAULT_SHORTCUTS)
  .filter(s => s && s.name && s.root && exists(s.root));
const QUICKS = (Array.isArray(CONFIG.quicks) ? CONFIG.quicks : DEFAULT_QUICKS)
  .filter(q => q && q.label && q.path && exists(q.path));
const scopeRoots = Object.fromEntries(SHORTCUTS.map(s => [s.name, s.root]));
const BASES = SHORTCUTS.map(s => ({ name: s.name, root: s.root }));

function safeResolve(p) {
  const resolved = path.resolve(p);
  // HOME, /tmp, il pacchetto e le radici configurate nella sidebar: niente path arbitrari.
  const roots = [HOME, '/tmp', PKG_ROOT].concat(SHORTCUTS.map(s => s.root));
  const allowed = roots.some(r => resolved === r || resolved.startsWith(r + path.sep));
  if (!allowed) throw new Error('Access denied: ' + p);
  return resolved;
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));
}

function mime(p) {
  if (p.endsWith('.js')) return 'application/javascript';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.md')) return 'text/markdown';
  return 'text/plain';
}

function readFile(p) {
  try {
    const sp = safeResolve(p);
    if (!fs.existsSync(sp)) return { error: 'Not found' };
    const stat = fs.statSync(sp);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(sp, { withFileTypes: true });
      return {
        path: p,
        type: 'directory',
        entries: entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        })).sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === 'directory' ? -1 : 1;
        }),
      };
    }
    const content = fs.readFileSync(sp, 'utf-8');
    return { path: p, type: 'file', content, size: stat.size, mime: mime(p) };
  } catch (err) {
    return { error: err.message };
  }
}

function searchFiles(dir, query, max = 50) {
  const results = [];
  function walk(d) {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          walk(fp);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          try {
            const text = fs.readFileSync(fp, 'utf-8');
            if (text.toLowerCase().includes(query.toLowerCase())) {
              results.push({ path: fp, snippet: text.slice(0, 200).replace(/\n/g, ' ') });
              if (results.length >= max) return;
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  walk(dir);
  return results;
}

function apiLs(url) {
  const p = new URL(url, 'http://localhost').searchParams.get('path') || HOME;
  return readFile(p);
}

function apiRead(url) {
  const p = new URL(url, 'http://localhost').searchParams.get('path') || HOME;
  return readFile(p);
}

function apiSearch(url) {
  const u = new URL(url, 'http://localhost');
  const q = u.searchParams.get('q') || '';
  const scope = u.searchParams.get('scope') || 'ai-studio';
  const base = scope === 'all'
    ? HOME
    : (BASES.find(b => b.name.toLowerCase() === scope.toLowerCase())?.root || HOME);
  return { query: q, scope, results: searchFiles(base, q) };
}

function apiSystem() {
  const out = {};
  try {
    out.crontab = execSync('crontab -l 2>/dev/null || echo "(nessun crontab)"', { encoding: 'utf-8', cwd: HOME });
  } catch (e) { out.crontab = String(e.stderr || e); }
  try {
    out.env = Object.entries(process.env)
      .filter(([k]) => /PI_|OPENROUTER_|HOME|PATH|NODE|USER/.test(k))
      .map(([k, v]) => `${k}=${v}`).sort().join('\n');
  } catch (e) { out.env = String(e); }
  try {
    const procs = execSync('ps -o pid,comm,args --no-headers -u "' + process.env.USER + '" | head -30', { encoding: 'utf-8' });
    out.processes = procs;
  } catch (e) { out.processes = String(e.stderr || e); }
  return out;
}

function apiPackages() {
  try {
    const p = path.join(HOME, '.pi', 'agent', 'npm', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {} };
  } catch (e) { return { error: e.message }; }
}

function parseSession(fp) {
  const out = { file: fp, id: null, parentSession: null, workspace: null, start: null, end: null, userMsgs: 0, assistantMsgs: 0, toolMsgs: 0, totalTokens: 0, totalCost: 0, byModel: {}, messages: [] };
  let lastModel = null;
  const lines = fs.readFileSync(fp, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session') { out.id = o.id; out.workspace = o.cwd; out.start = o.timestamp; out.parentSession = o.parentSession || null; }
    if (o.type === 'model_change') { if (o.modelId) lastModel = o.modelId; out.end = out.end || o.timestamp; }
    if (o.type === 'message') {
      const m = o.message || {};
      const role = m.role || '?';
      const ts = o.timestamp || m.timestamp;
      out.end = ts || out.end;
      const provider = m.provider || null;
      const model = (provider && m.model) ? provider + '/' + m.model : (m.model || o.modelId || lastModel || 'unknown');
      if (role === 'user') out.userMsgs++;
      else if (role === 'assistant') out.assistantMsgs++;
      else if (role === 'tool' || role === 'toolResult') out.toolMsgs++;
      const u = m.usage;
      if (u) {
        const tok = u.totalTokens || 0;
        const cost = (u.cost && u.cost.total) || 0;
        out.totalTokens += tok;
        out.totalCost += cost;
        if (!out.byModel[model]) out.byModel[model] = { msgs: 0, tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
        out.byModel[model].msgs++;
        out.byModel[model].tokens += tok;
        out.byModel[model].cost += cost;
        out.byModel[model].input += u.input || 0;
        out.byModel[model].output += u.output || 0;
        out.byModel[model].cacheRead += u.cacheRead || 0;
        out.byModel[model].cacheWrite += u.cacheWrite || 0;
        out.byModel[model].reasoning += u.reasoning || 0;
        out.messages.push({ ts, role, model, tok, cost, input: u.input || 0, output: u.output || 0, reasoning: u.reasoning || 0 });
      }
    }
  }
  return out;
}

/** Primo rigo di un file JSONL (o '' se illeggibile). */
function firstLine(fp) {
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf-8').split('\n')[0];
  } catch { return ''; }
}

/**
 * Solo le sessioni vere: gli artefatti in `subagent-artifacts/` sono transcript
 * (primo rigo `recordType:"message"`), non sessioni → generavano righe vuote in Stats.
 * Stesso filtro di `trace.js` (`!hasSession`).
 */
function isSessionFile(fp) {
  try { return JSON.parse(firstLine(fp)).type === 'session'; } catch { return false; }
}

function apiStats() {
  const sessionsDir = SESSIONS_DIR;
  const sessions = [];
  try {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.name.endsWith('.jsonl') && isSessionFile(fp)) sessions.push(parseSession(fp));
      }
    };
    walk(sessionsDir);
  } catch (e) { return { error: e.message }; }
  sessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const summary = { sessions: 0, userMsgs: 0, assistantMsgs: 0, toolMsgs: 0, totalTokens: 0, totalCost: 0, subSessions: 0, subTokens: 0, subCost: 0, firstSession: null, lastSession: null, byDay: {}, unsupportedSessions: 0 };
  const byModel = {};
  const supported = (k) => SUPPORTED_PROVIDERS.some(p => k.startsWith(p + '/'));
  const rows = [];
  for (const s of sessions) {
    // Solo i provider supportati entrano nei totali; una sessione con usage ma senza
    // nessun provider supportato viene contata a parte e scartata dalla tabella.
    const all = Object.entries(s.byModel);
    const kept = all.filter(([k]) => supported(k));
    if (!kept.length && all.length) { summary.unsupportedSessions += 1; continue; }
    let totalTokens = 0, totalCost = 0;
    for (const [, m] of kept) { totalTokens += m.tokens; totalCost += m.cost; }
    s.totalTokens = totalTokens;
    s.totalCost = totalCost;
    s.byModel = Object.fromEntries(kept);
    rows.push(s);
    // Le sessioni subagent non sono sessioni utente: messaggi/turni a parte, costo nei totali.
    if (s.parentSession) {
      summary.subSessions += 1;
      summary.subTokens += s.totalTokens;
      summary.subCost += s.totalCost;
    } else {
      summary.sessions += 1;
      summary.userMsgs += s.userMsgs;
      summary.assistantMsgs += s.assistantMsgs;
      summary.toolMsgs += s.toolMsgs;
    }
    summary.totalTokens += s.totalTokens;
    summary.totalCost += s.totalCost;
    if (s.start && (!summary.firstSession || s.start < summary.firstSession)) summary.firstSession = s.start;
    if (s.end && (!summary.lastSession || s.end > summary.lastSession)) summary.lastSession = s.end;
    const day = (s.start || '').slice(0, 10);
    if (day) {
      if (!summary.byDay[day]) summary.byDay[day] = { cost: 0, tokens: 0, msgs: 0, sessions: 0, subCost: 0 };
      summary.byDay[day].cost += s.totalCost;
      summary.byDay[day].tokens += s.totalTokens;
      if (s.parentSession) summary.byDay[day].subCost += s.totalCost;
      else {
        summary.byDay[day].msgs += s.assistantMsgs;
        summary.byDay[day].sessions += 1;
      }
    }
    for (const [model, m] of Object.entries(s.byModel)) {
      if (!byModel[model]) byModel[model] = { msgs: 0, tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessions: new Set() };
      byModel[model].msgs += m.msgs;
      byModel[model].tokens += m.tokens;
      byModel[model].cost += m.cost;
      byModel[model].input += m.input;
      byModel[model].output += m.output;
      byModel[model].cacheRead += m.cacheRead;
      byModel[model].cacheWrite += m.cacheWrite;
      byModel[model].reasoning += m.reasoning;
      byModel[model].sessions.add(s.id);
    }
  }
  const byModelArr = Object.entries(byModel).map(([model, m]) => ({ model, msgs: m.msgs, tokens: m.tokens, cost: m.cost, input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, reasoning: m.reasoning, sessions: m.sessions.size, pct: summary.totalCost ? (m.cost / summary.totalCost * 100) : 0 })).sort((a, b) => b.cost - a.cost);
  const byDayArr = Object.entries(summary.byDay).map(([date, d]) => ({ date, ...d })).sort((a, b) => a.date.localeCompare(b.date));
  return {
    ocgo: apiOcLocalUsage(ocPricingCached()),
    summary: { sessions: summary.sessions, userMsgs: summary.userMsgs, assistantMsgs: summary.assistantMsgs, toolMsgs: summary.toolMsgs, totalTokens: summary.totalTokens, totalCost: summary.totalCost, subSessions: summary.subSessions, subTokens: summary.subTokens, subCost: summary.subCost, firstSession: summary.firstSession, lastSession: summary.lastSession, byDay: byDayArr, unsupportedSessions: summary.unsupportedSessions },
    byModel: byModelArr,
    sessions: rows.filter(s => !s.parentSession).map(s => ({ file: s.file, id: s.id, workspace: s.workspace, start: s.start, end: s.end, userMsgs: s.userMsgs, assistantMsgs: s.assistantMsgs, toolMsgs: s.toolMsgs, totalTokens: s.totalTokens, totalCost: s.totalCost, byModel: Object.entries(s.byModel).map(([m, v]) => ({ model: m, msgs: v.msgs, tokens: v.tokens, cost: v.cost, input: v.input, output: v.output, cacheRead: v.cacheRead })) }))
  };
}

function apiSession(file) {
  try { return parseSession(decodeURIComponent(file)); } catch (e) { return { error: e.message }; }
}

function apiTrace(file) {
  try {
    const fp = decodeURIComponent(file);
    if (!fp || !fp.startsWith(HOME)) return { error: 'path fuori HOME' };
    return trace.traceFile(fp);
  } catch (e) { return { error: e.message }; }
}

function apiTraceList() {
  try {
    const sessions = trace.listSessions(SESSIONS_DIR);
    let totTokens = 0, totCost = 0, totTool = 0, totErr = 0;
    for (const s of sessions) {
      totTokens += s.totalTokens || 0;
      totCost += s.totalCost || 0;
      totTool += (s.counts.toolResult || 0);
    }
    return { sessions, totals: { sessions: sessions.length, tokens: totTokens, cost: totCost, toolResults: totTool } };
  } catch (e) { return { error: e.message, sessions: [] }; }
}

// /api/metrics rilegge 190+ JSONL: cache 60s (il dato è storico, non realtime).
const METRICS_TTL_MS = 60 * 1000;
let metricsCache = { at: 0, data: null };
function apiMetrics(force) {
  const now = Date.now();
  if (!force && metricsCache.data && (now - metricsCache.at) < METRICS_TTL_MS) {
    return { ...metricsCache.data, cached: true };
  }
  const t0 = Date.now();
  let data;
  try { data = trace.metrics(SESSIONS_DIR); } catch (e) { return { error: e.message }; }
  data.computeMs = Date.now() - t0;
  data.cachedAt = new Date().toISOString();
  data.cached = false;
  metricsCache = { at: Date.now(), data };
  return data;
}

function apiCollections() {
  const out = { collections: [], error: null };
  try {
    const list = execSync('qmd collection list', { encoding: 'utf-8', timeout: 8000 });
    const blocks = list.split(/\n\n+/).filter(b => b.includes('qmd://'));
    for (const block of blocks) {
      const nameMatch = block.match(/^([^\s(]+)\s*\(qmd:\/\//);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      const pattern = (block.match(/Pattern:\s*(.+)/) || [])[1] && (block.match(/Pattern:\s*(.+)/) || [])[1].trim();
      const files = parseInt((block.match(/Files:\s*(\d+)/) || [])[1] || '0', 10);
      const updated = (block.match(/Updated:\s*(.+)/) || [])[1] && (block.match(/Updated:\s*(.+)/) || [])[1].trim();
      let colPath = null;
      try {
        const show = execSync('qmd collection show ' + name, { encoding: 'utf-8', timeout: 8000 });
        colPath = (show.match(/Path:\s*(.+)/) || [])[1] && (show.match(/Path:\s*(.+)/) || [])[1].trim();
      } catch {}
      const indexedFiles = [];
      if (colPath) {
        const walk = (dir) => {
          try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (e.name === 'node_modules' || e.name === '.git') continue;
              const fp = path.join(dir, e.name);
              if (e.isDirectory()) walk(fp);
              else if (e.name.endsWith('.md')) indexedFiles.push(fp);
            }
          } catch {}
        };
        walk(colPath);
      }
      out.collections.push({ name, pattern, files, updated, path: colPath, indexedFiles });
    }
  } catch (e) { out.error = e.message; }
  return out;
}

function getAuthKey(provider) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(HOME, '.pi', 'agent', 'auth.json'), 'utf-8'));
    const cred = auth[provider];
    return (cred && (cred.key || cred.access)) || null;
  } catch { return null; }
}

function getOpenRouterKey() {
  return getAuthKey('openrouter');
}

function readCache(file, maxAgeMs) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Date.now() - raw.ts < maxAgeMs) return raw.data;
  } catch {}
  return null;
}
function writeCache(file, data) {
  try { fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

async function apiCreditsAsync() {
  const key = getOpenRouterKey();
  if (!key) return { error: 'Chiave OpenRouter non trovata in ~/.pi/agent/auth.json' };
  try {
    const [cr, ki] = await Promise.all([
      fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: 'Bearer ' + key } }),
      fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: 'Bearer ' + key } }),
    ]);
    const credits = await cr.json();
    const keyinfo = await ki.json();
    if (credits.error) return { error: credits.error.message };
    return { credits: credits.data, keyinfo: keyinfo.data };
  } catch (e) { return { error: e.message }; }
}

// --- storico crediti: una riga al giorno in STATS_DIR (AI_STUDIO_STATS_DIR) ---
const SNAPSHOT = path.join(STATS_DIR, 'credits-snapshots.jsonl');

function readSnapshots() {
  try {
    return fs.readFileSync(SNAPSHOT, 'utf-8').split('\n').filter(Boolean)
      .map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

/** Scrive la riga di oggi se manca. Idempotente per giorno; non solleva mai
 *  (il trend non deve rompere la pagina se il file o il disco fanno i capricci). */
function snapshotCredits(payload) {
  const or = payload && payload.openrouter;
  if (!or || or.error || !or.credits) return false;
  const c = or.credits;
  const go = (payload.ocgo && payload.ocgo.go) || {};
  const day = new Date().toISOString().slice(0, 10);
  if (readSnapshots().some(function (r) { return r.date === day; })) return false;
  const row = {
    date: day,
    or_total: c.total_credits,
    or_usage: c.total_usage,
    or_left: +(c.total_credits - c.total_usage).toFixed(6),
    oc_spent: (go.usage && go.usage.today != null) ? +Number(go.usage.today).toFixed(6) : null,
  };
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.appendFileSync(SNAPSHOT, JSON.stringify(row) + '\n');
    return true;
  } catch (e) { return false; }
}

/** Righe ordinate per data + spesa del giorno (delta di usage vs giorno precedente). */
function creditsHistory() {
  const rows = readSnapshots().sort(function (a, b) { return a.date.localeCompare(b.date); });
  let prevOr = null, prevOc = null;
  const out = rows.map(function (r) {
    const orSpent = prevOr == null ? null : +(r.or_usage - prevOr).toFixed(6);
    let ocSpent = null;
    if (prevOc != null && r.oc_spent != null) ocSpent = +(r.oc_spent - prevOc).toFixed(4);
    prevOr = r.or_usage;
    if (r.oc_spent != null) prevOc = r.oc_spent;
    return { date: r.date, or_usage: r.or_usage, or_left: r.or_left, or_spent_day: orSpent,
             oc_spent: r.oc_spent, oc_spent_day: ocSpent };
  });
  const spentDays = out.filter(function (r) { return r.or_spent_day != null; });
  const total = spentDays.reduce(function (a, r) { return a + Math.max(0, r.or_spent_day); }, 0);
  return {
    rows: out, days: out.length, file: SNAPSHOT, total_window: +total.toFixed(4),
    avg_day: spentDays.length ? +(total / spentDays.length).toFixed(4) : null,
  };
}

/** Payload crediti condiviso da handler HTTP e timer giornaliero. */
async function creditsPayload() {
  const [openrouter, ocgoLocal, ocgoGo] = await Promise.all([
    apiCreditsAsync(),
    Promise.resolve(apiOcLocalUsage(ocPricingCached())),
    apiOcGoAsync(),
  ]);
  return { openrouter: openrouter, ocgo: { local: ocgoLocal, go: ocgoGo } };
}

async function apiModelsAsync() {
  const cached = readCache('/tmp/or-models-cache.json', 6 * 60 * 60 * 1000);
  if (cached) return { models: cached, cached: true };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const j = await r.json();
    const models = (j.data || []).map(m => {
      const p = m.pricing || {};
      return {
        id: m.id, name: m.name, context: m.context_length,
        prompt: p.prompt, completion: p.completion,
        free: (p.prompt === '0' && p.completion === '0'),
        modality: m.architecture && m.architecture.modality,
        reasoning: m.reasoning,
        created: m.created,
      };
    });
    writeCache('/tmp/or-models-cache.json', models);
    return { models, cached: false };
  } catch (e) { return { error: e.message }; }
}

// ===================== OpenCode Go =====================
// Listino piano Go: prezzi per 1M token e nomi dei modelli, LIVE dal Console API
// (GET /console/api/config -> config.provider['opencode-go'].models), cache 6h.
// I tetti di spesa mensili per modello NON sono esposti da nessuna API (stanno solo
// nella pagina docs): non li teniamo, cosi' non c'e' nessuna tabella statica da inseguire.
// La quota consumata si legge dall'usage endpoint (percentuale del piano).
function parseOcConfig(j) {
  const models = (((((j || {}).config || {}).provider || {})['opencode-go']) || {}).models || {};
  const out = {};
  for (const [id, m] of Object.entries(models)) {
    const c = (m && m.cost) || {};
    out[id] = {
      name: (m && m.name) || id,
      input: c.input || 0,
      output: c.output || 0,
      cacheRead: c.cache_read || 0,
      cacheWrite: c.cache_write || 0,
      // i modelli contributor cedono i dati per il training (suffisso fisso nell'id)
      train: id.endsWith('-contributor'),
    };
  }
  return out;
}

/** Listino in cache (sincrono): usato dove non si puo' attendere la rete. */
function ocPricingCached() { return readCache('/tmp/ocgo-pricing-cache.json', 6 * 60 * 60 * 1000); }

async function apiOcPricingAsync() {
  const cached = ocPricingCached();
  if (cached) return cached;
  const key = getAuthKey('opencode-go');
  if (!key) return { error: 'key opencode-go assente in ~/.pi/agent/auth.json' };
  try {
    const r = await fetch('https://opencode.ai/console/api/config', {
      headers: { Authorization: 'Bearer ' + key, 'User-Agent': 'ai-studio/1.0' },
    });
    if (!r.ok) return { error: 'listino OpenCode Go: HTTP ' + r.status };
    const pricing = parseOcConfig(await r.json());
    if (!Object.keys(pricing).length) return { error: 'listino OpenCode Go: risposta senza modelli' };
    writeCache('/tmp/ocgo-pricing-cache.json', pricing);
    return pricing;
  } catch (e) { return { error: 'listino OpenCode Go: ' + e.message }; }
}

/** Uso locale OpenCode Go nel mese corrente, dai JSONL delle sessioni (padre + subagent).
 *  `pricing` e' il listino live (per i nomi); se manca si mostra l'id. */
function apiOcLocalUsage(pricing) {
  const base = SESSIONS_DIR;
  const month = new Date().toISOString().slice(0, 7);
  const perModel = {};
  let totalCost = 0, msgs = 0;
  const files = [];
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.jsonl')) files.push(fp);
    }
  };
  walk(base);
  for (const fp of files) {
    let text; try { text = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'message') continue;
      const m = o.message || {};
      if (m.role !== 'assistant' || m.provider !== 'opencode-go') continue;
      const ts = o.timestamp || m.timestamp || '';
      if (String(ts).slice(0, 7) !== month) continue;
      const u = m.usage || {};
      const id = m.model || 'unknown';
      if (!perModel[id]) perModel[id] = { model: id, msgs: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
      const d = perModel[id];
      d.msgs++;
      d.input += u.input || 0;
      d.output += u.output || 0;
      d.cacheRead += u.cacheRead || 0;
      d.cost += (u.cost && u.cost.total) || 0;
      totalCost += (u.cost && u.cost.total) || 0;
      msgs++;
    }
  }
  const models = Object.values(perModel).map(d => {
    const p = (pricing || {})[d.model] || {};
    return { ...d, name: p.name || d.model };
  }).sort((a, b) => b.cost - a.cost);
  return { month, msgs, totalCost, models };
}

/** Catalogo + listino OpenCode Go: tutto dal Console API, nessuna tabella statica. */
async function apiOcModelsAsync() {
  const pricing = await apiOcPricingAsync();
  if (pricing.error) return { models: [], error: pricing.error };
  const used = {};
  for (const u of apiOcLocalUsage(pricing).models) used[u.model] = u;
  const models = Object.entries(pricing).map(([id, p]) => ({
    id, name: p.name, input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite,
    free: !p.input && !p.output, train: !!p.train,
    used: used[id] || null,
  }));
  return { models };
}

/** CSV Console (/api/v2/usage/export): una riga per giorno + modello + service account.
 *  Colonne: day,user_type,user_id,user_name,provider,model,requests,input_tokens,
 *  output_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,cost_micro_cents
 *  USD = cost_micro_cents / 1e8 (verificato 2026-10-23 contro il costo registrato da pi). */
function parseOcUsageCsv(text) {
  const lines = String(text).trim().split('\n');
  if (!lines.length || !lines[0]) return { error: 'CSV vuoto' };
  const head = lines.shift().split(',').map((h) => h.trim()); // il CSV usa CRLF
  const splitRow = (line) => {
    const f = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { f.push(cur); cur = ''; }
      else cur += ch;
    }
    f.push(cur); return f;
  };
  const byDay = {}, byModel = {};
  let total = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = splitRow(line);
    const g = {}; head.forEach((h, i) => { g[h] = f[i]; });
    const cost = (Number(g.cost_micro_cents) || 0) / 1e8;
    const req = Number(g.requests) || 0;
    total += cost;
    const d = byDay[g.day] || (byDay[g.day] = { day: g.day, requests: 0, cost: 0 });
    d.requests += req; d.cost += cost;
    const m = byModel[g.model] || (byModel[g.model] = { model: g.model, requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0 });
    m.requests += req;
    m.input += Number(g.input_tokens) || 0;
    m.output += Number(g.output_tokens) || 0;
    m.cacheRead += Number(g.cache_read_tokens) || 0;
    m.cost += cost;
  }
  const days = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
  const today = new Date().toISOString().slice(0, 10);
  return {
    days,
    by_model: Object.values(byModel).sort((a, b) => b.cost - a.cost),
    total: +total.toFixed(6),
    today: +((byDay[today] || { cost: 0 }).cost).toFixed(6),
    n_days: days.length,
    avg_day: days.length ? +(total / days.length).toFixed(6) : null,
  };
}

/** Dati OpenCode Go remoti: quota del piano (inference API) + spesa reale (Console API).
 *  La key ha usage:read ma NON budgets:read (/api/v1|v2/budgets/members → 403): i tetti
 *  si leggono dalle budget policy, che oggi sono vuote. User-Agent esplicito richiesto
 *  dalla Console (rifiuta Python-urllib). */
async function apiOcGoAsync() {
  const key = getAuthKey('opencode-go');
  if (!key) return { available: false, reason: 'key opencode-go assente in ~/.pi/agent/auth.json' };
  const cached = readCache('/tmp/ocgo-console-cache.json', 5 * 60 * 1000);
  if (cached) return cached;
  const headers = { Authorization: 'Bearer ' + key, 'User-Agent': 'ai-studio/1.0' };
  const grab = async (url, as) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return { error: 'HTTP ' + r.status };
      return as === 'text' ? { text: await r.text() } : { json: await r.json() };
    } catch (e) { return { error: e.message }; }
  };
  const [quota, usage, policies] = await Promise.all([
    grab('https://opencode.ai/inference/go/v1/usage', 'json'),
    grab('https://opencode.ai/console/api/v2/usage/export?range=30d', 'text'),
    grab('https://opencode.ai/console/api/v2/budget-policies', 'json'),
  ]);
  const out = {
    available: !quota.error,
    reason: quota.error || null,
    quota: (quota.json && quota.json.usage) || null,
    usage: usage.error ? { error: usage.error } : parseOcUsageCsv(usage.text),
    policies: policies.error ? { error: policies.error } : { items: Array.isArray(policies.json) ? policies.json : [] },
  };
  if (out.available && !out.usage.error) writeCache('/tmp/ocgo-console-cache.json', out);
  return out;
}

async function apiRateAsync() {
  const cached = readCache('/tmp/or-rate-cache.json', 6 * 60 * 60 * 1000);
  if (cached) return { rate: cached, cached: true };
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    const rate = j.rates && j.rates.EUR;
    if (!rate) throw new Error('rate EUR non disponibile');
    writeCache('/tmp/or-rate-cache.json', rate);
    return { rate, cached: false, updated: j.time_last_update_utc };
  } catch (e) { return { rate: 0.89, fallback: true, error: e.message }; }
}

// Confronti "spesa se avessi usato la frontiera": prezzi $/1M presi SOLO dal catalogo
// locale di pi (models-store.json). Il catalogo e' opzionale: senza, i prezzi sono n/d.
const FRONTIER_IDS = [
  'anthropic/claude-opus-4.8', 'anthropic/claude-sonnet-5.5', 'openai/gpt-6-astra',
  'google/gemini-3.1-pro-preview', 'deepseek/deepseek-v4-pro', 'z-ai/glm-5.3-prime',
];
function apiFrontier() {
  let list;
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'models-store.json'), 'utf8'));
    list = (cat.openrouter && cat.openrouter.models) || [];
  } catch (e) {
    return { models: [], missing: FRONTIER_IDS, catalog: false, note: 'catalogo locale non trovato: prezzi n/d' };
  }
  const found = FRONTIER_IDS.map(id => list.find(m => m.id === id)).filter(m => m && m.cost);
  return {
    models: found.map(m => ({ id: m.id, name: m.name, cost: m.cost })),
    missing: FRONTIER_IDS.filter(id => !found.some(m => m.id === id)),
    catalog: true,
  };
}

// Snippet generati dal server per la sidebar: un solo posto per le scorciatoie.
const SIDEBAR_SCOPES = SHORTCUTS.map(s => '  <button onclick="openScope(\'' + s.name + '\')">' + escapeHtml(s.label || s.name) + '</button>').join('\n');
const SIDEBAR_QUICKS = (section) => QUICKS.filter(q => (q.section || 'Quick') === section)
  .map(q => '  <button onclick="quickRead(\'' + String(q.path).replace(/'/g, "\\'") + '\')">' + escapeHtml(q.label) + '</button>').join('\n');
const SCOPE_OPTIONS = SHORTCUTS.map(s => '<option value="' + s.name + '">' + escapeHtml(s.label || s.name) + '</option>').join('\n      ');
const CLIENT_HOME = JSON.stringify(HOME);
const CLIENT_SCOPE_ROOTS = JSON.stringify(scopeRoots);

const HTML = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI-studio Explorer</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #0d1117; color: #c9d1d9; display: flex; height: 100vh; }
  aside { width: 220px; background: #161b22; border-right: 1px solid #30363d; padding: 12px; overflow-y: auto; }
  aside h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #8b949e; margin: 16px 0 6px; }
  aside button { display: block; width: 100%; text-align: left; background: none; border: none; color: #c9d1d9; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  aside button:hover, aside button.active { background: #21262d; color: #58a6ff; }
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #toolbar { padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; gap: 8px; align-items: center; }
  #toolbar input { flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; border-radius: 6px; font-size: 13px; }
  #toolbar button { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: #58a6ff; }
  .csvbtn { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 3px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: normal; margin-left: 8px; }
  .frontier-modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 100; cursor: pointer; }
  .frontier-box { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 18px 22px; max-width: 760px; width: 92%; max-height: 85vh; overflow: auto; cursor: default; }
  .frontier-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
  .frontier-row { margin: 12px 0; }
  .frontier-label { font-size: 12px; color: #c9d1d9; margin-bottom: 3px; }
  .frontier-track { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; height: 20px; overflow: hidden; }
  .frontier-bar { height: 100%; border-radius: 5px; }
  .frontier-real { background: #238636; }
  .frontier-sim { background: linear-gradient(90deg, #8957e5, #da3633); }
  .frontier-delta { color: #f85149; font-size: 11px; }
  #toolbar button:hover { border-color: #58a6ff; }
  #pathbar { padding: 6px 16px; font-size: 12px; color: #8b949e; background: #0d1117; border-bottom: 1px solid #21262d; word-break: break-all; }
  #content { flex: 1; overflow-y: auto; padding: 16px; }
  .entries { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
  .entry { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 8px; }
  .entry:hover { border-color: #58a6ff; }
  .entry .icon { font-size: 16px; width: 20px; text-align: center; }
  .entry .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entry .size { color: #8b949e; font-size: 11px; }
  pre.file { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; font-size: 12px; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .search-result { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .search-result h4 { margin: 0 0 4px; font-size: 13px; color: #58a6ff; cursor: pointer; }
  .search-result p { margin: 0; font-size: 12px; color: #8b949e; }
  .system-block { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .system-block h3 { margin: 0 0 8px; font-size: 13px; color: #8b949e; text-transform: uppercase; }
  .system-block pre { margin: 0; font-size: 12px; overflow-x: auto; }
  .breadcrumbs a { color: #58a6ff; text-decoration: none; cursor: pointer; }
  .breadcrumbs a:hover { text-decoration: underline; }
  .error { color: #f85149; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px,1fr)); gap: 10px; margin-bottom: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; }
  .card .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 18px; font-weight: 600; color: #58a6ff; margin-top: 4px; word-break: break-word; }
  .card.cost .value { color: #3fb950; }
  .tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid #30363d; }
  .tab { background: none; border: none; border-bottom: 2px solid transparent; color: #8b949e; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  .tab:hover { color: #c9d1d9; }
  .tab.active { color: #58a6ff; border-bottom-color: #58a6ff; }
  h4.sub { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin: 12px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; margin-bottom: 16px; }
  th, td { padding: 7px 10px; text-align: left; border-bottom: 1px solid #21262d; }
  th { background: #21262d; color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.clickable:hover { background: #21262d; cursor: pointer; }
  .badge { display: inline-block; background: #21262d; border: 1px solid #30363d; border-radius: 10px; padding: 2px 8px; font-size: 11px; color: #8b949e; margin: 1px; }
  .badge.model { color: #58a6ff; border-color: #1f6feb; }
  h3.section { color: #8b949e; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0 8px; border-bottom: 1px solid #21262d; padding-bottom: 4px; }
  .coll-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
  .coll-card h4 { margin: 0 0 8px; color: #58a6ff; font-size: 15px; }
  .coll-meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: #8b949e; margin-bottom: 10px; }
  .coll-meta span b { color: #c9d1d9; }
  /* ===== Trace view ===== */
  .tbl { width:100%; border-collapse:collapse; font-size:12px; }
  .tbl th, .tbl td { padding:7px 10px; text-align:left; border-bottom:1px solid #21262d; }
  .tbl th { background:#21262d; color:#8b949e; text-transform:uppercase; font-size:11px; letter-spacing:0.5px; }
  .trow { cursor:pointer; }
  .trow:hover { background:#21262d; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:16px; }
  .chip { background:#21262d; border:1px solid #30363d; border-radius:12px; padding:3px 10px; font-size:12px; color:#c9d1d9; }
  .chip b { color:#58a6ff; }
  .tl { border-left:2px solid #30363d; margin:0 0 16px 8px; padding-left:12px; }
  .tl-row { display:flex; gap:10px; padding:2px 0; font-size:12px; line-height:1.5; }
  .tl-time { color:#6e7681; font-variant-numeric:tabular-nums; flex:0 0 62px; }
  .tl-txt { flex:1; word-break:break-word; }
  .tl-user .tl-txt { color:#58a6ff; }
  .tl-tool .tl-txt { color:#d29922; }
  .tl-res .tl-txt { color:#3fb950; }
  .tl-err .tl-txt { color:#f85149; }
  .tl-think .tl-txt { color:#8b949e; font-style:italic; }
  .tl-comp .tl-txt { color:#bc8cff; font-weight:600; }
  .tl-edit .tl-txt { color:#ff7b72; }
  .tl-model .tl-txt { color:#79c0ff; }
  .tl-sess .tl-txt { color:#3fb950; font-weight:600; }
  .turn { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  .turn-head { font-size:12px; margin-bottom:4px; }
  .turn-user { font-size:12px; color:#8b949e; white-space:pre-wrap; word-break:break-word; max-height:80px; overflow:hidden; margin-bottom:6px; }
  .turn-stats { font-size:11px; color:#6e7681; }
</style>
</head>
<body>
<aside id="sidebar">
  <h2>Scope</h2>
${SIDEBAR_SCOPES}
  <button onclick="showSystem()">🔍 System</button>
  <button onclick="showPackages()">📦 Packages</button>
  <button onclick="showStats()">📊 Stats</button>
  <button onclick="showCollections()">🗂️ Collections</button>
  <button onclick="showCredits()">💳 Crediti</button>
  <button onclick="showModels()">🤖 Modelli</button>
  <button onclick="showTrace()">🧭 Trace</button>
  <button onclick="showMetrics()">📈 Metriche</button>
  <button onclick="showDoctor()">🩺 Doctor</button>

  <h2>Quick</h2>
${SIDEBAR_QUICKS('Quick')}

  <h2>Log</h2>
${SIDEBAR_QUICKS('Log')}
</aside>

<main>
  <div id="toolbar">
    <input id="search" placeholder="Cerca nei file markdown..." onkeydown="if(event.key==='Enter')doSearch()">
    <button onclick="doSearch()">Cerca</button>
    <select id="scopeSelect" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:5px 8px;font-size:13px;">
      ${SCOPE_OPTIONS}
      <option value="all">Tutto</option>
    </select>
  </div>
  <div id="pathbar"><span class="breadcrumbs"><a onclick='openDir(${CLIENT_HOME})'>~</a></span></div>
  <div id="content">Caricamento...</div>
</main>

<script>
const HOME = ${CLIENT_HOME};
let currentPath = HOME;
let currentScope = 'ai-studio';

const scopeRoots = ${CLIENT_SCOPE_ROOTS};

async function api(path) {
  const r = await fetch(path);
  return r.json();
}

function setPathBar(p) {
  const rel = p.startsWith(HOME) ? p.slice(HOME.length) : p;
  const parts = rel.split('/').filter(Boolean);
  let acc = HOME;
  const links = ['<a onclick="openDir(\\'' + HOME + '\\')">~</a>'];
  for (const part of parts) {
    acc += '/' + part;
    links.push('<a onclick="openDir(\\'' + acc + '\\')">' + part + '</a>');
  }
  document.getElementById('pathbar').innerHTML = '<span class="breadcrumbs">' + links.join(' / ') + '</span>';
}

function renderDir(data) {
  setPathBar(data.path);
  if (data.error) {
    document.getElementById('content').innerHTML = '<div class="error">' + data.error + '</div>';
    return;
  }
  let html = '<div class="entries">';
  for (const e of data.entries) {
    const icon = e.type === 'directory' ? '📁' : '📄';
    const base = data.path.endsWith('/') ? data.path.slice(0,-1) : data.path;
    const full = base + '/' + e.name;
    const click = e.type === 'directory' ? 'openDir(\\'' + full + '\\')' : 'quickRead(\\'' + full + '\\')';
    html += '<div class="entry" onclick="' + click + '"><span class="icon">' + icon + '</span><span class="name">' + e.name + '</span></div>';
  }
  html += '</div>';
  document.getElementById('content').innerHTML = html;
  currentPath = data.path;
}

function renderFile(data) {
  setPathBar(data.path);
  if (data.error) {
    document.getElementById('content').innerHTML = '<div class="error">' + data.error + '</div>';
    return;
  }
  let html = '<pre class="file">' + escapeHtml(data.content) + '</pre>';
  document.getElementById('content').innerHTML = html;
  currentPath = data.path;
}

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

async function openDir(p) {
  const data = await api('/api/ls?path=' + encodeURIComponent(p));
  renderDir(data);
}

async function quickRead(p) {
  const data = await api('/api/read?path=' + encodeURIComponent(p));
  if (data.type === 'directory') renderDir(data); else renderFile(data);
}

async function openScope(name) {
  currentScope = name;
  const root = scopeRoots[name] || HOME;
  const sel = document.getElementById('scopeSelect');
  if (sel) sel.value = name;
  openDir(root);
}

async function doSearch() {
  const q = document.getElementById('search').value.trim();
  if (!q) return;
  const scope = document.getElementById('scopeSelect').value;
  const data = await api('/api/search?q=' + encodeURIComponent(q) + '&scope=' + encodeURIComponent(scope));
  let html = '<h3>Risultati per "' + escapeHtml(data.query) + '" in ' + escapeHtml(data.scope) + '</h3>';
  if (!data.results.length) html += '<p>Nessun risultato.</p>';
  for (const r of data.results) {
    html += '<div class="search-result"><h4 onclick="quickRead(\\'' + r.path + '\\')">' + escapeHtml(r.path.replace(HOME, '~')) + '</h4><p>' + escapeHtml(r.snippet) + '...</p></div>';
  }
  document.getElementById('content').innerHTML = html;
}

async function showSystem() {
  const data = await api('/api/system');
  let html = '<h3>System Info</h3>';
  for (const [k, v] of Object.entries(data)) {
    html += '<div class="system-block"><h3>' + k + '</h3><pre>' + escapeHtml(v) + '</pre></div>';
  }
  document.getElementById('content').innerHTML = html;
}

async function showPackages() {
  const data = await api('/api/packages');
  let html = '<h3>Packages</h3>';
  if (data.error) { html += '<div class="error">' + data.error + '</div>'; }
  else {
    for (const [k, v] of Object.entries(data.dependencies || {})) {
      html += '<div class="entry"><span class="name">' + k + '</span><span class="size">' + v + '</span></div>';
    }
  }
  document.getElementById('content').innerHTML = html;
}

window.RATE = 0.89;
function fmtCost(n){ return '€' + ((n||0)*window.RATE).toFixed(4); }
function fmtEur(n){ return '€' + ((n||0)*window.RATE).toFixed(2); }
// Un prezzo negativo (es. -1 nel catalogo OpenRouter) significa "variabile": niente numero inventato.
function fmtPer1M(p){ const v = parseFloat(p); if (!isFinite(v) || v < 0) return 'variabile'; return '€' + (v*1e6*window.RATE).toFixed(2); }
// I prezzi OpenCode Go sono GIA' per 1M token (OpenRouter invece li da' per token: x1e6).
function fmtOc(p){ const v = parseFloat(p); if (!isFinite(v) || v < 0) return 'variabile'; const e = v*window.RATE; return '€' + ((e > 0 && e < 0.01) ? e.toFixed(4) : e.toFixed(2)); }
// Quota OpenCode Go: percentuale con barra colorata (verde/giallo/rosso) e data di reset.
function pctCard(label, pct, reset){
  const v = Number(pct) || 0;
  const c = v >= 90 ? '#f85149' : v >= 70 ? '#d29922' : '#3fb950';
  return '<div class="card"><div class="label">'+label+'</div><div class="value">'+v+'%</div>'
    + '<div style="background:#21262d;height:6px;border-radius:3px;margin-top:6px"><div style="width:'+Math.min(v,100)+'%;height:6px;border-radius:3px;background:'+c+'"></div></div>'
    + '<div style="color:#8b949e;font-size:10px;margin-top:4px">reset '+escapeHtml(String(reset || '').slice(0,10))+'</div></div>';
}
function fmtTok(n){ return (n||0).toLocaleString(); }
function fmtDur(start, end){ if(!start||!end) return '-'; const a=new Date(start), b=new Date(end); const m=Math.round((b-a)/60000); if(m<60) return m+'m'; return Math.floor(m/60)+'h '+(m%60)+'m'; }
function fmtDate(s){ if(!s) return '-'; return s.replace('T',' ').slice(0,16); }
function wsName(p){ if(!p) return '-'; return p.replace(HOME,'~'); }
function card(label, value, cls){ return '<div class="card '+(cls||'')+'"><div class="label">'+label+'</div><div class="value">'+value+'</div></div>'; }
function modelShort(m){ return (m||'').replace(/^~/,'').split('/').pop(); }

// --- Confronto "se avessi usato la frontiera" (intero periodo, token reali) ---
async function showFrontier() {
  // Da Stats i dati sono già in window._statsData; da Metriche (o dopo reload) si rileggono.
  const d = window._statsData || await api('/api/stats');
  if (!d || !d.byModel) return;
  let tin = 0, tout = 0, tcr = 0, tcw = 0, real = 0;
  for (const m of (d.byModel || [])) {
    tin += m.input || 0; tout += m.output || 0; tcr += m.cacheRead || 0; tcw += m.cacheWrite || 0; real += m.cost || 0;
  }
  const wrap = document.createElement('div');
  wrap.className = 'frontier-modal';
  wrap.innerHTML = '<div class="frontier-box"><div class="frontier-title">🔥 Se avessi usato la frontiera</div><div id="frontier-body"><p>Carico listino dal catalogo locale…</p></div></div>';
  document.body.appendChild(wrap);
  wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
  const f = await api('/api/frontier');
  const body = document.getElementById('frontier-body');
  if (f.error) { body.innerHTML = '<div class="error">' + escapeHtml(f.error) + '</div>'; return; }
  if (f.catalog === false) {
    const max = real > 0 ? real : 1;
    let h = '<p class="error">Prezzi n/d: catalogo locale models-store.json non trovato.</p>';
    h += frontierRow('Spesa REALE (tutti i modelli usati)', real, max, real, true);
    for (const id of (f.missing || [])) h += frontierRow(escapeHtml(id), null, max, real, false);
    body.innerHTML = h;
    return;
  }
  const rows = (f.models || []).map(function (m) {
    const c = m.cost || {};
    const sim = (tin * (c.input || 0) + tout * (c.output || 0) + tcr * (c.cacheRead || 0) + tcw * (c.cacheWrite || 0)) / 1e6;
    return { name: (m.name || m.id).replace(/^.*?:\s*/, ''), id: m.id, sim: sim };
  }).sort(function (a, b) { return a.sim - b.sim; });
  const max = Math.max(real, ...rows.map(function (r) { return r.sim; }));
  let h = '<p style="font-size:12px;color:#8b949e">Token reali del periodo: ' + fmtTok(tin + tout + tcr + tcw) +
    ' — in ' + fmtTok(tin) + ' · out ' + fmtTok(tout) + ' · cacheRead ' + fmtTok(tcr) + ' · cacheWrite ' + fmtTok(tcw) +
    '. Simulazione: stessi token × listino $/1M (sconto cache incluso).</p>';
  h += frontierRow('Spesa REALE (tutti i modelli usati)', real, max, real, true);
  for (const r of rows) h += frontierRow(r.name + ' <span style="color:#8b949e;font-size:10px">' + escapeHtml(r.id) + '</span>', r.sim, max, real, false);
  if ((f.missing || []).length) h += '<p style="font-size:11px;color:#8b949e">Non nel catalogo locale: ' + escapeHtml(f.missing.join(', ')) + '</p>';
  body.innerHTML = h;
}
function frontierRow(label, cost, max, real, isReal) {
  const nd = cost == null;
  const w = (!nd && max > 0) ? Math.max(1, cost / max * 100) : 0;
  let delta = '';
  if (!nd && !isReal && real > 0) {
    const pct = (cost / real - 1) * 100;
    delta = ' <span class="frontier-delta">(+' + fmtEur(cost - real) + ', +' + pct.toFixed(0) + '%)</span>';
  } else if (!nd && !isReal) {
    delta = ' <span class="frontier-delta">(+' + fmtEur(cost) + ')</span>';
  }
  return '<div class="frontier-row"><div class="frontier-label">' + label + '</div>' +
    '<div class="frontier-track"><div class="frontier-bar ' + (isReal ? 'frontier-real' : 'frontier-sim') + '" style="width:' + w.toFixed(1) + '%"></div></div>' +
    '<div class="frontier-label" style="margin-top:2px"><b>' + (nd ? 'n/d' : fmtEur(cost)) + '</b>' + delta + '</div></div>';
}

async function showStats() {
  const data = await api('/api/stats');
  document.getElementById('pathbar').innerHTML = '<span class="breadcrumbs">📊 Stats utilizzo pi</span>';
  if (data.error) { document.getElementById('content').innerHTML = '<div class="error">'+data.error+'</div>'; return; }
  renderStats(data);
}

// Riuso dello stesso payload: il sort non deve rifare /api/stats (rianalizza 150+ file).
function renderStats(data) {
  window._statsData = data; // per showFrontier(): token reali per modello (intero periodo)
  const s = data.summary;
  let html = '<h3 class="section">Riepilogo</h3><div class="cards">';
  html += card('Sessioni', s.sessions);
  html += card('di cui subagent', (s.subSessions || 0) + ' sessioni · ' + fmtCost(s.subCost || 0));
  html += card('Msg user', fmtTok(s.userMsgs));
  html += card('Msg assistant', fmtTok(s.assistantMsgs));
  html += card('Msg tool', fmtTok(s.toolMsgs));
  html += card('Token totali', fmtTok(s.totalTokens));
  html += card('Costo totale', fmtCost(s.totalCost), 'cost');
  html += card('Prima sessione', fmtDate(s.firstSession));
  html += card('Ultima sessione', fmtDate(s.lastSession));
  html += card('non supportati', (s.unsupportedSessions || 0) + ' sessioni');
  html += '</div>';

  const oc = data.ocgo || { month: '', msgs: 0, totalCost: 0, models: [] };
  html += '<h3 class="section">OpenCode Go — mese ' + escapeHtml(oc.month) + '</h3>';
  html += '<div class="cards">';
  html += card('Valore uso', fmtCost(oc.totalCost), 'cost');
  html += card('Messaggi', oc.msgs);
  html += card('Modelli usati', oc.models.length);
  html += '</div>';
  if (oc.models.length) {
    html += '<table><thead><tr><th>Modello</th><th class="num">Msg</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache R</th><th class="num">Uso</th></tr></thead><tbody>';
    for (const m of oc.models) {
      html += '<tr><td>' + escapeHtml(m.name || m.model) + '</td><td class="num">' + m.msgs + '</td><td class="num">' + fmtTok(m.input) + '</td><td class="num">' + fmtTok(m.output) + '</td><td class="num">' + fmtTok(m.cacheRead) + '</td><td class="num">' + fmtCost(m.cost) + '</td></tr>';
    }
    html += '</tbody></table>';
  } else {
    html += '<p style="color:#8b949e;font-size:12px">Nessun uso OpenCode Go nel mese corrente.</p>';
  }
  html += '<h3 class="section">Per modello <button class="csvbtn" onclick="showFrontier()" title="Spesa reale vs se avessi usato i modelli di frontiera — token reali del periodo × listino locale">🔥 Se avessi usato la frontiera</button></h3><table><thead><tr><th>Modello</th><th class="num">Sess</th><th class="num">Msg</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache R</th><th class="num">Cache W</th><th class="num">Reason</th><th class="num">Token</th><th class="num">Costo</th><th class="num">%</th></tr></thead><tbody>';
  for (const m of data.byModel) {
    html += '<tr><td><span class="badge model">'+escapeHtml(m.model.replace(/^~/,''))+'</span></td><td class="num">'+m.sessions+'</td><td class="num">'+m.msgs+'</td><td class="num">'+fmtTok(m.input)+'</td><td class="num">'+fmtTok(m.output)+'</td><td class="num">'+fmtTok(m.cacheRead)+'</td><td class="num">'+fmtTok(m.cacheWrite)+'</td><td class="num">'+fmtTok(m.reasoning)+'</td><td class="num">'+fmtTok(m.tokens)+'</td><td class="num">'+fmtCost(m.cost)+'</td><td class="num">'+m.pct.toFixed(1)+'%</td></tr>';
  }
  html += '</tbody></table>';
  html += '<h3 class="section">Timeline per giorno</h3><table><thead><tr><th>Data</th><th class="num">Sessioni</th><th class="num">Msg</th><th class="num">Token</th><th class="num">Costo</th></tr></thead><tbody>';
  for (const d of s.byDay) {
    html += '<tr><td>'+d.date+'</td><td class="num">'+d.sessions+'</td><td class="num">'+d.msgs+'</td><td class="num">'+fmtTok(d.tokens)+'</td><td class="num">'+fmtCost(d.cost)+'</td></tr>';
  }
  html += '</tbody></table>';
  statsState.data = data;
  html += '<h3 class="section">Sessioni (clicca per dettaglio) <button class="csvbtn" onclick="exportStatsCsv()" title="Esporta la tabella ordinata in CSV">⇩ CSV</button></h3>';
  html += '<table><thead><tr>' + STATS_COLS.map(function (c, i) {
    const arrow = statsState.sortKey === c[0] ? (statsState.sortDir > 0 ? ' ▲' : ' ▼') : '';
    return '<th class="' + (c[2] ? 'num ' : '') + 'sortable" onclick="sortStats(' + i + ')">' + c[1] + arrow + '</th>';
  }).join('') + '</tr></thead><tbody>';
  for (const s of statsRows()) {
    const fe = encodeURIComponent(s.file);
    const models = s.models.map(function(m){ return '<span class="badge model">'+escapeHtml(modelShort(m))+'</span>'; }).join(' ');
    html += '<tr class="clickable" onclick="showSession(\\''+fe+'\\')"><td>'+escapeHtml(wsName(s.workspace))+'</td><td>'+fmtDate(s.start)+'</td><td class="num">'+fmtDur(s.start,s.end)+'</td><td class="num">'+s.userMsgs+'</td><td class="num">'+s.assistantMsgs+'</td><td class="num">'+s.toolMsgs+'</td><td class="num">'+fmtTok(s.input)+'</td><td class="num">'+fmtTok(s.output)+'</td><td class="num">'+fmtTok(s.cacheRead)+'</td><td class="num">'+fmtTok(s.totalTokens)+'</td><td class="num">'+fmtCost(s.totalCost)+'</td><td>'+models+'</td></tr>';
  }
  html += '</tbody></table>';
  document.getElementById('content').innerHTML = html;
}

// --- tabella sessioni: colonne, ordinamento client-side, export CSV ---
let statsState = { sortKey: 'start', sortDir: -1, data: null };
// [chiave, etichetta, allineato a destra]
const STATS_COLS = [
  ['workspace', 'Workspace', 0], ['start', 'Inizio', 0], ['durMs', 'Durata', 1],
  ['userMsgs', 'Usr', 1], ['assistantMsgs', 'Asst', 1], ['toolMsgs', 'Tool', 1],
  ['input', 'In', 1], ['output', 'Out', 1], ['cacheRead', 'Cache', 1],
  ['totalTokens', 'Token', 1], ['totalCost', 'Costo', 1], ['models', 'Modelli', 0]
];

function statsRows() {
  const d = statsState.data;
  if (!d) return [];
  const rows = d.sessions.map(function (s) {
    let input = 0, output = 0, cacheRead = 0;
    for (const m of s.byModel) { input += m.input || 0; output += m.output || 0; cacheRead += m.cacheRead || 0; }
    const ms = (s.start && s.end) ? (new Date(s.end) - new Date(s.start)) : 0;
    return { file: s.file, workspace: wsName(s.workspace), start: s.start, end: s.end, durMs: ms,
             userMsgs: s.userMsgs, assistantMsgs: s.assistantMsgs, toolMsgs: s.toolMsgs,
             input: input, output: output, cacheRead: cacheRead,
             totalTokens: s.totalTokens, totalCost: s.totalCost,
             models: s.byModel.map(function (m) { return m.model; }) };
  });
  const k = statsState.sortKey, dir = statsState.sortDir;
  rows.sort(function (a, b) {
    const va = a[k], vb = b[k];
    if (typeof va === 'number' || typeof vb === 'number') return ((va || 0) - (vb || 0)) * dir;
    return String(va || '').localeCompare(String(vb || '')) * dir;
  });
  return rows;
}

function sortStats(i) {
  const k = STATS_COLS[i][0];
  if (statsState.sortKey === k) statsState.sortDir *= -1;
  else { statsState.sortKey = k; statsState.sortDir = -1; }
  renderStats(statsState.data);
}

function exportStatsCsv() {
  const rows = statsRows();
  const head = ['Workspace', 'Inizio', 'Fine', 'Durata_s', 'Msg_user', 'Msg_assistant', 'Msg_tool',
                'Token_input', 'Token_output', 'Token_cache_read', 'Token_total', 'Costo_USD', 'Modelli'];
  // NL da fromCharCode: un a capo letterale qui verrebbe emesso come a capo reale nel browser.
  const NL = String.fromCharCode(10);
  const q = function (v) { const s = String(v == null ? '' : v); return (/[",;]/.test(s) || s.indexOf(NL) >= 0) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.workspace, r.start || '', r.end || '', Math.round(r.durMs / 1000), r.userMsgs, r.assistantMsgs,
                r.toolMsgs, r.input, r.output, r.cacheRead, r.totalTokens, r.totalCost.toFixed(6),
                r.models.join(' ')].map(q).join(','));
  }
  const blob = new Blob([lines.join(NL)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ai-studio-sessioni-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function showSession(fe) {
  const data = await api('/api/session?file='+fe);
  if (data.error) { document.getElementById('content').innerHTML='<div class="error">'+data.error+'</div>'; return; }
  document.getElementById('pathbar').innerHTML='<span class="breadcrumbs">📊 <a onclick="showStats()">Stats</a> / '+escapeHtml((data.id||'').slice(0,8))+'</span>';
  let html = '<div class="cards">';
  html += card('Workspace', escapeHtml(wsName(data.workspace)));
  html += card('Inizio', fmtDate(data.start));
  html += card('Fine', fmtDate(data.end));
  html += card('Durata', fmtDur(data.start,data.end));
  html += card('Token', fmtTok(data.totalTokens));
  html += card('Costo', fmtCost(data.totalCost), 'cost');
  html += '</div>';
  html += '<h3 class="section">Messaggi con usage ('+data.messages.length+')</h3><table><thead><tr><th>Timestamp</th><th>Ruolo</th><th>Modello</th><th class="num">Input</th><th class="num">Output</th><th class="num">Reason</th><th class="num">Token</th><th class="num">Costo</th></tr></thead><tbody>';
  for (const m of data.messages) {
    html += '<tr><td>'+fmtDate(m.ts)+'</td><td>'+m.role+'</td><td><span class="badge model">'+escapeHtml(modelShort(m.model))+'</span></td><td class="num">'+fmtTok(m.input)+'</td><td class="num">'+fmtTok(m.output)+'</td><td class="num">'+fmtTok(m.reasoning)+'</td><td class="num">'+fmtTok(m.tok)+'</td><td class="num">'+fmtCost(m.cost)+'</td></tr>';
  }
  html += '</tbody></table>';
  document.getElementById('content').innerHTML = html;
}

async function showCollections() {
  const data = await api('/api/collections');
  document.getElementById('pathbar').innerHTML='<span class="breadcrumbs">🗂️ Collezioni qmd</span>';
  if (data.error) { document.getElementById('content').innerHTML='<div class="error">'+data.error+'</div>'; return; }
  let totalFiles = data.collections.reduce(function(a,c){ return a + c.indexedFiles.length; }, 0);
  let html = '<div class="cards">'+card('Collezioni', data.collections.length)+card('File .md totali', fmtTok(totalFiles))+'</div>';
  for (const c of data.collections) {
    html += '<div class="coll-card"><h4>🗂️ '+escapeHtml(c.name)+'</h4><div class="coll-meta">';
    html += '<span>Path: <b>'+escapeHtml(wsName(c.path))+'</b></span>';
    html += '<span>Pattern: <b>'+escapeHtml(c.pattern)+'</b></span>';
    html += '<span>File qmd: <b>'+c.files+'</b></span>';
    html += '<span>File .md: <b>'+c.indexedFiles.length+'</b></span>';
    html += '<span>Updated: <b>'+escapeHtml(c.updated)+'</b></span>';
    html += '</div>';
    if (c.indexedFiles.length) {
      html += '<div class="entries" style="margin-top:8px">';
      for (const f of c.indexedFiles) {
        html += '<div class="entry" onclick="quickRead(\\''+f+'\\')"><span class="icon">📄</span><span class="name">'+escapeHtml(f.replace(c.path,'.'))+'</span></div>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  document.getElementById('content').innerHTML = html;
}

api('/api/rate').then(function(r){ if (r.rate) window.RATE = r.rate; });

async function showCredits() {
  document.getElementById('pathbar').innerHTML = '<span class="breadcrumbs">💳 Crediti</span>';
  document.getElementById('content').innerHTML = '<p>Caricamento...</p>';
  const data = await api('/api/credits');
  const or = data.openrouter || {};
  const oc = data.ocgo || {};
  const loc = oc.local || { month: '', msgs: 0, totalCost: 0, models: [] };
  let html = '';

  html += '<h3 class="section">OpenRouter</h3>';
  if (or.error) {
    html += '<div class="error">' + escapeHtml(or.error) + '</div>';
  } else {
    const c = or.credits, k = or.keyinfo;
    const residuo = c.total_credits - c.total_usage;
    html += '<div class="cards">';
    html += card('Credito totale', fmtEur(c.total_credits));
    html += card('Usato', fmtEur(c.total_usage), 'cost');
    html += card('Residuo', fmtEur(residuo));
    html += '</div>';
    html += '<h4 class="sub">Chiave (' + escapeHtml(k.label) + ')</h4><div class="cards">';
    html += card('Uso chiave tot', fmtEur(k.usage));
    html += card('Oggi', fmtEur(k.usage_daily));
    html += card('Settimana', fmtEur(k.usage_weekly));
    html += card('Mese', fmtEur(k.usage_monthly));
    html += '</div>';
    const ft = k.free_model_daily_requests || {};
    html += '<h4 class="sub">Free tier giornaliero</h4><div class="cards">';
    html += card('Usati', ft.used || 0);
    html += card('Limite', ft.limit || 0);
    html += card('Rimanenti', ft.remaining || 0);
    html += '</div>';
  }

  html += '<h3 class="section">OpenCode Go</h3>';
  const go = oc.go || {};
  const q = go.quota;
  if (q) {
    html += '<h4 class="sub">Quota del piano</h4><div class="cards">';
    html += pctCard('Rolling 5h', q.rolling && q.rolling.percent, q.rolling && q.rolling.resetsAt);
    html += pctCard('Settimana', q.weekly && q.weekly.percent, q.weekly && q.weekly.resetsAt);
    html += pctCard('Mese', q.monthly && q.monthly.percent, q.monthly && q.monthly.resetsAt);
    html += '</div>';
  } else {
    html += '<p style="color:#8b949e;font-size:12px">Quota non disponibile: ' + escapeHtml(go.reason || 'n/d') + '</p>';
  }
  const u = go.usage || {};
  if (u.error) {
    html += '<div class="error">Spesa Console: ' + escapeHtml(u.error) + '</div>';
  } else {
    html += '<h4 class="sub">Spesa reale — Console API, ultimi 30 giorni</h4><div class="cards">';
    html += card('Speso', fmtEur(u.total), 'cost');
    html += card('Oggi', fmtEur(u.today), 'cost');
    html += card('Media/giorno', u.avg_day == null ? '-' : fmtEur(u.avg_day));
    html += card('Giorni con dati', u.n_days);
    html += '</div>';
    if ((u.by_model || []).length) {
      html += '<table><thead><tr><th>Modello</th><th class="num">Req</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache R</th><th class="num">Spesa</th></tr></thead><tbody>';
      for (const m of u.by_model) {
        html += '<tr><td>' + escapeHtml(m.model) + '</td><td class="num">' + fmtTok(m.requests) + '</td><td class="num">' + fmtTok(m.input) + '</td><td class="num">' + fmtTok(m.output) + '</td><td class="num">' + fmtTok(m.cacheRead) + '</td><td class="num">' + fmtEur(m.cost) + '</td></tr>';
      }
      html += '</tbody></table>';
    }
    if ((u.days || []).length) {
      html += '<h4 class="sub">Spesa per giorno</h4><table><thead><tr><th>Giorno</th><th class="num">Req</th><th class="num">Spesa</th></tr></thead><tbody>';
      for (let i = u.days.length - 1; i >= 0; i--) {
        const d = u.days[i];
        html += '<tr><td>' + escapeHtml(d.day) + '</td><td class="num">' + fmtTok(d.requests) + '</td><td class="num">' + fmtEur(d.cost) + '</td></tr>';
      }
      html += '</tbody></table>';
    }
  }
  const pol = (go.policies && go.policies.items) || [];
  html += '<p style="color:#8b949e;font-size:11px">'
    + (go.policies && go.policies.error ? 'Budget policy: ' + escapeHtml(go.policies.error)
       : pol.length ? 'Budget policy attive: ' + pol.length : 'Budget policy: nessuna configurata (nessun tetto)')
    + ' — la quota per membro (<code>/api/v2/budgets/members</code>) richiede lo scope <code>budgets:read</code>, assente su questa key.</p>';
  html += '<h4 class="sub">Uso locale — mese ' + escapeHtml(loc.month) + '</h4><div class="cards">';
  html += card('Valore uso', fmtCost(loc.totalCost), 'cost');
  html += card('Messaggi', loc.msgs);
  html += card('Modelli usati', loc.models.length);
  html += '</div>';
  if (!u.error && u.total) {
    const d = (loc.totalCost - u.total) / u.total * 100;
    html += '<p style="color:#8b949e;font-size:11px">Scostamento stima locale vs server: ' + (d >= 0 ? '+' : '') + d.toFixed(0)
      + '% (indicativo: mese corrente locale vs 30 giorni server; il server usa il prezzo effettivo, la stima il listino locale).</p>';
  }
  if (loc.models.length) {
    html += '<table><thead><tr><th>Modello</th><th class="num">Msg</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache R</th><th class="num">Uso</th></tr></thead><tbody>';
    for (const m of loc.models) {
      html += '<tr><td>' + escapeHtml(m.name || m.model) + '</td><td class="num">' + m.msgs + '</td><td class="num">' + fmtTok(m.input) + '</td><td class="num">' + fmtTok(m.output) + '</td><td class="num">' + fmtTok(m.cacheRead) + '</td><td class="num">' + fmtCost(m.cost) + '</td></tr>';
    }
    html += '</tbody></table>';
  } else {
    html += '<p style="color:#8b949e;font-size:12px">Nessun uso OpenCode Go nel mese corrente.</p>';
  }
  html += '<p style="color:#8b949e;font-size:11px">Tasso: 1 USD = ' + window.RATE.toFixed(4) + ' EUR' + (window.RATE === 0.89 ? ' (fallback)' : '') + '</p>';
  html += await creditsHistoryHtml();
  document.getElementById('content').innerHTML = html;
}

/** Sezione "Storico e trend": barre SVG della spesa giornaliera + tabella. */
async function creditsHistoryHtml() {
  const h = await api('/api/credits/history');
  if (h.error) return '<div class="error">' + escapeHtml(h.error) + '</div>';
  const rows = h.rows || [];
  let out = '<h3 class="section">📈 Storico e trend</h3>';
  if (!rows.length) {
    return out + '<p style="color:#8b949e;font-size:12px">Nessun dato ancora: la prima riga viene scritta alla prima lettura dei crediti (o dal timer del server) e il trend diventa utile da 2 giorni in poi.</p>';
  }
  out += '<div class="cards">' + card('Giorni tracciati', h.days) +
         card('Speso nella finestra', fmtEur(h.total_window), 'cost') +
         card('Media/giorno', h.avg_day == null ? '-' : fmtEur(h.avg_day)) + '</div>';

  if (rows.length >= 2) {
    const vals = rows.map(function (r) { return Math.max(0, r.or_spent_day || 0); });
    const max = Math.max.apply(null, vals.concat([0.01]));
    const BW = 26, GAP = 6, H = 70;
    let bars = '';
    rows.forEach(function (r, i) {
      const v = Math.max(0, r.or_spent_day || 0);
      const bh = Math.round(v / max * H);
      const x = i * (BW + GAP);
      const y = H - bh;
      const col = i === rows.length - 1 ? '#58a6ff' : '#238636';
      bars += '<rect x="' + x + '" y="' + y + '" width="' + BW + '" height="' + Math.max(bh, 1) + '" fill="' + col + '" rx="2"><title>' + r.date + ': ' + fmtEur(v) + '</title></rect>';
      bars += '<text x="' + (x + BW / 2) + '" y="' + (H + 12) + '" fill="#6e7681" font-size="9" text-anchor="middle">' + r.date.slice(5) + '</text>';
    });
    const W = rows.length * (BW + GAP);
    out += '<div style="overflow-x:auto;margin:8px 0"><svg width="' + W + '" height="' + (H + 20) + '" role="img" aria-label="Spesa giornaliera">' + bars + '</svg></div>';
    out += '<p style="color:#8b949e;font-size:11px">Barra blu = ultimo giorno. Valori in USD, delta di <code>total_usage</code> OpenRouter rispetto al giorno precedente.</p>';
  } else {
    out += '<p style="color:#8b949e;font-size:12px">Un solo giorno tracciato: il grafico compare da domani.</p>';
  }

  out += '<table><thead><tr><th>Data</th><th class="num">Speso nel giorno</th><th class="num">Usato cumulato</th><th class="num">Residuo</th></tr></thead><tbody>';
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    out += '<tr><td>' + r.date + '</td><td class="num">' + (r.or_spent_day == null ? '-' : fmtEur(Math.max(0, r.or_spent_day))) +
           '</td><td class="num">' + fmtEur(r.or_usage) + '</td><td class="num">' + fmtEur(r.or_left) + '</td></tr>';
  }
  out += '</tbody></table>';
  out += '<p style="color:#8b949e;font-size:11px">File: <code>' + escapeHtml(h.file || '') + '</code></p>';
  return out;
}

let modelsState = { tab: 'openrouter', or: null, oc: null, orError: null, ocError: null, sortKey: 'prompt', sortDir: 1, filter: '', onlyFree: false };

async function showModels() {
  document.getElementById('pathbar').innerHTML = '<span class="breadcrumbs">🤖 Modelli</span>';
  if (!modelsState.or) {
    document.getElementById('content').innerHTML = '<p>Caricamento modelli...</p>';
    const data = await api('/api/models');
    modelsState.or = (data.openrouter || {}).models || [];
    modelsState.orError = (data.openrouter || {}).error || null;
    modelsState.oc = (data.ocgo || {}).models || [];
    modelsState.ocError = (data.ocgo || {}).error || null;
  }
  renderModels();
}

function renderOrModels() {
  const ms = modelsState.or || [];
  if (modelsState.orError) return '<div class="error">' + escapeHtml(modelsState.orError) + '</div>';
  let filtered = ms.filter(function (m) {
    if (modelsState.onlyFree && !m.free) return false;
    if (modelsState.filter) {
      const q = modelsState.filter.toLowerCase();
      if (!(m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))) return false;
    }
    return true;
  });
  const sk = modelsState.sortKey;
  filtered.sort(function (a, b) {
    let va, vb;
    if (sk === 'prompt' || sk === 'completion') { va = parseFloat(a[sk]) || 0; vb = parseFloat(b[sk]) || 0; }
    else if (sk === 'context') { va = a.context || 0; vb = b.context || 0; }
    else { va = (a[sk] || '').toLowerCase(); vb = (b[sk] || '').toLowerCase(); }
    if (va < vb) return -1 * modelsState.sortDir;
    if (va > vb) return 1 * modelsState.sortDir;
    return 0;
  });
  let html = '<div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">';
  html += '<input id="mfilter" placeholder="Filtra per id o nome..." value="' + escapeHtml(modelsState.filter) + '" oninput="modelsState.filter=this.value; renderModels()" style="flex:1;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:6px 10px;border-radius:6px;font-size:13px">';
  html += '<label style="font-size:12px;color:#8b949e;white-space:nowrap"><input type="checkbox" ' + (modelsState.onlyFree ? 'checked' : '') + ' onchange="modelsState.onlyFree=this.checked; renderModels()"> Solo gratuiti</label>';
  html += '<span style="color:#8b949e;font-size:12px">' + filtered.length + ' / ' + ms.length + '</span>';
  html += '</div>';
  html += '<table><thead><tr>';
  const cols = [['id', 'Modello'], ['context', 'Context'], ['prompt', 'Input €/1M'], ['completion', 'Output €/1M'], ['free', 'Free']];
  for (const ck of cols) {
    const k = ck[0], label = ck[1];
    const arrow = modelsState.sortKey === k ? (modelsState.sortDir > 0 ? ' ▲' : ' ▼') : '';
    html += '<th onclick="sortModels(\\'' + k + '\\')" style="cursor:pointer">' + label + arrow + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (const m of filtered) {
    html += '<tr><td>' + escapeHtml(m.id) + '</td><td class="num">' + (m.context ? m.context.toLocaleString() : '-') + '</td><td class="num">' + fmtPer1M(m.prompt) + '</td><td class="num">' + fmtPer1M(m.completion) + '</td><td>' + (m.free ? '✅' : '-') + '</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

// Colonne ordinabili del tab OpenCode Go. L'onclick passa l'indice, cosi non servono apici.
const OC_COLS = [['id', 'Modello'], ['input', 'Input €/1M'], ['output', 'Output €/1M'], ['cacheRead', 'Cache €/1M'], ['free', 'Free'], ['used', 'Uso mese']];

function ocSortValue(m, k) {
  if (k === 'id') return (m.name || m.id || '').toLowerCase();
  if (k === 'used') return m.used ? m.used.cost : 0;
  if (k === 'free') return m.free ? 1 : 0;
  return parseFloat(m[k]) || 0;
}

function sortOcModels(i) {
  const k = OC_COLS[i][0];
  if (modelsState.sortKey === k) modelsState.sortDir *= -1;
  else { modelsState.sortKey = k; modelsState.sortDir = 1; }
  renderModels();
}

function switchModelTab(i) {
  modelsState.tab = i === 1 ? 'opencode-go' : 'openrouter';
  modelsState.filter = '';
  modelsState.sortKey = modelsState.tab === 'opencode-go' ? 'input' : 'prompt';
  modelsState.sortDir = 1;
  renderModels();
}

function renderModels() {
  let html = '<div class="tabs">';
  html += '<button class="tab' + (modelsState.tab === 'openrouter' ? ' active' : '') + '" onclick="switchModelTab(0)">OpenRouter (' + (modelsState.or || []).length + ')</button>';
  html += '<button class="tab' + (modelsState.tab === 'opencode-go' ? ' active' : '') + '" onclick="switchModelTab(1)">OpenCode Go (' + (modelsState.oc || []).length + ')</button>';
  html += '</div>';
  html += modelsState.tab === 'opencode-go' ? renderOcModels() : renderOrModels();
  document.getElementById('content').innerHTML = html;
}

function renderOcModels() {
  const ms = modelsState.oc || [];
  if (modelsState.ocError) return '<div class="error">' + escapeHtml(modelsState.ocError) + '</div>';
  const q = (modelsState.filter || '').toLowerCase();
  const filtered = ms.filter(function (m) {
    if (modelsState.onlyFree && !m.free) return false;
    if (q && !(m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))) return false;
    return true;
  });
  const sk = modelsState.sortKey;
  filtered.sort(function (a, b) {
    const va = ocSortValue(a, sk), vb = ocSortValue(b, sk);
    if (va < vb) return -1 * modelsState.sortDir;
    if (va > vb) return 1 * modelsState.sortDir;
    return 0;
  });
  let total = 0;
  for (const m of filtered) if (m.used) total += m.used.cost;
  let html = '<div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">';
  html += '<input id="mfilter" placeholder="Filtra per id o nome..." value="' + escapeHtml(modelsState.filter) + '" oninput="modelsState.filter=this.value; renderModels()" style="flex:1;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:6px 10px;border-radius:6px;font-size:13px">';
  html += '<label style="font-size:12px;color:#8b949e;white-space:nowrap"><input type="checkbox" ' + (modelsState.onlyFree ? 'checked' : '') + ' onchange="modelsState.onlyFree=this.checked; renderModels()"> Solo gratuiti</label>';
  html += '<span style="color:#8b949e;font-size:12px">' + filtered.length + ' / ' + ms.length + '</span>';
  html += '</div>';
  html += '<p style="color:#8b949e;font-size:12px;margin:0 0 10px">Piano Go: prezzi per 1M token dal <b>listino live</b> (Console API, cache 6h). Quota consumata e percentuale del piano stanno in 💳 Crediti. Uso locale del mese corrente: <b>' + fmtCost(total) + '</b></p>';
  html += '<table><thead><tr>';
  for (let i = 0; i < OC_COLS.length; i++) {
    const k = OC_COLS[i][0], label = OC_COLS[i][1];
    if (k === 'used') html += '<th>Note</th>';
    const arrow = modelsState.sortKey === k ? (modelsState.sortDir > 0 ? ' ▲' : ' ▼') : '';
    html += '<th onclick="sortOcModels(' + i + ')" style="cursor:pointer">' + label + arrow + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (const m of filtered) {
    const notes = [];
    if (m.train) notes.push('<span class="badge" style="color:#d29922">training</span>');
    html += '<tr><td>' + escapeHtml(m.name || m.id) + ' <span style="color:#8b949e;font-size:11px">' + escapeHtml(m.id) + '</span></td>'
      + '<td class="num">' + fmtOc(m.input) + '</td>'
      + '<td class="num">' + fmtOc(m.output) + '</td>'
      + '<td class="num">' + fmtOc(m.cacheRead) + '</td>'
      + '<td>' + (m.free ? '✅' : '-') + '</td>'
      + '<td>' + (notes.length ? notes.join(' ') : '-') + '</td>'
      + '<td class="num">' + (m.used ? fmtCost(m.used.cost) : '-') + '</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

function sortModels(k) {
  if (modelsState.sortKey === k) modelsState.sortDir *= -1;
  else { modelsState.sortKey = k; modelsState.sortDir = 1; }
  renderModels();
}

// ===================== METRICS VIEW =====================
async function showMetrics(fresh) {
  document.getElementById('pathbar').innerHTML = '<span class="breadcrumbs">📈 Metriche avanzate (timing tool, costi, alert)</span>';
  document.getElementById('content').innerHTML = '<p>Calcolo metriche su tutte le sessioni…</p>';
  const data = await api('/api/metrics' + (fresh ? '?fresh=1' : ''));
  if (data.error) { document.getElementById('content').innerHTML = '<div class="error">' + escapeHtml(data.error) + '</div>'; return; }

  // trova durata totale tool (somma totalMs)
  let totToolMs = 0;
  for (const t of data.toolUsage) totToolMs += t.totalMs;
  let totSubTokens = 0, totSubCost = 0, totSubAgents = 0;
  for (const s of data.subagents) { totSubTokens += s.tokens || 0; totSubCost += s.cost || 0; totSubAgents += s.agents || 0; }

  let html = '<h3 class="section">📈 Metriche aggregate</h3><div class="cards">';
  html += card('Sessioni utente', data.totals.sessions);
  html += card('Sessioni subagent', data.totals.subSessions || 0);
  html += card('Token totali', fmtTok(data.totals.tokens));
  html += card('Costo totale', fmtCost(data.totals.cost), 'cost');
  html += card('di cui subagent', fmtCost(data.totals.subCost || 0));
  html += card('Tempo tool tot', fmtMs(totToolMs));
  html += card('Alert compaction', data.compactionAlerts.length, data.compactionAlerts.length ? 'warn' : '');
  html += card('Subagent calls', data.subagents.reduce((a, s) => a + (s.calls || 0), 0));
  html += '</div>';

  // 🎯 KPI di inferenza — campi già presenti nei JSONL, medie ponderate sui volumi
  const kp = data.sessionsKpi || [];
  const sumK = (f) => kp.reduce((a, s) => a + (f(s) || 0), 0);
  const pctK = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '-');
  const msgAvg = sumK(s => s.assistantMsgs) ? Math.round(sumK(s => s.msgTotalMs) / sumK(s => s.assistantMsgs)) : null;
  html += '<h3 class="section">🎯 KPI inferenza (solo sessioni utente) <button class="csvbtn" onclick="showMetrics(true)" title="Rilegge tutti i JSONL ignorando la cache di 60s">↻ ricalcola</button></h3><div class="cards">';
  html += card('Cache hit', pctK(sumK(s => s.cacheRead), sumK(s => s.input) + sumK(s => s.cacheRead)));
  html += card('Reasoning / output', pctK(sumK(s => s.reasoning), sumK(s => s.output)));
  html += card('Tool error', pctK(sumK(s => s.toolErrorCount), sumK(s => s.toolCalls)));
  html += card('Output troncati', sumK(s => s.stopLength), sumK(s => s.stopLength) ? 'warn' : '');
  html += card('Latenza msg avg', fmtMs(msgAvg));
  html += card('Compaction', sumK(s => s.compactions));
  html += '</div>';
  if (!kp.length) html += '<p style="color:#888">Nessun KPI disponibile.</p>';
  else {
    html += '<table><thead><tr><th>Giorno</th><th>Sessione</th><th>Modello</th><th class="num">Turni</th><th class="num">Cache</th><th class="num">Reason</th><th class="num">ToolErr</th><th class="num">Tronc</th><th class="num">Msg avg</th><th class="num">Costo</th></tr></thead><tbody>';
    for (const s of kp.slice(0, 30)) {
      html += '<tr><td>' + s.day + '</td><td><code>' + String(s.id || '').slice(0, 8) + '</code></td><td><span class="badge model">' + escapeHtml(modelShort(s.model || '-')) + '</span></td>'
        + '<td class="num">' + (s.turns || 0) + '</td>'
        + '<td class="num">' + (s.cacheHitPct == null ? '-' : s.cacheHitPct + '%') + '</td>'
        + '<td class="num">' + (s.reasoningPct == null ? '-' : s.reasoningPct + '%') + '</td>'
        + '<td class="num">' + (s.toolErrorPct == null ? '-' : s.toolErrorPct + '%') + '</td>'
        + '<td class="num">' + (s.stopLength || 0) + '</td>'
        + '<td class="num">' + fmtMs(s.msgAvgMs) + '</td>'
        + '<td class="num">' + fmtCost(s.cost) + '</td></tr>';
    }
    html += '</tbody></table><p style="color:#8b949e;font-size:11px">Cache = cacheRead/(input+cacheRead). Reason = reasoning/output. Tronc = stopReason "length". Ultime 30 sessioni. Calcolo: ' + (data.computeMs || 0) + 'ms' + (data.cached ? ' (da cache, ' + new Date(data.cachedAt).toLocaleTimeString('it-IT') + ')' : '') + '.</p>';
  }

  // per giorno
  html += '<h3 class="section">Per giorno</h3><table><thead><tr><th>Giorno</th><th class="num">Sess</th><th class="num">Token</th><th class="num">Costo</th><th class="num">Tempo tool</th></tr></thead><tbody>';
  for (const d of data.byDay) {
    html += '<tr><td>' + d.day + '</td><td class="num">' + d.sessions + '</td><td class="num">' + fmtTok(d.tokens) + '</td><td class="num">' + fmtCost(d.cost) + '</td><td class="num">' + fmtMs(d.toolMs) + '</td></tr>';
  }
  html += '</tbody></table>';

  // per modello
  html += '<h3 class="section">Per modello <button class="csvbtn" onclick="showFrontier()" title="Spesa reale vs se avessi usato i modelli di frontiera — token reali del periodo × listino locale">🔥 Se avessi usato la frontiera</button></h3><table><thead><tr><th>Modello</th><th class="num">Sess</th><th class="num">Token</th><th class="num">Costo</th></tr></thead><tbody>';
  for (const m of data.byModel) {
    html += '<tr><td><span class="badge model">' + escapeHtml(modelShort(m.model)) + '</span></td><td class="num">' + m.sessions + '</td><td class="num">' + fmtTok(m.tokens) + '</td><td class="num">' + fmtCost(m.cost) + '</td></tr>';
  }
  html += '</tbody></table>';

  // timing tool
  html += '<h3 class="section">Durata per tool (durationMs)</h3><table><thead><tr><th>Tool</th><th class="num">Chiamate</th><th class="num">Errori</th><th class="num">Avg</th><th class="num">Max</th><th class="num">Totale</th></tr></thead><tbody>';
  for (const t of data.toolUsage) {
    html += '<tr><td>' + escapeHtml(t.name) + '</td><td class="num">' + t.count + '</td><td class="num">' + (t.errors || '-') + '</td><td class="num">' + fmtMs(t.avgMs) + '</td><td class="num">' + fmtMs(t.maxMs) + '</td><td class="num">' + fmtMs(t.totalMs) + '</td></tr>';
  }
  html += '</tbody></table>';

  // alert compaction
  html += '<h3 class="section">Alert compattazioni (>=2 per sessione)</h3>';
  if (!data.compactionAlerts.length) html += '<p style="color:#888">Nessuna sessione con compattazioni frequenti.</p>';
  else {
    html += '<table><thead><tr><th>Sessione</th><th>Giorno</th><th>CWD</th><th class="num">Compaction</th></tr></thead><tbody>';
    for (const c of data.compactionAlerts) {
      html += '<tr style="background:#fff3f3"><td><code>' + String(c.id || '').slice(0, 8) + '</code></td><td>' + c.day + '</td><td>' + escapeHtml(wsName(c.cwd)) + '</td><td class="num"><b>' + c.count + '</b></td></tr>';
    }
    html += '</tbody></table>';
  }

  // subagents
  html += '<h3 class="section">Subagent tree</h3>';
  if (!data.subagents.length) html += '<p style="color:#888">Nessuna attività subagent rilevata.</p>';
  else {
    html += '<table><thead><tr><th>Sessione</th><th>Giorno</th><th class="num">Calls</th><th class="num">Results</th><th class="num">Agenti</th><th class="num">Ok/Fail</th><th class="num">Token</th><th class="num">Costo</th></tr></thead><tbody>';
    for (const s of data.subagents) {
      html += '<tr><td><code>' + String(s.id || '').slice(0, 8) + '</code></td><td>' + s.day + '</td><td class="num">' + s.calls + '</td><td class="num">' + s.results + '</td><td class="num">' + s.agents + '</td><td class="num">' + (s.ok || 0) + '/' + (s.failed || 0) + '</td><td class="num">' + fmtTok(s.tokens) + '</td><td class="num">' + fmtCost(s.cost) + '</td></tr>';
    }
    html += '</tbody></table>';
  }

  document.getElementById('content').innerHTML = html;
}

function fmtMs(n) {
  if (n == null) return '-';
  if (n < 1000) return n + 'ms';
  if (n < 60000) return (n / 1000).toFixed(1) + 's';
  const m = Math.round(n / 60000);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// ===================== TRACE VIEW =====================
window._traceList = [];

async function showTrace() {
  document.getElementById('content').innerHTML = '<p>Carico sessioni…</p>';
  const data = await api('/api/trace-list');
  if (data.error) { document.getElementById('content').innerHTML = '<p style="color:#c33">Errore: ' + escapeHtml(data.error) + '</p>'; return; }
  window._traceList = data.sessions;
  let h = '<h3>🧭 Trace — ' + data.totals.sessions + ' sessioni pi</h3>';
  h += '<p style="color:#888">Token totali: <b>' + fmtTok(data.totals.tokens) + '</b> · Costo totale: <b>' + fmtCost(data.totals.cost) + '</b> · Tool results: <b>' + data.totals.toolResults + '</b></p>';
  h += '<table class="tbl"><thead><tr>';
  h += '<th>Inizio</th><th>ID</th><th>CWD</th><th>Turni</th><th>Tool</th><th>Err</th><th>Think</th><th>Comp</th><th>Token</th><th>Costo</th><th>Top tool</th>';
  h += '</tr></thead><tbody>';
  for (let i = 0; i < data.sessions.length; i++) {
    const s = data.sessions[i];
    const top = (s.toolBreakdown || []).slice(0, 3).map(t => t.name + '×' + t.count).join(' ');
    h += '<tr class="trow" onclick="openTraceSession(' + i + ')">';
    h += '<td>' + fmtDate(s.start) + '</td>';
    h += '<td><code>' + String(s.id || '').slice(0, 8) + '</code></td>';
    h += '<td>' + escapeHtml(wsName(s.cwd)) + '</td>';
    h += '<td>' + (s.counts.user || 0) + '</td>';
    h += '<td>' + (s.counts.toolResult || 0) + '</td>';
    h += '<td>' + (s.toolErrors || 0) + '</td>';
    h += '<td>' + (s.counts.thinking || 0) + '</td>';
    h += '<td>' + (s.counts.compactions || 0) + '</td>';
    h += '<td>' + fmtTok(s.totalTokens || 0) + '</td>';
    h += '<td>' + fmtCost(s.totalCost || 0) + '</td>';
    h += '<td style="font-size:11px;color:#888">' + escapeHtml(top) + '</td>';
    h += '</tr>';
  }
  h += '</tbody></table>';
  document.getElementById('content').innerHTML = h;
}

async function openTraceSession(idx) {
  const s = window._traceList[idx];
  if (!s) return;
  document.getElementById('content').innerHTML = '<p>Carico traccia…</p>';
  const t = await api('/api/trace?file=' + encodeURIComponent(s.file));
  if (t.error) { document.getElementById('content').innerHTML = '<p style="color:#c33">Errore: ' + escapeHtml(t.error) + '</p>'; return; }
  renderTrace(t, idx);
}

function renderTrace(t, idx) {
  let h = '';
  h += '<div style="display:flex;justify-content:space-between;align-items:center">';
  h += '<h3>🧭 Traccia sessione <code>' + String(t.id || '').slice(0, 8) + '</code></h3>';
  h += '<button onclick="showTrace()">← elenco</button>';
  h += '</div>';
  h += '<p style="color:#888">CWD <code>' + escapeHtml(wsName(t.cwd)) + '</code> · ' + fmtDate(t.start) + ' → ' + fmtDate(t.end) + ' · ' + fmtDur(t.start, t.end) + '</p>';

  // cards riepilogo
  h += '<div class="cards">';
  h += card('Turni', t.turns.length);
  h += card('Tool calls', t.counts.toolCalls);
  h += card('Tool errors', t.toolCalls.filter(x => x.isError).length);
  h += card('Thinking', t.counts.thinking);
  h += card('Compaction', t.counts.compactions);
  h += card('Context edits', t.counts.contextEdits);
  h += card('Token', fmtTok(t.usage.totalTokens));
  h += card('Costo', fmtCost(t.usage.totalCost));
  h += '</div>';

  // modelli
  if (t.usage.byModelArr && t.usage.byModelArr.length) {
    h += '<h4>Modelli</h4><table class="tbl"><thead><tr><th>Modello</th><th>Msg</th><th>Input</th><th>Output</th><th>Reasoning</th><th>Token</th><th>Costo</th></tr></thead><tbody>';
    for (const m of t.usage.byModelArr) {
      h += '<tr><td>' + escapeHtml(m.model) + '</td><td>' + m.msgs + '</td><td>' + fmtTok(m.input) + '</td><td>' + fmtTok(m.output) + '</td><td>' + fmtTok(m.reasoning) + '</td><td>' + fmtTok(m.tokens) + '</td><td>' + fmtCost(m.cost) + '</td></tr>';
    }
    h += '</tbody></table>';
  }

  // tool breakdown
  if (t.toolBreakdown && t.toolBreakdown.length) {
    h += '<h4>Tool usati</h4><div class="chips">';
    for (const tb of t.toolBreakdown) h += '<span class="chip">' + escapeHtml(tb.name) + ' <b>×' + tb.count + '</b></span>';
    h += '</div>';
  }

  // timeline eventi (compaction/context_edit/model_change evidenziati)
  h += '<h4>Timeline eventi</h4>';
  h += '<div class="tl">';
  for (const e of t.events) {
    const time = String(e.ts || '').slice(11, 19);
    let cls = '', txt = '';
    if (e.kind === 'user') { cls = 'tl-user'; txt = '👤 ' + escapeHtml((e.text || '').slice(0, 120)); }
    else if (e.kind === 'toolCall') { cls = 'tl-tool'; txt = '🔧 ' + escapeHtml(e.name) + ' ' + escapeHtml((e.args || '').slice(0, 100)); }
    else if (e.kind === 'toolResult') { cls = e.isError ? 'tl-err' : 'tl-res'; txt = (e.isError ? '❌ ' : '📥 ') + escapeHtml(e.name) + ' · ' + (e.durationMs != null ? e.durationMs + 'ms' : '?') + ' · ' + e.bytes + 'B'; }
    else if (e.kind === 'thinking') { cls = 'tl-think'; txt = '💭 ' + e.len + ' chars'; }
    else if (e.kind === 'compaction') { cls = 'tl-comp'; txt = '🗜️ COMPACTION · tokensBefore=' + (e.tokensBefore != null ? e.tokensBefore.toLocaleString() : '?') + ' · summary=' + e.summaryLen + ' chars'; }
    else if (e.kind === 'context_edit') { cls = 'tl-edit'; txt = '✂️ context_edit → ' + escapeHtml(e.targetId || ''); }
    else if (e.kind === 'model_change') { cls = 'tl-model'; txt = '🔀 model → ' + escapeHtml(e.modelId || ''); }
    else if (e.kind === 'thinking_level_change') { cls = 'tl-model'; txt = '🧠 thinking → ' + escapeHtml(e.level || ''); }
    else if (e.kind === 'session') { cls = 'tl-sess'; txt = '▶️ session start · ' + escapeHtml(wsName(e.cwd)); }
    else { cls = 'tl-other'; txt = e.kind; }
    h += '<div class="tl-row ' + cls + '"><span class="tl-time">' + time + '</span><span class="tl-txt">' + txt + '</span></div>';
  }
  h += '</div>';

  // turni
  h += '<h4>Turni (' + t.turns.length + ')</h4>';
  for (const turn of t.turns) {
    h += '<div class="turn">';
    h += '<div class="turn-head"><b>#' + turn.index + '</b> <span style="color:#888">' + fmtDate(turn.startTs) + ' → ' + String(turn.endTs || '').slice(11, 19) + '</span></div>';
    h += '<div class="turn-user">' + escapeHtml(turn.userText || '') + '</div>';
    h += '<div class="turn-stats">';
    h += '💬 ' + turn.assistantMsgs + ' msg · ';
    h += '💭 ' + turn.thinkingBlocks + ' · ';
    h += '🔧 ' + turn.toolCalls + (turn.toolErrors ? ' <span style="color:#c33">(' + turn.toolErrors + ' err)</span>' : '') + ' · ';
    h += '⏱ ' + (turn.toolMs || 0) + 'ms · ';
    h += '🪙 ' + fmtTok(turn.tokens) + ' · ';
    h += fmtCost(turn.cost);
    h += '</div>';
    h += '</div>';
  }

  document.getElementById('content').innerHTML = h;
}
// =================== FINE TRACE VIEW ===================

async function showDoctor() {
  const d = await api('/api/doctor');
  document.getElementById('pathbar').innerHTML = '<span class="breadcrumbs">🩺 Doctor</span>';
  if (d.error) { document.getElementById('content').innerHTML = '<div class="error">' + escapeHtml(d.error) + '</div>'; return; }
  let h = '<h3>🩺 Doctor</h3>';
  h += '<p style="font-size:12px;color:#8b949e">Esito: ' + (d.ok ? 'OK' : 'PROBLEMI') + ' — exit code ' + (d.ok ? 0 : 1) + '</p>';
  h += '<table><thead><tr><th>Check</th><th>Stato</th><th>Dettaglio</th></tr></thead><tbody>';
  for (const c of d.checks) {
    const color = c.status === 'FAIL' ? '#f85149' : (c.status === 'WARN' ? '#d29922' : '#3fb950');
    h += '<tr><td>' + escapeHtml(c.name) + '</td><td style="color:' + color + '">' + escapeHtml(c.status) + '</td><td>' + escapeHtml(c.detail) + '</td></tr>';
  }
  h += '</tbody></table>';
  document.getElementById('content').innerHTML = h;
}

openScope('ai-studio');
</script>
</body>
</html>
`;

async function handler(req, res) {
  const url = req.url;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  if (url.startsWith('/api/ls')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiLs(url)));
  }
  if (url.startsWith('/api/read')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiRead(url)));
  }
  if (url.startsWith('/api/search')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiSearch(url)));
  }
  if (url === '/api/system') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiSystem()));
  }
  if (url === '/api/packages') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiPackages()));
  }
  if (url.startsWith('/api/stats')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiStats()));
  }
  if (url.startsWith('/api/session')) {
    const u = new URL(url, 'http://localhost');
    const file = u.searchParams.get('file') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiSession(file)));
  }
  if (url.startsWith('/api/metrics')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiMetrics(url.includes('fresh=1'))));
  }
  if (url.startsWith('/api/trace-list')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiTraceList()));
  }
  if (url.startsWith('/api/trace')) {
    const u = new URL(url, 'http://localhost');
    const file = u.searchParams.get('file') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiTrace(file)));
  }
  if (url.startsWith('/api/collections')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiCollections()));
  }
  if (url.startsWith('/api/credits/history')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(creditsHistory()));
  }
  if (url.startsWith('/api/credits')) {
    const payload = await creditsPayload();
    snapshotCredits(payload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(payload));
  }
  if (url.startsWith('/api/models')) {
    const [openrouter, ocgo] = await Promise.all([apiModelsAsync(), apiOcModelsAsync()]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ openrouter, ocgo }));
  }
  if (url.startsWith('/api/rate')) {
    const data = await apiRateAsync();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }
  if (url.startsWith('/api/frontier')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiFrontier()));
  }
  if (url.startsWith('/api/doctor')) {
    const report = await doctor.check({ selfPort: port });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(report));
  }

  res.writeHead(404); res.end('Not found');
}

let port = Number(process.env.PORT) || 8888;
const server = http.createServer(handler);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < 8895) {
    port++;
    console.log('Porta ' + (port - 1) + ' occupata, provo ' + port);
    server.listen(port);
  } else {
    console.error(e);
    process.exit(1);
  }
});
server.listen(port, () => {
  console.log('AI-studio Explorer su http://localhost:' + port);
  console.log('Ctrl+C per fermare');
});

// Storico crediti: una tantum all'avvio e poi ogni 6h. L'append è idempotente per
// giorno, quindi il trend si riempie anche se la pagina Crediti non viene aperta.
// Il listino Go si scalda qui: Stats e Crediti mostrano i nomi dei modelli anche se
// nessuno apre la pagina Modelli.
function dailySnapshot() {
  creditsPayload().then(snapshotCredits).catch(function () {});
  apiOcPricingAsync().catch(function () {});
}
setTimeout(dailySnapshot, 5000);
setInterval(dailySnapshot, 6 * 60 * 60 * 1000);
