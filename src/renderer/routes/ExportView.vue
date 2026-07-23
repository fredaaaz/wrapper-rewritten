<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import {
	apiServer,
	Params,
	staticPaths,
	staticServer,
	swfUrlBase,
	toAttrString,
} from "../utils/AppInit";

type ExportStatus = "queued" | "rendering" | "encoding" | "completed" | "cancelled" | "failed";
interface ExportJob {
	id:string;
	movieId:string;
	status:ExportStatus;
	totalFrames:number;
	renderedFrames:number;
	progress:number;
	error?:string;
	title:string;
	settings:{ width:number; height:number; frameRate:24 | 30 };
	captureFrameRate:number;
	isWide:boolean;
	stage:string;
	etaSeconds?:number;
	downloadUrl?:string;
	hasOutput:boolean;
}
interface FlashExporterElement extends HTMLEmbedElement {
	getPhotoArray:() => string[];
	getSceneInfoArray:() => { startFrom:number }[];
}

const route = useRoute();
const movieId = route.params.movieId as string;
const movieTitle = ref("Loading movie...");
const resolution = ref("640x360");
const frameRate = ref<24 | 30>(24);
const job = ref<ExportJob>();
const busy = ref(false);
const uiError = ref("");
const showExporter = ref(false);
const playerObject = ref<FlashExporterElement>();
const lastQueuedFrame = ref(0);
const uploadQueue = ref<Promise<void>>(Promise.resolve());
let pollingTimer:ReturnType<typeof setInterval> | undefined;
let heartbeatTimer:ReturnType<typeof setInterval> | undefined;
let draining = false;
let finishing = false;
let closing = false;

const swfUrl = swfUrlBase + "/exporter.swf";
const params = ref<Params>({
	flashvars: {
		appCode: "go",
		autostart: "1",
		collab: "0",
		ctc: "go",
		goteam_draft_only: "1",
		isLogin: "Y",
		isWide: "1",
		lid: "0",
		nextUrl: "/",
		page: "",
		retut: "1",
		siteId: "go",
		tlang: "en_US",
		ut: "60",
		apiserver: apiServer + "/",
		storePath: staticServer + staticPaths.storeUrl + "/<store>",
		clientThemePath: staticServer + staticPaths.clientUrl + "/<client_theme>",
	},
	allowScriptAccess: "always",
});

const terminal = computed(() =>
	job.value && ["completed", "cancelled", "failed"].includes(job.value.status)
);
const canCancel = computed(() =>
	job.value && ["queued", "rendering", "encoding"].includes(job.value.status)
);
const frameSummary = computed(() => {
	if (!job.value) return "0 / 0";
	return `${job.value.renderedFrames.toLocaleString()} / ${job.value.totalFrames.toLocaleString()}`;
});
const etaText = computed(() => {
	if (!job.value?.etaSeconds && job.value?.etaSeconds !== 0) {
		return "Calculating...";
	}
	const seconds = job.value.etaSeconds;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
});

async function apiRequest(path:string, options?:RequestInit) {
	const response = await fetch(apiServer + path, options);
	const data = await response.json().catch(() => ({
		error: { message:`Request failed with HTTP ${response.status}.` },
	}));
	if (!response.ok) {
		throw new Error(data.error?.message || "Export request failed.");
	}
	return data;
}

async function loadMovieInfo() {
	try {
		const response = await fetch(
			apiServer + "/api/movie/get_info?id=" + encodeURIComponent(movieId)
		);
		if (!response.ok) {
			throw new Error("Movie not found.");
		}
		const movie = await response.json();
		movieTitle.value = movie.title || "Untitled";
	} catch (error) {
		uiError.value = error instanceof Error ? error.message : String(error);
	}
}

async function startExport() {
	busy.value = true;
	uiError.value = "";
	try {
		const body = new FormData();
		body.append("movieId", movieId);
		body.append("resolution", resolution.value);
		body.append("frameRate", String(frameRate.value));
		const data = await apiRequest("/api/export/start", { method:"POST", body });
		job.value = data.job;
		movieTitle.value = data.job.title;
		beginPolling();
		if (data.job.status == "rendering") {
			await mountExporter();
		}
	} catch (error) {
		uiError.value = error instanceof Error ? error.message : String(error);
	} finally {
		busy.value = false;
	}
}

