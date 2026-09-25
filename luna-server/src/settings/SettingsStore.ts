import type { DatabaseSync } from 'node:sqlite';

/**
 * Wrapper da tabela `settings`: um documento JSON por grupo de configuração
 * de runtime (ADR 010, decisão 3). Mesmo banco do `ReminderStore` — o schema
 * nasce na lista de migrações dele, e este wrapper só lê e grava.
 *
 * Sem validação aqui: quem grava é o `RuntimeSettings`, que valida antes. Este
 * módulo é o único ponto de SQL da configuração, como o `ReminderStore` é o dos
 * lembretes.
 */
export class SettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  /** `undefined` quando o grupo nunca foi gravado — é o sinal de semear. */
  get(group: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE grp = ?').get(group) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch (err) {
      // JSON corrompido no banco não pode virar configuração vazia em silêncio:
      // para o HA, isso seria "desligar a automação" sem ninguém ter pedido.
      throw new Error(
        `Configuração "${group}" corrompida no banco: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  set(group: string, value: unknown, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO settings (grp, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(grp) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(group, JSON.stringify(value), now);
  }

  updatedAt(group: string): number | null {
    const row = this.db.prepare('SELECT updated_at FROM settings WHERE grp = ?').get(group) as
      | { updated_at: number }
      | undefined;
    return row ? Number(row.updated_at) : null;
  }
}
