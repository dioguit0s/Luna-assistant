# Luna Client Test

Cliente de testes que simula um satélite Luna via microfone e alto-falante do PC.

## Pré-requisitos

- Node.js >= 20
- PortAudio (necessário para `naudiodon` no Windows: drivers de áudio padrão)

## Setup

```bash
cd luna-client-test
cp .env.example .env
npm install
```

## Executar

```bash
# Microfone — use dev:mic (não use npm run dev --mic)
npm run dev:mic

# Arquivo WAV (sem microfone)
npm run dev:wav

# Equivalente com argumentos explícitos
npm run dev -- --mic
npm run dev -- --wav fixtures/silence.wav
```

### Microfone no Windows

O cliente tenta, nesta ordem:

1. **naudiodon** (opcional — exige Visual Studio Build Tools)
2. **ffmpeg** — instale em https://ffmpeg.org e adicione ao PATH

Se ffmpeg não detectar o microfone automaticamente, liste os dispositivos:

```bash
ffmpeg -list_devices true -f dshow -i dummy
```

Depois defina no `.env`:

```env
MIC_DEVICE=Nome exato do microfone
```

## Conversa multi-turno

Vários turnos na mesma sessão — é o cenário de uso real, e o único em que a
latência de regime aparece (a primeira fala paga ~2s de abertura de sessão):

```bash
npm run dev -- --wav fixtures/t1-saudacao-trim.wav,fixtures/t2-capital-trim.wav
```

Os fixtures `*-trim.wav` foram gerados com a voz SAPI pt-BR do Windows e têm o
silêncio final cortado. Isso importa: com silêncio embutido no WAV o marco de
fim-de-fala fica adiantado e a medição sai inflada.

## Push-to-talk (activityEnd manual)

Desliga o VAD do provider e usa o fim de fala explícito, como o botão do
satélite. **As duas variáveis precisam concordar** — com apenas uma ligada o
turno é interrompido e nenhuma resposta chega:

```bash
# servidor
GEMINI_MANUAL_ACTIVITY=true npm run dev
# cliente
MANUAL_ACTIVITY=true npm run dev -- --wav fixtures/t2-capital-trim.wav
```

Em modo manual o cliente para de transmitir ao sinalizar o fim; continuar
mandando silêncio reabriria a atividade e cancelaria a resposta em andamento.

## Instrumentação TTFAB

O cliente loga duas métricas por turno:

- `[TTFAB client]` — do último chunk enviado até o primeiro `audio_response`.
  **Só é significativo se o cliente parar de transmitir no fim da fala.** Com
  streaming contínuo o marco vira sempre "agora" e o número fica perto de zero
  sem que nada tenha melhorado.
- `[turno N] EOS→áudio` — do fim da **fala** até o primeiro áudio de volta.
  É a medida honesta, e a que corresponde ao que o usuário sente.

Compare com o log `event: ttfab` do servidor, que tem a mesma limitação do
primeiro item.
