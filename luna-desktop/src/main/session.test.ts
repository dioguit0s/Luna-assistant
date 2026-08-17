import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { Session } from './session.js';
import type { AppState } from './state.js';

function connectAndAuth(session: Session): void {
  session.onConnecting();
  session.onAuthOk();
}

/** Conecta, autentica e simula um "Hey Luna" — o estado que a maioria dos
 * testes de turno assumia implicitamente antes do gate de wake word (M4). */
function connectAuthAndWake(session: Session): void {
  connectAndAuth(session);
  session.onWakeDetected();
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

  it('recém-conectado fica em idle aguardando wake, não listening', () => {
    const session = new Session();
    connectAndAuth(session);
    assert.equal(session.getState(), 'idle');
    assert.equal(session.isUplinkOpen(), false);
  });

  it('onWakeDetected abre o uplink a partir do repouso', () => {
    const session = new Session();
    const states: AppState[] = [];
    session.on('stateChanged', (s) => states.push(s));

    connectAndAuth(session);
    session.onWakeDetected();

    assert.equal(session.getState(), 'listening');
    assert.equal(session.isUplinkOpen(), true);
    assert.deepEqual(states, ['idle', 'listening']);
  });

  it('turno feliz: listening -> thinking -> speaking -> idle (aguardando novo wake), com TTFAB', () => {
    const session = new Session();
    const states: AppState[] = [];
    session.on('stateChanged', (s) => states.push(s));
    let ttfabMs: number | null = null;
    session.on('ttfab', (info) => (ttfabMs = info.sinceSpeakingStartMs));

    connectAuthAndWake(session);
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
    assert.equal(session.getState(), 'idle', 'fim de turno volta a exigir um novo Hey Luna');
    assert.equal(session.isUplinkOpen(), false);

    assert.deepEqual(states, ['idle', 'listening', 'thinking', 'speaking', 'idle']);
  });

  it('onWakeDetected durante um turno em andamento interrompe (barge-in) e mantém o uplink aberto depois', () => {
    const session = new Session();
    let flushed = false;
    session.on('flushPlayback', () => (flushed = true));

    connectAuthAndWake(session);
    session.onSpeakingStart();
    session.onAudioResponseFrame();
    assert.equal(session.getState(), 'speaking');

    session.onWakeDetected();
    assert.equal(session.getState(), 'listening');
    assert.equal(session.isUplinkOpen(), true);
    assert.equal(flushed, true);

    // Frames que já estavam a caminho do servidor não devem tocar.
    assert.equal(session.onAudioResponseFrame(), false);
    assert.equal(session.getState(), 'listening');
  });

  it('watchdog de thinking: sem áudio por 15s volta a idle (precisa de novo wake)', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const session = new Session();
    let flushed = false;
    session.on('flushPlayback', () => (flushed = true));

    connectAuthAndWake(session);
    session.onSpeakingStart();
    assert.equal(session.getState(), 'thinking');

    mock.timers.tick(14_999);
    assert.equal(session.getState(), 'thinking', 'não deveria disparar antes do prazo');

    mock.timers.tick(1);
    assert.equal(session.getState(), 'idle');
    assert.equal(session.isUplinkOpen(), false, 'precisa de um novo wake pra reabrir');
    assert.equal(flushed, true);

    session.onWakeDetected();
    assert.equal(session.getState(), 'listening');
    assert.equal(session.isUplinkOpen(), true);
  });

  it('watchdog de speaking: sem chunk novo por 5s volta a idle (precisa de novo wake)', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const session = new Session();

    connectAuthAndWake(session);
    session.onSpeakingStart();
    session.onAudioResponseFrame();
    assert.equal(session.getState(), 'speaking');

    mock.timers.tick(4_999);
    assert.equal(session.getState(), 'speaking');

    mock.timers.tick(1);
    assert.equal(session.getState(), 'idle');
    assert.equal(session.isUplinkOpen(), false);
  });

  it('watchdog de speaking é adiado por cada chunk novo (não expira enquanto a resposta continua)', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const session = new Session();

    connectAuthAndWake(session);
    session.onSpeakingStart();
    session.onAudioResponseFrame();

    mock.timers.tick(4_000);
    session.onAudioResponseFrame(); // rearma o watchdog
    mock.timers.tick(4_000);
    assert.equal(session.getState(), 'speaking', 'ainda dentro dos 5s desde o último chunk');

    mock.timers.tick(1_000);
    assert.equal(session.getState(), 'idle');
  });

  it('forceListen interrompe o turno e descarta frames em trânsito até o próximo speaking_start', () => {
    const session = new Session();
    let flushed = false;
    session.on('flushPlayback', () => (flushed = true));

    connectAuthAndWake(session);
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

  it('forceListen abre o gate mesmo em repouso (não é mais no-op sem turno ativo)', () => {
    const session = new Session();
    let flushed = false;
    session.on('flushPlayback', () => (flushed = true));

    connectAndAuth(session);
    assert.equal(session.getState(), 'idle');

    session.forceListen();
    assert.equal(flushed, false, 'nada em andamento para interromper — só abre o gate');
    assert.equal(session.getState(), 'listening');
    assert.equal(session.isUplinkOpen(), true);
  });

  it('setMuted fecha o uplink e vai para idle; desmutar não reabre sozinho, precisa de novo wake', () => {
    const session = new Session();
    connectAuthAndWake(session);

    session.setMuted(true);
    assert.equal(session.getState(), 'idle');
    assert.equal(session.isUplinkOpen(), false);
    assert.equal(session.isMuted(), true);

    session.setMuted(false);
    assert.equal(session.getState(), 'idle', 'desmutar sozinho não é um wake');
    assert.equal(session.isUplinkOpen(), false);

    session.onWakeDetected();
    assert.equal(session.getState(), 'listening');
    assert.equal(session.isUplinkOpen(), true);
  });

  it('mutar durante um turno em andamento não interrompe a resposta; só some depois do speaking_end', () => {
    const session = new Session();
    connectAuthAndWake(session);
    session.onSpeakingStart();
    session.onAudioResponseFrame();
    assert.equal(session.getState(), 'speaking');

    session.setMuted(true);
    assert.equal(session.getState(), 'speaking', 'turno em andamento não é cortado pelo mute');

    session.onSpeakingEnd();
    assert.equal(session.getState(), 'idle', 'volta para idle (mudo), não listening');
    assert.equal(session.isUplinkOpen(), false);
  });

  it('setSidecarHealthy(false) força erro em repouso e restaura o estado anterior ao voltar', () => {
    const session = new Session();
    connectAndAuth(session);
    assert.equal(session.getState(), 'idle', 'aguardando wake');

    session.setSidecarHealthy(false);
    assert.equal(session.getState(), 'error');
    assert.equal(session.isUplinkOpen(), false);

    session.setSidecarHealthy(true);
    assert.equal(session.getState(), 'idle', 'ainda aguardando wake, não muda sozinho');

    session.onWakeDetected();
    assert.equal(session.getState(), 'listening');

    session.setSidecarHealthy(false);
    assert.equal(session.getState(), 'error');
    session.setSidecarHealthy(true);
    assert.equal(session.getState(), 'listening', 'já tinha passado do wake — recompute não exige um novo');
  });

  it('setSidecarHealthy(false) não interrompe um turno em thinking/speaking', () => {
    const session = new Session();
    connectAuthAndWake(session);
    session.onSpeakingStart();
    session.onAudioResponseFrame();
    assert.equal(session.getState(), 'speaking');

    session.setSidecarHealthy(false);
    assert.equal(session.getState(), 'speaking', 'sidecar caindo no meio de uma resposta não a corta');

    session.onSpeakingEnd();
    assert.equal(session.getState(), 'error', 'fim do turno revela o sidecar não saudável');
  });

  it('onDisconnected zera o turno e volta para erro', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const session = new Session();
    connectAuthAndWake(session);
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
