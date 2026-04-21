#!/usr/bin/env bash
# deploy.sh - Script automatico di build + commit + push per TerreniReady
#
# Uso:
#   ./deploy.sh                        -> commit su main, auto-deploy su Render
#   ./deploy.sh --branch mio-branch    -> commit su branch separato
#   ./deploy.sh --skip-build           -> salta la build locale (solo commit+push)
#   ./deploy.sh --message "nota mia"   -> imposta un commit message custom
#
# Lo script si ferma al primo errore (set -e) per non pushare build rotte.

set -euo pipefail

# ---- parametri ---------------------------------------------------------------

BRANCH=""
SKIP_BUILD="false"
CUSTOM_MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD="true"
      shift
      ;;
    --message)
      CUSTOM_MESSAGE="${2:-}"
      shift 2
      ;;
    *)
      echo "[ERRORE] parametro sconosciuto: $1"
      exit 1
      ;;
  esac
done

# ---- helper ------------------------------------------------------------------

say() { printf "\n\033[1;34m==>\033[0m %s\n" "$1"; }
ok()  { printf "\033[1;32m✓\033[0m %s\n" "$1"; }
err() { printf "\033[1;31m✗\033[0m %s\n" "$1" >&2; }

# ---- step 0: preflight -------------------------------------------------------

cd "$(dirname "$0")"

if [[ ! -f "package.json" ]]; then
  err "package.json non trovato, non sono nella cartella giusta"
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "questa cartella non è un repo git"
  exit 1
fi

# ---- step 1: lint ------------------------------------------------------------

if [[ "$SKIP_BUILD" == "false" ]]; then
  say "Eseguo lint (ESLint)..."
  if npm run lint; then
    ok "Lint passato"
  else
    err "Lint fallito. Correggi gli errori sopra e riprova."
    exit 1
  fi

  # ---- step 2: build -----------------------------------------------------------

  say "Eseguo build locale (Next.js)..."
  if npm run build; then
    ok "Build passata"
  else
    err "Build fallita. Controlla gli errori sopra."
    exit 1
  fi
else
  say "Skip lint + build (--skip-build attivo)"
fi

# ---- step 3: commit ----------------------------------------------------------

if [[ -z "$(git status --porcelain)" ]]; then
  say "Nessuna modifica da committare. Skip commit."
else
  say "Modifiche rilevate:"
  git status --short

  MSG="${CUSTOM_MESSAGE:-perf: cap pre-filtro particelle e soft timeout filtro anti-urbano

- Aggiunge MAX_TERRAINS_PRE_FILTER=140 per limitare il set candidato prima del filtro urbano
- Il filtro anti-urbano usa Promise.race con OBSTACLE_FILTER_SOFT_TIMEOUT_MS=15s
- Su provider Overpass lenti restituiamo particelle non filtrate con warning
  invece di bloccare la pipeline
- Impatto atteso: scansione da minuti a ~30-60s su province piccole}"

  git add -A
  git commit -m "$MSG"
  ok "Commit creato"
fi

# ---- step 4: push ------------------------------------------------------------

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [[ -n "$BRANCH" && "$BRANCH" != "$CURRENT_BRANCH" ]]; then
  say "Creo/switcho branch: $BRANCH"
  git checkout -B "$BRANCH"
  git push -u origin "$BRANCH"
  ok "Pushato su $BRANCH (non auto-deploya: apri PR o fai merge su main)"
else
  say "Push su $CURRENT_BRANCH..."
  git push origin "$CURRENT_BRANCH"
  if [[ "$CURRENT_BRANCH" == "main" ]]; then
    ok "Push su main completato. Render partirà con l'auto-deploy."
    echo ""
    echo "   Monitora il deploy su: https://dashboard.render.com"
    echo "   URL live: https://terreniready.onrender.com"
  else
    ok "Push su $CURRENT_BRANCH completato."
  fi
fi

echo ""
ok "Fatto!"
