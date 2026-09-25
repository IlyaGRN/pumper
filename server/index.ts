import express from 'express';
import { foregroundService } from './foreground';
import multer from 'multer';
import sharp from 'sharp';
import ffmpegStatic from 'ffmpeg-static';
import { chromium, type Browser } from 'playwright';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { spawn, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import {
  projectSchema,
  dimensions,
  type Asset,
  type Analysis,
  type Project,
  type ExportJob,
} from '../src/model';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = path.resolve(process.env.PUMPER_DATA_DIR || path.join(root, '.pumper-data'));
const port = Number(process.env.PORT || 4310),
  origin = `http://127.0.0.1:${port}`;
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
for (const dir of ['assets', 'cache', 'uploads', 'exports'])
  await fs.mkdir(path.join(data, dir), { recursive: true });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assetPath = (id: string) => {
  if (!uuid.test(id)) throw new Error('Invalid asset ID');
  return path.join(data, 'assets', `${id}.bin`);
};
const metaPath = (id: string) => assetPath(id).replace(/\.bin$/, '.json');
const getAsset = async (id: string): Promise<Asset> =>
  JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
async function command(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stderr)
        : reject(new Error(`FFmpeg could not process this media. ${stderr.slice(-500)}`)),
    );
  });
}
let ffmpegReady = false;
try {
  await command(['-version']);
  ffmpegReady = true;
} catch {
  console.warn('FFmpeg unavailable. Install dependencies or set FFMPEG_PATH.');
}
const browserReady = () => existsSync(chromium.executablePath());