async function mountExporter() {
	if (showExporter.value || !job.value || job.value.status != "rendering") {
		return;
	}
	params.value.flashvars.movieId = movieId;
	params.value.flashvars.isWide = job.value.isWide ? "1" : "0";
	params.value.movie = swfUrl;
	showExporter.value = true;
	await nextTick();
}

async function uploadFrame(index:number, frame:string) {
	if (!job.value) return;
	const base64 = frame.replace(/^data:image\/png;base64,/, "");
	const body = new FormData();
	body.append("index", String(index));
	body.append("frame", base64);
	await apiRequest(`/api/export/${job.value.id}/frame`, { method:"POST", body });
}

async function drainCapturedFrames() {
	if (draining || !playerObject.value || !job.value || job.value.status != "rendering") {
		return;
	}
	draining = true;
	try {
		const frames = playerObject.value.getPhotoArray();
		if (!Array.isArray(frames)) {
			throw new Error("Flash exporter returned an invalid frame list.");
		}
		for (let index = lastQueuedFrame.value; index < frames.length; index++) {
			const frame = frames[index];
			if (typeof frame != "string" || frame.length == 0) {
				throw new Error(`Flash exporter returned an invalid frame at index ${index}.`);
			}
			uploadQueue.value = uploadQueue.value.then(() => uploadFrame(index, frame));
			lastQueuedFrame.value++;
		}
	} catch (error) {
		await failRendering(error);
	} finally {
		draining = false;
	}
}

async function exporterSceneEntered() {
	await drainCapturedFrames();
}

async function exporterMovieEnded() {
	if (finishing || !job.value) return;
	finishing = true;
	try {
		await drainCapturedFrames();
		await uploadQueue.value;
		const scenes = playerObject.value?.getSceneInfoArray() || [];
		const sceneStarts = scenes
			.map(scene => Number(scene.startFrom))
			.filter(value => Number.isSafeInteger(value) && value >= 0);
		const body = new FormData();
		body.append("totalFrames", String(lastQueuedFrame.value));
		body.append("sceneStarts", JSON.stringify(sceneStarts));
		const data = await apiRequest(`/api/export/${job.value.id}/finish`, {
			method: "POST",
			body,
		});
		job.value = data.job;
		showExporter.value = false;
	} catch (error) {
		await failRendering(error);
	}
}

async function failRendering(error:unknown) {
	uiError.value = error instanceof Error ? error.message : String(error);
	if (job.value && canCancel.value) {
		try {
			const data = await apiRequest(`/api/export/${job.value.id}/cancel`, { method:"POST" });
			job.value = data.job;
		} catch {
			// Keep the original rendering error visible.
		}
	}
	showExporter.value = false;
}

async function refreshStatus() {
	if (!job.value) return;
	try {
		const data = await apiRequest(`/api/export/${job.value.id}/status`);
		const previous = job.value.status;
		job.value = data.job;
		if (previous == "queued" && data.job.status == "rendering") {
			await mountExporter();
		}
		if (terminal.value) {
			stopPolling();
			showExporter.value = false;
		}
	} catch (error) {
		uiError.value = error instanceof Error ? error.message : String(error);
	}
}

async function heartbeat() {
	if (!job.value || !["queued", "rendering"].includes(job.value.status)) return;
	try {
		await apiRequest(`/api/export/${job.value.id}/heartbeat`, { method:"POST" });
	} catch {
		// Status polling provides the user-facing failure.
	}
}

function beginPolling() {
	stopPolling();
	pollingTimer = setInterval(refreshStatus, 750);
	heartbeatTimer = setInterval(heartbeat, 5_000);
}

function stopPolling() {
	if (pollingTimer) clearInterval(pollingTimer);
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	pollingTimer = undefined;
	heartbeatTimer = undefined;
}

async function cancelExport() {
	if (!job.value || !canCancel.value) return;
	busy.value = true;
	try {
		const data = await apiRequest(`/api/export/${job.value.id}/cancel`, { method:"POST" });
		job.value = data.job;
		showExporter.value = false;
		stopPolling();
	} catch (error) {
		uiError.value = error instanceof Error ? error.message : String(error);
	} finally {
		busy.value = false;
	}
}

