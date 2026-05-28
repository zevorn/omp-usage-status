import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Model, UsageLimit, UsageReport } from "../src/omp-types";
import { UsageStatusController, installPiStatusLinePatch, resetPiStatusLinePatchForTest } from "../src/index";
import {
	DEFAULT_CONFIG,
	STATUS_KEY,
	getUsageFraction,
	renderUsageForModel,
	selectUsageForModel,
	type UsageStatusConfig,
} from "../src/usage-status";
function expect<T>(actual: T) {
	return {
		toBe(expected: unknown): void {
			assert.equal(actual, expected);
		},
		toBeUndefined(): void {
			assert.equal(actual, undefined);
		},
		toContain(expected: string): void {
			assert.equal(typeof actual, "string");
			assert.match(actual as string, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		},
		toBeLessThanOrEqual(expected: number): void {
			assert.equal(typeof actual, "number");
			assert.ok((actual as number) <= expected);
		},
		not: {
			toContain(expected: string): void {
				assert.equal(typeof actual, "string");
				assert.doesNotMatch(actual as string, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			},
		},
	};
}
function stripAnsi(text: string): string {
	return text.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[()][A-Za-z0-9]|[=>])/g, "");
}


function model(provider: string, id: string, name = id): Model {
	return {
		id,
		name,
		provider,
		api: "openai-responses",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

function limit(args: {
	id: string;
	provider: string;
	fraction?: number;
	windowId?: string;
	durationMs?: number;
	resetsAt?: number;
	status?: UsageLimit["status"];
	modelId?: string;
	tier?: string;
	shared?: boolean;
}): UsageLimit {
	return {
		id: args.id,
		label: args.id,
		scope: {
			provider: args.provider,
			windowId: args.windowId,
			modelId: args.modelId,
			tier: args.tier,
			shared: args.shared,
		},
		window: {
			id: args.windowId ?? args.id,
			label: args.windowId ?? args.id,
			durationMs: args.durationMs,
			resetsAt: args.resetsAt,
		},
		amount: args.fraction === undefined ? { unit: "percent" } : { unit: "percent", usedFraction: args.fraction },
		status: args.status,
	};
}

function report(provider: string, limits: UsageLimit[], fetchedAt = Date.now()): UsageReport {
	return { provider, fetchedAt, limits };
}


const STATUS_LINE_TEST_PADDING = " ".repeat(20);

function installFakeStatusLine(): { new(): { getTopBorder(width: number): { content: string; width: number } } } {
	class FakeStatusLine {
		getTopBorder(_width: number): { content: string; width: number } {
			const content = `π > model ▶${STATUS_LINE_TEST_PADDING}`;
			return { content, width: content.length };
		}
	}
	resetPiStatusLinePatchForTest();
	const installed = installPiStatusLinePatch({ pi: { StatusLineComponent: FakeStatusLine } } as never);
	expect(installed).toBe(true);
	return FakeStatusLine;
}

function installFakeStatusLineAndEditor(): {
	StatusLine: { new(): { getTopBorder(width: number): { content: string; width: number } } };
	Editor: { new(): { topBorder: { content: string; width: number } | undefined; setTopBorder(content: { content: string; width: number } | undefined): void } };
} {
	class FakeStatusLine {
		getTopBorder(_width: number): { content: string; width: number } {
			const content = `π > model ▶${STATUS_LINE_TEST_PADDING}`;
			return { content, width: content.length };
		}
	}
	class FakeEditor {
		topBorder: { content: string; width: number } | undefined;

		setTopBorder(content: { content: string; width: number } | undefined): void {
			this.topBorder = content;
		}
	}
	resetPiStatusLinePatchForTest();
	const installed = installPiStatusLinePatch({ pi: { StatusLineComponent: FakeStatusLine, CustomEditor: FakeEditor } } as never);
	expect(installed).toBe(true);
	return { StatusLine: FakeStatusLine, Editor: FakeEditor };
}

describe("usage selection", () => {
	test("filters to the active Claude provider", () => {
		const active = model("anthropic", "claude-opus-4-6", "Claude Opus");
		const selected = selectUsageForModel(
			[
				report("openai-codex", [limit({ id: "openai-codex:primary", provider: "openai-codex", fraction: 0.9 })]),
				report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })]),
			],
			active,
		);

		expect(selected?.report.provider).toBe("anthropic");
		expect(selected?.primary.id).toBe("anthropic:5h");
		expect(selected?.usedFraction).toBe(0.42);
	});

	test("selects Codex primary and keeps exhausted weekly limit visible", () => {
		const active = model("openai-codex", "gpt-5.3-codex");
		const primary = limit({ id: "openai-codex:primary", provider: "openai-codex", fraction: 0.18, windowId: "5h" });
		const secondary = limit({
			id: "openai-codex:secondary",
			provider: "openai-codex",
			fraction: 1,
			windowId: "7d",
			status: "exhausted",
		});
		const selected = selectUsageForModel([report("openai-codex", [primary, secondary])], active);

		expect(selected?.primary.id).toBe("openai-codex:primary");
		expect(selected?.secondary?.id).toBe("openai-codex:secondary");
		expect(selected?.severity).toBe("critical");
	});

	test("Gemini prefers exact model bucket before tier fallback", () => {
		const active = model("google-gemini-cli", "gemini-2.5-pro", "Gemini 2.5 Pro");
		const flash = limit({
			id: "gemini-flash",
			provider: "google-gemini-cli",
			fraction: 0.95,
			modelId: "gemini-2.5-flash",
			tier: "Flash",
		});
		const exact = limit({
			id: "gemini-pro",
			provider: "google-gemini-cli",
			fraction: 0.63,
			modelId: "gemini-2.5-pro",
			tier: "Pro",
		});
		const selected = selectUsageForModel([report("google-gemini-cli", [flash, exact])], active);

		expect(selected?.primary.id).toBe("gemini-pro");
		expect(selected?.modelTier).toBe("pro");
	});

	test("Gemini falls back to matching tier", () => {
		const active = model("google-gemini-cli", "gemini-3-pro-preview", "Gemini 3 Pro Preview");
		const flash = limit({ id: "flash", provider: "google-gemini-cli", fraction: 0.2, tier: "Flash" });
		const pro = limit({ id: "pro", provider: "google-gemini-cli", fraction: 0.7, tier: "Pro" });
		const selected = selectUsageForModel([report("google-gemini-cli", [flash, pro])], active);

		expect(selected?.primary.id).toBe("pro");
	});

	test("hides missing, unsupported, or nonnumeric usage", () => {
		const active = model("anthropic", "claude-sonnet-4-5");
		expect(selectUsageForModel([], active)).toBeUndefined();
		expect(selectUsageForModel([report("openai-codex", [])], active)).toBeUndefined();
		expect(selectUsageForModel([report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic" })])], active)).toBeUndefined();
	});
	test("hides ambiguous same-provider reports instead of guessing an account", () => {
		const active = model("anthropic", "claude-sonnet-4-5");
		const selected = selectUsageForModel(
			[
				report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.2, windowId: "5h" })], 1),
				report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.7, windowId: "5h" })], 2),
			],
			active,
		);

		expect(selected).toBeUndefined();
	});

	test("can derive numeric usage from safe normalized amount fields", () => {
		const derived = {
			...limit({ id: "remaining", provider: "future" }),
			amount: { unit: "percent" as const, remainingFraction: 0.25 },
		};
		expect(getUsageFraction(derived)).toBe(0.75);
	});
});

