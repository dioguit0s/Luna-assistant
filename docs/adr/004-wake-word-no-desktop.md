# ADR 004 — Extração de features do wake word no `luna-desktop`

**Status:** Aceito
**Data:** 2026-08-17
**Contexto:** Marco 3 do `luna-desktop` (docs/luna-desktop.md)

## Contexto

O [ADR 003](003-wake-word-engine.md) escolheu microWakeWord/TFLite-micro como
engine de wake word para o satélite ESP32-S3, com o modelo "Hey Luna" treinado
localmente (`luna-firmware/models/hey_luna_trained.tflite`) e o fallback
`okay_nabu.tflite`. O `luna-desktop` (satélite virtual, sem hardware
dedicado) precisa da mesma detecção, e o plano original (`docs/luna-desktop.md`
§2, redigido antes deste marco) assumia um sidecar Python que carregaria os
`.tflite` vendorizados — preprocessador **e** modelo wake — com
`tflite-runtime` ou `tensorflow`, tirados do ambiente já validado em
`wake-training/Dockerfile`.

Ao implementar o marco 3, essa suposição se provou errada em dois pontos,
verificados na máquina de desenvolvimento (Windows, Python 3.14.4,
2026-08-17):

1. **Não há wheel de `tflite-runtime`, `tensorflow` nem `tflite-micro` para
   Windows + Python 3.14.** O ambiente do `wake-training/` é uma imagem Docker
   Linux/Python 3.11 — é o ambiente de *treino*, não algo instalável direto no
   desktop do usuário.
2. **O preprocessador `audio_preprocessor_int8.tflite` não carrega fora do
   tflite-micro.** Ele roda inteiramente em kernels customizados
   `tflite::tflm_signal` (`SignalWindow`, `SignalFftAutoScale`, `SignalRfft`,
   `SignalFilterBank*`, `SignalPcan`, `SignalFilterBankLog`) que só existem
   nesse runtime. Tentar carregá-lo com um interpretador TFLite normal falha
   com `RuntimeError: Encountered unresolved custom op: SignalWindow`.

O modelo wake em si (`hey_luna_trained.tflite`, `okay_nabu.tflite`) **não**
tem esse problema — é um `.tflite` int8 comum, sem ops customizadas.

## Decisão

Duas peças, separadas:

