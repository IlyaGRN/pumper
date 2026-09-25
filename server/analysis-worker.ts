import { readFileSync } from 'node:fs';
import { analyze, envelope } from '../src/audio';
process.on('message', (input: { path: string; cutoff: number; envelopeOnly: boolean }) => {
  try {
    const bytes = readFileSync(input.path);
    const frames = Math.floor(bytes.length / 8),
      channels = [new Float32Array(frames), new Float32Array(frames)];
    for (let i = 0; i < frames; i++) {
      channels[0][i] = bytes.readFloatLE(i * 8);
      channels[1][i] = bytes.readFloatLE(i * 8 + 4);
    }
    const result = input.envelopeOnly
      ? envelope(channels, 44100, input.cutoff)
      : analyze(channels, 44100, input.cutoff);
    process.send!({ result }, () => process.exit(0));
  } catch (error) {
    process.send!({ error: String(error) }, () => process.exit(1));
  }
});
