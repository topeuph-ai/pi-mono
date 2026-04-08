/**
 * ValiChord Extension for pi
 *
 * Provides a `valichord_validate` tool for submitting research deposits to the
 * ValiChord reproducibility verification API, plus a `/valichord` command that
 * loads the full workflow prompt.
 *
 * Configuration (environment variables):
 *   VALICHORD_BASE_URL  — API base URL (default: http://localhost:5000)
 *   VALICHORD_API_KEY   — API key, passed as X-ValiChord-Key header (optional)
 *
 * Two modes, depending on whether validator_outcome is supplied:
 *
 *   Validator (outcome supplied):
 *     Calls POST /attest — synchronous, returns HarmonyRecord directly (~60 s).
 *     Use when you have actually executed the research code.
 *
 *   Researcher (no outcome):
 *     Calls POST /validate + polls GET /result/<job_id> every 10 s.
 *     Runs structural analysis; returns HarmonyRecord with validator_attested: false.
 *
 * See examples/skills/valichord/SKILL.md for the full workflow prompt.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseUrl(): string {
	return (process.env["VALICHORD_BASE_URL"] ?? "http://localhost:5000").replace(/\/$/, "");
}

function apiHeaders(): Record<string, string> {
	const key = process.env["VALICHORD_API_KEY"];
	return key ? { "X-ValiChord-Key": key } : {};
}

async function pollResult(
	jobId: string,
	signal: AbortSignal | undefined,
	onUpdate: ((p: { content: [{ type: "text"; text: string }]; details: Record<string, unknown> }) => void) | undefined,
): Promise<Record<string, unknown>> {
	const maxAttempts = 150; // 150 × 10 s = 25 min
	for (let i = 0; i < maxAttempts; i++) {
		await new Promise((resolve) => setTimeout(resolve, 10_000));
		if (signal?.aborted) throw new Error("Cancelled by user");

		const res = await fetch(`${baseUrl()}/result/${jobId}`, {
			headers: apiHeaders(),
			signal,
		});
		if (!res.ok) throw new Error(`GET /result/${jobId} returned ${res.status}`);

		const data = (await res.json()) as Record<string, unknown>;
		if (data["status"] === "done") return data;
		if (data["status"] === "error") throw new Error((data["error"] as string) ?? "Unknown ValiChord error");

		const elapsedMin = Math.round(((i + 1) * 10) / 60);
		const elapsedSuffix = elapsedMin >= 1 ? ` (${elapsedMin} min)` : ` (${(i + 1) * 10}s)`;
		onUpdate?.({
			content: [{ type: "text", text: `Structural analysis in progress${elapsedSuffix}…` }],
			details: { job_id: jobId, elapsed_s: (i + 1) * 10 },
		});
	}
	throw new Error("Timed out waiting for ValiChord results after 25 minutes");
}

// ── Extension factory ─────────────────────────────────────────────────────────

export default function valichordExtension(pi: ExtensionAPI): void {
	// ── valichord_validate tool ──────────────────────────────────────────────
	pi.registerTool({
		name: "valichord_validate",
		label: "ValiChord",
		description:
			"Submit a research deposit ZIP to ValiChord for reproducibility verification. " +
			"Returns a HarmonyRecord — a cryptographically tamper-evident record of the " +
			"reproducibility verdict written to a peer-to-peer distributed network. " +
			"\n\n" +
			"VALIDATOR MODE (validator_outcome supplied): " +
			"Call this after you have actually executed the research code. " +
			"Uses POST /attest — fast path (~60 s), synchronous, no polling needed. " +
			"The HarmonyRecord will carry validator_attested: true — a real replication verdict. " +
			"\n\n" +
			"RESEARCHER MODE (validator_outcome omitted): " +
			"Call this to submit your own deposit for others to verify. " +
			"Uses POST /validate — runs structural analysis (~5–20 min). " +
			"The HarmonyRecord carries validator_attested: false (provisional until a validator runs the code).",

		promptSnippet: "Submit research deposit ZIPs to ValiChord for reproducibility verification and HarmonyRecord generation",

		promptGuidelines: [
			"VALIDATOR: Supply validator_outcome and validator_notes only after you have actually executed the research code.",
			"RESEARCHER: Omit validator_outcome — submit your own deposit for structural assessment.",
			"deposit_path must be an absolute path or a path relative to the working directory.",
			"Validator mode returns immediately (~60 s). Researcher mode takes 5–20 min for structural analysis.",
		],

		parameters: Type.Object({
			deposit_path: Type.String({
				description: "Path to the research deposit ZIP file (absolute or relative to cwd)",
			}),
			validator_outcome: Type.Optional(
				StringEnum(["Reproduced", "PartiallyReproduced", "FailedToReproduce"] as const, {
					description:
						"Your replication verdict — only supply when you have actually executed the research code. " +
						"Reproduced: code ran and outputs match within reasonable tolerance. " +
						"PartiallyReproduced: code ran but outputs differ in specific ways. " +
						"FailedToReproduce: code failed to run or outputs were fundamentally different.",
				}),
			),
			validator_notes: Type.Optional(
				Type.String({
					description:
						"Concise replication notes (max 2000 characters): what ran, what failed, exact error messages, " +
						"environment used (OS, language version, key package versions), and why you chose your verdict.",
					maxLength: 2000,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Resolve deposit path
			const depositPath = path.isAbsolute(params.deposit_path)
				? params.deposit_path
				: path.resolve(ctx.cwd, params.deposit_path);

			onUpdate?.({
				content: [{ type: "text", text: `Reading deposit: ${path.basename(depositPath)}` }],
				details: { deposit_path: depositPath },
			});

			let fileBuffer: Buffer;
			try {
				fileBuffer = await fs.readFile(depositPath);
			} catch (err) {
				throw new Error(`Cannot read deposit file at "${depositPath}": ${(err as Error).message}`);
			}

			const filename = path.basename(depositPath);
			const sizeMb = (fileBuffer.byteLength / 1024 / 1024).toFixed(1);

			// Check health first — fast fail with a clear message
			try {
				const health = await fetch(`${baseUrl()}/health`, {
					headers: apiHeaders(),
					signal,
				});
				if (!health.ok) throw new Error(`/health returned ${health.status}`);
				const healthData = (await health.json()) as { status?: string; conductor?: string };
				if (healthData.conductor === "offline") {
					onUpdate?.({
						content: [{ type: "text", text: "Holochain conductor is offline — analysis will complete but harmony_record_hash will be null." }],
						details: { conductor: "offline" },
					});
				}
			} catch (err) {
				if ((err as Error).name === "AbortError") throw err;
				throw new Error(
					`ValiChord API unreachable at ${baseUrl()}. ` +
					`Check that the server is running and VALICHORD_BASE_URL is set correctly. ` +
					`Error: ${(err as Error).message}`,
				);
			}

			// ── VALIDATOR MODE: POST /attest (synchronous, ~60 s) ────────────────
			if (params.validator_outcome) {
				onUpdate?.({
					content: [{ type: "text", text: `Uploading ${filename} (${sizeMb} MB) as validator attestation…` }],
					details: { filename, size_mb: Number(sizeMb), mode: "validator" },
				});

				const formData = new FormData();
				formData.append("file", new Blob([fileBuffer]), filename);
				formData.append("outcome", params.validator_outcome);
				if (params.validator_notes) {
					formData.append("notes", params.validator_notes.slice(0, 2000));
				}

				onUpdate?.({
					content: [{ type: "text", text: "Running Holochain commit-reveal protocol… (this takes ~60 s)" }],
					details: {},
				});

				const attestRes = await fetch(`${baseUrl()}/attest`, {
					method: "POST",
					body: formData,
					headers: apiHeaders(),
					signal,
				});

				if (!attestRes.ok) {
					const body = await attestRes.text().catch(() => "");
					throw new Error(`POST /attest failed (${attestRes.status}): ${body}`);
				}

				const data = (await attestRes.json()) as {
					data_hash?: string;
					outcome?: string;
					validator_attested?: boolean;
					harmony_record_hash?: string | null;
					harmony_record_url?: string | null;
				};

				const lines: string[] = [];
				lines.push("## ValiChord Validator Attestation Complete");
				lines.push("");
				lines.push(`**Outcome:** ${data.outcome ?? "unknown"}`);
				lines.push(`**Validator attested:** yes — this is a real replication verdict`);
				lines.push(`**Deposit SHA-256:** \`${data.data_hash ?? "unknown"}\``);
				lines.push("");

				if (data.harmony_record_hash) {
					lines.push(`**Harmony Record hash:** \`${data.harmony_record_hash}\``);
				} else {
					lines.push("**Harmony Record hash:** null (conductor offline — record not written to DHT)");
				}
				if (data.harmony_record_url) {
					lines.push(`**Harmony Record URL:** ${data.harmony_record_url}`);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: data as Record<string, unknown>,
				};
			}

			// ── RESEARCHER MODE: POST /validate + poll ────────────────────────────
			onUpdate?.({
				content: [{ type: "text", text: `Uploading ${filename} (${sizeMb} MB) for structural analysis…` }],
				details: { filename, size_mb: Number(sizeMb), mode: "researcher" },
			});

			const formData = new FormData();
			formData.append("file", new Blob([fileBuffer]), filename);

			const submitRes = await fetch(`${baseUrl()}/validate`, {
				method: "POST",
				body: formData,
				headers: apiHeaders(),
				signal,
			});

			if (!submitRes.ok) {
				const body = await submitRes.text().catch(() => "");
				throw new Error(`POST /validate failed (${submitRes.status}): ${body}`);
			}

			const submitData = (await submitRes.json()) as { job_id?: string; error?: string };
			if (!submitData.job_id) {
				throw new Error(`ValiChord did not return a job_id: ${JSON.stringify(submitData)}`);
			}

			const jobId = submitData.job_id;
			onUpdate?.({
				content: [{ type: "text", text: `Upload complete. Structural analysis running (job ${jobId})…` }],
				details: { job_id: jobId },
			});

			const result = await pollResult(jobId, signal, onUpdate);

			// Format result for the model
			const harmony = result["harmony_record_draft"] as Record<string, unknown> | undefined;
			const topFindings = (result["top_findings"] as unknown[]) ?? [];

			const lines: string[] = [];
			lines.push("## ValiChord Analysis Complete");
			lines.push("");

			if (harmony) {
				const outcome = harmony["outcome"] as { type?: string; content?: { details?: string } } | undefined;
				const attested = harmony["validator_attested"] as boolean | undefined;
				const hash = harmony["harmony_record_hash"] as string | null | undefined;
				const url = harmony["harmony_record_url"] as string | null | undefined;
				const summary = harmony["findings_summary"] as Record<string, number> | undefined;

				lines.push(`**Outcome:** ${outcome?.type ?? "unknown"} (provisional — no validator has run the code yet)`);
				lines.push(`**Validator attested:** ${attested ? "yes" : "no — this verdict is derived from deposit structure"}`);
				if (outcome?.content?.details) {
					lines.push(`**Details:** ${outcome.content.details}`);
				}
				lines.push("");

				if (summary) {
					lines.push(
						`**Findings:** ${summary["critical"] ?? 0} critical · ` +
						`${summary["significant"] ?? 0} significant · ` +
						`${summary["low_confidence"] ?? 0} low confidence ` +
						`(total: ${summary["total"] ?? 0})`,
					);
					lines.push("");
				}

				if (hash) {
					lines.push(`**Harmony Record hash:** \`${hash}\``);
				} else {
					lines.push("**Harmony Record hash:** null (conductor offline — record not written to DHT)");
				}
				if (url) {
					lines.push(`**Harmony Record URL:** ${url}`);
				}
			}

			if (topFindings.length > 0) {
				lines.push("");
				lines.push("**Top findings:**");
				for (const f of topFindings as Array<{ severity?: string; title?: string }>) {
					lines.push(`- [${f.severity ?? "?"}] ${f.title ?? "(untitled)"}`);
				}
			}

			const downloadUrl = result["download_url"] as string | undefined;
			if (downloadUrl) {
				lines.push("");
				lines.push(`**Full cleaning report:** \`GET ${baseUrl()}${downloadUrl}\``);
			}

			const prs = result["prs"] as number | undefined;
			if (prs !== undefined) {
				lines.push(`**PRS (Preliminary Reproducibility Score):** ${(prs * 100).toFixed(0)}%`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: result,
			};
		},
	});

	// ── valichord_health tool ────────────────────────────────────────────────
	pi.registerTool({
		name: "valichord_health",
		label: "ValiChord Health",
		description:
			"Check whether the ValiChord API is reachable and whether the Holochain conductor " +
			"is live. Use before attempting a submission to surface problems early.",

		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
			try {
				const res = await fetch(`${baseUrl()}/health`, {
					headers: apiHeaders(),
					signal,
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as { status?: string; conductor?: string; version?: string };
				const conductor = data.conductor === "live" ? "live ✓" : "offline (harmony_record_hash will be null)";
				const text =
					`ValiChord API: ${data.status ?? "ok"} (v${data.version ?? "?"})  |  ` +
					`Conductor: ${conductor}  |  ` +
					`Endpoint: ${baseUrl()}`;
				return { content: [{ type: "text", text }], details: data };
			} catch (err) {
				throw new Error(
					`ValiChord API unreachable at ${baseUrl()}. ` +
					`Set VALICHORD_BASE_URL to the correct endpoint. ` +
					`Error: ${(err as Error).message}`,
				);
			}
		},
	});

	// ── /valichord command ────────────────────────────────────────────────────
	pi.registerCommand("valichord", {
		description:
			"Start a ValiChord validation session. Loads the full workflow: " +
			"determine role (researcher or validator), optionally run the code, " +
			"submit to ValiChord, and present the HarmonyRecord.",
		handler: async (_args, ctx) => {
			const apiEndpoint = baseUrl();
			const hasKey = !!process.env["VALICHORD_API_KEY"];

			pi.sendUserMessage(
				`/skill:valichord\n\n` +
				`[Context: ValiChord API is at ${apiEndpoint}. ` +
				`API key: ${hasKey ? "configured (VALICHORD_API_KEY set)" : "not set (open mode)"}. ` +
				`The valichord_validate tool is available for programmatic submission.]`,
			);

			ctx.ui.notify("ValiChord workflow loaded. Tell pi your role (researcher or validator) and provide the deposit.", "info");
		},
	});
}
