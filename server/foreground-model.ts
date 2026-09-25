import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const modelFilename = 'birefnet-lite.onnx';
export const modelSha256 = '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333';
export const modelUrl =
  'https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx';
export const modelPath = path.join(
  path.resolve(
    process.env.PUMPER_DATA_DIR || fileURLToPath(new URL('../.pumper-data', import.meta.url)),
  ),
  'models',
  modelFilename,
);
