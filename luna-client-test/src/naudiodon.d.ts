declare module 'naudiodon' {
  export enum SampleFormatInt16 {
    SampleFormatInt16 = 0,
  }

  export class AudioIO {
    constructor(options: {
      inOptions?: Record<string, unknown>;
      outOptions?: Record<string, unknown>;
    });
    on(event: 'data', listener: (chunk: Buffer) => void): void;
    start(): void;
    write(data: Buffer): void;
    quit(): void;
  }

  const portAudio: {
    AudioIO: typeof AudioIO;
    SampleFormatInt16: SampleFormatInt16;
  };

  export default portAudio;
}
