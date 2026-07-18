# luna-firmware — Satélite de Borda (Épico 2)

Firmware C++/Arduino (PlatformIO) do nó satélite ESP32-S3 do Projeto Luna.
Captura áudio contínuo (open-mic), autentica via HMAC-SHA256, transmite chunks de
20ms ao `luna-server` por WebSocket e reproduz a resposta da Luna no speaker.

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
4. **E2E:** falar perto do satélite e ouvir a resposta da Luna. LED **aceso** ao capturar,
   **apaga** enquanto a Luna fala e volta ~150ms após o fim (AEC).

## Arquitetura

- `captureTask` (core 1): I2S0 → PCM16 → fila `txQueue`.
- `loop` (core 1, dono único do WS): `ws.loop()`, drena `txQueue` → `sendBIN`, trata frames.
- `playbackTask` (core 0): StreamBuffer ← `audio_response` → I2S1.
- `StateMachine`: `IDLE_LISTENING` → `ACTIVE_STREAMING` ⇄ `RESPONDING` (AEC + LED).

O protocolo WebSocket segue exatamente `luna-server/src/ws/` e `luna-client-test/src/protocol.ts`.
