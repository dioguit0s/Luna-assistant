# Treino local da wake word "Hey Luna"

Pipeline do [microWakeWord](https://github.com/kahrendt/microWakeWord) rodando local em
Docker — gratuito, sem depender do site pago `microwakeword.com/train` nem do notebook
oficial (quebrado no Colab desde que ele foi para Python 3.11, ver
[issue #62](https://github.com/kahrendt/microWakeWord/issues/62)).

Motivação completa em [`docs/adr/003-wake-word-engine.md`](../docs/adr/003-wake-word-engine.md):
os modelos "hey_luna" da comunidade são fracos e não disparam no INMP441 do satélite;
o `okay_nabu` oficial prova que o hardware funciona bem com um modelo bem treinado.

## Status do treino atual (2026-07-25)

Rodado até convergência antecipada: acurácia de treino passou de 99,9% já no passo 500 e não
melhorou depois (sinal de que 2000 amostras de uma única voz TTS saturam rápido). Parado
manualmente por overfitting — ver `AUC 0.536` no `tflite_streaming_roc.txt` exportado
(perto de aleatório no split de teste, apesar da acurácia de treino alta). Resultado copiado
para `../luna-firmware/models/hey_luna_trained.tflite` + `.json`, **em validação com voz
humana real** — ver a nota de risco em `../luna-firmware/models/README.md`.

Também descobri no processo: `microwakeword/train.py` reinicia o contador de passos a cada
invocação do processo (não retoma a contagem global do checkpoint, só os pesos/otimizador) —
por isso o loop de auto-reinício (`06b_train_loop.sh`, criado para contornar um vazamento de
memória do TF que mata o processo por OOM em treinos longos) não converge para um total fixo:
cada reinício roda mais `training_steps` inteiros por cima do que já foi treinado. Se retreinar,
considere isso ao escolher `training_steps` e monitore a acurácia de treino para decidir quando
parar manualmente, em vez de confiar que o processo vai parar sozinho no alvo certo.

**Se for retreinar para melhorar a generalização**, o suspeito nº 1 é a diversidade das amostras
positivas (mais vozes/pronúncias, não só mais passos) — ver "Se o modelo sair fraco" abaixo.

## Requisitos

- Docker Desktop (o Dockerfile fixa Python 3.10 + as versões que realmente funcionam
  juntas — TF 2.21, torch 2.4.1, numpy 2.x; ver comentários no Dockerfile para o porquê
  de cada pin).
- CPU apenas — sem GPU NVIDIA disponível nesta máquina (só Intel Iris Xe integrada).
  O treino de ~10000 passos leva horas, não minutos. Rodar em background.
- Espaço em disco: os datasets de augmentation (AudioSet, FMA, RIRs) e os negativos
  somam alguns GB. Tudo vai para `./work/`, fora do repositório git.

## Uso

```bash
docker build -t mww-train .   # uma vez
./run.sh                      # roda o pipeline inteiro
```

Ou etapa por etapa (útil para rodar o treino em background sem travar o terminal):

```bash
./run.sh samples      # gera ~2000 "hey luna" sintéticas (Piper TTS)
./run.sh augdata       # baixa RIR/AudioSet/FMA para augmentation
./run.sh negatives     # baixa os datasets negativos pré-processados
./run.sh features      # aplica augmentation e gera os espectrogramas
./run.sh train         # treina (a etapa longa)
./run.sh export        # copia o .tflite final e escreve o manifesto JSON
```

Cada etapa pula sozinha se a saída já existir — pode interromper e retomar.

## Depois do treino

`work/hey_luna.tflite` e `work/hey_luna.json` são o resultado. Integrar no firmware:

```bash
cp work/hey_luna.tflite work/hey_luna.json ../luna-firmware/models/
cd ../luna-firmware
python tools/tflite_to_header.py models/hey_luna.tflite src/wake/models/hey_luna_model_data.h g_hey_luna_model_data
```

Depois, em `include/config.h`: `WAKE_PHRASE`, `WAKE_PROB_CUTOFF` (começar no valor do
manifesto e **recalibrar pelo `raw_max` do log com `WAKE_DEBUG=1`**, no microfone real —
foi assim que se achou 0.90 para o `okay_nabu` em vez do 0.97 "de fábrica"),
`WAKE_SLIDING_WINDOW` e `WAKE_ARENA_BYTES`. Passo a passo completo em
[`../luna-firmware/models/TRAINING.md`](../luna-firmware/models/TRAINING.md).

## Se o modelo sair fraco

O notebook oficial já avisa: "a maioria dos treinos não sai bom de primeira". Antes de
desistir, tente nesta ordem (mais barato → mais caro):

1. Mais passos de treino (`training_steps` em `training_parameters.yaml`, hoje 10000).
2. Mais amostras positivas (`MAX_SAMPLES` em `01_generate_samples.sh`, hoje 2000) e/ou
   variar `noise-scales`/`length-scales` do Piper para mais diversidade de pronúncia.
3. Ajustar os pesos de amostragem/penalidade em `05_write_training_config.py`.
4. Se nada disso ajudar e o "Hey Luna" continuar ruim, `okay_nabu` fica como fallback —
   ele já está validado e funcionando no satélite.