describe("rendering", () => {
	test("renders a Pi status segment with icon, 5h, and weekly limits", () => {
		const now = 1_700_000_000_000;
		const originalNow = Date.now;
		Date.now = () => now;
		try {
			const rendered = renderUsageForModel(
				[
					report("openai-codex", [
						limit({
							id: "openai-codex:primary",
							provider: "openai-codex",
							fraction: 0.05,
							windowId: "5h",
							resetsAt: now + 176 * 60_000,
						}),
						limit({
							id: "openai-codex:secondary",
							provider: "openai-codex",
							fraction: 0.06,
							windowId: "7d",
							resetsAt: now + (4 * 24 + 2) * 60 * 60_000,
						}),
					]),
				],
				model("openai-codex", "gpt-5.3-codex"),
				DEFAULT_CONFIG,
				48,
			);

			expect(rendered?.text).toBe("🪙 5h 5% (↻ 2h56m) / W 6% (↻ 4d2h)");
		} finally {
			Date.now = originalNow;
		}
	});

	test("degrades output when width shrinks", () => {
		const reports = [
			report("openai-codex", [
				limit({ id: "openai-codex:primary", provider: "openai-codex", fraction: 0.18, windowId: "5h", resetsAt: Date.now() + 2 * 60 * 60_000 }),
			]),
		];
		const active = model("openai-codex", "gpt-5.3-codex");
		const medium = renderUsageForModel(reports, active, DEFAULT_CONFIG, 14);
		const minimal = renderUsageForModel(reports, active, DEFAULT_CONFIG, 3);
		const hidden = renderUsageForModel(reports, active, DEFAULT_CONFIG, 2);

		expect(medium?.text.length).toBeLessThanOrEqual(14);
		expect(minimal?.text).toBe("18%");
		expect(hidden).toBeUndefined();
	});

	test("never renders private identity metadata", () => {
		const rendered = renderUsageForModel(
			[
				{
					...report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })]),
					metadata: {
						email: "person@example.test",
						accountId: "acct-secret",
						orgId: "org-secret",
						projectId: "project-secret",
					},
				},
			],
			model("anthropic", "claude-sonnet-4-5"),
		);

		expect(rendered?.text).not.toContain("person@example.test");
		expect(rendered?.text).not.toContain("acct-secret");
		expect(rendered?.text).not.toContain("org-secret");
		expect(rendered?.text).not.toContain("project-secret");
	});

	test("uses warning and critical thresholds", () => {
		const cfg: UsageStatusConfig = { ...DEFAULT_CONFIG, warningThreshold: 0.5, criticalThreshold: 0.9 };
		const warning = renderUsageForModel(
			[report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.6, windowId: "5h" })])],
			model("anthropic", "claude-sonnet-4-5"),
			cfg,
		);
		const critical = renderUsageForModel(
			[report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.95, windowId: "5h" })])],
			model("anthropic", "claude-sonnet-4-5"),
			cfg,
		);

		expect(warning?.severity).toBe("warning");
		expect(critical?.severity).toBe("critical");
	});
});

