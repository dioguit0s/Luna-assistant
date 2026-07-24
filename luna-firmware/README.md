# luna-firmware — Satélite de Borda (Épicos 2 e 4)

Firmware C++/Arduino (PlatformIO) do nó satélite ESP32-S3 do Projeto Luna.
Escuta a wake word **"Hey Luna"** localmente, autentica via HMAC-SHA256, transmite chunks de
20ms ao `luna-server` por WebSocket e reproduz a resposta da Luna no speaker.

> O microfone fica sempre aberto, mas **nada sai pela rede** até a wake word disparar.

## Hardware

Placa **ESP32-S3 N16R8**. Pinagem completa em [`../docs/PINAGEM_EPICO_2.md`](../docs/PINAGEM_EPICO_2.md):

| Módulo | Sinais | GPIOs |
|---|---|---|
| INMP441 (mic, I2S0 RX) | SD / WS / SCK | 4 / 5 / 6 |
| MAX98357A (amp, I2S1 TX) | DIN / BCLK / LRC | 7 / **16** / **17** |
| LED de escuta | — | 10 |

> O `VIN` do amplificador vai no pino **`5VIN`**, não no 3.3V. E o BCLK/LRC ficam
> em 16/17 (não 8/9): no GPIO8 o amplificador só emitia ruído. Detalhes na
> seção 9 da pinagem.

## Wake word

Detecção local com [microWakeWord](https://github.com/kahrendt/microWakeWord) sobre o
TFLite-micro que já vem no toolchain pioarduino — **sem dependência nova no `platformio.ini`**.
Os modelos e a procedência estão em [`models/`](models/README.md); a decisão de não usar o
ESP-SR está no [ADR 003](../docs/adr/003-wake-word-engine.md).

Ajustes ficam em [`include/config.h`](include/config.h):

| Constante | Para que serve |
|---|---|
| `WAKE_WORD_ENABLED` | `0` volta ao open-mic (transmite sempre) |
| `WAKE_PROB_CUTOFF` | limiar de disparo — **suba se der falso-positivo** |
| `WAKE_PREROLL_MS` | quanto de áudio anterior ao wake vai junto ao servidor |
| `WAKE_REARM_FEATURES` | janela morta após um disparo |

A cada 5s o serial mostra o custo de manter a escuta ligada:

```
[wake] infer avg=1180us max=2400us load=11.8% p=0.01 | heap_int=190112 psram=780120 stack_hwm=1284
```

`load%` é a fração de um núcleo gasta inferindo. Se passar de ~25%, o primeiro passo é rodar o
modelo streaming a cada 2 features em vez de 1.

> A tabela de partição é a `default_16MB.csv` — o runtime TFLite não cabe na `app0` de 1,25 MB
> da tabela padrão de 4 MB. A partição `nvs` é a mesma, então o segredo gravado na NVS
> sobrevive à troca (não precisa de `erase`).

## Configuração

```bash
cp include/secrets.h.example include/secrets.h
# edite include/secrets.h: Wi-Fi, IP do servidor, ROOM_ID e WS_AUTH_SECRET
```

> `WS_AUTH_SECRET` **deve ser idêntico** ao do `.env` do `luna-server`.
> `device_id` do satélite = MAC do ESP32 (automático).
>
> O segredo fica na **NVS** do ESP32: o valor do `secrets.h` é gravado nela no
> primeiro boot e, dali em diante, é a NVS que manda. Para trocar o segredo,
> apague a NVS com `pio run -t erase` e grave de novo.

## Build / flash / monitor

```bash
pio run                 # compila
pio run -t upload       # grava
pio device monitor      # log serial (115200)
```

## Validação faseada

1. **Captura (INMP441):** use `AudioCapture::lastPeak()` (0..32767) para conferir o mic —
   em silêncio fica baixo e estável; falando, sobe. Picos de fundo de escala erráticos
   indicam mau contato nas linhas I2S, não problema de código. Ajuste `MIC_SAMPLE_SHIFT`
   em `include/config.h` se o volume estiver baixo/clipando.
2. **Playback (MAX98357A):** `AudioPlayback::playTone(440, 600)` toca um seno limpo — se
   sair ruído, o problema está no caminho de saída (fiação/pino/alimentação), não nos dados.
   O tom de aviso de offline também valida o speaker (deixe o servidor desligado ~30s).
3. **Rede + Auth:** com o `luna-server` no ar, o serial mostra `auth_ok` e o servidor loga `auth_ok`.
4. **Wake word:** com o servidor no ar e ninguém falando, o `luna-server` **não** deve receber
   `audio_chunk` nenhum. Dizer "Hey Luna" a ~1m e a ~3m: o serial loga `[wake] DETECTADO`, o LED
   acende, sai um bipe curto e o servidor passa a receber áudio.
5. **E2E:** "Hey Luna, ligar luz de teste" e ouvir a resposta. LED **aceso** ao capturar,
   **apaga** enquanto a Luna fala e o satélite volta a exigir a wake word depois (AEC de 150ms
   mais o dreno do buffer de playback).

## Arquitetura

- `captureTask` (core 1): I2S0 → PCM16 → detector (`wakeBuffer`), pré-buffer e fila `txQueue`.
- `wakeTask` (core 0, prio 2): `WakeWord::feed()` → dispara `StateMachine::onWakeWord()`.
- `loop` (core 1, dono único do WS): `ws.loop()`, drena `txQueue` → `sendBIN`, trata frames.
- `playbackTask` (core 0, prio 3): StreamBuffer ← `audio_response` → I2S1.
- `StateMachine`: `IDLE_LISTENING` --wake--> `ACTIVE_STREAMING` ⇄ `RESPONDING`, e de `RESPONDING`
  sempre de volta para `IDLE_LISTENING` (cada turno exige a wake word de novo). Em
  `ACTIVE_STREAMING` há uma **janela de escuta com timeout** (`WAKE_LISTEN_*` em `config.h`): se o
  servidor não enfileirar uma resposta, a FSM fecha por silêncio/teto e volta a exigir o wake word,
  em vez de ficar presa transmitindo.

A inferência roda com prioridade **abaixo** do playback de propósito: se a CPU apertar, quem
atrasa é a detecção, não o áudio que está tocando.

O protocolo WebSocket segue exatamente `luna-server/src/ws/` e `luna-client-test/src/protocol.ts`.
