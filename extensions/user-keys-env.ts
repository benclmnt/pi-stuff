/**
 * User Keys Environment Injector
 *
 * Reads ~/.pi/agent/user-keys.json and injects each value into process.env.
 * Keys are available only inside pi's Node.js process — your shell env is untouched.
 *
 * Expected user-keys.json format:
 *   {
 *     "anthropic_api_key": "sk-ant-...",
 *     "openai_api_key": "sk-...",
 *     "parallel_api_key": "pkey_..."
 *   }
 *
 * In models.json, reference them as env vars:
 *   { "apiKey": "ANTHROPIC_API_KEY" }
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CONFIG_PATH = join(process.env.HOME ?? "~", ".pi", "agent", "user-keys.json");

// Placeholder patterns to skip
const PLACEHOLDERS = ["YOUR_", "TODO", "FIXME", "REPLACE", "example", "changeme"];

function isPlaceholder(value: string): boolean {
	const lower = value.toLowerCase();
	return PLACEHOLDERS.some((p) => lower.includes(p.toLowerCase()));
}

async function loadKeys(): Promise<Record<string, string>> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const config = JSON.parse(raw) as Record<string, unknown>;
		const keys: Record<string, string> = {};
		for (const [k, v] of Object.entries(config)) {
			if (typeof v === "string" && v.trim() && !isPlaceholder(v)) {
				keys[k.toUpperCase()] = v.trim();
			}
		}
		return keys;
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return {};
		}
		throw err;
	}
}

export default async function (pi: ExtensionAPI) {
	const keys = await loadKeys();
	const injected: string[] = [];
	const overwritten: string[] = [];

	for (const [envName, value] of Object.entries(keys)) {
		if (process.env[envName]) {
			overwritten.push(envName);
		} else {
			injected.push(envName);
		}
		process.env[envName] = value;
	}

	pi.on("session_start", async (_event, ctx) => {
		const parts: string[] = [];

		if (injected.length > 0) {
			parts.push(`Loaded ${injected.length} key${injected.length === 1 ? "" : "s"} from user-keys.json: ${injected.join(", ")}`);
		}

		if (overwritten.length > 0) {
			parts.push(`Overwritten ${overwritten.length}: ${overwritten.join(", ")}`);
		}

		if (parts.length > 0) {
			ctx.ui.notify(parts.join(" | "), "info");
		}
	});
}