describe("extension refresh controller", () => {
	test("coalesces concurrent refresh events and updates status without throwing", async () => {
		let fetchCount = 0;
		let releaseFetch: (() => void) | undefined;
		const fetchGate = new Promise<void>(resolve => {
			releaseFetch = resolve;
		});
		const statuses = new Map<string, string | undefined>();
		const bgAnsi = "\x1b[48;2;1;2;3m";
		const spendAnsi = "\x1b[38;2;4;5;6m";
		const sepAnsi = "\x1b[38;2;7;8;9m";
		const StatusLine = installFakeStatusLine();
		const active = model("anthropic", "claude-sonnet-4-5");
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			model: active,
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						fetchCount += 1;
						await fetchGate;
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })])];
					},
				},
			},
			ui: {
				setStatus(key: string, text: string | undefined) {
					statuses.set(key, text);
				},
				theme: {
					fg(_token: string, text: string) {
						return text;
					},
					getBgAnsi(token: string) {
						assert.equal(token, "statusLineBg");
						return bgAnsi;
					},
					getFgAnsi(token: string) {
						if (token === "statusLineSpend") return spendAnsi;
						if (token === "statusLineSep") return sepAnsi;
						throw new Error(`unexpected token ${token}`);
					},
				},
			},
		} as never;

		const controller = new UsageStatusController();
		controller.schedule(ctx, "one");
		controller.schedule(ctx, "two");
		expect(fetchCount).toBe(1);
		releaseFetch?.();
		await controller.flush();
		await controller.flush();

		expect(fetchCount).toBe(2);
		expect(statuses.get(STATUS_KEY)).toBe("");
		const border = new StatusLine().getTopBorder(80);
		expect(stripAnsi(border.content)).toBe(`π > model ▶ 🪙 5h 42%${" ".repeat(10)}`);
		expect(border.content).not.toContain(bgAnsi);
		expect(border.content).toContain(`${sepAnsi} \x1b[0m`);
		expect(border.content).toContain(`${spendAnsi}🪙 5h 42%\x1b[0m`);
		expect(border.width).toBe(`π > model ▶${STATUS_LINE_TEST_PADDING}`.length);
		controller.dispose(ctx);
		expect(statuses.get(STATUS_KEY)).toBe("");
		expect(new StatusLine().getTopBorder(80).content).not.toContain("42%");
		resetPiStatusLinePatchForTest();
	});

	test("retries startup refresh until the active model is available", async () => {
		let fetchCount = 0;
		const StatusLine = installFakeStatusLine();
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			model: undefined as Model | undefined,
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						fetchCount += 1;
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })])];
					},
				},
			},
			ui: {
				setStatus() {},
				theme: { fg: (_token: string, text: string) => text },
			},
		};
		const controller = new UsageStatusController();

		await controller.start(ctx as never);
		await controller.flush();
		expect(fetchCount).toBe(0);
		expect(stripAnsi(new StatusLine().getTopBorder(80).content)).toBe(`π > model ▶${STATUS_LINE_TEST_PADDING}`);

		ctx.model = model("anthropic", "claude-sonnet-4-5");
		await new Promise(resolve => setTimeout(resolve, 300));
		await controller.flush();
		expect(fetchCount).toBe(1);
		expect(stripAnsi(new StatusLine().getTopBorder(80).content)).toBe(`π > model ▶ 🪙 5h 42%${" ".repeat(10)}`);
		controller.dispose(ctx as never);
		resetPiStatusLinePatchForTest();
	});
	test("start waits for the initial usage refresh before returning", async () => {
		let releaseFetch: (() => void) | undefined;
		let markFetchStarted: (() => void) | undefined;
		const fetchStarted = new Promise<void>(resolve => {
			markFetchStarted = resolve;
		});
		const fetchGate = new Promise<void>(resolve => {
			releaseFetch = resolve;
		});
		const statuses: Array<[string, string | undefined]> = [];
		const StatusLine = installFakeStatusLine();
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			model: model("anthropic", "claude-sonnet-4-5"),
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						markFetchStarted?.();
						await fetchGate;
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })])];
					},
				},
			},
			ui: {
				setStatus(key: string, text: string | undefined) {
					statuses.push([key, text]);
				},
				theme: { fg: (_token: string, text: string) => text },
			},
		} as never;
		const controller = new UsageStatusController();
		let resolved = false;

		const started = controller.start(ctx).then(() => {
			resolved = true;
		});
		await fetchStarted;
		expect(resolved).toBe(false);
		expect(statuses.length).toBe(0);

		releaseFetch?.();
		await started;

		expect(resolved).toBe(true);
		expect(statuses.length).toBe(1);
		await controller.start(ctx);
		expect(statuses.length).toBe(2);
		expect(stripAnsi(new StatusLine().getTopBorder(80).content)).toBe(`π > model ▶ 🪙 5h 42%${" ".repeat(10)}`);
		controller.dispose(ctx);
		resetPiStatusLinePatchForTest();
	});

	test("shutdown ignores in-flight refreshes without forcing a final render", async () => {
		let fetchCount = 0;
		let releaseFetch: (() => void) | undefined;
		const fetchGate = new Promise<void>(resolve => {
			releaseFetch = resolve;
		});
		const statuses: Array<[string, string | undefined]> = [];
		const StatusLine = installFakeStatusLine();
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			model: model("anthropic", "claude-sonnet-4-5"),
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						fetchCount += 1;
						await fetchGate;
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })])];
					},
				},
			},
			ui: {
				setStatus(key: string, text: string | undefined) {
					statuses.push([key, text]);
				},
				theme: { fg: (_token: string, text: string) => text },
			},
		} as never;
		const controller = new UsageStatusController();

		controller.schedule(ctx, "slow-refresh");
		expect(fetchCount).toBe(1);
		controller.dispose(ctx, { render: false });
		releaseFetch?.();
		await Promise.resolve();

		expect(statuses.length).toBe(0);
		expect(stripAnsi(new StatusLine().getTopBorder(80).content)).toBe(`π > model ▶${STATUS_LINE_TEST_PADDING}`);
		resetPiStatusLinePatchForTest();
	});

	test("session switch ignores stale in-flight refreshes from the previous generation", async () => {
		let releaseOldFetch: (() => void) | undefined;
		const oldFetchGate = new Promise<void>(resolve => {
			releaseOldFetch = resolve;
		});
		let setStatusCount = 0;
		const StatusLine = installFakeStatusLine();
		const ui = {
			setStatus() {
				setStatusCount += 1;
			},
			theme: { fg: (_token: string, text: string) => text },
		};
		const oldCtx = {
			hasUI: true,
			cwd: process.cwd(),
			model: model("anthropic", "claude-sonnet-4-5"),
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						await oldFetchGate;
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.21, windowId: "5h" })])];
					},
				},
			},
			ui,
		} as never;
		const newCtx = {
			hasUI: true,
			cwd: process.cwd(),
			model: model("anthropic", "claude-sonnet-4-5"),
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })])];
					},
				},
			},
			ui,
		} as never;
		const controller = new UsageStatusController();

		controller.schedule(oldCtx, "old-refresh");
		controller.dispose(oldCtx, { render: false });
		await controller.start(newCtx);
		releaseOldFetch?.();
		await Promise.resolve();
		await controller.flush();

		expect(setStatusCount).toBe(1);
		expect(stripAnsi(new StatusLine().getTopBorder(80).content)).toBe(`π > model ▶ 🪙 5h 42%${" ".repeat(10)}`);
		controller.dispose(newCtx, { render: false });
		resetPiStatusLinePatchForTest();
	});


	test("appends usage with no right side and hides when right-side padding is insufficient", async () => {
		let fraction = 0.41;
		let baseContent = "π > model ▶";
		class InteractiveStatusLine {
			getTopBorder(_width: number): { content: string; width: number } {
				return { content: baseContent, width: baseContent.length };
			}
		}
		resetPiStatusLinePatchForTest();
		const installed = installPiStatusLinePatch({ pi: { StatusLineComponent: InteractiveStatusLine } } as never);
		expect(installed).toBe(true);
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			model: model("anthropic", "claude-sonnet-4-5"),
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction, windowId: "5h" })])];
					},
				},
			},
			ui: {
				setStatus() {},
				theme: { fg: (_token: string, text: string) => text },
			},
		} as never;
		const controller = new UsageStatusController();

		controller.schedule(ctx, "initial");
		await controller.flush();
		expect(stripAnsi(new InteractiveStatusLine().getTopBorder(80).content)).toBe("π > model ▶ 🪙 5h 41% ");


		baseContent = "π > model ▶── right";
		fraction = 0.42;
		controller.schedule(ctx, "tight-right-side");
		await controller.flush();
		expect(stripAnsi(new InteractiveStatusLine().getTopBorder(80).content)).toBe("π > model ▶── right");

		fraction = 0.42;
		baseContent = `π > model ▶${" ".repeat(20)}`;
		controller.schedule(ctx, "padded-marker");
		await controller.flush();
		expect(stripAnsi(new InteractiveStatusLine().getTopBorder(80).content)).toBe(`π > model ▶ 🪙 5h 42%${" ".repeat(10)}`);

		controller.dispose(ctx);
		resetPiStatusLinePatchForTest();
	});

	test("overlays usage after the play marker without moving the rendered right side", async () => {
		const baseContent = `π > model ${"─".repeat(20)} ctx ▶`;
		class FullStatusLine {
			getTopBorder(_width: number): { content: string; width: number } {
				return { content: baseContent, width: baseContent.length };
			}
		}
		resetPiStatusLinePatchForTest();
		const installed = installPiStatusLinePatch({ pi: { StatusLineComponent: FullStatusLine } } as never);
		expect(installed).toBe(true);
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			model: model("anthropic", "claude-sonnet-4-5"),
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })])];
					},
				},
			},
			ui: {
				setStatus() {},
				theme: { fg: (_token: string, text: string) => text },
			},
		} as never;
		const controller = new UsageStatusController();

		controller.schedule(ctx, "initial");
		await controller.flush();
		const border = new FullStatusLine().getTopBorder(baseContent.length);

		const wideBorder = new FullStatusLine().getTopBorder(80);
		expect(stripAnsi(wideBorder.content)).toBe(`${baseContent} 🪙 5h 42% `);

		expect(stripAnsi(border.content)).toBe(`${baseContent} 🪙 5h 42% `);
		expect(border.width).toBe(`${baseContent} 🪙 5h 42% `.length);

		const asciiDashContent = `π > model ${"-".repeat(20)} ctx ▶`;
		class AsciiDashStatusLine {
			getTopBorder(_width: number): { content: string; width: number } {
				return { content: asciiDashContent, width: asciiDashContent.length };
			}
		}
		resetPiStatusLinePatchForTest();
		const asciiDashInstalled = installPiStatusLinePatch({ pi: { StatusLineComponent: AsciiDashStatusLine } } as never);
		expect(asciiDashInstalled).toBe(true);
		const asciiDashController = new UsageStatusController();
		asciiDashController.schedule(ctx, "ascii-dash");
		await asciiDashController.flush();
		const asciiDashBorder = new AsciiDashStatusLine().getTopBorder(asciiDashContent.length);
		expect(stripAnsi(asciiDashBorder.content)).toBe(`${asciiDashContent} 🪙 5h 42% `);
		expect(asciiDashBorder.width).toBe(`${asciiDashContent} 🪙 5h 42% `.length);
		asciiDashController.dispose(ctx);

		const afterMarkerDashContent = `π > model ▶ ${"─".repeat(20)} ctx`;
		class AfterMarkerDashStatusLine {
			getTopBorder(_width: number): { content: string; width: number } {
				return { content: afterMarkerDashContent, width: afterMarkerDashContent.length };
			}
		}
		resetPiStatusLinePatchForTest();
		const afterMarkerDashInstalled = installPiStatusLinePatch({ pi: { StatusLineComponent: AfterMarkerDashStatusLine } } as never);
		expect(afterMarkerDashInstalled).toBe(true);
		const afterMarkerDashController = new UsageStatusController();
		afterMarkerDashController.schedule(ctx, "after-marker-dash");
		await afterMarkerDashController.flush();
		const afterMarkerDashBorder = new AfterMarkerDashStatusLine().getTopBorder(afterMarkerDashContent.length);
		expect(stripAnsi(afterMarkerDashBorder.content)).toBe(`π > model ▶ 🪙 5h 42% ${"─".repeat(10)} ctx`);
		expect(afterMarkerDashBorder.width).toBe(afterMarkerDashContent.length);
		afterMarkerDashController.dispose(ctx);

		const summaryBgAnsi = "\x1b[48;2;10;20;30m";
		const summarySpendAnsi = "\x1b[38;2;40;50;60m";
		const summarySepAnsi = "\x1b[38;2;70;80;90m";
		const summaryResetAnsi = "\x1b[0m";
		let summaryContent = `π > model ▶ ${summaryBgAnsi}${"─".repeat(13)} session summary${"─".repeat(13)}${summaryResetAnsi}`;
		let summaryWidth = stripAnsi(summaryContent).length;
		class SummaryStatusLine {
			getTopBorder(_width: number): { content: string; width: number } {
				return { content: summaryContent, width: summaryWidth };
			}
		}
		resetPiStatusLinePatchForTest();
		const summaryInstalled = installPiStatusLinePatch({ pi: { StatusLineComponent: SummaryStatusLine } } as never);
		expect(summaryInstalled).toBe(true);
		const summaryController = new UsageStatusController();
		const summaryCtx = {
			hasUI: true,
			cwd: process.cwd(),
			model: model("anthropic", "claude-sonnet-4-5"),
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })])];
					},
				},
			},
			ui: {
				setStatus() {},
				theme: {
					fg: (_token: string, text: string) => text,
					getBgAnsi(token: string) {
						assert.equal(token, "statusLineBg");
						return summaryBgAnsi;
					},
					getFgAnsi(token: string) {
						if (token === "statusLineSpend") return summarySpendAnsi;
						if (token === "statusLineSep") return summarySepAnsi;
						throw new Error(`unexpected token ${token}`);
					},
				},
			},
		} as never;
		summaryController.schedule(summaryCtx, "session-summary");
		await summaryController.flush();
		const summaryBorder = new SummaryStatusLine().getTopBorder(summaryWidth);
		expect(stripAnsi(summaryBorder.content)).toBe(`π > model ▶ 🪙 5h 42% ${"─".repeat(3)} session summary${"─".repeat(13)}`);
		expect(summaryBorder.content).not.toContain(`${summaryBgAnsi}🪙`);
		expect(summaryBorder.width).toBe(summaryWidth);

		summaryContent = `π > model ▶ ${summaryBgAnsi}${"─".repeat(9)} session summary${"─".repeat(13)}${summaryResetAnsi}`;
		summaryWidth = stripAnsi(summaryContent).length;
		const tightSummaryBorder = new SummaryStatusLine().getTopBorder(summaryWidth);
		expect(stripAnsi(tightSummaryBorder.content)).toBe(`π > model ▶ ${"─".repeat(9)} session summary${"─".repeat(13)}`);
		expect(tightSummaryBorder.content).not.toContain("🪙");
		expect(tightSummaryBorder.width).toBe(summaryWidth);
		summaryController.dispose(summaryCtx);
		controller.dispose(ctx);
		resetPiStatusLinePatchForTest();
	});

	test("real top-border render chain applies usage exactly once", async () => {
		const statuses = new Map<string, string | undefined>();
		const { StatusLine, Editor } = installFakeStatusLineAndEditor();
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			model: model("anthropic", "claude-sonnet-4-5"),
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })])];
					},
				},
			},
			ui: {
				setStatus(key: string, text: string | undefined) {
					statuses.set(key, text);
				},
				theme: { fg: (_token: string, text: string) => text },
			},
		} as never;
		const controller = new UsageStatusController();

		controller.schedule(ctx, "initial");
		await controller.flush();
		const editor = new Editor();
		const border = new StatusLine().getTopBorder(80);
		editor.setTopBorder(border);
		expect(stripAnsi(editor.topBorder?.content ?? "")).toBe(`π > model ▶ 🪙 5h 42%${" ".repeat(10)}`);
		expect(editor.topBorder?.content.match(/🪙/g)?.length).toBe(1);
		expect(editor.topBorder?.width).toBe(`π > model ▶${STATUS_LINE_TEST_PADDING}`.length);

		const bareContent = `π > model ▶${STATUS_LINE_TEST_PADDING}`;
		editor.setTopBorder({ content: bareContent, width: bareContent.length });
		expect(stripAnsi(editor.topBorder?.content ?? "")).toBe(bareContent);
		expect(editor.topBorder?.width).toBe(bareContent.length);

		expect(statuses.get(STATUS_KEY)).toBe("");
		controller.dispose(ctx);
		resetPiStatusLinePatchForTest();
	});

	test("editor fallback overlays only when no status-line component exists", async () => {
		class FallbackEditor {
			topBorder: { content: string; width: number } | undefined;

			setTopBorder(content: { content: string; width: number } | undefined): void {
				this.topBorder = content;
			}
		}
		resetPiStatusLinePatchForTest();
		const installed = installPiStatusLinePatch({ pi: { CustomEditor: FallbackEditor } } as never);
		expect(installed).toBe(true);
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			model: model("anthropic", "claude-sonnet-4-5"),
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })])];
					},
				},
			},
			ui: {
				setStatus() {},
				theme: { fg: (_token: string, text: string) => text },
			},
		} as never;
		const controller = new UsageStatusController();

		controller.schedule(ctx, "initial");
		await controller.flush();
		const editor = new FallbackEditor();
		editor.setTopBorder({ content: "π > model ▶", width: "π > model ▶".length });
		expect(stripAnsi(editor.topBorder?.content ?? "")).toBe("π > model ▶ 🪙 5h 42% ");

		const paddedContent = `π > model ▶${STATUS_LINE_TEST_PADDING}`;
		editor.setTopBorder({ content: paddedContent, width: paddedContent.length });
		expect(stripAnsi(editor.topBorder?.content ?? "")).toBe(`π > model ▶ 🪙 5h 42%${" ".repeat(10)}`);
		expect(editor.topBorder?.width).toBe(paddedContent.length);
		controller.dispose(ctx);
		resetPiStatusLinePatchForTest();
	});

	test("fetch failure preserves the last rendered status", async () => {
		let fail = false;
		const statuses = new Map<string, string | undefined>();
		const StatusLine = installFakeStatusLine();
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			model: model("anthropic", "claude-sonnet-4-5"),
			modelRegistry: {
				authStorage: {
					async fetchUsageReports() {
						if (fail) throw new Error("network down");
						return [report("anthropic", [limit({ id: "anthropic:5h", provider: "anthropic", fraction: 0.42, windowId: "5h" })])];
					},
				},
			},
			ui: {
				setStatus(key: string, text: string | undefined) {
					statuses.set(key, text);
				},
				theme: { fg: (_token: string, text: string) => text },
			},
		} as never;
		const controller = new UsageStatusController();

		controller.schedule(ctx, "initial");
		await controller.flush();
		expect(stripAnsi(new StatusLine().getTopBorder(80).content)).toBe(`π > model ▶ 🪙 5h 42%${" ".repeat(10)}`);

		fail = true;
		controller.schedule(ctx, "failure");
		await controller.flush();

		expect(statuses.get(STATUS_KEY)).toBe("");
		expect(stripAnsi(new StatusLine().getTopBorder(80).content)).toBe(`π > model ▶ 🪙 5h 42%${" ".repeat(10)}`);
		controller.dispose(ctx);
		resetPiStatusLinePatchForTest();
	});
});
