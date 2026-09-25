import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import type { Project, ExportJob } from '../src/model';

const origin = process.env.PUMPER_URL || 'http://127.0.0.1:4310';
const foregroundEnabled = process.env.PUMPER_TEST_FOREGROUND === '1';
const out = path.resolve('test-results');
await fs.mkdir(out, { recursive: true });
const file = (name: string) => path.join(out, name);
const svg = `<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#182f3b"/><stop offset="1" stop-color="#8b927c"/></linearGradient><linearGradient id="peak" x2="0" y2="1"><stop stop-color="#354b4d"/><stop offset="1" stop-color="#0d232b"/></linearGradient></defs><rect width="640" height="360" fill="url(#sky)"/><circle cx="415" cy="123" r="49" fill="#e5d8ad"/><path d="M0 260 102 139 188 234 312 105 436 247 534 165 640 271V360H0" fill="#566c68"/><path d="m0 301 170-169 193 211 90-133 187 136v14H0" fill="url(#peak)"/><path d="m113 189 57-57 54 59-46-24-16 15-19-9Z" fill="#b6c3ad"/><path d="M0 328q170-39 319 0t321 7v25H0" fill="#10242b"/><text x="33" y="47" fill="#d6e1c8" font-size="12" font-family="sans-serif" letter-spacing="4">AFTER HOURS</text><text x="35" y="68" fill="#8caaa5" font-size="7" font-family="sans-serif" letter-spacing="3">SOUND STUDY / 001</text></svg>`;
await sharp(Buffer.from(svg)).png().toFile(file('landscape.png'));
await sharp(
  Buffer.from(
    '<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="360" fill="black"/><circle cx="415" cy="123" r="49" fill="#808080"/><circle cx="415" cy="123" r="30" fill="white"/></svg>',
  ),
)
  .png()
  .toFile(file('mask.png'));
await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } })
  .png()
  .toFile(file('wrong-mask.png'));
