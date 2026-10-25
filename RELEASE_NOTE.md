# Release notes — pi-skill-ai-studio

Formato: una sezione per versione, dalla più recente. Ogni voce = modifica testata e accettata da Axxx,
allineata su tre punti (repo locale `~/PI/repos/pi-skill-ai-studio`, checkout installato, GitHub).

## 1.1.0 — 2026-10-25

**KPI di inferenza + aggregazione subagent**

- `trace.js`: blocco `kpi` per sessione calcolato dai campi già presenti nei JSONL — cache hit %
  (`cacheRead/(input+cacheRead)`), reasoning/output %, tool error %, stopReason (`length`/`error`/`aborted`),
  latenza media messaggio e tool, compaction, context edit, turni. CLI `--list` li stampa.
- `trace.js`: `metrics()` separa sessioni utente e subagent; il rollup figli risale la catena
  `parentSession` fino al padre top-level (prima i subagent annidati restavano orfani).
- `server.js` (📊 Stats): i subagent non contano più come sessioni utente; card "di cui subagent"
  con costo separato. Costo totale invariato (nessun doppio conteggio).
- `server.js` (📈 Metriche): nuova sezione "🎯 KPI inferenza" con card aggregate ponderate e tabella
  per sessione (ultime 30).
- `server.js`: `/api/metrics` in cache 60s (`?fresh=1` per forzare), `computeMs` e `cachedAt` nel payload;
  la pagina mostra il tempo di calcolo e il bottone "↻ ricalcola".
- `tests/verify-ui.js`: da 36 a 46 check (KPI, split subagent, cache).

**Baseline misurata** (60 sessioni utente, 132 subagent): cache hit 93.9%, reasoning/output 66.1%,
tool error 4.6%, output troncati 0, stopReason error 60 / aborted 23, latenza media messaggio 27.1s;
subagent = 4.48$ su 15.61$ totali (28.7%).

**Test**: `verify-ui` 46/46, `test-stats-filter`, `test-usage-csv`, `test-oc-pricing` tutti OK.

## 1.0.1 — 2026-10-25

- Fix: bottone "se avessi usato la frontiera" anche nella pagina Metriche (con fetch di fallback).
- Fix: record legacy senza `provider` dichiarato rientra nei totali.
