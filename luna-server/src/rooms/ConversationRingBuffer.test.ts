import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRingBuffer } from './ConversationRingBuffer.js';

describe('ConversationRingBuffer', () => {
  it('mantém no máximo 10 turnos (20 mensagens)', () => {
    const buffer = new ConversationRingBuffer();
    try {
      for (let i = 0; i < 15; i++) {
        buffer.appendTurn('sala', `user-${i}`, `assistant-${i}`);
      }
      const history = buffer.getHistory('sala');
      assert.equal(history.length, 20);
      assert.equal(history[0]?.text, 'user-5');
    } finally {
      buffer.destroy();
    }
  });

  it('expira sala após TTL de 5 minutos', () => {
    const buffer = new ConversationRingBuffer();
    try {
      buffer.appendTurn('sala', 'oi', 'olá');
      const state = buffer as unknown as {
        rooms: Map<string, { lastActivity: number }>;
      };
      const room = state.rooms.get('sala');
      assert.ok(room);
      room.lastActivity = Date.now() - 5 * 60 * 1000 - 1;
      assert.equal(buffer.getHistory('sala').length, 0);
    } finally {
      buffer.destroy();
    }
  });

  it('touch atualiza lastActivity', () => {
    const buffer = new ConversationRingBuffer();
    try {
      buffer.appendTurn('sala', 'teste', 'ok');
      const state = buffer as unknown as {
        rooms: Map<string, { lastActivity: number }>;
      };
      const before = state.rooms.get('sala')!.lastActivity;
      buffer.touch('sala');
      const after = state.rooms.get('sala')!.lastActivity;
      assert.ok(after >= before);
    } finally {
      buffer.destroy();
    }
  });
});
