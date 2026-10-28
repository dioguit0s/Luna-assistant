# Modelos de wake word

Os `.tflite` aqui são **vendorizados de propósito**: o build não baixa nada. O modelo
"Hey Luna" vem de um PR ainda **não mergeado** no repositório oficial, então depender da
rede em build time deixaria o firmware refém de um fork de terceiro.

Os arrays C que o firmware compila ficam em [`../src/wake/models/`](../src/wake/models/) e são
gerados por [`../tools/tflite_to_header.py`](../tools/tflite_to_header.py). Regerar depois de
trocar qualquer `.tflite`:

```bash
python tools/tflite_to_header.py models/hey_luna_ptbr_v2.tflite src/wake/models/hey_luna_model_data.h g_hey_luna_model_data
```

## Estado atual: `hey_luna_ptbr_v2` em validação no satélite

O header compilado (`../src/wake/models/hey_luna_model_data.h`) contém hoje o
**`hey_luna_ptbr_v2.tflite`** — retreinado do zero em 2026-10-27 (`../../wake-training/`, ver o
README lá), mesma arquitetura e mesma quantização de entrada do `hey_luna_ptbr` e do `okay_nabu`
(mixednet, stride 3). Detalhes do treino e das medições em
[`hey_luna_ptbr_v2.json`](hey_luna_ptbr_v2.json).

Ele substitui o `hey_luna_ptbr`, que disparava sozinho 12,6 vezes por hora em fala pt-BR
(diagnóstico de 2026-10-26 em [`../../wake-training/README.md`](../../wake-training/README.md)).
Mesmos positivos do `hey_luna_ptbr`; os negativos ganharam ~10 h de fala pt-BR lida (FLEURS
`train`) e frases confundíveis sintéticas com o formato do positivo ("ei, Helena", "uma"...).
Medido pelo `./run.sh evaluate` (mesmo frontend de features e mesma lógica de disparo do
firmware), só em áudio que nenhum dos dois viu no treino:

| Áudio | `hey_luna_ptbr` (0,99, o que estava em uso) | **`hey_luna_ptbr_v2` (0,85)** |
|---|---|---|
| hold-out das gravações reais (14, nunca treinado) | 13/14 | **13/14** |
| `hey-luna.wav` — mic do desktop, 11 tentativas | 11/11 | **11/11** |
| FLEURS pt-BR `dev`+`test`, 4,5 h (falsos/hora) | 12,6 | **1,1** |
| frases confundíveis do hold-out (disparam, de 56) | 16 | **3** (todas "Ei, Lula") |
| `okay-nabu.wav` — outra wake word, 8x (disparos falsos) | 1 | **0** |

⚠️ **O cutoff mudou de escala: 0,85, não 0,99.** O v2 é menos convicto nos positivos: em 0,88
ele já perde um "hey luna" do `hey-luna.wav`, e em 0,99 acerta só 9/11. Não reaproveite o 0,99
do `hey_luna_ptbr`.

⚠️ **Falta medir no INMP441.** Os números acima são de áudio de arquivo; o cutoff do satélite
(`WAKE_PROB_CUTOFF` em `include/config.h`, hoje 0,85) precisa ser calibrado pelo `raw_max` com
`WAKE_DEBUG`, e o teste de ≥15 min de TV/conversa real sem disparar continua pendente.

Histórico: os três `hey_luna*` da comunidade (`hey_luna.tflite`, `_v2`, `_v3`) são fracos e não
disparam neste hardware (INMP441) — só o `okay_nabu` (modelo oficial) provou que o hardware está
bom. O `hey_luna_trained` (2026-07-25, só positivos sintéticos em inglês) ficou com recall baixo
em voz real (3/11 no mic do desktop). O `hey_luna_ptbr` (2026-09-28) resolveu o recall com
"hey luna" real, mas disparava em fala pt-BR comum. Detalhes em
[ADR 003](../../docs/adr/003-wake-word-engine.md) e [TRAINING.md](TRAINING.md).

### Reverter se o `hey_luna_ptbr_v2` não funcionar bem no satélite

Para o modelo anterior (mesma frase; acerta tanto quanto, mas dispara ~10x mais em fala pt-BR):

```bash
python tools/tflite_to_header.py models/hey_luna_ptbr.tflite src/wake/models/hey_luna_model_data.h g_hey_luna_model_data
```

E em `include/config.h`: `WAKE_PROB_CUTOFF 0.99f`.

Para o `okay_nabu` (validado no hardware, muda a frase):

```bash
python tools/tflite_to_header.py models/okay_nabu.tflite src/wake/models/hey_luna_model_data.h g_hey_luna_model_data
```

E em `include/config.h`: `WAKE_PHRASE "Okay Nabu"`, `WAKE_PROB_CUTOFF 0.90f`.

| Arquivo | SHA-256 | Papel |
|---|---|---|
| **`hey_luna_ptbr_v2.tflite`** (em uso) | `3056e56467b45e44907bcea18b702580e2761cfc9c0a8dd25ae056861821d7d1` | retreino com fala pt-BR e negativos difíceis, em validação no satélite |
| `hey_luna_ptbr.tflite` | `f54c16bf69600b9bef5b336c41c2f8bc9b9cd86a325cbf5aecf27cc35a5924d4` | modelo anterior, fallback (dispara em fala pt-BR) |
| `hey_luna_trained.tflite` | `c3922993a77b782ed8a8b0acb8ec0bfa5c5e069eead6c2cd66c0f33e6c4ee698` | fallback antigo (recall baixo em voz real) |
| `okay_nabu.tflite` | `0689abe1912a95a3318a0d8cb2e67bad0cbcfe3e24dd6e050c75debddfb6f891` | fallback validado no mic real, outra frase |

