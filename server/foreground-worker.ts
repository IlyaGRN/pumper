import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { availableParallelism } from 'node:os';
import { modelPath } from './foreground-model';

process.once('message', async (message: { input: string; output: string }) => {
  let session: ort.InferenceSession | undefined;
  try {
    process.send?.({ status: 'loading' });
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      intraOpNumThreads: Math.min(4, availableParallelism()),
      interOpNumThreads: 1,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
    });
    const size = 1024;
    const metadata = await sharp(message.input).metadata();
    const rgb = await sharp(message.input)
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .resize(size, size, { fit: 'fill', kernel: 'linear' })
      .removeAlpha()
      .raw()
      .toBuffer();
    const input = new Float32Array(3 * size * size);
    const mean = [0.485, 0.456, 0.406],
      deviation = [0.229, 0.224, 0.225];
    for (let i = 0; i < size * size; i++)
      for (let channel = 0; channel < 3; channel++)
        input[channel * size * size + i] =
          (rgb[i * 3 + channel] / 255 - mean[channel]) / deviation[channel];
    process.send?.({ status: 'separating' });
    const result = await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]),
    });
    const output = result[session.outputNames.at(-1)!];
    const height = Number(output.dims.at(-2)),
      width = Number(output.dims.at(-1));
    if (!width || !height || output.data.length !== width * height)
      throw new Error('Unexpected BiRefNet output shape.');
    const mask = Buffer.alloc(width * height);
    for (let i = 0; i < mask.length; i++) {
      const logit = Number(output.data[i]);
      if (!Number.isFinite(logit)) throw new Error('BiRefNet produced invalid mask values.');
      mask[i] = Math.round(255 / (1 + Math.exp(-logit)));
    }
    await sharp(mask, { raw: { width, height, channels: 1 } })
      .resize(metadata.width!, metadata.height!, { fit: 'fill', kernel: 'linear' })
      .png()
      .toFile(message.output);
    process.send?.({ status: 'complete' });
  } catch (error) {
    process.send?.({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await session?.release();
    process.disconnect();
  }
});
