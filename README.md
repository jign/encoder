# Encoder

A focused Windows desktop tool for turning recordings into small web demos, with optional audio. Tauri 2, React, and local FFmpeg. Uses Vanilla's fonts, tokens, and command palette.

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

1. The **Source file** field is always available. Browse for any video, or type an absolute filepath and press Enter / Load. A draft filepath must be loaded before exporting, so the displayed path always identifies the clip being encoded.
2. Enable **OBS mode** for a sidebar of recordings. Pick your OBS cache folder once; use **Change folder…** or **Change OBS cache folder** in the palette to change it. Today is determined by the computer's local date. Only `YYYY-MM-DD_HH-MM-SS.mkv`, `.mp4`, and `.mov` names appear, newest first. The list refreshes every 15 seconds. Use the palette to show older recordings. Picking a sidebar item updates the source field; browsing elsewhere clears the sidebar highlight. Disabling OBS mode hides the sidebar without unloading the source.
3. Drag the playhead or step through frames, set the start/end, choose a speed, and draw a crop. Pixel coordinates are also editable. Final durations over one minute receive an advisory warning.
4. Choose **3.8 MB**, **10 MB**, or **Unlimited**. **Remove audio** defaults to checked; uncheck to retain the first audio track. Set the output filename inline, or use **Save As…** to select both filename and destination folder. Save As chooses the location; **Export clip** starts encoding. Cancelling a dialog leaves the previous selection intact.
5. Compare the source and export with synchronized playback. Reveal the MP4 in Explorer, including exports outside the default folder.

Exports default to `%LOCALAPPDATA%\com.whitevanillaskies.encoder\exports`; Save As can choose any destination. The OBS mode, OBS folder, last loaded source, destination folder, audio choice, and today-only filter persist in `settings.json` under the app's local data folder. Fresh installations start without a configured OBS folder. Existing installations migrate `E:\cache\obs` once when available.

Previews and temporary encodes use Tauri's application cache directory. Originals are never modified. Existing export names are rejected. Export work files are cleaned up after success, failure, or cancellation; previews are cached by full source path, size, and modification time, so identically named files in different folders do not collide.

Inputs get an H.264 preview at the original resolution, CRF 18, and 30 fps for reliable WebView2 playback. The preview includes the first audio track when present and is muted when Remove audio is checked. The preview is an editing proxy, not a lossless reference. Exports always encode directly from the recording. Preview generation can take a moment on first selection. Comparison playback uses only the source preview's audio to avoid playing two audio tracks over each other.

## Encoding

All outputs are H.264 (`libx264`, medium preset), `yuv420p`, MP4 with `+faststart`, square pixels, and 30 fps. Crop and trim apply before speed and scaling. Retained audio is AAC at 96 kbps; chained `atempo` filters preserve pitch for speeds from 0.25× through 8×. Sources with no audio remain silent even if Remove audio is unchecked.

- First encode at full cropped resolution, **CRF 23**. Unlimited uses this result. A capped export also keeps this result if it already fits, avoiding larger files just to fill a budget.
- If it exceeds the cap, sample three moments at **CRF 28**, an estimated quality floor. Try full resolution, then 75%, then 50%; choose the first whose sampled bitrate fits the duration-adjusted budget.
- Run two-pass encoding using 97% of the target as the combined media budget, leaving space for MP4 overhead and subtracting 96 kbps for audio when retained. Samples and the first pass encode video only. Verify the actual byte count including audio. Retry with a lower video bitrate up to twice if necessary. An oversized file is never returned as a successful capped export.
- If even half resolution exceeds the sampled quality budget, the result explicitly warns that quality may fall below the floor. Check text legibility or choose a larger cap. This sampling heuristic is not a perceptual quality guarantee.

MB is decimal: 3,800,000 and 10,000,000 bytes. Output dimensions are rounded down to even pixels.

## Keyboard

| Key                | Action                      |
| ------------------ | --------------------------- |
| Ctrl K             | Command palette             |
| Ctrl O             | Browse for a source file    |
| Ctrl Shift S       | Choose export location      |
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

`test:encode` uses the local `2026-10-12_11-50-01.mkv` and `2026-10-12_11-49-12.mkv` recordings as integration fixtures. It checks H.264, audio removal, pixel format, faststart, trim/speed duration, crop dimensions, preset ceilings with retained audio, resolution fallback, collision protection, and live FFmpeg cancellation. A generated portable fixture checks arbitrary filenames, custom destinations, retained audio at 0.25× / 2× / 8×, and pitch preservation by measuring a 440 Hz tone. It also covers keeping audio on a source with no audio track. Temporary outputs stay under the project's ignored `.work` folder.

For frontend checks, `http://127.0.0.1:1427/?fixture` uses Tauri's official IPC mocks in development only. It expects `.work/ui-preview.mp4` and `.work/ui-output.mp4`; it never encodes or writes exports. It simulates the native file dialogs and stores fixture preferences in browser local storage for reload checks. The mock module is excluded from production builds.

Encoding remains opinionated: 30 fps and three size presets. No upload service, project format, or multi-clip timeline.
