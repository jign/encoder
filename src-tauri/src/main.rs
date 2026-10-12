#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
const OBS: &str = "E:\\cache\\obs";
#[derive(Default)]
struct Jobs {
    busy: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}
#[derive(Serialize)]
struct Recording {
    name: String,
    bytes: u64,
}
#[derive(Serialize, Deserialize, Clone)]
struct Media {
    duration: f64,
    width: u32,
    height: u32,
}
#[derive(Deserialize, Clone)]
struct Crop {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}
#[derive(Deserialize, Clone)]
struct ExportRequest {
    source: String,
    filename: String,
    start: f64,
    end: f64,
    speed: f64,
    target: Option<u64>,
    crop: Crop,
}
#[derive(Serialize, Debug)]
struct ExportResult {
    path: String,
    bytes: u64,
    width: u32,
    height: u32,
    duration: f64,
    scale: f64,
    quality_warning: bool,
}
#[derive(Serialize, Clone)]
struct Progress {
    stage: String,
    fraction: f64,
}

fn command(bin: &str) -> Command {
    let mut c = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c
}
fn conventional(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    stem.len() == 19
        && ["mkv", "mp4", "mov"].contains(&ext)
        && stem.bytes().enumerate().all(|(i, c)| match i {
            4 | 7 | 13 | 16 => c == b'-',
            10 => c == b'_',
            _ => c.is_ascii_digit(),
        })
}
fn source(name: &str) -> Result<PathBuf, String> {
    if !conventional(name) {
        return Err("Select a conventional OBS recording.".into());
    }
    let p = Path::new(OBS).join(name);
    let p = p.canonicalize().map_err(|e| e.to_string())?;
    if p.parent()
        != Some(
            Path::new(OBS)
                .canonicalize()
                .map_err(|e| e.to_string())?
                .as_path(),
        )
    {
        return Err("Recording must be inside the OBS folder.".into());
    }
    Ok(p)
}
fn probe(p: &Path) -> Result<Media, String> {
    let o = command("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "json",
        ])
        .arg(p)
        .output()
        .map_err(|_| {
            "FFprobe is missing. Install FFmpeg and add its bin directory to PATH.".to_string()
        })?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr).into());
    }
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())?;
    let m = Media {
        duration: v["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.),
        width: v["streams"][0]["width"].as_u64().unwrap_or(0) as u32,
        height: v["streams"][0]["height"].as_u64().unwrap_or(0) as u32,
    };
    if m.duration <= 0. || m.width < 2 || m.height < 2 {
        return Err("Recording is incomplete or has no readable video.".into());
    }
    Ok(m)
}
#[tauri::command]
fn list_recordings(today_only: bool) -> Result<Vec<Recording>, String> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut list: Vec<_> = fs::read_dir(OBS)
        .map_err(|e| format!("Cannot read {OBS}: {e}"))?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let m = e.metadata().ok()?;
            (m.is_file() && conventional(&name) && (!today_only || name.starts_with(&today)))
                .then_some(Recording {
                    name,
                    bytes: m.len(),
                })
        })
        .collect();
    list.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(list)
}
#[tauri::command]
async fn inspect_recording(name: String) -> Result<Media, String> {
    tauri::async_runtime::spawn_blocking(move || probe(&source(&name)?))
        .await
        .map_err(|e| e.to_string())?
}
fn emit(app: Option<&tauri::AppHandle>, stage: &str, fraction: f64) {
    if let Some(app) = app {
        let _ = app.emit(
            "encode-progress",
            Progress {
                stage: stage.into(),
                fraction,
            },
        );
    }
}
fn run(
    app: Option<&tauri::AppHandle>,
    args: &[String],
    dir: &Path,
    cancel: &AtomicBool,
    stage: &str,
    duration: f64,
) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".into());
    }
    emit(app, stage, 0.);
    let log = dir.join("ffmpeg.log");
    let mut child = command("ffmpeg")
        .args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-progress",
            "pipe:1",
            "-nostats",
        ])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::from(
            fs::File::create(&log).map_err(|e| e.to_string())?,
        ))
        .spawn()
        .map_err(|_| {
            "FFmpeg is missing. Install FFmpeg and add its bin directory to PATH.".to_string()
        })?;
    let stdout = child.stdout.take().unwrap();
    let handle = app.cloned();
    let label = stage.to_string();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(t) = line
                .strip_prefix("out_time_us=")
                .and_then(|s| s.parse::<f64>().ok())
            {
                emit(
                    handle.as_ref(),
                    &label,
                    (t / 1_000_000. / duration).clamp(0., 1.),
                );
            }
        }
    });
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err("Cancelled".into());
        }
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        std::thread::sleep(Duration::from_millis(80));
    };
    let _ = reader.join();
    if status.success() {
        Ok(())
    } else {
        let log = fs::read_to_string(log).unwrap_or_default();
        Err(log
            .chars()
            .rev()
            .take(1800)
            .collect::<String>()
            .chars()
            .rev()
            .collect())
    }
}
fn strings(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}
fn cache(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let p = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}
struct Guard(Arc<AtomicBool>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn claim(jobs: &Jobs) -> Result<Guard, String> {
    if jobs.busy.swap(true, Ordering::SeqCst) {
        return Err("Wait for the current operation to finish.".into());
    }
    jobs.cancel.store(false, Ordering::SeqCst);
    Ok(Guard(jobs.busy.clone()))
}
#[tauri::command]
fn cancel_job(jobs: tauri::State<Jobs>) {
    jobs.cancel.store(true, Ordering::SeqCst);
}
#[tauri::command]
async fn prepare_preview(
    app: tauri::AppHandle,
    jobs: tauri::State<'_, Jobs>,
    name: String,
) -> Result<String, String> {
    let guard = claim(&jobs)?;
    let cancel = jobs.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let p = source(&name)?;
        let m = probe(&p)?;
        let dir = cache(&app)?;
        let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
        let stamp = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|t| t.as_secs())
            .unwrap_or(0);
        let preview = dir.join(format!("{name}-{}-{stamp}.mp4", meta.len()));
        if !preview.exists() {
            let tmp = dir.join("preview-part.mp4");
            let mut a = strings(&["-i"]);
            a.push(p.display().to_string());
            a.extend(strings(&[
                "-map",
                "0:v:0",
                "-an",
                "-vf",
                "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,fps=30",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
            ]));
            a.push(tmp.display().to_string());
            let r = run(
                Some(&app),
                &a,
                &dir,
                &cancel,
                "Preparing preview",
                m.duration,
            );
            if r.is_err() {
                let _ = fs::remove_file(&tmp);
                r?;
            }
            fs::rename(tmp, &preview).map_err(|e| e.to_string())?;
        }
        app.asset_protocol_scope()
            .allow_file(&preview)
            .map_err(|e| e.to_string())?;
        Ok(preview.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn validate(r: &ExportRequest, m: &Media) -> Result<(), String> {
    if !r.start.is_finite()
        || !r.end.is_finite()
        || !r.speed.is_finite()
        || r.start < 0.
        || r.end <= r.start
        || r.end > m.duration + 0.05
        || !(0.25..=8.).contains(&r.speed)
    {
        return Err("Check the trim points and speed (0.25–8×).".into());
    }
    let c = &r.crop;
    if c.width < 2
        || c.height < 2
        || c.x.checked_add(c.width).is_none_or(|n| n > m.width)
        || c.y.checked_add(c.height).is_none_or(|n| n > m.height)
    {
        return Err("Crop is outside the recording.".into());
    }
    if r.filename.is_empty()
        || r.filename.len() > 120
        || r.filename
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || r.filename.ends_with(['.', ' '])
    {
        return Err("Use a valid output filename without folders.".into());
    }
    let stem = r
        .filename
        .trim_end_matches(".mp4")
        .split('.')
        .next()
        .unwrap_or("")
        .to_uppercase();
    if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&stem.as_str())
    {
        return Err("That filename is reserved by Windows.".into());
    }
    if r.target.is_some_and(|n| n != 3_800_000 && n != 10_000_000) {
        return Err("Choose 3.8 MB, 10 MB, or Unlimited.".into());
    }
    Ok(())
}
fn filter(r: &ExportRequest, scale: f64) -> (String, u32, u32) {
    let c = &r.crop;
    let w = ((c.width as f64 * scale) as u32 / 2 * 2).max(2);
    let h = ((c.height as f64 * scale) as u32 / 2 * 2).max(2);
    (
        format!(
            "crop={}:{}:{}:{}:exact=1,setpts=(PTS-STARTPTS)/{},scale={w}:{h}:flags=lanczos,setsar=1,fps=30",
            c.width, c.height, c.x, c.y, r.speed
        ),
        w,
        h,
    )
}
fn base(r: &ExportRequest, input: &Path, scale: f64, start: f64, length: f64) -> Vec<String> {
    let mut a = strings(&["-ss", &start.to_string(), "-t", &length.to_string(), "-i"]);
    a.push(input.display().to_string());
    a.extend(strings(&[
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        &filter(r, scale).0,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-pix_fmt",
        "yuv420p",
    ]));
    a
}
fn export(
    app: Option<&tauri::AppHandle>,
    cancel: &AtomicBool,
    r: ExportRequest,
    input: &Path,
    exports: &Path,
    dir: &Path,
) -> Result<ExportResult, String> {
    let m = probe(input)?;
    validate(&r, &m)?;
    fs::create_dir_all(exports).map_err(|e| e.to_string())?;
    let filename = if r.filename.ends_with(".mp4") {
        r.filename.clone()
    } else {
        format!("{}.mp4", r.filename)
    };
    let output = exports.join(filename);
    if output.exists() {
        return Err("That export already exists. Choose another filename.".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let result = (|| {
        let duration = (r.end - r.start) / r.speed;
        let tmp = dir.join("output.mp4");
        let mut quality = base(&r, input, 1., r.start, r.end - r.start);
        quality.extend(strings(&["-crf", "23", "-movflags", "+faststart"]));
        quality.push(tmp.display().to_string());
        run(
            app,
            &quality,
            dir,
            cancel,
            "Encoding · quality first",
            duration,
        )?;
        if r.target
            .is_none_or(|limit| fs::metadata(&tmp).is_ok_and(|m| m.len() <= limit))
        {
            return save_export(&tmp, &output, cancel, 1., false);
        }
        let mut scale = 1.;
        let mut quality_warning = false;
        let mut bitrate = r
            .target
            .map(|n| ((n as f64 * 0.97 * 8. / duration) as u64).max(1000));
        if let Some(budget) = bitrate {
            quality_warning = true;
            // Sample three moments at CRF 28, our quality floor; prefer readable full-resolution text.
            for candidate in [1., 0.75, 0.5] {
                scale = candidate;
                let mut bytes = 0u64;
                let sample_len = ((r.end - r.start) / 3.).min(2. * r.speed);
                for (i, pos) in [0., 0.5, 1.].iter().enumerate() {
                    let p = dir.join(format!("sample-{i}.mp4"));
                    let start = r.start + (r.end - r.start - sample_len) * pos;
                    let mut a = base(&r, input, scale, start, sample_len);
                    a.extend(strings(&["-crf", "28"]));
                    a.push(p.display().to_string());
                    run(
                        app,
                        &a,
                        dir,
                        cancel,
                        &format!("Checking quality · {}%", (scale * 100.) as u32),
                        sample_len / r.speed,
                    )?;
                    bytes += fs::metadata(p).map_err(|e| e.to_string())?.len();
                }
                let required = bytes as f64 * 8. / (3. * sample_len / r.speed);
                if required <= budget as f64 {
                    quality_warning = false;
                    break;
                }
            }
        }
        for attempt in 0..3 {
            let mut a = base(&r, input, scale, r.start, r.end - r.start);
            if let Some(b) = bitrate {
                a.extend(strings(&[
                    "-b:v",
                    &b.to_string(),
                    "-passlogfile",
                    &dir.join("pass").display().to_string(),
                ]));
                let mut first = a.clone();
                first.extend(strings(&["-pass", "1", "-f", "null"]));
                first.push(if cfg!(windows) {
                    "NUL".into()
                } else {
                    "/dev/null".into()
                });
                run(
                    app,
                    &first,
                    dir,
                    cancel,
                    "Encoding · pass 1 of 2",
                    duration,
                )?;
                a.extend(strings(&["-pass", "2"]));
            } else {
                a.extend(strings(&["-crf", "23"]));
            }
            a.extend(strings(&["-movflags", "+faststart"]));
            a.push(tmp.display().to_string());
            run(
                app,
                &a,
                dir,
                cancel,
                if bitrate.is_some() {
                    "Encoding · pass 2 of 2"
                } else {
                    "Encoding"
                },
                duration,
            )?;
            let bytes = fs::metadata(&tmp).map_err(|e| e.to_string())?.len();
            if r.target.is_none_or(|limit| bytes <= limit) {
                return save_export(&tmp, &output, cancel, scale, quality_warning);
            }
            if attempt == 2 {
                return Err("Could not meet the filesize limit. Try a shorter clip or the next size preset.".into());
            }
            bitrate =
                bitrate.map(|b| (b as f64 * r.target.unwrap() as f64 / bytes as f64 * 0.94) as u64);
        }
        unreachable!()
    })();
    let _ = fs::remove_dir_all(dir);
    result
}
fn save_export(
    tmp: &Path,
    output: &Path,
    cancel: &AtomicBool,
    scale: f64,
    quality_warning: bool,
) -> Result<ExportResult, String> {
    let actual = probe(tmp)?;
    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".into());
    }
    let bytes = fs::metadata(tmp).map_err(|e| e.to_string())?.len();
    let mut input = fs::File::open(tmp).map_err(|e| e.to_string())?;
    let mut dest = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|e| format!("Could not save export: {e}"))?;
    if let Err(e) = std::io::copy(&mut input, &mut dest).and_then(|_| dest.sync_all()) {
        drop(dest);
        let _ = fs::remove_file(output);
        return Err(e.to_string());
    }
    Ok(ExportResult {
        path: output.display().to_string(),
        bytes,
        width: actual.width,
        height: actual.height,
        duration: actual.duration,
        scale,
        quality_warning,
    })
}
#[tauri::command]
async fn export_video(
    app: tauri::AppHandle,
    jobs: tauri::State<'_, Jobs>,
    request: ExportRequest,
) -> Result<ExportResult, String> {
    let guard = claim(&jobs)?;
    let cancel = jobs.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let input = source(&request.source)?;
        let exports = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("exports");
        let dir = cache(&app)?.join("export-work");
        let result = export(Some(&app), &cancel, request, &input, &exports, &dir)?;
        app.asset_protocol_scope()
            .allow_file(&result.path)
            .map_err(|e| e.to_string())?;
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn reveal_export(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("exports")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let p = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    if p.parent() != Some(root.as_path()) {
        return Err("Only exports can be revealed.".into());
    }
    command("explorer")
        .arg(format!("/select,{}", p.display()))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn main() {
    tauri::Builder::default()
        .manage(Jobs::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let jobs = window.state::<Jobs>();
                if jobs.busy.load(Ordering::SeqCst) {
                    api.prevent_close();
                    jobs.cancel.store(true, Ordering::SeqCst);
                    let busy = jobs.busy.clone();
                    let app = window.app_handle().clone();
                    std::thread::spawn(move || {
                        while busy.load(Ordering::SeqCst) {
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        app.exit(0);
                    });
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<Jobs>().cancel.store(true, Ordering::SeqCst);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_recordings,
            inspect_recording,
            prepare_preview,
            export_video,
            cancel_job,
            reveal_export
        ])
        .run(tauri::generate_context!())
        .expect("could not run Encoder");
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> ExportRequest {
        ExportRequest {
            source: "2026-10-12_11-50-01.mkv".into(),
            filename: "demo".into(),
            start: 0.,
            end: 20.,
            speed: 1.,
            target: Some(3_800_000),
            crop: Crop {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        }
    }
    #[test]
    fn names() {
        assert!(conventional("2026-10-12_11-50-01.mkv"));
        assert!(!conventional("../2026-10-12_11-50-01.mkv"));
        assert!(!conventional("recording.mkv"));
    }
    #[test]
    fn invalid_inputs() {
        let m = Media {
            duration: 30.,
            width: 1920,
            height: 1080,
        };
        let mut r = request();
        assert!(validate(&r, &m).is_ok());
        r.start = 21.;
        assert!(validate(&r, &m).is_err());
        r.start = 0.;
        r.crop.x = u32::MAX;
        assert!(validate(&r, &m).is_err());
        r.crop.x = 0;
        r.filename = "../demo".into();
        assert!(validate(&r, &m).is_err());
        r.filename = "NUL".into();
        assert!(validate(&r, &m).is_err());
    }
    #[test]
    fn even_dimensions_and_speed() {
        let mut r = request();
        r.crop.width = 1919;
        r.speed = 2.;
        let (f, w, h) = filter(&r, 0.75);
        assert_eq!((w, h), (1438, 810));
        assert!(f.contains("setpts=(PTS-STARTPTS)/2"));
    }
    #[test]
    #[ignore = "Requires FFmpeg and the local OBS recording; run with --ignored --nocapture"]
    fn real_obs_exports() {
        let input = source("2026-10-12_11-50-01.mkv").unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".work")
            .join(format!("encode-test-{}", std::process::id()));
        let cancel = AtomicBool::new(false);
        for (i, target) in [Some(3_800_000), Some(10_000_000), None]
            .into_iter()
            .enumerate()
        {
            let mut r = request();
            r.filename = format!("test-{i}");
            r.start = 2.;
            r.end = 10.;
            r.speed = 2.;
            r.target = target;
            r.crop = Crop {
                x: 100,
                y: 80,
                width: 1280,
                height: 720,
            };
            let out = export(
                None,
                &cancel,
                r.clone(),
                &input,
                &root.join("exports"),
                &root.join("work"),
            )
            .unwrap();
            assert!(
                (out.duration - 4.).abs() < 0.12,
                "duration was {}",
                out.duration
            );
            assert!(target.is_none_or(|limit| out.bytes <= limit));
            assert_eq!((out.width, out.height), (1280, 720));
            let o = command("ffprobe")
                .args(["-v", "error", "-show_streams", "-of", "json"])
                .arg(&out.path)
                .output()
                .unwrap();
            let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
            let streams = v["streams"].as_array().unwrap();
            assert_eq!(streams.len(), 1);
            assert_eq!(streams[0]["codec_name"], "h264");
            assert_eq!(streams[0]["pix_fmt"], "yuv420p");
            let mp4 = fs::read(&out.path).unwrap();
            assert!(
                mp4.windows(4).position(|w| w == b"moov").unwrap()
                    < mp4.windows(4).position(|w| w == b"mdat").unwrap(),
                "MP4 must have faststart metadata"
            );
            println!(
                "{}: {} bytes, {}x{}, {}s",
                r.filename, out.bytes, out.width, out.height, out.duration
            );
            assert!(export(
                None,
                &cancel,
                r,
                &input,
                &root.join("exports"),
                &root.join("work")
            )
            .unwrap_err()
            .contains("already exists"));
        }
        fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    #[ignore = "Requires FFmpeg and the longer local OBS recording"]
    fn real_obs_capped_fallback() {
        let input = source("2026-10-12_11-49-12.mkv").unwrap();
        let m = probe(&input).unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".work")
            .join(format!("fallback-test-{}", std::process::id()));
        let mut r = request();
        r.end = m.duration;
        r.crop = Crop {
            x: 0,
            y: 0,
            width: m.width,
            height: m.height,
        };
        let out = export(
            None,
            &AtomicBool::new(false),
            r,
            &input,
            &root.join("exports"),
            &root.join("work"),
        )
        .unwrap();
        assert!(out.bytes <= 3_800_000);
        assert!((out.duration - m.duration).abs() < 0.15);
        println!(
            "Fallback: {} bytes, {}x{}, {}s, scale {}",
            out.bytes, out.width, out.height, out.duration, out.scale
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "Requires FFmpeg; exercises live child-process cancellation"]
    fn ffmpeg_cancellation() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".work")
            .join(format!("cancel-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            signal.store(true, Ordering::SeqCst);
        });
        let now = std::time::Instant::now();
        let a = strings(&[
            "-re",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1280x720:rate=30",
            "-t",
            "60",
            "-an",
            "-f",
            "null",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ]);
        assert_eq!(
            run(None, &a, &root, &cancel, "test", 60.).unwrap_err(),
            "Cancelled"
        );
        thread.join().unwrap();
        assert!(now.elapsed() < Duration::from_secs(3));
        fs::remove_dir_all(root).unwrap();
    }
}
