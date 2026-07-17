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
| GPIO8 | MAX98357A | BCLK — bit clock | ESP32 → MAX98357A |
| GPIO9 | MAX98357A | LRC (WS) — word select | ESP32 → MAX98357A |
| GPIO10 | LED indicador | Estado de escuta (`ACTIVE_STREAMING`) | ESP32 → LED |
| GPIO2 | Botão físico (pendente) | Trigger — reservado, não conectado nesta rodada | Botão → ESP32 |

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
| VIN | 5V | preferir fonte externa 5V — ver seção 4 |
| GND | GND | |
| DIN | GPIO7 | |
| BCLK | GPIO8 | |
| LRC (WS) | GPIO9 | |
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

## 8. Próximos passos no código

- `platformio.ini`: definir board correspondente à variante confirmada do ESP32-S3.
- `src/audio/`: inicializar I2S0 (RX, pinos 4/5/6) e I2S1 (TX, pinos 7/8/9) como instâncias separadas.
- `src/fsm/`: adicionar `digitalWrite` do LED (GPIO10) nas transições `IDLE_LISTENING` ↔ `ACTIVE_STREAMING`.
- Validar captura do INMP441 isoladamente antes de habilitar o MAX98357A (não misturar as duas frentes de debug).
