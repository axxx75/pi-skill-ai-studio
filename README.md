# pi-skill-ai-studio

Skill per [pi](https://pi.dev) + dashboard locale per lo **studio strutturato dell'AI**:
cartelle `temi/` `fonti/` `sintesi/`, flussi di studio/approfondimento/sintesi, ricerca
semantica con `qmd` e un explorer locale delle sessioni pi (Trace, Metriche, Stats,
Crediti OpenRouter/OpenCode Go, Modelli, Collections, Doctor).

Nessuna dipendenza npm: solo Node.js standard library. Nessun dato lascia la macchina,
tranne le chiamate alle API dei provider con le chiavi già presenti in `auth.json`.

## Requirements

| Componente | Versione / note | Obbligatorio |
|---|---|---|
| Node.js | ≥ 18 (testato su 22.23) | sì per la dashboard e doctor |
| `pi` | ≥ 1.4 (pacchetti `pi` + skill) | sì per l'uso come skill |
| `qmd` | qualsiasi versione con `qmd collection list` | no, solo ricerca semantica |
| `auth.json` | chiavi `openrouter` / `opencode-go` | no: senza chiavi le pagine Crediti/Modelli mostrano l'errore, il resto funziona |
| `models-store.json` | catalogo locale di pi | no: senza catalogo i prezzi frontiera sono `n/d` |

I path di default sono `$HOME/.pi/agent` (o `PI_CODING_AGENT_DIR`) per auth/catalogo/sessioni
e `$HOME/.local/share/ai-studio/stats` per lo storico crediti.

## Install

Da path locale (il pacchetto è caricato dal path, nessuna copia):

```bash
pi install /percorso/pi-skill-ai-studio
pi list                                            # deve comparire pi-skill-ai-studio
```

In alternativa, una sola invocazione senza toccare la configurazione:

```bash
pi -e /percorso/pi-skill-ai-studio
```

Il flag `pi.` in `package.json` carica `./skills`: la skill `ai-studio` si attiva quando la
richiesta la riguarda, oppure in modo esplicito con `/skill:ai-studio`.

La dashboard si avvia a mano (non è un servizio):

```bash
node skills/ai-studio/app/server.js            # http://localhost:8888
PORT=8899 node skills/ai-studio/app/server.js  # porta diversa
```

## Verify

```bash
node --check skills/ai-studio/app/server.js
node --check skills/ai-studio/app/trace.js
node skills/ai-studio/app/doctor.js --json                 # exit 1 se un check è FAIL
bash skills/ai-studio/app/tests/doctor-selftest.sh         # fixture: 3 sessioni finte, nessun dato reale
node skills/ai-studio/app/tests/test-oc-pricing.js
node skills/ai-studio/app/tests/test-usage-csv.js
```

Verifica della UI (il server deve essere già avviato su una porta):

```bash
PORT=8899 node skills/ai-studio/app/server.js &
node skills/ai-studio/app/tests/verify-ui.js --url http://localhost:8899
```

`verify-ui.js` non guarda il sorgente: estrae lo `<script>` che il server emette, ne valida
la sintassi e lo esegue con un DOM finto e i dati veri delle API. Copre sintassi e runtime
del render, non CSS/layout.

Output atteso di ogni comando: tutti i check verdi, exit code 0. `doctor` può uscire 0 con
qualche `WARN` (catalogo assente, righe JSONL corrotte saltate): i `WARN` sono opzionali o
degradati, solo i `FAIL` fanno uscire 1.

## Usage

| Comando / richiesta | Cosa fa |
|---|---|
| *"studio [tema]"* | crea `temi/<tema>.md` dal template e lo riempie con l'utente |
| *"approfondisci [aspetto] di [tema]"* | espande la sezione, aggiunge la fonte in `fonti/` |
| *"sintetizza [temi] in una tesi"* | scrive in `sintesi/` con tesi, evidenze, contraddizioni |
| `qmd query "..." -c ai-studio` | ricerca semantica nello studio |
| `node skills/ai-studio/app/server.js` | dashboard: Trace, Crediti, Metriche, Stats, Modelli, Collections, Doctor |
| `node skills/ai-studio/app/doctor.js` | diagnostica: node, auth/provider, catalogo, sessioni, copertura campi, stats dir, porta, righe corrotte |

Variabili (default fra parentesi):

| Variabile | Significato |
|---|---|
| `PORT` | porta HTTP (`8888`, fallback 8889…8894 se occupata) |
| `AI_STUDIO_SESSIONS_DIR` | sessioni pi (`$HOME/.pi/agent/sessions`) |
| `AI_STUDIO_STATS_DIR` | storico crediti (`$HOME/.local/share/ai-studio/stats`, creata al bisogno) |
| `AI_STUDIO_CONFIG` | scorciatoie sidebar (`$HOME/.config/ai-studio/config.json`) |
| `PI_CODING_AGENT_DIR` | dir di configurazione pi (`$HOME/.pi/agent`) |

Config delle scorciatoie (facoltativa, sostituisce i default):

```json
{
  "shortcuts": [{ "name": "ai-studio", "label": "📁 AI-studio", "root": "/percorso/studio" }],
  "quicks": [{ "label": "MEMORY.md", "path": "/percorso/MEMORY.md", "section": "Quick" }]
}
```

Una voce il cui path non esiste non viene mostrata (niente link morti). Nei totali di Stats
entrano **solo** `openrouter` e `opencode-go`: le altre sessioni sono escluse e contate come
"non supportati: N sessioni".

## Troubleshooting

| Sintomo | Causa | Rimedio |
|---|---|---|
| La pagina resta su "Caricamento" | il JS emesso ha un errore | `node skills/ai-studio/app/tests/verify-ui.js --url ...` |
| `porta libera FAIL` | un'altra istanza ascolta su `PORT` | `PORT=8899 node skills/ai-studio/app/server.js` |
| `auth.json + provider FAIL` | `auth.json` assente o senza i due provider | `pi` → login OpenRouter/OpenCode Go |
| Crediti OpenRouter in errore | chiave assente o senza permessi | verifica la chiave in `auth.json` |
| Prezzi frontiera `n/d` | `models-store.json` assente | apri una volta la pagina Modelli in pi o ignora: è opzionale |
| `sessions dir WARN/FALL` | `AI_STUDIO_SESSIONS_DIR` sbagliata o nessuna sessione | usa il default `$HOME/.pi/agent/sessions` |
| Righe JSONL corrotte | sessione troncata | nessuna azione: sono saltate e contate |
| `qmd collection ai-studio` assente | collection mai creata | chiedi all'utente il path, poi `qmd collection add` |

## Privacy

Le sessioni restano locali: la dashboard legge i JSONL e scrive solo lo storico crediti in
`AI_STUDIO_STATS_DIR`. Le uniche chiamate esterne sono OpenRouter e OpenCode Go (crediti,
listini) e il tasso EUR/USD (`open.er-api.com`), con le chiavi dell'utente. Non incollare
contenuto delle sessioni in servizi esterni senza chiedere.

## Uninstall

```bash
pi remove /percorso/pi-skill-ai-studio
# oppure: pi remove pi-skill-ai-studio
```

Poi rimuovi a mano i dati generati, se vuoi:

```bash
rm -rf "$HOME/.local/share/ai-studio"      # storico crediti
rm -f "$HOME/.config/ai-studio/config.json" # config opzionale
```

## License

MIT — vedi [LICENSE](LICENSE).
