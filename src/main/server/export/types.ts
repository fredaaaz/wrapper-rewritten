import type { ChildProcessWithoutNullStreams } from "child_process";

export type ExportJobStatus =
	| "queued"
	| "rendering"
	| "encoding"
	| "completed"
	| "cancelled"
	| "failed";

export interface ExportJob {
	id: string;
	movieId: string;
	status: ExportJobStatus;
	totalFrames: number;
	renderedFrames: number;
	progress: number;
	outputPath?: string;
	error?: string;
	createdAt: number;
}

export interface ExportSettings {
	width: number;
	height: number;
	frameRate: 24 | 30;
}

export interface AudioClip {
	filepath: string;
	assetId: string;
	startSeconds: number;
	durationSeconds: number;
	trimStartSeconds: number;
	trimEndSeconds: number;
	fadeInSeconds: number;
	fadeOutSeconds: number;
	fadeInVolume: number;
	fadeOutVolume: number;
	volume: number;
}

export interface PublicExportJob extends Omit<ExportJob, "outputPath"> {
	title: string;
	settings: ExportSettings;
	captureFrameRate: number;
	isWide: boolean;
	stage: string;
	etaSeconds?: number;
	downloadUrl?: string;
	hasOutput: boolean;
}

export interface InternalExportJob extends ExportJob {
	title: string;
	safeTitle: string;
	settings: ExportSettings;
	captureFrameRate: number;
	isWide: boolean;
	durationSeconds: number;
	tempPath: string;
	framePath: string;
	frameIndexes: Set<number>;
	audio: AudioClip[];
	containsAudio: boolean;
	lastHeartbeat: number;
	startedAt?: number;
	encodingStartedAt?: number;
	cancelRequested: boolean;
	process?: ChildProcessWithoutNullStreams;
	ffmpegLog: string;
}
