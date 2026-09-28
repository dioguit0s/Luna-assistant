#!/usr/bin/env python3
"""Escreve training_parameters.yaml (célula 9 do notebook oficial).

Os pesos de amostragem/penalidade e a lista de features seguem o notebook —
são o que separa um modelo utilizável de um que não generaliza. Ajustar aqui
antes de mexer na arquitetura do modelo.
"""
import os

import yaml

WORK = "/work"
os.chdir(WORK)

config = {}

config["window_step_ms"] = 10
config["train_dir"] = "trained_models/wakeword"

config["features"] = [
    {
        "features_dir": "generated_augmented_features",
        "sampling_weight": 2.0,
        "penalty_weight": 1.0,
        "truth": True,
        "truncation_strategy": "truncate_start",
        "type": "mmap",
    },
    {
        "features_dir": "negative_datasets/speech",
        "sampling_weight": 10.0,
        "penalty_weight": 1.0,
        "truth": False,
        "truncation_strategy": "random",
        "type": "mmap",
    },
    {
        "features_dir": "negative_datasets/dinner_party",
        "sampling_weight": 10.0,
        "penalty_weight": 1.0,
        "truth": False,
        "truncation_strategy": "random",
        "type": "mmap",
    },
    {
        "features_dir": "negative_datasets/no_speech",
        "sampling_weight": 5.0,
        "penalty_weight": 1.0,
        "truth": False,
        "truncation_strategy": "random",
        "type": "mmap",
    },
    {  # Só usado para validação/teste
        "features_dir": "negative_datasets/dinner_party_eval",
        "sampling_weight": 0.0,
        "penalty_weight": 1.0,
        "truth": False,
        "truncation_strategy": "split",
        "type": "mmap",
    },
]

# Negativos pt-BR opcionais (ver 04b_generate_custom_negatives.py e "Se o
# modelo dispara demais" no README) — cada grupo só entra se alguém rodou
# aquela etapa com WAVs nele. Grupos separados porque têm volumes muito
# diferentes (minutos de TV vs. segundos de frases): num diretório só, o
# sorteio quase nunca pegaria as frases confundíveis.
# - fundo: fala pt-BR comum, mesmo peso do `speech` em inglês.
# - confundiveis: "lua", "uma", "luna" sem "hey"... — são o motivo desta
#   etapa (a causa mais provável de disparo em frase aleatória em pt-BR), mas
#   vêm de poucos segundos de áudio repetidos à exaustão; peso alto demais
#   ensina o modelo a rejeitar "luna" em si e derruba o recall. É o primeiro
#   parâmetro a baixar se o modelo ficar "surdo".
# Checa o mmap de treino, não só a pasta: o 04b gera num .tmp e só renomeia no
# fim, mas uma pasta criada à mão (ou por uma execução quebrada de uma versão
# antiga) quebraria o carregamento no treino.
# confundiveis era 5.0 no retreino de 2026-09-25, que derrubou o acerto no
# hold-out real de 13/14 (modelo antigo) para 6/14.
CUSTOM_PTBR_GROUPS = {"fundo": 10.0, "confundiveis": 2.0}
for _group, _weight in CUSTOM_PTBR_GROUPS.items():
    _dir = f"negative_datasets/custom_ptbr_{_group}"
    if not os.path.isdir(os.path.join(_dir, "training", "wakeword_mmap")):
        print(f"[config] {_dir} sem features de treino — pulando (etapa opcional, ver README)")
        continue
    config["features"].append(
        {
            "features_dir": _dir,
            "sampling_weight": _weight,
            "penalty_weight": 1.0,
            "truth": False,
            "truncation_strategy": "random",
            "type": "mmap",
        }
    )
    print(f"[config] incluindo negativos pt-BR de {_dir} (sampling_weight={_weight})")

# Positivos reais (03b_generate_real_positives.py) — gravações de gente de
# verdade, com a mesma augmentation dos sintéticos. Peso maior que o dos 2000
# sintéticos (2.0): são o que mais se parece com o microfone real, e sem eles o
# modelo trata qualquer voz humana real como negativa.
_real_pos = "real_positive_features"
if os.path.isdir(os.path.join(_real_pos, "training", "wakeword_mmap")):
    config["features"].append(
        {
            "features_dir": _real_pos,
            "sampling_weight": 3.0,
            "penalty_weight": 1.0,
            "truth": True,
            "truncation_strategy": "truncate_start",
            "type": "mmap",
        }
    )
    print(f"[config] incluindo positivos reais de {_real_pos} (sampling_weight=3.0)")
else:
    print(f"[config] {_real_pos} sem features de treino — só positivos sintéticos")

# Passos de UM processo de treino. O `./run.sh train` treina em rodadas curtas
# (TRAIN_ROUND_STEPS, padrão 500) e passa o valor por TRAINING_STEPS: cada
# validação do model_train_eval vaza ~3,8 GB que nunca são liberados, então um
# processo longo morre por OOM na 3ª validação. 5000 é o total histórico, usado
# só se alguém rodar o 06_train.sh direto.
config["training_steps"] = [int(os.environ.get("TRAINING_STEPS", "5000"))]
config["positive_class_weight"] = [1]
config["negative_class_weight"] = [20]
config["learning_rates"] = [0.001]
config["batch_size"] = 128

config["time_mask_max_size"] = [0]
config["time_mask_count"] = [0]
config["freq_mask_max_size"] = [0]
config["freq_mask_count"] = [0]

config["eval_step_interval"] = 500
config["clip_duration_ms"] = 1500

config["target_minimization"] = 0.9
config["minimization_metric"] = None
config["maximization_metric"] = "average_viable_recall"

with open("training_parameters.yaml", "w") as f:
    yaml.dump(config, f)

print("training_parameters.yaml escrito em", os.path.join(WORK, "training_parameters.yaml"))
