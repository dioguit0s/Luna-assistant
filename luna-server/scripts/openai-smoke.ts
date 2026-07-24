/**
 * Smoke test manual da sessão OpenAI Realtime (LUNA-307).
 *
 *   node --import tsx scripts/openai-smoke.ts
 *
 * Abre a sessão com as tools declaradas e espera pela confirmação do servidor,
 * sem enviar áudio. Serve para validar o `session.update` no formato GA — nome
 * de voz, modelo de transcrição e schema das tools são rejeitados aqui, com a
 * mensagem exata, em vez de falharem no meio de um teste com microfone.
 *
 * Precisa de OPENAI_API_KEY no .env. Não depende de AUDIO_PROVIDER.
 */
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/logging/logger.js';
import { OpenAIRealtimeAdapter } from '../src/providers/openai/OpenAIRealtimeAdapter.js';
import { CONTROL_DEVICE_TOOL } from '../src/providers/types.js';

const TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  createLogger(config);

  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY vazia no .env');
  }

  console.log(`modelo: ${config.openaiRealtimeModel}`);
  console.log(`voz: ${config.openaiVoice} — vad: ${config.openaiVadType}\n`);

  const adapter = new OpenAIRealtimeAdapter(config);
  let failure: Error | null = null;

  adapter.onError((err) => {
    failure = err;
  });

  await adapter.connect({
    roomId: 'smoke',
    systemPrompt: 'Você é a Luna.',
    history: [],
    tools: [CONTROL_DEVICE_TOOL],
  });

  // A sessão sobe no `open`; um session.update inválido só volta depois, como
  // evento `error`. Sem essa espera o script sairia "verde" com a sessão morta.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await adapter.disconnect();

  if (failure) {
    throw failure;
  }

  console.log('\nsession.update aceito — tools declaradas sem erro.');
}

main().catch((err) => {
  console.error('\nFalha no smoke test da OpenAI Realtime:', err.message ?? err);
  process.exit(1);
});
