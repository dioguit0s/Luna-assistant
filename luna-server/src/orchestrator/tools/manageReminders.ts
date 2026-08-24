import type { AlarmRinger } from '../../reminders/AlarmRinger.js';
import type { ReminderScheduler } from '../../reminders/ReminderScheduler.js';
import type { Reminder, ReminderStore } from '../../reminders/ReminderStore.js';
import { isManageRemindersArgs, type ManageRemindersArgs } from '../../reminders/tools.js';
import { spokenReminder, spokenWhenFor } from '../../reminders/spoken.js';
import { localDateTime, systemNow, type NowFn } from '../../time/clock.js';
import { getLogger } from '../../logging/logger.js';
import { INVALID_ARGS_RESULT, type ToolHandler } from './types.js';

/** Soneca sem número dito: "mais um pouquinho" vira cinco minutos. */
const DEFAULT_SNOOZE_MINUTES = 5;

/** Sem alarme tocando, dizer isso é obrigatório — pior seria confirmar um desligamento que não houve. */
const NADA_TOCANDO = { success: false, error: 'não tem nenhum alarme tocando aqui agora' };

export interface ManageRemindersDeps {
  /**
   * Referência direta, sem thunk: o ringer é construído no mesmo construtor do
   * Orchestrator, antes do registro dos handlers — diferente do
   * `ReminderScheduler`, que só nasce depois do `WsServer` inteiro.
   */
  ringer: AlarmRinger;
  store: ReminderStore;
  getScheduler: () => ReminderScheduler;
  /** Injetável para teste, mesmo padrão do resto do módulo de lembretes. */
  now?: NowFn;
}

export function createManageRemindersHandler(deps: ManageRemindersDeps): ToolHandler {
  const now = deps.now ?? systemNow;

  return async (args, ctx) => {
    if (!isManageRemindersArgs(args)) {
      getLogger().error(
        { event: 'tool_call', room_id: ctx.roomId, name: 'manage_reminders', args },
        'Tool call inválida ou desconhecida',
      );
      return INVALID_ARGS_RESULT;
    }

    getLogger().info(
      {
        event: 'tool_call',
        room_id: ctx.roomId,
        device_id: ctx.deviceId,
        name: 'manage_reminders',
        action: args.action,
        model_decision_ms: ctx.modelDecisionMs,
      },
      `manage_reminders: ${args.action} em ${ctx.roomId}`,
    );

    // `ctx.roomId` é a verdade sobre onde a coisa acontece (ADR 002): tudo aqui
    // é escopado ao cômodo da sessão, nunca a um que o modelo tenha escolhido.
    switch (args.action) {
      case 'dismiss':
        return dismiss(deps, ctx.roomId);
      case 'snooze':
        return snooze(deps, ctx.roomId, args.minutes);
      case 'list':
        return list(deps, ctx.roomId, now());
      case 'cancel':
        return cancel(deps, ctx.roomId, args, now());
    }
  };
}

function dismiss(deps: ManageRemindersDeps, roomId: string): unknown {
  const tocando = deps.ringer.ringingIn(roomId);
  if (!tocando) return NADA_TOCANDO;

  deps.ringer.dismiss(roomId, 'tool');
  return { success: true, dismissed: true, label: tocando.label };
}

function snooze(deps: ManageRemindersDeps, roomId: string, minutes: number | undefined): unknown {
  const tocando = deps.ringer.ringingIn(roomId);
  if (!tocando) return NADA_TOCANDO;

  const adiado = deps.ringer.snooze(roomId, minutes ?? DEFAULT_SNOOZE_MINUTES);
  if (!adiado.ok) return NADA_TOCANDO;

  // `minutes` é o valor DEPOIS do clamp: a confirmação falada não pode divergir
  // do que foi de fato agendado, mesma regra do `spoken_when` do set_reminder.
  return {
    success: true,
    snoozed: true,
    minutes: adiado.minutes,
    spoken_when: `daqui a ${adiado.minutes} minuto${adiado.minutes === 1 ? '' : 's'}`,
    label: tocando.label,
  };
}

function list(deps: ManageRemindersDeps, roomId: string, agora: Date): unknown {
  const vivos = deps.store.listLiveByRoom(roomId);

  if (vivos.length === 0) {
    return { success: true, count: 0, reminders: [], spoken: 'nenhum lembrete marcado aqui' };
  }

  return {
    success: true,
    count: vivos.length,
    reminders: vivos.map((r) => ({
      reminder_id: r.shortId,
      label: r.label,
      spoken_when: spokenWhenFor(r, agora),
    })),
    // Texto pronto para ser falado: sem isto o modelo remonta a lista sozinho e
    // a confirmação diverge do que está no banco.
    spoken: vivos.map((r) => spokenReminder(r, agora)).join('; '),
  };
}