## `hey_luna*.tflite` — detector da wake word (fracos, não usar)

Modelos [microWakeWord](https://github.com/kahrendt/microWakeWord) treinados por Daniel Reimer
(`dreimer1986`), submetidos em [esphome/micro-wake-word-models#20](https://github.com/esphome/micro-wake-word-models/pull/20).
Origem: `https://github.com/dreimer1986/micro-wake-word-models`, `models/v2/`.

| Arquivo | SHA-256 | Commit de origem | Teste offline* |
|---|---|---|---|
| `hey_luna.tflite` | `18a56ba916a5c7adff1d5d4f594eaadff7af62ba20f83be38c3e456253c94191` | 2025-02-19 "Add Luna as v2" | 7/255 (surdo) |
| **`hey_luna_v2.tflite`** (em uso) | `275f482929770a7152c26ded4d7a4e71c09db4ccb021be311c461633976b837e` | 2025-07-13 "Second try for Hey Luna" | **245/255** ✓ |
| `hey_luna_v3.tflite` | `1cc0f36baa1988b7df3ffa82d72a28f99d48bbbdf9310a471911fe2b85c5ba74` | 2025-07-16 "Tried to slow the ww down a bit" | 37/255 (surdo) |

\* Pico do modelo (`raw`/255) rodando o pipeline completo (preprocessador + modelo) sobre um
"hey luna" sintetizado por TTS, num container com `tflite-micro`. **Só o v2 dispara** — os
`hey_luna` e `hey_luna_v3` mal reagem a um exemplo limpo, então não adianta ajustar limiar com
eles. As três ficam no repo para referência; trocar é regerar o header apontando para outro
arquivo.

Todos compartilham o mesmo manifesto (`probability_cutoff` 0.97, `sliding_window_size` 5,
`feature_step_size` 10 ms, `tensor_arena_size` 30000), mas os picos do v2 ficam em 238-245/255
(média da janela ~0.94), então `WAKE_PROB_CUTOFF` em `include/config.h` foi baixado para 0.90.

> Treinados em **inglês** (`trained_languages: ["en"]`). Se a taxa de rejeição com sotaque pt-BR
> incomodar, o caminho é treinar uma versão própria em <https://microwakeword.com/train> e trocar
> só o `.tflite` + as constantes — o código do firmware não muda.

## `audio_preprocessor_int8.tflite` — extrator de features

Preprocessador canônico do exemplo `micro_speech` do
[tflite-micro](https://github.com/tensorflow/tflite-micro/tree/main/tensorflow/lite/micro/examples/micro_speech)
(Apache-2.0). SHA-256 `278949d197166fb8b580c0bdc94e902fb709fec0569dcf5766816b28285440e5`.

Contrato: recebe **480 amostras `int16`** (janela de 30 ms @ 16 kHz) e devolve **40 features
`int8`**. O `WakeWord` avança a janela de 160 em 160 amostras (stride de 10 ms), como manda o
`feature_step_size` do manifesto.

### Geometria dos modelos (lida do `.tflite`, não do manifesto)

| Tensor | Forma | Tipo |
|---|---|---|
| preprocessador in | `[1, 480]` | int16 |
| preprocessador out | `[40]` | int8 |
| **hey_luna in** | `[1, 2, 40]` | int8 |
| **hey_luna out** | `[1, 1]` | **uint8** (probabilidade 0..255) |

O `[1, 2, 40]` é o pulo do gato: o modelo consome **2 slices de 40 features empilhados** e só
roda a inferência a cada 2 slices (pares não-sobrepostos, 1 inferência a cada 20 ms) — o modelo
guarda o resto do histórico internamente via *variable tensors*. Os modelos oficiais do ESPHome
(okay_nabu, hey_jarvis) usam `[1, 3, 40]`. O `WakeWord` lê esse `stride = dims[1]` do próprio
tensor no boot, então trocar por um modelo de stride 3 não exige mexer no código.

A saída é **uint8 cru** (não int8 dequantizado): `probabilidade = raw / 255`. O `WAKE_PROB_CUTOFF`
de `config.h` (0.85 para o `hey_luna_ptbr_v2`) é comparado contra a média dessa razão.

Roda inteiramente sobre kernels `tflite::tflm_signal` (`WINDOW`, `FFT_AUTO_SCALE`, `RFFT`,
`ENERGY`, `FILTER_BANK`, `FILTER_BANK_SQUARE_ROOT`, `FILTER_BANK_SPECTRAL_SUBTRACTION`, `PCAN`,
`FILTER_BANK_LOG`) que **já vêm compilados** na `libespressif__esp-tflite-micro.a` do toolchain
pioarduino — por isso o wake word não adiciona nenhuma dependência ao `platformio.ini`.

**Fora do tflite-micro este `.tflite` não carrega** (runtimes normais como
`tflite-runtime`/`ai-edge-litert`/`tensorflow` não têm esses kernels
`tflm_signal`). O equivalente para o `luna-desktop` é `pymicro-features`
(mesmo micro frontend em C++, wheel Python standalone) — ver
[`luna-desktop/wakeword-sidecar/README.md`](../../luna-desktop/wakeword-sidecar/README.md)
e [`docs/adr/004-wake-word-no-desktop.md`](../../docs/adr/004-wake-word-no-desktop.md).
