---
name: ai-studio
description: "Metodo di studio strutturato dell'AI: cartelle temi/ fonti/ sintesi/, flussi 'studio [tema]', 'approfondisci [aspetto]', 'sintetizza [temi]' e ricerca semantica con qmd (collection ai-studio). Usa quando l'utente chiede di studiare un tema AI, approfondire un aspetto già studiato o sintetizzare più temi in una tesi."
license: MIT
compatibility: "node >= 18; qmd solo per la ricerca semantica"
---

# AI-studio — metodo di studio e dashboard

Uno spazio di studio per temi AI con lente professionale (infrastruttura, sostenibilità,
integrazione, costo/efficienza). Lo studio vive in tre cartelle; la dashboard locale legge
le sessioni di pi e i crediti dei provider senza modificare nulla.

## Struttura dello studio

Nel workspace scelto dall'utente (default: la cwd):

```
temi/     un file .md per tema (parti da temi/_TEMPLATE.md)
fonti/    note su articoli, video, paper letti
sintesi/  elaborazioni trasversali tra più temi
```

Se le cartelle non esistono, creale prima di scrivere. Un file `temi/_TEMPLATE.md` con le
sezioni ricorrenti (cos'è, stato dell'arte, player, costi, rischi, domande aperte) rende i
temi confrontabili: proponilo tu la prima volta.

## Flussi

| Richiesta | Cosa fai |
|---|---|
| *"studio [tema]"* | Cerca fonti recenti, crea `temi/<tema>.md` dal template e riempilo **con** l'utente, sezione per sezione |
| *"approfondisci [aspetto] di [tema]"* | Espandi la sezione esistente; aggiungi la fonte in `fonti/` e collega il file del tema |
| *"sintetizza [temi] in una tesi"* | File in `sintesi/`: tesi, evidenze per tema, contraddizioni, cosa resta da verificare |

Regole:

1. Prima di scrivere, leggi il tema esistente e le fonti collegate: non duplicare sezioni.
2. Ogni affermazione non ovvia ha una fonte in `fonti/` (titolo, URL, data, 3-5 righe di note).
3. Distingui sempre fatto verificato, stima e opinione. Niente numeri inventati: se un prezzo
   o una data non sono nella fonte, scrivi "da verificare".
4. Dopo modifiche ai file dello studio, aggiorna l'indice semantico (vedi sotto).

## Ricerca semantica (qmd)

La collection qmd si chiama `ai-studio` e punta alla radice dello studio.

```bash
qmd query "..."                 # cerca in tutte le collection
qmd query "..." -c ai-studio    # solo lo studio
qmd update                      # reindicizza dopo modifiche ai file
qmd collection list             # verifica che ai-studio esista e il path sia giusto
```

Se la collection non esiste o punta altrove, fermati e chiedi all'utente prima di crearla:
il path della collection è una decisione sua. Se `qmd` non è installato, la ricerca
semantica non è disponibile: usa `grep` sui file md e dillo.

## Dashboard locale (opzionale)

```bash
node {baseDir}/app/server.js      # http://localhost:8888 (PORT per cambiarla)
node {baseDir}/app/doctor.js      # diagnostica; exit 1 se un check è FAIL
```

Pagine: Trace, Crediti (OpenRouter + OpenCode Go), Metriche, Stats, Modelli, Collections,
Doctor. Nessuna dipendenza npm. I dati sono le sessioni di pi e, per i crediti, le API dei
provider con le chiavi già in `auth.json`.

Variabili utente (default fra parentesi):

| Variabile | Significato |
|---|---|
| `PORT` | porta HTTP (8888; se occupata il server prova 8889…8894) |
| `AI_STUDIO_SESSIONS_DIR` | sessioni pi (`$HOME/.pi/agent/sessions`) |
| `AI_STUDIO_STATS_DIR` | storico crediti (`$HOME/.local/share/ai-studio/stats`) |
| `AI_STUDIO_CONFIG` | scorciatoie della sidebar (`$HOME/.config/ai-studio/config.json`) |
| `PI_CODING_AGENT_DIR` | dir di configurazione pi (`$HOME/.pi/agent`) |

Nella sidebar compaiono solo le scorciatoie la cui directory esiste. I totali di Stats
includono **solo** `openrouter` e `opencode-go`; le altre sessioni sono escluse e contate
come "non supportati".

## Cosa non fare

- Non modificare `auth.json`, `settings.json` o i file di pi per far funzionare la dashboard.
- Non inviare i dati delle sessioni (prompt, costi, path) a servizi esterni: le uniche
  chiamate di rete sono OpenRouter e OpenCode Go, con le chiavi dell'utente.
- Non dichiarare completato uno studio senza aver aggiornato `qmd update`.
