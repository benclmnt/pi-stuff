/**
 * look_at — Multimodal file analysis via Gemini 3.7 Flash.
 *
 * Reads local files (images, PDFs, audio, video, or text) and sends them to Gemini 3.7 Flash for analysis.
 * No sub-agent — just a direct API call to the Gemini model.
 *
 * Supports:
 *   - Images, PDFs, audio, and video sent as inline data
 *   - Text files sent as plain text
 *   - Optional reference files for comparison (before/after, diffs, etc.)
 *
 * API key: GEMINI_API_KEY → https://aistudio.google.com/apikey
 */

import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────

function mimeType(ext: string): string {
	const map: Record<string, string> = {
		// Images
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		// Documents
		".pdf": "application/pdf",
		// Audio
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".flac": "audio/flac",
		".m4a": "audio/mp4",
		".ogg": "audio/ogg",
		".oga": "audio/ogg",
		".opus": "audio/opus",
		".aac": "audio/aac",
		// Video
		".mp4": "video/mp4",
		".mpeg": "video/mpeg",
		".mpg": "video/mpeg",
		".mov": "video/quicktime",
		".avi": "video/x-msvideo",
		".webm": "video/webm",
		".wmv": "video/x-ms-wmv",
		".3gp": "video/3gpp",
	};
	return map[ext.toLowerCase()] ?? "text/plain";
}

function isInlineMedia(path: string): boolean {
	return mimeType(extname(path)) !== "text/plain";
}

function truncate(s: string, max = 80): string {
	return s.length > max ? s.slice(0, max) + "…" : s;
}

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "look_at",
		label: "Look At",
		description:
			"Analyze a local file (image, PDF, audio, video, or text) using Gemini 3.7 Flash.\n\n"
			+ "Use this when you need to extract information from images, analyze screenshots, "
			+ "summarize documents, or compare files — without reading raw contents into context.\n\n"
			+ "Always provide a clear objective describing what to look for.\n\n"
			+ "Pass referenceFiles when you need to compare two or more files.",

		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the file to analyze (relative or absolute).",
				},
				objective: {
					type: "string",
					description:
						"What to analyze or extract (e.g., 'describe the UI layout', "
						+ "'extract all numeric values', 'summarize this document').",
				},
				referenceFiles: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional paths to reference files for comparison.",
				},
			},
			required: ["path", "objective"],
		},

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			// ── API key ────────────────────────────────────────────────
			const apiKey = process.env["GEMINI_API_KEY"];
			if (!apiKey) {
				return {
					content: [{
						type: "text",
						text:
							"❌ GEMINI_API_KEY not set. Get one at https://aistudio.google.com/apikey",
					}],
					details: { error: "missing api key" },
				};
			}

			// ── Read main file ──────────────────────────────────────────
			const filePath = resolve(_ctx.cwd, params.path);
			const objective = params.objective ?? "";
			const referenceFiles: string[] = params.referenceFiles ?? [];

			let mainPart: Record<string, unknown>;
			if (isInlineMedia(filePath)) {
				const buf = await readFile(filePath);
				mainPart = {
					inlineData: {
						mimeType: mimeType(extname(filePath)),
						data: buf.toString("base64"),
					},
				};
			} else {
				mainPart = { text: await readFile(filePath, "utf-8") };
			}

			// ── Build request payload ──────────────────────────────────
			const parts: Record<string, unknown>[] = [
				{
					text:
						`Analyze the file at "${params.path}" with this objective: ${objective}\n\n`
						+ "Be concise, specific, and direct. No preamble, disclaimers, or flattery.\n"
						+ "Use Markdown for formatting.\n",
				},
				mainPart,
			];

			// Attach reference files
			for (const ref of referenceFiles) {
				const refPath = resolve(_ctx.cwd, ref);
				if (isInlineMedia(refPath)) {
					const buf = await readFile(refPath);
					parts.push({
						inlineData: {
							mimeType: mimeType(extname(refPath)),
							data: buf.toString("base64"),
						},
					});
				} else {
					const text = await readFile(refPath, "utf-8");
					parts.push({ text: `\n--- Reference: ${ref} ---\n${text}` });
				}
			}

			if (referenceFiles.length > 0) {
				parts.push({
					text:
						"\nCompare the main file against the reference file(s). "
						+ "Identify all notable differences and similarities.",
				});
			}

			onUpdate?.({
				content: [{ type: "text", text: "🔍 Analyzing with Gemini 3.7 Flash…" }],
			});

			// ── Call Gemini API ──────────────────────────────────────
			const url =
				"https://generativelanguage.googleapis.com/v1beta/models/"
				+ "gemini-3.7-flash:generateContent"
				+ `?key=${apiKey}`;

			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ contents: [{ role: "user", parts }] }),
				signal,
			});

			if (!res.ok) {
				const err = await res.text().catch(() => res.statusText);
				return {
					content: [{
						type: "text",
						text: `❌ Gemini API error (${res.status}): ${err}`,
					}],
					details: { error: err },
				};
			}

			const data = (await res.json()) as Record<string, unknown>;
			const candidate = (data as any).candidates?.[0];
			const resultText =
				candidate?.content?.parts
					?.map((p: any) => p.text)
					.filter(Boolean)
					.join("") ?? "(no response)";

			return {
				content: [{ type: "text", text: resultText }],
				details: { model: "gemini-3.7-flash", objective },
			};
		},

		// ── TUI rendering ────────────────────────────────────────────
		renderCall(args: any, theme: any) {
			const path = args.path ?? "…";
			const obj = args.objective ? truncate(args.objective) : "";
			let text =
				theme.fg("toolTitle", theme.bold("look_at "))
				+ theme.fg("dim", path);
			if (obj) text += theme.fg("muted", ` — ${obj}`);
			const refs = args.referenceFiles;
			if (refs?.length) {
				text += theme.fg("muted", ` (+${refs.length} ref${refs.length > 1 ? "s" : ""})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result: any, _options: any, theme: any) {
			const text = result.content?.[0]?.text;
			if (!text) return new Text("(no output)", 0, 0);

			const lines = text.split("\n").slice(0, 20);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
