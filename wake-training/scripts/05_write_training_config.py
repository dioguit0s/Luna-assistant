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

config["training_steps"] = [5000]  # reduzido de 10000: treino em CPU vaza memória e
# precisa de reinícios periódicos (ver scripts/06b_train_loop.sh); menos passos
# = menos ciclos de OOM+retomada até concluir.
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
