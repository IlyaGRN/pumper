import type { Analysis } from './model';

// Analysis uses channel energy, never a phase-sensitive stereo downmix.
export function rmsChannels(channels: Float32Array[], start: number, end: number) {
  let sum = 0,
    count = 0;
  for (const channel of channels)
    for (let i = start; i < Math.min(end, channel.length); i++) {
      sum += channel[i] ** 2;
      count++;
    }
  return Math.sqrt(sum / Math.max(1, count));
}
export function lowpass(input: Float32Array, sampleRate: number, cutoff: number) {
  const w = (2 * Math.PI * cutoff) / sampleRate,
    cos = Math.cos(w),
    alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha,
    b0 = (1 - cos) / 2 / a0,
    b1 = (1 - cos) / a0,
    a1 = (-2 * cos) / a0,
    a2 = (1 - alpha) / a0;
  const out = new Float32Array(input.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i],
      y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}
export function envelope(channels: Float32Array[], sampleRate: number, cutoff?: number, fps = 60) {
  const filtered =
    cutoff === undefined ? channels : channels.map((c) => lowpass(c, sampleRate, cutoff));
  const count = Math.ceil((channels[0].length / sampleRate) * fps),
    values: number[] = [];
  let previous = 0,
    peak = 0;
  for (let i = 0; i < count; i++) {
    const rms = rmsChannels(
      filtered,
      Math.floor((i * sampleRate) / fps),
      Math.floor(((i + 1) * sampleRate) / fps),
    );
    const coefficient = Math.exp(-1 / (fps * (rms > previous ? 0.025 : 0.16)));
    previous = coefficient * previous + (1 - coefficient) * rms;
    values.push(previous);
    peak = Math.max(peak, previous);
  }
  return values.map((v) => (peak < 1e-5 ? 0 : Math.min(1, v / peak)));
}
function fftPower(samples: Float32Array, offset: number, size = 2048) {
  const re = new Float64Array(size),
    im = new Float64Array(size);
  for (let i = 0; i < size; i++)
    re[i] = (samples[offset + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= size; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let i = 0; i < size; i += len)
      for (let j = 0; j < len / 2; j++) {
        const c = Math.cos(angle * j),
          s = Math.sin(angle * j),
          a = i + j,
          b = a + len / 2;
        const tr = re[b] * c - im[b] * s,
          ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
  }
  return re.slice(0, size / 2).map((v, i) => (v * v + im[i] * im[i]) / (size * size));
}
export function analyze(channels: Float32Array[], sampleRate: number, cutoff: number): Analysis {
  const duration = channels[0].length / sampleRate,
    fps = 60,
    spectrum: number[][] = [],
    waveform: number[] = [];
  // 30 Hz FFT frames are shared by preview and export; envelope is sampled at 60 Hz.
  for (let i = 0; i < Math.ceil(duration * 30); i++) {
    const powers = channels.map((c) => fftPower(c, Math.floor((i * sampleRate) / 30)));
    spectrum.push(
      Array.from({ length: 64 }, (_, band) => {
        const lo = Math.max(1, Math.floor((30 * (16000 / 30) ** (band / 64) * 2048) / sampleRate));
        const hi = Math.min(
          1023,
          Math.max(lo, Math.ceil((30 * (16000 / 30) ** ((band + 1) / 64) * 2048) / sampleRate)),
        );
        let sum = 0;
        for (const power of powers) for (let k = lo; k <= hi; k++) sum += power[k];
        const db = 10 * Math.log10(sum / powers.length + 1e-12);
        return Math.max(0, Math.min(1, (db + 70) / 65));
      }),
    );
  }
  const step = Math.max(1, Math.ceil(channels[0].length / 1200));
  for (let i = 0; i < channels[0].length; i += step)
    waveform.push(rmsChannels(channels, i, i + step));
  const wavePeak = Math.max(...waveform, 1e-5);
  return {
    duration,
    fps,
    envelope: envelope(channels, sampleRate, cutoff, fps),
    loudness: envelope(channels, sampleRate, undefined, fps),
    spectrum,
    waveform: waveform.map((v) => v / wavePeak),
  };
}
export function sample(values: number[], time: number, fps: number) {
  if (time < 0 || !values.length) return 0;
  const index = Math.min(time * fps, values.length - 1),
    lo = Math.floor(index),
    mix = index - lo;
  return values[lo] * (1 - mix) + (values[Math.min(lo + 1, values.length - 1)] || 0) * mix;
}
export const pulseScale = (maxScale: number, loudness: number) =>
  1 + (maxScale - 1) * Math.min(1, Math.max(0, loudness));
