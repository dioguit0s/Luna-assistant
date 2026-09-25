import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AdminClient } from './admin/client.js';
import { ReminderNotifier } from './reminder-notifier.js';

function adminWith(bodies: unknown[]): AdminClient {
  let i = 0;
  return new AdminClient(
    () => ({ serverUrl: 'ws://192.168.0.20:8080', adminToken: 'tok' }),
    (async () => new Response(JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]), { status: 200 })) as unknown as typeof fetch,
  );
}

const ringing = (over: object = {}) => ({ id: 1, room_id: 'desktop_diogo', label: 'remédio', status: 'ringing', next_due_utc: 1000, spoken: 'agora: remédio', ...over });

describe('ReminderNotifier', () => {
  it('avisa uma vez por toque, só da sala deste computador', async () => {
    const shown: string[] = [];
    const admin = adminWith([
      { reminders: [ringing(), ringing({ id: 2, room_id: 'quarto' })] },
      { reminders: [ringing()] },
      { reminders: [ringing({ next_due_utc: 2000 })] },
    ]);
    const n = new ReminderNotifier(admin, () => 'desktop_diogo', (t) => shown.push(t), () => true);
    await n.poll();
    await n.poll();
    assert.deepEqual(shown, ['Luna — remédio'], 'repetiu ou avisou outra sala');
    // Recorrente: toque seguinte tem outro next_due_utc e avisa de novo.
    await n.poll();
    assert.equal(shown.length, 2);
  });

  it('desligado não consulta; servidor fora não lança', async () => {
    let calls = 0;
    const admin = new AdminClient(
      () => ({ serverUrl: 'ws://192.168.0.20:8080', adminToken: 'tok' }),
      (async () => {
        calls += 1;
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    );
    let on = false;
    const n = new ReminderNotifier(admin, () => 'desktop_diogo', () => assert.fail('não devia avisar'), () => on);
    await n.poll();
    assert.equal(calls, 0);
    on = true;
    await n.poll();
    assert.equal(calls, 1);
  });

  it('alarme sem rótulo tem título genérico', async () => {
    const shown: string[] = [];
    const n = new ReminderNotifier(adminWith([{ reminders: [ringing({ label: null })] }]), () => 'desktop_diogo', (t) => shown.push(t), () => true);
    await n.poll();
    assert.deepEqual(shown, ['Luna — alarme']);
  });
});