execFileSync(ffmpeg!, [
  '-y',
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'aevalsrc=0.5*sin(2*PI*80*t)*(0.5+0.5*sin(2*PI*3*t))|0.5*sin(2*PI*1000*t):s=44100:d=1.2',
  file('track.wav'),
]);
execFileSync(ffmpeg!, [
  '-y',
  '-v',
  'error',
  '-i',
  file('track.wav'),
  '-c:a',
  'libmp3lame',
  file('track.mp3'),
]);
const health = await fetch(`${origin}/api/health`).then((r) => r.json());
assert.ok(health.ffmpeg && health.chromium);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
// Live reload is unnecessary during tests and can connect to another dev server.
await page.routeWebSocket(/.*/, () => {});
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const api = async <T>(url: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetch(`${origin}${url}`, {
    ...options,
    headers: {
      'X-Pumper': '1',
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
  });
  assert.ok(response.ok, `${url}: ${response.status} ${response.ok ? '' : await response.text()}`);
  return response.json() as Promise<T>;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: /Give your image/ }).waitFor();
  await page.screenshot({ path: file('empty-editor.png') });
  await page.locator('input[type=file]').nth(0).setInputFiles(file('landscape.png'));
  await page.locator('canvas[aria-label="Animation preview"]').waitFor();
  await page.locator('input[type=file]').nth(1).setInputFiles(file('track.wav'));
  await page.getByTitle('Play', { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.body.textContent?.includes('All systems local') &&
      !document.body.textContent?.includes('Analyzing'),
  );
  if (foregroundEnabled) {
    assert.ok(health.foreground, 'Run npm run setup:foreground before the foreground suite');
    await page.getByRole('button', { name: 'Separate foreground', exact: true }).click();
    await page
      .getByRole('button', { name: 'Foreground BiRefNet cutout', exact: true })
      .waitFor({ timeout: 180000 });
    await page.getByRole('slider', { name: 'Motion blur strength', exact: true }).fill('24');
    await page.getByRole('slider', { name: 'Motion blur angle', exact: true }).fill('30');
  }
  await page.getByRole('button', { name: 'Draw region', exact: true }).click();
  const overlay = page.locator('.selection-overlay');
  const bounds = (await overlay.boundingBox())!;
  for (const [x, y] of [
    [0.17, 0.54],
    [0.267, 0.36],
    [0.42, 0.69],
    [0.1, 0.83],
  ])
    await overlay.click({ position: { x: bounds.width * x, y: bounds.height * y } });
  await page.getByRole('button', { name: 'Finish region' }).click();
  await page.getByLabel('Layer name').fill('Mountain pulse');
  const vertex = overlay.locator('[data-vertex="0"]');
  const before = await vertex.getAttribute('cx');
  const vb = (await vertex.boundingBox())!;
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  await page.mouse.down();
  await page.mouse.move(vb.x + 25, vb.y + 15);
  await page.mouse.up();
  assert.notEqual(await vertex.getAttribute('cx'), before, 'Vertex edit should change coordinates');
  await page.locator('input[type=file]').nth(2).setInputFiles(file('wrong-mask.png'));
  await page.getByRole('alert').filter({ hasText: 'Mask must match' }).waitFor();
  await page.getByTitle('Dismiss message').click();
  await page.locator('input[type=file]').nth(2).setInputFiles(file('mask.png'));
  await page.getByLabel('Layer name').fill('Moon pulse');
  await page.getByLabel('Edge blur', { exact: true }).fill('8');
  await page.getByTitle('Add particle layer').click();
  await page.getByLabel('React to music', { exact: true }).check();
  await page.getByLabel('Movement', { exact: true }).selectOption('shimmer');
  await page.getByTitle('Add analyzer layer').click();
  await page.getByLabel('Style', { exact: true }).selectOption('mirror');
  await page.getByLabel('Project name').fill('After Hours');
  await page.getByLabel('Timeline', { exact: true }).fill('0.4');
  await page.screenshot({ path: file('editor.png') });
  await page.getByTitle('Play', { exact: true }).click();
  await sleep(200);
  await page.getByTitle('Pause', { exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project' }).click();
  const download = await downloadPromise;
  await download.saveAs(file('roundtrip.pumper'));
  const archive = unzipSync(await fs.readFile(file('roundtrip.pumper')));
  const project: Project = JSON.parse(strFromU8(archive['project.json']));
  assert.equal(project.pulse.edgeBlur, 8);
  assert.equal(project.layers.length, foregroundEnabled ? 5 : 4);
  assert.equal(project.assets.length, foregroundEnabled ? 4 : 3);
  if (foregroundEnabled) {
    assert.equal(project.canvas.motionBlur, 24);
    assert.equal(project.canvas.motionBlurAngle, 30);
    assert.ok(
      project.layers.findIndex((l) => l.type === 'foreground') >
        project.layers.findIndex((l) => l.type === 'particles'),
    );
    const cachedJob: any = await api('/api/foreground', {
      method: 'POST',
      body: JSON.stringify({ imageId: project.imageId }),
    });
    await sleep(300);
    const cached: any = await api(`/api/foreground/${cachedJob.id}`);
    assert.equal(cached.status, 'complete');
    assert.equal(cached.mask.id, project.layers.find((l) => l.type === 'foreground')!.maskId);
  }
  await page.locator('input[type=file]').nth(3).setInputFiles(file('roundtrip.pumper'));
  await page.getByRole('status').filter({ hasText: 'Project opened' }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByLabel('Project name').inputValue(), 'After Hours');
  if (foregroundEnabled) {
    await page.getByRole('button', { name: 'Foreground BiRefNet cutout', exact: true }).waitFor();
    const roundtripDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save project' }).click();
    await (await roundtripDownload).saveAs(file('foreground-roundtrip.pumper'));
    const restored: Project = JSON.parse(
      strFromU8(unzipSync(await fs.readFile(file('foreground-roundtrip.pumper')))['project.json']),
    );
    const layer = restored.layers.find((l) => l.type === 'foreground')!;
    assert.notEqual(layer.maskId, project.layers.find((l) => l.type === 'foreground')!.maskId);
    assert.ok(restored.assets.some((a) => a.id === layer.maskId && a.kind === 'mask'));
    assert.equal(restored.canvas.motionBlur, 24);
  }
  await page.getByRole('button', { name: 'Background Original image BASE' }).click();
  assert.equal(await page.getByLabel('Edge blur', { exact: true }).inputValue(), '8');
  await page.getByLabel('Format', { exact: true }).selectOption('portrait');
  await page.screenshot({ path: file('portrait-editor.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: file('mobile-editor.png'), fullPage: true });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Mobile should not overflow horizontally',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Mask alpha, source coordinates, deterministic seeking, and all analyzer styles use the production renderer.
  const rendering = await page.evaluate(
    async ({ project }) => {
      const { prepareResources, renderFrame } = await import('/src/renderer.ts' as string);
      const analysis = await fetch(
        `/api/analysis/${project.audioId}?cutoff=${project.pulse.cutoff}`,
      ).then((r) => r.json());
      const resources = await prepareResources(project),
        mask = resources.cutouts.get(project.layers.find((l) => l.type === 'part' && l.maskId)!.id);
      const rgba = mask.canvas.getContext('2d').getImageData(0, 0, mask.width, mask.height).data;
      let partial = false,
        opaque = false;
      for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] > 100 && rgba[i] < 150) partial = true;
        if (rgba[i] === 255) opaque = true;
      }
      // A straight boundary makes the blur falloff measurable in source coordinates.
      const rectangle = {
        id: crypto.randomUUID(),
        name: 'Blur fixture',
        type: 'part',
        visible: true,
        polygon: [
          { x: 200, y: 150 },
          { x: 300, y: 150 },
          { x: 300, y: 250 },
          { x: 200, y: 250 },
        ],
      };
      const fixture = { ...project, layers: [rectangle] };
      const sharpResources = await prepareResources({
        ...fixture,
        pulse: { ...project.pulse, edgeBlur: 0 },
      });
      const softResources = await prepareResources(fixture);
      const sharp = sharpResources.cutouts.get(rectangle.id)!;
      const soft = softResources.cutouts.get(rectangle.id)!;
      const [sharpEdge, softEdge, softOutside, sharpCenter, softCenter] = [
        { cutout: sharp, x: 200, y: 200 },
        { cutout: soft, x: 200, y: 200 },
        { cutout: soft, x: 190, y: 200 },
        { cutout: sharp, x: 250, y: 200 },
        { cutout: soft, x: 250, y: 200 },
      ].map(
        ({ cutout, x, y }) =>
          Array.from(
            cutout.canvas.getContext('2d').getImageData(x - cutout.x, y - cutout.y, 1, 1).data,
          ) as number[],
      );
      const feathered =
        sharpEdge[3] === 255 &&
        softEdge[3] > 80 &&
        softEdge[3] < 180 &&
        softOutside[3] > 0 &&
        softOutside[3] < softEdge[3];
      const detailPreserved = JSON.stringify(sharpCenter) === JSON.stringify(softCenter);
      const centerPreserved =
        sharp.x + sharp.width / 2 === soft.x + soft.width / 2 &&
        sharp.y + sharp.height / 2 === soft.y + soft.height / 2;
      const canvas = document.createElement('canvas');
      canvas.width = 1920;
      canvas.height = 1080;
      const ctx = canvas.getContext('2d')!;
      const analyzer = project.layers.find((l) => l.type === 'analyzer')!;
      const styleFrames: string[] = [];
      for (const style of ['bars', 'mirror', 'line', 'radial'] as const) {
        analyzer.style = style;
        renderFrame(ctx, project, resources, analysis, 0.4);
        styleFrames.push(canvas.toDataURL());
      }
      analyzer.style = 'mirror';
      renderFrame(ctx, project, resources, analysis, 0.4);
      const first = canvas.toDataURL();
      renderFrame(ctx, project, resources, analysis, 0.9);
      renderFrame(ctx, project, resources, analysis, 0.4);
      const second = canvas.toDataURL();
      renderFrame(ctx, project, resources, analysis, 0);
      const initial = canvas.toDataURL();
      return {
        partial,
        opaque,
        feathered,
        detailPreserved,
        centerPreserved,
        deterministic: first === second,
        stylesDistinct: new Set(styleFrames).size === 4,
        initial,
        middle: first,
      };
    },
    { project },
  );
  assert.ok(rendering.partial && rendering.opaque, 'Mask preserves feathered and opaque alpha');
  assert.ok(rendering.feathered, 'Edge blur feathers the boundary and extends beyond it');
  assert.ok(
    rendering.detailPreserved && rendering.centerPreserved,
    'Blur preserves image details and pulse center',
  );
  assert.ok(rendering.deterministic && rendering.stylesDistinct);
  await fs.writeFile(
    file('expected-frame.png'),
    Buffer.from(rendering.initial.split(',')[1], 'base64'),
  );
  await fs.writeFile(
    file('expected-middle.png'),
    Buffer.from(rendering.middle.split(',')[1], 'base64'),
  );
  const render = async (p: Project, name: string) => {
    let job = await api<ExportJob>('/api/exports', { method: 'POST', body: JSON.stringify(p) });
    const deadline = Date.now() + 180000;
    while (['queued', 'rendering', 'encoding'].includes(job.status) && Date.now() < deadline) {
      await sleep(400);
      job = await api<ExportJob>(`/api/exports/${job.id}`);
    }
    assert.equal(job.status, 'complete', job.error || `Export timed out: ${job.status}`);
    const response = await fetch(`${origin}/api/exports/${job.id}/download`);
    assert.ok(response.ok);
    await fs.writeFile(file(name), Buffer.from(await response.arrayBuffer()));
  };
  await render(project, 'landscape-wav.mp4');
  execFileSync(ffmpeg!, [
    '-y',
    '-v',
    'error',
    '-i',
    file('landscape-wav.mp4'),
    '-frames:v',
    '1',
    file('export-frame.png'),
  ]);
  const expected = await sharp(file('expected-frame.png')).raw().toBuffer(),
    actual = await sharp(file('export-frame.png')).ensureAlpha().raw().toBuffer();
  assert.equal(actual.length, expected.length);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference += Math.abs(expected[i] - actual[i]);
  assert.ok(
    difference / actual.length < 5,
    `Export diverged from renderer: MAE ${difference / actual.length}`,
  );
  execFileSync(ffmpeg!, [
    '-y',
    '-v',
    'error',
    '-i',
    file('landscape-wav.mp4'),
    '-vf',
    'select=eq(n\\,12)',
    '-frames:v',
    '1',
    file('export-middle.png'),
  ]);
  const expectedMiddle = await sharp(file('expected-middle.png')).raw().toBuffer();
  const actualMiddle = await sharp(file('export-middle.png')).ensureAlpha().raw().toBuffer();
  let middleDifference = 0;
  for (let i = 0; i < actualMiddle.length; i++)
    middleDifference += Math.abs(expectedMiddle[i] - actualMiddle[i]);
  assert.ok(
    middleDifference / actualMiddle.length < 5,
    'Animated export frame must match preview at the same timestamp',
  );
  const outputMeta = await sharp(file('export-frame.png')).metadata();
  assert.equal(outputMeta.width, 1920);
  assert.equal(outputMeta.height, 1080);
  const decodedAudio = execFileSync(ffmpeg!, [
    '-v',
    'error',
    '-i',
    file('landscape-wav.mp4'),
    '-vn',
    '-f',
    'f32le',
    '-ac',
    '2',
    '-ar',
    '44100',
    'pipe:1',
  ]);
  assert.ok(
    Math.abs(decodedAudio.length / (44100 * 8) - 1.2) < 1 / 30,
    'Audio stays within one frame of original duration',
  );
  const videoFrames = execFileSync(ffmpeg!, [
    '-v',
    'error',
    '-i',
    file('landscape-wav.mp4'),
    '-an',
    '-f',
    'framemd5',
    'pipe:1',
  ]).toString();
  assert.equal(videoFrames.split('\n').filter((line) => line && !line.startsWith('#')).length, 36);
  assert.match(videoFrames, /#tb 0: 1\/30/);
  const form = new FormData();
  form.append('file', new Blob([await fs.readFile(file('track.mp3'))]), 'track.mp3');
  form.append('kind', 'audio');
  const mp3: any = await api('/api/assets', { method: 'POST', body: form });
  const portrait: Project = {
    ...project,
    audioId: mp3.id,
    assets: [...project.assets.filter((a) => a.kind !== 'audio'), mp3],
    canvas: { ...project.canvas, format: 'portrait' },
  };
  await render(portrait, 'portrait-mp3.mp4');
  execFileSync(ffmpeg!, [
    '-y',
    '-v',
    'error',
    '-i',
    file('portrait-mp3.mp4'),
    '-frames:v',
    '1',
    file('portrait-frame.png'),
  ]);
  const portraitMeta = await sharp(file('portrait-frame.png')).metadata();
  assert.equal(portraitMeta.width, 1080);
  assert.equal(portraitMeta.height, 1920);
  await render({ ...project, canvas: { ...project.canvas, format: 'square' } }, 'square-wav.mp4');
  execFileSync(ffmpeg!, [
    '-y',
    '-v',
    'error',
    '-i',
    file('square-wav.mp4'),
    '-frames:v',
    '1',
    file('square-frame.png'),
  ]);
  const squareMeta = await sharp(file('square-frame.png')).metadata();
  assert.equal(squareMeta.width, 1080);
  assert.equal(squareMeta.height, 1080);
  let cancel = await api<ExportJob>('/api/exports', {
    method: 'POST',
    body: JSON.stringify(project),
  });
  const duplicate = await fetch(`${origin}/api/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pumper': '1' },
    body: JSON.stringify(project),
  });
  assert.equal(duplicate.status, 409);
  cancel = await api<ExportJob>(`/api/exports/${cancel.id}`, { method: 'DELETE' });
  assert.equal(cancel.status, 'cancelled');
  assert.equal((await fetch(`${origin}/api/exports/${cancel.id}/download`)).status, 404);
  const malicious = new FormData();
  malicious.append(
    'file',
    new Blob([
      zipSync({ '../escape': strToU8('bad'), 'project.json': archive['project.json'] }) as BlobPart,
    ]),
    'bad.pumper',
  );
  const invalid = await fetch(`${origin}/api/projects/open`, {
    method: 'POST',
    headers: { 'X-Pumper': '1' },
    body: malicious,
  });
  assert.equal(invalid.status, 400);
  const missingAudio = await fetch(`${origin}/api/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pumper': '1' },
    body: JSON.stringify({ ...project, audioId: undefined }),
  });
  // A cancelled job can still be closing Chromium; wait for cleanup before testing validation.
  if (missingAudio.status === 409) await sleep(1000);
  const badExport = await fetch(`${origin}/api/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pumper': '1' },
    body: JSON.stringify({ ...project, audioId: undefined }),
  });
  assert.equal(badExport.status, 400);
  if (!process.env.PUMPER_URL) {
    // Inject a read failure into a newly uploaded test-only asset, then restore it.
    const brokenForm = new FormData();
    brokenForm.append(
      'file',
      new Blob([await fs.readFile(file('landscape.png'))]),
      'fault-fixture.png',
    );
    brokenForm.append('kind', 'image');
    const asset: any = await api('/api/assets', { method: 'POST', body: brokenForm });
    const assetFile = path.join(
      process.env.PUMPER_DATA_DIR || '.pumper-data',
      'assets',
      `${asset.id}.bin`,
    );
    const original = await fs.readFile(assetFile);
    try {
      await fs.writeFile(assetFile, 'intentionally unreadable test image');
      const brokenProject = {
        ...project,
        imageId: asset.id,
        assets: [...project.assets.filter((a) => a.kind !== 'image'), asset],
      };
      let failed = await api<ExportJob>('/api/exports', {
        method: 'POST',
        body: JSON.stringify(brokenProject),
      });
      const deadline = Date.now() + 30000;
      while (['queued', 'rendering', 'encoding'].includes(failed.status) && Date.now() < deadline) {
        await sleep(300);
        failed = await api<ExportJob>(`/api/exports/${failed.id}`);
      }
      assert.equal(failed.status, 'failed');
      assert.ok(failed.error);
      assert.equal((await fetch(`${origin}/api/exports/${failed.id}/download`)).status, 404);
    } finally {
      await fs.writeFile(assetFile, original);
    }
  }
  assert.deepEqual(pageErrors, [], 'Browser should have no uncaught errors');
  console.log(
    'PASS: foreground (when enabled), imports, polygon editing, grayscale feathering, controls, deterministic seeking, four analyzer styles, portable project, mobile layout, WAV/MP3 exports in all three formats, animated frame parity, duration, cancellation, failed exports, and archive validation.',
  );
  console.log(`Screenshots and exported videos: ${out}`);
} catch (error) {
  await page.screenshot({ path: file('failure.png'), fullPage: true }).catch(() => {});
  console.error('Browser errors:', pageErrors);
  throw error;
} finally {
  await browser.close();
}
