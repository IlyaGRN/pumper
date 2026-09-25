import { test } from 'node:test';
import { motionBlurPixels } from '../src/blur';
import assert from 'node:assert/strict';
import { analyze, envelope, lowpass, rmsChannels, pulseScale, sample } from '../src/audio';
import {
  initialProject,
  newParticles,
  projectSchema,
  dimensions,
  insertLayer,
  type Layer,
} from '../src/model';
import { particleAt, imageTransform } from '../src/renderer';

const rate = 44100;
const sine = (hz: number, duration = 1) =>
  Float32Array.from(
    { length: rate * duration },
    (_, i) => Math.sin((2 * Math.PI * hz * i) / rate) * 0.5,
  );
test('silence produces no pulse, waveform or spectrum energy', () => {
  const result = analyze([new Float32Array(4410)], rate, 180);
  assert.equal(result.duration, 0.1);
  assert.ok(result.envelope.every((v) => v === 0));
  assert.ok(result.waveform.every((v) => v === 0));
  assert.ok(result.spectrum.flat().every((v) => v === 0));
  assert.equal(pulseScale(1.5, 0), 1);
});
test('opposite-phase stereo preserves energy and bass response', () => {
  const signal = sine(80),
    inverse = signal.map((v) => -v);
  assert.ok(rmsChannels([signal, inverse], 0, rate) > 0.3);
  const stereo = envelope([signal, inverse], rate, 180),
    mono = envelope([signal], rate, 180);
  assert.ok(stereo.every((v, i) => Math.abs(v - mono[i]) < 1e-12));
});
test('low-pass attenuates treble while retaining bass', () => {
  const bass = lowpass(sine(60), rate, 180),
    treble = lowpass(sine(4000), rate, 180);
  assert.ok(rmsChannels([bass], 4410, rate) > 0.3);
  assert.ok(rmsChannels([treble], 4410, rate) < 0.005);
});
test('bass cutoff changes pulse envelope but not full-band analysis', () => {
  const signal = Float32Array.from(
    { length: rate },
    (_, i) => Math.sin((2 * Math.PI * (i < rate / 2 ? 60 : 1000) * i) / rate) * 0.5,
  );
  const low = analyze([signal], rate, 80),
    high = analyze([signal], rate, 1500);
  assert.ok(low.envelope[55] < high.envelope[55] * 0.3);
  assert.deepEqual(low.spectrum, high.spectrum);
  assert.deepEqual(low.loudness, high.loudness);
});
test('amplification stays bounded, delayed samples before start are zero', () => {
  assert.equal(pulseScale(1.2, 1), 1.2);
  assert.equal(pulseScale(2, 7), 2);
  assert.equal(pulseScale(2, -1), 1);
  assert.equal(sample([0, 1], 0.5, 1), 0.5);
  assert.equal(sample([0, 1], -1, 60), 0);
});
test('particles reproduce their state after arbitrary seeks', () => {
  for (const mode of ['rise', 'fall', 'shimmer'] as const) {
    const layer = { ...newParticles(), mode };
    const first = particleAt(layer, 17, 45.2, 0.5);
    particleAt(layer, 17, 102, 0.3);
    assert.deepEqual(particleAt(layer, 17, 45.2, 0.5), first);
    assert.notDeepEqual(particleAt({ ...layer, seed: layer.seed + 1 }, 17, 45.2, 0.5), first);
    assert.ok(first.radius > 0 && first.opacity >= 0 && first.opacity <= 1);
  }
});
test('image transform preserves coordinates at different preview sizes', () => {
  const project = initialProject();
  const image = { width: 400, height: 300 };
  const full = imageTransform(project, image, 1920, 1080),
    half = imageTransform(project, image, 960, 540);
  assert.equal(full.scale, half.scale * 2);
  assert.equal(full.x, half.x * 2);
  assert.equal(full.y, half.y * 2);
  assert.deepEqual(dimensions('portrait'), [1080, 1920]);
  assert.deepEqual(dimensions('square'), [1080, 1080]);
});
test('project validation rejects bad masks, duplicate layers and unsupported versions', () => {
  const project = initialProject();
  assert.ok(projectSchema.safeParse(project).success);
  assert.equal(projectSchema.safeParse({ ...project, version: 2 }).success, false);
  const layer = newParticles();
  assert.equal(projectSchema.safeParse({ ...project, layers: [layer, layer] }).success, false);
  const imageId = crypto.randomUUID(),
    maskId = crypto.randomUUID();
  assert.equal(
    projectSchema.safeParse({
      ...project,
      imageId,
      assets: [
        { id: imageId, name: 'image.png', kind: 'image', width: 200, height: 200 },
        { id: maskId, name: 'mask.png', kind: 'mask', width: 100, height: 200 },
      ],
      layers: [{ id: crypto.randomUUID(), name: 'mask', type: 'part', visible: true, maskId }],
    }).success,
    false,
  );
});

