#!/bin/bash
# Não treina mais (--train 0): só carrega o melhor checkpoint já salvo,
# quantiza e converte para o .tflite streaming — o mesmo que 06_train.sh faria
# ao final de um treino completo, mas sem gastar mais passos. Usado quando o
# modelo já convergiu e decidimos parar de treinar de propósito.
set -euo pipefail
cd /work

python -m microwakeword.model_train_eval \
  --training_config='training_parameters.yaml' \
  --train 0 \
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
