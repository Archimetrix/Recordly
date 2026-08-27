export function canShowFloatingWebcamPreview(
	requested: boolean,
	hudOverlayMousePassthroughSupported: boolean | null,
): boolean {
	// Allow in both passthrough and compact-bar modes; null means still loading.
	return requested && hudOverlayMousePassthroughSupported !== null;
}
export function canToggleFloatingWebcamPreview(
	hudOverlayMousePassthroughSupported: boolean | null,
): boolean {
	return hudOverlayMousePassthroughSupported !== null;
}
