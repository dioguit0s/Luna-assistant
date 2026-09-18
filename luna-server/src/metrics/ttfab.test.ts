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

    const sample = tracker.markFirstResponseSent();
    assert.ok(sample !== null && sample.latencyMs >= 25, `esperava >= 25ms, veio ${sample?.latencyMs}`);
  });

  it('reancora no último sinal de fala do usuário', () => {
    const tracker = new TtfabTracker();

    tracker.markClientAudioReceived();
    busyWait(30);
    tracker.markUserSpeech(); // usuário ainda falava agora

    const sample = tracker.markFirstResponseSent();
    assert.ok(sample !== null && sample.latencyMs < 25, `esperava < 25ms, veio ${sample?.latencyMs}`);
  });

  it('o limite superior não é descontado pela transcrição', () => {
    // O ponto do intervalo: `latencyMs` é reancorado pela transcrição e some,
    // `sinceTurnStartMs` continua contando desde o começo do turno. Um relatório
    // que mostrasse só o de baixo esconderia os 30ms de espera real.
    const tracker = new TtfabTracker();

    tracker.markClientAudioReceived();
    busyWait(30);
    tracker.markUserSpeech();

    const sample = tracker.markFirstResponseSent();
    assert.ok(sample !== null);
    assert.ok(sample.latencyMs < 25, `limite inferior: ${sample.latencyMs}`);
    assert.ok(sample.sinceTurnStartMs !== null && sample.sinceTurnStartMs >= 25,
              `limite superior: ${sample.sinceTurnStartMs}`);
  });

  it('conta quantas vezes a transcrição moveu a âncora', () => {
    // anchorMoves = 0 significa que os dois limites medem a mesma coisa; é o
    // que separa "medição confiável" de "transcrição atrasada mascarando".
    const tracker = new TtfabTracker();

    tracker.markClientAudioReceived();
    const semFala = new TtfabTracker();
    semFala.markClientAudioReceived();
    assert.equal(semFala.markFirstResponseSent()?.anchorMoves, 0);

    tracker.markUserSpeech();
    tracker.markUserSpeech();
    assert.equal(tracker.markFirstResponseSent()?.anchorMoves, 2);
  });

  it('sinceTurnStartMs é null quando a fala não foi precedida de áudio do cliente', () => {
    // Fala espontânea (alarme, segundo turno de tool call): não há turno de
    // usuário para ancorar o limite superior, e inventar um seria mentira.
    const tracker = new TtfabTracker();

    tracker.markUserSpeech();

    assert.equal(tracker.markFirstResponseSent()?.sinceTurnStartMs, null);
  });

  it('o limite superior reancora a cada turno', () => {
    // Sem zerar `turnStartedAt` ao emitir, o segundo turno herdaria o começo do
    // primeiro e o limite superior cresceria sem parar ao longo da conversa.
    const tracker = new TtfabTracker();

    tracker.markClientAudioReceived();
    busyWait(30);
    tracker.markUserSpeech();
    assert.notEqual(tracker.markFirstResponseSent(), null);

    tracker.markUserSpeech(); // novo turno
    tracker.markClientAudioReceived();
    const segundo = tracker.markFirstResponseSent();
    assert.ok(segundo !== null);
    assert.ok(segundo.sinceTurnStartMs !== null && segundo.sinceTurnStartMs < 25,
              `herdou o turno anterior: ${segundo.sinceTurnStartMs}`);
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
