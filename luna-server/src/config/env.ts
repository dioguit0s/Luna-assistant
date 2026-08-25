import { config as loadEnv } from 'dotenv';
import { isAbsolute, join, resolve } from 'node:path';

loadEnv();

export type AudioProviderName = 'gemini' | 'openai';

export interface AppConfig {
  audioProvider: AudioProviderName;
  geminiApiKey: string;
  openaiApiKey: string;
  wsAuthSecret: string;
  wsPort: number;
  logLevel: string;
  geminiLiveModel: string;
  openaiRealtimeModel: string;
  haUrl: string;
  haToken: string;
  /** Overrides do registro de dispositivos. O catálogo em si vem do HA. */
  devicesConfigPath: string;
  /** Intervalo de revalidação do registro: dispositivo novo sem restart. */
  deviceRegistryTtlMs: number;
  /**
   * Teto para `IAudioProvider.connect()`. Um blackhole de rede (Wi-Fi de pé,
   * internet fora) deixa a promise do SDK do Gemini/OpenAI pendurada para
   * sempre — sem este teto, `RoomManager.pendingConnections` entrega a mesma
   * promise nunca resolvida para todo chunk de áudio seguinte, e a sala fica
   * muda até o processo reiniciar.
   */
  providerConnectTimeoutMs: number;
  geminiVadSilenceMs: number | null;
  geminiVadEndSensitivity: EndSensitivityName | null;
  geminiManualActivity: boolean;
  /**
   * `thinkingBudget` da sessão Live: `0` desabilita o thinking, `-1` deixa o
   * modelo decidir (default dos native-audio preview — e o raciocínio roda
   * inteiro antes da tool call, direto no atraso percebido), `null` omite o
   * campo (obrigatório em modelos que rejeitam `thinkingConfig`, como os
   * half-cascade).
   */
  geminiThinkingBudget: number | null;
  /** Loga mensagens cruas do Gemini, incluindo transcrições da fala do usuário. */
  geminiDebugMessages: boolean;
  /**
   * Silêncio (ms) sem novo fragmento de `onUserSpeech` até o Orchestrator
   * assumir "usuário parou de falar" e mandar `speaking_start` ao satélite —
   * sem esperar o primeiro áudio de resposta. Fecha a janela em que o LED
   * continua aceso mesmo com o comando já capturado (STT/LLM/TTS ainda
   * processando), evitando que o usuário fale por cima de um turno em voo.
   */
  userSilenceCutoffMs: number;
  /**
   * `server_vad` corta o turno por silêncio (a janela entra no TTFAB, como o
   * VAD do Gemini); `semantic_vad` decide pelo conteúdo e ignora
   * `openaiVadSilenceMs`.
   */
  openaiVadType: OpenAIVadType;
  openaiVadSilenceMs: number | null;
  /** Loga mensagens cruas da Realtime, incluindo transcrições da fala. */
  openaiDebugMessages: boolean;
  openaiVoice: string;
  /**
   * Caminho **absoluto** do banco de lembretes. Absoluto de propósito: o
   * `activate.sh` troca o symlink de `/opt/luna/current` a cada deploy e poda
   * as releases antigas, então um default relativo ao `WorkingDirectory` —
   * como o de `devicesConfigPath` — apontaria justamente para o diretório que
   * some. Em produção vem do `$STATE_DIRECTORY` que o systemd cria.
   */
  dbPath: string;
  /** Carência do catch-up: lembrete mais atrasado que isto no boot não toca. */
  missedGraceMs: number;
  /** Teto do ciclo de toque; usado para fechar `ringing` órfão no boot. */
  alarmMaxRingMs: number;
  /** Teto de disparos simultâneos: 20 alarmes não podem abrir 20 sessões de provider. */
  reminderMaxConcurrent: number;
  /** Teto de lembretes vivos por sala: um loop de tool calls não pode inserir milhares de linhas. */
  reminderMaxPerRoom: number;
  /**
   * Cômodo de fallback quando o satélite de origem está offline no disparo.
   * Burro de propósito — config fixa, não "onde tem gente". Vazio desliga o
   * fallback: o alarme só toca na sala de origem, e se ninguém estiver lá,
   * silêncio (melhor que adivinhar errado onde tem gente).
   */
  reminderFallbackRoomId: string;
  /**
   * Janela em que o satélite fica ouvindo entre duas rajadas do alarme.
   *
   * Consequência direta de dispensar por wake word: em `RESPONDING` a wake word
   * está desligada, então um alarme que toca continuamente é um alarme que não
   * se desliga por voz. O orçamento vem do firmware: `speaking_end` → drain do
   * `playbackBuffer` → `AEC_RESUME_DELAY_MS` (150 ms) → `WAKE_SETTLE_WINDOWS`
   * (15 janelas ≈ 450 ms de supressão) — ~600 ms surdos antes de a pessoa poder
   * começar, mais ~700-900 ms de "Hey Luna".
   *
   * 2026-08-24: valor derivado desses números no papel, **não medido no
   * hardware** (esta rodada não teve satélite disponível). Calibrar no
   * dispositivo real, como os `WAKE_LISTEN_*` do `config.h` foram.
   */
  ringListenWindowMs: number;
  /**
   * Silêncio mínimo desde a última fala do usuário para uma rajada poder sair.
   *
   * `speaking_start` faz o firmware dar `xQueueReset(txQueue)`: uma rajada no
   * meio de uma frase corta o comando do usuário e o provider recebe meia
   * pergunta. O mesmo guard resolve a corrida da borda — a wake word da
   * dispensa caindo no instante do re-disparo.
   */
  ringBargeInGuardMs: number;
  /**
   * Espera antes de tentar de novo quando a sala emudeceu **depois** de já ter
   * recebido rajada (satélite desconectou no meio do toque).
   *
   * Nunca rearmar com o vencimento original: `next_due_utc` no passado faz o
   * scheduler acordar com `delay = 0` e re-disparar em laço quente até a
   * carência de `missedGraceMs` expirar.
   */
  ringSilentRetryMs: number;
  /**
   * Teto de adiamento de uma rajada pelo guard de barge-in.
   *
   * Sem ele, um cômodo que transmite sem parar nunca ouviria o alarme — é o
   * caso do `luna-client-test --mic` e do `luna-desktop`, que não têm wake word.
   * Um alarme que **nunca toca** é pior que um que trunca uma frase, então
   * passado este teto a rajada sai assim mesmo.
   *
   * 2026-08-24: não medido no hardware, como `ringListenWindowMs`. É env pelo
   * mesmo motivo que aquele: calibrar não pode exigir redeploy.
   */
  ringMaxDeferMs: number;
  /** Teto da soneca pedida por voz, em minutos. */
  reminderSnoozeMaxMinutes: number;
}