async function importAsset(file: string, name: string, kind: Asset['kind']): Promise<Asset> {
  const id = randomUUID(),
    destination = assetPath(id);
  let asset: Asset;
  try {
    if (kind === 'audio') {
      if (!/\.(mp3|wav)$/i.test(name)) throw new Error('Choose an MP3 or WAV file.');
      const pcm = path.join(data, 'cache', `${id}.pcm`);
      await command([
        '-v',
        'error',
        '-y',
        '-i',
        file,
        '-vn',
        '-t',
        '1801',
        '-ac',
        '2',
        '-ar',
        '44100',
        '-f',
        'f32le',
        pcm,
      ]);
      const duration = (await fs.stat(pcm)).size / (44100 * 8);
      if (duration <= 0 || duration > 1800) {
        await fs.rm(pcm, { force: true });
        throw new Error('Audio must be between 0 and 30 minutes long.');
      }
      await fs.copyFile(file, destination);
      asset = { id, kind, name, duration };
    } else {
      const image = sharp(file, { limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format || ''))
        throw new Error('Choose a PNG, JPEG, or WebP image.');
      const info = await image.rotate().png().toFile(destination);
      if (info.width > 12000 || info.height > 12000)
        throw new Error('Image dimensions must be at most 12,000 pixels.');
      asset = { id, kind, name, width: info.width, height: info.height };
    }
    await fs.writeFile(metaPath(id), JSON.stringify(asset));
    return asset;
  } catch (error) {
    await fs.rm(destination, { force: true });
    await fs.rm(path.join(data, 'cache', `${id}.pcm`), { force: true });
    throw error;
  }
}
const workers = new Set<ChildProcess>();
function runAnalysis(
  id: string,
  cutoff: number,
  envelopeOnly: boolean,
): Promise<Analysis | number[]> {
  return new Promise((resolve, reject) => {
    const worker = fork(path.join(root, 'server/analysis-worker.ts'), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    workers.add(worker);
    let settled = false;
    worker.on('message', (message: { result?: Analysis | number[]; error?: string }) => {
      settled = true;
      message.error ? reject(new Error(message.error)) : resolve(message.result!);
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      workers.delete(worker);
      if (!settled) reject(new Error(`Audio analysis stopped (${code}).`));
    });
    worker.send({ path: path.join(data, 'cache', `${id}.pcm`), cutoff, envelopeOnly });
  });
}
const pending = new Map<string, Promise<Analysis>>();
// Serial analysis jobs prevent multiple large audio buffers from exhausting memory.
let analysisQueue = Promise.resolve<unknown>(undefined);
async function getAnalysis(id: string, cutoff: number): Promise<Analysis> {
  const asset = await getAsset(id);
  if (asset.kind !== 'audio') throw new Error('Select an audio asset.');
  const key = `${id}-${cutoff}`;
  const cached = path.join(data, 'cache', `${key}.json`);
  if (existsSync(cached)) return JSON.parse(await fs.readFile(cached, 'utf8'));
  if (pending.has(key)) return pending.get(key)!;
  const work = analysisQueue.then(async () => {
    const baseFile = path.join(data, 'cache', `${id}-base.json`);
    let result: Analysis;
    if (existsSync(baseFile)) {
      result = JSON.parse(await fs.readFile(baseFile, 'utf8'));
      result.envelope = (await runAnalysis(id, cutoff, true)) as number[];
    } else {
      result = (await runAnalysis(id, cutoff, false)) as Analysis;
      await fs.writeFile(baseFile, JSON.stringify(result));
    }
    await fs.writeFile(cached, JSON.stringify(result));
    return result;
  });
  analysisQueue = work.catch(() => {});
  pending.set(key, work);
  try {
    return await work;
  } finally {
    pending.delete(key);
  }
}
async function validateProject(input: unknown) {
  const project = projectSchema.parse(input);
  for (const asset of project.assets) {
    const actual = await getAsset(asset.id);
    if (
      asset.kind !== actual.kind ||
      asset.width !== actual.width ||
      asset.height !== actual.height
    )
      throw new Error('Project asset metadata does not match the imported media.');
  }
  return project;
}

interface InternalJob extends ExportJob {
  project: Project;
  analysis?: Analysis;
  browser?: Browser;
  encoder?: ChildProcess;
}
const jobs = new Map<string, InternalJob>();
let activeJob: string | undefined;
const publicJob = (job: InternalJob): ExportJob => ({
  id: job.id,
  status: job.status,
  progress: job.progress,
  error: job.error,
});
const exportPath = (id: string) => path.join(data, 'exports', `${id}.mp4`);
async function renderVideo(job: InternalJob) {
  let encoderDone: Promise<void> | undefined;
  try {
    job.analysis = await getAnalysis(job.project.audioId!, job.project.pulse.cutoff);
    if (job.status === 'cancelled') return;
    job.status = 'rendering';
    job.browser = await chromium.launch({ headless: true });
    const [width, height] = dimensions(job.project.canvas.format);
    const page = await job.browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`${origin}/?render=${job.id}`);
    await page.waitForFunction(
      () => Boolean((window as any).pumperReady || (window as any).pumperError),
      {},
      { timeout: 120000 },
    );
    const pageError = await page.evaluate(() => (window as any).pumperError);
    if (pageError) throw new Error(pageError);
    if ((job.status as string) === 'cancelled') return;
    const encoder = spawn(
      ffmpeg,
      [
        '-y',
        '-v',
        'error',
        '-f',
        'image2pipe',
        '-framerate',
        '30',
        '-vcodec',
        'png',
        '-i',
        'pipe:0',
        '-i',
        assetPath(job.project.audioId!),
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-t',
        String(job.analysis.duration),
        '-movflags',
        '+faststart',
        exportPath(job.id),
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    job.encoder = encoder;
    let stderr = '';
    encoder.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    encoder.stdin.on('error', () => {});
    encoderDone = new Promise<void>((resolve, reject) => {
      encoder.on('error', reject);
      encoder.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(stderr || 'Video encoding stopped.')),
      );
    });
    void encoderDone.catch(() => {});
    const frames = Math.ceil(job.analysis.duration * 30);
    for (let frame = 0; frame < frames; frame++) {
      if ((job.status as string) === 'cancelled') throw new Error('Cancelled');
      await page.evaluate((t) => (window as any).pumperRender(t), frame / 30);
      const png = await page.screenshot({ type: 'png', timeout: 60000 });
      if (encoder.exitCode !== null || encoder.stdin.destroyed)
        throw new Error(stderr || 'Video encoder stopped.');
      if (!encoder.stdin.write(png))
        await Promise.race([
          once(encoder.stdin, 'drain'),
          encoderDone.then(() => {
            throw new Error('Video encoder ended before all frames were written.');
          }),
        ]);
      job.progress = ((frame + 1) / frames) * 0.97;
    }
    job.status = 'encoding';
    encoder.stdin.end();
    await encoderDone;
    job.status = 'complete';
    job.progress = 1;
  } catch (error) {
    if (job.status !== 'cancelled') {
      job.status = 'failed';
      job.error = errorMessage(error);
    }
  } finally {
    job.encoder?.kill('SIGKILL');
    await job.browser?.close().catch(() => {});
    if (encoderDone) await encoderDone.catch(() => {});
    if (job.status !== 'complete') await fs.rm(exportPath(job.id), { force: true });
    job.browser = undefined;
    job.encoder = undefined;
    job.analysis = undefined;
    activeJob = undefined;
  }
}

