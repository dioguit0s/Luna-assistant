export class TtfabTracker {
  private lastClientAudioAt: number | null = null;
  private firstResponseLogged = false;

  markClientAudioReceived(): void {
    this.lastClientAudioAt = performance.now();
    this.firstResponseLogged = false;
  }

  markFirstResponseSent(roomId: string, provider: string): number | null {
    if (this.firstResponseLogged || this.lastClientAudioAt === null) {
      return null;
    }

    const latencyMs = Math.round(performance.now() - this.lastClientAudioAt);
    this.firstResponseLogged = true;
    return latencyMs;
  }

  reset(): void {
    this.lastClientAudioAt = null;
    this.firstResponseLogged = false;
  }
}
