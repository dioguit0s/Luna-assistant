import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOLLOWUP_MAX_MS,
  FOLLOWUP_OPEN_DELAY_MS,
  FOLLOWUP_SILENCE_MS,
  FOLLOWUP_WINDOW_MS,
  Session,
} from './session.js';
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

  it('turno feliz: listening -> thinking -> speaking -> janela de continuação -> idle, com TTFAB', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
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
    assert.equal(session.getState(), 'listening', 'fim de turno abre a janela de continuação');
    assert.equal(session.isUplinkOpen(), false, 'uplink só reabre depois do lead do playback');

    mock.timers.tick(FOLLOWUP_OPEN_DELAY_MS);
    mock.timers.tick(FOLLOWUP_WINDOW_MS);
    assert.equal(session.getState(), 'idle', 'sem réplica, volta a exigir um novo Hey Luna');
    assert.equal(session.isUplinkOpen(), false);

    assert.deepEqual(states, ['idle', 'listening', 'thinking', 'speaking', 'listening', 'idle']);
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

  it('forceListen enquanto mudo não pré-arma o gate — desmutar ainda exige um novo wake', () => {
    const session = new Session();
    connectAuthAndWake(session);

    session.setMuted(true);
    assert.equal(session.getState(), 'idle');

    session.forceListen();
    assert.equal(session.getState(), 'idle', 'forceListen não faz nada enquanto mudo');
    assert.equal(session.isUplinkOpen(), false);

    session.setMuted(false);
    assert.equal(
      session.getState(),
      'idle',
      'desmutar não deve reabrir sozinho mesmo com um forceListen() pendurado de quando estava mudo',
    );
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

  describe('janela de continuação', () => {
    /** Turno completo terminando em speaking_end, com a janela já aberta. */
    function finishTurnAndOpenWindow(session: Session): void {
      connectAuthAndWake(session);
      session.onSpeakingStart();
      session.onAudioResponseFrame();
      session.onSpeakingEnd();
      mock.timers.tick(FOLLOWUP_OPEN_DELAY_MS);
    }

    beforeEach(() => {
      mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    });

    it('reabre o uplink sem wake só depois do atraso do playback', () => {
      const session = new Session();
      connectAuthAndWake(session);
      session.onSpeakingStart();
      session.onAudioResponseFrame();
      session.onSpeakingEnd();

      mock.timers.tick(FOLLOWUP_OPEN_DELAY_MS - 1);
      assert.equal(session.isUplinkOpen(), false);
      assert.equal(session.isFollowUpOpen(), false);

      mock.timers.tick(1);
      assert.equal(session.isUplinkOpen(), true);
      assert.equal(session.isFollowUpOpen(), true);
      assert.equal(session.getState(), 'listening');
    });

    it('fecha sem fala depois de FOLLOWUP_WINDOW_MS', () => {
      const session = new Session();
      finishTurnAndOpenWindow(session);

      mock.timers.tick(FOLLOWUP_WINDOW_MS - 1);
      assert.equal(session.isUplinkOpen(), true);

      mock.timers.tick(1);
      assert.equal(session.isUplinkOpen(), false);
      assert.equal(session.isFollowUpOpen(), false);
      assert.equal(session.getState(), 'idle');
    });

    it('fala mantém aberto; fecha após FOLLOWUP_SILENCE_MS de silêncio', () => {
      const session = new Session();
      finishTurnAndOpenWindow(session);

      mock.timers.tick(5_000);
      session.noteVoice(); // começou a responder perto do fim da janela
      mock.timers.tick(FOLLOWUP_SILENCE_MS - 1);
      assert.equal(session.isUplinkOpen(), true, 'a janela inicial não corta quem já está falando');

      session.noteVoice();
      mock.timers.tick(FOLLOWUP_SILENCE_MS - 1);
      assert.equal(session.isUplinkOpen(), true, 'cada fala adia o prazo de silêncio');

      mock.timers.tick(1);
      assert.equal(session.isUplinkOpen(), false);
      assert.equal(session.getState(), 'idle');
    });

    it('ruído contínuo não segura a janela além de FOLLOWUP_MAX_MS', () => {
      const session = new Session();
      finishTurnAndOpenWindow(session);

      for (let t = 0; t < FOLLOWUP_MAX_MS - 1_000; t += 1_000) {
        session.noteVoice();
        mock.timers.tick(1_000);
      }
      session.noteVoice();
      assert.equal(session.isUplinkOpen(), true);
      mock.timers.tick(1_000);
      assert.equal(session.isUplinkOpen(), false);
      assert.equal(session.getState(), 'idle');
    });

    it('sidecar caindo durante a abertura não abre o uplink', () => {
      const session = new Session();
      connectAuthAndWake(session);
      session.onSpeakingStart();
      session.onAudioResponseFrame();
      session.onSpeakingEnd();

      session.setSidecarHealthy(false);
      mock.timers.tick(FOLLOWUP_OPEN_DELAY_MS);
      assert.equal(session.isUplinkOpen(), false);
      assert.equal(session.getState(), 'error');
    });

    it('speaking_end atrasado após barge-in não fecha o gate do wake', () => {
      const session = new Session();
      connectAuthAndWake(session);
      session.onSpeakingStart();
      session.onAudioResponseFrame();
      session.onWakeDetected(); // barge-in: usuário começa um comando novo

      session.onSpeakingEnd(); // do turno interrompido
      assert.equal(session.isUplinkOpen(), true, 'o comando em andamento não pode perder áudio');
      assert.equal(session.getState(), 'listening');
    });

    it('noteVoice fora da janela não abre nada', () => {
      const session = new Session();
      connectAndAuth(session);
      session.noteVoice();
      assert.equal(session.isUplinkOpen(), false);
      assert.equal(session.getState(), 'idle');
    });

    it('speaking_start encerra a janela e o próximo speaking_end abre outra', () => {
      const session = new Session();
      finishTurnAndOpenWindow(session);
      session.noteVoice();

      session.onSpeakingStart();
      assert.equal(session.getState(), 'thinking');
      assert.equal(session.isUplinkOpen(), false);
      assert.equal(session.isFollowUpOpen(), false);

      // O timer de silêncio não pode vazar para o turno novo.
      mock.timers.tick(FOLLOWUP_SILENCE_MS);
      assert.equal(session.getState(), 'thinking');

      session.onAudioResponseFrame();
      session.onSpeakingEnd();
      mock.timers.tick(FOLLOWUP_OPEN_DELAY_MS);
      assert.equal(session.isUplinkOpen(), true);
    });

    it('não abre com o app mudo', () => {
      const session = new Session();
      connectAuthAndWake(session);
      session.onSpeakingStart();
      session.onAudioResponseFrame();
      session.setMuted(true);
      session.onSpeakingEnd();

      mock.timers.tick(FOLLOWUP_OPEN_DELAY_MS);
      assert.equal(session.isUplinkOpen(), false);
      assert.equal(session.getState(), 'idle');
    });

    it('mutar durante a janela fecha e desmutar não reabre', () => {
      const session = new Session();
      finishTurnAndOpenWindow(session);

      session.setMuted(true);
      assert.equal(session.isUplinkOpen(), false);
      session.setMuted(false);
      assert.equal(session.isUplinkOpen(), false);
      assert.equal(session.getState(), 'idle');
    });

    it('watchdog não abre a janela (falha não é fim de resposta)', () => {
      const session = new Session();
      connectAuthAndWake(session);
      session.onSpeakingStart();
      session.onAudioResponseFrame();

      mock.timers.tick(5_000); // watchdog de speaking
      assert.equal(session.getState(), 'idle');
      mock.timers.tick(FOLLOWUP_OPEN_DELAY_MS);
      assert.equal(session.isUplinkOpen(), false);
    });

    it('desconectar durante a abertura cancela a janela', () => {
      const session = new Session();
      connectAuthAndWake(session);
      session.onSpeakingStart();
      session.onAudioResponseFrame();
      session.onSpeakingEnd();

      session.onDisconnected();
      session.onAuthOk();
      mock.timers.tick(FOLLOWUP_OPEN_DELAY_MS);
      assert.equal(session.isUplinkOpen(), false);
      assert.equal(session.getState(), 'idle');
    });

    it('wake durante a janela vira gate normal, sem prazo', () => {
      const session = new Session();
      finishTurnAndOpenWindow(session);

      session.onWakeDetected();
      assert.equal(session.isFollowUpOpen(), false);
      mock.timers.tick(FOLLOWUP_WINDOW_MS);
      mock.timers.tick(FOLLOWUP_SILENCE_MS);
      assert.equal(session.isUplinkOpen(), true);
      assert.equal(session.getState(), 'listening');
    });
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