const foreground = foregroundService({ root, data, getAsset, assetPath, importAsset });
const app = express();
app.use((req, res, next) => {
  const host = req.hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host))
    return void res.status(403).json({ error: 'Local connections only.' });
  if (req.headers.origin && ![origin, `http://localhost:${port}`].includes(req.headers.origin))
    return void res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  if (
    req.path.startsWith('/api') &&
    !['GET', 'HEAD'].includes(req.method) &&
    req.headers['x-pumper'] !== '1'
  )
    return void res.status(403).json({ error: 'Missing local app request header.' });
  next();
});
app.use(express.json({ limit: '4mb' }));
const upload = multer({
  dest: path.join(data, 'uploads'),
  limits: { fileSize: 256 * 1024 * 1024, files: 1 },
});
const projectUpload = multer({
  dest: path.join(data, 'uploads'),
  limits: { fileSize: 512 * 1024 * 1024, files: 1 },
});
app.get('/api/health', (_req, res) => {
  res.json({
    ffmpeg: ffmpegReady,
    chromium: browserReady(),
    foreground: foreground.ready(),
    maxAudioMinutes: 30,
  });
});
app.post('/api/foreground', async (req, res) => {
  if (typeof req.body.imageId !== 'string') throw new Error('Select an image to separate.');
  res.status(202).json(await foreground.start(req.body.imageId));
});
app.get('/api/foreground/:id', (req, res) => {
  const job = foreground.get(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Foreground job not found.' });
  res.json(job);
});
app.delete('/api/foreground/:id', (req, res) => {
  const job = foreground.cancel(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Foreground job not found.' });
  res.json(job);
});
app.post('/api/assets', upload.single('file'), async (req, res) => {
  if (!req.file) throw new Error('Choose a file to upload.');
  try {
    const kind = req.body.kind;
    if (!['audio', 'image', 'mask'].includes(kind)) throw new Error('Invalid asset type.');
    const asset = await importAsset(req.file.path, req.file.originalname, kind);
    res.json(asset);
  } finally {
    await fs.rm(req.file.path, { force: true });
  }
});
app.get('/api/assets/:id', async (req, res) => {
  const asset = await getAsset(req.params.id);
  res.type(
    asset.kind === 'audio'
      ? /\.wav$/i.test(asset.name)
        ? 'audio/wav'
        : 'audio/mpeg'
      : 'image/png',
  );
  res.sendFile(assetPath(asset.id), { dotfiles: 'allow' });
});
app.get('/api/analysis/:id', async (req, res) => {
  const cutoff = Number(req.query.cutoff || 180);
  if (!Number.isFinite(cutoff) || cutoff < 20 || cutoff > 2000)
    throw new Error('Bass cutoff must be 20–2000 Hz.');
  res.json(await getAnalysis(req.params.id, cutoff));
});
app.post('/api/projects/save', async (req, res) => {
  const project = await validateProject(req.body);
  const entries: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(project)) };
  let archiveBytes = entries['project.json'].length;
  for (const asset of project.assets) {
    archiveBytes += (await fs.stat(assetPath(asset.id))).size;
    if (archiveBytes > 512 * 1024 * 1024 - 65536)
      throw new Error(
        'Portable projects must be smaller than 512 MiB. Remove unused media or use a shorter audio track.',
      );
    entries[`assets/${asset.id}.bin`] = await fs.readFile(assetPath(asset.id));
  }
  res
    .type('application/zip')
    .attachment(`${project.name.replace(/[^a-z0-9 _-]/gi, '') || 'project'}.pumper`)
    .send(Buffer.from(zipSync(entries, { level: 0 })));
});
app.post('/api/projects/open', projectUpload.single('file'), async (req, res) => {
  if (!req.file) throw new Error('Choose a .pumper project.');
  const imported: Asset[] = [];
  try {
    let total = 0;
    const entries = unzipSync(await fs.readFile(req.file.path), {
      filter: (file) => {
        if (!/^(project\.json|assets\/[0-9a-f-]{36}\.bin)$/.test(file.name))
          throw new Error('Project archive contains an invalid path.');
        total += file.originalSize;
        if (total > 512 * 1024 * 1024 || file.originalSize > 256 * 1024 * 1024)
          throw new Error('Project archive is too large.');
        return true;
      },
    });
    if (!entries['project.json']) throw new Error('Project manifest is missing.');
    const project = projectSchema.parse(JSON.parse(strFromU8(entries['project.json'])));
    const mapping = new Map<string, string>();
    for (const asset of project.assets) {
      const bytes = entries[`assets/${asset.id}.bin`];
      if (!bytes) throw new Error(`Missing media: ${asset.name}`);
      const temporary = path.join(data, 'uploads', randomUUID());
      await fs.writeFile(temporary, bytes);
      try {
        const replacement = await importAsset(temporary, asset.name, asset.kind);
        imported.push(replacement);
        mapping.set(asset.id, replacement.id);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    project.assets = imported;
    project.imageId = project.imageId ? mapping.get(project.imageId) : undefined;
    project.audioId = project.audioId ? mapping.get(project.audioId) : undefined;
    for (const layer of project.layers)
      if ((layer.type === 'part' || layer.type === 'foreground') && layer.maskId)
        layer.maskId = mapping.get(layer.maskId);
    res.json(await validateProject(project));
  } catch (error) {
    for (const asset of imported) {
      await fs.rm(assetPath(asset.id), { force: true });
      await fs.rm(metaPath(asset.id), { force: true });
      await fs.rm(path.join(data, 'cache', `${asset.id}.pcm`), { force: true });
    }
    throw error;
  } finally {
    await fs.rm(req.file.path, { force: true });
  }
});
app.post('/api/exports', async (req, res) => {
  if (activeJob)
    return void res
      .status(409)
      .json({ error: 'An export is already running. Wait or cancel it first.' });
  const project = await validateProject(req.body);
  if (!project.imageId || !project.audioId)
    throw new Error('Add an image and audio before exporting.');
  if (!ffmpegReady || !browserReady())
    throw new Error('Export needs FFmpeg and Chromium. Run npm install and npm run setup:browser.');
  if (activeJob) return void res.status(409).json({ error: 'An export is already running.' });
  const job: InternalJob = { id: randomUUID(), project, status: 'queued', progress: 0 };
  jobs.set(job.id, job);
  activeJob = job.id;
  res.status(202).json(publicJob(job));
  void renderVideo(job);
});
app.get('/api/exports/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Export not found.' });
  res.json(publicJob(job));
});
app.get('/api/exports/:id/render', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.analysis) return void res.status(404).json({ error: 'Export not ready.' });
  res.json({ project: job.project, analysis: job.analysis });
});
app.delete('/api/exports/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Export not found.' });
  if (['queued', 'rendering', 'encoding'].includes(job.status)) {
    job.status = 'cancelled';
    job.encoder?.kill('SIGKILL');
    await job.browser?.close().catch(() => {});
  }
  res.json(publicJob(job));
});
app.get('/api/exports/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job?.status !== 'complete')
    return void res.status(404).json({ error: 'Export is not complete.' });
  res.download(
    exportPath(job.id),
    `${job.project.name.replace(/[^a-z0-9 _-]/gi, '') || 'pumper'}.mp4`,
    { dotfiles: 'allow' },
  );
});
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown API endpoint.' });
});
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(root, 'dist/index.html'));
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(errorMessage(error));
  if (!res.headersSent)
    res.status(400).json({
      error: error?.issues
        ? error.issues.map((i: any) => i.message).join('; ')
        : errorMessage(error),
    });
});
const server = app.listen(port, '127.0.0.1', () =>
  console.log(
    `Pumper is ready at ${origin}\nFFmpeg: ${ffmpegReady ? 'ready' : 'missing'} · Chromium: ${browserReady() ? 'ready' : 'run npm run setup:browser'}`,
  ),
);
async function shutdown() {
  foreground.stop();
  for (const worker of workers) worker.kill();
  for (const job of jobs.values()) {
    if (['queued', 'rendering', 'encoding'].includes(job.status)) job.status = 'cancelled';
    job.encoder?.kill('SIGKILL');
    await job.browser?.close().catch(() => {});
    if (job.status !== 'complete') await fs.rm(exportPath(job.id), { force: true });
  }
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
