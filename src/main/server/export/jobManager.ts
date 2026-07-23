import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import directories from "../../storage/directories";
import MovieModel from "../models/movie";
import { XmlDocument } from "xmldoc";
import { extractAudioClips, MOVIE_CAPTURE_FRAME_RATE } from "./audio";
import {
	buildFfmpegArgs,
	ffmpegPath,
	terminateProcessTree,
	validateAudioFiles,
	validateOutput,
} from "./ffmpeg";
import type {
	ExportJobStatus,
	ExportSettings,
	InternalExportJob,
	PublicExportJob,
} from "./types";
import {
	assertPathInside,
	decodePngBase64,
	requireExistingMovie,
	safeFilename,
	validateFrameIndex,
} from "./validation";
import {
	cleanupExportFiles,
	createJobId,
	ExportStateMachine,
	missingFrameIndexes,
	removePath,
} from "./jobUtils";

const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;
const RENDER_HEARTBEAT_TIMEOUT_MS = 30 * 1000;
const MAX_LOG_LENGTH = 64 * 1024;

function errorMessage(error:unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function readMovieXml(movieId:string): Buffer {
	const filepath = path.join(MovieModel.folder, movieId + ".xml");
	requireExistingMovie(movieId, id => MovieModel.exists(id) && fs.existsSync(filepath));
	if (!fs.existsSync(filepath)) {
		throw new RangeError("Movie not found.");
	}
	return fs.readFileSync(filepath);
}

export class ExportJobManager {
	private jobs = new Map<string, InternalExportJob>();
	private queue:string[] = [];
	private activeJobId?:string;
	private readonly rootPath:string;
	private readonly tempRoot:string;
	private readonly outputRoot:string;
	private staleTimer:NodeJS.Timeout;

	constructor(rootPath = directories.export) {
		this.rootPath = rootPath;
		this.tempRoot = assertPathInside(rootPath, path.join(rootPath, "temp"));
		this.outputRoot = assertPathInside(rootPath, path.join(rootPath, "output"));
		fs.mkdirSync(this.tempRoot, { recursive:true });
		fs.mkdirSync(this.outputRoot, { recursive:true });
		this.removeStaleTempDirectories();
		this.staleTimer = setInterval(() => this.cancelAbandonedRender(), 10_000);
		this.staleTimer.unref();
	}

	async create(movieId:string, settings:ExportSettings): Promise<PublicExportJob> {
		const xml = readMovieXml(movieId);
		const metadata = await MovieModel.extractMeta(movieId);
		const film = new XmlDocument(xml.toString());
		const audio = extractAudioClips(xml);
		await validateAudioFiles(audio);

		let id:string;
		do {
			id = createJobId();
		} while (this.jobs.has(id));
		const safeTitle = safeFilename(metadata.title);
		const tempPath = assertPathInside(this.tempRoot, path.join(this.tempRoot, id));
		const framePath = assertPathInside(tempPath, path.join(tempPath, "frames"));
		const outputPath = assertPathInside(
			this.outputRoot,
			path.join(this.outputRoot, `${safeTitle}-${id}.mp4`)
		);
		fs.mkdirSync(framePath, { recursive:true });

		const status:ExportJobStatus = this.activeJobId ? "queued" : "rendering";
		const now = Date.now();
		const job:InternalExportJob = {
			id,
			movieId,
			status,
			totalFrames: Math.max(1, Math.round(metadata.duration * MOVIE_CAPTURE_FRAME_RATE)),
			renderedFrames: 0,
			progress: 0,
			outputPath,
			createdAt: now,
			title: metadata.title,
			safeTitle,
			settings,
			captureFrameRate: MOVIE_CAPTURE_FRAME_RATE,
			isWide: film.attr.isWide != "0",
			durationSeconds: metadata.duration,
			tempPath,
			framePath,
			frameIndexes: new Set(),
			audio,
			containsAudio: audio.length > 0,
			lastHeartbeat: now,
			cancelRequested: false,
			ffmpegLog: "",
		};
		if (status == "rendering") {
			this.activeJobId = id;
			job.startedAt = now;
		} else {
			this.queue.push(id);
		}
		this.jobs.set(id, job);
		return this.toPublic(job);
	}

	get(jobId:string): PublicExportJob {
		return this.toPublic(this.requireJob(jobId));
	}

	heartbeat(jobId:string): PublicExportJob {
		const job = this.requireJob(jobId);
		if (job.status == "queued" || job.status == "rendering") {
			job.lastHeartbeat = Date.now();
		}
		return this.toPublic(job);
	}

	addFrame(jobId:string, indexValue:unknown, base64Value:unknown): PublicExportJob {
		const job = this.requireJob(jobId);
		if (job.status == "cancelled" || job.cancelRequested) {
			throw new ExportRequestError(409, "Export was cancelled.");
		}
		if (job.status != "rendering" || this.activeJobId != job.id) {
			throw new ExportRequestError(409, "Export is not accepting frames.");
		}
		const index = validateFrameIndex(indexValue);
		if (job.frameIndexes.has(index)) {
			throw new ExportRequestError(409, `Frame ${index} has already been uploaded.`);
		}
		const frame = decodePngBase64(base64Value);
		const filepath = assertPathInside(
			job.framePath,
			path.join(job.framePath, `frame-${String(index).padStart(9, "0")}.png`)
		);
		job.frameIndexes.add(index);
		try {
			fs.writeFileSync(filepath, frame, { flag:"wx" });
		} catch (error) {
			job.frameIndexes.delete(index);
			throw error;
		}
		job.renderedFrames = job.frameIndexes.size;
		job.progress = Math.min(74, job.renderedFrames / Math.max(1, job.totalFrames) * 75);
		job.lastHeartbeat = Date.now();
		return this.toPublic(job);
	}

	finish(jobId:string, rawTotalFrames:unknown, sceneStartsValue:unknown): PublicExportJob {
		const job = this.requireJob(jobId);
		if (job.status == "cancelled" || job.cancelRequested) {
			throw new ExportRequestError(409, "Export was cancelled.");
		}
		if (job.status != "rendering" || this.activeJobId != job.id) {
			throw new ExportRequestError(409, "Export is not rendering.");
		}
		const totalFrames = validateFrameIndex(rawTotalFrames);
		if (totalFrames < 1) {
			throw new ExportRequestError(400, "An export must contain at least one frame.");
		}
		const missing = missingFrameIndexes(job.frameIndexes, totalFrames);
		if (missing.length > 0) {
			throw new ExportRequestError(
				409,
				`Missing frame indexes: ${missing.join(", ")}${missing.length == 25 ? ", ..." : ""}.`
			);
		}
		const sceneStarts = this.parseSceneStarts(sceneStartsValue, totalFrames);
		this.compactFrames(job, totalFrames, sceneStarts);
		ExportStateMachine.transition(job, "encoding");
		job.renderedFrames = job.totalFrames;
		job.progress = 75;
		job.encodingStartedAt = Date.now();
		void this.encode(job);
		return this.toPublic(job);
	}

	async cancel(jobId:string): Promise<PublicExportJob> {
		const job = this.requireJob(jobId);
		if (["completed", "failed", "cancelled"].includes(job.status)) {
			return this.toPublic(job);
		}
		job.cancelRequested = true;
		ExportStateMachine.transition(job, "cancelled");
		this.queue = this.queue.filter(id => id != job.id);
		await this.terminate(job);
		this.cleanupJobFiles(job, true);
		this.releaseAndPromote(job);
		return this.toPublic(job);
	}

	getCompletedOutput(jobId:string): { filepath:string, filename:string } {
		const job = this.requireJob(jobId);
		if (job.status != "completed" || !job.outputPath || !fs.existsSync(job.outputPath)) {
			throw new ExportRequestError(409, "Export output is not available.");
		}
		return {
			filepath: job.outputPath,
			filename: job.safeTitle + ".mp4",
		};
	}

	shutdownSync() {
		clearInterval(this.staleTimer);
		for (const job of this.jobs.values()) {
			if (job.process && job.process.exitCode == null) {
				if (process.platform == "win32" && job.process.pid) {
					spawnSync("taskkill", ["/pid", String(job.process.pid), "/T", "/F"], {
						windowsHide:true,
						stdio:"ignore",
					});
				} else {
					job.process.kill("SIGKILL");
				}
			}
			if (!["completed", "failed", "cancelled"].includes(job.status)) {
				this.cleanupJobFiles(job, true);
			}
		}
	}

	private async encode(job:InternalExportJob) {
		try {
			if (job.cancelRequested) {
				return;
			}
			const durationSeconds = job.totalFrames / job.captureFrameRate;
			const args = buildFfmpegArgs({
				framePattern: path.join(job.tempPath, "render", "frame-%09d.png"),
				captureFrameRate: job.captureFrameRate,
				settings: job.settings,
				audio: job.audio,
				durationSeconds,
				outputPath: job.outputPath as string,
			});
			const child = spawn(ffmpegPath, args, {
				windowsHide:true,
			});
			job.process = child;
			let progressBuffer = "";
			let progressValues:Record<string, string> = {};
			child.stdout.on("data", chunk => {
				progressBuffer += chunk.toString();
				const lines = progressBuffer.split(/\r?\n/);
				progressBuffer = lines.pop() || "";
				for (const line of lines) {
					const split = line.indexOf("=");
					if (split < 1) continue;
					const key = line.slice(0, split);
					progressValues[key] = line.slice(split + 1);
					if (key != "progress") continue;
					const outputMicros = Number(progressValues.out_time_us);
					if (Number.isFinite(outputMicros)) {
						const ratio = Math.max(
							0,
							Math.min(1, outputMicros / 1_000_000 / durationSeconds)
						);
						job.progress = 75 + ratio * 24;
					}
					progressValues = {};
				}
			});
			child.stderr.on("data", chunk => {
				job.ffmpegLog = (job.ffmpegLog + chunk.toString()).slice(-MAX_LOG_LENGTH);
			});
			const exitCode = await new Promise<number>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", code => resolve(code ?? -1));
			});
			job.process = undefined;
			if (job.cancelRequested || job.status == "cancelled") {
				return;
			}
			if (exitCode != 0) {
				throw new Error(
					`FFmpeg exited with code ${exitCode}. ${job.ffmpegLog.trim()}`.trim()
				);
			}
			await validateOutput(job.outputPath as string, durationSeconds, job.containsAudio);
			ExportStateMachine.transition(job, "completed");
			job.progress = 100;
			this.cleanupJobFiles(job, false);
		} catch (error) {
			if (!job.cancelRequested && job.status != "cancelled") {
				this.fail(job, error);
			}
		} finally {
			this.releaseAndPromote(job);
		}
	}

	private compactFrames(job:InternalExportJob, totalFrames:number, sceneStarts:number[]) {
		const duplicateIndexes = new Set(sceneStarts.slice(1));
		const renderPath = assertPathInside(job.tempPath, path.join(job.tempPath, "render"));
		fs.mkdirSync(renderPath, { recursive:true });
		let outputIndex = 0;
		for (let inputIndex = 0; inputIndex < totalFrames; inputIndex++) {
			if (duplicateIndexes.has(inputIndex)) {
				continue;
			}
			const source = assertPathInside(
				job.framePath,
				path.join(job.framePath, `frame-${String(inputIndex).padStart(9, "0")}.png`)
			);
			const destination = assertPathInside(
				renderPath,
				path.join(renderPath, `frame-${String(outputIndex).padStart(9, "0")}.png`)
			);
			fs.renameSync(source, destination);
			outputIndex++;
		}
		if (outputIndex < 1) {
			throw new ExportRequestError(409, "No legitimate frames remained after scene processing.");
		}
		job.totalFrames = outputIndex;
	}

	private parseSceneStarts(value:unknown, totalFrames:number): number[] {
		if (typeof value != "string" || value == "") {
			return [];
		}
		let parsed:unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new ExportRequestError(400, "sceneStarts must be valid JSON.");
		}
		if (!Array.isArray(parsed) || parsed.length > 100_000) {
			throw new ExportRequestError(400, "sceneStarts must be an array.");
		}
		const unique = new Set<number>();
		for (const value of parsed) {
			const index = validateFrameIndex(value);
			if (index >= totalFrames) {
				throw new ExportRequestError(400, `Scene frame ${index} is outside the uploaded range.`);
			}
			unique.add(index);
		}
		return [...unique].sort((a, b) => a - b);
	}

	private fail(job:InternalExportJob, error:unknown) {
		if (!["failed", "cancelled", "completed"].includes(job.status)) {
			ExportStateMachine.transition(job, "failed");
		}
		job.error = errorMessage(error).slice(0, 4000);
		this.cleanupJobFiles(job, true);
	}

	private releaseAndPromote(job:InternalExportJob) {
		if (this.activeJobId == job.id) {
			this.activeJobId = undefined;
		}
		if (this.activeJobId) {
			return;
		}
		while (this.queue.length > 0) {
			const nextId = this.queue.shift() as string;
			const next = this.jobs.get(nextId);
			if (!next || next.status != "queued") {
				continue;
			}
			ExportStateMachine.transition(next, "rendering");
			next.startedAt = Date.now();
			next.lastHeartbeat = Date.now();
			this.activeJobId = next.id;
			break;
		}
	}

	private async terminate(job:InternalExportJob) {
		const child = job.process;
		if (!child) {
			return;
		}
		await terminateProcessTree(child);
		job.process = undefined;
	}

	private cleanupJobFiles(job:InternalExportJob, removeOutput:boolean) {
		try {
			cleanupExportFiles(job.tempPath, job.outputPath, removeOutput);
		} catch (error) {
			console.error(`Failed to clean export temp directory ${job.id}:`, error);
		}
	}

	private removeStaleTempDirectories() {
		const cutoff = Date.now() - STALE_TEMP_AGE_MS;
		for (const entry of fs.readdirSync(this.tempRoot, { withFileTypes:true })) {
			if (!entry.isDirectory()) {
				continue;
			}
			const filepath = assertPathInside(this.tempRoot, path.join(this.tempRoot, entry.name));
			try {
				if (fs.statSync(filepath).mtimeMs < cutoff) {
					removePath(filepath);
				}
			} catch (error) {
				console.error(`Failed to inspect stale export directory "${entry.name}":`, error);
			}
		}
	}

	private cancelAbandonedRender() {
		if (!this.activeJobId) {
			return;
		}
		const job = this.jobs.get(this.activeJobId);
		if (
			job &&
			job.status == "rendering" &&
			Date.now() - job.lastHeartbeat > RENDER_HEARTBEAT_TIMEOUT_MS
		) {
			void this.cancel(job.id);
		}
	}

	private requireJob(jobId:string): InternalExportJob {
		const job = this.jobs.get(jobId);
		if (!job) {
			throw new ExportRequestError(404, "Export job not found.");
		}
		return job;
	}

	private toPublic(job:InternalExportJob): PublicExportJob {
		let etaSeconds:number | undefined;
		const now = Date.now();
		if (job.status == "rendering" && job.startedAt && job.renderedFrames > 0) {
			const framesPerSecond = job.renderedFrames / ((now - job.startedAt) / 1000);
			if (framesPerSecond > 0) {
				etaSeconds = Math.max(0, (job.totalFrames - job.renderedFrames) / framesPerSecond);
			}
		} else if (job.status == "encoding" && job.encodingStartedAt && job.progress > 75) {
			const ratio = (job.progress - 75) / 25;
			etaSeconds = Math.max(0, (now - job.encodingStartedAt) / 1000 * (1 - ratio) / ratio);
		}
		const stage = {
			queued: "Waiting in export queue",
			rendering: "Rendering movie frames",
			encoding: "Encoding and validating MP4",
			completed: "Export completed",
			cancelled: "Export cancelled",
			failed: "Export failed",
		}[job.status];
		return {
			id: job.id,
			movieId: job.movieId,
			status: job.status,
			totalFrames: job.totalFrames,
			renderedFrames: job.renderedFrames,
			progress: Number(job.progress.toFixed(2)),
			error: job.error,
			createdAt: job.createdAt,
			title: job.title,
			settings: job.settings,
			captureFrameRate: job.captureFrameRate,
			isWide: job.isWide,
			stage,
			etaSeconds: Number.isFinite(etaSeconds) ? Math.round(etaSeconds as number) : undefined,
			downloadUrl: job.status == "completed" ? `/api/export/${job.id}/download` : undefined,
			hasOutput: job.status == "completed",
		};
	}
}

export class ExportRequestError extends Error {
	constructor(public statusCode:number, message:string) {
		super(message);
	}
}

export default new ExportJobManager();