function resetExport() {
	stopPolling();
	job.value = undefined;
	uiError.value = "";
	showExporter.value = false;
	lastQueuedFrame.value = 0;
	uploadQueue.value = Promise.resolve();
	draining = false;
	finishing = false;
}

async function nativeAction(action:"exportSaveAs" | "exportOpenFile" | "exportOpenFolder") {
	if (!job.value) return;
	uiError.value = "";
	try {
		await (window as any).appWindow[action](job.value.id);
	} catch (error) {
		uiError.value = error instanceof Error ? error.message : String(error);
	}
}

function closeWindow() {
	window.close();
}

function beforeUnload() {
	closing = true;
	if (job.value && canCancel.value) {
		navigator.sendBeacon(apiServer + `/api/export/${job.value.id}/cancel`, new FormData());
	}
}

onMounted(() => {
	(window as any).onSceneEnter = exporterSceneEntered;
	(window as any).notifyMovieEnded = exporterMovieEnded;
	window.addEventListener("beforeunload", beforeUnload);
	void loadMovieInfo();
});

onBeforeUnmount(() => {
	stopPolling();
	window.removeEventListener("beforeunload", beforeUnload);
	delete (window as any).onSceneEnter;
	delete (window as any).notifyMovieEnded;
	if (!closing) beforeUnload();
});
</script>

<template>
	<main class="export_page">
		<header>
			<div>
				<span class="eyebrow">EXPORT MP4</span>
				<h1>{{ movieTitle }}</h1>
			</div>
			<button class="close" title="Close" @click="closeWindow">×</button>
		</header>

		<section v-if="!job" class="setup panel">
			<h2>Video settings</h2>
			<label>
				<span>Resolution</span>
				<select v-model="resolution" :disabled="busy">
					<option value="640x360">640 × 360</option>
					<option value="854x480">854 × 480</option>
					<option value="1280x720">1280 × 720</option>
					<option value="1920x1080">1920 × 1080</option>
				</select>
			</label>
			<label>
				<span>Frame rate</span>
				<select v-model="frameRate" :disabled="busy">
					<option :value="24">24 FPS</option>
					<option :value="30">30 FPS</option>
				</select>
			</label>
			<p class="hint">
				The movie keeps its native aspect ratio. Black padding is added when the selected
				frame shape differs from the movie.
			</p>
			<button class="primary" :disabled="busy || !!uiError" @click="startExport">
				{{ busy ? "Preparing..." : "Start export" }}
			</button>
		</section>

		<section v-else class="progress_panel panel">
			<div class="stage_row">
				<div>
					<span class="eyebrow">CURRENT STAGE</span>
					<h2>{{ job.stage }}</h2>
				</div>
				<strong>{{ Math.round(job.progress) }}%</strong>
			</div>
			<div class="progress_track">
				<div class="progress_fill" :style="{ width:`${job.progress}%` }"></div>
			</div>
			<div class="stats">
				<div><span>Resolution</span><strong>{{ job.settings.width }} × {{ job.settings.height }}</strong></div>
				<div><span>Frame rate</span><strong>{{ job.settings.frameRate }} FPS</strong></div>
				<div><span>Frames</span><strong>{{ frameSummary }}</strong></div>
				<div><span>Estimated remaining</span><strong>{{ terminal ? "—" : etaText }}</strong></div>
			</div>

			<div v-show="showExporter" class="flash_preview">
				<object
					v-if="showExporter"
					id="exporter_object"
					ref="playerObject"
					:src="swfUrl"
					type="application/x-shockwave-flash">
					<param
						v-for="[name, param] of Object.entries(params)"
						:key="name"
						:name="name"
						:value="toAttrString(param)"/>
				</object>
				<span>Rendering the actual movie through the Wrapper player</span>
			</div>

			<div v-if="job.status == 'completed'" class="completion">
				<button class="primary" @click="nativeAction('exportSaveAs')">Save As...</button>
				<button @click="nativeAction('exportOpenFile')">Open file</button>
				<button @click="nativeAction('exportOpenFolder')">Open containing folder</button>
			</div>
			<div v-else-if="job.status == 'failed'" class="failure">
				<p>{{ job.error }}</p>
				<button @click="resetExport">Try again</button>
			</div>
			<div v-else-if="job.status == 'cancelled'" class="completion">
				<button @click="resetExport">Start another export</button>
			</div>
			<button v-else class="danger" :disabled="busy" @click="cancelExport">
				{{ busy ? "Cancelling..." : "Cancel export" }}
			</button>
		</section>

		<p v-if="uiError" class="error">{{ uiError }}</p>
	</main>
