/**
 * Web Search Tool for pi
 *
 * Provides a `web_search` tool that uses Parallel's Search API (https://parallel.ai)
 * or Exa's Search API (https://exa.ai) to search the web and return
 * LLM-optimized excerpts.
 *
 * Expects PARALLEL_API_KEY or EXA_API_KEY to be set in the environment
 * (e.g. via the user-keys-env extension that loads
 * ~/.pi/agent/user-keys.json into process.env).
 *
 * The tool accepts a primary query plus optional additional queries, an objective,
 * a provider, and provider-specific search modes. Results are truncated to pi's
 * default limits (50KB / 2000 lines) with full output saved to a temp file when
 * truncated.
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

const PARALLEL_API_BASE = "https://api.parallel.ai";
const EXA_API_BASE = "https://api.exa.ai";

type SearchProvider = "parallel" | "exa";

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
	provider: Type.Optional(
		StringEnum(["parallel", "exa"] as const, {
			description:
				"Search provider. Defaults to Parallel when PARALLEL_API_KEY is set, otherwise Exa when EXA_API_KEY is set.",
		}),
	),
	mode: Type.Optional(
		StringEnum(["basic", "advanced"] as const, {
			description:
				"Parallel search mode: 'basic' for lowest latency, 'advanced' for higher quality retrieval. Defaults to 'advanced'.",
		}),
	),
	exaType: Type.Optional(
		StringEnum(["auto", "instant", "fast", "deep", "deep-reasoning"] as const, {
			description:
				"Exa search type. Defaults to 'auto'. Use 'fast' or 'instant' for speed and 'deep' for harder searches.",
		}),
	),
});

interface SearchDetails {
	provider: SearchProvider;
	query: string;
	queries?: string[];
	objective?: string;
	mode?: string;
	exaType?: string;
	resultCount: number;
	requestCount: number;
	truncated?: boolean;
	fullOutputPath?: string;
	warnings?: string[];
}

interface SearchResult {
	url: string;
	title?: string | null;
	publishDate?: string | null;
	excerpts: string[];
}

interface ResultGroup {
	query: string;
	results: SearchResult[];
	warnings?: string[];
}

function normalizeQueries(params: { query: string; queries?: string[] }): string[] {
	return [params.query, ...(params.queries ?? [])].map((q) => q.trim()).filter(Boolean);
}

function formatResults(groups: ResultGroup[]): string {
	const lines: string[] = [];
	let resultNumber = 1;
	const showQueryHeadings = groups.length > 1;

	for (const group of groups) {
		if (showQueryHeadings) {
			lines.push(`Query: ${group.query}`);
		}

		if (group.warnings && group.warnings.length > 0) {
			lines.push("Warnings:");
			for (const warning of group.warnings) {
				lines.push(`  ${warning}`);
			}
			lines.push("");
		}

		for (const result of group.results) {
			const title = result.title ?? "Untitled";
			const date = result.publishDate ? ` (${result.publishDate})` : "";
			lines.push(`${resultNumber}. ${title}${date}`);
			lines.push(`   URL: ${result.url}`);
			for (const excerpt of result.excerpts) {
				const trimmed = excerpt.trim();
				if (trimmed) {
					const indented = trimmed
						.split("\n")
						.map((line) => `   ${line}`)
						.join("\n");
					lines.push(indented);
				}
			}
			lines.push("");
			resultNumber++;
		}

		if (showQueryHeadings) {
			lines.push("");
		}
	}

	const formatted = lines.join("\n").trim();
	return formatted || "No results found.";
}

async function getApiError(response: Response): Promise<string> {
	let errText = await response.text();
	try {
		const errJson = JSON.parse(errText) as {
			error?: { message?: string } | string;
			message?: string;
		};
		if (typeof errJson.error === "string") {
			errText = errJson.error;
		} else {
			errText = errJson.error?.message ?? errJson.message ?? errText;
		}
	} catch {
		// keep raw text
	}
	return errText;
}

function selectProvider(requestedProvider?: SearchProvider): SearchProvider {
	if (requestedProvider) return requestedProvider;
	if (process.env.PARALLEL_API_KEY) return "parallel";
	if (process.env.EXA_API_KEY) return "exa";
	throw new Error(
		"PARALLEL_API_KEY or EXA_API_KEY is not set. Configure one key or pass a provider with its key.",
	);
}

async function runParallelSearch(
	params: {
		query: string;
		queries?: string[];
		objective?: string;
		mode?: string;
	},
	signal?: AbortSignal | null,
): Promise<{ groups: ResultGroup[]; mode: string }> {
	const apiKey = process.env.PARALLEL_API_KEY;
	if (!apiKey) {
		throw new Error(
			"PARALLEL_API_KEY is not set. Set provider to 'exa' or configure PARALLEL_API_KEY.",
		);
	}

	const mode = params.mode ?? "advanced";
	const body: Record<string, unknown> = {
		search_queries: normalizeQueries(params),
		mode,
	};
	if (params.objective !== undefined) {
		body.objective = params.objective;
	}

	const response = await fetch(`${PARALLEL_API_BASE}/v1/search`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(body),
		signal: signal ?? undefined,
	});

	if (!response.ok) {
		throw new Error(
			`Parallel Search API error (${response.status}): ${await getApiError(response)}`,
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

	return {
		groups: [
			{
				query: params.query,
				results: data.results.map((result) => ({
					url: result.url,
					title: result.title,
					publishDate: result.publish_date,
					excerpts: result.excerpts,
				})),
				warnings: data.warnings?.map((w) => `[${w.type}] ${w.message}`),
			},
		],
		mode,
	};
}

async function runExaSearch(
	params: {
		query: string;
		queries?: string[];
		objective?: string;
		exaType?: string;
	},
	signal?: AbortSignal | null,
): Promise<{ groups: ResultGroup[]; exaType: string }> {
	const apiKey = process.env.EXA_API_KEY;
	if (!apiKey) {
		throw new Error(
			"EXA_API_KEY is not set. Set provider to 'parallel' or configure EXA_API_KEY.",
		);
	}

	const exaType = params.exaType ?? "auto";
	const groups: ResultGroup[] = [];

	for (const query of normalizeQueries(params)) {
		const highlights = params.objective
			? {
					query: params.objective,
					highlightsPerUrl: 3,
					numSentences: 3,
				}
			: true;
		const body: Record<string, unknown> = {
			query,
			type: exaType,
			contents: { highlights },
		};

		const response = await fetch(`${EXA_API_BASE}/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: signal ?? undefined,
		});

		if (!response.ok) {
			throw new Error(
				`Exa Search API error (${response.status}): ${await getApiError(response)}`,
			);
		}

		const data = (await response.json()) as {
			results: Array<{
				url: string;
				title?: string | null;
				publishedDate?: string | null;
				highlights?: string[];
				summary?: string | null;
				text?: string | null;
			}>;
		};

		groups.push({
			query,
			results: data.results.map((result) => ({
				url: result.url,
				title: result.title,
				publishDate: result.publishedDate,
				excerpts:
					result.highlights && result.highlights.length > 0
						? result.highlights
						: [result.summary ?? result.text ?? ""].filter(Boolean),
			})),
		});
	}

	return { groups, exaType };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web using Parallel (https://parallel.ai) or Exa (https://exa.ai). Returns relevant excerpts from web pages. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Requires PARALLEL_API_KEY or EXA_API_KEY to be set in the environment.`,
		promptSnippet:
			"Search the web for current information, facts, or references using Parallel or Exa",
		promptGuidelines: [
			"Use web_search when you need current or factual information not in your training data.",
			"Provide 1-3 concise search queries (3-6 words each) for best results.",
			"Set web_search provider to 'exa' when the user asks for Exa or only EXA_API_KEY is available.",
			"Include an objective when the search goal needs additional context.",
		],
		parameters: SearchParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const provider = selectProvider(params.provider as SearchProvider | undefined);
			let groups: ResultGroup[];
			let mode: string | undefined;
			let exaType: string | undefined;

			if (provider === "parallel") {
				const result = await runParallelSearch(params, signal);
				groups = result.groups;
				mode = result.mode;
			} else {
				const result = await runExaSearch(params, signal);
				groups = result.groups;
				exaType = result.exaType;
			}

			const formatted = formatResults(groups);
			const truncation = truncateHead(formatted, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const warnings = groups.flatMap((group) => group.warnings ?? []);

			const details: SearchDetails = {
				provider,
				query: params.query,
				queries: params.queries,
				objective: params.objective,
				mode,
				exaType,
				resultCount: groups.reduce((count, group) => count + group.results.length, 0),
				requestCount: groups.length,
				warnings: warnings.length > 0 ? warnings : undefined,
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
			if (args.provider) {
				text += theme.fg("muted", ` [${args.provider}]`);
			}
			if (args.mode) {
				text += theme.fg("muted", ` [${args.mode}]`);
			}
			if (args.exaType) {
				text += theme.fg("muted", ` [${args.exaType}]`);
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
				`${details.provider}: ${details.resultCount} result${details.resultCount === 1 ? "" : "s"}`,
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
