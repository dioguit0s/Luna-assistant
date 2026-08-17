/// <reference path="./worklet.d.ts" />

// Processor de captura: roda no thread de áudio (AudioWorkletGlobalScope),
// um realm isolado do renderer normal — por isso este arquivo não importa de
// mais nada (nem de shared/pcm.ts). `audioContext.audioWorklet.addModule()`
// carrega este arquivo sozinho, compilado sem import/export.
//
// Converte os blocos de 128 amostras que o Web Audio entrega em PCM16 e
// acumula até fechar exatamente 320 amostras (640 bytes = 20ms) antes de
// postar — a mesma cadência de frame do firmware e do luna-client-test.

const CHUNK_SAMPLES = 320;

class CaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Int16Array(CHUNK_SAMPLES);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true; // mic sem dados neste quantum — mantém o processor vivo

    for (let i = 0; i < channel.length; i++) {
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.filled++;

      if (this.filled === CHUNK_SAMPLES) {
        // Cópia antes de transferir: postMessage(transferable) esvazia o
        // ArrayBuffer original, e this.buffer precisa sobreviver pro próximo lote.
        const out = this.buffer.slice();
        this.port.postMessage(out.buffer, [out.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('luna-capture-processor', CaptureProcessor);
