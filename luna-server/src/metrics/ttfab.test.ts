import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TtfabTracker } from './ttfab.js';

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* espera ativa: o tracker usa performance.now(), não timers */
  }
}

describe('TtfabTracker', () => {
  it('não move a âncora a cada chunk de áudio', () => {
    // Regressão do bug que mascarava o atraso real: em open-mic o satélite
    // streama contínuo e cada chunk reancorava a medição em "agora",
    // produzindo TTFAB de poucos ms num sistema lento.
    const tracker = new TtfabTracker();

    tracker.markClientAudioReceived();
    busyWait(30);
    tracker.markClientAudioReceived();

    const latency = tracker.markFirstResponseSent();
    assert.ok(latency !== null && latency >= 25, `esperava >= 25ms, veio ${latency}`);
  });

  it('reancora no último sinal de fala do usuário', () => {
    const tracker = new TtfabTracker();

    tracker.markClientAudioReceived();
    busyWait(30);
    tracker.markUserSpeech(); // usuário ainda falava agora

    const latency = tracker.markFirstResponseSent();
    assert.ok(latency !== null && latency < 25, `esperava < 25ms, veio ${latency}`);
  });

  it('loga a latência só uma vez por turno', () => {
    const tracker = new TtfabTracker();

    tracker.markUserSpeech();
    assert.notEqual(tracker.markFirstResponseSent(), null);
    assert.equal(tracker.markFirstResponseSent(), null);
  });

  it('não mede nada antes do primeiro áudio do turno', () => {
    const tracker = new TtfabTracker();
    assert.equal(tracker.markFirstResponseSent(), null);
    assert.equal(tracker.elapsedSinceAnchor(), null);
  });

  it('elapsedSinceAnchor não consome o marco', () => {
    const tracker = new TtfabTracker();

    tracker.markUserSpeech();
    assert.notEqual(tracker.elapsedSinceAnchor(), null);
    assert.notEqual(tracker.markFirstResponseSent(), null);
  });

  it('reset volta ao estado sem âncora', () => {
    const tracker = new TtfabTracker();

    tracker.markUserSpeech();
    tracker.reset();
    assert.equal(tracker.elapsedSinceAnchor(), null);
  });
});
