import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStaticPath from "@derhuerst/ffprobe-static";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";
import type { AudioClip, ExportSettings } from "./types";

export const VIDEO_PRESET = "medium";
export const VIDEO_CRF = "18";
export const AUDIO_BITRATE = "192k";
export const AUDIO_SAMPLE_RATE = "48000";

export interface ProbeStream {
	codec_type?: "video" | "audio" | string;
	duration?: string;
	width?: number;
	height?: number;
}

export interface ProbeResult {
	streams: ProbeStream[];
	format?: {
		duration?: string;
		size?: string;
	};
}

export interface FfmpegBuildInput {
	framePattern:string;
	captureFrameRate:number;
	settings:ExportSettings;
	audio:AudioClip[];
	durationSeconds:number;
	outputPath:string;
}

function executablePath(modulePath:string, fallback:string, envName:string): string {
	const unpacked = modulePath.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
	if (fs.existsSync(unpacked)) {
		return unpacked;
	}
	if (fs.existsSync(modulePath)) {
		return modulePath;
	}
	return process.env[envName] || fallback;
}

export const ffmpegPath = executablePath(ffmpegStaticPath, "ffmpeg", "FFMPEG_PATH");
export const ffprobePath = executablePath(ffprobeStaticPath, "ffprobe", "FFPROBE_PATH");

