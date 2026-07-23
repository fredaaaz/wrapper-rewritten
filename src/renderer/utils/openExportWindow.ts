/**
 * Opens the isolated MP4 export window for a saved movie.
 */
export default function openExportWindow(movieId:string) {
	const width = Math.min(screen.availWidth, 760);
	const height = Math.min(screen.availHeight, 760);
	window.open(
		`?redirect=/movies/export/${encodeURIComponent(movieId)}`,
		`ExportMovie-${movieId}`,
		`width=${width},height=${height},left=${Math.max(0, (screen.width - width) / 2)},` +
		`top=${Math.max(0, (screen.height - height) / 2)}`
	);
}
