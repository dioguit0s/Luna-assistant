# Pinagem do Protótipo — Épico 2 (Satélite ESP32-S3)

**Escopo:** Módulo Zero — protoboard de validação de hardware
**Placa:** ESP32-S3 DevKit (confirmar variante — ver seção 5 sobre pinos reservados)

---

## 1. Tabela consolidada de GPIOs

| GPIO | Componente | Função | Direção |
|------|-----------|--------|---------|
| **GPIO12** | INMP441 | SD (DOUT) — dado do microfone | ESP32 ← INMP441 |
| GPIO5 | INMP441 | WS (LRCLK) — word select | ESP32 → INMP441 |
| GPIO6 | INMP441 | SCK (BCLK) — bit clock | ESP32 → INMP441 |
| GPIO7 | MAX98357A | DIN — dado de áudio | ESP32 → MAX98357A |
| **GPIO16** | MAX98357A | BCLK — bit clock | ESP32 → MAX98357A |
| **GPIO17** | MAX98357A | LRC (WS) — word select | ESP32 → MAX98357A |
| GPIO10 | LED RGB | Canal **R** (vermelho) | ESP32 → LED |
| GPIO13 | LED RGB | Canal **G** (verde) | ESP32 → LED |
| GPIO14 | LED RGB | Canal **B** (azul) | ESP32 → LED |
| GPIO2 | Botão físico (pendente) | Trigger — reservado, não conectado nesta rodada | Botão → ESP32 |

> **⚠️ Revisado após validação com hardware real.** O BCLK e o LRC do amplificador
> eram GPIO8 e GPIO9 no projeto original. Com o BCLK no **GPIO8 o amplificador só
> emitia ruído**, mesmo com dado de entrada comprovadamente limpo (um seno de
> 440 Hz gerado na própria placa saía como ruído branco). Mover BCLK→**GPIO16** e
> LRC→**GPIO17** resolveu. Ver seção 9.
>
> **⚠️ 2026-08-24 — segundo pino perdido.** O SD do microfone era o **GPIO4** e
> passou a ler silêncio digital absoluto. O pad de entrada do GPIO4 estava
> danificado; SD→**GPIO12** resolveu. Ver seção 9.
>
> **Nota de correção.** Esta tabela dizia GPIO11 (e a mensagem do commit
> `75bbc49` também), mas `include/config.h` define `MIC_SD 12` — e é esse o
> firmware que captura áudio. O 11 era erro de redação; o pino real é o **12**,
> e o **GPIO11 está livre**.

Barramentos I2S separados por design: **I2S0 dedicado ao microfone (RX)**, **I2S1 dedicado ao amplificador (TX)** — nenhum pino é compartilhado entre captura e playback.

---

## 2. INMP441 (microfone I2S)

| Pino do INMP441 | Ligação | Observação |
|---|---|---|
| VDD | 3.3V | |
| GND | GND | |
| SD (DOUT) | **GPIO12** | movido do GPIO4 — ver seção 9 |
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

## 4. LED RGB indicador de estado

LED RGB discreto de 4 pernas, **cátodo comum** (o comum vai ao GND). Substituiu o
LED simples de escuta que ocupava só o GPIO10; a lógica é PWM por canal via LEDC,
com nível alto = aceso.

```
GPIO10 ──[ 300Ω ]── R
GPIO13 ──[ 300Ω ]── G     (recomendado trocar para 100Ω — ver abaixo)
GPIO14 ──[ 300Ω ]── B     (recomendado trocar para 100Ω — ver abaixo)
                     comum (perna longa) ── GND
```

**Um resistor por canal, nunca um só no comum.** Com resistor único no cátodo a
corrente se divide entre os canais acesos e a cor muda conforme quantos estão
ligados — branco sai esverdeado, amarelo sai diferente de vermelho+verde
separados.

**O verde e o azul pedem resistor menor que o vermelho.** O die vermelho tem
Vf ≈ 2,0 V contra ≈ 3,0 V dos outros dois, então o mesmo resistor produz correntes
muito diferentes:

| Canal | Vf típico | com 300Ω | com 100Ω |
|---|---|---|---|
| R | ~2,0 V | ~4,3 mA | (manter 300Ω) |
| G | ~3,0 V | ~1,0 mA | ~3,0 mA |
| B | ~3,0 V | ~1,0 mA | ~3,0 mA |

A montagem atual usa **300Ω nos três**, o que deixa o vermelho ~4× mais forte e
domina toda mistura. O ganho por canal em `config.h` (`LED_GAIN_R`) compensa o
desbalanço no duty do PWM, mas não resolve o problema de fundo: com 300Ω sobram
só ~0,3 V acima do Vf do verde e do azul, e nessa faixa a corrente vira uma função
quase vertical do Vf. A variação normal entre peças (3,0 V vs 3,2 V) muda o brilho
em 3×, e o VOH do pino sob carga come parte dessa folga — é ponto de operação que
não se calibra de forma estável por software.

