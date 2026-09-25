# Pumper

A local music-reactive video studio. Mask image regions with polygons or grayscale images, make them pulse with bass energy, and layer particles and frequency visualizers over the result. Export full-track 1080p MP4 video with audio.

## Run

Requires Node.js 22.12+ and npm. Installation downloads dependencies, FFmpeg, and Chromium; editing and rendering then work offline.

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm install
npm run setup:browser
npm run dev
```

Open **http://127.0.0.1:4310**. The service binds only to localhost. On Linux systems missing Chromium libraries, run `npx playwright install-deps chromium` using your system's package-manager permissions.

For a production build:

```sh
npm run build
npm start
```

Set `PORT`, `PUMPER_DATA_DIR`, or `FFMPEG_PATH` to override the port, local storage directory, or FFmpeg executable. Windows users can run the commands in WSL. FFmpeg must include H.264 and AAC encoding; the packaged binary does.

## CPU foreground separation

Run `npm run setup:foreground` once to download the official [BiRefNet lightweight ONNX model](https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1) (224 MB). Setup verifies its pinned SHA-256 checksum and stores it under `.pumper-data/models/`. No Python or GPU is required. The project npm configuration skips optional GPU runtime downloads; ONNX Runtime explicitly uses the CPU execution provider with up to four threads.

Select **Background → Foreground → Separate foreground**. The app runs inference in a separate process and adds a foreground layer on top when finished. CPU inference can take a few minutes; continue editing or use **Cancel separation**. Repeated separation of the same source asset uses the cached mask. Replacing the source clears the foreground. New particle layers are inserted beneath it; select the foreground and use the ordering controls to change this. The mask is included in saved projects, so opening and exporting an already separated project does not need the model.

Under **Background motion blur**, set strength from 0–100 source-image pixels and direction from −180° to 180°. Zero disables it. This is a directional streak effect, cached when settings change. With a visible separated foreground, the subject is excluded from background blur samples and composited sharply in its layer position. It does not reconstruct scenery hidden behind the subject. The same rendering is used in previews and video exports.

Separation runs locally and never uploads images. The one-time model setup requires internet access; subsequent inference works offline. `PUMPER_DATA_DIR` changes both model and media storage, so run setup with the same value used by the server.

## Workflow

1. Add a PNG, JPEG, or WebP image and an MP3/WAV track.
2. Choose **Draw region**, click polygon vertices, and click the first point or press Enter to close. Backspace removes the last draft point; Escape cancels. Select a polygon layer and drag its handles to edit. Use Undo/Redo or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z.
3. Alternatively, upload a mask matching the source image dimensions. White selects, black excludes, gray feathers edges, and transparency reduces selection. Each uploaded mask defines one region. All disconnected shapes in that mask scale together around their combined bounding-box center.
4. Adjust shared maximum amplification, bass cutoff, edge blur, and motion trail settings. Edge blur softens polygon and grayscale-mask boundaries without blurring image details; 0 disables it, and values up to 50 are measured in source image pixels. Scale runs from 1× at silence to the configured maximum at peak energy. The original image stays underneath the cutouts. Trail delay is spacing between fading earlier poses; zero delay or zero copies disables trails.
5. Add any number of particle or spectrum layers. Layers at the top of the list render on top. Particle audio response uses full-band energy independently of bass cutoff. Spectrum styles are bars, mirrored bars, line, and radial. Hide and reorder layers using their controls.
6. Choose landscape, portrait, or square under Background settings. Preview with the timeline or Space. Selecting a polygon stops at the beginning for source-coordinate editing.
7. **Save project** downloads a `.pumper` archive including all source media, masks, settings, polygons, and random seeds. **Open** restores it. Keep this file to resume later; a browser refresh starts a new session.
8. **Export video** renders a snapshot of the project as H.264/AAC MP4 at 30 fps. Landscape is 1920×1080, portrait 1080×1920, and square 1080×1080. Download the result when finished. Edits during export apply to the next render.

## Limits and storage

- Desktop browser editor; the layout also stacks on narrow screens. No accounts or external media services.
- Upload limit: 256 MiB per file. Audio: up to 30 minutes. Images: up to 40 megapixels and 12,000 pixels per side. Masks use the oriented source-image dimensions.
- One export at a time. Frame capture prioritizes deterministic output and can run slower than realtime. Progress is frame-based; final encoding follows capture.
- Export audio is the original track re-encoded as AAC. Bass filtering only affects animation, never the exported sound.
- Media, decoded audio, analysis caches, and completed videos live in `.pumper-data/`. Caches persist across restarts. Failed/cancelled exports are removed. You may remove this directory **after stopping the app** to reclaim space; first save any projects you need as `.pumper` files.
- Portable archives are limited to 512 MiB, with each media file limited to 256 MiB. Incompatible project versions, missing assets, mismatched masks, and unsafe archive paths produce errors.
- No background inpainting, audio editing, accounts, hosted rendering, or 4K/60 fps output.

## Implementation

React/TypeScript and Canvas 2D share an explicit-time renderer with the headless Chromium export page. Seeded particles and trails derived from past envelope samples reproduce the same frame after seeking. FFmpeg decodes stereo audio at 44.1 kHz. Separate channel energies prevent phase cancellation; a Butterworth low-pass feeds an RMS envelope with 25 ms attack and 160 ms release. A full-track peak normalizes scale. A separate full-band envelope drives optional particle response. A Hann-windowed FFT supplies 64 logarithmic frequency bands. Analysis runs in serial child processes and caches results on disk; changing bass cutoff reuses spectrum and waveform data.

The local HTTP service exposes:

- `POST /api/assets` and `GET /api/assets/:id`: import and retrieve media.
- `GET /api/analysis/:id?cutoff=180`: cached waveform, spectrum, bass envelope, and full-band loudness.
- `POST /api/projects/save` and `POST /api/projects/open`: portable archives.
- `POST /api/exports`, `GET /api/exports/:id`, `DELETE /api/exports/:id`, and `GET /api/exports/:id/download`: render lifecycle.
- `POST /api/foreground`, `GET /api/foreground/:id`, and `DELETE /api/foreground/:id`: cached CPU separation and cancellation.
- `GET /api/health`: FFmpeg, Chromium, and foreground model availability.

Mutation requests require `X-Pumper: 1`; cross-origin requests are rejected. Project JSON uses the versioned Zod schema in `src/model.ts`. Asset IDs are local UUIDs, and portable imports remap them.

## Verify

```sh
npm run build
npm test
# With npm run dev running in a separate terminal:
npm run test:e2e
# With the BiRefNet model installed:
npm run test:e2e:foreground
npm run test:foreground-renderer
```

Unit tests cover silence, stereo cancellation, low-pass response, independent full-band analysis, scale bounds, deterministic particles, coordinate transforms, and schema validation. The end-to-end test generates fixtures, exercises the browser editor, validates grayscale masks and project round trips, and renders landscape, portrait, and square videos from WAV/MP3 audio. It checks static and animated exported frames against the preview renderer, frame count, duration, cancellation, failed exports, and archive validation. Screenshots and sample exports are written to `test-results/`.

The foreground suite exercises real CPU inference, saved mask remapping, particle ordering, motion blur persistence, and preview/export parity. The renderer suite checks directional streaks, sharp foreground pixels, foreground color exclusion, image-edge coverage, layer occlusion, and cancellation.
