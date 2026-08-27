import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BrowserWindow } from "electron";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { getWindowsCaptureExePath } from "../paths/binaries";
import {
	selectedSource,
	setWindowsCaptureProcess,
	setWindowsCaptureStopRequested,
	setWindowsNativeCaptureActive,
	windowsCaptureOutputBuffer,
	windowsCaptureStopRequested,
	windowsCaptureTargetPath,
	windowsNativeCaptureActive,
} from "../state";
import {
	AudioSyncAdjustment,
} from "../types";
import { moveFileWithOverwrite } from "../utils";
import { emitRecordingInterrupted } from "./events";

const execFileAsync = promisify(execFile);

const WINDOWS_CAPTURE_STOP_TIMEOUT_MS = 45_000;

export type NativeWindowsVideoPaddingResult = {
	padded: boolean;
	durationSeconds: number;
	containerDurationSeconds: number;
	targetDurationSeconds: number;
	padDurationSeconds: number;
};

export type NativeWindowsAudioMuxResult = {
	muxed: boolean;
	videoDurationSeconds: number;
	muxTimeoutMs: number;
	audioInputs: string[];
	audio: Record<
		string,
		{
			path: string;
			sizeBytes: number;
			durationSeconds: number;
			startDelayMs: number | null;
			adjustment: AudioSyncAdjustment;
		}
	>;
	outputPath?: string;
	keptAudioSidecars?: boolean;
};

export async function isNativeWindowsCaptureAvailable(): Promise<boolean> {
	if (process.platform !== "win32") return false;

	const os = await import("node:os");
	const [major, , build] = os.release().split(".").map(Number);
	const supported = major >= 10 && build >= 19041;
	if (!supported) return false;

	try {
		await fs.access(getWindowsCaptureExePath(), fsConstants.X_OK);
	} catch {
		return false;
	}

	return true;
}

export function waitForWindowsCaptureStart(proc: ChildProcessWithoutNullStreams) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for native Windows capture to start"));
		}, 12000);

		let stdoutBuffer = "";
		const onStdout = (chunk: Buffer) => {
			stdoutBuffer += chunk.toString();
			if (stdoutBuffer.includes("Recording started")) {
				cleanup();
				resolve();
			}
		};

		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};

		const onExit = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					windowsCaptureOutputBuffer.trim() ||
						`Native Windows capture exited before recording started (code ${code ?? "unknown"})`,
				),
			);
		};

		const cleanup = () => {
			clearTimeout(timer);
			proc.stdout.off("data", onStdout);
			proc.off("error", onError);
			proc.off("exit", onExit);
		};

		proc.stdout.on("data", onStdout);
		proc.once("error", onError);
		proc.once("exit", onExit);
	});
}

export function waitForWindowsCaptureStop(
	proc: ChildProcessWithoutNullStreams,
	timeoutMs = WINDOWS_CAPTURE_STOP_TIMEOUT_MS,
) {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};

		const timer = setTimeout(() => {
			finish(() => {
				try {
					if (!proc.killed) proc.kill();
				} catch {
					// The process may already be gone; the caller only needs the timeout error.
				}
				reject(new Error("Timed out waiting for native Windows capture to stop"));
			});
		}, timeoutMs);

		const onClose = (code: number | null) => {
			finish(() => {
				const match = windowsCaptureOutputBuffer.match(/Recording stopped\. Output path: (.+)/);
				if (match?.[1]) {
					resolve(match[1].trim());
					return;
				}
				if (code === 0 && windowsCaptureTargetPath) {
					resolve(windowsCaptureTargetPath);
					return;
				}
				reject(
					new Error(
						windowsCaptureOutputBuffer.trim() ||
							`Native Windows capture exited with code ${code ?? "unknown"}`,
					),
				);
			});
		};

		const onError = (error: Error) => {
			finish(() => {
				reject(error);
			});
		};

		const cleanup = () => {
			clearTimeout(timer);
			proc.off("close", onClose);
			proc.off("error", onError);
		};

		proc.once("close", onClose);
		proc.once("error", onError);
	});
}

export function attachWindowsCaptureLifecycle(proc: ChildProcessWithoutNullStreams) {
	proc.once("close", () => {
		const wasActive = windowsNativeCaptureActive;
		setWindowsCaptureProcess(null);

		if (!wasActive || windowsCaptureStopRequested) {
			return;
		}

		setWindowsNativeCaptureActive(false);
		setWindowsCaptureStopRequested(false);

		const sourceName = selectedSource?.name ?? "Screen";
		BrowserWindow.getAllWindows().forEach((window) => {
			if (!window.isDestroyed()) {
				window.webContents.send("recording-state-changed", {
					recording: false,
					sourceName,
				});
			}
		});

		emitRecordingInterrupted("capture-stopped", "Recording stopped unexpectedly.");
	});
}

