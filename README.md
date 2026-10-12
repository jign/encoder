# Encoder

A focused Windows desktop tool for turning OBS recordings into small, silent web demos. Tauri 2, React, and local FFmpeg. Uses Vanilla's fonts, tokens, and command palette.

## Run

Requires Node.js, Rust with the MSVC toolchain, WebView2, and `ffmpeg` / `ffprobe` on PATH. The Vanilla checkout is linked at `../../design/vanilla`.

```powershell
npm install
npm run tauri dev
```

Build a standalone executable:

```powershell
npm run tauri build -- --no-bundle
```

The executable is `src-tauri/target/release/encoder.exe`. It still requires FFmpeg/FFprobe on PATH; those binaries are not bundled.

## Workflow

1. Select a recording from `E:\cache\obs`. Today is determined by the computer's local date. Only `YYYY-MM-DD_HH-MM-SS.mkv`, `.mp4`, and `.mov` names appear, newest first. The list refreshes every 15 seconds. Use the palette to show older recordings.
2. Drag the playhead or step through frames, set the start/end, choose a speed, and draw a crop. Pixel coordinates are also editable. Final durations over one minute receive an advisory warning.
3. Choose **3.8 MB**, **10 MB**, or **Unlimited**, name the output, and export.
4. Compare the source and export with synchronized playback. Reveal the MP4 in Explorer.

Exports are stored in `%LOCALAPPDATA%\com.whitevanillaskies.encoder\exports`. Previews and temporary encodes use Tauri's application cache directory. Originals are never modified. Existing export names are rejected. Export work files are cleaned up after success, failure, or cancellation; previews are cached by filename, size, and modification time.

MKV and HEVC inputs get a silent H.264 preview at the original resolution, CRF 18, and 30 fps for reliable WebView2 playback. The preview is an editing proxy, not a lossless reference. Exports always encode directly from the recording. Preview generation can take a moment on first selection.

## Encoding

All outputs are H.264 (`libx264`, medium preset), `yuv420p`, silent MP4 with `+faststart`, square pixels, and 30 fps. Crop and trim apply before speed and scaling.

- First encode at full cropped resolution, **CRF 23**. Unlimited uses this result. A capped export also keeps this result if it already fits, avoiding larger files just to fill a budget.
- If it exceeds the cap, sample three moments at **CRF 28**, an estimated quality floor. Try full resolution, then 75%, then 50%; choose the first whose sampled bitrate fits the duration-adjusted budget.
- Run two-pass encoding using 97% of the target as the video budget, leaving space for MP4 overhead. Verify the actual byte count. Retry with a lower bitrate up to twice if necessary. An oversized file is never returned as a successful capped export.
- If even half resolution exceeds the sampled quality budget, the result explicitly warns that quality may fall below the floor. Check text legibility or choose a larger cap. This sampling heuristic is not a perceptual quality guarantee.

MB is decimal: 3,800,000 and 10,000,000 bytes. Output dimensions are rounded down to even pixels.

## Keyboard

| Key                | Action                      |
| ------------------ | --------------------------- |
| Ctrl K             | Command palette             |
| Space              | Play / pause                |
| I / O              | Set start / end at playhead |
| Left / Right       | Step by 1/30 second         |
| Shift Left / Right | Step by one second          |
| Ctrl Enter         | Export                      |

## Verification

```powershell
npm run build
npm test
npm run test:encode
```

`test:encode` uses the local `2026-10-12_11-50-01.mkv` and `2026-10-12_11-49-12.mkv` recordings as integration fixtures. It checks H.264, no audio, pixel format, faststart, trim/speed duration, crop dimensions, preset ceilings, resolution fallback, collision protection, and live FFmpeg cancellation. Temporary outputs stay under the project's ignored `.work` folder.

For frontend checks, `http://127.0.0.1:1427/?fixture` uses Tauri's official IPC mocks in development only. It expects `.work/ui-preview.mp4`; it never encodes or writes exports. The mock module is excluded from production builds.

Configuration is deliberately fixed for this first version: one OBS folder, 30 fps, three size presets. No upload service, project format, or multi-clip timeline.
