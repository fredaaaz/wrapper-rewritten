import assert from "assert";
import { buildFfmpegArgs } from "../src/main/server/export/ffmpeg";
import type { AudioClip } from "../src/main/server/export/types";

const settings = { width:1280, height:720, frameRate:24 as const };

function clip(index:number):AudioClip {
	return {
		filepath: `/audio/clip-${index}.mp3`,
		assetId: `ugc.clip-${index}.mp3`,
		startSeconds: index,
		durationSeconds: 2,
		trimStartSeconds: 0.25,
		trimEndSeconds: 2.25,
		fadeInSeconds: 0.2,
		fadeOutSeconds: 0.3,
		fadeInVolume: 1,
		fadeOutVolume: 0,
		volume: 0.8,
	};
}

describe("FFmpeg argument generation", () => {
	it("builds a video-only graph without amix=inputs=0", () => {
		const args = buildFfmpegArgs({
			framePattern: "/frames/frame-%09d.png",
			captureFrameRate: 24,
			settings,
			audio: [],
			durationSeconds: 1,
			outputPath: "/output/movie.mp4",
		});
		assert(args.includes("-an"));
		assert(!args.join(" ").includes("amix"));
		assert(args.includes("libx264"));
		assert(args.includes("yuv420p"));
	});

	it("builds a stereo overlapping multi-audio graph", () => {
		const args = buildFfmpegArgs({
			framePattern: "/frames/frame-%09d.png",
			captureFrameRate: 24,
			settings,
			audio: [clip(0), clip(1)],
			durationSeconds: 4,
			outputPath: "/output/movie.mp4",
		});
		const graph = args[args.indexOf("-filter_complex") + 1];
		assert.match(graph, /amix=inputs=2/);
		assert.match(graph, /atrim=start=0\.25:end=2\.25/);
		assert.match(graph, /adelay=1000\|1000/);
		assert.match(graph, /afade=t=in/);
		assert.match(graph, /afade=t=out/);
		assert.deepEqual(args.slice(args.indexOf("-ac"), args.indexOf("-ac") + 2), ["-ac", "2"]);
		assert.deepEqual(args.slice(args.indexOf("-b:a"), args.indexOf("-b:a") + 2), ["-b:a", "192k"]);
	});
});