function formatSeconds(value:number): string {
	return Math.max(0, value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function buildFfmpegArgs(input:FfmpegBuildInput): string[] {
	const { settings, audio, durationSeconds } = input;
	const args = [
		"-hide_banner",
		"-loglevel", "warning",
		"-y",
		"-framerate", String(input.captureFrameRate),
		"-start_number", "0",
		"-i", input.framePattern,
	];
	for (const clip of audio) {
		args.push("-i", clip.filepath);
	}

	const videoFilter = [
		`scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease`,
		`pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
		"setsar=1",
		`fps=${settings.frameRate}`,
	].join(",");

	if (audio.length == 0) {
		args.push(
			"-vf", videoFilter,
			"-map", "0:v:0",
			"-an",
		);
	} else {
		const filters:string[] = [`[0:v]${videoFilter}[vout]`];
		const mixInputs:string[] = [];
		audio.forEach((clip, index) => {
			const inputIndex = index + 1;
			const outputLabel = `audio${index}`;
			const trim = clip.trimEndSeconds > clip.trimStartSeconds
				? `atrim=start=${formatSeconds(clip.trimStartSeconds)}:end=${formatSeconds(clip.trimEndSeconds)}`
				: `atrim=start=${formatSeconds(clip.trimStartSeconds)}:duration=${formatSeconds(clip.durationSeconds)}`;
			const clipFilters = [
				"aresample=" + AUDIO_SAMPLE_RATE,
				"aformat=sample_fmts=fltp:channel_layouts=stereo",
				trim,
				"asetpts=PTS-STARTPTS",
				`atrim=duration=${formatSeconds(clip.durationSeconds)}`,
			];
			const fadeInDuration = Math.min(clip.fadeInSeconds, clip.durationSeconds);
			if (fadeInDuration > 0) {
				clipFilters.push(`afade=t=in:st=0:d=${formatSeconds(fadeInDuration)}`);
			}
			const fadeOutDuration = Math.min(clip.fadeOutSeconds, clip.durationSeconds);
			if (fadeOutDuration > 0) {
				const fadeStart = Math.max(0, clip.durationSeconds - fadeOutDuration);
				clipFilters.push(
					`afade=t=out:st=${formatSeconds(fadeStart)}:d=${formatSeconds(fadeOutDuration)}`
				);
			}
			if (clip.volume != 1) {
				clipFilters.push(`volume=${clip.volume.toFixed(4)}`);
			}
			const delayMs = Math.max(0, Math.round(clip.startSeconds * 1000));
			clipFilters.push(`adelay=${delayMs}|${delayMs}`);
			filters.push(`[${inputIndex}:a]${clipFilters.join(",")}[${outputLabel}]`);
			mixInputs.push(`[${outputLabel}]`);
		});
		filters.push(
			`${mixInputs.join("")}amix=inputs=${audio.length}:duration=longest:dropout_transition=0:normalize=0,` +
			`atrim=duration=${formatSeconds(durationSeconds)}[aout]`
		);
		args.push(
			"-filter_complex", filters.join(";"),
			"-map", "[vout]",
			"-map", "[aout]",
		);
	}

	args.push(
		"-t", formatSeconds(durationSeconds),
		"-c:v", "libx264",
		"-preset", VIDEO_PRESET,
		"-crf", VIDEO_CRF,
		"-pix_fmt", "yuv420p",
		"-movflags", "+faststart",
	);
	if (audio.length > 0) {
		args.push(
			"-c:a", "aac",
			"-b:a", AUDIO_BITRATE,
			"-ar", AUDIO_SAMPLE_RATE,
			"-ac", "2",
		);
	}
	args.push(
		"-progress", "pipe:1",
		"-nostats",
		input.outputPath,
	);
	return args;
}

export function runFfprobe(filepath:string): Promise<ProbeResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(ffprobePath, [
			"-v", "error",
			"-print_format", "json",
			"-show_streams",
			"-show_format",
			filepath,
		]);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => stdout += chunk.toString());
		child.stderr.on("data", chunk => stderr += chunk.toString());
		child.on("error", reject);
		child.on("close", code => {
			if (code != 0) {
				return reject(new Error(`FFprobe failed for "${filepath}": ${stderr.trim() || `exit ${code}`}`));
			}
			try {
				resolve(JSON.parse(stdout));
			} catch (error) {
				reject(new Error(`FFprobe returned invalid JSON for "${filepath}": ${error}`));
			}
		});
	});
}

export async function validateAudioFiles(clips:AudioClip[]): Promise<void> {
	for (const clip of clips) {
		if (!fs.existsSync(clip.filepath)) {
			throw new Error(`Missing audio asset "${clip.assetId}".`);
		}
		const stat = fs.statSync(clip.filepath);
		if (!stat.isFile() || stat.size == 0) {
			throw new Error(`Audio asset "${clip.assetId}" is empty or unreadable.`);
		}
		const probe = await runFfprobe(clip.filepath);
		if (!probe.streams.some(stream => stream.codec_type == "audio")) {
			throw new Error(`Audio asset "${clip.assetId}" contains no decodable audio stream.`);
		}
	}
}

export async function validateOutput(
	filepath:string,
	expectedDuration:number,
	expectAudio:boolean
): Promise<ProbeResult> {
	if (!fs.existsSync(filepath) || fs.statSync(filepath).size == 0) {
		throw new Error("FFmpeg did not create a non-empty MP4.");
	}
	const probe = await runFfprobe(filepath);
	if (!probe.streams.some(stream => stream.codec_type == "video")) {
		throw new Error("The exported MP4 does not contain a video stream.");
	}
	if (expectAudio && !probe.streams.some(stream => stream.codec_type == "audio")) {
		throw new Error("The exported MP4 is missing its expected audio stream.");
	}
	const duration = Number(probe.format?.duration);
	const tolerance = Math.max(0.5, expectedDuration * 0.02);
	if (!Number.isFinite(duration) || Math.abs(duration - expectedDuration) > tolerance) {
		throw new Error(
			`The exported duration (${duration || "unknown"}s) differs from the expected ` +
			`${expectedDuration.toFixed(3)}s.`
		);
	}
	return probe;
}

export async function terminateProcessTree(child:ChildProcess): Promise<void> {
	if (child.exitCode != null || !child.pid) {
		return;
	}
	if (process.platform == "win32") {
		await new Promise<void>(resolve => {
			const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				windowsHide:true,
			});
			killer.once("error", () => {
				child.kill("SIGKILL");
				resolve();
			});
			killer.once("close", () => resolve());
		});
		return;
	}
	child.kill("SIGTERM");
	await new Promise<void>(resolve => {
		const timeout = setTimeout(() => {
			if (child.exitCode == null) {
				child.kill("SIGKILL");
			}
			resolve();
		}, 2_000);
		child.once("close", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}
