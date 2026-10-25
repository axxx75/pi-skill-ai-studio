#!/usr/bin/env node
/**
 * trace.js — Parser di sessioni pi (JSONL) per AI-studio Explorer
 * Zero dipendenze (solo fs/path/os). Trasforma l'event log grezzo di pi
 * in una traccia strutturata: turni, tool call, thinking, compaction, costi.
 *
 * CLI:
 *   node trace.js <file.jsonl>            → sommario umano
 *   node trace.js <file.jsonl> --json     → JSON completo
 *   node trace.js --list [sessionsDir]    → elenco sessioni con conteggi
 *
 * Modulo:
 *   const trace = require('./trace.js');
 *   const t = trace.traceFile('/path/session.jsonl');
 *   const list = trace.listSessions('/path/sessions');
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const DEFAULT_SESSIONS = process.env.AI_STUDIO_SESSIONS_DIR || path.join(AGENT_DIR, 'sessions');

const MAX_LINES = 200000;
const MAX_RESULT_PREVIEW = 400;
const MAX_ARGS_PREVIEW = 300;
const MAX_SUMMARY_PREVIEW = 2000;
const MAX_THINKING_PREVIEW = 200;

function clip(s, n) {
  if (s == null) return null;
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  if (t.length <= n) return t;
  return t.slice(0, n) + '… [+' + (t.length - n) + ' chars]';
}

function blockText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) {
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function argsSummary(args) {
  if (!args || typeof args !== 'object') return clip(args, MAX_ARGS_PREVIEW);
  const out = {};
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (typeof v === 'string') out[k] = clip(v, 120);
    else if (Array.isArray(v)) out[k] = '[' + v.length + ' items]';
    else if (v && typeof v === 'object') out[k] = '{' + Object.keys(v).join(',') + '}';
    else out[k] = v;
  }
  return clip(JSON.stringify(out), MAX_ARGS_PREVIEW);
}

function traceFile(fp) {
  const out = {
    file: fp, id: null, cwd: null, version: null, start: null, end: null, hasSession: false, parentSession: null, subagentRuns: [],
    counts: { records: 0, user: 0, assistant: 0, toolResult: 0, system: 0, thinking: 0, toolCalls: 0, compactions: 0, contextEdits: 0, custom: 0 },
    models: [], thinkingChanges: [], toolCalls: [], compactions: [], contextEdits: [], custom: [], events: [], turns: [],
    usage: { totalTokens: 0, totalCost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, byModel: {} },
    stopReasons: {}, latency: { msgs: 0, totalMs: 0 },
  };

  let raw;
  try { raw = fs.readFileSync(fp, 'utf-8'); }
  catch (e) { return { error: e.message, file: fp }; }

  const lines = raw.split('\n');
  const toolById = {};
  let currentTurn = null, lastModel = null, n = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (++n > MAX_LINES) { out.truncated = true; break; }
    let o; try { o = JSON.parse(line); } catch { continue; }
    out.counts.records++;
    const ts = o.timestamp;

    if (o.type === 'session') {
      out.id = o.id; out.cwd = o.cwd; out.version = o.version; out.start = ts;
      out.hasSession = true; out.parentSession = o.parentSession || null;
      out.events.push({ ts, kind: 'session', id: o.id, cwd: o.cwd });
      continue;
    }
    if (o.type === 'model_change') {
      if (o.modelId) lastModel = o.modelId;
      out.models.push({ ts, provider: o.provider || null, modelId: o.modelId || null });
      out.events.push({ ts, kind: 'model_change', provider: o.provider || null, modelId: o.modelId || null });
      out.end = ts || out.end;
      continue;
    }
    if (o.type === 'thinking_level_change') {
      out.thinkingChanges.push({ ts, level: o.thinkingLevel || null });
      out.events.push({ ts, kind: 'thinking_level_change', level: o.thinkingLevel || null });
      continue;
    }
    if (o.type === 'compaction') {
      const c = { ts, tokensBefore: o.tokensBefore != null ? o.tokensBefore : null, firstKeptEntryId: o.firstKeptEntryId || null, summary: clip(o.summary, MAX_SUMMARY_PREVIEW), summaryLen: (o.summary || '').length };
      out.compactions.push(c); out.counts.compactions++;
      out.events.push({ ts, kind: 'compaction', tokensBefore: c.tokensBefore, summaryLen: c.summaryLen });
      continue;
    }
    if (o.type === 'context_edit') {
      out.contextEdits.push({ ts, targetId: o.targetId || null, replacement: o.replacement == null ? null : clip(o.replacement, 120) });
      out.counts.contextEdits++;
      out.events.push({ ts, kind: 'context_edit', targetId: o.targetId || null });
      continue;
    }
    if (o.type === 'custom_message' && o.customType === 'subagent-notify') {
      const runs = (o.details || {}).runs;
      if (Array.isArray(runs)) for (const r of runs) out.subagentRuns.push({ runId: r.runId || null, agent: r.agent || null, status: r.status || null, durationMs: r.durationMs || null, sessionValue: r.sessionValue || null });
      continue;
    }
    if (o.type === 'custom') {
      const cu = { ts, customType: o.customType || null };
      if (o.customType === 'subagent-slash-result') {
        const r = ((o.details || {}).result || {}).details || {};
        cu.mode = r.mode || null;
        cu.results = Array.isArray(r.results) ? r.results.map(x => ({
          agent: x.agent || null, sessionName: x.sessionName || null, exitCode: x.exitCode,
          usage: x.usage || null,
          status: (x.progress && x.progress.status) || null,
          tokens: (x.progress && x.progress.tokens) || 0,
          toolCount: (x.progress && x.progress.toolCount) || 0,
          recentTools: Array.isArray(x.progress && x.progress.recentTools) ? x.progress.recentTools.slice(0, 10) : [],
        })) : [];
        cu.spawnBudget = r.spawnBudget || null;
      }
      out.custom.push(cu); out.counts.custom++;
      continue;
    }
    if (o.type !== 'message') continue;

    const m = o.message || {};
    const role = m.role || '?';
    out.end = ts || out.end;
    const model = m.model || o.modelId || lastModel || null;
    const provider = m.provider || null;

    if (role === 'user') {
      out.counts.user++;
      currentTurn = { index: out.turns.length + 1, startTs: ts, endTs: ts, userText: clip(blockText(m.content), 300), assistantMsgs: 0, thinkingBlocks: 0, toolCalls: 0, toolErrors: 0, toolMs: 0, tokens: 0, cost: 0, models: {} };
      out.turns.push(currentTurn);
      out.events.push({ ts, kind: 'user', text: currentTurn.userText });
      continue;
    }

    if (role === 'assistant') {
      out.counts.assistant++;
      if (currentTurn) { currentTurn.assistantMsgs++; currentTurn.endTs = ts; }
      if (m.stopReason) out.stopReasons[m.stopReason] = (out.stopReasons[m.stopReason] || 0) + 1;
      if (typeof m.durationMs === 'number') { out.latency.msgs++; out.latency.totalMs += m.durationMs; }
      const u = m.usage;
      if (u) {
        const tok = u.totalTokens || 0;
        const cost = (u.cost && u.cost.total) || 0;
        out.usage.totalTokens += tok; out.usage.totalCost += cost;
        out.usage.input += u.input || 0; out.usage.output += u.output || 0;
        out.usage.cacheRead += u.cacheRead || 0; out.usage.cacheWrite += u.cacheWrite || 0;
        out.usage.reasoning += u.reasoning || 0;
        const mk = (provider && model) ? provider + '/' + model : (model || 'unknown');
        if (!out.usage.byModel[mk]) out.usage.byModel[mk] = { msgs: 0, tokens: 0, cost: 0, input: 0, output: 0, reasoning: 0 };
        const bm = out.usage.byModel[mk];
        bm.msgs++; bm.tokens += tok; bm.cost += cost;
        bm.input += u.input || 0; bm.output += u.output || 0; bm.reasoning += u.reasoning || 0;
        if (currentTurn) { currentTurn.tokens += tok; currentTurn.cost += cost; currentTurn.models[mk] = (currentTurn.models[mk] || 0) + 1; }
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'thinking') {
            out.counts.thinking++;
            if (currentTurn) currentTurn.thinkingBlocks++;
            out.events.push({ ts, kind: 'thinking', len: (b.thinking || '').length, preview: clip(b.thinking, MAX_THINKING_PREVIEW) });
          } else if (b.type === 'toolCall') {
            out.counts.toolCalls++;
            if (currentTurn) currentTurn.toolCalls++;
            const idx = out.toolCalls.push({ id: b.id || null, name: b.name || '?', argsSummary: argsSummary(b.arguments), ts, resultTs: null, durationMs: null, isError: null, resultBytes: null, resultPreview: null }) - 1;
            if (b.id) toolById[b.id] = idx;
            out.events.push({ ts, kind: 'toolCall', name: b.name || '?', id: b.id || null, args: argsSummary(b.arguments) });
          }
        }
      }
      continue;
    }

    if (role === 'toolResult') {
      out.counts.toolResult++;
      const txt = blockText(m.content);
      const bytes = txt.length;
      const dur = typeof m.durationMs === 'number' ? m.durationMs : null;
      const isErr = m.isError === true;
      if (currentTurn) { currentTurn.endTs = ts || currentTurn.endTs; if (dur != null) currentTurn.toolMs += dur; if (isErr) currentTurn.toolErrors++; }
      const tcid = m.toolCallId;
      if (tcid != null && toolById[tcid] != null) {
        const tc = out.toolCalls[toolById[tcid]];
        tc.resultTs = ts || m.timestamp || null; tc.durationMs = dur; tc.isError = isErr; tc.resultBytes = bytes; tc.resultPreview = clip(txt, MAX_RESULT_PREVIEW);
      }
      out.events.push({ ts, kind: 'toolResult', name: m.toolName || '?', id: tcid || null, durationMs: dur, isError: isErr, bytes });
      continue;
    }

    if (role === 'system') out.counts.system++;
  }

  const toolNames = {};
  for (const tc of out.toolCalls) toolNames[tc.name] = (toolNames[tc.name] || 0) + 1;
  out.toolBreakdown = Object.entries(toolNames).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  out.usage.byModelArr = Object.entries(out.usage.byModel).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.cost - a.cost);

  // KPI di inferenza: solo campi già presenti nel JSONL, nessuna raccolta aggiuntiva.
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const u = out.usage;
  const toolErr = out.toolCalls.filter(x => x.isError).length;
  const toolMs = out.toolCalls.reduce((a, x) => a + (x.durationMs || 0), 0);
  out.kpi = {
    userMsgs: out.counts.user, turns: out.turns.length,
    cacheHitPct: pct(u.cacheRead, u.input + u.cacheRead),
    reasoningPct: pct(u.reasoning, u.output),
    toolErrorPct: pct(toolErr, out.toolCalls.length), toolErrorCount: toolErr, toolCalls: out.toolCalls.length,
    stopLength: out.stopReasons.length || 0, stopError: out.stopReasons.error || 0, stopAborted: out.stopReasons.aborted || 0,
    msgAvgMs: out.latency.msgs ? Math.round(out.latency.totalMs / out.latency.msgs) : null,
    toolAvgMs: out.toolCalls.length ? Math.round(toolMs / out.toolCalls.length) : null,
    compactions: out.counts.compactions, contextEdits: out.counts.contextEdits,
  };

  return out;
}

function listSessions(dir) {
  const base = dir || DEFAULT_SESSIONS;
  const sessions = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.jsonl')) {
        let st = null;
        try { st = fs.statSync(fp); } catch {}
        const t = traceFile(fp);
        if (t.error || !t.hasSession) continue;
        sessions.push({ file: fp, dir: path.basename(d), id: t.id, cwd: t.cwd, parentSession: t.parentSession, kpi: t.kpi, start: t.start, end: t.end, sizeBytes: st ? st.size : null, counts: t.counts, toolErrors: t.toolCalls.filter(x => x.isError).length, totalTokens: t.usage.totalTokens, totalCost: t.usage.totalCost, models: t.models.map(x => x.modelId).filter(Boolean), toolBreakdown: t.toolBreakdown });
      }
    }
  };
  walk(base);
  sessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  return sessions;
}


function metrics(dir) {
  const base = dir || DEFAULT_SESSIONS;
  const files = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.jsonl')) files.push(fp);
    }
  };
  walk(base);

  const byDay = {};       // { 'YYYY-MM-DD': { sessions, tokens, cost, toolMs } }
  const byModel = {};     // { 'model-id': { sessions, tokens, cost } }
  const toolUsage = {};   // { 'tool-name': { count, totalMs, maxMs, errors } }
  const compactionAlerts = [];
  const subagents = [];
  const metaByPath = {};      // fp -> { id, cwd, day, calls }
  const subList = [];         // sessioni figlie (per il rollup dopo il loop)
  const parentOf = {};        // fp -> parentSession
  const sessionKpi = [];      // KPI per sessione utente
  const runByParent = {};     // fp padre -> [ run, ... ]

  let totalSessions = 0, totalTokens = 0, totalCost = 0;
  let subSessions = 0, subTokens = 0, subCost = 0, userTokens = 0, userCost = 0;

  for (const fp of files.sort()) {
    const t = traceFile(fp);
    if (t.error || !t.hasSession) continue;
    const isSub = !!t.parentSession;
    const u = t.usage || {};
    totalTokens += u.totalTokens || 0;
    totalCost += u.totalCost || 0;
    if (isSub) { subSessions++; subTokens += u.totalTokens || 0; subCost += u.totalCost || 0; }
    else {
      totalSessions++; userTokens += u.totalTokens || 0; userCost += u.totalCost || 0;
    }

    const day = (t.start || '').slice(0, 10) || 'unknown';
    if (!isSub) sessionKpi.push({ id: t.id, day, cwd: t.cwd, model: (t.usage.byModelArr[0] || {}).model || null, tokens: u.totalTokens || 0, cost: +(u.totalCost || 0).toFixed(4), input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, reasoning: u.reasoning || 0, assistantMsgs: t.counts.assistant, msgTotalMs: t.latency.totalMs, ...t.kpi });
    if (!byDay[day]) byDay[day] = { sessions: 0, tokens: 0, cost: 0, toolMs: 0 };
    byDay[day].sessions++;
    byDay[day].tokens += u.totalTokens || 0;
    byDay[day].cost += u.totalCost || 0;

    for (const [mid, mu] of Object.entries(u.byModel || {})) {
      if (!byModel[mid]) byModel[mid] = { sessions: 0, tokens: 0, cost: 0 };
      byModel[mid].sessions++;
      byModel[mid].tokens += mu.tokens || 0;
      byModel[mid].cost += mu.cost || 0;
    }

    // durata per tool (durationMs dai toolResult)
    for (const tc of t.toolCalls) {
      const name = tc.name || 'unknown';
      if (!toolUsage[name]) toolUsage[name] = { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
      toolUsage[name].count++;
      if (tc.durationMs != null) {
        toolUsage[name].totalMs += tc.durationMs;
        if (tc.durationMs > toolUsage[name].maxMs) toolUsage[name].maxMs = tc.durationMs;
        byDay[day].toolMs += tc.durationMs;
      }
      if (tc.isError) toolUsage[name].errors++;
    }

    // alert compattazioni frequenti (>=2 per sessione)
    if (t.counts.compactions >= 2) {
      compactionAlerts.push({ file: fp, day, id: t.id, cwd: t.cwd, count: t.counts.compactions });
    }

    // subagent: meta del padre (chiamate); i figli si accumulano dopo il loop
    const calls = (t.toolCalls || []).filter(tc => tc.name === 'subagent').length;
    parentOf[fp] = t.parentSession || null;
    metaByPath[fp] = { id: t.id, cwd: t.cwd, day, calls };
    if (isSub) subList.push({ fp, parent: t.parentSession, tokens: u.totalTokens || 0, cost: u.totalCost || 0, turns: t.counts.assistant || 0 });
    if (t.subagentRuns && t.subagentRuns.length) (runByParent[fp] = runByParent[fp] || []).push(...t.subagentRuns);
  }

  // rollup figli -> padre TOP-LEVEL (i subagent annidati risalgono la catena parentSession)
  const topParent = (fp) => {
    let p = parentOf[fp], guard = 0;
    while (p && parentOf[p] && guard++ < 20) p = parentOf[p];
    return p || null;
  };
  const subByParent = {};
  for (const s of subList) {
    const top = topParent(s.fp) || s.parent;
    const agg = subByParent[top] || (subByParent[top] = { tokens: 0, cost: 0, turns: 0, agents: 0 });
    agg.tokens += s.tokens; agg.cost += s.cost; agg.turns += s.turns; agg.agents++;
  }

  // subagent tree: unione padri (chiamate subagent) e padri con sessioni figlie
  const seenRuns = new Set();
  const parentPaths = new Set(Object.keys(subByParent));
  for (const fp in metaByPath) if (metaByPath[fp].calls > 0) parentPaths.add(fp);
  for (const p of parentPaths) {
    const meta = metaByPath[p] || { id: null, cwd: null, day: 'unknown', calls: 0 };
    const agg = subByParent[p] || { tokens: 0, cost: 0, turns: 0, agents: 0 };
    let ok = 0, failed = 0, i = 0;
    for (const r of (runByParent[p] || [])) {
      const key = p + '|' + (r.runId || ('idx' + (i++)));
      if (seenRuns.has(key)) continue;
      seenRuns.add(key);
      if (r.status === 'failed' || r.status === 'error') failed++; else if (r.status) ok++;
    }
    subagents.push({ file: p, day: meta.day, id: meta.id, cwd: meta.cwd, calls: meta.calls, results: agg.agents, agents: agg.agents, tokens: agg.tokens, cost: +agg.cost.toFixed(4), turns: agg.turns, ok, failed });
  }
  subagents.sort((a, b) => (a.day || '').localeCompare(b.day || ''));

  const toolArr = Object.entries(toolUsage).map(([name, v]) => ({
    name, count: v.count, errors: v.errors,
    avgMs: v.count && v.totalMs ? Math.round(v.totalMs / v.count) : 0,
    totalMs: v.totalMs, maxMs: v.maxMs,
  })).sort((a, b) => b.count - a.count);

  const byDayArr = Object.entries(byDay).map(([d, v]) => ({ day: d, ...v })).sort((a, b) => a.day.localeCompare(b.day));
  const byModelArr = Object.entries(byModel).map(([m, v]) => ({ model: m, ...v, cost: +v.cost.toFixed(4) })).sort((a, b) => b.cost - a.cost);

  return {
    totals: {
      sessions: totalSessions, tokens: totalTokens, cost: +totalCost.toFixed(4),
      userTokens, userCost: +userCost.toFixed(4),
      subSessions, subTokens, subCost: +subCost.toFixed(4),
    },
    byDay: byDayArr,
    byModel: byModelArr,
    toolUsage: toolArr,
    compactionAlerts,
    subagents,
    sessionsKpi: sessionKpi.sort((a, b) => (b.day || '').localeCompare(a.day || '')),
  };
}

module.exports = { traceFile, listSessions, metrics, DEFAULT_SESSIONS };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--list' || args[0] === '-l') {
    const sessions = listSessions(args[1]);
    console.log('Sessioni trovate: ' + sessions.length + '\n');
    for (const s of sessions) {
      console.log((s.start || '?').slice(0, 16).replace('T', ' ') + '  ' + String(s.id || '').slice(0, 8) + '  ' + String(s.cwd || '').replace(os.homedir(), '~'));
      const k = s.kpi || {};
      console.log('    KPI cache=' + (k.cacheHitPct == null ? '-' : k.cacheHitPct + '%') + ' reason=' + (k.reasoningPct == null ? '-' : k.reasoningPct + '%') + ' toolErr=' + (k.toolErrorPct == null ? '-' : k.toolErrorPct + '%') + ' stopLen=' + (k.stopLength || 0) + ' msgAvg=' + (k.msgAvgMs == null ? '-' : k.msgAvgMs + 'ms'));
      console.log('    usr=' + s.counts.user + ' asst=' + s.counts.assistant + ' tool=' + s.counts.toolResult + ' toolCall=' + s.counts.toolCalls + ' think=' + s.counts.thinking + ' compaction=' + s.counts.compactions + ' ctxEdit=' + s.counts.contextEdits + '  tok=' + s.totalTokens.toLocaleString() + '  cost=$' + s.totalCost.toFixed(4));
      if (s.toolBreakdown.length) console.log('    tools: ' + s.toolBreakdown.slice(0, 8).map(t => t.name + ' x' + t.count).join(', '));
      console.log('');
    }
    process.exit(0);
  }
  const fp = args[0];
  if (!fp) { console.error('Uso: node trace.js <file.jsonl> [--json]  |  node trace.js --list [dir]'); process.exit(1); }
  const t = traceFile(fp);
  if (t.error) { console.error('Errore: ' + t.error); process.exit(1); }
  if (args.includes('--json')) { console.log(JSON.stringify(t, null, 2)); process.exit(0); }
  console.log('Sessione   ' + (t.id || '?'));
  console.log('CWD        ' + (t.cwd || '?'));
  console.log('Inizio     ' + (t.start || '?'));
  console.log('Fine       ' + (t.end || '?'));
  console.log('Record     ' + t.counts.records);
  console.log('Messaggi   user=' + t.counts.user + '  assistant=' + t.counts.assistant + '  toolResult=' + t.counts.toolResult);
  console.log('Thinking   ' + t.counts.thinking + ' blocchi');
  console.log('ToolCalls  ' + t.counts.toolCalls);
  console.log('Compaction ' + t.counts.compactions + '   ContextEdits ' + t.counts.contextEdits);
  console.log('Token      ' + t.usage.totalTokens.toLocaleString() + '   Costo $' + t.usage.totalCost.toFixed(4));
  console.log('\nTurni: ' + t.turns.length);
  for (const turn of t.turns.slice(-8)) {
    console.log('  #' + turn.index + '  ' + String(turn.startTs || '').slice(11, 19) + '  tools=' + turn.toolCalls + ' (err ' + turn.toolErrors + ')' + '  think=' + turn.thinkingBlocks + '  tok=' + turn.tokens + '  ' + (turn.userText || '').slice(0, 60).replace(/\n/g, ' '));
  }
  console.log('\nTool piu usati:');
  for (const tb of t.toolBreakdown.slice(0, 12)) console.log('  ' + tb.name + '  x' + tb.count);
}
