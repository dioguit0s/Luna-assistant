import { localDateTime, type LocalDateTime } from '../time/clock.js';
import { WEEKDAY_LABEL_PT } from './resolveOnce.js';
import { spokenRule } from './recurrence.js';
import type { Reminder } from './ReminderStore.js';

/**
 * Como um lembrete é dito em voz alta.
 *
 * Ponto único de propósito: a confirmação do `set_reminder` e a listagem do
 * `manage_reminders` não podem divergir. Um alarme confirmado como "amanhã às
 * sete" que aparece na lista como outra coisa destrói a confiança na Luna mais
 * rápido que um alarme que não toca.
 */

const MES_PT: Record<number, string> = {
  1: 'janeiro',
  2: 'fevereiro',
  3: 'março',
  4: 'abril',
  5: 'maio',
  6: 'junho',
  7: 'julho',
  8: 'agosto',
  9: 'setembro',
  10: 'outubro',
  11: 'novembro',
  12: 'dezembro',
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function horaLocal(p: LocalDateTime): string {
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Dias de calendário entre duas datas locais — não horas corridas. */
function diasDeDiferenca(de: LocalDateTime, para: LocalDateTime): number {
  const inicio = Date.UTC(de.year, de.month - 1, de.day);
  const fim = Date.UTC(para.year, para.month - 1, para.day);
  return Math.round((fim - inicio) / (24 * 60 * 60 * 1000));
}

/** "hoje às 20:00", "amanhã às 06:30", "sexta às 20:00", "dia 12 de setembro às 09:00". */
export function spokenInstant(instantUtc: number, now: Date): string {
  const alvo = localDateTime(new Date(instantUtc));
  const hoje = localDateTime(now);
  const dias = diasDeDiferenca(hoje, alvo);
  const hora = horaLocal(alvo);

  if (dias === 0) return `hoje às ${hora}`;
  if (dias === 1) return `amanhã às ${hora}`;
  if (dias > 1 && dias < 7) return `${WEEKDAY_LABEL_PT[alvo.weekday]} às ${hora}`;

  return `dia ${alvo.day} de ${MES_PT[alvo.month]} às ${hora}`;
}

/**
 * Num recorrente o que se diz é a **regra**, não a próxima ocorrência: quem
 * marcou "todo dia útil às 6:30" espera ouvir isso de volta, não "amanhã às
 * 06:30".
 */
export function spokenWhenFor(reminder: Reminder, now: Date): string {
  if (
    reminder.kind === 'recurring' &&
    reminder.repeatRule !== null &&
    reminder.localHour !== null &&
    reminder.localMinute !== null
  ) {
    return `${spokenRule(reminder.repeatRule)} às ${pad(reminder.localHour)}:${pad(reminder.localMinute)}`;
  }

  return spokenInstant(reminder.nextDueUtc, now);
}

/** Uma linha da listagem: "tomar o remédio, hoje às 20:00" ou só o horário. */
export function spokenReminder(reminder: Reminder, now: Date): string {
  const quando = spokenWhenFor(reminder, now);
  return reminder.label ? `${reminder.label}, ${quando}` : quando;
}
