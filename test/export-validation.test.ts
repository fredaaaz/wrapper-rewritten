import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
	assertPathInside,
	decodePngBase64,
	requireExistingMovie,
	safeFilename,
	validateFrameIndex,
} from "../src/main/server/export/validation";
import {
	cleanupExportFiles,
	createJobId,
	ExportStateMachine,
	missingFrameIndexes,
} from "../src/main/server/export/jobUtils";

describe("export validation", () => {
	it("creates filesystem-safe cross-platform filenames", () => {
		assert.equal(safeFilename("../../movie?.mp4"), "_movie_.mp4");
		assert.equal(safeFilename("CON"), "_CON");
		assert.equal(safeFilename("  My   Movie.  "), "My Movie");
		assert.equal(safeFilename(""), "Untitled");
	});

	it("isolates jobs with random fixed-width IDs", () => {
		const ids = new Set(Array.from({ length:500 }, () => createJobId()));
		assert.equal(ids.size, 500);
		for (const id of ids) {
			assert.match(id, /^[a-f0-9]{32}$/);
		}
	});

	it("enforces job state transitions", () => {
		const job = { status:"queued" } as any;
		ExportStateMachine.transition(job, "rendering");
		ExportStateMachine.transition(job, "encoding");
		ExportStateMachine.transition(job, "completed");
		assert.throws(() => ExportStateMachine.transition(job, "rendering"), /Invalid export state/);
	});

	it("validates frame indexes", () => {
		assert.equal(validateFrameIndex("42"), 42);
		for (const value of [-1, 1.5, "NaN", "../1"]) {
			assert.throws(() => validateFrameIndex(value), RangeError);
		}
	});

	it("rejects malformed and non-PNG base64", () => {
		assert.throws(() => decodePngBase64("not-base64"), /valid base64/);
		assert.throws(() => decodePngBase64(Buffer.from("hello").toString("base64")), /PNG/);
	});

	it("reports missing frame indexes", () => {
		assert.deepEqual(missingFrameIndexes(new Set([0, 2, 4]), 5), [1, 3]);
	});

	it("reports a missing movie without trusting the ID", () => {
		assert.throws(
			() => requireExistingMovie("not_real", () => false),
			/Movie not found/
		);
		assert.throws(
			() => requireExistingMovie("../../movie", () => true),
			/Movie not found/
		);
	});

	it("rejects paths outside the job directory", () => {
		const root = path.join(os.tmpdir(), "export-root");
		assert.throws(() => assertPathInside(root, path.join(root, "..", "escape")), /escapes/);
		assert.equal(assertPathInside(root, path.join(root, "job", "frame.png")), path.join(root, "job", "frame.png"));
	});

	it("uses the shared cleanup path for cancellation artifacts", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-cancel-"));
		const temp = path.join(root, "temp");
		const output = path.join(root, "partial.mp4");
		fs.mkdirSync(temp);
		fs.writeFileSync(path.join(temp, "frame.png"), "frame");
		fs.writeFileSync(output, "partial");
		cleanupExportFiles(temp, output, true);
		assert.equal(fs.existsSync(temp), false);
		assert.equal(fs.existsSync(output), false);
		fs.rmSync(root, { recursive:true, force:true });
	});
});
