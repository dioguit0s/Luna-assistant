// Script da janela oculta: captura (getUserMedia + AudioWorklet) e playback
// (AudioContext) via Web Audio, sem addon nativo.
//
// Propositalmente sem `import`/`export`: um <script src="./renderer.js">
// carregado de file:// não sofre a checagem estrita de MIME type que
// `<script type="module">` sofre no Chromium. index.html carrega isto como
// script clássico. Constantes precisam bater com shared/pcm.ts à mão — não
// há como importar de lá sem reintroduzir o problema de módulo.

// declare global (não uma interface Window solta): sob "module":"NodeNext"
// num pacote "type":"module", o TypeScript trata TODO .ts como módulo — com
// ou sem import/export no arquivo — então uma `interface Window` sem esse
// wrapper criaria um tipo local, sem se fundir com o Window global do lib.dom.
declare global {
  interface LunaBridge {
    sendMicFrame(buf: ArrayBuffer): void;
    sendCaptureError(message: string): void;
    sendCaptureReady(): void;
    onPlayPcm(callback: (buf: ArrayBuffer) => void): void;
    onFlushPlayback(callback: () => void): void;
  }

  interface Window {
    luna: LunaBridge;
  }
}

const SAMPLE_RATE = 16000; // deve bater com shared/pcm.ts:SAMPLE_RATE
const PLAYBACK_LEAD_S = 0.12; // absorve jitter de rede/IPC entre chunks consecutivos

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

async function main(): Promise<void> {
  const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  // autoplayPolicy: 'no-user-gesture-required' já libera isto na criação da
  // janela, mas o resume() explícito não faz mal se já estiver rodando.
  await audioCtx.resume();

  await audioCtx.audioWorklet.addModule('./capture-worklet.js');

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // echoCancellation é a principal defesa contra a Luna se ouvir com o
      // uplink reaberto durante o barge-in manual (forceListen).
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const source = audioCtx.createMediaStreamSource(stream);
  const captureNode = new AudioWorkletNode(audioCtx, 'luna-capture-processor');

  let frameCount = 0;
  captureNode.port.onmessage = (event: MessageEvent<ArrayBuffer>): void => {
    window.luna.sendMicFrame(event.data);

    // Nível de mic no debug (LUNA_DEBUG_WINDOW=1): throttlado a ~1x/s (a
    // cada 50 frames de 20ms) para não martelar o DOM.
    frameCount++;
    if (frameCount % 50 === 0) {
      const pcm = new Int16Array(event.data);
      let sumSquares = 0;
      for (let i = 0; i < pcm.length; i++) sumSquares += pcm[i] * pcm[i];
      const rms = Math.sqrt(sumSquares / pcm.length) / 0x8000;
      setStatus(`Capturando — nível de mic: ${(rms * 100).toFixed(0)}%`);
    }
  };

  source.connect(captureNode);
  // Não conectar captureNode a audioCtx.destination — senão o próprio mic
  // ecoaria de volta pelo alto-falante.

  window.luna.sendCaptureReady();
  setStatus('Captura pronta.');

  let playCursor = 0;
  const activeSources: AudioBufferSourceNode[] = [];

  window.luna.onPlayPcm((buf) => {
    const pcm = new Int16Array(buf);
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      float32[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);
    }

    const audioBuffer = audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
    audioBuffer.copyToChannel(float32, 0);

    const node = audioCtx.createBufferSource();
    node.buffer = audioBuffer;
    node.connect(audioCtx.destination);

    // Agenda em fila contra audioCtx.currentTime, não contra Date.now() —
    // absorve o jitter entre chunks que chegam por WS→IPC sem estalos.
    const now = audioCtx.currentTime;
    if (playCursor < now + 0.01) playCursor = now + PLAYBACK_LEAD_S;

    node.start(playCursor);
    playCursor += audioBuffer.duration;

    activeSources.push(node);
    node.onended = (): void => {
      const idx = activeSources.indexOf(node);
      if (idx !== -1) activeSources.splice(idx, 1);
    };
  });

  window.luna.onFlushPlayback(() => {
    for (const node of activeSources.splice(0)) {
      try {
        node.stop();
      } catch {
        // já pode ter terminado sozinho entre o splice e o stop()
      }
    }
    playCursor = audioCtx.currentTime;
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  setStatus(`Erro: ${message}`);
  window.luna.sendCaptureError(message);
});
