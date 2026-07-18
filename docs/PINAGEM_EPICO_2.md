# Pinagem do Protótipo — Épico 2 (Satélite ESP32-S3)

**Escopo:** Módulo Zero — protoboard de validação de hardware
**Placa:** ESP32-S3 DevKit (confirmar variante — ver seção 5 sobre pinos reservados)

---

## 1. Tabela consolidada de GPIOs

| GPIO | Componente | Função | Direção |
|------|-----------|--------|---------|
| GPIO4 | INMP441 | SD (DOUT) — dado do microfone | ESP32 ← INMP441 |
| GPIO5 | INMP441 | WS (LRCLK) — word select | ESP32 → INMP441 |
| GPIO6 | INMP441 | SCK (BCLK) — bit clock | ESP32 → INMP441 |
| GPIO7 | MAX98357A | DIN — dado de áudio | ESP32 → MAX98357A |
| **GPIO16** | MAX98357A | BCLK — bit clock | ESP32 → MAX98357A |
| **GPIO17** | MAX98357A | LRC (WS) — word select | ESP32 → MAX98357A |
| GPIO10 | LED indicador | Estado de escuta (`ACTIVE_STREAMING`) | ESP32 → LED |
| GPIO2 | Botão físico (pendente) | Trigger — reservado, não conectado nesta rodada | Botão → ESP32 |

> **⚠️ Revisado após validação com hardware real.** O BCLK e o LRC do amplificador
> eram GPIO8 e GPIO9 no projeto original. Com o BCLK no **GPIO8 o amplificador só
> emitia ruído**, mesmo com dado de entrada comprovadamente limpo (um seno de
> 440 Hz gerado na própria placa saía como ruído branco). Mover BCLK→**GPIO16** e
> LRC→**GPIO17** resolveu. Ver seção 9.

Barramentos I2S separados por design: **I2S0 dedicado ao microfone (RX)**, **I2S1 dedicado ao amplificador (TX)** — nenhum pino é compartilhado entre captura e playback.

---

## 2. INMP441 (microfone I2S)

| Pino do INMP441 | Ligação | Observação |
|---|---|---|
| VDD | 3.3V | |
| GND | GND | |
| SD (DOUT) | GPIO4 | |
| WS (LRCLK) | GPIO5 | |
| SCK (BCLK) | GPIO6 | |
| L/R | GND | fixa canal esquerdo (captura mono) |

---

## 3. MAX98357A (amplificador I2S)

| Pino do MAX98357A | Ligação | Observação |
|---|---|---|
| VIN | 5V | usar o pino `5VIN` da placa, **não** o 3.3V — ver seção 5 |
| GND | GND | |
| DIN | GPIO7 | |
| BCLK | **GPIO16** | movido do GPIO8 — ver seção 9 |
| LRC (WS) | **GPIO17** | movido do GPIO9 |
| SD | flutuante | habilita o amplificador (pull-up interno) |
| GAIN | flutuante | 9dB (padrão). Ligar a GND = 12dB se precisar de mais volume |
| SPK+ / SPK- | alto-falante | |

---

## 4. LED indicador (estado de escuta)

```
GPIO10 → resistor 220–330Ω → anodo (perna longa) do LED
Catodo (perna curta) do LED → GND
```

**Lógica no firmware:** `digitalWrite(10, HIGH)` na entrada do estado `ACTIVE_STREAMING`, `digitalWrite(10, LOW)` ao retornar para `IDLE_LISTENING`. Reaproveita as transições de estado já mapeadas na FSM — nenhuma lógica nova além do toggle do pino.

---

## 5. Alimentação e terra comum

- ESP32-S3, INMP441 e MAX98357A devem compartilhar o **mesmo GND**, inclusive se o MAX98357A for alimentado por fonte externa 5V.
- **VIN do MAX98357A no pino `5VIN`, nunca no 3.3V.** O 3.3V é a saída do regulador que alimenta o núcleo digital e o WiFi do ESP32 — é uma rail ruidosa, e um amplificador classe D amplifica esse ruído direto no speaker.
- Se o ESP32 reiniciar sozinho ao tocar áudio em volume alto, é sinal de corrente insuficiente na porta USB — trocar para fonte 5V externa com GND comum.
- Capacitor de desacoplamento de 100nF entre VDD/VIN e GND em cada módulo, se a breakout não já tiver um embutido.