export async function muxNativeWindowsVideoWithAudio(
	videoPath: string,
	systemAudioPath: string | null,
	micAudioPath: string | null,
): Promise<NativeWindowsAudioMuxResult> {
	const start = Date.now();
	console.log("[PERF:MAIN] muxNativeWindowsVideoWithAudio: STARTED");
	const audio: NativeWindowsAudioMuxResult["audio"] = {};
	const audioInputs: string[] = [];

	const videoPathWithoutExt = videoPath.replace(/\.[^.]+$/u, "");

	// Collect audio inputs that have usable data.
	const audioInputFiles: { type: "mic" | "system"; inputPath: string }[] = [];

	if (micAudioPath) {
		try {
			const stat = await fs.stat(micAudioPath);
			if (stat.size > 0) {
				audioInputFiles.push({ type: "mic", inputPath: micAudioPath });
			}
		} catch { /* missing file — skip */ }
	}

	if (systemAudioPath) {
		try {
			const stat = await fs.stat(systemAudioPath);
			if (stat.size > 0) {
				audioInputFiles.push({ type: "system", inputPath: systemAudioPath });
			}
		} catch { /* missing file — skip */ }
	}

	if (audioInputFiles.length > 0) {
		// Mux audio directly into the MP4. Video stream is stream-copied (no
		// re-encode) so this is fast even for large files — only audio is encoded.
		const ffmpegPath = getFfmpegBinaryPath();
		const tmpOutput = path.join(os.tmpdir(), `recordly-mux-${Date.now()}.mp4`);

		try {
			const ffmpegArgs = [
				"-y",
				"-i", videoPath,
				...audioInputFiles.flatMap(({ inputPath }) => ["-i", inputPath]),
				"-c:v", "copy",
				"-c:a", "aac",
				"-b:a", "192k",
				"-map", "0:v:0",
				// Mix all audio inputs into a single stereo track.
				...(audioInputFiles.length > 1
					? ["-filter_complex", `amix=inputs=${audioInputFiles.length}:duration=first[amix]`, "-map", "[amix]"]
					: ["-map", "1:a:0"]),
				"-movflags", "+faststart",
				tmpOutput,
			];

			console.log("[mux-win] Running ffmpeg mux:", ffmpegArgs.join(" "));
			await execFileAsync(ffmpegPath, ffmpegArgs, {
				timeout: 30 * 60 * 1000,
				maxBuffer: 100 * 1024 * 1024,
			});

			await moveFileWithOverwrite(tmpOutput, videoPath);
			console.log("[mux-win] Mux complete — audio embedded in MP4");

			for (const { type, inputPath } of audioInputFiles) {
				audioInputs.push(type);
				const stat = await fs.stat(videoPath);
				audio[type] = {
					path: videoPath,
					sizeBytes: stat.size,
					durationSeconds: 0,
					startDelayMs: null,
					adjustment: { mode: "none", delayMs: 0, tempoRatio: 1, durationDeltaMs: 0 },
				};
				// Remove the now-redundant sidecar files.
				fs.rm(inputPath, { force: true }).catch(() => undefined);
				fs.rm(`${inputPath}.json`, { force: true }).catch(() => undefined);
			}
		} catch (err) {
			console.error("[mux-win] ffmpeg mux failed, keeping sidecars:", err);
			fs.rm(tmpOutput, { force: true }).catch(() => undefined);
			// Fall back: keep sidecar files at their final companion paths.
			for (const { type, inputPath } of audioInputFiles) {
				const finalPath = `${videoPathWithoutExt}.${type}.wav`;
				if (inputPath !== finalPath) {
					await moveFileWithOverwrite(inputPath, finalPath).catch(() => undefined);
				}
				audioInputs.push(type);
				const stat = await fs.stat(finalPath).catch(() => ({ size: 0 }));
				audio[type] = {
					path: finalPath,
					sizeBytes: stat.size,
					durationSeconds: 0,
					startDelayMs: null,
					adjustment: { mode: "none", delayMs: 0, tempoRatio: 1, durationDeltaMs: 0 },
				};
			}
		}
	}

	console.log(
		`[PERF:MAIN] muxNativeWindowsVideoWithAudio: COMPLETED in ${Date.now() - start}ms`,
	);

	return {
		muxed: audioInputs.length > 0,
		videoDurationSeconds: 0,
		muxTimeoutMs: 0,
		audioInputs,
		audio,
		keptAudioSidecars: false,
	};
}
