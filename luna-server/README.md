# Luna Server

Orquestrador central do Projeto Luna — Épico 1.

## Pré-requisitos

- Node.js >= 20
- Chave de API do provider configurado (`GEMINI_API_KEY` ou `OPENAI_API_KEY`)

## Setup

```bash
cd luna-server
cp .env.example .env
# Edite .env com suas chaves
npm install
```

## Executar

```bash
npm run dev
```

## Testes

```bash
npm test
```

## Variáveis de ambiente

| Variável | Descrição |
|----------|-----------|
| `AUDIO_PROVIDER` | `gemini` ou `openai` |
| `GEMINI_API_KEY` | Chave Google AI (quando provider=gemini) |
| `OPENAI_API_KEY` | Chave OpenAI (quando provider=openai) |
| `WS_AUTH_SECRET` | Segredo HMAC para autenticação de satélites |
| `WS_PORT` | Porta WebSocket (default: 8080) |
| `LOG_LEVEL` | Nível de log pino (default: info) |
| `HA_URL` | URL do Home Assistant (Épico 3, ex: `http://192.168.0.10:8123`) |
| `HA_TOKEN` | Long-Lived Access Token do Home Assistant (Épico 3) |

O `HA_TOKEN` é gerado na UI do Home Assistant: perfil do usuário → aba
*Segurança* → **Long-Lived Access Tokens** → *Criar token*. O valor só é exibido
uma vez. Ver [`infra/README.md`](../infra/README.md) para a subida do serviço.

## Homologação Épico 1

1. Inicie o servidor: `npm run dev`
2. Em outro terminal, inicie o cliente de teste em `luna-client-test`
3. Fale no microfone e verifique logs com `latency_ms` (meta: < 800ms)
4. Teste multi-turn: apresente-se e pergunte seu nome em seguida
5. Troque `AUDIO_PROVIDER` no `.env` e reinicie — sem alteração de código
