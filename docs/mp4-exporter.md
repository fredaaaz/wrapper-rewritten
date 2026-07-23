# MP4 exporter

## Architecture

The exporter is split between the Vue renderer, the local HTTP API, and Electron's main process.

- `ExportView.vue` owns the export UI and embeds `exporter.swf` only while its job has the `rendering` slot.
- `routes/export.ts` validates HTTP input and exposes job-scoped operations.
- `export/jobManager.ts` owns the queue, state machine, frame files, FFmpeg process, cancellation, cleanup, and completed outputs.
- `export/audio.ts` parses movie XML and resolves UGC or store audio without accepting arbitrary paths.
- `export/ffmpeg.ts` builds argument arrays, starts no shell, probes inputs/outputs, and defines the adjustable encoding constants.
- Electron IPC implements Save As, Open file, and Open containing folder. The renderer never receives an arbitrary filesystem path.

Only one job renders or encodes at a time. Additional jobs remain `queued`. Every job has a random 128-bit ID and isolated paths:

```text
_EXPORTS/temp/<jobId>/
_EXPORTS/output/<safeMovieTitle>-<jobId>.mp4
```

Completed outputs are retained. Temporary frames and partial outputs are removed after success, failure, cancellation, shutdown, or when an abandoned temp directory is older than 24 hours.

## Routes

All POST bodies use form fields because Wrapper's existing request middleware is based on Formidable.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/export/start` | Validate the movie and settings, validate audio, and create or queue a job |
| POST | `/api/export/:jobId/frame` | Upload one explicitly indexed base64 PNG |
| POST | `/api/export/:jobId/finish` | Detect missing frames, compact scene-boundary duplicates, and start encoding |
| GET | `/api/export/:jobId/status` | Read public progress without exposing local paths |
| POST | `/api/export/:jobId/heartbeat` | Keep a queued/rendering browser job alive |
| POST | `/api/export/:jobId/cancel` | Cancel rendering or terminate the FFmpeg process tree |
| GET | `/api/export/:jobId/download` | Download only that job's validated completed MP4 |

Errors use `{ "status":"error", "error":{ "code":"...", "message":"..." } }`.

## Job lifecycle

```text
queued -> rendering -> encoding -> completed
   |          |           |
   +----------+-----------+-> cancelled
              +-----------+-> failed
```

Invalid transitions are rejected. Indexed uploads may arrive out of order, but duplicate indexes are rejected and `finish` refuses a sequence with missing indexes.

## Flash frame capture

The current `player.swf` exposes `getPhotoArray()`, `getSceneInfoArray()`, and seek methods, but it does not issue exporter lifecycle callbacks. The historical exporter SWF contains the same movie player plus `onSceneEnter` and `notifyMovieEnded` calls. That SWF is retained as a binary rendering resource; none of the old HTTP or FFmpeg implementation was restored.

The SWF renders at the movie engine's deterministic 24 FPS and captures PNGs from the composed movie stage after assets are ready. At scene boundaries, Vue drains newly available frames and uploads each frame in a separate request. It never sends the old giant JSON body. At completion, scene start indexes are sent as metadata. The server preserves the first legitimate frame and compacts later duplicated boundary frames into a separate contiguous sequence, avoiding unsafe array splicing and the historical `frames[i == 1 ? 2 : i]` corruption.

30 FPS output is generated deterministically from the 24 FPS movie timeline by FFmpeg's `fps` filter. Scaling always uses `force_original_aspect_ratio=decrease` followed by padding, so classic content is not stretched.

## Audio and FFmpeg

Movie `<sound>` elements are resolved to either `_ASSETS` UGC audio or the packaged store. Legacy SWF sound references prefer a decrypted MP3 sibling when present. Every resolved input must exist, be non-empty, and contain an FFprobe-detectable audio stream before a job starts rendering.

Each clip receives source trimming, a timeline duration cap, fade in/out, volume, stereo conversion, and a sample-accurate timeline delay. Overlapping clips are combined with `amix`. An audio-free movie takes a separate video-only path and never creates `amix=inputs=0`.

The MP4 encoder uses:

```text
libx264, CRF 18, preset medium, yuv420p, faststart
AAC stereo, 48 kHz, 192 kb/s
```

Constants are at the top of `export/ffmpeg.ts`. Progress comes from `-progress pipe:1`. A job is completed only after the output is non-empty and FFprobe confirms its video stream, duration tolerance, and expected audio stream.

On Windows, cancellation uses `taskkill /T /F` with an argument array to terminate the complete FFmpeg process tree. Other platforms request `SIGTERM` and fall back to `SIGKILL`.

## Debugging

1. Check the export window's structured error first. Missing audio errors identify the movie asset reference.
2. Run `npm test` to exercise validators, argument generation, cleanup, and the synthetic H.264/AAC integration encode.
3. Confirm `require("ffmpeg-static")` and `require("@derhuerst/ffprobe-static")` point to executable files. Development can use `FFMPEG_PATH` and `FFPROBE_PATH` overrides or system commands as a fallback.
4. Inspect the final portion of the logged FFmpeg error. The manager limits retained process output to 64 KiB.
5. If Flash never starts, confirm Pepper Flash is loaded and `resources/static/animation/414827163ad4eb60/exporter.swf` is present.

## Known limitations

- Flash frame capture must run in Wrapper's Electron window and therefore cannot be covered by the headless test suite.
- The legacy movie engine renders natively at 24 FPS. The 30 FPS option cadence-converts that deterministic render; it does not invent intermediate animation poses.
- Closing the export window during an unfinished export cancels it. Completed files remain available in `_EXPORTS/output`.
