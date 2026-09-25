import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  initialProject,
  newParticles,
  newAnalyzer,
  insertLayer,
  dimensions,
  type Project,
  type Layer,
  type Point,
  type Asset,
  type Analysis,
  type ExportJob,
  type ForegroundJob,
} from './model';
import {
  assetUrl,
  prepareResources,
  renderFrame,
  resourceKey,
  imageTransform,
  setExportSize,
  type Resources,
} from './renderer';
import '@fontsource-variable/inter';
import './style.css';

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'X-Pumper': '1',
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json();
}
async function upload(file: File, kind: Asset['kind']) {
  const form = new FormData();
  form.append('file', file);
  form.append('kind', kind);
  return api<Asset>('/api/assets', { method: 'POST', body: form });
}
const timeLabel = (time: number) =>
  `${Math.floor(time / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(time % 60)
    .toString()
    .padStart(2, '0')}`;
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    pulse: <path d="M2 12h4l3-8 5 16 3-8h5" />,
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8" cy="8" r="1.5" />
        <path d="m3 17 6-6 4 4 3-3 5 5" />
      </>
    ),
    music: (
      <>
        <path d="M9 18V5l12-2v13M9 8l12-2" />
        <ellipse cx="6" cy="18" rx="3" ry="3" />
        <ellipse cx="18" cy="16" rx="3" ry="3" />
      </>
    ),
    polygon: (
      <>
        <path d="m5 4 14 2 2 12-12 3L3 12Z" />
        <path d="M5 2v4M3 4h4m12 0v4m-2-2h4M7 21h4" />
      </>
    ),
    particles: (
      <>
        <path d="m12 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" />
        <path d="M20 17v6m-3-3h6" />
      </>
    ),
    analyzer: <path d="M3 14v6m4-11v11m5-17v17m5-13v13m4-8v8" />,
    play: <path d="m8 4 13 8-13 8Z" />,
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    hidden: (
      <>
        <path d="M3 3l18 18M9 5c7-2 13 7 13 7s-2 4-6 6M6 6c-3 2-4 6-4 6s4 7 10 7" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
      </>
    ),
    undo: <path d="m9 4-6 6 6 6M3 10h10a7 7 0 0 1 7 7v3" />,
    redo: <path d="m15 4 6 6-6 6m6-6h-10a7 7 0 0 0-7 7v3" />,
    save: (
      <>
        <path d="M4 3h13l4 4v14H3V3ZM7 3v6h10V3M7 21v-8h10v8" />
      </>
    ),
    folder: <path d="M3 7V4h7l3 3h8v14H3ZM3 10h18" />,
    arrow: <path d="M12 3v18m-7-7 7 7 7-7" />,
    close: <path d="m5 5 14 14M5 19 19 5" />,
    plus: <path d="M12 4v16M4 12h16" />,
    check: <path d="m4 12 5 5L20 6" />,
    back: <path d="M5 4v16M19 4 7 12l12 8Z" />,
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.pulse}
    </svg>
  );
}
function Range({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format = (v) => String(v),
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="control range-control">
      <span>
        {label}
        <output>{format(value)}</output>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: any) => void;
}) {
  return (
    <label className="control">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function Color({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <label className="control color-control">
      <span>{label}</span>
      <span>
        <input
          aria-label={label}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <code>{value.toUpperCase()}</code>
      </span>
    </label>
  );
}
function Section({
  title,
  children,
  caption,
}: {
  title: string;
  children: ReactNode;
  caption?: string;
}) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {caption && <p className="caption">{caption}</p>}
      {children}
    </section>
  );
}

function useHistory() {
  const [project, setProject] = useState(initialProject),
    past = useRef<Project[]>([]),
    future = useRef<Project[]>([]),
    ref = useRef(project);
  const commit = useCallback((change: Project | ((p: Project) => Project)) => {
    const next = typeof change === 'function' ? change(ref.current) : change;
    if (JSON.stringify(next) === JSON.stringify(ref.current)) return;
    past.current = [...past.current.slice(-79), ref.current];
    future.current = [];
    ref.current = next;
    setProject(next);
  }, []);
  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (previous) {
      future.current.push(ref.current);
      ref.current = previous;
      setProject(previous);
    }
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next) {
      past.current.push(ref.current);
      ref.current = next;
      setProject(next);
    }
  }, []);
  const reset = (next: Project) => {
    past.current = [];
    future.current = [];
    ref.current = next;
    setProject(next);
  };
  return {
    project,
    commit,
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}

