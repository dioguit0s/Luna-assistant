// Notificação do Windows quando um lembrete toca neste computador (painel v2,
// "Este computador"). O satélite desktop não recebe evento de lembrete pelo
// WebSocket — só o áudio do toque —, e criar um mudaria o contrato das quatro
// cópias do protocolo. Então o processo principal pergunta à API admin, que
// ele já usa para o painel: `GET reminders` a cada POLL_MS, e avisa quando um
// lembrete da sala deste computador passa a `ringing`.
//
// Módulo puro (sem `electron`): testável com `node --test` e um AdminClient
// com fetch falso.

import type { AdminClient } from './admin/client.js';

export const POLL_MS = 10_000;

interface ReminderWire {
  id: number;
  room_id: string;
  label: string | null;
  status: string;
  next_due_utc: number;
  spoken?: string;
}

export class ReminderNotifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** `id:next_due_utc` já notificados — o recorrente toca de novo amanhã com outra chave. */
  private readonly notified = new Set<string>();
  private inFlight = false;

  constructor(
    private readonly admin: AdminClient,
    private readonly roomId: () => string,
    private readonly notify: (title: string, body: string) => void,
    private readonly enabled: () => boolean,
    private readonly pollMs = POLL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma rodada. Público para teste. Nunca lança: servidor fora é só "nada a avisar". */
  async poll(): Promise<void> {
    if (this.inFlight || !this.enabled()) return;
    this.inFlight = true;
    try {
      const result = await this.admin.request('GET', 'reminders');
      if (!result.ok) return;
      const raw = (result.body as { reminders?: unknown })?.reminders;
      // Resposta de outra coisa (proxy, versão diferente do servidor): nada a avisar.
      if (!Array.isArray(raw)) return;
      const reminders = raw as ReminderWire[];
      const room = this.roomId();
      const live = new Set<string>();
      for (const r of reminders) {
        const key = `${r.id}:${r.next_due_utc}`;
        live.add(key);
        if (r.status !== 'ringing' || r.room_id !== room || this.notified.has(key)) continue;
        this.notified.add(key);
        this.notify(r.label ? `Luna — ${r.label}` : 'Luna — alarme', r.spoken ? capitalize(r.spoken) : 'Tocando agora.');
      }
      // Esquece o que já não existe, para o conjunto não crescer sem fim.
      for (const key of this.notified) if (!live.has(key)) this.notified.delete(key);
    } catch (err) {
      console.warn(`[luna-desktop] notificador de lembretes: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight = false;
    }
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
