# Wake word sidecar — marco 3 do `luna-desktop`

Detector de "Hey Luna" isolado do Electron: um `.wav` entra, uma detecção sai
em stdout. Marco 4 (próximo) vai fazer o Electron `child_process.spawn` este
mesmo script em `--stdin`; a CLI já suporta os dois modos.

Ver [`docs/luna-desktop.md`](../../docs/luna-desktop.md) para o plano geral e
[`docs/adr/004-wake-word-no-desktop.md`](../../docs/adr/004-wake-word-no-desktop.md)
para a decisão de arquitetura por trás deste diretório.

## Por que isto não é um binding TFLite direto

O preprocessador de áudio do firmware (`luna-firmware/models/audio_preprocessor_int8.tflite`)
roda em kernels `tflite::tflm_signal` (`SignalWindow`, `SignalRfft`,
`SignalPcan`, ...) que só existem no runtime **tflite-micro**. Não há wheel de
`tflite-micro`, `tflite-runtime` nem `tensorflow` para Windows + Python 3.14
(verificado em 2026-08-17) — carregar aquele `.tflite` aqui falha com:

```
RuntimeError: Encountered unresolved custom op: SignalWindow
```

O substituto é [`pymicro-features`](https://pypi.org/project/pymicro-features/),
o mesmo micro frontend em C++ do tflite-micro, embalado como wheel `abi3`
standalone — e, por coincidência útil, é exatamente a implementação que o
[microWakeWord](https://github.com/kahrendt/microWakeWord) usou para gerar as
features de **treino** dos modelos vendorizados em `luna-firmware/models/`.

O modelo streaming (`hey_luna_trained.tflite`, `okay_nabu.tflite`) continua
sendo um `.tflite` de verdade, carregado com
[`ai-edge-litert`](https://pypi.org/project/ai-edge-litert/) — sucessor
mantido do `tflite-runtime`, com wheel para Windows + Python 3.14.

## Setup

```bash
cd luna-desktop/wakeword-sidecar
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Uso

```bash
# M3 — offline, contra um .wav (aceita qualquer taxa/canais/bits; converte para 16kHz mono PCM16)
.venv\Scripts\python.exe wake_sidecar.py --wav fixtures\okay-nabu.wav --model ..\..\luna-firmware\models\okay_nabu.tflite --trace

# vários clipes numa chamada só (cada um rearma antes de processar)
.venv\Scripts\python.exe wake_sidecar.py --wav a.wav --wav b.wav

# M4 — o modo que o Electron vai spawnar: PCM16LE 16kHz mono cru no stdin
.venv\Scripts\python.exe wake_sidecar.py --stdin < mic.pcm
```

`--model` default: `luna-firmware/models/hey_luna_trained.tflite` (resolvido
relativo a este script). `--threshold`/`--cutoff` default: `0.97` (o cutoff do
firmware, calibrado no INMP441 — ver seção Calibração abaixo sobre se ele
transfere para o desktop). `--feature-stats` imprime min/max/média das
features cruas do frontend, em stderr.

**Contrato de saída:** stdout só tem JSON, uma linha por evento — é o que o
M4 vai parsear. Todo log humano (incluindo `--trace`) vai para stderr.

| evento | quando | campos |
|---|---|---|
| `ready` | ao carregar o modelo | `model`, `model_sha256`, `stride`, `threshold`, `input_scale`, `input_zero_point` |
| `wake` | a cada disparo | `audio_ms`, `prob`, `mean_prob`, `inference` (+ `label` no modo `--wav`) |
| `eof` | fim de cada clipe (`--wav`) ou do stdin | `inferences`, `max_mean_prob`, `detections` (+ `label`) |
| `error` | falha fatal (modelo ausente, geometria errada, `.wav` inválido) | `message` (+ `label` se for de um clipe específico) |

Códigos de saída: `0` ok, `2` uso/modelo/wav inválido.

## Paridade com `WakeWord.cpp`

Cada linha da tabela é uma decisão do firmware que o sidecar reproduz de
propósito — mudar qualquer uma desloca o cutoff calibrado no satélite.

| Comportamento | Firmware (`luna-firmware/src/wake/WakeWord.cpp`) | Sidecar |
|---|---|---|
| Janela/hop do frontend | 480 amostras / 160 amostras (30ms/10ms) | Delegado ao `pymicro_features.MicroFrontend` — mesmo frontend, mesma janela |
| Empilhamento das fatias | grupos não sobrepostos de `stride` fatias (`WakeWord.cpp:320-324`) | `detector.py: WakeDetector.push_feature` |
| Saída → probabilidade | `raw / 255.0`, sem dequantizar (`:337-338`) | idêntico |
| Média móvel | últimas 5 inferências, empilhada **antes** do refratário (`:349-358`) | idêntico |
| Gatilho | `sum(ring) > cutoff * 5` — `>` estrito, sobre a soma (`:363`) | idêntico |
| Refratário pós-disparo | 50 inferências (`WAKE_REARM_WINDOWS`), sem resetar o modelo nem o anel (`:365`) | idêntico |
| `rearm()` | `Reset()` do modelo + limpa anel + settle de 15 inferências (`:406-424`) | `WakeDetector.rearm()`; `reset_all_variables()` no lugar de `Reset()` |
| Boot | termina em `rearm()` — detector nasce "resfriando" (`:279-286`) | `WakeDetector.__init__` também termina em settle |

Com stride 3 (`hey_luna_trained`/`okay_nabu`), 50 janelas de refratário são
~1,5s e 15 de settle são ~450ms — os comentários do `config.h` assumem stride
2/1s e estão desatualizados; não é uma divergência do sidecar.

## A escala das features — resolvida empiricamente

`pymicro_features.MicroFrontend().process_samples(...).features` não
documenta a escala numérica da saída. Duas hipóteses eram plausíveis por
leitura de código (ver comentário longo em `frontend.py`): faixa crua ~0..26
(sem escalar) ou ~0..666 (precisando de um fator `1/25.6`).

**Medido em 2026-08-17**, alimentando o frontend com ruído branco moderado:
`max=25.78`, `p99=22.57` — bate com a faixa 0..26. Quantizado com o
scale/zero_point do `hey_luna_trained.tflite` (`0.10196078568696976`, `-128`),
26.0 vira int8 127 quase exato: a faixa do frontend cobre o int8 quase inteiro
sem escala nenhuma. `FEATURE_SCALE = 1.0` em `frontend.py`.

**Confirmado com fala real em 2026-08-17**, via `LUNA_DUMP_MIC`:

- `okay_nabu.tflite` (controle): 8 repetições de "okay nabu" → 8 detecções
  limpas, `mean_prob` entre 0.970 e 0.993, curva subindo suavemente até
  1.000 e caindo de volta, zero falso-positivo nas pausas entre frases.
  **Recall ~100%** — prova a pipeline inteira: `pymicro-features` está
  gerando features compatíveis com o que os modelos esperam, e
  `FEATURE_SCALE = 1.0` está correto.
- `hey_luna_trained.tflite` (o modelo do satélite): **3 detecções em 10**
  repetições de "hey luna" — recall ~30%, ou seja, ~70% de rejeição
  falsa (FRR) no áudio pós-AGC/NS do Chromium. Quando dispara, dispara com
  confiança (`mean_prob` 0.970-0.993, mesmo formato de curva do
  `okay_nabu`, zero falso-positivo) — o problema não é ambiguidade, é que a
  maioria das tentativas simplesmente não chega perto do cutoff. Bate com
  o risco já documentado em `hey_luna_trained.json` (`test_auc: 0.536`,
  treinado numa única voz de TTS), mas pior na prática do que os números de
  treino sozinhos sugeriam — o pipeline do sidecar está correto (o
  `okay_nabu` prova isso), o modelo em si que generaliza mal pra voz
  humana real, e possivelmente ainda menos depois do AGC/NS do desktop.

**Implicação para o marco 4:** com esse recall, `hey_luna_trained` como
está hoje provavelmente frustra o usuário no dia a dia (precisa repetir a
frase 2-3x). Considerar como próximo passo: `okay_nabu` como wake word
provisória no desktop (mesma decisão que o ADR 003 já tomou pro firmware
por motivo idêntico), ou retreinar um "hey luna" com mais dados/vozes antes
de fechar o M4.

Falso-positivo (`fixtures/noise-smoke.wav`, 50s de ruído de fundo): **0
detecções nos dois modelos** — `okay_nabu` chegou a `max_mean_prob=0.29`,
`hey_luna_trained` a `0.017`, ambos bem abaixo do cutoff 0.97. Positivo, mas
50s é bem menos que os ≥15min recomendados (mesmo padrão do ADR 003 pro
firmware) — sinal de fumaça, não prova robusta. Sessão mais longa fica como
follow-up recomendado, sem bloquear o M3.

## Calibração do cutoff no desktop

`0.97` foi calibrado no microfone INMP441 do satélite, sem AGC/NS/AEC. O
`luna-desktop` captura via `getUserMedia` com
`echoCancellation/noiseSuppression/autoGainControl` **ligados** — é um domínio
de áudio diferente, e o cutoff pode não transferir.

Regra: grave ≥5 utterances do alvo e ≥15 minutos de TV/conversa de fundo
(mesmo teste que validou o firmware, ADR 003). Rode com `--trace` e anote o
`max_mean_prob` de cada clipe. Se o menor positivo for claramente maior que o
maior negativo (folga ≥0,05), o cutoff é o ponto médio; senão o problema é o
modelo, não o limiar — ver `hey_luna_trained.json` (`test_auc: 0.536`, overfit
numa única voz de TTS).

**Medido em 2026-08-17** (fixtures deste diretório, 50s de ruído):

| modelo | `mean_prob` dos positivos detectados | `max_mean_prob` do ruído | folga |
|---|---|---|---|
| `okay_nabu` | 0.970-0.993 (8/8 detecções) | 0.29 | ~0,68 — enorme, `0.97` sobra de margem |
| `hey_luna_trained` | 0.970-0.993 (3/10 detecções) | 0.017 | ~0,95 — também enorme, mas irrelevante pro problema real |

O cutoff `0.97` está bem calibrado nos dois casos — não é o limiar que está
errado. O problema do `hey_luna_trained` é recall (7 em 10 tentativas nem
chegam perto de disparar), não um cutoff mal ajustado; baixar o cutoff não
resolveria de forma confiável sem também elevar o risco de falso-positivo, e
os dados de `--trace` das tentativas perdidas (picos de prob individual
~0.9 sem sustentar a média) sugerem que o gargalo é a confiança do modelo
nessas janelas, não a soma final. Ver "Implicação para o marco 4" acima.

## Testes

```bash
.venv\Scripts\python.exe -m unittest detector_test.py -v
```

ou, do `luna-desktop/`:

```bash
npm run test:wakeword
```

`detector_test.py` é puro `unittest` + numpy — sem tflite, sem
pymicro-features, sem I/O. Cobre exatamente as sutilezas do firmware que um
teste manual não pega: agrupamento por stride, anel enchendo durante o
refratário, comparação `>` estrita, settle inicial engolindo prob 1.0,
`rearm()` chamando reset. Ver `test_*` em `detector_test.py`.

Não existe convenção de teste Python no resto do repo (o CI só cobre
`luna-server/**` — CLAUDE.md) — `unittest discover` (via `-p "*_test.py"`, já
configurado no `test:wakeword`) faz o papel do glob que falta no
`luna-server`/`luna-desktop`.

## Fixtures

Ver [`fixtures/README.md`](fixtures/README.md).