**Trocar G e B para 100Ω** (68Ω se quiser mais brilho) e manter 300Ω no vermelho
põe os três em ~3–4 mA, com folga de tensão suficiente para o brilho ser
previsível. Todos bem abaixo dos 40 mA absolutos do pino. Feita a troca, ajustar
`config.h`: `LED_BRIGHTNESS_PCT 55` e `LED_GAIN_R 45`.

**Ordem das pernas conferida** canal a canal em 2026-08-24: GPIO13 = verde,
GPIO14 = azul, seguindo o encapsulamento padrão **R – comum – G – B**.

**GPIO13 é vizinho do GPIO12 (SD do microfone) no header.** A ordem física do
header esquerdo é `… 9, 10, 11, 12, 13, 14`, então um canal de PWM chaveando fica
encostado na linha de dado do I2S de captura. Não houve problema observado, mas
se o `audio_peak` ficar errático depois desta mudança, este é o primeiro suspeito:
o teste é deixar o LED apagado e ver se o sintoma some. Se confirmar, mover o
canal para o header direito (GPIO21, 47, 40–42 estão livres).

### Mapa de estados → cores

Definido em `luna-firmware/src/ui/StatusLed.cpp` (`lookFor`). Quem escolhe o
estado é `updateStatusLed()` em `main.cpp`, não a FSM: a cor depende de Wi-Fi,
WebSocket e FSM ao mesmo tempo, e nenhum dos três enxerga os outros.

**Paleta em uso hoje (`LED_NO_GREEN_PALETTE 1`).** Com 300Ω no canal verde ele
não acende — verificado no hardware, não é estimativa: `LISTENING` (verde puro)
aparecia como LED apagado e o âmbar de `THINKING` saía vermelho puro. Não sobra
tensão acima do Vf, e duty de PWM não cria tensão direta. Enquanto os resistores
não trocam, a paleta usa só vermelho, azul e magenta, e quem separa os estados é
o **padrão**:

| Estado | Cor | Padrão | Significado |
|---|---|---|---|
| `BOOTING` | magenta | respirando 0,8 s | `setup()` ainda rodando |
| `NO_WIFI` | vermelho | **piscando 0,4 s** | sem associação Wi-Fi |
| `NO_SERVER` | magenta | **piscando 0,4 s** | Wi-Fi ok, sem `auth_ok` do servidor |
| `IDLE` | azul fraco | respirando 4 s | repouso — aguardando a wake word |
| `LISTENING` | magenta | **sólido** | capturando e transmitindo sua voz |
| `THINKING` | vermelho | respirando 1,2 s | você parou de falar, esperando resposta |
| `SPEAKING` | azul | respirando 1,6 s | Luna respondendo |
| `DEGRADED` | magenta | respirando 3 s | open-mic: o detector de wake word não subiu |

As duas falhas piscam com borda dura e rápida — a coisa mais distante de
"respirar" que o LED sabe fazer. É isso que as separa de `THINKING` e `DEGRADED`,
que reusam as mesmas cores.

**Paleta cheia (`LED_NO_GREEN_PALETTE 0`),** para depois de trocar os resistores
do verde e do azul por ~100Ω:

| Estado | Cor | Padrão |
|---|---|---|
| `BOOTING` | branco | respirando 1,2 s |
| `NO_WIFI` | vermelho | piscando 1 s |
| `NO_SERVER` | âmbar | piscando 2 s |
| `IDLE` | azul fraco | respirando 4 s |
| `LISTENING` | **verde** | **sólido** |
| `THINKING` | âmbar | respirando 1,2 s |
| `SPEAKING` | ciano | respirando 1,6 s |
| `DEGRADED` | magenta | respirando 2,5 s |

Definidas em `luna-firmware/src/ui/StatusLed.cpp` (`lookFor`). Quem escolhe o
estado é `updateStatusLed()` em `main.cpp`, não a FSM: a cor depende de Wi-Fi,
WebSocket e FSM ao mesmo tempo, e nenhum dos três enxerga os outros.

Falha de conectividade tem prioridade sobre o estado da conversa. Não é
arbitrário: em `IDLE_LISTENING` sem servidor a wake word ainda dispara e o áudio
não vai a lugar nenhum, então mostrar "repouso" ali esconderia justamente a
informação que o usuário precisa.

`LISTENING` é o único estado sólido, de propósito — é o único em que a voz está
saindo pela rede, e é o que precisa de leitura inequívoca a três metros.

**`THINKING` é inferido, não informado.** O protocolo não tem esse evento: o
satélite não sabe quando o modelo começou a pensar. O que ele sabe é que parou de
chegar fala (`StateMachine::msSinceVoice()` acima de `LED_THINKING_AFTER_MS`, 700 ms),
e nesse ponto a captura continua sendo transmitida normalmente — a mudança é só
visual. Um estado de verdade exigiria uma mensagem nova nos quatro pontos do
contrato WS (ver `docs/protocolo-websocket.md`).

**Calibração do vermelho.** Ajuste `LED_GAIN_R` olhando o **magenta de
`LISTENING`** (diga "Hey Luna" — é o estado mais fácil de provocar e fica sólido
por segundos, ao contrário do branco do boot, que passa num relance). Suba se
puxar para azul, desça se puxar para vermelho; o alvo é um roxo/rosa claramente
diferente do azul do repouso. Com a paleta cheia o alvo passa a ser o branco
neutro do `BOOTING`.

