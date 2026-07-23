import { basename, resolve, sep } from "path";

export const MOVIE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
export const MAX_FRAME_BASE64_LENGTH = 12 * 1024 * 1024;
export const MAX_FRAME_INDEX = 24 * 60 * 60 * 12;

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isValidMovieId(value:unknown): value is string {
	return typeof value == "string" && MOVIE_ID_PATTERN.test(value);
}

export function isValidJobId(value:unknown): value is string {
	return typeof value == "string" && JOB_ID_PATTERN.test(value);
}

export function requireExistingMovie(
	movieId:unknown,
	exists:(id:string) => boolean
): asserts movieId is string {
	if (!isValidMovieId(movieId) || !exists(movieId)) {
		throw new RangeError("Movie not found.");
	}
}

export function validateFrameIndex(value:unknown): number {
	const parsed = typeof value == "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_FRAME_INDEX) {
		throw new RangeError("Frame index must be a non-negative integer.");
	}
	return parsed;
}

export function decodePngBase64(value:unknown): Buffer {
	if (typeof value != "string" || value.length == 0) {
		throw new TypeError("Frame data must be a base64 string.");
	}
	if (value.length > MAX_FRAME_BASE64_LENGTH) {
		throw new RangeError("Frame payload is too large.");
	}
	if (
		value.length % 4 != 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
		value.indexOf("=") > -1 && value.indexOf("=") < value.length - 2
	) {
		throw new TypeError("Frame data is not valid base64.");
	}
	const decoded = Buffer.from(value, "base64");
	if (
		decoded.length < PNG_SIGNATURE.length ||
		!decoded.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
	) {
		throw new TypeError("Frame data is not a PNG image.");
	}
	return decoded;
}

export function safeFilename(value:string): string {
	let name = value
		.normalize("NFKC")
		.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
		.replace(/\.{2,}/g, "_")
		.replace(/^\./, "_")
		.replace(/_+/g, "_")
		.replace(/\s+/g, " ")
		.replace(/[ .]+$/g, "")
		.trim();
	if (!name) {
		name = "Untitled";
	}
	if (WINDOWS_RESERVED_NAMES.test(name)) {
		name = "_" + name;
	}
	return name.slice(0, 120).replace(/[ .]+$/g, "") || "Untitled";
}

export function assertPathInside(parent:string, child:string): string {
	const parentPath = resolve(parent);
	const childPath = resolve(child);
	if (childPath != parentPath && !childPath.startsWith(parentPath + sep)) {
		throw new Error("Resolved path escapes the export directory.");
	}
	return childPath;
}

export function safeDownloadName(title:string): string {
	return basename(safeFilename(title)) + ".mp4";
}

export function scalarField(value:unknown): unknown {
	return Array.isArray(value) ? value[0] : value;
}
