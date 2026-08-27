#pragma once

// ============================================================================
// Luna — Configuração de hardware e áudio do satélite (Épico 2)
// Pinagem: ver docs/PINAGEM_EPICO_2.md
// ============================================================================

// --- INMP441 (microfone I2S) — barramento I2S0 (RX) ---
#define MIC_SD 12 // SD  (DOUT) — dado do microfone  (ESP32 <- INMP441) [movido de GPIO4]
#define MIC_WS 5  // WS  (LRCLK) — word select        (ESP32 -> INMP441)
#define MIC_SCK 6 // SCK (BCLK) — bit clock           (ESP32 -> INMP441)
// L/R do INMP441 ligado a GND => captura no canal ESQUERDO (mono)

// --- MAX98357A (amplificador I2S) — barramento I2S1 (TX) ---
#define SPK_DIN 7   // DIN — dado de áudio  (ESP32 -> MAX98357A)
#define SPK_BCLK 16 // BCLK — bit clock     (ESP32 -> MAX98357A) [movido de GPIO8: ruído]
#define SPK_LRC 17  // LRC (WS) — word select (ESP32 -> MAX98357A) [movido de GPIO9]

// --- LED RGB indicador de estado (cátodo comum) ---
// Ver docs/PINAGEM_EPICO_2.md seção 4. Montagem atual: 300Ω nos TRÊS canais.
#define LED_R_PIN 10
#define LED_G_PIN 13
#define LED_B_PIN 14

// PWM (LEDC). Frequência baixa de propósito: o GPIO13 é vizinho do GPIO12 (SD do
// microfone) no header, e quanto menos bordas por segundo menor o acoplamento na
// linha de dado do I2S. 2 kHz já fica bem acima do limiar de cintilação visível.
#define LED_PWM_FREQ_HZ 2000
#define LED_PWM_BITS 10
#define LED_MAX_DUTY ((1 << LED_PWM_BITS) - 1)

// Brilho global (0..100). Em 100 porque com 300Ω no verde e no azul esses dois
// canais já saem no limite do que conseguem: qualquer teto abaixo disso os apaga
// antes de domar o vermelho, que é o que de fato precisa ser contido. Quem
// contém o vermelho é o LED_GAIN_R abaixo. Baixar este valor faz sentido depois
// de trocar os resistores do G/B (ver comentário do ganho).
#define LED_BRIGHTNESS_PCT 100

// Ganho por canal (0..100), compensa Vf e resistor diferentes.
//
// Montagem atual — 300Ω nos três canais, rail de 3,3V:
//   R: Vf ~2,0V -> ~4,3 mA     G e B: Vf ~3,0V -> ~1,0 mA
// O vermelho puxa ~4x a corrente dos outros, então em duty igual ele domina e
// toda mistura sai rosa. Daí o ganho baixo só nele.
//
// RECOMENDADO trocar os resistores do verde e do azul para 100Ω (ou 68Ω). Não é
// só brilho: com 300Ω sobram ~0,3V acima do Vf, e nessa faixa a corrente é uma
// função quase vertical do Vf — a variação normal entre peças muda o brilho em
// 3x, e o VOH do pino sob carga come parte dessa folga. É calibração que não
// para em pé. Com 100Ω no G/B, use LED_BRIGHTNESS_PCT 55 e LED_GAIN_R 45.
//
// Em qualquer um dos casos, o ajuste fino é OLHANDO o LED: suba/desça
// LED_GAIN_R até o branco do BOOTING (todos os canais no máximo) sair neutro.
#define LED_GAIN_R 30
#define LED_GAIN_G 100
#define LED_GAIN_B 100

// Paleta sem verde. Com 300Ω no canal verde não sobra tensão acima do Vf e ele
// simplesmente não acende — verificado no hardware: LISTENING (verde puro)
// aparecia como LED APAGADO, e o âmbar de THINKING saía vermelho puro. Isso não
// tem correção por software: duty de PWM não cria tensão direta.
//
// Com 1 ligado, a paleta usa só vermelho, azul e a mistura dos dois, e passa a
// distinguir os estados principalmente pelo PADRÃO (sólido / respirando /
// piscando) em vez da cor. Voltar para 0 depois de trocar os resistores do verde
// e do azul para 100Ω — a paleta de oito cores é melhor quando o verde existe.
#define LED_NO_GREEN_PALETTE 1

