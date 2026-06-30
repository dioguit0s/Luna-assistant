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

## Instrumentação TTFAB

O cliente mede TTFAB com `performance.now()` do último chunk enviado até o primeiro `audio_response` recebido. Compare com o log `event: ttfab` do servidor.