function App() {
  const { project, commit, undo, redo, reset, canUndo, canRedo } = useHistory();
  const [selected, setSelected] = useState('canvas'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState('');
  const [resources, setResources] = useState<Resources>({ cutouts: new Map() }),
    [readyKey, setReadyKey] = useState('');
  const [analysisState, setAnalysisState] = useState<{ key: string; data: Analysis }>(),
    [analyzing, setAnalyzing] = useState(false);
  const [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [tool, setTool] = useState<'select' | 'polygon'>('select');
  const [draft, setDraft] = useState<Point[]>([]),
    [editedPolygon, setEditedPolygon] = useState<Point[] | undefined>();
  const drag = useRef<number | null>(null),
    editRef = useRef<Point[] | undefined>(undefined);
  const [job, setJob] = useState<ExportJob>(),
    [exportOpen, setExportOpen] = useState(false),
    [health, setHealth] = useState<{ ffmpeg: boolean; chromium: boolean; foreground: boolean }>();
  const [foregroundJob, setForegroundJob] = useState<ForegroundJob>();
  const [saved, setSaved] = useState(JSON.stringify(initialProject())),
    [pendingImage, setPendingImage] = useState<Asset>();
  const canvas = useRef<HTMLCanvasElement>(null),
    audio = useRef<HTMLAudioElement>(null),
    waveform = useRef<HTMLCanvasElement>(null);
  const imageInput = useRef<HTMLInputElement>(null),
    audioInput = useRef<HTMLInputElement>(null),
    maskInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null);
  const imageAsset = project.assets.find((a) => a.id === project.imageId),
    audioAsset = project.assets.find((a) => a.id === project.audioId);
  const layer = project.layers.find((l) => l.id === selected),
    [width, height] = dimensions(project.canvas.format);
  const key = resourceKey(project),
    analysisKey = `${project.audioId}-${project.pulse.cutoff}`;
  const analysis = analysisState?.key === analysisKey ? analysisState.data : undefined;
  const duration = analysis?.duration || audioAsset?.duration || 0,
    dirty = JSON.stringify(project) !== saved;
  const exportRunning = job && ['queued', 'rendering', 'encoding'].includes(job.status);

  useEffect(() => {
    api<typeof health>('/api/health')
      .then(setHealth)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    let current = true;
    prepareResources(project)
      .then((next) => {
        if (current) {
          setResources(next);
          setReadyKey(key);
        }
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [key]);
  useEffect(() => {
    if (!project.audioId) {
      setAnalysisState(undefined);
      setAnalyzing(false);
      return;
    }
    const controller = new AbortController();
    setAnalyzing(true);
    const timer = setTimeout(
      () =>
        api<Analysis>(`/api/analysis/${project.audioId}?cutoff=${project.pulse.cutoff}`, {
          signal: controller.signal,
        })
          .then((data) => {
            setAnalysisState({ key: analysisKey, data });
            setAnalyzing(false);
          })
          .catch((e) => {
            if (!controller.signal.aborted) {
              setError(e.message);
              setAnalyzing(false);
            }
          }),
      250,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [analysisKey]);
  useEffect(() => {
    if (canvas.current && readyKey === key)
      renderFrame(
        canvas.current.getContext('2d')!,
        project,
        resources,
        analysis,
        tool === 'polygon' || editedPolygon ? 0 : time,
      );
  }, [project, resources, analysis, time, readyKey, tool, editedPolygon]);
  useEffect(() => {
    let frame: number;
    const tick = () => {
      if (audio.current && playing) setTime(audio.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    if (playing) frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => {
    audio.current?.pause();
    setPlaying(false);
    setTime(0);
  }, [project.audioId]);
  useEffect(() => {
    const c = waveform.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!analysis) return;
    analysis.waveform.forEach((v, i) => {
      ctx.fillStyle = i / analysis.waveform.length <= time / duration ? '#c7efaa' : '#414850';
      const x = (i / analysis.waveform.length) * c.width;
      ctx.fillRect(
        x,
        (c.height - v * 46) / 2,
        Math.max(1, c.width / analysis.waveform.length - 0.5),
        Math.max(2, v * 46),
      );
    });
  }, [analysis, time, duration]);
  useEffect(() => {
    if (!job || !['queued', 'rendering', 'encoding'].includes(job.status)) return;
    const timer = setInterval(
      () =>
        api<ExportJob>(`/api/exports/${job.id}`)
          .then(setJob)
          .catch((e) => setError(e.message)),
      700,
    );
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (!foregroundJob) return;
    let current = true,
      polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await api<ForegroundJob>(`/api/foreground/${foregroundJob.id}`);
        if (!current) return;
        if (next.status === 'complete' && next.mask) {
          const mask = next.mask;
          commit((p) =>
            p.imageId !== next.imageId
              ? p
              : {
                  ...p,
                  assets: p.assets.some((a) => a.id === mask.id) ? p.assets : [...p.assets, mask],
                  layers: [
                    ...p.layers.filter((l) => l.type !== 'foreground'),
                    {
                      id: crypto.randomUUID(),
                      type: 'foreground',
                      name: 'Foreground',
                      visible: true,
                      maskId: mask.id,
                    },
                  ],
                },
          );
          setNotice('Foreground separation finished. The result is placed above the other layers.');
          setForegroundJob(undefined);
        } else if (next.status === 'failed' || next.status === 'cancelled') {
          if (next.error) setError(next.error);
          setForegroundJob(undefined);
        } else setForegroundJob(next);
      } catch (e) {
        if (current) {
          setError((e as Error).message);
          setForegroundJob(undefined);
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, 1000);
    void poll();
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [foregroundJob?.id, commit]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || exportRunning || foregroundJob) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, exportRunning, foregroundJob]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).matches('input,select,textarea') ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (event.code === 'Space') {
        event.preventDefault();
        void togglePlayback();
      } else if (event.key === 'Escape') {
        setDraft([]);
        setTool('select');
      } else if (event.key === 'Enter' && tool === 'polygon') finishPolygon();
      else if (event.key === 'Backspace' && tool === 'polygon') {
        event.preventDefault();
        setDraft((points) => points.slice(0, -1));
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const patchLayer = (values: Partial<Layer>) =>
    commit((p) => ({
      ...p,
      layers: p.layers.map((l) => (l.id === selected ? ({ ...l, ...values } as Layer) : l)),
    }));
  const patchPulse = (values: Partial<Project['pulse']>) =>
    commit((p) => ({ ...p, pulse: { ...p.pulse, ...values } }));
  const patchCanvas = (values: Partial<Project['canvas']>) =>
    commit((p) => ({ ...p, canvas: { ...p.canvas, ...values } }));
  const select = (id: string) => {
    setSelected(id);
    setTool('select');
    setDraft([]);
    setEditedPolygon(undefined);
    if (project.layers.find((l) => l.id === id)?.type === 'part') {
      audio.current?.pause();
      seek(0);
    }
  };
  function addLayer(next: Layer) {
    commit((p) => ({ ...p, layers: insertLayer(p.layers, next) }));
    select(next.id);
  }
  function changeImage(asset: Asset) {
    if (foregroundJob) {
      void api(`/api/foreground/${foregroundJob.id}`, { method: 'DELETE' }).catch(() => {});
      setForegroundJob(undefined);
    }
    commit((p) => ({
      ...p,
      imageId: asset.id,
      assets: [...p.assets.filter((a) => a.kind === 'audio'), asset],
      layers: p.layers.filter((l) => l.type !== 'part' && l.type !== 'foreground'),
    }));
    setPendingImage(undefined);
    select('canvas');
  }
  async function importFile(file: File | undefined, kind: Asset['kind']) {
    if (!file) return;
    await run(`Importing ${kind}…`, async () => {
      const asset = await upload(file, kind);
      if (kind === 'image') {
        if (project.layers.some((l) => l.type === 'part' || l.type === 'foreground'))
          setPendingImage(asset);
        else changeImage(asset);
      }
      if (kind === 'audio')
        commit((p) => ({
          ...p,
          audioId: asset.id,
          assets: [...p.assets.filter((a) => a.kind !== 'audio'), asset],
        }));
      if (kind === 'mask') {
        if (!imageAsset || asset.width !== imageAsset.width || asset.height !== imageAsset.height)
          throw new Error(
            `Mask must match the source image (${imageAsset?.width} × ${imageAsset?.height} pixels). White selects; black excludes.`,
          );
        const next: Layer = {
          id: crypto.randomUUID(),
          type: 'part',
          name: file.name.replace(/\.[^.]+$/, ''),
          visible: true,
          maskId: asset.id,
        };
        commit((p) => ({ ...p, assets: [...p.assets, asset], layers: [...p.layers, next] }));
        select(next.id);
      }
    });
  }
  async function separateForeground() {
    if (!project.imageId) return;
    await run('Starting foreground separation…', async () => {
      const next = await api<ForegroundJob>('/api/foreground', {
        method: 'POST',
        body: JSON.stringify({ imageId: project.imageId }),
      });
      setForegroundJob(next);
    });
  }
  async function cancelForeground() {
    if (!foregroundJob) return;
    await run('Cancelling separation…', async () => {
      await api(`/api/foreground/${foregroundJob.id}`, { method: 'DELETE' });
      setForegroundJob(undefined);
    });
  }
  function finishPolygon() {
    if (draft.length < 3) return;
    const area =
      Math.abs(
        draft.reduce((sum, p, i) => {
          const next = draft[(i + 1) % draft.length];
          return sum + p.x * next.y - next.x * p.y;
        }, 0),
      ) / 2;
    if (area < 4) {
      setError('Draw a polygon with an area of at least 4 source pixels.');
      return;
    }
    addLayer({
      id: crypto.randomUUID(),
      type: 'part',
      name: `Pulse region ${project.layers.filter((l) => l.type === 'part').length + 1}`,
      visible: true,
      polygon: draft,
    });
    setDraft([]);
    setTool('select');
  }
  function seek(t: number) {
    const next = Math.max(0, Math.min(duration, t));
    if (audio.current) audio.current.currentTime = next;
    setTime(next);
  }
  async function togglePlayback() {
    if (!audio.current || !project.audioId) return;
    if (playing) audio.current.pause();
    else {
      setTool('select');
      setDraft([]);
      if (time >= duration) seek(0);
      await audio.current.play().catch((e) => setError(e.message));
    }
  }
  function sourcePoint(event: React.PointerEvent<SVGSVGElement>) {
    if (!resources.image) return { x: 0, y: 0 };
    const rect = event.currentTarget.getBoundingClientRect(),
      transform = imageTransform(project, resources.image, width, height);
    return {
      x: Math.max(
        0,
        Math.min(
          resources.image.width,
          (((event.clientX - rect.left) / rect.width) * width - transform.x) / transform.scale,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          resources.image.height,
          (((event.clientY - rect.top) / rect.height) * height - transform.y) / transform.scale,
        ),
      ),
    };
  }
  function moveLayer(direction: number) {
    commit((p) => {
      const layers = [...p.layers],
        index = layers.findIndex((l) => l.id === selected),
        next = index + direction;
      if (index < 0 || next < 0 || next >= layers.length) return p;
      [layers[index], layers[next]] = [layers[next], layers[index]];
      return { ...p, layers };
    });
  }
  async function saveProject() {
    await run('Packing project…', async () => {
      const response = await fetch('/api/projects/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pumper': '1' },
        body: JSON.stringify(project),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob()),
        a = document.createElement('a');
      a.href = url;
      a.download = `${project.name}.pumper`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setSaved(JSON.stringify(project));
      setNotice('Project downloaded with all media included.');
    });
  }
  async function openProject(file?: File) {
    if (!file) return;
    await run('Opening project…', async () => {
      const form = new FormData();
      form.append('file', file);
      const next = await api<Project>('/api/projects/open', { method: 'POST', body: form });
      audio.current?.pause();
      if (foregroundJob) {
        await api(`/api/foreground/${foregroundJob.id}`, { method: 'DELETE' });
        setForegroundJob(undefined);
      }
      reset(next);
      setSaved(JSON.stringify(next));
      select('canvas');
      setNotice('Project opened.');
    });
  }
  const transform = resources.image
    ? imageTransform(project, resources.image, width, height)
    : undefined;
  const toScreen = (p: Point) =>
    transform
      ? { x: p.x * transform.scale + transform.x, y: p.y * transform.scale + transform.y }
      : p;
  const selection =
    layer?.type === 'part' && layer.polygon ? editedPolygon || layer.polygon : undefined;
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => e.preventDefault()}>
          <span className="brand-mark">
            <Icon name="pulse" size={23} />
          </span>
          pumper<span className="beta">STUDIO</span>
        </a>
        <div className="project-title">
          <input
            aria-label="Project name"
            value={project.name}
            onChange={(e) => commit((p) => ({ ...p, name: e.target.value.slice(0, 100) }))}
          />
          <span className={dirty ? 'unsaved' : ''}>
            {dirty ? 'Unsaved changes' : 'Local session'}
          </span>
        </div>
        <div className="header-actions">
          <button
            className="quiet"
            title="Open project"
            onClick={() => projectInput.current?.click()}
            disabled={!!busy}
          >
            <Icon name="folder" />
            <span>Open</span>
          </button>
          <button className="quiet" onClick={saveProject} disabled={!!busy}>
            <Icon name="save" />
            <span>Save project</span>
          </button>
          <button
            className="primary"
            onClick={() => setExportOpen(true)}
            disabled={!project.imageId || !project.audioId}
          >
            <Icon name="arrow" />
            Export video
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="left-panel">
          <div className="panel-title">
            YOUR SESSION<span className="local-dot">LOCAL</span>
          </div>
          <section className="media-section">
            <h2>Source media</h2>
            <button
              className={`media-card ${imageAsset ? 'has-media' : ''}`}
              onClick={() => imageInput.current?.click()}
              disabled={!!busy}
            >
              {imageAsset ? (
                <img src={assetUrl(imageAsset.id)} alt="Source thumbnail" />
              ) : (
                <span className="media-icon">
                  <Icon name="image" size={21} />
                </span>
              )}
              <span>
                <strong>{imageAsset?.name || 'Add an image'}</strong>
                <small>
                  {imageAsset ? `${imageAsset.width} × ${imageAsset.height}` : 'PNG, JPG or WebP'}
                </small>
              </span>
              <Icon name={imageAsset ? 'settings' : 'plus'} size={16} />
            </button>
            <button
              className={`media-card ${audioAsset ? 'has-media' : ''}`}
              onClick={() => audioInput.current?.click()}
              disabled={!!busy}
            >
              <span className="media-icon audio-icon">
                <Icon name="music" size={21} />
              </span>
              <span>
                <strong>{audioAsset?.name || 'Add your audio'}</strong>
                <small>
                  {audioAsset
                    ? `${timeLabel(audioAsset.duration || 0)} · Original audio`
                    : 'MP3 or WAV · up to 30 min'}
                </small>
              </span>
              <Icon name={audioAsset ? 'settings' : 'plus'} size={16} />
            </button>
          </section>
          <section className="layer-section">
            <div className="section-heading">
              <h2>Layers</h2>
              <span className="count">{project.layers.length + 1}</span>
            </div>
            <p className="caption">Stack your sound into something visual.</p>
            <div className="layer-add">
              <button title="Add particle layer" onClick={() => addLayer(newParticles())}>
                <Icon name="particles" size={16} />
                Particles
              </button>
              <button title="Add analyzer layer" onClick={() => addLayer(newAnalyzer())}>
                <Icon name="analyzer" size={16} />
                Spectrum
              </button>
            </div>
            <div className="layer-list">
              {[...project.layers].reverse().map((l) => (
                <div key={l.id} className={`layer-row ${selected === l.id ? 'selected' : ''}`}>
                  <button className="layer-select" onClick={() => select(l.id)}>
                    <span className={`layer-icon ${l.type}`}>
                      <Icon
                        name={
                          l.type === 'foreground'
                            ? 'image'
                            : l.type === 'part'
                              ? 'polygon'
                              : l.type === 'particles'
                                ? 'particles'
                                : 'analyzer'
                        }
                      />
                    </span>
                    <span>
                      <strong>{l.name}</strong>
                      <small>
                        {l.type === 'foreground'
                          ? 'BiRefNet cutout'
                          : l.type === 'part'
                            ? l.maskId
                              ? 'Uploaded mask'
                              : 'Polygon mask'
                            : l.type === 'particles'
                              ? l.mode
                              : l.style}
                      </small>
                    </span>
                  </button>
                  <button
                    className="icon-button"
                    title={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                    onClick={() =>
                      commit((p) => ({
                        ...p,
                        layers: p.layers.map((item) =>
                          item.id === l.id ? { ...item, visible: !item.visible } : item,
                        ),
                      }))
                    }
                  >
                    <Icon name={l.visible ? 'eye' : 'hidden'} size={15} />
                  </button>
                </div>
              ))}
              <button
                className={`layer-row base-layer ${selected === 'canvas' ? 'selected' : ''}`}
                onClick={() => select('canvas')}
              >
                <span className="layer-icon">
                  <Icon name="image" />
                </span>
                <span>
                  <strong>Background</strong>
                  <small>Original image</small>
                </span>
                <span className="base-tag">BASE</span>
              </button>
            </div>
            {!project.layers.length && (
              <div className="layer-empty">
                <span className="dotted-square">
                  <Icon name="polygon" size={22} />
                </span>
                <p>A little motion goes a long way.</p>
                <small>Draw a region on your image or add an effect above.</small>
              </div>
            )}
          </section>
          <div className="privacy-note">
            <span className="status-dot" />
            <span>
              Made here. Stays here.<small>Your media never leaves this computer.</small>
            </span>
          </div>
        </aside>
        <main className="editor">
          <div className="editor-toolbar">
            <div className="tool-group">
              <button
                className={tool === 'select' ? 'tool active' : 'tool'}
                title="Select and edit regions"
                onClick={() => {
                  setTool('select');
                  setDraft([]);
                }}
              >
                ↖<span>Select</span>
              </button>
              <button
                className={tool === 'polygon' ? 'tool active' : 'tool'}
                disabled={!imageAsset}
                onClick={() => {
                  audio.current?.pause();
                  setTool('polygon');
                  setDraft([]);
                }}
              >
                <Icon name="polygon" size={16} />
                Draw region
              </button>
              <button
                className="tool"
                disabled={!imageAsset || !!busy}
                onClick={() => maskInput.current?.click()}
              >
                <Icon name="upload" size={15} />
                Upload mask
              </button>
            </div>
            <div className="tool-group">
              <button
                className="icon-button"
                title="Undo (Ctrl+Z)"
                disabled={!canUndo}
                onClick={undo}
              >
                <Icon name="undo" size={17} />
              </button>
              <button
                className="icon-button"
                title="Redo (Ctrl+Shift+Z)"
                disabled={!canRedo}
                onClick={redo}
              >
                <Icon name="redo" size={17} />
              </button>
            </div>
          </div>
          <div className="preview-area">
            <div className="preview-meta">
              <span>
                <span className="status-dot" />
                {tool === 'polygon' ? 'MASK EDITOR' : 'LIVE PREVIEW'}
              </span>
              <span>
                {width} × {height}
                <span className="meta-separator">/</span>30 FPS
              </span>
            </div>
            {!imageAsset ? (
              <div className="empty-preview">
                <div className="empty-art">
                  <div className="art-orbit orbit-one" />
                  <div className="art-orbit orbit-two" />
                  <div className="art-core">
                    <Icon name="pulse" size={55} />
                  </div>
                  <i />
                  <i />
                  <i />
                </div>
                <span className="eyebrow">SOUND INTO MOTION</span>
                <h1>
                  Give your image
                  <br />a heartbeat.
                </h1>
                <p>
                  Add an image and a track. Choose what moves.
                  <br />
                  Make something that feels like your music.
                </p>
                <button
                  className="primary"
                  onClick={() => imageInput.current?.click()}
                  disabled={!!busy}
                >
                  <Icon name="plus" />
                  Start with an image
                </button>
                <div className="workflow-hints">
                  <span>
                    01 <b>Add media</b>
                  </span>
                  <span>
                    02 <b>Shape the motion</b>
                  </span>
                  <span>
                    03 <b>Export</b>
                  </span>
                </div>
              </div>
            ) : (
              <div
                className={`canvas-wrap ${tool === 'polygon' ? 'drawing' : ''}`}
                style={{
                  aspectRatio: `${width}/${height}`,
                  maxWidth:
                    project.canvas.format === 'portrait'
                      ? 300
                      : project.canvas.format === 'square'
                        ? 520
                        : 1000,
                }}
              >
                <canvas ref={canvas} width={width} height={height} aria-label="Animation preview" />
                <svg
                  className="selection-overlay"
                  viewBox={`0 0 ${width} ${height}`}
                  onPointerDown={(e) => {
                    if (tool === 'polygon') {
                      const point = sourcePoint(e);
                      if (draft.length >= 3) {
                        const a = toScreen(draft[0]),
                          b = toScreen(point),
                          rect = e.currentTarget.getBoundingClientRect();
                        if ((Math.hypot(a.x - b.x, a.y - b.y) * rect.width) / width < 12) {
                          finishPolygon();
                          return;
                        }
                      }
                      setDraft((points) => [...points, point]);
                    } else {
                      const index = (e.target as SVGElement).getAttribute('data-vertex');
                      if (index !== null && selection) {
                        audio.current?.pause();
                        seek(0);
                        drag.current = Number(index);
                        editRef.current = [...selection];
                        setEditedPolygon(editRef.current);
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }
                    }
                  }}
                  onPointerMove={(e) => {
                    if (drag.current === null || !editRef.current) return;
                    const point = sourcePoint(e);
                    editRef.current = editRef.current.map((p, i) =>
                      i === drag.current ? point : p,
                    );
                    setEditedPolygon(editRef.current);
                  }}
                  onPointerUp={() => {
                    if (drag.current !== null && editRef.current)
                      patchLayer({ polygon: editRef.current });
                    drag.current = null;
                    editRef.current = undefined;
                    setEditedPolygon(undefined);
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                    editRef.current = undefined;
                    setEditedPolygon(undefined);
                  }}
                >
                  {tool !== 'polygon' && selection && !playing && (
                    <>
                      <polygon
                        className="selected-polygon"
                        points={selection
                          .map((p) => {
                            const s = toScreen(p);
                            return `${s.x},${s.y}`;
                          })
                          .join(' ')}
                      />
                      {selection.map((p, i) => {
                        const s = toScreen(p);
                        return (
                          <circle
                            key={i}
                            className="vertex"
                            data-vertex={i}
                            cx={s.x}
                            cy={s.y}
                            r={width / 150}
                          />
                        );
                      })}
                    </>
                  )}
                  {tool === 'polygon' && (
                    <>
                      <polyline
                        className="draft-polygon"
                        points={draft
                          .map((p) => {
                            const s = toScreen(p);
                            return `${s.x},${s.y}`;
                          })
                          .join(' ')}
                      />
                      {draft.map((p, i) => {
                        const s = toScreen(p);
                        return (
                          <circle
                            key={i}
                            className={i === 0 ? 'vertex first-vertex' : 'vertex'}
                            cx={s.x}
                            cy={s.y}
                            r={width / 150}
                          />
                        );
                      })}
                    </>
                  )}
                </svg>
              </div>
            )}
            <div className="preview-bottom">
              {tool === 'polygon' ? (
                <div className="draw-help">
                  <span>Click to add points. Close at the first point or press Enter.</span>
                  <button onClick={finishPolygon} disabled={draft.length < 3}>
                    <Icon name="check" size={14} />
                    Finish region
                  </button>
                  <button
                    className="icon-button"
                    title="Cancel polygon"
                    onClick={() => {
                      setTool('select');
                      setDraft([]);
                    }}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              ) : (
                <>
                  <span>
                    {imageAsset
                      ? 'Polygon masks · Grayscale masks · Layered effects'
                      : 'Your next visual starts here'}
                  </span>
                  <span>
                    {analyzing
                      ? 'Analyzing audio…'
                      : readyKey !== key
                        ? 'Preparing image…'
                        : 'Preview ready'}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="transport">
            <div className="transport-heading">
              <div className="playback-buttons">
                <button
                  className="icon-button"
                  title="Back to start"
                  onClick={() => seek(0)}
                  disabled={!audioAsset}
                >
                  <Icon name="back" size={16} />
                </button>
                <button
                  className="play-button"
                  title={playing ? 'Pause' : 'Play'}
                  disabled={!audioAsset}
                  onClick={togglePlayback}
                >
                  <Icon name={playing ? 'pause' : 'play'} size={17} />
                </button>
                <span className="time-code">
                  {timeLabel(time)}
                  <small>/ {timeLabel(duration)}</small>
                </span>
              </div>
              <span className="audio-badge">
                <Icon name="music" size={13} />
                {audioAsset ? audioAsset.name : 'No audio track'}
              </span>
              <span className="keyboard-hint">
                SPACE <small>play / pause</small>
              </span>
            </div>
            <div className="waveform-track">
              <canvas ref={waveform} width={1600} height={56} />
              {!audioAsset && <span>Add a track to see its waveform</span>}
              <input
                aria-label="Timeline"
                type="range"
                min="0"
                max={duration || 1}
                step="0.01"
                value={time}
                disabled={!audioAsset}
                onChange={(e) => seek(Number(e.target.value))}
              />
              {audioAsset && (
                <i className="playhead" style={{ left: `${(time / (duration || 1)) * 100}%` }} />
              )}
            </div>
            <div className="timeline-ticks">
              {Array.from({ length: 7 }, (_, i) => (
                <span key={i}>{timeLabel((duration * i) / 6)}</span>
              ))}
            </div>
          </div>
        </main>
        <aside className="right-panel">
          <div className="panel-title">
            {layer ? 'LAYER SETTINGS' : 'SCENE SETTINGS'}
            <Icon name="settings" size={15} />
          </div>
          <div className="settings-scroll">
            {layer && (
              <Section
                title={
                  layer.type === 'foreground'
                    ? 'Foreground'
                    : layer.type === 'part'
                      ? 'Pulse region'
                      : layer.type === 'particles'
                        ? 'Particle field'
                        : 'Frequency spectrum'
                }
              >
                <label className="control">
                  <span>Layer name</span>
                  <input
                    aria-label="Layer name"
                    type="text"
                    value={layer.name}
                    maxLength={100}
                    onChange={(e) => patchLayer({ name: e.target.value })}
                  />
                </label>
                <div className="layer-order">
                  <button
                    title="Move layer up"
                    onClick={() => moveLayer(1)}
                    disabled={project.layers.at(-1)?.id === selected}
                  >
                    ↑ Move up
                  </button>
                  <button
                    title="Move layer down"
                    onClick={() => moveLayer(-1)}
                    disabled={project.layers[0]?.id === selected}
                  >
                    ↓ Move down
                  </button>
                  <button
                    className="icon-button danger"
                    title="Delete layer"
                    onClick={() => {
                      commit((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== selected) }));
                      select('canvas');
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </Section>
            )}
            {!layer && (
              <Section title="Canvas" caption="Set the stage for your visual.">
                <Select
                  label="Format"
                  value={project.canvas.format}
                  options={[
                    ['landscape', 'Landscape · 16:9'],
                    ['portrait', 'Portrait · 9:16'],
                    ['square', 'Square · 1:1'],
                  ]}
                  onChange={(format) => patchCanvas({ format })}
                />
                <Select
                  label="Image sizing"
                  value={project.canvas.fit}
                  options={[
                    ['fill', 'Fill canvas'],
                    ['fit', 'Fit whole image'],
                  ]}
                  onChange={(fit) => patchCanvas({ fit })}
                />
                <Range
                  label="Image zoom"
                  value={project.canvas.zoom}
                  min={0.25}
                  max={3}
                  onChange={(zoom) => patchCanvas({ zoom })}
                  format={(v) => `${v.toFixed(2)}×`}
                />
                <Range
                  label="Horizontal position"
                  value={project.canvas.offsetX}
                  min={-1}
                  max={1}
                  onChange={(offsetX) => patchCanvas({ offsetX })}
                  format={percent}
                />
                <Range
                  label="Vertical position"
                  value={project.canvas.offsetY}
                  min={-1}
                  max={1}
                  onChange={(offsetY) => patchCanvas({ offsetY })}
                  format={percent}
                />
                <Color
                  label="Background"
                  value={project.canvas.background}
                  onChange={(background) => patchCanvas({ background })}
                />
              </Section>
            )}
            {(!layer || layer.type === 'foreground') && (
              <Section
                title="Foreground"
                caption="Separate the subject locally with BiRefNet on your CPU."
              >
                <button
                  className="secondary-button"
                  disabled={!imageAsset || !!busy || !!foregroundJob}
                  onClick={() => void separateForeground()}
                >
                  {project.layers.some((l) => l.type === 'foreground')
                    ? 'Separate foreground again'
                    : 'Separate foreground'}
                </button>
                {foregroundJob && (
                  <div className="foreground-progress" role="status">
                    <p>
                      {foregroundJob.status === 'loading'
                        ? 'Loading BiRefNet on CPU…'
                        : 'Separating foreground on CPU…'}
                    </p>
                    <button
                      className="secondary-button"
                      disabled={!!busy}
                      onClick={() => void cancelForeground()}
                    >
                      Cancel separation
                    </button>
                  </div>
                )}
                <p className="setting-tip">
                  {health?.foreground === false
                    ? 'Model setup needed: run npm run setup:foreground once.'
                    : 'CPU separation can take a few minutes. You can keep editing while it runs.'}
                </p>
                {layer?.type === 'foreground' && (
                  <>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        commit((p) => ({
                          ...p,
                          layers: [...p.layers.filter((l) => l.id !== layer.id), layer],
                        }))
                      }
                    >
                      Place foreground on top
                    </button>
                    <p className="setting-tip">
                      New particles are placed beneath the foreground. Use Move up or Move down to
                      change the order.
                    </p>
                  </>
                )}
              </Section>
            )}
            {!layer && (
              <Section
                title="Background motion blur"
                caption="Directional blur of the background; the foreground stays sharp."
              >
                <Range
                  label="Motion blur strength"
                  value={project.canvas.motionBlur}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(motionBlur) => patchCanvas({ motionBlur })}
                  format={(v) => (v === 0 ? 'Off' : `${v} px`)}
                />
                <Range
                  label="Motion blur angle"
                  value={project.canvas.motionBlurAngle}
                  min={-180}
                  max={180}
                  step={1}
                  onChange={(motionBlurAngle) => patchCanvas({ motionBlurAngle })}
                  format={(v) => `${v}°`}
                />
                <p className="setting-tip">
                  Strength is measured in source image pixels. Separate the foreground to keep your
                  subject sharp above the blur.
                </p>
              </Section>
            )}
            {(!layer || layer.type === 'part') && (
              <>
                <Section title="Pulse" caption="Shared by every selected region.">
                  <Range
                    label="Maximum amplification"
                    value={project.pulse.maxScale}
                    min={1}
                    max={3}
                    onChange={(maxScale) => patchPulse({ maxScale })}
                    format={(v) => `${v.toFixed(2)}×`}
                  />
                  <Range
                    label="Bass cutoff"
                    value={project.pulse.cutoff}
                    min={20}
                    max={2000}
                    step={10}
                    onChange={(cutoff) => patchPulse({ cutoff })}
                    format={(v) => `${v} Hz`}
                  />
                  <p className="setting-tip">
                    Only frequencies below the cutoff drive the pulse. Your audio stays untouched.
                  </p>
                </Section>
                <Section title="Edges">
                  <Range
                    label="Edge blur"
                    value={project.pulse.edgeBlur}
                    min={0}
                    max={50}
                    step={1}
                    onChange={(edgeBlur) => patchPulse({ edgeBlur })}
                    format={(v) => (v === 0 ? 'Off' : `${v} px`)}
                  />
                  <p className="setting-tip">
                    Softens every region and its trails. Measured in source image pixels.
                  </p>
                </Section>
                <Section title="Motion trail">
                  <Range
                    label="Trail delay"
                    value={project.pulse.trailDelay}
                    min={0}
                    max={0.5}
                    step={0.01}
                    onChange={(trailDelay) => patchPulse({ trailDelay })}
                    format={(v) => `${Math.round(v * 1000)} ms`}
                  />
                  <Range
                    label="Trail opacity"
                    value={project.pulse.trailOpacity}
                    min={0}
                    max={0.8}
                    onChange={(trailOpacity) => patchPulse({ trailOpacity })}
                    format={percent}
                  />
                  <Range
                    label="Trail copies"
                    value={project.pulse.trailCopies}
                    min={0}
                    max={8}
                    step={1}
                    onChange={(trailCopies) => patchPulse({ trailCopies })}
                  />
                </Section>
              </>
            )}
            {layer?.type === 'particles' && (
              <Section title="Movement & appearance">
                <Select
                  label="Movement"
                  value={layer.mode}
                  options={[
                    ['rise', 'Rise from below'],
                    ['fall', 'Fall from above'],
                    ['shimmer', 'Shimmer in place'],
                  ]}
                  onChange={(mode) => patchLayer({ mode })}
                />
                <Range
                  label="Particle size"
                  value={layer.size}
                  min={1}
                  max={40}
                  step={1}
                  onChange={(size) => patchLayer({ size })}
                  format={(v) => `${v} px`}
                />
                <Range
                  label="Density"
                  value={layer.density}
                  min={1}
                  max={600}
                  step={1}
                  onChange={(density) => patchLayer({ density })}
                />
                <Range
                  label="Speed"
                  value={layer.speed}
                  min={0}
                  max={3}
                  onChange={(speed) => patchLayer({ speed })}
                  format={(v) => `${v.toFixed(2)}×`}
                />
                <Range
                  label="Motion amount"
                  value={layer.motion}
                  min={0}
                  max={2}
                  onChange={(motion) => patchLayer({ motion })}
                  format={percent}
                />
                <Color
                  label="Particle color"
                  value={layer.color}
                  onChange={(color) => patchLayer({ color })}
                />
                <Range
                  label="Opacity"
                  value={layer.opacity}
                  min={0}
                  max={1}
                  onChange={(opacity) => patchLayer({ opacity })}
                  format={percent}
                />
                <label className="toggle-control">
                  <span>
                    React to music<small>Pulse size and brightness</small>
                  </span>
                  <input
                    aria-label="React to music"
                    type="checkbox"
                    checked={layer.audioResponse}
                    onChange={(e) => patchLayer({ audioResponse: e.target.checked })}
                  />
                </label>
                <button
                  className="subtle-button"
                  onClick={() => patchLayer({ seed: Math.floor(Math.random() * 2147483647) })}
                >
                  Shuffle particle arrangement
                </button>
              </Section>
            )}
            {layer?.type === 'analyzer' && (
              <Section title="Spectrum style">
                <Select
                  label="Style"
                  value={layer.style}
                  options={[
                    ['bars', 'Vertical bars'],
                    ['mirror', 'Mirrored bars'],
                    ['line', 'Continuous line'],
                    ['radial', 'Radial spectrum'],
                  ]}
                  onChange={(style) => patchLayer({ style })}
                />
                <Select
                  label="Color palette"
                  value={layer.palette}
                  options={[
                    ['mint', 'Mint · Sage to lime'],
                    ['sunset', 'Sunset · Coral to violet'],
                    ['ice', 'Ice · Blue to cyan'],
                    ['mono', 'Single color'],
                  ]}
                  onChange={(palette) => patchLayer({ palette })}
                />
                {layer.palette === 'mono' && (
                  <Color
                    label="Spectrum color"
                    value={layer.color}
                    onChange={(color) => patchLayer({ color })}
                  />
                )}
                <Range
                  label="Opacity"
                  value={layer.opacity}
                  min={0}
                  max={1}
                  onChange={(opacity) => patchLayer({ opacity })}
                  format={percent}
                />
                <Range
                  label="Sensitivity"
                  value={layer.sensitivity}
                  min={0.1}
                  max={4}
                  onChange={(sensitivity) => patchLayer({ sensitivity })}
                  format={(v) => `${v.toFixed(2)}×`}
                />
                <Range
                  label="Thickness"
                  value={layer.thickness}
                  min={1}
                  max={12}
                  step={1}
                  onChange={(thickness) => patchLayer({ thickness })}
                />
                <Range
                  label="Width"
                  value={layer.width}
                  min={0.05}
                  max={1}
                  onChange={(width) => patchLayer({ width })}
                  format={percent}
                />
                <Range
                  label="Height"
                  value={layer.height}
                  min={0.05}
                  max={1}
                  onChange={(height) => patchLayer({ height })}
                  format={percent}
                />
                <Range
                  label="Position X"
                  value={layer.x}
                  min={0}
                  max={1}
                  onChange={(x) => patchLayer({ x })}
                  format={percent}
                />
                <Range
                  label="Position Y"
                  value={layer.y}
                  min={0}
                  max={1}
                  onChange={(y) => patchLayer({ y })}
                  format={percent}
                />
              </Section>
            )}
          </div>
          <div className="output-note">
            <span>OUTPUT</span>
            <strong>
              MP4 <i>·</i> H.264 <i>·</i> 30 FPS
            </strong>
            <small>Full track. Original sound.</small>
          </div>
        </aside>
      </div>
      <footer className="statusbar">
        <span>
          <span className="status-dot" />
          {busy ||
            (foregroundJob
              ? 'Separating foreground on CPU…'
              : analyzing
                ? 'Analyzing your track…'
                : 'All systems local')}
        </span>
        <span>
          {project.layers.filter((l) => l.type === 'part').length} regions
          <span className="meta-separator">·</span>
          {project.layers.filter((l) => l.type !== 'part').length} effects
          <span className="meta-separator">·</span>PUMPER 1.0
        </span>
      </footer>
      {audioAsset && (
        <audio
          ref={audio}
          src={assetUrl(audioAsset.id)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setTime(duration);
          }}
          onError={() =>
            setError(
              'This browser could not play the audio file. Try a standard MP3 or PCM WAV file.',
            )
          }
          preload="auto"
        />
      )}
      <input
        ref={imageInput}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          void importFile(e.target.files?.[0], 'image');
          e.target.value = '';
        }}
      />
      <input
        ref={audioInput}
        hidden
        type="file"
        accept=".mp3,.wav"
        onChange={(e) => {
          void importFile(e.target.files?.[0], 'audio');
          e.target.value = '';
        }}
      />
      <input
        ref={maskInput}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          void importFile(e.target.files?.[0], 'mask');
          e.target.value = '';
        }}
      />
      <input
        ref={projectInput}
        hidden
        type="file"
        accept=".pumper"
        onChange={(e) => {
          void openProject(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {(error || notice) && (
        <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          <Icon name={error ? 'close' : 'check'} />
          <span>{error || notice}</span>
          <button
            className="icon-button"
            title="Dismiss message"
            onClick={() => {
              setError('');
              setNotice('');
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {pendingImage && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="replace-title">
            <h2 id="replace-title">Replace source image?</h2>
            <p>
              The existing regions and foreground belong to the current image. Replacing it clears
              them and keeps particle and spectrum layers. You can undo this change.
            </p>
            <div className="modal-actions">
              <button onClick={() => setPendingImage(undefined)}>Cancel</button>
              <button className="primary" onClick={() => changeImage(pendingImage)}>
                Replace image
              </button>
            </div>
          </div>
        </div>
      )}
      {exportOpen && (
        <div className="modal-backdrop">
          <div
            className="modal export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-title"
          >
            <button
              className="icon-button modal-close"
              title="Close export dialog"
              onClick={() => setExportOpen(false)}
            >
              <Icon name="close" />
            </button>
            <span className="eyebrow">READY FOR THE WORLD</span>
            <h2 id="export-title">Your sound. In motion.</h2>
            <p>Render the full track as a video, right on your computer.</p>
            <div className="export-details">
              <span>
                Resolution
                <strong>
                  {width} × {height}
                </strong>
              </span>
              <span>
                Frame rate<strong>30 fps</strong>
              </span>
              <span>
                Format<strong>MP4 · H.264 / AAC</strong>
              </span>
              <span>
                Duration<strong>{timeLabel(duration)}</strong>
              </span>
            </div>
            {health && (!health.ffmpeg || !health.chromium) && (
              <p className="setup-warning">
                Export setup is incomplete. Run <code>npm install</code> and{' '}
                <code>npm run setup:browser</code>, then restart the app.
              </p>
            )}
            {job && (
              <div className="export-progress">
                <div>
                  <span>
                    {job.status === 'complete'
                      ? 'Your video is ready.'
                      : job.status === 'failed'
                        ? 'Export failed'
                        : job.status === 'cancelled'
                          ? 'Export cancelled'
                          : job.status === 'queued'
                            ? 'Preparing audio…'
                            : job.status === 'encoding'
                              ? 'Finishing video…'
                              : 'Rendering frames…'}
                  </span>
                  <strong>{Math.round(job.progress * 100)}%</strong>
                </div>
                <progress value={job.progress} max="1" />
                {job.error && <p className="setup-warning">{job.error}</p>}
              </div>
            )}
            <p className="caption">
              Export uses a snapshot of this session. You can keep editing. Rendering may take
              longer than playback.
            </p>
            <div className="modal-actions">
              {exportRunning ? (
                <button
                  onClick={() =>
                    run('Cancelling export…', async () =>
                      setJob(await api<ExportJob>(`/api/exports/${job.id}`, { method: 'DELETE' })),
                    )
                  }
                >
                  Cancel export
                </button>
              ) : (
                <>
                  {job?.status === 'complete' && (
                    <a className="button" href={`/api/exports/${job.id}/download`} download>
                      <Icon name="arrow" />
                      Download MP4
                    </a>
                  )}
                  <button
                    className="primary"
                    disabled={!!busy || !health?.ffmpeg || !health?.chromium}
                    onClick={() =>
                      run('Starting export…', async () => {
                        audio.current?.pause();
                        setJob(
                          await api<ExportJob>('/api/exports', {
                            method: 'POST',
                            body: JSON.stringify(project),
                          }),
                        );
                      })
                    }
                  >
                    <Icon name="arrow" />
                    {job?.status === 'complete' ? 'Render again' : 'Render video'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

async function exportPage(id: string) {
  document.body.className = 'render-page';
  const canvas = document.createElement('canvas');
  document.getElementById('root')!.append(canvas);
  try {
    const { project, analysis } = await api<{ project: Project; analysis: Analysis }>(
      `/api/exports/${id}/render`,
    );
    const resources = await prepareResources(project);
    setExportSize(canvas, project);
    (window as any).pumperRender = (time: number) =>
      renderFrame(canvas.getContext('2d')!, project, resources, analysis, time);
    (window as any).pumperRender(0);
    (window as any).pumperReady = true;
  } catch (e) {
    (window as any).pumperError = (e as Error).message;
  }
}
const exportId = new URLSearchParams(location.search).get('render');
if (exportId) void exportPage(exportId);
else createRoot(document.getElementById('root')!).render(<App />);