// Brilho do repouso (0..100), aplicado sobre o azul de IDLE. Único estado que
// fica aceso indefinidamente, inclusive de madrugada num quarto — por isso tem
// knob próprio em vez de sair embutido na cor. Se depois de trocar os
// resistores do G/B o repouso ficar incomodando, é aqui que se mexe.
#define LED_IDLE_BRIGHTNESS_PCT 70

// "Pensando" é inferido localmente: em ACTIVE_STREAMING, este tanto de tempo sem
// fala significa que a pergunta acabou e estamos esperando o servidor. Não existe
// estado equivalente na FSM nem no protocolo — é só dica visual, o áudio continua
// sendo transmitido normalmente. Deve ficar bem abaixo de WAKE_LISTEN_SILENCE_MS,
// que é quem de fato fecha a janela de escuta.
//
// 700ms era curto demais na prática: a pausa natural entre "Hey Luna" e o
// comando já bastava para o LED sair do verde, ou seja, ele anunciava "pensando"
// enquanto ainda esperava VOCÊ falar. 1200ms tolera essa pausa e a do meio de
// frase, que é o mesmo fenômeno que levou WAKE_LISTEN_SILENCE_MS a 5000.
#define LED_THINKING_AFTER_MS 1200

// GPIO2 reservado para o botão físico (não usado nesta rodada — open-mic)

// --- Parâmetros de áudio (devem casar com o protocolo do servidor) ---
#define SAMPLE_RATE 16000  // 16 kHz
#define CHUNK_SAMPLES 320  // 20 ms @ 16 kHz
#define CHUNK_BYTES (CHUNK_SAMPLES * 2) // 640 bytes de PCM16 mono

// Conversão INMP441 (32-bit no barramento) -> PCM16.
// Deslocamento à direita aplicado a cada amostra bruta. Ajuste na Fase A:
// valor MAIOR => mais baixo/limpo; MENOR => mais alto (risco de clipping).
#define MIC_SAMPLE_SHIFT 14

// --- Buffers / filas ---
// Profundidade dimensionada para absorver o despejo do pré-buffer no wake
// (WAKE_PREROLL_CHUNKS de uma vez) sem descartar os chunks que chegam em seguida.
#define TX_QUEUE_DEPTH 24          // chunks de captura aguardando envio
// Reprodução: o Gemini despeja a resposta em rajada (>100 KB em ~1s), muito mais
// rápido que o tempo real (16 KB/s). Buffer grande na PSRAM absorve a rajada.
#define PLAYBACK_BUFFER_BYTES (512 * 1024) // ~16 s @ 16k, alocado na PSRAM

// Bloco que o playbackTask entrega ao I2S por iteracao, e sua duracao. Um
// bloco de silencio injetado por falta de audio custa exatamente isto de
// buraco audivel - e a unidade em que playbackSilenceMs conta.
#define PLAYBACK_BLOCK_BYTES 512 // 256 amostras
#define PLAYBACK_BLOCK_MS (PLAYBACK_BLOCK_BYTES / 2 * 1000 / SAMPLE_RATE)

// --- Wake word local ("Hey Luna") ---
// Detecção roda no ESP32-S3 via microWakeWord (TFLite-micro). Enquanto não houver
// wake word, o microfone continua aberto LOCALMENTE mas nada sai pela rede.
// Ver src/wake/WakeWord.h e models/README.md.
#define WAKE_WORD_ENABLED 1 // 0 = volta ao open-mic (transmite sempre)

