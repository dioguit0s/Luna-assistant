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

LUNA_ENV_FILE="${LUNA_ENV_FILE:-/etc/luna-server.env}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-20}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

log() { echo "[activate] $*"; }

# A porta e definida em $LUNA_ENV_FILE, que o systemd injeta no processo — o
# runner nao a tem no ambiente. Ler dali evita que uma troca de WS_PORT no
# servidor faca o health check bater na porta errada e provocar rollback falso.
# Lemos so a chave WS_PORT em vez de dar `source`: o arquivo contem segredos.
resolve_health_port() {
  if [[ -n "${WS_PORT:-}" ]]; then
    echo "$WS_PORT"
    return
  fi

  if [[ -r "$LUNA_ENV_FILE" ]]; then
    local port
    port="$(sed -n 's/^[[:space:]]*WS_PORT[[:space:]]*=[[:space:]]*["'\'']\?\([0-9]\+\).*/\1/p' \
      "$LUNA_ENV_FILE" | tail -n1)"
    if [[ -n "$port" ]]; then
      echo "$port"
      return
    fi
    echo 8080
    return
  fi

  log "AVISO: $LUNA_ENV_FILE ilegivel por $(id -un) — assumindo porta 8080."
  log "       Se WS_PORT for outra, o health check falha e provoca rollback falso."
  log "       Corrija com: sudo usermod -aG luna $(id -un)"
  echo 8080
}

HEALTH_PORT="$(resolve_health_port)"
HEALTH_URL="http://127.0.0.1:$HEALTH_PORT/health"

if [[ ! -d "$NEW_RELEASE" ]]; then
  log "ERRO: release nao encontrada em $NEW_RELEASE"
  exit 1
fi
if [[ ! -f "$NEW_RELEASE/dist/index.js" ]]; then
  log "ERRO: $NEW_RELEASE/dist/index.js ausente — build nao foi copiado"
  exit 1
fi

# A unit systemd NAO faz parte da release: activate.sh so copia dist/ e
# config/, nunca /etc/systemd/system/luna-server.service (isso e passo manual
# do setup inicial, ver README). Uma mudanca em deploy/luna-server.service
# que nao seja reinstalada fica invisivel ate o proximo restart falhar de um
# jeito que nao tem nada a ver com a causa real -- foi assim que
# StateDirectory=luna-server (para o ReminderStore escrever sob
# ProtectSystem=strict) queimou um deploy inteiro: o processo saia com EROFS
# no boot, o Restart=always ficava reiniciando em loop, e so o health check
# estourava em 20s -- nenhuma pista de systemd unit desatualizada em lugar
# nenhum. Falhar aqui, antes de tocar no symlink ou reiniciar o servico,
# troca 20s de timeout as cegas por um erro imediato e acionavel.
INSTALLED_UNIT="/etc/systemd/system/luna-server.service"
REPO_UNIT="$(dirname "$0")/luna-server.service"
if [[ -f "$INSTALLED_UNIT" && -f "$REPO_UNIT" ]] && ! cmp -s "$REPO_UNIT" "$INSTALLED_UNIT"; then
  log "ERRO: deploy/luna-server.service mudou mas a unit instalada no servidor nao foi atualizada."
  log "      O deploy automatico nunca escreve em /etc/systemd/system/ -- isso e manual, uma vez por mudanca de unit."
  log "      Rode no servidor e repita o deploy:"
  log "        sudo cp $REPO_UNIT $INSTALLED_UNIT"
  log "        sudo systemctl daemon-reload"
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

log "ativando release $SHA (health check em $HEALTH_URL)"
swap_to "$NEW_RELEASE"
sudo systemctl restart luna-server

if health_ok; then
  log "health check OK — release $SHA no ar"
  curl -fsS --max-time 2 "$HEALTH_URL" || true
  echo
else
  log "ERRO: health check falhou em ${HEALTH_TIMEOUT_S}s ($HEALTH_URL)"
  # Sem flag nenhuma: precisa bater exatamente com a entrada NOPASSWD do
  # sudoers (ver README, "sudoers para o restart") -- `--no-pager --lines=30`
  # aqui pedia senha (sudo nao interativo falha) e o diagnostico nunca saia.
  sudo systemctl status luna-server || true

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
