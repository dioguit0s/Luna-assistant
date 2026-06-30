/**
 * Resampling PCM16 mono via interpolação linear.
 * Suficiente para conversão 16kHz ↔ 24kHz no Épico 1.
 */

export function resamplePcm16(
  input: Buffer,
  fromRate: number,
  toRate: number,
): Buffer {
  if (fromRate === toRate) {
    return Buffer.from(input);
  }

  const inputSamples = input.length / 2;
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }

  const ratio = fromRate / toRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = input.readInt16LE(Math.min(srcIndex, inputSamples - 1) * 2);
    const s1 = input.readInt16LE(Math.min(srcIndex + 1, inputSamples - 1) * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return output;
}

export function resample16kTo24k(pcm16k: Buffer): Buffer {
  return resamplePcm16(pcm16k, 16000, 24000);
}

export function resample24kTo16k(pcm24k: Buffer): Buffer {
  return resamplePcm16(pcm24k, 24000, 16000);
}
