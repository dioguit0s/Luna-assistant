import type { Reminder, ReminderStore } from '../../reminders/ReminderStore.js';
import type { ReminderScheduler } from '../../reminders/ReminderScheduler.js';
import { isSetReminderArgs, type SetReminderArgs } from '../../reminders/tools.js';
import { resolveOnceDueAt } from '../../reminders/resolveOnce.js';
import { resolveRecurring } from '../../reminders/recurrence.js';
import { getLogger } from '../../logging/logger.js';
import type { NowFn } from '../../time/clock.js';
import { systemNow } from '../../time/clock.js';
import { INVALID_ARGS_RESULT, type ToolHandler } from './types.js';

/**
 * `label` é texto que vai ser falado de volta pelo satélite. Um limite
 * generoso para uma frase curta ("tomar o remédio às 20h"), não um parágrafo
 * — o alvo de fala da Luna já é 1-2 frases.
 */
export const MAX_LABEL_LENGTH = 200;

/**
 * "Luna" no label re-dispara a wake word quando o alarme fala o texto de
 * volta durante o toque (decisão 11 do plano) — a rajada de chime já corre
 * esse risco baixo com um tom puro; a fala não pode somar a palavra que
 * acorda o próprio detector.
 */
const WAKE_WORD_PATTERN = /luna/i;

export interface SetReminderDeps {
  store: ReminderStore;
  /**
   * Resolvido no momento da chamada, não capturado na construção: o scheduler
   * só existe depois que o `WsServer`/`Orchestrator` sobem por completo (ver
   * `Orchestrator.setReminderScheduler`), mas o handler é registrado antes
   * disso, no construtor.
   */
  getScheduler: () => ReminderScheduler;
  reminderMaxPerRoom: number;
  /** Injetável para teste, mesmo padrão do resto do módulo de lembretes. */
  now?: NowFn;
}

export function createSetReminderHandler(deps: SetReminderDeps): ToolHandler {
  const now = deps.now ?? systemNow;

  return async (args, ctx) => {
    if (!isSetReminderArgs(args)) {
      getLogger().error(
        { event: 'tool_call', room_id: ctx.roomId, name: 'set_reminder', args },
        'Tool call inválida ou desconhecida',
      );
      return INVALID_ARGS_RESULT;
    }

    const label = sanitizeLabel(args.label);
    if (label.ok === false) {
      return { success: false, error: label.error };
    }

    if (deps.store.countLiveByRoom(ctx.roomId) >= deps.reminderMaxPerRoom) {
      getLogger().warn(
        { event: 'reminder_room_full', room_id: ctx.roomId, max: deps.reminderMaxPerRoom },
        `Cômodo ${ctx.roomId} já tem o máximo de lembretes vivos`,
      );
      return { success: false, error: 'já tem lembretes demais marcados aqui — cancele algum antes' };
    }

    const criacao =
      args.repeat === undefined || args.repeat === 'none'
        ? criarOneShot(deps, ctx.roomId, label.value, args, now())
        : criarRecorrente(deps, ctx.roomId, label.value, args, now());

    if (criacao.ok === false) {
      return { success: false, error: criacao.error };
    }
    const { created, spokenWhen } = criacao;

    // Sem isto, um "daqui a 10 segundos" só seria notado na próxima acordada
    // do timer — até MAX_TIMER_DELAY_MS (60s) de atraso.
    deps.getScheduler().reschedule();

    getLogger().info(
      {
        event: 'reminder_set',
        room_id: ctx.roomId,
        reminder_id: created.id,
        short_id: created.shortId,
        due_at_utc: created.dueAtUtc,
        next_due_utc: created.nextDueUtc,
        kind: created.kind,
        repeat_rule: created.repeatRule,
        has_label: created.label !== null,
      },
      `Lembrete ${created.shortId} marcado para ${spokenWhen} em ${ctx.roomId}`,
    );

    return {
      success: true,
      reminder_id: created.shortId,
      spoken_when: spokenWhen,
      label: created.label,
    };
  };
}

type Criacao =
  | { ok: true; created: Reminder; spokenWhen: string }
  | { ok: false; error: string };

/** "daqui a 10 minutos", "me acorda às 7", "sexta às 20h" — instante único. */
function criarOneShot(
  deps: SetReminderDeps,
  roomId: string,
  label: string | null,
  args: SetReminderArgs,
  agora: Date,
): Criacao {
  const resolved = resolveOnceDueAt(
    { inSeconds: args.in_seconds, atTime: args.at_time, whenDay: args.when_day },
    agora,
  );
  if (!resolved.ok) return { ok: false, error: resolved.error };

  return {
    ok: true,
    created: deps.store.insertOnce(
      { roomId, label, dueAtUtc: resolved.dueAtUtc },
      agora.getTime(),
    ),
    spokenWhen: resolved.spokenWhen,
  };
}

/**
 * "todo dia útil às 6:30", "toda sexta às 20h".
 *
 * O banco guarda a **hora local** e a regra, não um instante: é `next_due_utc`
 * que é materializado, e ele é recomputado a partir da hora de parede a cada
 * disparo. Um recorrente definido por delta sairia do horário a cada soneca.
 */
function criarRecorrente(
  deps: SetReminderDeps,
  roomId: string,
  label: string | null,
  args: SetReminderArgs,
  agora: Date,
): Criacao {
  if (args.in_seconds !== undefined) {
    return { ok: false, error: 'para repetir eu preciso de um horário, não de "daqui a tanto"' };
  }
  if (args.at_time === undefined) {
    return { ok: false, error: 'faltou o horário em que isso deve tocar todo dia' };
  }

  const resolved = resolveRecurring(
    {
      atTime: args.at_time,
      repeat: args.repeat as Exclude<NonNullable<SetReminderArgs['repeat']>, 'none'>,
      whenDay: args.when_day,
    },
    agora,
  );
  if (!resolved.ok) return { ok: false, error: resolved.error };

  return {
    ok: true,
    created: deps.store.insertRecurring(
      {
        roomId,
        label,
        localHour: resolved.localHour,
        localMinute: resolved.localMinute,
        repeatRule: resolved.repeatRule,
        nextDueUtc: resolved.firstDueUtc,
      },
      agora.getTime(),
    ),
    spokenWhen: resolved.spokenWhen,
  };
}

function sanitizeLabel(raw: string | undefined): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: null };

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };

  if (trimmed.length > MAX_LABEL_LENGTH) {
    return { ok: false, error: 'esse lembrete está longo demais' };
  }

  if (WAKE_WORD_PATTERN.test(trimmed)) {
    return { ok: false, error: 'não posso usar meu próprio nome no texto do lembrete' };
  }

  return { ok: true, value: trimmed };
}
