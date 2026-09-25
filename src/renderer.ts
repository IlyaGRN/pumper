import {
  dimensions,
  type Project,
  type Analysis,
  type ParticleLayer,
  type AnalyzerLayer,
  type PartLayer,
  type ForegroundLayer,
} from './model';
import { sample, pulseScale } from './audio';
import { motionBlurPixels } from './blur';

export interface Cutout {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Resources {
  image?: HTMLImageElement;
  background?: HTMLCanvasElement;
  cutouts: Map<string, Cutout>;
}
const createCanvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};
export const assetUrl = (id: string) => `/api/assets/${id}`;
export async function loadImage(url: string) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}
export async function prepareResources(project: Project): Promise<Resources> {
  const cutouts = new Map<string, Cutout>();
  if (!project.imageId) return { cutouts };
  const image = await loadImage(assetUrl(project.imageId));
  for (const part of project.layers) {
    if (part.type !== 'part' && part.type !== 'foreground') continue;
    const canvas = createCanvas(image.width, image.height),
      ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    let x = 0,
      y = 0,
      right = image.width,
      bottom = image.height;
    if (part.type === 'part' && part.polygon) {
      x = Math.max(0, Math.floor(Math.min(...part.polygon.map((p) => p.x))));
      y = Math.max(0, Math.floor(Math.min(...part.polygon.map((p) => p.y))));
      right = Math.min(image.width, Math.ceil(Math.max(...part.polygon.map((p) => p.x))));
      bottom = Math.min(image.height, Math.ceil(Math.max(...part.polygon.map((p) => p.y))));
      ctx.beginPath();
      part.polygon.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = 'white';
      ctx.fill();
    } else if (part.maskId) {
      const mask = await loadImage(assetUrl(part.maskId));
      if (mask.width !== image.width || mask.height !== image.height)
        throw new Error('Mask dimensions must match the source image.');
      ctx.drawImage(mask, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height),
        data = pixels.data;
      x = image.width;
      y = image.height;
      right = 0;
      bottom = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = Math.round(
          ((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * data[i + 3]) / 255,
        );
        data[i] = data[i + 1] = data[i + 2] = 255;
        data[i + 3] = alpha;
        if (alpha) {
          const px = (i / 4) % image.width,
            py = Math.floor(i / 4 / image.width);
          x = Math.min(x, px);
          y = Math.min(y, py);
          right = Math.max(right, px + 1);
          bottom = Math.max(bottom, py + 1);
        }
      }
      ctx.putImageData(pixels, 0, 0);
    }
    if (right <= x || bottom <= y) continue;
    const blur = part.type === 'part' ? project.pulse.edgeBlur : 0;
    if (blur > 0) {
      // Feather only the alpha mask so image details remain sharp.
      const softened = createCanvas(image.width, image.height);
      const softCtx = softened.getContext('2d')!;
      softCtx.filter = `blur(${blur}px)`;
      softCtx.drawImage(canvas, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(softened, 0, 0);
      // Symmetric padding preserves the region's pulse center and blur falloff.
      const padding = Math.ceil(blur * 3);
      x -= padding;
      y -= padding;
      right += padding;
      bottom += padding;
    }
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(image, 0, 0);
    const width = right - x,
      height = bottom - y;
    if (width <= 0 || height <= 0) continue;
    const cropped = createCanvas(width, height);
    cropped.getContext('2d')!.drawImage(canvas, x, y, width, height, 0, 0, width, height);
    cutouts.set(part.id, { canvas: cropped, x, y, width, height });
  }
  const foreground = project.layers.find((l) => l.type === 'foreground' && l.visible);
  const background =
    project.canvas.motionBlur > 0
      ? prepareBackground(
          image,
          foreground ? cutouts.get(foreground.id) : undefined,
          project.canvas.motionBlur,
          project.canvas.motionBlurAngle,
        )
      : undefined;
  return { image, cutouts, background };
}
// Build once per settings change, shared by preview and export. Blur only the
// background's premultiplied colors, then normalize coverage at mask/image edges.
function prepareBackground(
  image: HTMLImageElement,
  foreground: Cutout | undefined,
  amount: number,
  angle: number,
) {
  const source = createCanvas(image.width, image.height);
  const sourceCtx = source.getContext('2d')!;
  sourceCtx.drawImage(image, 0, 0);
  if (foreground) {
    sourceCtx.globalCompositeOperation = 'destination-out';
    sourceCtx.drawImage(foreground.canvas, foreground.x, foreground.y);
  }
  const blurred = createCanvas(image.width, image.height);
  const ctx = blurred.getContext('2d', { willReadFrequently: true })!;
  const pixels = sourceCtx.getImageData(0, 0, source.width, source.height);
  const filtered = motionBlurPixels(pixels.data, source.width, source.height, amount, angle);
  ctx.putImageData(new ImageData(filtered, source.width, source.height), 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(image, 0, 0);
  // Original pixels fill fully occluded areas for later layer visibility/order edits.
  sourceCtx.globalCompositeOperation = 'source-over';
  sourceCtx.clearRect(0, 0, source.width, source.height);
  sourceCtx.drawImage(image, 0, 0);
  sourceCtx.drawImage(blurred, 0, 0);
  return source;
}
export function imageTransform(
  project: Project,
  image: { width: number; height: number },
  width: number,
  height: number,
) {
  const fit = project.canvas.fit === 'fill' ? Math.max : Math.min;
  const scale = fit(width / image.width, height / image.height) * project.canvas.zoom;
  return {
    scale,
    x: (width - image.width * scale) / 2 + project.canvas.offsetX * width,
    y: (height - image.height * scale) / 2 + project.canvas.offsetY * height,
  };
}
function drawPart(
  ctx: CanvasRenderingContext2D,
  cutout: Cutout,
  project: Project,
  analysis: Analysis | undefined,
  time: number,
) {
  const { x, y, width, height, canvas } = cutout;
  const draw = (t: number, opacity: number) => {
    const scale = pulseScale(
      project.pulse.maxScale,
      analysis ? sample(analysis.envelope, t, analysis.fps) : 0,
    );
    ctx.globalAlpha = opacity;
    ctx.drawImage(
      canvas,
      x + width / 2 - (width * scale) / 2,
      y + height / 2 - (height * scale) / 2,
      width * scale,
      height * scale,
    );
  };
  if (project.pulse.trailDelay > 0)
    for (let i = project.pulse.trailCopies; i >= 1; i--) {
      const t = time - i * project.pulse.trailDelay;
      if (t >= 0) draw(t, project.pulse.trailOpacity * (1 - i / (project.pulse.trailCopies + 1)));
    }
  draw(time, 1);
}
export function seeded(seed: number, index: number) {
  let n = (seed ^ Math.imul(index + 1, 0x45d9f3b)) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
const wrap = (n: number) => ((n % 1) + 1) % 1;
export function particleAt(layer: ParticleLayer, index: number, time: number, loudness: number) {
  const random = (i: number) => seeded(layer.seed, index * 7 + i);
  const phase = random(2) * Math.PI * 2,
    speed = (0.025 + random(3) * 0.055) * layer.speed;
  let x = random(0),
    y = random(1);
  if (layer.mode === 'rise') y = wrap(y - time * speed);
  if (layer.mode === 'fall') y = wrap(y + time * speed);
  x += Math.sin(time * (0.4 + layer.speed) + phase) * 0.025 * layer.motion;
  if (layer.mode === 'shimmer')
    y += Math.cos(time * (1 + layer.speed) + phase) * 0.015 * layer.motion;
  const shimmer =
    layer.mode === 'shimmer'
      ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time * (1 + layer.speed * 2) + phase))
      : 1;
  return {
    x,
    y,
    radius: layer.size * (0.4 + random(4) * 0.6) * (layer.audioResponse ? 1 + loudness : 1),
    opacity: Math.min(1, layer.opacity * shimmer * (layer.audioResponse ? 0.5 + loudness : 1)),
  };
}
function drawParticles(
  ctx: CanvasRenderingContext2D,
  layer: ParticleLayer,
  width: number,
  height: number,
  time: number,
  loudness: number,
) {
  ctx.fillStyle = layer.color;
  for (let i = 0; i < layer.density; i++) {
    const p = particleAt(layer, i, time, loudness);
    ctx.globalAlpha = p.opacity;
    ctx.beginPath();
    ctx.arc(p.x * width, p.y * height, p.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}
const palettes = {
  mint: ['#6dcab0', '#dbffbf'],
  sunset: ['#ff8465', '#c683fd'],
  ice: ['#74a6ff', '#c5fbff'],
};
function drawAnalyzer(
  ctx: CanvasRenderingContext2D,
  layer: AnalyzerLayer,
  width: number,
  height: number,
  spectrum: number[],
) {
  const x = layer.x * width,
    y = layer.y * height,
    w = layer.width * width,
    h = layer.height * height;
  ctx.globalAlpha = layer.opacity;
  if (layer.palette === 'mono') ctx.fillStyle = ctx.strokeStyle = layer.color;
  else {
    const colors = palettes[layer.palette],
      grad = ctx.createLinearGradient(x - w / 2, y, x + w / 2, y - h);
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(1, colors[1]);
    ctx.fillStyle = ctx.strokeStyle = grad;
  }
  ctx.lineWidth = (layer.thickness * width) / 1920;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const values = Array.from({ length: 64 }, (_, i) =>
    Math.min(1, (spectrum[i] || 0) * layer.sensitivity),
  );
  if (layer.style === 'line') {
    ctx.beginPath();
    values.forEach((v, i) => {
      const px = x - w / 2 + (i / 63) * w,
        py = y - v * h;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  } else if (layer.style === 'radial') {
    const radius = Math.min(w, h) * 0.3;
    values.forEach((v, i) => {
      const angle = (i / 64) * Math.PI * 2 - Math.PI / 2,
        end = radius + v * Math.min(w, h) * 0.4;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
      ctx.lineTo(x + Math.cos(angle) * end, y + Math.sin(angle) * end);
      ctx.stroke();
    });
  } else {
    values.forEach((v, i) => {
      const barHeight = Math.max(1, v * h),
        barWidth = Math.min((w / 64) * 0.85, ((layer.thickness * width) / 1920) * 2);
      ctx.fillRect(
        x - w / 2 + ((i + 0.5) * w) / 64 - barWidth / 2,
        y - barHeight,
        barWidth,
        barHeight * (layer.style === 'mirror' ? 2 : 1),
      );
    });
  }
}
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  resources: Resources,
  analysis: Analysis | undefined,
  time: number,
) {
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = project.canvas.background;
  ctx.fillRect(0, 0, width, height);
  const image = resources.image,
    transform = image ? imageTransform(project, image, width, height) : undefined;
  if (image && transform)
    ctx.drawImage(
      resources.background || image,
      transform.x,
      transform.y,
      image.width * transform.scale,
      image.height * transform.scale,
    );
  const loudness = analysis ? sample(analysis.loudness, time, analysis.fps) : 0;
  const spectrum =
    analysis?.spectrum[Math.min(Math.floor(time * 30), analysis.spectrum.length - 1)] || [];
  for (const layer of project.layers) {
    if (!layer.visible) continue;
    ctx.save();
    if ((layer.type === 'part' || layer.type === 'foreground') && transform) {
      const cutout = resources.cutouts.get(layer.id);
      if (cutout) {
        ctx.translate(transform.x, transform.y);
        ctx.scale(transform.scale, transform.scale);
        if (layer.type === 'foreground') ctx.drawImage(cutout.canvas, cutout.x, cutout.y);
        else drawPart(ctx, cutout, project, analysis, time);
      }
    } else if (layer.type === 'particles') drawParticles(ctx, layer, width, height, time, loudness);
    else if (layer.type === 'analyzer') drawAnalyzer(ctx, layer, width, height, spectrum);
    ctx.restore();
  }
  ctx.restore();
}
export function resourceKey(project: Project) {
  return JSON.stringify([
    project.imageId,
    project.pulse.edgeBlur,
    project.canvas.motionBlur,
    project.canvas.motionBlurAngle,
    project.layers
      .filter((l): l is PartLayer | ForegroundLayer => l.type === 'part' || l.type === 'foreground')
      .map((l) => [l.id, l.maskId, l.type === 'part' ? l.polygon : l.visible]),
  ]);
}
export function setExportSize(canvas: HTMLCanvasElement, project: Project) {
  [canvas.width, canvas.height] = dimensions(project.canvas.format);
}
