import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import sharp from 'sharp';
import type { Asset, ForegroundJob } from '../src/model';

const origin = process.env.PUMPER_URL || 'http://127.0.0.1:4310';
const upload = async (svg: string, kind: string): Promise<Asset> => {
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(png)]), 'compositing-test.png');
  form.append('kind', kind);
  const response = await fetch(`${origin}/api/assets`, {
    method: 'POST',
    headers: { 'X-Pumper': '1' },
    body: form,
  });
  assert.ok(response.ok);
  return response.json();
};
const image = await upload(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="blue"/><rect x="16" y="16" width="32" height="32" fill="red"/><rect x="6" y="6" width="2" height="2" fill="white"/></svg>',
  'image',
);
const mask = await upload(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="black"/><rect x="16" y="16" width="32" height="32" fill="white"/></svg>',
  'mask',
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(origin);
  const result = await page.evaluate(
    async ({ image, mask }) => {
      const { prepareResources, renderFrame, particleAt, resourceKey } = await import(
        '/src/renderer.ts' as string
      );
      const { initialProject, newParticles } = await import('/src/model.ts' as string);
      const foreground = {
        id: crypto.randomUUID(),
        type: 'foreground',
        name: 'Foreground',
        visible: true,
        maskId: mask.id,
      };
      const project = {
        ...initialProject(),
        imageId: image.id,
        assets: [image, mask],
        layers: [foreground],
      };
      project.canvas.motionBlur = 24;
      const resources = await prepareResources(project);
      const original = await prepareResources({
        ...project,
        canvas: { ...project.canvas, motionBlur: 0 },
      });
      const vertical = await prepareResources({
        ...project,
        canvas: { ...project.canvas, motionBlurAngle: 90 },
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      renderFrame(ctx, project, resources, undefined, 0);
      const sharpSubject = Array.from(ctx.getImageData(20, 32, 1, 1).data);
      const cleanBackground = Array.from(ctx.getImageData(12, 32, 1, 1).data);
      const edgeBackground = Array.from(ctx.getImageData(0, 32, 1, 1).data);
      const horizontalStreak = Array.from(ctx.getImageData(2, 6, 1, 1).data);
      renderFrame(ctx, project, vertical, undefined, 0);
      const verticalStreak = Array.from(ctx.getImageData(2, 6, 1, 1).data);
      const particle = {
        ...newParticles(),
        size: 40,
        density: 1,
        motion: 0,
        speed: 0,
        opacity: 1,
        color: '#00ff00',
      };
      for (let seed = 0; seed < 10000; seed++) {
        particle.seed = seed;
        const position = particleAt(particle, 0, 0, 0);
        if (position.x > 0.45 && position.x < 0.55 && position.y > 0.45 && position.y < 0.55) break;
      }
      project.layers = [particle, foreground];
      renderFrame(ctx, project, resources, undefined, 0);
      const aboveParticles = Array.from(ctx.getImageData(32, 32, 1, 1).data);
      project.layers.reverse();
      renderFrame(ctx, project, resources, undefined, 0);
      const belowParticles = Array.from(ctx.getImageData(32, 32, 1, 1).data);
      return {
        sharpSubject,
        cleanBackground,
        edgeBackground,
        horizontalStreak,
        verticalStreak,
        aboveParticles,
        belowParticles,
        zeroDisables: !original.background,
        keyChanges:
          resourceKey(project) !==
          resourceKey({ ...project, canvas: { ...project.canvas, motionBlurAngle: 90 } }),
      };
    },
    { image, mask },
  );
  assert.deepEqual(
    result.sharpSubject,
    [255, 0, 0, 255],
    'Subject stays sharp over background blur',
  );
  assert.deepEqual(
    result.cleanBackground,
    [0, 0, 255, 255],
    'Foreground red must not bleed into the background',
  );
  assert.deepEqual(result.edgeBackground, [0, 0, 255, 255], 'Blur must not darken image edges');
  assert.ok(
    result.horizontalStreak[0] > 0 && result.verticalStreak[0] === 0,
    'Angle changes the streak direction',
  );
  assert.deepEqual(result.aboveParticles, [255, 0, 0, 255], 'Foreground occludes particles');
  assert.deepEqual(result.belowParticles, [0, 255, 0, 255], 'Layer reordering changes occlusion');
  assert.ok(result.zeroDisables && result.keyChanges);
  const response = await fetch(`${origin}/api/foreground`, {
    method: 'POST',
    headers: { 'X-Pumper': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageId: image.id }),
  });
  assert.equal(response.status, 202);
  const job: ForegroundJob = await response.json();
  const cancellation = await fetch(`${origin}/api/foreground/${job.id}`, {
    method: 'DELETE',
    headers: { 'X-Pumper': '1' },
  });
  assert.equal((await cancellation.json()).status, 'cancelled');
  const invalid = await fetch(`${origin}/api/foreground`, {
    method: 'POST',
    headers: { 'X-Pumper': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageId: mask.id }),
  });
  assert.equal(invalid.status, 400, 'A mask cannot be used as a source image');
  console.log(
    'PASS: directional blur, sharp foreground, no color bleed, image edges, particle occlusion/reordering, zero blur, resource invalidation, cancellation, invalid input.',
  );
} finally {
  await browser.close();
}
