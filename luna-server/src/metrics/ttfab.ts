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
 */
export class TtfabTracker {
  private anchorAt: number | null = null;
  private firstResponseLogged = false;

  /** Âncora de fallback: só vale enquanto não houve sinal de fala. */
  markClientAudioReceived(): void {
    if (this.anchorAt === null) {
      this.anchorAt = performance.now();
    }
  }

  /** O usuário ainda estava falando neste instante — move a âncora à frente. */
  markUserSpeech(): void {
    this.anchorAt = performance.now();
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

  markFirstResponseSent(): number | null {
    if (this.firstResponseLogged || this.anchorAt === null) {
      return null;
    }

    const latencyMs = Math.round(performance.now() - this.anchorAt);
    this.firstResponseLogged = true;
    return latencyMs;
  }

  reset(): void {
    this.anchorAt = null;
    this.firstResponseLogged = false;
  }
}