function cancel(
  deps: ManageRemindersDeps,
  roomId: string,
  args: ManageRemindersArgs,
  agora: Date,
): unknown {
  const candidatos = candidatosDeCancelamento(deps, roomId, args, agora);
  if (candidatos.ok === false) return { success: false, error: candidatos.error };

  const alvo = candidatos.alvo;
  deps.store.markStatus(alvo.id, 'cancelled', agora.getTime());

  // Cancelar o que está tocando também para o toque: senão o alarme continuaria
  // em rajadas até o teto, com o registro já cancelado no banco.
  const tocando = deps.ringer.ringingIn(roomId);
  if (tocando && tocando.shortId === alvo.shortId) {
    deps.ringer.dismiss(roomId, 'tool');
  }

  deps.getScheduler().reschedule();

  getLogger().info(
    {
      event: 'reminder_cancelled',
      room_id: roomId,
      reminder_id: alvo.id,
      short_id: alvo.shortId,
    },
    `Lembrete ${alvo.shortId} cancelado em ${roomId}`,
  );

  return {
    success: true,
    cancelled: true,
    reminder_id: alvo.shortId,
    label: alvo.label,
    spoken_when: spokenWhenFor(alvo, agora),
  };
}

/**
 * Resolve de qual lembrete a pessoa está falando.
 *
 * Ambiguidade vira **pergunta falada**, nunca um chute: cancelar o alarme
 * errado é uma falha que só aparece na manhã seguinte, quando ninguém acorda.
 */
function candidatosDeCancelamento(
  deps: ManageRemindersDeps,
  roomId: string,
  args: ManageRemindersArgs,
  agora: Date,
): { ok: true; alvo: Reminder } | { ok: false; error: string } {
  if (args.reminder_id) {
    const porId = deps.store.findByShortId(roomId, args.reminder_id);
    if (!porId) return { ok: false, error: 'não achei esse lembrete aqui' };
    return { ok: true, alvo: porId };
  }

  const vivos = deps.store.listLiveByRoom(roomId);
  if (vivos.length === 0) return { ok: false, error: 'não tem nenhum lembrete marcado aqui' };

  const temFiltro = args.at_time !== undefined || args.label !== undefined;
  if (!temFiltro) {
    // Um único candidato não é ambíguo nem sem filtro: "cancela o alarme" com
    // um alarme só na sala tem leitura única.
    if (vivos.length === 1) return { ok: true, alvo: vivos[0]! };
    return { ok: false, error: `tem ${vivos.length} lembretes aqui — qual deles?` };
  }

  // Filtros combinam por E: "cancela o do remédio das 8" precisa bater nos dois.
  const filtrados = vivos.filter(
    (r) =>
      (args.at_time === undefined || bateHorario(r, args.at_time)) &&
      (args.label === undefined || bateLabel(r, args.label)),
  );

  if (filtrados.length === 0) return { ok: false, error: 'não achei nenhum lembrete assim' };
  if (filtrados.length === 1) return { ok: true, alvo: filtrados[0]! };

  return {
    ok: false,
    error: `tem mais de um: ${filtrados.map((r) => spokenReminder(r, agora)).join('; ')}. Qual?`,
  };
}

/**
 * Compara a hora de parede, não o instante: num recorrente é `local_hour` que
 * vale, e num one-shot é a hora local do próximo vencimento. "cancela o das 7"
 * tem que achar tanto "amanhã às 07:00" quanto "todo dia às 07:00".
 */
function bateHorario(reminder: Reminder, atTime: string): boolean {
  const [hora, minuto] =
    reminder.kind === 'recurring' && reminder.localHour !== null && reminder.localMinute !== null
      ? [reminder.localHour, reminder.localMinute]
      : horaLocalDe(reminder.nextDueUtc);

  const alvo = atTime.split(':');
  return hora === Number(alvo[0]) && minuto === Number(alvo[1] ?? '0');
}

function horaLocalDe(instantUtc: number): [number, number] {
  const p = localDateTime(new Date(instantUtc));
  return [p.hour, p.minute];
}

/**
 * Casamento por substring, sem acento e sem caixa: a transcrição do modelo
 * escreve "remedio" tão frequentemente quanto "remédio", e um cancelamento que
 * falha por causa de um acento é indistinguível de um bug para quem falou.
 */
function bateLabel(reminder: Reminder, label: string): boolean {
  if (!reminder.label) return false;
  const normalizar = (texto: string): string =>
    texto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();

  return normalizar(reminder.label).includes(normalizar(label));
}
