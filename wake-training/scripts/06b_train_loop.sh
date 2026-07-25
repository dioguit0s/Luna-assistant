#!/bin/bash
# O model_train_eval.py (TF) acumula memória ao longo de milhares de passos e
# acaba morto pelo OOM killer (visto em produção: crashava mais cedo com 7.6GB
# de RAM na VM, mais tarde com 11.7GB — sinal de vazamento, não de limite
# fixo). Reiniciar o processo libera tudo; --restore_checkpoint 1 (já em
# 06_train.sh) retoma exatamente do último checkpoint salvo, sem perder passos.
set -uo pipefail
cd /work

MAX_RESTARTS=20
for i in $(seq 1 "$MAX_RESTARTS"); do
  echo "=== tentativa $i/$MAX_RESTARTS ==="
  bash /scripts/06_train.sh
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "treino concluido com sucesso na tentativa $i"
    exit 0
  fi
  echo "saiu com codigo $code (137 = OOM esperado) — reiniciando do checkpoint..."
done

echo "esgotou $MAX_RESTARTS tentativas sem concluir"
exit 1
