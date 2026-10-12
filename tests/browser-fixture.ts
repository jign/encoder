// Development-only UI fixture. No filesystem or encoding commands are executed.
import { mockIPC } from "@tauri-apps/api/mocks";
const name = "2026-10-12_11-50-01.mkv";
let settings = JSON.parse(
  localStorage.getItem("encoder-fixture-settings") || "null",
) || {
  obs_mode: true,
  obs_folder: "E:\\cache\\obs",
  output_folder: "D:\\Clips",
  remove_audio: true,
  today_only: true,
  last_source: null,
};
mockIPC(
  (cmd, args) => {
    if (cmd === "load_settings")
      return { target_mb: 3.8, uncapped: false, ...settings };
    if (cmd === "save_settings") {
      settings = (args as Record<string, unknown>).settings;
      localStorage.setItem(
        "encoder-fixture-settings",
        JSON.stringify(settings),
      );
      return null;
    }
    if (cmd === "choose_source") return "D:\\Videos\\custom-demo.mov";
    if (cmd === "choose_obs_folder") return "D:\\OBS recordings";
    if (cmd === "choose_destination")
      return { folder: "D:\\Shared demos", filename: "my-shareable-clip" };
    if (cmd === "list_recordings")
      return [
        {
          name,
          path: `${(args as Record<string, unknown>).folder}\\${name}`,
          bytes: 17979026,
        },
      ];
    if (cmd === "inspect_recording")
      return { duration: 14.463, width: 1920, height: 1080, has_audio: true };
    if (cmd === "prepare_preview") return "/.work/ui-preview.mp4";
    if (cmd === "export_video") {
      const r = (args as Record<string, unknown>)?.request as {
        start: number;
        end: number;
        speed: number;
        crop: { width: number; height: number };
        remove_audio: boolean;
      };
      return {
        path: "/.work/ui-output.mp4",
        bytes: 1215406,
        width: r.crop.width,
        height: r.crop.height,
        duration: (r.end - r.start) / r.speed,
        scale: 1,
        quality_warning: false,
        has_audio: !r.remove_audio,
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
