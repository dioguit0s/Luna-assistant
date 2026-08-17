# ADR 003 — Engine de Wake Word no Satélite

**Status:** Aceito
**Data:** 2026-07-24
**Contexto:** Épico 4 — Autonomia (A1)

## Contexto

O Épico 2 entregou o satélite em modo open-mic: `StateMachine::update()` saía de `IDLE_LISTENING` para `ACTIVE_STREAMING` incondicionalmente, e o ESP32-S3 transmitia 100% do áudio capturado ao `luna-server`. O plano do projeto sempre foi trocar esse trigger por wake word local, e a escolha declarada na seção 4 do `PROJETO LUNA.md` era o **ESP-SR** da Espressif — motivo, inclusive, da escolha do ESP32-S3 (aceleração vetorial e PSRAM).

Ao implementar, o ESP-SR se mostrou inviável para a palavra "Luna":

- O `esp-sr 2.4.6` que vem no toolchain pioarduino embarca um `srmodels.bin` com apenas quatro modelos: `wn9_hiesp` ("Hi ESP"), `mn7_en`, `vadnet1_medium` e `fst`.
- O catálogo completo do WakeNet9 (~60 modelos, listados no `sdkconfig` do `framework-arduinoespressif32-libs`) não tem "Luna", e o WakeNet **não suporta português** — só chinês, inglês, japonês e francês. O README do esp-sr lista pt como "planejado".
- Modelo customizado é serviço pago: a Espressif exige corpus de 20.000 amostras de 500+ locutores (2-3 semanas, preço sob consulta); um terceiro (`custom-espsr.com`) cobra ~US$ 1.000 com ~10 dias úteis de prazo.
- Independentemente do modelo, o wrapper Arduino `ESP_SR` assume posse de um `I2SClass` e roda sua própria task de leitura. Isso colidiria com `AudioCapture`, dono do I2S0, e o wrapper não expõe o áudio processado pelo AFE — ou seja, o satélite perderia o streaming para o servidor, que é a razão de ele existir.

## Decisão

Usar **microWakeWord** (TFLite-micro streaming) como engine de wake word, com o modelo comunitário **"Hey Luna"**.

Três razões:

1. **Existe modelo para a nossa palavra, de graça.** O modelo foi treinado por Daniel Reimer e submetido em `esphome/micro-wake-word-models#20`. Procedência e hashes em [`luna-firmware/models/README.md`](../../luna-firmware/models/README.md).
2. **Custo de integração zero.** A `libespressif__esp-tflite-micro.a` do toolchain já traz compilados o interpretador e todos os kernels `tflite::tflm_signal` que o preprocessador de áudio usa (`WINDOW`, `FFT_AUTO_SCALE`, `RFFT`, `ENERGY`, `FILTER_BANK*`, `PCAN`), e o `pioarduino-build.py` já adiciona o include path e o `-lespressif__esp-tflite-micro`. Nenhuma entrada nova em `lib_deps`, nenhum ESP-IDF, nenhuma partição `model`/`srmodels.bin`.
3. **Não toca no pipeline de áudio.** O `WakeWord` só recebe o PCM que o `AudioCapture` já leu. O `captureTask` continua dono único do I2S0 e o streaming para o servidor segue idêntico.

A frase é **"Hey Luna"**, não "Luna": palavra única e curta de duas sílabas dispara demais sozinha (TV, conversa de fundo), e foi por isso que a comunidade treinou com o prefixo.

## Consequências

- A tabela de partição passou de `default.csv` (4 MB, `app0` de 1,25 MB) para `default_16MB.csv` (`app0` de 6,5 MB). O binário foi de ~1,15 MB para ~1,47 MB e não caberia mais. A partição `nvs` é idêntica nas duas tabelas, então o segredo de autenticação gravado na NVS sobrevive à troca.
- A PSRAM deixa de ser requisito da inferência (os modelos somam ~72 KB e as arenas ficam na RAM interna, onde o `esp-nn` rende). Ela segue em uso pelo buffer de playback e passa a hospedar o pré-buffer de captura.
- O modelo foi treinado em inglês (`trained_languages: ["en"]`). Se a taxa de rejeição com sotaque pt-BR incomodar, o caminho é treinar uma versão própria em <https://microwakeword.com/train> e trocar só o `.tflite` mais as constantes do manifesto — o código do firmware não muda.
- O modelo vem de um PR **não mergeado** no repositório oficial. Por isso os `.tflite` são vendorizados no repo com hash, e o build não baixa nada.
- **Os modelos "hey_luna" da comunidade não servem.** No bring-up, nenhum dos três disparava no INMP441, apesar de a integração estar correta (provado rodando o pipeline completo num container com `tflite-micro`: os `hey_luna` mal reagem nem a um "hey luna" de TTS limpo). O `okay_nabu` — modelo oficial, fortemente aumentado — dispara com folga (0.95-1.00) **no mesmo microfone**, o que isola a causa: os `hey_luna` são fracos/sub-treinados, não é o hardware nem o código. O que separa um modelo que funciona de um que não é a **augmentation** de treino, não a frase. Consequência: o `okay_nabu` fica como wake word provisória ("Okay Nabu") e o A1 só fecha de fato com um "Ei Luna" treinado com a mesma qualidade — ver [models/TRAINING.md](../../luna-firmware/models/TRAINING.md).
- `WAKE_WORD_ENABLED=0` em `include/config.h` restaura o open-mic. O mesmo acontece em runtime, via `StateMachine::setWakeWordAvailable(false)`, se o detector não conseguir subir — um satélite degradado é melhor que um satélite mudo.

## Alternativas descartadas

- **ESP-SR com `wn9_hiesp` ("Hi ESP")**: funcionaria hoje, sem custo, mas mudaria o nome da assistente e ainda esbarraria na disputa pelo I2S0.
- **Pagar um modelo `wn9` "Luna"** (~US$ 1.000 ou cotação Espressif): resolveria a palavra, mas não o problema do wrapper `ESP_SR` sobre o I2S, e não se justifica antes de o produto estar validado.
- **AFE do ESP-SR alimentado manualmente** (`esp_afe_sr_iface`, sem o wrapper Arduino): daria NS/AGC/AEC de brinde e resolveria o I2S, mas custa ~740 KB de PSRAM e ~18% de CPU, e continua sem modelo para "Luna". Vale reconsiderar como fonte de AEC se o eco voltar a incomodar — é ortogonal a esta decisão.

## Nota — extensão para o `luna-desktop`

O satélite virtual (`luna-desktop`) reusa os mesmos modelos `.tflite` decididos
aqui, mas não pode carregar o preprocessador de features do mesmo jeito (sem
tflite-micro fora do firmware) — ver [ADR 004](004-wake-word-no-desktop.md).
