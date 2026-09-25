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
./run.sh samples            # gera ~2000 "hey luna" sintéticas (Piper TTS)
./run.sh augdata             # baixa RIR/AudioSet/FMA para augmentation
./run.sh negatives           # baixa os datasets negativos pré-processados
./run.sh custom_negatives    # opcional: negativos pt-BR próprios, ver seção abaixo
./run.sh features            # aplica augmentation e gera os espectrogramas
./run.sh train               # treina (a etapa longa)
./run.sh export              # copia o .tflite final e escreve o manifesto JSON
```

Cada etapa pula sozinha se a saída já existir — pode interromper e retomar (exceto
`custom_negatives`, que sempre regenera a partir dos WAVs).

Rodando numa máquina que também serve produção (ex. o servidor do `luna-server`), limite o
container para que um OOM do treino mate só ele, e não um processo do host:

```bash
MWW_DOCKER_ARGS="--memory=8g --cpus=3" ./run.sh train
```

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

## Se o modelo dispara demais (falso-positivo em frase aleatória)

Sintoma oposto ao acima: o wake word ativa sozinho ouvindo conversa normal, TV, etc.
Ordem recomendada (mais barato → mais caro):

1. **Recalibrar o cutoff com áudio pt-BR de verdade primeiro.** O procedimento de
   `luna-desktop/wakeword-sidecar/README.md` ("Calibração do cutoff no desktop") vale
   igual para o satélite: grave ≥15 min de TV/conversa **em português** (o único teste
   feito até hoje foi 50s de ruído sem fala nenhuma — não prova nada sobre frase real) e
   ≥5 repetições de "Hey Luna", rode com `--trace`/`WAKE_DEBUG` e compare `max_mean_prob`.
   Se a folga entre o pior positivo e o pior negativo for pequena (<0,05), subir só o
   `WAKE_PROB_CUTOFF` (`luna-firmware/include/config.h`) ou `WAKEWORD_THRESHOLD`
   (`.env` do `luna-desktop`) já resolve, sem retreinar nada.
2. **Se a folga for grande mesmo assim** (ou seja, o cutoff já está bem calibrado e o
   problema é o modelo confundir a frase, não o limiar): o suspeito é os negativos de
   treino serem só em inglês (`speech`/`dinner_party`/`no_speech`, baixados por
   `04_download_negatives.sh`) — nenhuma frase em português entrou como "isto não é a
   wake word" durante o treino. `./run.sh custom_negatives` (opcional, roda sempre e é
   no-op se vazio) existe para isto:
   - Grave (ou baixe de um corpus como o Common Voice pt-BR) alguns clipes de fala
     comum em português: TV, conversa de fundo, e principalmente **palavras parecidas
     com "hey luna"** — "lua", "uma", "luna" sem o "hey", "e aí, Luna?" — as que mais
     provavelmente cruzam o cutoff por acidente.
   - Salve cada clipe como `.wav` (mono ou estéreo, qualquer sample rate) em uma de duas
     subpastas de `wake-training/work/custom_negatives_wav/` (fora do git):
     - `fundo/` — TV, rádio, conversa. Recortado em janelas de 3 s; mínimo ~30 s de áudio.
     - `confundiveis/` — as frases parecidas com "hey luna". Janelas de 1,5 s com
       sobreposição de 1 s; mínimo ~6 s de áudio.

     Separados porque os volumes são muito diferentes: num grupo só, 20 min de TV virariam
     ~99% das amostras e as frases confundíveis quase nunca seriam sorteadas. Abaixo do
     mínimo, a etapa falha com uma mensagem explicando.
   - `./run.sh custom_negatives` gera as features em
     `work/negative_datasets/custom_ptbr_{fundo,confundiveis}/`;
     `05_write_training_config.py` inclui cada grupo como negativo automaticamente se as
     features existirem (`CUSTOM_PTBR_GROUPS`: fundo 10.0, igual ao `speech` em inglês;
     confundiveis 5.0) — nenhuma mudança manual de config necessária. Apagar os WAVs e rodar a etapa de novo
     remove as features, e o próximo treino volta a não usá-las.
   - Retreine (`./run.sh train`) e reexporte (`./run.sh export`).
3. **Se ainda disparar**: considerar ligar `time_mask_*`/`freq_mask_*` (SpecAugment,
   hoje zerados em `05_write_training_config.py`) ou subir `negative_class_weight`
   (hoje 20) — não testado neste repositório ainda, ver comentários no notebook oficial
   do microWakeWord antes de mexer.
