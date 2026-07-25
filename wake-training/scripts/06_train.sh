#!/bin/bash
# Treina o modelo (célula 10 do notebook oficial). CPU-only aqui — sem GPU
# NVIDIA disponível — então é a etapa mais demorada do pipeline (pode levar
# horas para os 10000 passos). Retomável: rodar de novo continua de onde parou
# (mas reinicia a contagem de passos do yaml se train_dir já tiver checkpoint).
set -euo pipefail
cd /work

python -m microwakeword.model_train_eval \
  --training_config='training_parameters.yaml' \
  --train 1 \
  --restore_checkpoint 1 \
  --test_tf_nonstreaming 0 \
  --test_tflite_nonstreaming 0 \
  --test_tflite_nonstreaming_quantized 0 \
  --test_tflite_streaming 0 \
  --test_tflite_streaming_quantized 1 \
  --use_weights "best_weights" \
  mixednet \
  --pointwise_filters "64,64,64,64" \
  --repeat_in_block "1, 1, 1, 1" \
  --mixconv_kernel_sizes '[5], [7,11], [9,15], [23]' \
  --residual_connection "0,0,0,0" \
  --first_conv_filters 32 \
  --first_conv_kernel_size 5 \
  --stride 3