---

## 6. Pinos evitados (reserva para expansão futura)

Relevante ao adicionar o display ILI9341 (SPI) ou outros periféricos nos próximos épicos:

| Faixa/Pino | Motivo | Evitar |
|---|---|---|
| GPIO0, 3, 45, 46 | Strapping pins (modo de boot) | Sim |
| GPIO43, 44 | UART0 (monitor serial / programação) | Sim, a menos que não precise de debug serial |
| GPIO33–37 | Reservado em variantes com Octal PSRAM (ex: N16R8) | Confirmar variante da placa antes de usar |
| GPIO19, 20 | D-/D+ USB nativo (se a placa usa USB-JTAG) | Evitar se for usar USB simultaneamente |

---

## 7. Pendências

- **Botão físico:** não conectado nesta rodada por falta de espaço na protoboard. GPIO2 reservado. Necessário antes de fechar o critério de aceite do Épico 2 (falar após pressionar o botão e ouvir a resposta no speaker).

---

## 8. Estado da implementação

Firmware em `luna-firmware/` (PlatformIO + Arduino, core 3.x via pioarduino).
Placa confirmada: **ESP32-S3 N16R8** (`board_build.arduino.memory_type = qio_opi`).

- `src/audio/`: I2S0 (RX, pinos 4/5/6) e I2S1 (TX, pinos 7/16/17) como instâncias separadas. ✅
- `src/fsm/`: LED (GPIO10) nas transições `IDLE_LISTENING` ↔ `ACTIVE_STREAMING`. ✅
- Trigger atual é **open-mic** (sem botão); a FSM já está estruturada para o botão e o wake word. ✅
- Segredo de auth armazenado na **NVS** (`src/ws/SecretStore.cpp`); `secrets.h` só provisiona o primeiro boot. ✅

**Critério de aceite atingido** (forma adaptada, sem botão): falar e ouvir a resposta da Luna no speaker de forma inteligível.

---

## 9. Lições da validação com hardware real

Registro do que custou tempo, para não repetir na réplica do segundo satélite (Épico 4).

**Valide cada etapa isoladamente antes de integrar.** Fomos direto ao teste ponta-a-ponta e passamos horas atribuindo a software problemas que eram físicos. O teste que destravou tudo: **tocar um seno de 440 Hz gerado na própria placa**. Dado comprovadamente limpo saindo como ruído isola o problema no caminho de saída, não nos dados.

| Sintoma | Causa real | Correção |
|---|---|---|
| Ruído contínuo no speaker, inclusive com silêncio digital | BCLK no **GPIO8** corrompia o clock do I2S | BCLK → **GPIO16**, LRC → **GPIO17** |
| Ruído de fundo constante | VIN do amp no **3.3V** (rail do núcleo/WiFi) | VIN → pino **5VIN** |
| Mic lendo `pico=0` ou picos de fundo de escala erráticos | Mau contato nas linhas I2S do mic na protoboard | Re-encaixar com jumpers curtos e firmes |
| Placa desconectava do WS ao receber a resposta | Frame binário de **30720 bytes** derrubava o `arduinoWebSockets` | Servidor fragmenta `audio_response` em 1024 bytes |
| Áudio da resposta picotado | Gemini envia >100 KB em ~1s; buffer de 24 KB estourava | Buffer de 512 KB na **PSRAM** |
| Logs do firmware não apareciam no monitor | `Serial` ia para a UART0, monitor na USB nativa | `ARDUINO_USB_MODE=1` + `ARDUINO_USB_CDC_ON_BOOT=1`, `monitor_dtr/rts = 0` |

**Instrumentação vale mais que palpite.** Os medidores que resolveram cada impasse: nível de pico do mic (`AudioCapture::lastPeak`), heap livre na desconexão do WS, e log do tamanho do chunk vindo do Gemini. Quando um sintoma reaparecer, meça antes de mexer.