test('older projects default to sharp edges and invalid blur values are rejected', () => {
  const project = initialProject();
  const { edgeBlur, ...legacyPulse } = project.pulse;
  assert.equal(projectSchema.parse({ ...project, pulse: legacyPulse }).pulse.edgeBlur, 0);
  for (const value of [-1, 51, Infinity]) {
    assert.equal(
      projectSchema.safeParse({ ...project, pulse: { ...project.pulse, edgeBlur: value } }).success,
      false,
    );
  }
});

test('foreground requires a matching mask and only one foreground is allowed', () => {
  const imageId = crypto.randomUUID(),
    maskId = crypto.randomUUID();
  const layer = {
    id: crypto.randomUUID(),
    type: 'foreground',
    name: 'Subject',
    visible: true,
    maskId,
  };
  const project = {
    ...initialProject(),
    imageId,
    assets: [
      { id: imageId, kind: 'image', name: 'image.png', width: 200, height: 100 },
      { id: maskId, kind: 'mask', name: 'mask.png', width: 200, height: 100 },
    ],
    layers: [layer],
  };
  assert.ok(projectSchema.safeParse(project).success);
  assert.equal(projectSchema.safeParse({ ...project, imageId: undefined }).success, false);
  assert.equal(
    projectSchema.safeParse({ ...project, layers: [{ ...layer, maskId: crypto.randomUUID() }] })
      .success,
    false,
  );
  assert.equal(
    projectSchema.safeParse({
      ...project,
      assets: project.assets.map((a) => (a.kind === 'mask' ? { ...a, width: 100 } : a)),
    }).success,
    false,
  );
  assert.equal(
    projectSchema.safeParse({ ...project, layers: [layer, { ...layer, id: crypto.randomUUID() }] })
      .success,
    false,
  );
});
test('motion blur is backward compatible and bounded', () => {
  const project = initialProject();
  const { motionBlur, motionBlurAngle, ...legacyCanvas } = project.canvas;
  const parsed = projectSchema.parse({ ...project, canvas: legacyCanvas });
  assert.equal(parsed.canvas.motionBlur, 0);
  assert.equal(parsed.canvas.motionBlurAngle, 0);
  for (const values of [
    { motionBlur: -1 },
    { motionBlur: 101 },
    { motionBlurAngle: 181 },
    { motionBlur: NaN },
  ])
    assert.equal(
      projectSchema.safeParse({ ...project, canvas: { ...project.canvas, ...values } }).success,
      false,
    );
});
test('new particles are inserted underneath the foreground', () => {
  const foreground: Layer = {
    id: crypto.randomUUID(),
    type: 'foreground',
    name: 'Subject',
    visible: true,
    maskId: crypto.randomUUID(),
  };
  const particle = newParticles();
  assert.deepEqual(insertLayer([foreground], particle), [particle, foreground]);
  assert.deepEqual(insertLayer([], particle), [particle]);
});

test('motion blur retains smooth gradients without banding and weights transparent pixels', () => {
  const pixels = new Uint8ClampedArray(64 * 4);
  for (let i = 0; i < 64; i++) pixels.set([i + 60, i + 80, i + 100, 255], i * 4);
  const blurred = motionBlurPixels(pixels, 64, 1, 24, 0);
  for (let i = 12; i < 52; i++)
    assert.deepEqual(blurred.slice(i * 4, i * 4 + 4), pixels.slice(i * 4, i * 4 + 4));
  const masked = new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0]);
  assert.deepEqual(
    Array.from(motionBlurPixels(masked, 3, 1, 4, 0)),
    [0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255],
  );
});
test('motion blur covers every pixel at all supported angles, including narrow images', () => {
  for (const [width, height] of [
    [1, 1],
    [1, 19],
    [19, 1],
    [17, 11],
  ]) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([41, 97, 153, 255], i);
    for (const angle of [-180, -135, -90, -45, -30, 0, 30, 45, 90, 135, 180])
      assert.deepEqual(motionBlurPixels(pixels, width, height, 100, angle), pixels);
  }
});
