import type { CompassoItem } from './CompassoClient.js';
import { cleanText } from './CompassoClient.js';
import { spokenDate, splitIso } from './dates.js';

/**
 * Como um item do Compasso chega ao modelo: já em palavras, com a hora de
 * parede e o dia ditos do jeito que a Luna vai falar. O modelo não converte
 * ISO nem calcula "que dia da semana é 26" — é o mesmo motivo de o
 * `set_reminder` devolver `spoken_when`: a fala nunca diverge do dado.
 *
 * Só campos que se falam. `id` só em tarefa, que é o único item que a Luna
 * consegue alterar (concluir); expor o id de evento convidaria "apaga esse".
 */

const TYPE_LABEL: Record<CompassoItem['type'], string> = {
  event: 'compromisso',
  class: 'aula',
  task: 'tarefa',
};

export interface SpokenItem {
  type: string;
  title: string;
  /** "sexta", "amanhã", "dia 3 de outubro" — omitido se o período é um dia só e o item cai nele. */
  day?: string;
  /** "08:00 às 10:00", "dia inteiro", "até 23:59", "sem prazo". */
  time: string;
  room?: string;
  professor?: string;
  cancelled?: true;
  done?: boolean;
  task_id?: string;
  occurrence_date?: string;
}

/**
 * `withDay`: o período consultado tem mais de um dia, então cada item diz o
 * seu. Num período de um dia, o dia vai uma vez só no topo do resultado.
 */
export function describeItem(item: CompassoItem, now: Date, withDay: boolean): SpokenItem {
  const start = item.start ? splitIso(item.start) : null;
  const end = item.end ? splitIso(item.end) : null;

  const out: SpokenItem = {
    type: TYPE_LABEL[item.type] ?? 'item',
    title: cleanText(item.title) || 'sem título',
    time: describeTime(item, start, end, now),
  };

  // Tarefa se situa pelo prazo: o contrato repete `due` em `start`, mas não
  // custa não depender disso.
  const anchor = item.type === 'task' && item.due ? splitIso(item.due) : start;
  if (withDay && anchor) out.day = spokenDate(anchor.date, now);

  if (item.type === 'class') {
    const room = cleanText(item.location, 60);
    const professor = cleanText(item.professor, 80);
    if (room) out.room = room;
    if (professor) out.professor = professor;
    // Aula cancelada aparece e é dita como cancelada: omitir faria a pessoa ir
    // à faculdade à toa ou achar que a Luna esqueceu a aula.
    if (item.cancelled) out.cancelled = true;
  }

  if (item.type === 'task') {
    out.done = item.done === true;
    out.task_id = item.id;
    if (item.recurring && item.occurrence_date) out.occurrence_date = item.occurrence_date;
  }

  return out;
}

function describeTime(
  item: CompassoItem,
  start: { date: string; time: string | null } | null,
  end: { date: string; time: string | null } | null,
  now: Date,
): string {
  if (item.type === 'task') {
    const due = item.due ? splitIso(item.due) : null;
    if (!due) return 'sem prazo';
    return due.time ? `até ${due.time}` : 'até o fim do dia';
  }

  if (item.all_day || !start?.time) {
    // `end` de dia inteiro é o último dia, inclusivo (contrato do Compasso).
    if (start && end && end.date !== start.date) {
      return `dia inteiro, de ${spokenDate(start.date, now)} até ${spokenDate(end.date, now)}`;
    }
    return 'dia inteiro';
  }

  if (end?.time) {
    return end.date === start.date
      ? `${start.time} às ${end.time}`
      : `${start.time} até ${spokenDate(end.date, now)} às ${end.time}`;
  }
  return start.time;
}
