#!/usr/bin/env bash
# doctor-selftest.sh — fixture isolata per app/doctor.js.
#
# Perché esiste: il doctor legge sessioni JSONL reali. Qui si generano 3 sessioni finte
# (una completa, una senza costi, una con una riga corrotta) in una dir temporanea e si
# punta il doctor lì via env: nessun dato dell'utente viene letto o scritto.
#
# Uso:  bash app/tests/doctor-selftest.sh     Exit: 0 = tutti i check passati, 1 = fallito.
set -u

PKG_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DOCTOR="$PKG_DIR/app/doctor.js"
TMP="$(mktemp -d /tmp/ai-studio-doctor.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

SESSION_DIR="$TMP/sessions/--demo--"
mkdir -p "$SESSION_DIR"

# --- 1. sessione completa: usage.cost, totalTokens, model, provider, toolCall, durationMs
cat > "$SESSION_DIR/2026-01-01T10-00-00Z_fake-1.jsonl" <<'EOF'
{"type":"session","version":3,"id":"fake-1","timestamp":"2026-01-01T10:00:00.000Z","cwd":"/tmp/demo"}
{"type":"model_change","timestamp":"2026-01-01T10:00:01.000Z","provider":"openrouter","modelId":"openai/gpt-5"}
{"type":"message","timestamp":"2026-01-01T10:00:02.000Z","message":{"role":"assistant","provider":"openrouter","model":"openai/gpt-5","usage":{"input":10,"output":90,"totalTokens":100,"cost":{"total":0.5}},"content":[{"type":"toolCall","id":"t1","name":"read","arguments":{}}]}}
{"type":"message","timestamp":"2026-01-01T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"read","durationMs":42,"content":[{"type":"text","text":"ok"}]}}
EOF

# --- 2. sessione senza costi: usage c'è ma usage.cost manca
cat > "$SESSION_DIR/2026-01-02T10-00-00Z_fake-2.jsonl" <<'EOF'
{"type":"session","version":3,"id":"fake-2","timestamp":"2026-01-02T10:00:00.000Z","cwd":"/tmp/demo"}
{"type":"message","timestamp":"2026-01-02T10:00:01.000Z","message":{"role":"assistant","provider":"opencode-go","model":"glm-5","usage":{"input":5,"output":5,"totalTokens":10},"content":[{"type":"text","text":"ciao"}]}}
EOF

# --- 3. sessione con una riga JSONL corrotta (deve essere contata e saltata)
cat > "$SESSION_DIR/2026-01-03T10-00-00Z_fake-3.jsonl" <<'EOF'
{"type":"session","version":3,"id":"fake-3","timestamp":"2026-01-03T10:00:00.000Z","cwd":"/tmp/demo"}
{"type":"message","timestamp":"2026-01-03T10:00:01.000Z","message":{"role":"assistant","provider":"openrouter","model":"openai/gpt-5","usage":{"input":1,"output":9,"totalTokens":10,"cost":{"total":0.1}},"content":[{"type":"text","text":"ok"}]}}
{ questa riga non e' JSON
EOF

PORT="$(node -e 'const n=require("net").createServer();n.listen(0,"127.0.0.1",()=>{console.log(n.address().port);n.close();});')"
run_doctor() {
  PI_CODING_AGENT_DIR="${1:-$HOME/.pi/agent}" \
  AI_STUDIO_SESSIONS_DIR="$TMP/sessions" \
  AI_STUDIO_STATS_DIR="$TMP/stats" \
  PORT="$PORT" \
  node "$DOCTOR" 2>&1
}

fail=0
expect() { # $1 = sottostringa attesa, $2 = nome check, $3 = output
  if printf '%s' "$3" | grep -qF "$1"; then echo "  ✓ $2"; else echo "  ✗ $2 (atteso: $1)"; fail=1; fi
}

echo "doctor-selftest — fixture in $TMP"
OUT="$(run_doctor)"; CODE=$?
echo "$OUT"
echo

expect "3 sessioni valide su 3 file" "3 sessioni valide su 3 file" "$OUT"
expect "usage.cost 2/3 sessioni" "copertura usage.cost = 2/3 (sessione senza costi esclusa)" "$OUT"
expect "usage.totalTokens 3/3 sessioni" "copertura usage.totalTokens = 3/3" "$OUT"
expect "durationMs 1/3 sessioni" "copertura durationMs = 1/3" "$OUT"
expect "model 3/3 sessioni" "copertura model = 3/3" "$OUT"
expect "provider 3/3 sessioni" "copertura provider = 3/3" "$OUT"
expect "toolCall 1/3 sessioni" "copertura toolCall = 1/3" "$OUT"
expect "1 righe saltate (1 file)" "riga corrotta contata e saltata" "$OUT"
expect "WARN  righe JSONL illeggibili" "righe corrotte = WARN, non FAIL" "$OUT"
if [ "$CODE" -eq 0 ]; then echo "  ✓ exit 0 (nessun FAIL)"; else echo "  ✗ exit $CODE, atteso 0"; fail=1; fi
if [ -d "$TMP/stats" ]; then echo "  ✓ stats dir creata al bisogno"; else echo "  ✗ stats dir non creata"; fail=1; fi

# --- catalogo assente: opzionale, prezzi n/d, nessun FAIL
if [ -f "$HOME/.pi/agent/auth.json" ]; then
  mkdir -p "$TMP/agent"
  ln -s "$HOME/.pi/agent/auth.json" "$TMP/agent/auth.json"
  OUT2="$(run_doctor "$TMP/agent")"; CODE2=$?
  expect "opzionale: prezzi n/d" "catalogo assente = WARN con prezzi n/d" "$OUT2"
  expect "WARN  catalogo modelli" "catalogo assente non è FAIL" "$OUT2"
  if [ "$CODE2" -eq 0 ]; then echo "  ✓ exit 0 senza catalogo"; else echo "  ✗ exit $CODE2 senza catalogo, atteso 0"; fail=1; fi
else
  echo "  - SKIP catalogo assente: ~/.pi/agent/auth.json non trovato"
fi

echo
if [ "$fail" -ne 0 ]; then echo "SELFTEST FALLITO"; exit 1; fi
echo "TUTTI I CHECK OK"
