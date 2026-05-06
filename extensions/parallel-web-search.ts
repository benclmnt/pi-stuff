/**
 * Parallel Web Search Tool for pi
 *
 * Provides a `web_search` tool that uses Parallel's Search API (https://parallel.ai)
 * to search the web and return LLM-optimized excerpts.
 *
 * Expects PARALLEL_API_KEY to be set in the environment (e.g. via the user-keys-env
 * extension that loads ~/.pi/agent/user-keys.json into process.env).
 *
 * The tool accepts a primary query plus optional additional queries, an objective,
 * and a search mode. Results are truncated to pi's default limits (50KB / 2000 lines)
 * with full output saved to a temp file when truncated.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const API_BASE = "https://api.parallel.ai";

const SearchParams = Type.Object({
	query: Type.String({
		description: "Primary search query (3-6 words recommended)",
	}),
	queries: Type.Optional(
		Type.Array(Type.String(), {
			description: "Additional search queries for broader coverage",
		}),
	),
	objective: Type.Optional(
		Type.String({
			description:
				"Natural-language description of the underlying goal driving the search. Provides context to focus results.",
		}),
	),
	mode: Type.Optional(
		StringEnum(["basic", "advanced"] as const, {
			description:
				"Search mode: 'basic' for lowest latency, 'advanced' for higher quality retrieval. Defaults to 'advanced'.",
		}),
	),
});

interface SearchDetails {
	query: string;
	queries?: string[];
	objective?: string;
	mode?: string;
	resultCount: number;
	truncated?: boolean;
	fullOutputPath?: string;
	warnings?: string[];
}

function formatResults(data: {
	results: Array<{
		url: string;
		title?: string | null;
		publish_date?: string | null;
		excerpts: string[];
	}>;
	warnings?: Array<{ type: string; message: string }> | null;
}): string {
	const lines: string[] = [];

	if (data.warnings && data.warnings.length > 0) {
		lines.push("Warnings:");
		for (const w of data.warnings) {
			lines.push(`  [${w.type}] ${w.message}`);
		}
		lines.push("");
	}

	for (let i = 0; i < data.results.length; i++) {
		const r = data.results[i];
		const title = r.title ?? "Untitled";
		const date = r.publish_date ? ` (${r.publish_date})` : "";
		lines.push(`${i + 1}. ${title}${date}`);
		lines.push(`   URL: ${r.url}`);
		for (const excerpt of r.excerpts) {
			const trimmed = excerpt.trim();
			if (trimmed) {
				// Indent excerpts so they don't look like new result entries
				const indented = trimmed
					.split("\n")
					.map((l) => `   ${l}`)
					.join("\n");
				lines.push(indented);
			}
		}
		lines.push("");
	}

	return lines.join("\n").trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web using Parallel (https://parallel.ai). Returns relevant excerpts from web pages. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Requires PARALLEL_API_KEY to be set in the environment.`,
		promptSnippet:
			"Search the web for current information, facts, or references using Parallel",
		promptGuidelines: [
			"Use web_search when you need current or factual information not in your training data.",
			"Provide 1-3 concise search queries (3-6 words each) for best results.",
			"Include an objective when the search goal needs additional context.",
		],
		parameters: SearchParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const apiKey = process.env.PARALLEL_API_KEY;
			if (!apiKey) {
				throw new Error(
					"PARALLEL_API_KEY is not set. Ensure the user-keys-env extension is loaded, " +
					"or set the environment variable directly.",
				);
			}

			const searchQueries = [params.query];
			if (params.queries && params.queries.length > 0) {
				searchQueries.push(...params.queries);
			}

			const body: Record<string, unknown> = {
				search_queries: searchQueries,
			};
			if (params.objective !== undefined) {
				body.objective = params.objective;
			}
			if (params.mode !== undefined) {
				body.mode = params.mode;
			}

			const response = await fetch(`${API_BASE}/v1/search`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": apiKey,
				},
				body: JSON.stringify(body),
				signal: signal ?? undefined,
			});

			if (!response.ok) {
				let errText = await response.text();
				try {
					const errJson = JSON.parse(errText);
					errText = errJson.error?.message ?? errText;
				} catch {
					// keep raw text
				}
				throw new Error(
					`Parallel Search API error (${response.status}): ${errText}`,
				);
			}

			const data = (await response.json()) as {
				search_id: string;
				results: Array<{
					url: string;
					title?: string | null;
					publish_date?: string | null;
					excerpts: string[];
				}>;
				warnings?: Array<{ type: string; message: string }> | null;
				session_id: string;
			};

			const formatted = formatResults(data);
			const truncation = truncateHead(formatted, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: SearchDetails = {
				query: params.query,
				queries: params.queries,
				objective: params.objective,
				mode: params.mode,
				resultCount: data.results.length,
				warnings:
					data.warnings?.map((w) => `[${w.type}] ${w.message}`) ?? undefined,
			};

			let resultText = truncation.content;

			if (truncation.truncated) {
				const tempDir = await mkdtemp(join(tmpdir(), "pi-web-search-"));
				const tempFile = join(tempDir, "output.txt");
				await writeFile(tempFile, formatted, "utf8");

				details.truncated = true;
				details.fullOutputPath = tempFile;

				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.queries && args.queries.length > 0) {
				text += theme.fg("dim", ` +${args.queries.length} more`);
			}
			if (args.mode) {
				text += theme.fg("muted", ` [${args.mode}]`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as SearchDetails | undefined;

			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}

			if (!details) {
				return new Text(theme.fg("error", "Error: no details"), 0, 0);
			}

			let text = theme.fg(
				"success",
				`${details.resultCount} result${details.resultCount === 1 ? "" : "s"}`,
			);

			if (details.truncated) {
				text += theme.fg("warning", " (truncated)");
			}

			if (details.warnings && details.warnings.length > 0) {
				text += theme.fg(
					"warning",
					` • ${details.warnings.length} warning${details.warnings.length === 1 ? "" : "s"}`,
				);
			}

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 30);
					for (const line of lines) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (content.text.split("\n").length > 30) {
						text += `\n${theme.fg("muted", "...")}`;
					}
				}
				if (details.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