</template>

<style scoped>
.export_page {
	background: linear-gradient(145deg, hsl(250 16% 97%), hsl(250 16% 90%));
	box-sizing: border-box;
	overflow: auto;
	width: 100%;
	height: 100%;
	padding: 28px;
}
header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	margin: 0 auto 22px;
	max-width: 680px;
}
h1, h2, p { margin: 0; }
h1 { color: hsl(244 15% 24%); font-size: 26px; line-height: 1.25; }
h2 { color: hsl(244 15% 28%); font-size: 18px; }
.eyebrow {
	color: #e34772;
	font-size: 11px;
	font-weight: 800;
	letter-spacing: .11em;
}
.close {
	background: transparent;
	border: 0;
	color: #777382;
	cursor: pointer;
	font-size: 30px;
	line-height: 1;
}
.panel {
	background: #fff;
	border: 1px solid #d8d5df;
	border-radius: 9px;
	box-shadow: 0 12px 35px #24203012;
	margin: auto;
	max-width: 680px;
	padding: 24px;
}
.setup label {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-top: 18px;
}
.setup label span { font-weight: 700; }
select {
	background: #faf9fc;
	border: 1px solid #cbc8d2;
	border-radius: 5px;
	min-width: 190px;
	padding: 8px 10px;
}
.hint {
	color: #777382;
	font-size: 13px;
	line-height: 1.45;
	margin: 18px 0;
}
button {
	background: #eceaf0;
	border: 0;
	border-radius: 5px;
	color: #44404e;
	cursor: pointer;
	font-weight: 700;
	padding: 9px 14px;
}
button.primary { background: #ee4d78; color: white; }
button.danger { background: #802a3f; color: white; margin-top: 20px; }
button:disabled { cursor: default; opacity: .5; }
.stage_row {
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.stage_row strong { color: #e34772; font-size: 28px; }
.progress_track {
	background: #e8e5ec;
	border-radius: 10px;
	height: 12px;
	margin: 18px 0;
	overflow: hidden;
}
.progress_fill {
	background: linear-gradient(90deg, #ee4d78, #ff8b65);
	height: 100%;
	transition: width .2s linear;
}
.stats {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
}
.stats div {
	background: #f7f6f9;
	border-radius: 6px;
	display: flex;
	flex-direction: column;
	padding: 10px 12px;
}
.stats span { color: #827e89; font-size: 11px; text-transform: uppercase; }
.flash_preview {
	background: #1e1c24;
	border-radius: 7px;
	margin-top: 18px;
	overflow: hidden;
	text-align: center;
}
#exporter_object {
	display: block;
	margin: auto;
	width: min(100%, 480px);
	aspect-ratio: 16 / 9;
}
.flash_preview span { color: #aaa6b3; display: block; font-size: 11px; padding: 7px; }
.completion {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin-top: 20px;
}
.failure {
	background: #fff0f2;
	border-radius: 5px;
	color: #9c314b;
	margin-top: 18px;
	padding: 12px;
}
.failure button { margin-top: 10px; }
.error {
	background: #ffe9ed;
	border: 1px solid #f0b6c2;
	border-radius: 5px;
	color: #8e2942;
	margin: 16px auto 0;
	max-width: 680px;
	padding: 10px 14px;
}
html.dark .export_page {
	background: linear-gradient(145deg, hsl(250 12% 13%), hsl(250 12% 8%));
}
html.dark .panel { background: #24212b; border-color: #393541; }
html.dark h1, html.dark h2 { color: #f0edf5; }
html.dark select, html.dark .stats div { background: #1b1920; border-color: #403b48; color: #eee; }
</style>
