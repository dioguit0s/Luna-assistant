# Modelos de wake word

Os `.tflite` aqui são **vendorizados de propósito**: o build não baixa nada. O modelo
"Hey Luna" vem de um PR ainda **não mergeado** no repositório oficial, então depender da
rede em build time deixaria o firmware refém de um fork de terceiro.

Os arrays C que o firmware compila ficam em [`../src/wake/models/`](../src/wake/models/) e são
gerados por [`../tools/tflite_to_header.py`](../tools/tflite_to_header.py). Regerar depois de
trocar qualquer `.tflite`:

```bash
python tools/tflite_to_header.py models/hey_luna_v3.tflite src/wake/models/hey_luna_model_data.h g_hey_luna_model_data
```

## Estado atual: `hey_luna_trained` em validação

O header compilado (`../src/wake/models/hey_luna_model_data.h`) contém hoje o
**`hey_luna_trained.tflite`** — treinado localmente (`../../wake-training/`, ver o README lá) com
o pipeline do microWakeWord, mesma arquitetura do `okay_nabu` (mixednet, stride 3).

⚠️ **Risco conhecido**: o treino convergiu rápido (99,9%+ de acurácia desde o passo 500), mas o
AUC no split de teste ficou baixo (**0,536** — perto de aleatório). Isso é sinal de overfitting:
as 2000 amostras positivas vieram todas da mesma voz sintética (Piper `en_US-libritts_r-medium`),
então o modelo pode ter decorado essa voz específica em vez de generalizar "hey luna". As métricas
por corte de decisão (`tflite_streaming_roc.txt`, ver `hey_luna_trained.json`) pareciam boas
isoladamente (cutoff 0,98 → 5% de rejeição, ~1 falso-aceite/hora), mas isso não substitui o teste
com voz humana real no microfone. **Se não disparar bem, o fallback validado é o `okay_nabu`.**

Histórico: os três `hey_luna*` da comunidade (`hey_luna.tflite`, `_v2`, `_v3`) são fracos e não
disparam neste hardware (INMP441) — só o `okay_nabu` (modelo oficial) provou que o hardware está
bom. Detalhes em [ADR 003](../../docs/adr/003-wake-word-engine.md) e [TRAINING.md](TRAINING.md).

### Reverter para `okay_nabu` se o treinado não funcionar bem

```bash
python tools/tflite_to_header.py models/okay_nabu.tflite src/wake/models/hey_luna_model_data.h g_hey_luna_model_data
```

E em `include/config.h`: `WAKE_PHRASE "Okay Nabu"`, `WAKE_PROB_CUTOFF 0.90f`.

| Arquivo | SHA-256 | Papel |
|---|---|---|
| **`okay_nabu.tflite`** (em uso) | `0689abe1912a95a3318a0d8cb2e67bad0cbcfe3e24dd6e050c75debddfb6f891` | provisório, validado no mic real |

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
de `config.h` (0.97) é comparado contra a média dessa razão.

Roda inteiramente sobre kernels `tflite::tflm_signal` (`WINDOW`, `FFT_AUTO_SCALE`, `RFFT`,
`ENERGY`, `FILTER_BANK`, `FILTER_BANK_SQUARE_ROOT`, `FILTER_BANK_SPECTRAL_SUBTRACTION`, `PCAN`,
`FILTER_BANK_LOG`) que **já vêm compilados** na `libespressif__esp-tflite-micro.a` do toolchain
pioarduino — por isso o wake word não adiciona nenhuma dependência ao `platformio.ini`.