// Frase da wake word gravada no header src/wake/models/hey_luna_model_data.h.
// EM TESTE: hey_luna_trained (treinado localmente, ver wake-training/, mixednet
// idêntico ao okay_nabu). Treino convergiu rápido (99.9%+ de acurácia desde o
// passo 500), mas o AUC no split de teste ficou baixo (0.536) — sinal de
// overfitting na única voz TTS usada para gerar as 2000 amostras positivas.
// As métricas por corte (tflite_streaming_roc.txt) pareciam boas isoladamente,
// mas isso não substitui o teste no microfone real. Se não disparar bem com
// voz humana, o fallback validado é "Okay Nabu" — ver models/README.md e
// docs/adr/003. Reverter: WAKE_PHRASE "Okay Nabu" + regerar o header a partir
// de models/okay_nabu.tflite.
#define WAKE_PHRASE "Hey Luna"

// Constantes do manifesto do modelo em uso — trocar o modelo exige revisar.
// Cutoff escolhido a partir de trained_models/wakeword/.../tflite_streaming_roc.txt:
// 0.98 => frr=0.05 faph=0.94 (~1 falso-aceite/hora); 0.94 => frr=0.04 faph=2.0.
// Começando em 0.97 — ainda precisa calibrar pelo raw_max no microfone real
// (WAKE_DEBUG), igual foi feito para o okay_nabu (manifesto dizia 0.97, o
// hardware real pediu 0.90).
#define WAKE_PROB_CUTOFF 0.97f    // média da janela deslizante que dispara
#define WAKE_SLIDING_WINDOW 5     // nº de probabilidades na média móvel
#define WAKE_FEATURE_STEP_MS 10   // stride entre features (160 amostras @16k)
// Manifesto diz 30000, mas na prática o AllocateTensors usa ~30604 — com folga
// para não cair no realoc dobrado (que pede 30k+60k de pico) no boot.
#define WAKE_ARENA_BYTES 34000

// Janela de 30ms que o preprocessador consome por feature (480 amostras @16k).
#define WAKE_WINDOW_SAMPLES 480
#define WAKE_FEATURE_SIZE 40 // features int8 por slice
#define WAKE_STEP_SAMPLES (SAMPLE_RATE * WAKE_FEATURE_STEP_MS / 1000)

// Arena do preprocessador. Se o AllocateTensors falhar, o WakeWord tenta o dobro
// automaticamente e loga o tamanho efetivo — ajuste aqui depois de ver o log.
#define WAKE_PREPROC_ARENA_BYTES 16384

// Após um disparo, ignora este tanto de janelas de inferência antes de poder
// disparar de novo. Evita que o mesmo "Hey Luna" acione duas vezes. Com stride 2
// há ~50 inferências/s, então 50 ~= 1s de cool-off.
#define WAKE_REARM_WINDOWS 50

// Cooldown ao voltar para IDLE (rearm): suprime detecção por estas janelas
// enquanto o modelo recém-resetado vê áudio fresco e o eco da resposta morre.
// Sem isto, uma corrida entre captureTask e wakeTask deixa o modelo ainda-quente
// disparar sozinho logo após uma resposta. ~15 janelas * 30ms (stride 3) = ~450ms.
#define WAKE_SETTLE_WINDOWS 15

// Pré-buffer despejado ao servidor no instante do wake. A detecção só conclui
// depois da palavra terminar, então sem isto o início do comando ("Hey Luna,
// ACENDE a luz") chega cortado no provider. Vive na PSRAM.
#define WAKE_PREROLL_MS 240
#define WAKE_PREROLL_CHUNKS (WAKE_PREROLL_MS / 20) // chunks de 20ms

// Bipe curto de confirmação, empurrado pelo buffer de playback (não pelo I2S
// direto) para não disputar o barramento com o playbackTask.
#define WAKE_CHIRP_FREQ_HZ 1200
#define WAKE_CHIRP_MS 80

// Periodicidade do log de custo (CPU/RAM) do detector.
#define WAKE_STATS_INTERVAL_MS 5000

