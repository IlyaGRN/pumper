import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { modelPath, modelSha256, modelUrl } from '../server/foreground-model';

async function checksum(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
if (
  await checksum(modelPath)
    .then((hash) => hash === modelSha256)
    .catch(() => false)
) {
  console.log(`BiRefNet CPU model is ready: ${modelPath}`);
} else {
  await fs.mkdir(path.dirname(modelPath), { recursive: true });
  const temporary = `${modelPath}.${process.pid}.download`;
  try {
    console.log('Downloading the official BiRefNet lite model (224 MB)…');
    const response = await fetch(modelUrl, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body)
      throw new Error(`Model download failed (${response.status}).`);
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(temporary));
    if ((await checksum(temporary)) !== modelSha256)
      throw new Error('Model checksum mismatch. Please retry setup.');
    await fs.rename(temporary, modelPath);
    console.log(`BiRefNet CPU model is ready: ${modelPath}`);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
