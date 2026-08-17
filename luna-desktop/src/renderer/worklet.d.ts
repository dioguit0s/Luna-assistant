// Tipos ambientes do AudioWorkletGlobalScope. O `lib: ["DOM"]` do tsconfig
// cobre o realm de uma página normal, não o realm isolado de um worklet de
// áudio — sem isto, `class extends AudioWorkletProcessor` e
// `registerProcessor` não compilam. Mesmo padrão do ffmpeg-static.d.ts do
// luna-client-test: só o suficiente para compilar, não a spec inteira.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;