// Janela de escuta após o wake word. Sem isto, se o servidor não enfileira uma
// resposta (você falou algo que ele ignorou, ou ficou em silêncio), a FSM fica
// presa em ACTIVE_STREAMING transmitindo pra sempre. A janela fecha e volta a
// exigir o wake word quando:
//   - houver WAKE_LISTEN_SILENCE_MS de silêncio (pico < WAKE_LISTEN_VOICE_PEAK), ou
//   - passar de WAKE_LISTEN_MAX_MS desde o wake (teto absoluto, cobre ruído alto).
// O caso normal nem chega aqui: o servidor manda speaking_start e a FSM vai para
// RESPONDING antes. Só vale como rede de segurança. WAKE_LISTEN_VOICE_PEAK deve
// ficar ACIMA do ruído de fundo do mic (ver audio_peak no log em silêncio).
//
// 2026-07-25: 2500ms disparava ANTES do servidor numa pergunta longa — uma
// pausa natural para pensar no meio da frase (pico < WAKE_LISTEN_VOICE_PEAK
// por só um instante) já fechava a janela localmente, cortando a captura sem
// o servidor nunca ter recebido a frase completa. Subido para 5000ms; o teto
// absoluto subiu junto para acomodar perguntas genuinamente longas.
//
// 2026-07-25 (cont.): mesmo com 5000ms, log real mostrou "pico max=15468,
// limiar=10000" — ou seja, o pico CRUZOU o limiar (provavelmente na própria
// "Hey Luna", dita com mais ênfase) e depois nunca mais, porque a frase
// seguinte é falada num tom mais casual/baixo. 10000 (~30% da escala) exigia
// volume de wake word, não de fala contínua normal. Baixado para 3000.
#define WAKE_LISTEN_VOICE_PEAK 3000  // pico (0..32767) que conta como fala
#define WAKE_LISTEN_SILENCE_MS 5000  // silêncio que fecha a janela
#define WAKE_LISTEN_MAX_MS 20000     // teto absoluto da janela pós-wake

// Diagnóstico do domínio de features: loga pico de áudio, min/max/média das
// features e a probabilidade crua máxima. Cutoff já calibrado e validado
// (hey_luna_trained, 0.97, zero falso-positivo em ~30min de TV/conversa) —
// religar só se precisar recalibrar (troca de modelo, queixa de sensibilidade).
#define WAKE_DEBUG 1

// Despeja as features via Serial (base64) a cada WAKE_STATS_INTERVAL_MS, para
// rodar o modelo isolado no desktop. Só para depurar o "raw_max sempre 0" com
// áudio real; desligar depois. ~3s de contexto.
#define WAKE_DUMP_FEATURES 0
#define WAKE_DUMP_SLICES 300

// --- Timings de rede / FSM ---
// Rede de segurança análoga ao WAKE_LISTEN_MAX_MS: se o servidor mandar
// speaking_start e nunca mandar speaking_end (turno que não fecha no provider,
// conexão que morre sem close frame, resposta perdida), a FSM ficaria presa em
// RESPONDING para sempre — mic mudo (TX suspenso) e wake word desligada
// (shouldDetectWake() exige IDLE_LISTENING). Sem este teto só uma reautenticação
// (onAuthOk chama StateMachine::reset()) recupera o satélite.
//
// Contado desde o ÚLTIMO audio_response recebido, não desde o speaking_start:
// StateMachine::noteResponseAudio() rearma respondingSince a cada chunk (ver
// main.cpp:onAudioResponse). Antes disso o teto contava só a partir do início
// da resposta e ignorava áudio ainda chegando — uma resposta falada mais
// longa que 20s (o servidor agora despacha o áudio no ritmo real do
// playback, ver Orchestrator.ts:AUDIO_FRAME_INTERVAL_MS, então isso é comum)
// era cortada no meio mesmo com o provider ainda enviando. Agora o teto
// significa "20s SEM áudio novo", preservando a rede de segurança original
// (turno de fato travado no provider continua recuperando) sem impor limite
// à duração da resposta.
#define RESPONDING_TIMEOUT_MS 20000

#define AEC_RESUME_DELAY_MS 150    // silêncio após speaking_end antes de recapturar
#define PING_INTERVAL_MS 10000     // keep-alive
#define OFFLINE_WARN_MS 30000      // tempo offline antes do tom de aviso
#define WIFI_BACKOFF_START_MS 1000    // backoff exponencial: 1s, 2s, 4s...
#define WIFI_BACKOFF_MAX_MS 60000     // ...até 60s
#define WIFI_ATTEMPT_TIMEOUT_MS 8000  // janela mínima para uma associação concluir
