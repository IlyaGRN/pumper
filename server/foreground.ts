import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Asset, ForegroundJob } from '../src/model';
import { modelPath, modelSha256 } from './foreground-model';

type InternalJob = ForegroundJob & { worker?: ChildProcess };
export function foregroundService(options: {
  root: string;
  data: string;
  getAsset: (id: string) => Promise<Asset>;
  assetPath: (id: string) => string;
  importAsset: (file: string, name: string, kind: Asset['kind']) => Promise<Asset>;
}) {
  const jobs = new Map<string, InternalJob>();
  let active: InternalJob | undefined;
  const publicJob = ({ worker: _, ...job }: InternalJob): ForegroundJob => job;
  const cancelled = (job: InternalJob) => job.status === 'cancelled';
  const ready = () => existsSync(modelPath);
  async function processJob(job: InternalJob) {
    const output = path.join(options.data, 'uploads', `${job.id}-foreground.png`);
    const cache = path.join(options.data, 'cache', `${job.imageId}-foreground-${modelSha256}.json`);
    try {
      const cached = await fs
        .readFile(cache, 'utf8')
        .then(JSON.parse)
        .catch(() => undefined);
      if (cached?.id) {
        const mask = await options.getAsset(cached.id).catch(() => undefined);
        if (mask?.kind === 'mask' && existsSync(options.assetPath(mask.id))) {
          if (!cancelled(job)) {
            job.mask = mask;
            job.status = 'complete';
          }
          return;
        }
      }
      if (cancelled(job)) return;
      await new Promise<void>((resolve, reject) => {
        const worker = fork(path.join(options.root, 'server/foreground-worker.ts'), [], {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        job.worker = worker;
        let complete = false,
          detail = '',
          failure = '';
        const timer = setTimeout(
          () => {
            failure =
              'CPU separation timed out after 15 minutes. Try again with other CPU tasks stopped.';
            worker.kill('SIGKILL');
          },
          15 * 60 * 1000,
        );
        worker.stderr?.on('data', (chunk) => {
          detail = (detail + chunk).slice(-2000);
        });
        worker.on('message', (message: { status: ForegroundJob['status']; error?: string }) => {
          if (message.status === 'complete') complete = true;
          else if (message.status === 'failed')
            failure = message.error || 'BiRefNet inference failed.';
          else if (!cancelled(job) && ['loading', 'separating'].includes(message.status))
            job.status = message.status;
        });
        worker.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.on('exit', (code) => {
          clearTimeout(timer);
          if (complete && code === 0) resolve();
          else
            reject(
              new Error(failure || `BiRefNet CPU worker stopped (${code}). ${detail.slice(-500)}`),
            );
        });
        worker.send({ input: options.assetPath(job.imageId), output });
      });
      if (cancelled(job)) return;
      const mask = await options.importAsset(output, 'BiRefNet foreground.png', 'mask');
      await fs.writeFile(cache, JSON.stringify(mask));
      if (!cancelled(job)) {
        job.mask = mask;
        job.status = 'complete';
      }
    } catch (error) {
      if (!cancelled(job)) {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      await fs.rm(output, { force: true }).catch(() => {});
      job.worker = undefined;
      if (active === job) active = undefined;
    }
  }
  return {
    ready,
    async start(imageId: string) {
      const image = await options.getAsset(imageId);
      if (image.kind !== 'image') throw new Error('Select a source image to separate.');
      if (active) {
        if (active.imageId === imageId && !cancelled(active)) return publicJob(active);
        throw new Error(
          'A foreground separation is already running. Wait for it to finish or cancel it.',
        );
      }
      if (!ready())
        throw new Error(
          'BiRefNet model is not installed. Run npm run setup:foreground, then try again.',
        );
      // Bound terminal job history without discarding the active job.
      if (jobs.size >= 50) jobs.delete(jobs.keys().next().value!);
      const job: InternalJob = { id: randomUUID(), imageId, status: 'loading' };
      jobs.set(job.id, job);
      active = job;
      void processJob(job);
      return publicJob(job);
    },
    get(id: string) {
      const job = jobs.get(id);
      return job ? publicJob(job) : undefined;
    },
    cancel(id: string) {
      const job = jobs.get(id);
      if (!job) return undefined;
      if (['loading', 'separating'].includes(job.status)) {
        job.status = 'cancelled';
        job.worker?.kill('SIGKILL');
      }
      return publicJob(job);
    },
    stop() {
      if (active) {
        active.status = 'cancelled';
        active.worker?.kill('SIGKILL');
      }
    },
  };
}