- **Modelo wake:** [`ai-edge-litert`](https://pypi.org/project/ai-edge-litert/),
  sucessor mantido do `tflite-runtime` (mesma API), com wheel para Windows +
  Python 3.14. Carrega `hey_luna_trained.tflite`/`okay_nabu.tflite` sem
  alteração — verificado nesta sessão.
- **Extração de features (substitui o preprocessador `.tflite`):**
  [`pymicro-features`](https://pypi.org/project/pymicro-features/) 2.0.2 —
  o mesmo micro frontend em C++ do tflite-micro, embalado como wheel `abi3`
  standalone (roda em qualquer Python ≥3.9, incluindo 3.14 sem rebuild). Não é
  uma escolha arbitrária: é a implementação que o próprio
  [microWakeWord](https://github.com/kahrendt/microWakeWord) usa
  (`microwakeword/audio/audio_utils.py`, `use_c=True`) para gerar as features
  de **treino** dos modelos vendorizados — a mesma origem, não uma
  reimplementação paralela.

Como o firmware copia a saída int8 do preprocessador **crua** (sem
dequantizar) para dentro do tensor de entrada do modelo wake, o sidecar
reconstrói essa quantização a partir do `input_scale`/`input_zero_point` lidos
do próprio modelo, aplicados a um fator de escala único e nomeado
(`FEATURE_SCALE` em `luna-desktop/wakeword-sidecar/frontend.py`) — porque a
escala numérica da saída de `pymicro-features` não é documentada. Resolvido
empiricamente (não por leitura de código): alimentando o frontend com ruído
branco moderado, a faixa observada (`max≈25.8`, `p99≈22.6`) bate com a
hipótese de faixa crua ~0..26, não com a alternativa ~0..666 — `FEATURE_SCALE
= 1.0`. Ver `wakeword-sidecar/README.md` para a medição completa e para a
confirmação pendente com fala real.

A lógica de janela/stride/refratário/rearm do `WakeWord.cpp` é replicada em
`luna-desktop/wakeword-sidecar/detector.py`, módulo puro (sem tflite, sem
pymicro, sem I/O) coberto por testes unitários que fixam cada detalhe
observável do firmware: agrupamento não-sobreposto por `stride`, a
probabilidade entrando no anel *antes* do refratário, a comparação `>`
estrita sobre a soma (não a média), e `rearm()` chamando
`reset_all_variables()` — o equivalente de `Reset()` do TFLM, carga-crítico
porque sem ele o modelo streaming trava com a saída presa em 255 depois de
qualquer pausa na alimentação.

## Consequências

- **Duas implementações de extração de features a manter em sincronia:** o
  `.tflite` do firmware e o `pymicro-features` do desktop não são o mesmo
  binário — só a mesma origem. Uma mudança no preprocessador do firmware
  (novo modelo, novos parâmetros) não se propaga automaticamente para o
  sidecar; `luna-firmware/models/README.md` agora aponta para cá.
- **O cutoff pode ser diferente por plataforma.** `WAKE_PROB_CUTOFF = 0.97`
  foi calibrado no microfone INMP441 do satélite, sem processamento. O
  `luna-desktop` captura via `getUserMedia` com
  `echoCancellation`/`noiseSuppression`/`autoGainControl` ligados — um
  domínio de áudio diferente. O sidecar aceita `--threshold`/`--cutoff` como
  parâmetro em vez de fixar `0.97`; o valor de produção do desktop fica
  documentado em `wakeword-sidecar/README.md` assim que medido com voz real.
- **`FEATURE_SCALE` é uma constante empírica, não derivada.** Fica sujeita a
  precisar de correção se `pymicro-features` mudar de versão ou de
  comportamento — documentado com a medição que a sustenta, para a próxima
  pessoa poder refazer o teste em vez de confiar cegamente no número.
- **Python local continua sendo dependência de runtime do v1** (como o plano
  original já previa) — só a lista de pacotes mudou, não a estratégia de
  empacotamento (PyInstaller como follow-up, não bloqueia).

## Alternativas descartadas

- **Rodar o preprocessador `.tflite` canônico dentro de um container Docker
  Linux** (o mesmo caminho usado no bring-up do ADR 003, que tem
  `tflite-micro` funcionando). Daria paridade byte-exata, mas faria o app de
  bandeja depender de um daemon Docker rodando (não estava rodando nesta
  máquina no momento da implementação) — inaceitável para um processo que
  precisa iniciar sozinho no login do usuário. Fica como caminho de
  desempate se a paridade do `pymicro-features` se provar insuficiente (ver
  "tiebreaker" em `wakeword-sidecar/README.md`: comparar contra um dump de
  features reais do firmware via `WAKE_DUMP_FEATURES`).
- **Instalar um segundo interpretador Python (3.11/3.12) só para o sidecar**,
  visando `tflite-runtime` ou `tensorflow` de verdade. Reduz o atrito de
  versão do Python, mas não resolve o problema real: os kernels
  `tflm_signal` não existem em `tflite-runtime`/`tensorflow` normais em
  nenhuma versão de Python — só em `tflite-micro`, que também não tem wheel
  para Windows. Trocar de interpretador não destrava nada.
- **Reimplementar o preprocessamento (mel filterbank, PCAN, subtração
  espectral) em JavaScript/numpy puro.** É exatamente o risco que o ADR 003
  já rejeitou para o firmware (divergir sutilmente do que foi validado) — só
  que agora sem hardware real para validar contra. `pymicro-features` evita
  esse risco por ser a mesma implementação, não uma reescrita.
