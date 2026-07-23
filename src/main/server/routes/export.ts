import httpz from "@octanuary/httpz";
import fs from "fs";
import exportJobs, { ExportRequestError } from "../export/jobManager";
import type { ExportSettings } from "../export/types";
import {
	isValidJobId,
	isValidMovieId,
	scalarField,
} from "../export/validation";

const group = new httpz.Group();
const ALLOWED_RESOLUTIONS = new Set(["640x360", "854x480", "1280x720", "1920x1080"]);
const ALLOWED_FRAME_RATES = new Set([24, 30]);

function jsonError(res:any, status:number, code:string, message:string) {
	res.status(status).json({
		status: "error",
		error: { code, message },
	});
}

function routeError(res:any, error:unknown) {
	if (error instanceof ExportRequestError) {
		return jsonError(res, error.statusCode, "EXPORT_ERROR", error.message);
	}
	if (error instanceof RangeError && error.message == "Movie not found.") {
		return jsonError(res, 404, "MOVIE_NOT_FOUND", error.message);
	}
	console.error("Export route failed:", error);
	return jsonError(
		res,
		500,
		"INTERNAL_ERROR",
		error instanceof Error ? error.message : "Internal export error."
	);
}

group.route("POST", "/api/export/start", async (req, res) => {
	const movieId = scalarField(req.body.movieId);
	const resolution = scalarField(req.body.resolution);
	const frameRate = Number(scalarField(req.body.frameRate));
	if (!isValidMovieId(movieId)) {
		return jsonError(res, 400, "INVALID_MOVIE_ID", "Movie ID is invalid.");
	}
	if (typeof resolution != "string" || !ALLOWED_RESOLUTIONS.has(resolution)) {
		return jsonError(res, 400, "INVALID_RESOLUTION", "Export resolution is invalid.");
	}
	if (!ALLOWED_FRAME_RATES.has(frameRate)) {
		return jsonError(res, 400, "INVALID_FRAME_RATE", "Export frame rate is invalid.");
	}
	const [width, height] = resolution.split("x").map(Number);
	try {
		const settings:ExportSettings = {
			width,
			height,
			frameRate: frameRate as 24 | 30,
		};
		const job = await exportJobs.create(movieId, settings);
		res.status(201).json({ status:"ok", job });
	} catch (error) {
		routeError(res, error);
	}
});

group.route("POST", /^\/api\/export\/([a-f0-9]{32})\/frame$/, (req, res) => {
	const jobId = req.matches[1];
	if (!isValidJobId(jobId)) {
		return jsonError(res, 400, "INVALID_JOB_ID", "Export job ID is invalid.");
	}
	try {
		const job = exportJobs.addFrame(
			jobId,
			scalarField(req.body.index),
			scalarField(req.body.frame)
		);
		res.json({ status:"ok", job });
	} catch (error) {
		routeError(res, error);
	}
});

group.route("POST", /^\/api\/export\/([a-f0-9]{32})\/finish$/, (req, res) => {
	const jobId = req.matches[1];
	try {
		const job = exportJobs.finish(
			jobId,
			scalarField(req.body.totalFrames),
			scalarField(req.body.sceneStarts)
		);
		res.status(202).json({ status:"ok", job });
	} catch (error) {
		routeError(res, error);
	}
});

group.route("POST", /^\/api\/export\/([a-f0-9]{32})\/heartbeat$/, (req, res) => {
	try {
		res.json({ status:"ok", job:exportJobs.heartbeat(req.matches[1]) });
	} catch (error) {
		routeError(res, error);
	}
});

group.route("GET", /^\/api\/export\/([a-f0-9]{32})\/status$/, (req, res) => {
	try {
		res.setHeader("Cache-Control", "no-store");
		res.json({ status:"ok", job:exportJobs.get(req.matches[1]) });
	} catch (error) {
		routeError(res, error);
	}
});

group.route("POST", /^\/api\/export\/([a-f0-9]{32})\/cancel$/, async (req, res) => {
	try {
		const job = await exportJobs.cancel(req.matches[1]);
		res.json({ status:"ok", job });
	} catch (error) {
		routeError(res, error);
	}
});

group.route("GET", /^\/api\/export\/([a-f0-9]{32})\/download$/, (req, res) => {
	try {
		const output = exportJobs.getCompletedOutput(req.matches[1]);
		res.setHeader("Content-Type", "video/mp4");
		res.setHeader(
			"Content-Disposition",
			`attachment; filename*=UTF-8''${encodeURIComponent(output.filename)}`
		);
		res.setHeader("Content-Length", String(fs.statSync(output.filepath).size));
		fs.createReadStream(output.filepath)
			.on("error", error => {
				console.error("Failed to stream exported MP4:", error);
				res.destroy(error);
			})
			.pipe(res);
	} catch (error) {
		routeError(res, error);
	}
});

export default group;
