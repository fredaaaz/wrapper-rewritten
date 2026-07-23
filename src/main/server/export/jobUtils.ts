import { randomBytes } from "crypto";
import fs from "fs";
import type { ExportJobStatus, InternalExportJob } from "./types";

const VALID_TRANSITIONS:Record<ExportJobStatus, ExportJobStatus[]> = {
	queued: ["rendering", "cancelled", "failed"],
	rendering: ["encoding", "cancelled", "failed"],
	encoding: ["completed", "cancelled", "failed"],
	completed: [],
	cancelled: [],
	failed: [],
};

export class ExportStateMachine {
	static transition(job:InternalExportJob, next:ExportJobStatus) {
		if (!VALID_TRANSITIONS[job.status].includes(next)) {
			throw new Error(`Invalid export state transition: ${job.status} -> ${next}.`);
		}
		job.status = next;
	}
}

export function missingFrameIndexes(indexes:Set<number>, totalFrames:number): number[] {
	const missing:number[] = [];
	for (let index = 0; index < totalFrames; index++) {
		if (!indexes.has(index)) {
			missing.push(index);
			if (missing.length >= 25) {
				break;
			}
		}
	}
	return missing;
}

export function createJobId(): string {
	return randomBytes(16).toString("hex");
}

export function cleanupExportFiles(
	tempPath:string,
	outputPath?:string,
	removeOutput = false
) {
	removePath(tempPath);
	if (removeOutput && outputPath) {
		removePath(outputPath);
	}
}

export function removePath(filepath:string) {
	if (!fs.existsSync(filepath)) {
		return;
	}
	if (fs.lstatSync(filepath).isDirectory()) {
		if (typeof (fs as any).rmSync == "function") {
			(fs as any).rmSync(filepath, { recursive:true, force:true });
		} else {
			fs.rmdirSync(filepath, { recursive:true });
		}
	} else {
		fs.unlinkSync(filepath);
	}
}
