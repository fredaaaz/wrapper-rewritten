import assert from "assert";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
	buildFfmpegArgs,
	ffmpegPath,
	terminateProcessTree,
	validateOutput,
} from "../src/main/server/export/ffmpeg";
import type { AudioClip } from "../src/main/server/export/types";

function run(executable:string, args:string[]):Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args);
		let stderr = "";
		child.stderr.on("data", chunk => stderr += chunk.toString());
		child.once("error", reject);
		child.once("close", code => {
			if (code == 0) resolve();
			else reject(new Error(`${executable} exited ${code}: ${stderr}`));
		});
	});
}

describe("synthetic MP4 integration", function () {
	this.timeout(30_000);

	it("encodes generated PNG frames and audio into a validated MP4", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-export-integration-"));
		const frames = path.join(root, "frames");
		const audioPath = path.join(root, "tone.wav");
		const outputPath = path.join(root, "output.mp4");
		fs.mkdirSync(frames);
		try {
			await run(ffmpegPath, [
				"-hide_banner", "-loglevel", "error", "-y",
				"-f", "lavfi",
				"-i", "testsrc=size=160x90:rate=24:duration=0.5",
				"-frames:v", "12",
				path.join(frames, "frame-%09d.png"),
			]);
			await run(ffmpegPath, [
				"-hide_banner", "-loglevel", "error", "-y",
				"-f", "lavfi",
				"-i", "sine=frequency=440:sample_rate=48000:duration=0.5",
				"-c:a", "pcm_s16le",
				audioPath,
			]);
			const audio:AudioClip = {
				filepath: audioPath,
				assetId: "synthetic-tone",
				startSeconds: 0,
				durationSeconds: 0.5,
				trimStartSeconds: 0,
				trimEndSeconds: 0.5,
				fadeInSeconds: 0.02,
				fadeOutSeconds: 0.02,
				fadeInVolume: 1,
				fadeOutVolume: 0,
				volume: 1,
			};
			await run(ffmpegPath, buildFfmpegArgs({
				framePattern: path.join(frames, "frame-%09d.png"),
				captureFrameRate: 24,
				settings: { width:320, height:180, frameRate:24 },
				audio: [audio],
				durationSeconds: 0.5,
				outputPath,
			}));
			const probe = await validateOutput(outputPath, 0.5, true);
			assert(probe.streams.some(stream => stream.codec_type == "video"));
			assert(probe.streams.some(stream => stream.codec_type == "audio"));
		} finally {
			fs.rmSync(root, { recursive:true, force:true });
		}
	});

	it("terminates an active FFmpeg process tree during cancellation", async () => {
		const child = spawn(ffmpegPath, [
			"-hide_banner", "-loglevel", "error",
			"-re",
			"-f", "lavfi",
			"-i", "testsrc=size=64x64:rate=24:duration=30",
			"-f", "null",
			"-",
		]);
		const pid = child.pid as number;
		await new Promise(resolve => setTimeout(resolve, 150));
		await terminateProcessTree(child);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.notEqual(child.exitCode, null);
		assert.throws(() => process.kill(pid, 0));
	});
});
