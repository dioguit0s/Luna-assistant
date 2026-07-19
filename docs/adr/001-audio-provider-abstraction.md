# ADR 001 — Abstração do Provedor de Áudio

**Status:** Aceito  
**Data:** 2026-06-30  
**Contexto:** Épico 1 — O Cérebro da Luna

## Contexto

O Projeto Luna depende de APIs de voz em tempo real para processamento audio-to-audio com meta de TTFAB inferior a 800ms. O mercado de provedores de IA multimodal é altamente mutável: modelos são deprecados, preços mudam e capacidades evoluem rapidamente.

Acoplar o orquestrador central diretamente ao SDK de um único fornecedor (Gemini Live ou OpenAI Realtime) criaria vendor lock-in prematuro e dificultaria fallback operacional quando o provider primário estiver indisponível ou degradado.

## Decisão

Adotar arquitetura **Ports & Adapters (Hexagonal)** com uma interface `IAudioProvider` como port de saída da camada cognitiva.

O orquestrador depende exclusivamente do contrato do port. Implementações concretas (`GeminiLiveAdapter`, `OpenAIRealtimeAdapter`) ficam isoladas em `luna-server/src/providers/`. A seleção do provider ativo ocorre via factory que lê `AUDIO_PROVIDER` do ambiente — sem condicionais de provider espalhados no core.

### Contrato do Port

```typescript
interface IAudioProvider {
  connect(session: ProviderSessionConfig): Promise<void>;
  sendAudio(pcm16kHz: Buffer): void;
  signalActivityEnd(): void;
  onAudioResponse(callback: (chunk: Buffer) => void): void;
  onTurnComplete(callback: (turn: CompletedTurn) => void): void;
  onError(callback: (err: Error) => void): void;
  disconnect(): Promise<void>;
}
```

### Responsabilidades por camada

| Camada | Responsabilidade |
|--------|------------------|
| Orchestrator | Pipeline de áudio, TTFAB, ring buffer, protocolo WS |
| IAudioProvider (port) | Contrato estável de streaming bidirecional |
| Adapters | SDK específico, resampling de sample rate, turn detection nativo |
| AudioProviderFactory | Instanciação baseada em env |

## Consequências

### Positivas

- Troca de provider via `.env` sem alteração de código no core (critério de aceite do Épico 1).
- Adapters testáveis isoladamente com mocks do port.
- Resampling (16 kHz ↔ 24 kHz) encapsulado nos adapters — o protocolo Luna permanece em 16 kHz mono.
- Novos providers (ex.: Azure Voice Live) adicionados criando um adapter + registro na factory.

### Negativas

- Overhead inicial de abstração antes da primeira integração E2E.
- Diferenças semânticas entre providers (VAD, formato de histórico) exigem normalização no adapter, não no port.
- Manutenção de dois adapters em paridade de comportamento.

## Alternativas Consideradas

### SDK único acoplado (rejeitada)

Usar apenas `@google/genai` diretamente no orchestrator. Rejeitada por impossibilitar fallback configurável e acoplar o core a APIs específicas do Gemini.

### If/else de provider no orchestrator (rejeitada)

Condicionais `if (provider === 'gemini')` espalhados no fluxo de áudio. Rejeitada por violar Open/Closed Principle e dificultar testes.

### Proxy de áudio genérico (adiada)

Camada intermediária que traduz qualquer WebSocket de IA para o protocolo Luna. Adiada por complexidade desproporcional ao Épico 1; pode ser revisitada se o número de providers crescer além de 3.

## Referências

- [PROJETO LUNA.md](../PROJETO%20LUNA.md) — Seções 2, 3 e 7
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)
- [OpenAI Realtime API](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [ADR 002 — Contrato de Function Calling](./002-function-calling-contract.md) — estende este port com tools
