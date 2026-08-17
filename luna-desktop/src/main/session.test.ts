import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { Session } from './session.js';
import type { AppState } from './state.js';

function connectAndAuth(session: Session): void {
  session.onConnecting();
  session.onAuthOk();
}

describe('Session', () => {
  afterEach(() => {
    mock.timers.reset();
  });

  it('começa em erro (desconectado) antes de qualquer evento', () => {
    const session = new Session();
    assert.equal(session.getState(), 'error');
    assert.equal(session.isUplinkOpen(), false);
  });

  it('turno feliz: listening -> thinking -> speaking -> listening, com TTFAB', () => {
    const session = new Session();
    const states: AppState[] = [];
    session.on('stateChanged', (s) => states.push(s));
    let ttfabMs: number | null = null;
    session.on('ttfab', (info) => (ttfabMs = info.sinceSpeakingStartMs));

    connectAndAuth(session);
    assert.equal(session.getState(), 'listening');
    assert.equal(session.isUplinkOpen(), true);

    session.onSpeakingStart();
    assert.equal(session.getState(), 'thinking');
    assert.equal(session.isUplinkOpen(), false, 'uplink fecha assim que o turno começa');

    const played = session.onAudioResponseFrame();
    assert.equal(played, true);
    assert.equal(session.getState(), 'speaking');
    assert.ok(ttfabMs !== null && ttfabMs >= 0, 'TTFAB deveria ter sido emitido');

    // Chunks subsequentes do mesmo turno continuam tocando e não reemitem TTFAB.
    ttfabMs = null;
    assert.equal(session.onAudioResponseFrame(), true);
    assert.equal(ttfabMs, null);

    session.onSpeakingEnd();
    assert.equal(session.getState(), 'listening');
    assert.equal(session.isUplinkOpen(), true);

    assert.deepEqual(states, ['listening', 'thinking', 'speaking', 'listening']);
  });

  it('watchdog de thinking: sem áudio por 15s volta a ouvir sozinho', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const session = new Session();
    let flushed = false;
    session.on('flushPlayback', () => (flushed = true));

    connectAndAuth(session);
    session.onSpeakingStart();
    assert.equal(session.getState(), 'thinking');

    mock.timers.tick(14_999);
    assert.equal(session.getState(), 'thinking', 'não deveria disparar antes do prazo');

    mock.timers.tick(1);
    assert.equal(session.getState(), 'listening');
    assert.equal(session.isUplinkOpen(), true);
    assert.equal(flushed, true);
  });

  it('watchdog de speaking: sem chunk novo por 5s volta a ouvir sozinho', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const session = new Session();

    connectAndAuth(session);
    session.onSpeakingStart();
    session.onAudioResponseFrame();
    assert.equal(session.getState(), 'speaking');

    mock.timers.tick(4_999);
    assert.equal(session.getState(), 'speaking');

    mock.timers.tick(1);
    assert.equal(session.getState(), 'listening');
  });

  it('watchdog de speaking é adiado por cada chunk novo (não expira enquanto a resposta continua)', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const session = new Session();

    connectAndAuth(session);
    session.onSpeakingStart();
    session.onAudioResponseFrame();

    mock.timers.tick(4_000);
    session.onAudioResponseFrame(); // rearma o watchdog
    mock.timers.tick(4_000);
    assert.equal(session.getState(), 'speaking', 'ainda dentro dos 5s desde o último chunk');

    mock.timers.tick(1_000);
    assert.equal(session.getState(), 'listening');
  });

  it('forceListen interrompe o turno e descarta frames em trânsito até o próximo speaking_start', () => {
    const session = new Session();
    let flushed = false;
    session.on('flushPlayback', () => (flushed = true));

    connectAndAuth(session);
    session.onSpeakingStart();
    session.onAudioResponseFrame();
    assert.equal(session.getState(), 'speaking');

    session.forceListen();
    assert.equal(session.getState(), 'listening');
    assert.equal(session.isUplinkOpen(), true);
    assert.equal(flushed, true);

    // Frames que já estavam a caminho do servidor não devem tocar.
    assert.equal(session.onAudioResponseFrame(), false);
    assert.equal(session.getState(), 'listening');

    // O próximo turno de verdade volta a funcionar normalmente.
    session.onSpeakingStart();
    assert.equal(session.onAudioResponseFrame(), true);
    assert.equal(session.getState(), 'speaking');
  });

  it('forceListen é um no-op quando não há turno em andamento', () => {
    const session = new Session();
    let flushed = false;
    session.on('flushPlayback', () => (flushed = true));

    connectAndAuth(session);
    session.forceListen();
    assert.equal(flushed, false);
    assert.equal(session.getState(), 'listening');
  });

  it('setMuted fecha o uplink e vai para idle; desmutar retoma listening', () => {
    const session = new Session();
    connectAndAuth(session);

    session.setMuted(true);
    assert.equal(session.getState(), 'idle');
    assert.equal(session.isUplinkOpen(), false);
    assert.equal(session.isMuted(), true);

    session.setMuted(false);
    assert.equal(session.getState(), 'listening');
    assert.equal(session.isUplinkOpen(), true);
  });

  it('mutar durante um turno em andamento não interrompe a resposta; só some depois do speaking_end', () => {
    const session = new Session();
    connectAndAuth(session);
    session.onSpeakingStart();
    session.onAudioResponseFrame();
    assert.equal(session.getState(), 'speaking');

    session.setMuted(true);
    assert.equal(session.getState(), 'speaking', 'turno em andamento não é cortado pelo mute');

    session.onSpeakingEnd();
    assert.equal(session.getState(), 'idle', 'volta para idle (mudo), não listening');
    assert.equal(session.isUplinkOpen(), false);
  });

  it('onDisconnected zera o turno e volta para erro', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const session = new Session();
    connectAndAuth(session);
    session.onSpeakingStart();

    session.onDisconnected();
    assert.equal(session.getState(), 'error');
    assert.equal(session.isUplinkOpen(), false);

    // O watchdog de thinking não deveria mais disparar depois de resetado.
    let flushed = false;
    session.on('flushPlayback', () => (flushed = true));
    mock.timers.tick(20_000);
    assert.equal(flushed, false);
  });
});
