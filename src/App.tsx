import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Palette } from "@vanilla/petals/palette";

type Recording = { name: string; path: string; bytes: number };
type Media = {
  duration: number;
  width: number;
  height: number;
  has_audio: boolean;
};
type Settings = {
  obs_mode: boolean;
  obs_folder: string | null;
  output_folder: string;
  remove_audio: boolean;
  today_only: boolean;
  last_source: string | null;
  target_mb: number;
  uncapped: boolean;
};
type Crop = { x: number; y: number; width: number; height: number };
type Progress = { stage: string; fraction: number };
type Result = {
  path: string;
  bytes: number;
  width: number;
  height: number;
  duration: number;
  scale: number;
  quality_warning: boolean;
  has_audio: boolean;
  start: number;
  speed: number;
};
const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`;
const samePath = (a: string, b: string) =>
  a.trim().replace(/^"|"$/g, "").replaceAll("\\", "/").toLowerCase() ===
  b.trim().replaceAll("\\", "/").toLowerCase();
const comparisonRate = (current: number, exported: number) =>
  Math.max(0.0625, Math.min(16, current / exported));
const time = (n: number) =>
  `${Math.floor(n / 60)
    .toString()
    .padStart(2, "0")}:${(n % 60).toFixed(1).padStart(4, "0")}`;
function Icon({
  name,
}: {
  name:
    | "play"
    | "pause"
    | "crop"
    | "film"
    | "arrow"
    | "command"
    | "refresh"
    | "check";
}) {
  const paths = {
    play: "m8 5 11 7-11 7Z",
    pause: "M8 5v14M16 5v14",
    crop: "M6 3v15h15M3 6h15v15",
    film: "M4 4h16v16H4ZM4 9h16M4 15h16M9 4v16M15 4v16",
    arrow: "M4 12h15m-6-6 6 6-6 6",
    command:
      "M9 9H6a3 3 0 1 1 3-3v12a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3H9Z",
    refresh:
      "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1",
    check: "m5 12 4 4L19 6",
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export default function App() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [settings, setSettings] = useState<Settings>();
  const [sourceDraft, setSourceDraft] = useState("");
  const todayOnly = settings?.today_only ?? true;
  const obsMode = settings?.obs_mode ?? true;
  const obsFolder = settings?.obs_folder;
  const removeAudio = settings?.remove_audio ?? true;
  const outputFolder = settings?.output_folder ?? "";
  const targetMb = settings?.target_mb ?? 3.8;
  const uncapped = settings?.uncapped ?? false;
  const targetBytes = Math.round(targetMb * 1_000_000);
  const target = uncapped ? null : targetBytes;
  const validTarget =
    uncapped ||
    (Number.isFinite(targetMb) &&
      Number.isSafeInteger(targetBytes) &&
      targetBytes >= 1_000);
  const updateSettings = (patch: Partial<Settings>) =>
    setSettings((s) => (s ? { ...s, ...patch } : s));
  const setTodayOnly = (value: boolean | ((value: boolean) => boolean)) =>
    updateSettings({
      today_only: typeof value === "function" ? value(todayOnly) : value,
    });
  const [selected, setSelected] = useState<Recording>();
  const [media, setMedia] = useState<Media>();
  const [preview, setPreview] = useState("");
  const [start, setStart] = useState(0),
    [end, setEnd] = useState(0),
    [speed, setSpeed] = useState(1);
  const [filename, setFilename] = useState("");
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, width: 2, height: 2 });
  const [cropping, setCropping] = useState(false);
  const [playhead, setPlayhead] = useState(0),
    [playing, setPlaying] = useState(false);
  const [jobBusy, setBusy] = useState(false),
    [progress, setProgress] = useState<Progress>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const busy = jobBusy || dialogOpen;
  const [error, setError] = useState(""),
    [result, setResult] = useState<Result>();
  const [compare, setCompare] = useState(true);
  const [palette, setPalette] = useState(false),
    [query, setQuery] = useState("");
  const sourceVideo = useRef<HTMLVideoElement>(null),
    outputVideo = useRef<HTMLVideoElement>(null);
  const cropSurface = useRef<HTMLDivElement>(null);
  const sourceGround = useRef<HTMLDivElement>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const requestId = useRef(0);
  const settingsWrites = useRef<Promise<unknown>>(Promise.resolve());
  const sourceDirty = selected
    ? !samePath(sourceDraft, selected.path)
    : !!sourceDraft.trim();
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void invoke<Settings>("load_settings")
      .then((s) => {
        if (!active) return;
        setSettings(s);
        if (s.last_source) void selectSource(s.last_source);
      })
      .catch((e) => setError(String(e)));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!settings || !isTauri()) return;
    settingsWrites.current = settingsWrites.current
      .catch(() => {})
      .then(() => invoke("save_settings", { settings }))
      .catch((e) => setError(`Could not save preferences: ${e}`));
  }, [settings]);
  const refresh = useCallback(async () => {
    if (!isTauri() || !obsMode || !obsFolder) {
      setRecordings([]);
      return;
    }
    try {
      setRecordings(
        await invoke<Recording[]>("list_recordings", {
          folder: obsFolder,
          todayOnly,
        }),
      );
    } catch (e) {
      setError(String(e));
    }
  }, [todayOnly, obsMode, obsFolder]);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<Progress>("encode-progress", (e) =>
      setProgress(e.payload),
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    const ground = sourceGround.current;
    if (!ground || !media || !preview) return;
    const resize = () => {
      const ratio = media.width / media.height;
      const width = Math.max(
        0,
        Math.min(ground.clientWidth - 28, (ground.clientHeight - 28) * ratio),
      );
      setSurfaceSize({ width, height: width / ratio });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(ground);
    resize();
    return () => observer.disconnect();
  }, [media, preview, compare, result, obsMode]);
  useEffect(() => {
    if (
      sourceVideo.current &&
      Number.isFinite(speed) &&
      speed >= 0.25 &&
      speed <= 8
    )
      sourceVideo.current.playbackRate = speed;
    if (outputVideo.current && result && speed >= 0.25 && speed <= 8)
      outputVideo.current.playbackRate = comparisonRate(speed, result.speed);
  }, [speed, result, compare]);
  async function selectSource(filepath: string) {
    if (jobBusy || !filepath.trim()) return;
    const path = filepath.trim().replace(/^"|"$/g, "");
    const name = path.split(/[\\/]/).pop() || "clip";
    const id = ++requestId.current;
    sourceVideo.current?.pause();
    setSelected({ name, path, bytes: 0 });
    setSourceDraft(path);
    setMedia(undefined);
    setPreview("");
    setResult(undefined);
    setError("");
    setPlaying(false);
    setPlayhead(0);
    setCropping(false);
    setFilename(`${name.replace(/\.[^.]+$/, "") || "clip"}-web`);
    setBusy(true);
    setProgress({ stage: "Reading recording", fraction: 0 });
    try {
      const metadata = await invoke<Media>("inspect_recording", {
        name: path,
      });
      if (id !== requestId.current) return;
      setMedia(metadata);
      setStart(0);
      setEnd(metadata.duration);
      setSpeed(1);
      setCrop({ x: 0, y: 0, width: metadata.width, height: metadata.height });
      const previewPath = await invoke<string>("prepare_preview", {
        name: path,
      });
      if (id === requestId.current) {
        setPreview(convertFileSrc(previewPath));
        updateSettings({ last_source: filepath.trim().replace(/^"|"$/g, "") });
      }
    } catch (e) {
      if (id === requestId.current) setError(String(e));
    } finally {
      if (id === requestId.current) {
        setBusy(false);
        setProgress(undefined);
      }
    }
  }
  async function browseSource() {
    if (busy || !settings) return;
    setDialogOpen(true);
    try {
      const path = await invoke<string | null>("choose_source", {
        current: selected?.path ?? null,
      });
      if (path) await selectSource(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setDialogOpen(false);
    }
  }
  async function chooseObsFolder() {
    if (busy || !settings) return;
    setDialogOpen(true);
    try {
      const folder = await invoke<string | null>("choose_obs_folder", {
        current: obsFolder ?? null,
      });
      if (folder) updateSettings({ obs_folder: folder });
    } catch (e) {
      setError(String(e));
    } finally {
      setDialogOpen(false);
    }
  }
  async function saveAs() {
    if (busy || !settings) return;
    setDialogOpen(true);
    try {
      const destination = await invoke<{
        folder: string;
        filename: string;
      } | null>("choose_destination", {
        folder: outputFolder,
        filename: filename.trim() || "clip-web",
      });
      if (destination) {
        updateSettings({ output_folder: destination.folder });
        setFilename(destination.filename);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setDialogOpen(false);
    }
  }
  const finalDuration = (end - start) / speed;
  const valid =
    !!preview &&
    !!media &&
    start >= 0 &&
    end > start &&
    end <= media.duration &&
    speed >= 0.25 &&
    speed <= 8 &&
    filename.trim().length > 0 &&
    !sourceDirty &&
    !!outputFolder &&
    validTarget;
  function seek(t: number) {
    const v = sourceVideo.current;
    if (!v) return;
    v.currentTime = t;
    setPlayhead(t);
    if (result && outputVideo.current)
      outputVideo.current.currentTime = Math.max(
        0,
        Math.min(result.duration, (t - result.start) / result.speed),
      );
  }
  function togglePlayback() {
    const v = sourceVideo.current;
    if (!v) return;
    if (!v.paused) {
      v.pause();
      outputVideo.current?.pause();
      return;
    }
    if (v.currentTime < start || v.currentTime >= end) seek(start);
    v.playbackRate = speed;
    void v.play().catch((e) => setError(String(e)));
    if (result && compare && outputVideo.current) {
      outputVideo.current.playbackRate = comparisonRate(speed, result.speed);
      void outputVideo.current.play().catch(() => {});
    }
  }
  function mark(which: "start" | "end") {
    if (which === "start") setStart(Math.min(playhead, end - 0.1));
    else setEnd(Math.max(playhead, start + 0.1));
  }
  async function encode() {
    if (!selected || !valid || busy || sourceDirty || !outputFolder) return;
    sourceVideo.current?.pause();
    outputVideo.current?.pause();
    setBusy(true);
    setError("");
    setProgress({ stage: "Preparing export", fraction: 0 });
    const saved = { start, speed };
    try {
      const output = await invoke<Omit<Result, "start" | "speed">>(
        "export_video",
        {
          request: {
            source: selected.path,
            filename: filename.trim(),
            output_folder: outputFolder,
            remove_audio: removeAudio,
            start,
            end,
            speed,
            target,
            crop,
          },
        },
      );
      setResult({ ...output, ...saved });
      setCompare(true);
      seek(start);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  }
  const reveal = () => {
    if (result)
      void invoke("reveal_export", { path: result.path }).catch((e) =>
        setError(String(e)),
      );
  };
  const resetCrop = () => {
    if (media) {
      setCrop({ x: 0, y: 0, width: media.width, height: media.height });
      setCropping(false);
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        if (!busy) void browseSource();
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "s"
      ) {
        e.preventDefault();
        if (!busy) void saveAs();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (!palette) void encode();
        return;
      }
      if (
        palette ||
        (e.target instanceof HTMLElement &&
          ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName))
      )
        return;
      if (!busy && preview) {
        if (e.code === "Space") {
          e.preventDefault();
          togglePlayback();
        }
        if (e.key.toLowerCase() === "i") mark("start");
        if (e.key.toLowerCase() === "o") mark("end");
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          seek(Math.max(0, playhead - (e.shiftKey ? 1 : 1 / 30)));
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          seek(
            Math.min(
              media?.duration ?? 0,
              playhead + (e.shiftKey ? 1 : 1 / 30),
            ),
          );
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  function point(e: PointerEvent) {
    const rect = cropSurface.current!.getBoundingClientRect();
    return {
      x: Math.round(
        Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) *
          media!.width,
      ),
      y: Math.round(
        Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) *
          media!.height,
      ),
    };
  }
  function dragCrop(e: PointerEvent) {
    if (!drag.current || !media) return;
    const p = point(e),
      a = drag.current;
    const x = Math.min(a.x, p.x, media.width - 2),
      y = Math.min(a.y, p.y, media.height - 2);
    const width = Math.min(media.width - x, Math.max(2, Math.abs(p.x - a.x))),
      height = Math.min(media.height - y, Math.max(2, Math.abs(p.y - a.y)));
    setCrop({
      x: Math.min(x, media.width - 2),
      y: Math.min(y, media.height - 2),
      width,
      height,
    });
  }
  const commands = [
    {
      id: "browse",
      label: "Browse for source file",
      shortcut: ["Ctrl+O"],
      disabled: busy || !settings,
      run: () => void browseSource(),
    },
    {
      id: "obs-mode",
      label: obsMode ? "Turn OBS mode off" : "Turn OBS mode on",
      disabled: busy || !settings,
      run: () => updateSettings({ obs_mode: !obsMode }),
    },
    {
      id: "obs-folder",
      label: "Change OBS cache folder",
      disabled: busy || !settings,
      run: () => void chooseObsFolder(),
    },
    {
      id: "save-as",
      label: "Save As…",
      shortcut: ["Ctrl+Shift+S"],
      disabled: busy || !settings,
      run: () => void saveAs(),
    },
    {
      id: "audio",
      label: removeAudio ? "Keep audio" : "Remove audio",
      disabled: busy || !settings,
      run: () => updateSettings({ remove_audio: !removeAudio }),
    },
    {
      id: "export",
      label: "Export clip",
      shortcut: ["Ctrl+Enter"],
      disabled: !valid || busy,
      run: () => void encode(),
    },
    {
      id: "older",
      label: todayOnly ? "Show all recordings" : "Show today’s recordings",
      run: () => setTodayOnly((v) => !v),
    },
    { id: "refresh", label: "Refresh recordings", run: () => void refresh() },
    {
      id: "start",
      label: "Set start at playhead",
      shortcut: ["I"],
      disabled: !preview || busy,
      run: () => mark("start"),
    },
    {
      id: "end",
      label: "Set end at playhead",
      shortcut: ["O"],
      disabled: !preview || busy,
      run: () => mark("end"),
    },
    {
      id: "crop",
      label: "Draw a crop",
      disabled: !preview || busy,
      run: () => setCropping(true),
    },
    {
      id: "reset",
      label: "Reset crop",
      disabled: !media || busy,
      run: resetCrop,
    },
    {
      id: "reveal",
      label: "Reveal export in Explorer",
      disabled: !result,
      run: reveal,
    },
    {
      id: "compare",
      label: "Toggle comparison",
      disabled: !result,
      run: () => {
        outputVideo.current?.pause();
        setCompare((v) => !v);
      },
    },
    {
      id: "target-size",
      label: "Set target filesize",
      disabled: busy || !settings,
      run: () => {
        updateSettings({ uncapped: false });
        requestAnimationFrame(() => {
          const input = document.getElementById(
            "target-mb",
          ) as HTMLInputElement | null;
          input?.focus();
          input?.select();
        });
      },
    },
    {
      id: "uncapped",
      label: uncapped ? "Use filesize limit" : "Use uncapped encoding",
      disabled: busy || !settings,
      run: () => updateSettings({ uncapped: !uncapped }),
    },
  ];
  return (
    <div className={`app ${obsMode ? "" : "obs-off"}`}>
      {obsMode && (
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="film" />
            </span>
            <span>
              Encoder<small>WHITE VANILLA SKIES</small>
            </span>
          </div>
          <div className="sidebar-title">
            <span>{todayOnly ? "Today’s recordings" : "All recordings"}</span>
            <button
              className="icon-button"
              title="Refresh recordings"
              onClick={() => void refresh()}
            >
              <Icon name="refresh" />
            </button>
          </div>
          <div className="recording-list">
            {recordings.map((r) => (
              <button
                key={r.name}
                disabled={busy}
                className={`recording ${selected && samePath(selected.path, r.path) ? "selected" : ""}`}
                onClick={() => void selectSource(r.path)}
              >
                <span className="recording-icon">
                  <Icon name="film" />
                </span>
                <span className="recording-name">
                  <strong>{r.name.slice(11, 19).replaceAll("-", ":")}</strong>
                  <small>
                    {r.name.slice(0, 10)} ·{" "}
                    {r.name.split(".").pop()?.toUpperCase()}
                  </small>
                </span>
                <span className="recording-size">{mb(r.bytes)}</span>
              </button>
            ))}
            {!recordings.length && (
              <div className="sidebar-empty">
                {!obsFolder
                  ? "Choose your OBS cache folder to show recordings here."
                  : isTauri()
                    ? "No matching recordings."
                    : "Open the desktop app to load OBS recordings."}
                <button
                  disabled={busy || !settings}
                  onClick={() =>
                    obsFolder ? setTodayOnly(false) : void chooseObsFolder()
                  }
                >
                  {obsFolder ? "Show older recordings" : "Choose OBS folder…"}
                </button>
              </div>
            )}
          </div>
          <div className="sidebar-bottom">
            <span className="live-dot" /> OBS cache
            <code title={obsFolder ?? ""}>{obsFolder ?? "Not configured"}</code>
            <button
              className="change-folder"
              disabled={busy || !settings}
              onClick={() => void chooseObsFolder()}
            >
              Change folder…
            </button>
            <button
              className="palette-trigger"
              onClick={() => {
                setQuery("");
                setPalette(true);
              }}
            >
              <Icon name="command" /> Commands <kbd>Ctrl K</kbd>
            </button>
          </div>
        </aside>
      )}
      <main>
        <header>
          <div>
            <div className="eyebrow">FROM RECORDING TO SOMETHING SHAREABLE</div>
            <h1>
              A little less footage.
              <br />
              <span>A little more focus.</span>
            </h1>
          </div>
          <div className="header-tools">
            <div className="mode-tools">
              <label>
                <input
                  type="checkbox"
                  checked={obsMode}
                  disabled={busy || !settings}
                  onChange={(e) =>
                    updateSettings({ obs_mode: e.target.checked })
                  }
                />{" "}
                OBS mode
              </label>
              <button
                title="Commands (Ctrl K)"
                onClick={() => {
                  setQuery("");
                  setPalette(true);
                }}
              >
                <Icon name="command" />
              </button>
            </div>
            <div className="format-badge">
              <span className="live-dot" /> H.264 <span> / </span> MP4{" "}
              <span> / </span> {removeAudio ? "Silent" : "Audio kept"}
            </div>
          </div>
        </header>
        <div className="workspace-heading">
          <div className="source-controls">
            <label htmlFor="source-path" className="source-label">
              SOURCE FILE
            </label>
            <form
              className="source-field"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void selectSource(sourceDraft);
              }}
            >
              <input
                id="source-path"
                aria-label="Source file"
                disabled={busy || !settings}
                value={sourceDraft}
                placeholder="Choose a recording or enter a video filepath"
                title={sourceDraft}
                onChange={(e) => setSourceDraft(e.target.value)}
              />
              {sourceDirty && (
                <button disabled={busy || !sourceDraft.trim()}>Load</button>
              )}
              <button
                type="button"
                disabled={busy || !settings}
                onClick={() => void browseSource()}
              >
                Browse…
              </button>
            </form>
            <span>
              {media
                ? `${media.width} × ${media.height} · ${time(media.duration)}`
                : "Your next demo starts here."}
              {sourceDirty ? " · press Enter or Load to open" : ""}
            </span>
          </div>
          <div className="heading-actions">
            {result && (
              <button
                onClick={() => {
                  outputVideo.current?.pause();
                  setCompare((v) => !v);
                }}
              >
                {compare ? "Single view" : "Compare"}
              </button>
            )}
            <button
              disabled={!preview || busy}
              className={cropping ? "active" : ""}
              onClick={() => {
                sourceVideo.current?.pause();
                setCropping((v) => !v);
              }}
            >
              <Icon name="crop" /> {cropping ? "Done cropping" : "Crop"}
            </button>
          </div>
        </div>
        <div className={`viewports ${result && compare ? "split" : ""}`}>
          <section className="viewport">
            <div className="viewport-label">
              <span>SOURCE</span>
              <span>
                {cropping
                  ? "Drag to frame your clip"
                  : removeAudio
                    ? "Muted preview"
                    : media?.has_audio
                      ? "Audio preview"
                      : "No audio track"}
              </span>
            </div>
            <div className="video-ground" ref={sourceGround}>
              {preview && media ? (
                <div
                  className={`video-surface ${cropping ? "cropping" : ""}`}
                  ref={cropSurface}
                  style={{
                    width: surfaceSize.width,
                    height: surfaceSize.height,
                  }}
                  onPointerDown={(e) => {
                    if (!cropping || busy) return;
                    drag.current = point(e);
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={dragCrop}
                  onPointerUp={(e) => {
                    dragCrop(e);
                    drag.current = null;
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                  }}
                >
                  <video
                    ref={sourceVideo}
                    src={preview}
                    muted={removeAudio}
                    playsInline
                    preload="auto"
                    onLoadedMetadata={() => seek(start)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => {
                      setPlaying(false);
                      outputVideo.current?.pause();
                    }}
                    onEnded={() => {
                      setPlaying(false);
                      outputVideo.current?.pause();
                    }}
                    onError={() =>
                      setError(
                        "Could not play the preview. Try selecting the recording again.",
                      )
                    }
                    onTimeUpdate={(e) => {
                      const v = e.currentTarget;
                      setPlayhead(v.currentTime);
                      if (!v.paused && v.currentTime >= end) {
                        v.pause();
                        seek(end);
                      }
                      const out = outputVideo.current;
                      if (
                        out &&
                        result &&
                        compare &&
                        !out.seeking &&
                        !v.seeking
                      ) {
                        const t = Math.max(
                          0,
                          Math.min(
                            result.duration,
                            (v.currentTime - result.start) / result.speed,
                          ),
                        );
                        if (Math.abs(out.currentTime - t) > 0.18)
                          out.currentTime = t;
                      }
                    }}
                  />
                  {(cropping ||
                    crop.width !== media.width ||
                    crop.height !== media.height) && (
                    <div
                      className="crop-box"
                      style={{
                        left: `${(crop.x / media.width) * 100}%`,
                        top: `${(crop.y / media.height) * 100}%`,
                        width: `${(crop.width / media.width) * 100}%`,
                        height: `${(crop.height / media.height) * 100}%`,
                      }}
                    >
                      <i />
                      <i />
                      <i />
                      <i />
                      <span>
                        {crop.width} × {crop.height}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="preview-empty">
                  <Icon name="film" />
                  <strong>
                    {busy ? progress?.stage : "Make room for the good part."}
                  </strong>
                  <p>
                    {busy
                      ? "Preparing a browser-friendly preview…"
                      : "Browse for a video or select an OBS recording."}
                  </p>
                </div>
              )}
            </div>
          </section>
          {result && compare && (
            <section className="viewport">
              <div className="viewport-label">
                <span>EXPORT</span>
                <span>
                  {result.width} × {result.height} · {mb(result.bytes)}
                </span>
              </div>
              <div className="video-ground">
                <video
                  className="output-video"
                  ref={outputVideo}
                  src={convertFileSrc(result.path)}
                  muted
                  playsInline
                  preload="auto"
                  onLoadedMetadata={() => {
                    if (outputVideo.current)
                      outputVideo.current.currentTime = Math.max(
                        0,
                        (playhead - result.start) / result.speed,
                      );
                  }}
                />
              </div>
            </section>
          )}
        </div>
        <div className="transport">
          <button
            className="play-button"
            disabled={!preview || busy}
            onClick={togglePlayback}
            aria-label={playing ? "Pause" : "Play"}
          >
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <code>{time(playhead)}</code>
          <input
            aria-label="Playhead"
            type="range"
            min={0}
            max={media?.duration ?? 1}
            step="0.033333"
            value={playhead}
            disabled={!preview || busy}
            onChange={(e) => seek(Number(e.target.value))}
          />
          <code className="muted">{time(media?.duration ?? 0)}</code>
        </div>
        <fieldset disabled={busy || !media} className="editor-controls">
          <section className="trim-section">
            <div className="section-label">
              <span>01</span> Keep the moment <small>I / O to mark</small>
            </div>
            <div className="trim-track">
              <div
                className="trim-selection"
                style={{
                  left: `${(start / (media?.duration || 1)) * 100}%`,
                  right: `${100 - (end / (media?.duration || 1)) * 100}%`,
                }}
              />
              <input
                aria-label="Trim start"
                type="range"
                min="0"
                max={media?.duration || 1}
                step="0.1"
                value={start}
                onChange={(e) =>
                  setStart(Math.min(Number(e.target.value), end - 0.1))
                }
              />
              <input
                aria-label="Trim end"
                type="range"
                min="0"
                max={media?.duration || 1}
                step="0.1"
                value={end}
                onChange={(e) =>
                  setEnd(Math.max(Number(e.target.value), start + 0.1))
                }
              />
            </div>
            <div className="trim-fields">
              <label>
                Start{" "}
                <input
                  aria-label="Start seconds"
                  type="number"
                  min="0"
                  max={end - 0.1}
                  step="0.1"
                  value={Number(start.toFixed(2))}
                  onChange={(e) => setStart(Number(e.target.value))}
                />
                <button
                  title="Set start at playhead (I)"
                  onClick={() => mark("start")}
                >
                  Set I
                </button>
              </label>
              <span>→</span>
              <label>
                End{" "}
                <input
                  aria-label="End seconds"
                  type="number"
                  min={start + 0.1}
                  max={media?.duration}
                  step="0.1"
                  value={Number(end.toFixed(2))}
                  onChange={(e) => setEnd(Number(e.target.value))}
                />
                <button
                  title="Set end at playhead (O)"
                  onClick={() => mark("end")}
                >
                  Set O
                </button>
              </label>
              <span className="duration">
                {time(Math.max(0, end - start))} selected
              </span>
            </div>
          </section>
          <section className="speed-section">
            <div className="section-label">
              <span>02</span> Pick up the pace
            </div>
            <div className="speed-options">
              {[1, 1.25, 1.5, 2].map((s) => (
                <button
                  key={s}
                  className={speed === s ? "active" : ""}
                  onClick={() => setSpeed(s)}
                >
                  {s}×
                </button>
              ))}
            </div>
            <label className="custom-speed">
              Custom{" "}
              <input
                aria-label="Custom speed"
                type="number"
                min="0.25"
                max="8"
                step="0.05"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              />{" "}
              ×
              <strong>
                {time(
                  Number.isFinite(finalDuration)
                    ? Math.max(0, finalDuration)
                    : 0,
                )}{" "}
                final
              </strong>
            </label>
          </section>
          <section className="crop-section">
            <div className="section-label">
              <span>03</span> Frame it{" "}
              <button onClick={resetCrop}>Reset</button>
            </div>
            <div className="crop-fields">
              {(["x", "y", "width", "height"] as const).map((key) => (
                <label key={key}>
                  {key === "width"
                    ? "W"
                    : key === "height"
                      ? "H"
                      : key.toUpperCase()}
                  <input
                    aria-label={`Crop ${key}`}
                    type="number"
                    min={key === "width" || key === "height" ? 2 : 0}
                    max={
                      key === "x" || key === "width"
                        ? media?.width
                        : media?.height
                    }
                    value={crop[key]}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (!media) return;
                      setCrop((c) =>
                        key === "x"
                          ? {
                              ...c,
                              x: Math.min(
                                Math.max(0, n),
                                media.width - c.width,
                              ),
                            }
                          : key === "y"
                            ? {
                                ...c,
                                y: Math.min(
                                  Math.max(0, n),
                                  media.height - c.height,
                                ),
                              }
                            : key === "width"
                              ? {
                                  ...c,
                                  width: Math.min(
                                    Math.max(2, n),
                                    media.width - c.x,
                                  ),
                                }
                              : {
                                  ...c,
                                  height: Math.min(
                                    Math.max(2, n),
                                    media.height - c.y,
                                  ),
                                },
                      );
                    }}
                  />
                </label>
              ))}
            </div>
          </section>
        </fieldset>
        {finalDuration > 60 && (
          <div className="notice">
            This clip runs over a minute. Consider trimming it or picking up the
            pace.
          </div>
        )}
        <div className="export-bar">
          <div className="size-control">
            <label htmlFor="target-mb">SIZE LIMIT</label>
            <div className="filesize-control">
              <div className={`filesize-input ${uncapped ? "disabled" : ""}`}>
                <input
                  id="target-mb"
                  aria-label="Target filesize in MB"
                  type="number"
                  min="0.001"
                  step="any"
                  disabled={busy || uncapped || !settings}
                  value={targetMb}
                  aria-invalid={!validTarget}
                  onChange={(e) =>
                    updateSettings({ target_mb: Number(e.target.value) })
                  }
                />
                <span>MB</span>
              </div>
              <label className="uncapped-toggle">
                <input
                  type="checkbox"
                  checked={uncapped}
                  disabled={busy || !settings}
                  onChange={(e) =>
                    updateSettings({ uncapped: e.target.checked })
                  }
                />{" "}
                Uncapped
              </label>
            </div>
          </div>
          <label className="filename">
            OUTPUT NAME
            <div>
              <input
                aria-label="Output filename"
                disabled={busy}
                placeholder="my-next-demo"
                value={filename}
                onChange={(e) =>
                  setFilename(e.target.value.replace(/\.mp4$/i, ""))
                }
              />
              <span>.mp4</span>
            </div>
          </label>
          <button
            className="save-as-button"
            disabled={busy || !settings}
            onClick={() => void saveAs()}
          >
            Save As…
          </button>
          <button
            className="export-button"
            disabled={!valid || busy}
            onClick={() => void encode()}
          >
            Export clip <Icon name="arrow" />
          </button>
        </div>
        {!validTarget && (
          <div className="notice" role="alert">
            Enter a positive filesize limit of at least 0.001 MB, or enable
            Uncapped.
          </div>
        )}
        <div className="export-note">
          {target === null
            ? "Quality first · CRF 23"
            : "Fits your limit · resolution adapts when needed"}
          <label className="audio-toggle">
            <input
              type="checkbox"
              checked={removeAudio}
              disabled={busy || !settings}
              onChange={(e) =>
                updateSettings({ remove_audio: e.target.checked })
              }
            />{" "}
            Remove audio
          </label>
        </div>
        <div className="destination" title={outputFolder}>
          Saving to <span>{outputFolder || "Loading export folder…"}</span>
          <small>30 fps · ready for the web</small>
        </div>
        {progress && (
          <div className="progress-row" role="status">
            <div>
              <strong>{progress.stage}</strong>
              <span>{Math.round(progress.fraction * 100)}%</span>
            </div>
            <progress max="1" value={progress.fraction} />
            <button onClick={() => void invoke("cancel_job")}>Cancel</button>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {result?.quality_warning && (
          <div className="notice">
            This size budget falls below the estimated quality floor even at
            half resolution. Check text clarity, or export with a larger limit.
          </div>
        )}
        {result && (
          <div className="success">
            <Icon name="check" />
            <div>
              <strong>Ready to share · {mb(result.bytes)}</strong>
              <span>
                {time(result.duration)} · {result.width} × {result.height}
                {result.scale < 1
                  ? ` · reduced to ${result.scale * 100}% resolution`
                  : ""}{" "}
                · {result.path.split(/[\\/]/).pop()}
              </span>
            </div>
            <button onClick={reveal}>Show in Explorer ↗</button>
          </div>
        )}
        <footer>
          <span>Less friction. More showing.</span>
          <span>
            Space <b>play</b> · ← → <b>frame</b> · Ctrl Enter <b>export</b>
          </span>
        </footer>
      </main>
      <Palette
        open={palette}
        onClose={() => setPalette(false)}
        items={commands}
        onSelect={(item) => {
          commands.find((c) => c.id === item.id)?.run();
          setPalette(false);
          setQuery("");
        }}
        query={query}
        onQueryChange={setQuery}
        density="compact"
        placeholder="What would you like to do?"
      />
    </div>
  );
}
