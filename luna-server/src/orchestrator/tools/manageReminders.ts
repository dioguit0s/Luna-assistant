import type { AlarmRinger } from '../../reminders/AlarmRinger.js';
import { isManageRemindersArgs } from '../../reminders/tools.js';
import { getLogger } from '../../logging/logger.js';
import { INVALID_ARGS_RESULT, type ToolHandler } from './types.js';

/** Soneca sem número dito: "mais um pouquinho" vira cinco minutos. */
const DEFAULT_SNOOZE_MINUTES = 5;

export interface ManageRemindersDeps {
  /**
   * Referência direta, sem thunk: o ringer é construído no mesmo construtor do
   * Orchestrator, antes do registro dos handlers — diferente do
   * `ReminderScheduler`, que só nasce depois do `WsServer` inteiro.
   */
  ringer: AlarmRinger;
}

export function createManageRemindersHandler(deps: ManageRemindersDeps): ToolHandler {
  return async (args, ctx) => {
    if (!isManageRemindersArgs(args)) {
      getLogger().error(
        { event: 'tool_call', room_id: ctx.roomId, name: 'manage_reminders', args },
        'Tool call inválida ou desconhecida',
      );
      return INVALID_ARGS_RESULT;
    }

    // `ctx.roomId` é a verdade sobre onde a coisa acontece (ADR 002): o alarme
    // que se dispensa é o que está tocando aqui, não um que o modelo escolheu.
    const tocando = deps.ringer.ringingIn(ctx.roomId);
    if (!tocando) {
      // Mensagem escrita para ser falada, mesmo padrão de `control_device` para
      // dispositivo não encontrado — e é importante que a Luna diga que não
      // havia nada tocando em vez de confirmar um desligamento que não houve.
      return { success: false, error: 'não tem nenhum alarme tocando aqui agora' };
    }

    getLogger().info(
      {
        event: 'tool_call',
        room_id: ctx.roomId,
        device_id: ctx.deviceId,
        name: 'manage_reminders',
        action: args.action,
        short_id: tocando.shortId,
        model_decision_ms: ctx.modelDecisionMs,
      },
      `Alarme ${tocando.shortId}: ${args.action}`,
    );

    if (args.action === 'dismiss') {
      deps.ringer.dismiss(ctx.roomId, 'tool');
      return { success: true, dismissed: true, label: tocando.label };
    }

    const adiado = deps.ringer.snooze(ctx.roomId, args.minutes ?? DEFAULT_SNOOZE_MINUTES);
    if (!adiado.ok) {
      return { success: false, error: 'não tem nenhum alarme tocando aqui agora' };
    }

    // `minutes` é o valor DEPOIS do clamp: a confirmação falada não pode
    // divergir do que foi de fato agendado, mesma regra do `spoken_when` do
    // `set_reminder`.
    return {
      success: true,
      snoozed: true,
      minutes: adiado.minutes,
      spoken_when: `daqui a ${adiado.minutes} minuto${adiado.minutes === 1 ? '' : 's'}`,
      label: tocando.label,
    };
  };
}
