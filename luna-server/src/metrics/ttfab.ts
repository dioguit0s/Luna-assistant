/**
 * TTFAB = tempo entre o usuário terminar de falar e o primeiro áudio de
 * resposta sair para o satélite.
 *
 * A âncora NÃO pode ser "último chunk de áudio recebido": em open-mic o
 * satélite streama continuamente, então esse marco vira sempre "agora" e o
 * TTFAB medido cai para poucos milissegundos enquanto o usuário espera
 * segundos. É por isso que os logs mostravam 5–40ms num sistema visivelmente
 * lento.
 *
 * A âncora correta é o último instante em que sabemos que o usuário ainda
 * estava falando (`markUserSpeech`, alimentado pela transcrição de entrada do
 * provider). O primeiro chunk de áudio depois de um turno serve só como âncora
 * inicial, para o caso de a resposta vir antes de qualquer transcrição.
 *
 * ## Por que a medição é um INTERVALO, e não um número
 *
 * A âncora por transcrição corrige o viés grande do open-mic, mas deixa um
 * viés menor na mesma direção, e ele é estrutural: `markUserSpeech` carimba o
 * instante em que o FRAGMENTO DE TRANSCRIÇÃO CHEGOU, não o instante em que a
 * fala aconteceu. A transcrição de entrada do provider vem atrasada em relação
 * ao áudio, e todo esse atraso é subtraído do número — o `latency_ms` sai
 * sempre otimista, e não há sinal no protocolo do provider que permita
 * descontá-lo com exatidão.
 *
 * Como não dá para corrigir, o tracker devolve os dois lados:
 *
 * - `latencyMs` — da última transcrição ao primeiro áudio. Limite **inferior**
 *   (otimista), e a série histórica que já existe nos logs.
 * - `sinceTurnStartMs` — do primeiro chunk de áudio do turno ao primeiro áudio
 *   de resposta. Limite **superior** (pessimista: inclui o usuário ainda
 *   falando).
 *
 * A verdade está entre os dois. Um intervalo largo com `anchorMoves` alto é a
 * assinatura de transcrição atrasada mascarando o número de baixo; um intervalo
 * estreito significa que os dois concordam e a medição é confiável.
 */

/** Uma medição de turno. Ver o intervalo documentado acima. */
export interface TtfabSample {
  /** Limite inferior: da última transcrição de entrada ao primeiro áudio. */
  latencyMs: number;
  /**
   * Limite superior: do primeiro chunk de áudio do turno ao primeiro áudio de
   * resposta. `null` quando a resposta não foi precedida de áudio do cliente
   * (fala espontânea: alarme, lembrete, segundo turno de uma tool call).
   */
  sinceTurnStartMs: number | null;
  /**
   * Quantas vezes a transcrição empurrou a âncora neste turno. `0` significa
   * que `latencyMs` não foi descontado de nada — os dois limites medem a mesma
   * coisa e o intervalo é degenerado.
   */
  anchorMoves: number;
}

export class TtfabTracker {
  private anchorAt: number | null = null;
  /** Âncora do limite superior: não se move com a fala, só com o turno. */
  private turnStartedAt: number | null = null;
  private anchorMoves = 0;
  private firstResponseLogged = false;

  /** Âncora de fallback: só vale enquanto não houve sinal de fala. */
  markClientAudioReceived(): void {
    if (this.anchorAt === null) {
      this.anchorAt = performance.now();
    }
    // Independente da âncora móvel: este é o começo do turno, e ele não é
    // reancorado pela transcrição — é justamente o lado que não desconta nada.
    if (this.turnStartedAt === null) {
      this.turnStartedAt = performance.now();
    }
  }

  /** O usuário ainda estava falando neste instante — move a âncora à frente. */
  markUserSpeech(): void {
    this.anchorAt = performance.now();
    this.anchorMoves += 1;
    this.firstResponseLogged = false;
  }

  /**
   * Quanto tempo se passou desde o fim da fala, sem consumir o marco. Serve
   * para atribuir culpa: se a tool call chega 1500ms depois da fala e o HA
   * responde em 15ms, a latência é do modelo, não do despacho.
   */
  elapsedSinceAnchor(): number | null {
    return this.anchorAt === null ? null : Math.round(performance.now() - this.anchorAt);
  }

  markFirstResponseSent(): TtfabSample | null {
    if (this.firstResponseLogged || this.anchorAt === null) {
      return null;
    }

    const now = performance.now();
    const sample: TtfabSample = {
      latencyMs: Math.round(now - this.anchorAt),
      sinceTurnStartMs:
        this.turnStartedAt === null ? null : Math.round(now - this.turnStartedAt),
      anchorMoves: this.anchorMoves,
    };

    this.firstResponseLogged = true;
    // Só o limite superior fecha aqui: o turno seguinte reancora no próximo
    // chunk do cliente. `anchorAt` continua vivo de propósito — é o que
    // `elapsedSinceAnchor` usa para o `model_decision_ms` do MESMO turno, que
    // ainda está em curso quando o primeiro áudio sai.
    this.turnStartedAt = null;
    this.anchorMoves = 0;

    return sample;
  }

  reset(): void {
    this.anchorAt = null;
    this.turnStartedAt = null;
    this.anchorMoves = 0;
    this.firstResponseLogged = false;
  }
}
