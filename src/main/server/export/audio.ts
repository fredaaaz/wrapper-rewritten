import AssetModel from "../models/asset";
import directories from "../../storage/directories";
import fs from "fs";
import path from "path";
import { XmlDocument, XmlElement } from "xmldoc";
import type { AudioClip } from "./types";
import { assertPathInside } from "./validation";

export const MOVIE_CAPTURE_FRAME_RATE = 24;

function numberValue(element:XmlElement, name:string, fallback = 0): number {
	const value = Number(element.childNamed(name)?.val);
	return Number.isFinite(value) ? value : fallback;
}

function normalizedVolume(value:number, fallback = 1): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	const normalized = value > 1 ? value / 100 : value;
	return Math.max(0, Math.min(4, normalized));
}

export function resolveAudioAsset(sfile:string): { filepath:string, assetId:string } {
	const pieces = sfile.split(".");
	if (
		pieces.length < 2 ||
		pieces.some(piece => piece == "" || piece == ".." || /[\/\\\u0000]/.test(piece))
	) {
		throw new Error(`Invalid audio asset reference "${sfile}".`);
	}
	const themeId = pieces[0];
	const extension = pieces.pop() as string;
	pieces[pieces.length - 1] += "." + extension;
	pieces.splice(1, 0, "sound");

	let filepath:string;
	if (themeId == "ugc") {
		filepath = assertPathInside(
			AssetModel.folder,
			path.join(AssetModel.folder, pieces[pieces.length - 1])
		);
	} else {
		filepath = assertPathInside(directories.store, path.join(directories.store, ...pieces));
	}

	// The common library includes decrypted MP3 equivalents for a number of
	// legacy embedded SWF sounds. Prefer those because FFmpeg can decode them
	// consistently on every supported platform.
	if (path.extname(filepath).toLowerCase() == ".swf") {
		const mp3Path = filepath.slice(0, -4) + ".mp3";
		if (fs.existsSync(mp3Path)) {
			filepath = mp3Path;
		}
	}
	return { filepath, assetId:sfile };
}

export function extractAudioClips(xmlBuffer:Buffer): AudioClip[] {
	const film = new XmlDocument(xmlBuffer.toString());
	const clips:AudioClip[] = [];

	for (const child of film.children) {
		if (child.name != "sound") {
			continue;
		}
		const sfile = child.childNamed("sfile")?.val;
		if (!sfile) {
			throw new Error("A movie sound is missing its sfile reference.");
		}
		const startFrames = numberValue(child, "start");
		const stopFrames = numberValue(child, "stop", startFrames);
		const trimStartFrames = Math.max(0, numberValue(child, "trimStart"));
		const trimEndFrames = Math.max(0, numberValue(child, "trimEnd"));
		const timelineDurationFrames = Math.max(0, stopFrames - startFrames);
		const trimmedDurationFrames = trimEndFrames > trimStartFrames
			? trimEndFrames - trimStartFrames
			: timelineDurationFrames;
		const durationFrames = Math.min(
			timelineDurationFrames || trimmedDurationFrames,
			trimmedDurationFrames || timelineDurationFrames
		);
		if (durationFrames <= 0) {
			continue;
		}

		const fadeIn = child.childNamed("fadein");
		const fadeOut = child.childNamed("fadeout");
		const volumeElement = child.childNamed("volume");
		const volumeValue = Number(volumeElement?.val ?? child.attr.volume ?? child.attr.vol);
		const resolved = resolveAudioAsset(sfile);
		clips.push({
			...resolved,
			startSeconds: startFrames / MOVIE_CAPTURE_FRAME_RATE,
			durationSeconds: durationFrames / MOVIE_CAPTURE_FRAME_RATE,
			trimStartSeconds: trimStartFrames / MOVIE_CAPTURE_FRAME_RATE,
			trimEndSeconds: trimEndFrames > trimStartFrames
				? trimEndFrames / MOVIE_CAPTURE_FRAME_RATE
				: 0,
			fadeInSeconds: Math.max(0, Number(fadeIn?.attr.duration) || 0) / MOVIE_CAPTURE_FRAME_RATE,
			fadeOutSeconds: Math.max(0, Number(fadeOut?.attr.duration) || 0) / MOVIE_CAPTURE_FRAME_RATE,
			fadeInVolume: normalizedVolume(Number(fadeIn?.attr.vol), 1),
			fadeOutVolume: normalizedVolume(Number(fadeOut?.attr.vol), 0),
			volume: normalizedVolume(volumeValue, 1),
		});
	}
	return clips;
}
