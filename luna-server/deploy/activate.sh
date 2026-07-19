#!/usr/bin/env bash
#
# Efetiva uma release do luna-server: troca o symlink /opt/luna/current,
# reinicia o servico e valida via GET /health. Se a validacao falhar,
# volta para a release anterior e sai com erro.
#
# Uso: activate.sh <sha>
set -euo pipefail

SHA="${1:?uso: activate.sh <sha>}"

LUNA_ROOT="${LUNA_ROOT:-/opt/luna}"
RELEASES_DIR="$LUNA_ROOT/releases"
CURRENT_LINK="$LUNA_ROOT/current"
NEW_RELEASE="$RELEASES_DIR/$SHA"

HEALTH_PORT="${WS_PORT:-8080}"
HEALTH_URL="http://127.0.0.1:$HEALTH_PORT/health"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-20}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

log() { echo "[activate] $*"; }

if [[ ! -d "$NEW_RELEASE" ]]; then
  log "ERRO: release nao encontrada em $NEW_RELEASE"
  exit 1
fi
if [[ ! -f "$NEW_RELEASE/dist/index.js" ]]; then
  log "ERRO: $NEW_RELEASE/dist/index.js ausente — build nao foi copiado"
  exit 1
fi

# Guarda a release anterior para eventual rollback.
PREVIOUS_RELEASE=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK")"
  log "release atual: $PREVIOUS_RELEASE"
fi

# Troca atomica: ln -sfn sozinho nao e atomico quando o alvo ja existe.
swap_to() {
  local target="$1"
  ln -sfn "$target" "$CURRENT_LINK.tmp"
  mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
}

health_ok() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

log "ativando release $SHA"
swap_to "$NEW_RELEASE"
sudo systemctl restart luna-server

if health_ok; then
  log "health check OK — release $SHA no ar"
  curl -fsS --max-time 2 "$HEALTH_URL" || true
  echo
else
  log "ERRO: health check falhou em ${HEALTH_TIMEOUT_S}s ($HEALTH_URL)"
  sudo systemctl status luna-server --no-pager --lines=30 || true

  if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
    log "rollback para $PREVIOUS_RELEASE"
    swap_to "$PREVIOUS_RELEASE"
    sudo systemctl restart luna-server
    if health_ok; then
      log "rollback OK — versao anterior restaurada"
    else
      log "ATENCAO: rollback tambem falhou. Servico esta fora do ar."
    fi
  else
    log "ATENCAO: sem release anterior para rollback."
  fi

  exit 1
fi

# Poda releases antigas, preservando a atual.
log "podando releases (mantendo $KEEP_RELEASES)"
CURRENT_TARGET="$(readlink -f "$CURRENT_LINK")"
# shellcheck disable=SC2012
ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | tail -n "+$((KEEP_RELEASES + 1))" | while read -r old; do
  old="${old%/}"
  if [[ "$(readlink -f "$old")" != "$CURRENT_TARGET" ]]; then
    log "removendo $old"
    rm -rf "$old"
  fi
done

log "deploy concluido"