**Brilho do repouso.** `LED_IDLE_BRIGHTNESS_PCT` é knob separado porque `IDLE` é o
único estado que fica aceso indefinidamente — inclusive de madrugada, num quarto.

Por que RGB discreto e não WS2812: o addressable gastaria um pino só, mas exige
3,3 V de dado contra Vih de 3,5 V a 5 V (ou level shifter), e puxa ~60 mA por
pixel da mesma rail 3V3 do WiFi. Para um indicador de estado com meia dúzia de
cores fixas, três pinos de PWM saem mais previsíveis.

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
| GPIO26–32 | Flash SPI interna | Sim, sempre |
| **GPIO4** | **Pad de entrada danificado** nesta unidade (fuga de ~22 µA) | Sim — ver seção 9 |
| GPIO8, GPIO9 | Já corromperam o clock do I2S nesta placa (seção 9) | Preferir outros |

**Pinos livres nesta montagem:** 1, 11, 15, 18, 21, 39, 40, 41, 42, 47 e o par
38/48 (um dos dois é o WS2812 embutido da DevKitC-1, conforme a revisão). Os do
header direito (21, 40–42, 47) são a melhor escolha para periféricos que chaveiam,
por ficarem longe das linhas I2S.

---

## 7. Pendências

- **Botão físico:** não conectado nesta rodada por falta de espaço na protoboard. GPIO2 reservado. Necessário antes de fechar o critério de aceite do Épico 2 (falar após pressionar o botão e ouvir a resposta no speaker).

---

## 8. Estado da implementação

Firmware em `luna-firmware/` (PlatformIO + Arduino, core 3.x via pioarduino).
Placa confirmada: **ESP32-S3 N16R8** (`board_build.arduino.memory_type = qio_opi`).

- `src/audio/`: I2S0 (RX, pinos 12/5/6) e I2S1 (TX, pinos 7/16/17) como instâncias separadas. ✅
- `src/ui/StatusLed.*`: LED RGB (GPIO10/13/14) em PWM via LEDC, oito estados
  visuais com padrões de animação. Arbitragem em `main.cpp:updateStatusLed()`. ✅
- `src/fsm/`: a FSM não aciona mais o LED — só expõe `current()`,
  `wakeWordAvailable()` e `msSinceVoice()`. ✅
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
| Mic em `audio_peak=0` **absoluto**, com VDD, GND, L/R e os dois clocks já conferidos no multímetro | Pad de entrada do **GPIO4** danificado (fuga de ~22 µA para o terra) | SD → **GPIO11** |
| Placa desconectava do WS ao receber a resposta | Frame binário de **30720 bytes** derrubava o `arduinoWebSockets` | Servidor fragmenta `audio_response` em 1024 bytes |
| Áudio da resposta picotado | Gemini envia >100 KB em ~1s; buffer de 24 KB estourava | Buffer de 512 KB na **PSRAM** |
| Logs do firmware não apareciam no monitor | `Serial` ia para a UART0, monitor na USB nativa | `ARDUINO_USB_MODE=1` + `ARDUINO_USB_CDC_ON_BOOT=1`, `monitor_dtr/rts = 0` |

**Pino do ESP32 também queima — e o sintoma imita mau contato.** No caso do
GPIO4 (2026-08-24), continuidade, alimentação, terra, L/R e clocks passaram em
todos os testes, e trocar jumpers, fileira da protoboard e conectores não mudou
nada, porque o defeito estava dentro do micro. Dois testes resolvem sem chutar
peça:

- **Pull-up interno no pino de dados.** Com `gpio_set_pull_mode(pino,
  GPIO_PULLUP_ONLY)` logo após o `i2s_channel_init_std_mode`, um pino solto passa
  a ler `0xFFFFFFFF` e o `audio_peak` vai de 0 para **1** (porque `-1 >> shift`
  continua -1). Se ficar em 0, há driver ativo na linha e o problema é outro.
- **Tensão DC no pino com a linha aberta.** Com só o pull-up (~45 kΩ)
  sustentando o nó, um pino são marca ~3,3 V. O GPIO4 marcava **2,3 V**, ou seja
  ~22 µA de fuga para o terra — mil vezes acima dos nanoamperes de uma entrada
  saudável. É a assinatura de diodo de proteção ESD danificado.

Corolário para o multímetro: **continuidade que apita não prova conexão**. A
pressão da ponta de prova fecha juntas rachadas. Quando dois pontos "ligados"
medem tensões diferentes, a conexão está aberta em operação — acredite na
tensão, não no bipe. Os clocks também se conferem com o multímetro em DC: SCK e
WS são quadradas de 50% de duty, então devem marcar ~1,6 V (metade de 3,3 V) no
pad do módulo; 0 V significa clock que não chega.

**Instrumentação vale mais que palpite.** Os medidores que resolveram cada impasse: nível de pico do mic (`AudioCapture::lastPeak`), heap livre na desconexão do WS, e log do tamanho do chunk vindo do Gemini. Quando um sintoma reaparecer, meça antes de mexer.