export type EndSensitivityName = 'HIGH' | 'LOW';

export type OpenAIVadType = 'server_vad' | 'semantic_vad';

function parseVadType(value: string | undefined): OpenAIVadType | null {
  if (!value) return null;
  if (value === 'server_vad' || value === 'semantic_vad') return value;
  throw new Error(
    `OPENAI_VAD_TYPE inválido: "${value}". Use "server_vad" ou "semantic_vad".`,
  );
}

function parseEndSensitivity(value: string | undefined): EndSensitivityName | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  if (upper === 'HIGH' || upper === 'LOW') return upper;
  throw new Error(`GEMINI_VAD_END_SENSITIVITY inválido: "${value}". Use "HIGH" ou "LOW".`);
}

function parseOptionalNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} inválido: "${raw}". Use um número de milissegundos.`);
  }
  return parsed;
}

/**
 * `parseOptionalNumber` não serve aqui: `-1` (automático) é valor válido.
 * Aceita inteiro >= -1 ou o literal "off" para omitir o campo da sessão.
 */
function parseThinkingBudget(value: string | undefined): number | null | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.toLowerCase() === 'off') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < -1) {
    throw new Error(
      `GEMINI_THINKING_BUDGET inválido: "${value}". Use um inteiro >= -1 ou "off".`,
    );
  }
  return parsed;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

function parseAudioProvider(value: string): AudioProviderName {
  if (value === 'gemini' || value === 'openai') {
    return value;
  }
  throw new Error(`AUDIO_PROVIDER inválido: "${value}". Use "gemini" ou "openai".`);
}

/**
 * `LUNA_DB_PATH` explícito > `$STATE_DIRECTORY` do systemd > default de dev.
 *
 * O systemd cria `/var/lib/luna-server` com dono `luna:luna` a partir do
 * `StateDirectory=` da unit e exporta o caminho em `$STATE_DIRECTORY` — é o que
 * libera escrita mesmo sob `ProtectSystem=strict`, sem `ReadWritePaths` à mão.
 * Com mais de um `StateDirectory=`, a variável vem separada por `:`.
 */
export function resolveDbPath(
  explicit = process.env.LUNA_DB_PATH,
  stateDirectory = process.env.STATE_DIRECTORY,
): string {
  if (explicit) {
    return isAbsolute(explicit) ? explicit : resolve(explicit);
  }
  const firstStateDir = stateDirectory?.split(':')[0];
  if (firstStateDir) {
    return join(firstStateDir, 'luna.db');
  }
  return resolve('.luna-state', 'luna.db');
}

export function loadConfig(): AppConfig {
  const audioProvider = parseAudioProvider(process.env.AUDIO_PROVIDER ?? 'gemini');
  const thinkingBudget = parseThinkingBudget(process.env.GEMINI_THINKING_BUDGET);

  const config: AppConfig = {
    audioProvider,
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    wsAuthSecret: requireEnv('WS_AUTH_SECRET'),
    wsPort: Number(process.env.WS_PORT ?? 8080),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    geminiLiveModel:
      process.env.GEMINI_LIVE_MODEL ?? 'gemini-2.5-flash-native-audio-preview-12-2025',
    openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime',
    haUrl: process.env.HA_URL ?? '',
    haToken: process.env.HA_TOKEN ?? '',
    devicesConfigPath: process.env.DEVICES_CONFIG_PATH ?? 'config/devices.json',
    deviceRegistryTtlMs: parseOptionalNumber('DEVICE_REGISTRY_TTL_MS') ?? 300_000,
    providerConnectTimeoutMs: parseOptionalNumber('PROVIDER_CONNECT_TIMEOUT_MS') ?? 5000,
    // Sem override, o SDK usa END_SENSITIVITY_LOW e uma janela de silêncio
    // longa: o Gemini só começa a gerar bem depois de o usuário calar. Isso
    // entra inteiro no atraso percebido entre o comando e a luz acender.
    // HIGH + 500ms fecha o turno assim que a fala para. Se estiver cortando
    // frases no meio (pausa para pensar vira fim de turno), suba o silêncio
    // via GEMINI_VAD_SILENCE_MS antes de voltar para LOW.
    geminiVadSilenceMs: parseOptionalNumber('GEMINI_VAD_SILENCE_MS') ?? 500,
    geminiVadEndSensitivity: parseEndSensitivity(process.env.GEMINI_VAD_END_SENSITIVITY) ?? 'HIGH',
    geminiManualActivity: process.env.GEMINI_MANUAL_ACTIVITY === 'true',
    // Default 0: para um vocabulário de uma tool on/off, o thinking não paga
    // o ~1s que custa dentro do model_decision_ms. `-1` restaura o dinâmico.
    // `??` não serve: "off" vira `null` e precisa sobreviver até a sessão.
    geminiThinkingBudget: thinkingBudget === undefined ? 0 : thinkingBudget,
    geminiDebugMessages: process.env.GEMINI_DEBUG_MESSAGES === 'true',
    // Mesma ordem de grandeza do GEMINI_VAD_SILENCE_MS: no OpenAI o evento de
    // fim de fala já é discreto (um único disparo), então o debounce só soma
    // um atraso fixo pequeno; no Gemini é essencial — sem ele, cortaria no
    // primeiro fragmento de transcrição, ainda no meio da frase.
    userSilenceCutoffMs: parseOptionalNumber('USER_SILENCE_CUTOFF_MS') ?? 500,
    // Mesmo default do GEMINI_VAD_SILENCE_MS: os dois providers precisam do
    // mesmo endpointing para a comparação de TTFAB significar alguma coisa.
    openaiVadType: parseVadType(process.env.OPENAI_VAD_TYPE) ?? 'server_vad',
    openaiVadSilenceMs: parseOptionalNumber('OPENAI_VAD_SILENCE_MS') ?? 500,
    openaiDebugMessages: process.env.OPENAI_DEBUG_MESSAGES === 'true',
    openaiVoice: process.env.OPENAI_VOICE ?? 'marin',
    dbPath: resolveDbPath(),
    missedGraceMs: parseOptionalNumber('MISSED_GRACE_MS') ?? 15 * 60_000,
    alarmMaxRingMs: parseOptionalNumber('ALARM_MAX_RING_MS') ?? 5 * 60_000,
    reminderMaxConcurrent: parseOptionalNumber('REMINDER_MAX_CONCURRENT') ?? 20,
    reminderMaxPerRoom: parseOptionalNumber('REMINDER_MAX_PER_ROOM') ?? 20,
    reminderFallbackRoomId: process.env.REMINDER_FALLBACK_ROOM_ID ?? '',
    ringListenWindowMs: parseOptionalNumber('RING_LISTEN_WINDOW_MS') ?? 6_000,
    ringBargeInGuardMs: parseOptionalNumber('RING_BARGEIN_GUARD_MS') ?? 2_000,
    ringSilentRetryMs: parseOptionalNumber('RING_SILENT_RETRY_MS') ?? 60_000,
    ringMaxDeferMs: parseOptionalNumber('RING_MAX_DEFER_MS') ?? 3_000,
    reminderSnoozeMaxMinutes: parseOptionalNumber('REMINDER_SNOOZE_MAX_MINUTES') ?? 60,
  };

  if (audioProvider === 'gemini' && !config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY é obrigatória quando AUDIO_PROVIDER=gemini');
  }
  if (audioProvider === 'openai' && !config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY é obrigatória quando AUDIO_PROVIDER=openai');
  }

  return config;
}
