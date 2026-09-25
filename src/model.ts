import { z } from 'zod';

const id = z.string().uuid();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const point = z.object({ x: num(0, 20000), y: num(0, 20000) });
const asset = z.object({
  id,
  name: z.string().min(1).max(240),
  kind: z.enum(['image', 'audio', 'mask']),
  width: z.number().int().positive().max(12000).optional(),
  height: z.number().int().positive().max(12000).optional(),
  duration: num(0, 36000).optional(),
});
const base = { id, name: z.string().min(1).max(100), visible: z.boolean() };
const part = z
  .object({
    ...base,
    type: z.literal('part'),
    polygon: z.array(point).min(3).max(1000).optional(),
    maskId: id.optional(),
  })
  .refine(
    (p) => Boolean(p.polygon) !== Boolean(p.maskId),
    'A part requires either a polygon or mask',
  );
const foreground = z.object({
  ...base,
  type: z.literal('foreground'),
  maskId: id,
});
const particles = z.object({
  ...base,
  type: z.literal('particles'),
  mode: z.enum(['rise', 'fall', 'shimmer']),
  size: num(1, 40),
  density: z.number().int().min(1).max(600),
  color,
  opacity: num(0, 1),
  speed: num(0, 3),
  motion: num(0, 2),
  audioResponse: z.boolean(),
  seed: z.number().int().nonnegative(),
});
const analyzer = z.object({
  ...base,
  type: z.literal('analyzer'),
  style: z.enum(['bars', 'mirror', 'line', 'radial']),
  x: num(0, 1),
  y: num(0, 1),
  width: num(0.05, 1),
  height: num(0.05, 1),
  opacity: num(0, 1),
  palette: z.enum(['mint', 'sunset', 'ice', 'mono']),
  color,
  sensitivity: num(0.1, 4),
  thickness: num(1, 12),
});
export const projectSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(100),
    assets: z.array(asset).max(100),
    imageId: id.optional(),
    audioId: id.optional(),
    canvas: z.object({
      format: z.enum(['landscape', 'portrait', 'square']),
      fit: z.enum(['fit', 'fill']),
      background: color,
      offsetX: num(-1, 1),
      offsetY: num(-1, 1),
      zoom: num(0.25, 3),
      motionBlur: num(0, 100).default(0),
      motionBlurAngle: num(-180, 180).default(0),
    }),
    pulse: z.object({
      maxScale: num(1, 3),
      edgeBlur: num(0, 50).default(0),
      cutoff: num(20, 2000),
      trailDelay: num(0, 0.5),
      trailOpacity: num(0, 0.8),
      trailCopies: z.number().int().min(0).max(8),
    }),
    layers: z.array(z.union([part, foreground, particles, analyzer])).max(100),
  })
  .superRefine((p, ctx) => {
    const ids = p.assets.map((a) => a.id);
    const layerIds = p.layers.map((a) => a.id);
    if (new Set(ids).size !== ids.length || new Set(layerIds).size !== layerIds.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate IDs' });
    if (p.imageId && !p.assets.some((a) => a.id === p.imageId && a.kind === 'image'))
      ctx.addIssue({ code: 'custom', message: 'Missing image asset' });
    if (p.audioId && !p.assets.some((a) => a.id === p.audioId && a.kind === 'audio'))
      ctx.addIssue({ code: 'custom', message: 'Missing audio asset' });
    const image = p.assets.find((a) => a.id === p.imageId);
    if (p.layers.filter((l) => l.type === 'foreground').length > 1)
      ctx.addIssue({ code: 'custom', message: 'Only one foreground layer is supported' });
    for (const l of p.layers)
      if (l.type === 'part' || l.type === 'foreground') {
        if (!image?.width || !image.height)
          ctx.addIssue({ code: 'custom', message: 'Parts require an image' });
        if (
          l.type === 'part' &&
          l.polygon &&
          image &&
          l.polygon.some((v) => v.x > image.width! || v.y > image.height!)
        )
          ctx.addIssue({ code: 'custom', message: 'Polygon outside image' });
        if (
          l.maskId &&
          !p.assets.some(
            (a) =>
              a.id === l.maskId &&
              a.kind === 'mask' &&
              a.width === image?.width &&
              a.height === image?.height,
          )
        )
          ctx.addIssue({ code: 'custom', message: 'Mask dimensions must match the image' });
      }
  });
export type Project = z.infer<typeof projectSchema>;
export type Asset = Project['assets'][number];
export type Layer = Project['layers'][number];
export type PartLayer = Extract<Layer, { type: 'part' }>;
export type ParticleLayer = Extract<Layer, { type: 'particles' }>;
export type AnalyzerLayer = Extract<Layer, { type: 'analyzer' }>;
export type Point = z.infer<typeof point>;
export interface Analysis {
  duration: number;
  fps: number;
  envelope: number[];
  loudness: number[];
  spectrum: number[][];
  waveform: number[];
}
export interface ForegroundJob {
  id: string;
  imageId: string;
  status: 'loading' | 'separating' | 'complete' | 'failed' | 'cancelled';
  mask?: Asset;
  error?: string;
}
export type ForegroundLayer = Extract<Layer, { type: 'foreground' }>;
// New particles sit behind the foreground; users can still explicitly reorder layers.
export function insertLayer(layers: Layer[], next: Layer): Layer[] {
  const foregroundIndex = layers.findIndex((layer) => layer.type === 'foreground');
  const index = next.type === 'particles' && foregroundIndex >= 0 ? foregroundIndex : layers.length;
  return [...layers.slice(0, index), next, ...layers.slice(index)];
}
export interface ExportJob {
  id: string;
  status: 'queued' | 'rendering' | 'encoding' | 'complete' | 'cancelled' | 'failed';
  progress: number;
  error?: string;
}
export const dimensions = (format: Project['canvas']['format']): [number, number] =>
  format === 'landscape' ? [1920, 1080] : format === 'portrait' ? [1080, 1920] : [1080, 1080];
export const initialProject = (): Project => ({
  version: 1,
  name: 'Untitled session',
  assets: [],
  canvas: {
    format: 'landscape',
    fit: 'fill',
    background: '#101318',
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
    motionBlur: 0,
    motionBlurAngle: 0,
  },
  pulse: {
    maxScale: 1.2,
    edgeBlur: 0,
    cutoff: 180,
    trailDelay: 0.06,
    trailOpacity: 0.2,
    trailCopies: 3,
  },
  layers: [],
});
export const newParticles = (): ParticleLayer => ({
  id: crypto.randomUUID(),
  name: 'Floating dust',
  type: 'particles',
  visible: true,
  mode: 'rise',
  size: 3,
  density: 100,
  color: '#ccf6dc',
  opacity: 0.55,
  speed: 1,
  motion: 0.5,
  audioResponse: false,
  seed: 12345,
});
export const newAnalyzer = (): AnalyzerLayer => ({
  id: crypto.randomUUID(),
  name: 'Frequency spectrum',
  type: 'analyzer',
  visible: true,
  style: 'bars',
  x: 0.5,
  y: 0.8,
  width: 0.7,
  height: 0.2,
  opacity: 0.8,
  palette: 'mint',
  color: '#b8f5cf',
  sensitivity: 1,
  thickness: 3,
});
