// Development-only UI fixture. No filesystem or encoding commands are executed.
import { mockIPC } from "@tauri-apps/api/mocks";
const name = "2026-10-12_11-50-01.mkv";
mockIPC(
  (cmd, args) => {
    if (cmd === "list_recordings") return [{ name, bytes: 17979026 }];
    if (cmd === "inspect_recording")
      return { duration: 14.463, width: 1920, height: 1080 };
    if (cmd === "prepare_preview") return "/.work/ui-preview.mp4";
    if (cmd === "export_video") {
      const r = (args as Record<string, unknown>)?.request as {
        start: number;
        end: number;
        speed: number;
        crop: { width: number; height: number };
      };
      return {
        path: "/.work/ui-output.mp4",
        bytes: 1215406,
        width: r.crop.width,
        height: r.crop.height,
        duration: (r.end - r.start) / r.speed,
        scale: 1,
        quality_warning: false,
      };
    }
  },
  { shouldMockEvents: true },
);
Object.defineProperty(window, "isTauri", { value: true });
// convertFileSrc is a native transport in production, a local fixture URL here.
(
  window as unknown as {
    __TAURI_INTERNALS__: { convertFileSrc: (p: string) => string };
  }
).__TAURI_INTERNALS__.convertFileSrc = (p) => p;
