import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model, UsageLimit, UsageReport } from "./omp-types";

export const PLUGIN_NAME = "@oh-my-pi/omp-usage-status";
export const STATUS_KEY = "omp-usage-status";

export type UsageScopeMode = "current-provider";
export type UsageSeverity = "normal" | "warning" | "critical";

export interface UsageStatusConfig {
	enabled: boolean;
	scope: UsageScopeMode;
	refreshIntervalMs: number;
	showReset: boolean;
	warningThreshold: number;
	criticalThreshold: number;
}

export const DEFAULT_CONFIG: UsageStatusConfig = Object.freeze({
	enabled: true,
	scope: "current-provider",
	refreshIntervalMs: 60_000,
	showReset: true,
	warningThreshold: 0.8,
	criticalThreshold: 0.95,
});

export interface SelectedUsage {
	report: UsageReport;
	primary: UsageLimit;
	secondary?: UsageLimit | undefined;
	usedFraction: number;
	severity: UsageSeverity;
	modelTier?: string | undefined;
}

export interface RenderedUsage {
	text: string;
	severity: UsageSeverity;
}

interface RuntimeConfigFile {
	settings?: Record<string, Record<string, unknown>>;
}

interface ProjectOverridesFile {
	settings?: Record<string, Record<string, unknown>>;
}

const MIN_REFRESH_INTERVAL_MS = 5_000;
const MAX_REFRESH_INTERVAL_MS = 30 * 60_000;
const DEFAULT_RENDER_WIDTH = 32;
const DEFAULT_USAGE_ICON = "🪙";
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
	}
	return fallback;
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(parsed, min), max);
}


function normalizeScope(value: unknown, fallback: UsageScopeMode): UsageScopeMode {
	return value === "current-provider" ? value : fallback;
}

export function normalizeConfig(input?: Record<string, unknown>): UsageStatusConfig {
	if (!input) return { ...DEFAULT_CONFIG };
	const warningThreshold = normalizeNumber(input.warningThreshold, DEFAULT_CONFIG.warningThreshold, 0, 1);
	let criticalThreshold = normalizeNumber(input.criticalThreshold, DEFAULT_CONFIG.criticalThreshold, 0, 1);
	if (criticalThreshold < warningThreshold) criticalThreshold = warningThreshold;
	return {
		enabled: normalizeBoolean(input.enabled, DEFAULT_CONFIG.enabled),
		scope: normalizeScope(input.scope, DEFAULT_CONFIG.scope),
		refreshIntervalMs: normalizeNumber(
			input.refreshIntervalMs,
			DEFAULT_CONFIG.refreshIntervalMs,
			MIN_REFRESH_INTERVAL_MS,
			MAX_REFRESH_INTERVAL_MS,
		),
		showReset: normalizeBoolean(input.showReset, DEFAULT_CONFIG.showReset),
		warningThreshold,
		criticalThreshold,
	};
}

async function readJsonFile(pathname: string): Promise<unknown> {
	try {
		const text = await fs.readFile(pathname, "utf8");
		return JSON.parse(text) as unknown;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		return undefined;
	}
}

function getConfigRootDir(): string {
	return path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".omp");
}

function getEnvConfig(): Record<string, unknown> {
	const env = process.env;
	const result: Record<string, unknown> = {};
	if (env.OMP_USAGE_STATUSBAR_ENABLED !== undefined) result.enabled = env.OMP_USAGE_STATUSBAR_ENABLED;
	if (env.OMP_USAGE_STATUSBAR_REFRESH_INTERVAL_MS !== undefined) {
		result.refreshIntervalMs = env.OMP_USAGE_STATUSBAR_REFRESH_INTERVAL_MS;
	}
	if (env.OMP_USAGE_STATUSBAR_SHOW_RESET !== undefined) result.showReset = env.OMP_USAGE_STATUSBAR_SHOW_RESET;
	if (env.OMP_USAGE_STATUSBAR_WARNING_THRESHOLD !== undefined) {
		result.warningThreshold = env.OMP_USAGE_STATUSBAR_WARNING_THRESHOLD;
	}
	if (env.OMP_USAGE_STATUSBAR_CRITICAL_THRESHOLD !== undefined) {
		result.criticalThreshold = env.OMP_USAGE_STATUSBAR_CRITICAL_THRESHOLD;
	}
	return result;
}

export async function loadUsageStatusConfig(cwd: string, pluginName = PLUGIN_NAME): Promise<UsageStatusConfig> {
	const configRoot = getConfigRootDir();
	const runtimePath = path.join(configRoot, "plugins", "omp-plugins.lock.json");
	const projectOverridePath = path.join(cwd, ".omp", "plugin-overrides.json");

	const runtimeRaw = await readJsonFile(runtimePath);
	const projectRaw = await readJsonFile(projectOverridePath);
	const runtimeSettings = isRecord(runtimeRaw)
		? ((runtimeRaw as RuntimeConfigFile).settings?.[pluginName] ?? {})
		: {};
	const projectSettings = isRecord(projectRaw)
		? ((projectRaw as ProjectOverridesFile).settings?.[pluginName] ?? {})
		: {};

	return normalizeConfig({
		...DEFAULT_CONFIG,
		...runtimeSettings,
		...projectSettings,
		...getEnvConfig(),
	});
}

export function getUsageFraction(limit: UsageLimit): number | undefined {
	const amount = limit.amount;
	if (typeof amount.usedFraction === "number" && Number.isFinite(amount.usedFraction)) {
		return Math.min(Math.max(amount.usedFraction, 0), 1);
	}
	if (typeof amount.remainingFraction === "number" && Number.isFinite(amount.remainingFraction)) {
		return Math.min(Math.max(1 - amount.remainingFraction, 0), 1);
	}
	if (
		typeof amount.used === "number" &&
		Number.isFinite(amount.used) &&
		typeof amount.limit === "number" &&
		Number.isFinite(amount.limit) &&
		amount.limit > 0
	) {
		return Math.min(Math.max(amount.used / amount.limit, 0), 1);
	}
	if (amount.unit === "percent" && typeof amount.used === "number" && Number.isFinite(amount.used)) {
		return Math.min(Math.max(amount.used / 100, 0), 1);
	}
	return undefined;
}

function isExhausted(limit: UsageLimit, fraction: number): boolean {
	return limit.status === "exhausted" || fraction >= 1;
}

function getSeverity(limit: UsageLimit, fraction: number, config: UsageStatusConfig): UsageSeverity {
	if (isExhausted(limit, fraction) || fraction >= config.criticalThreshold) return "critical";
	if (limit.status === "warning" || fraction >= config.warningThreshold) return "warning";
	return "normal";
}
function severityRank(severity: UsageSeverity): number {
	return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
}

function maxSeverity(left: UsageSeverity, right: UsageSeverity): UsageSeverity {
	return severityRank(right) > severityRank(left) ? right : left;
}

function getLimitSeverity(limit: UsageLimit, config: UsageStatusConfig): UsageSeverity | undefined {
	const fraction = getUsageFraction(limit);
	return fraction === undefined ? undefined : getSeverity(limit, fraction, config);
}

function getDurationMs(limit: UsageLimit): number {
	const duration = limit.window?.durationMs;
	return typeof duration === "number" && Number.isFinite(duration) && duration > 0
		? duration
		: Number.POSITIVE_INFINITY;
}

function getResetAt(limit: UsageLimit): number {
	const resetAt = limit.window?.resetsAt;
	return typeof resetAt === "number" && Number.isFinite(resetAt) ? resetAt : Number.POSITIVE_INFINITY;
}

function statusScore(limit: UsageLimit, fraction: number): number {
	if (isExhausted(limit, fraction)) return 3;
	if (limit.status === "warning" || fraction >= DEFAULT_CONFIG.warningThreshold) return 2;
	if (limit.status === "unknown") return -1;
	return 0;
}

function compareLimits(left: UsageLimit, right: UsageLimit): number {
	const leftFraction = getUsageFraction(left);
	const rightFraction = getUsageFraction(right);
	if (leftFraction === undefined && rightFraction === undefined) return 0;
	if (leftFraction === undefined) return 1;
	if (rightFraction === undefined) return -1;
	const statusDiff = statusScore(right, rightFraction) - statusScore(left, leftFraction);
	if (statusDiff !== 0) return statusDiff;
	const durationDiff = getDurationMs(left) - getDurationMs(right);
	if (durationDiff !== 0) return durationDiff;
	const resetDiff = getResetAt(left) - getResetAt(right);
	if (resetDiff !== 0) return resetDiff;
	return rightFraction - leftFraction;
}

function findLimit(limits: UsageLimit[], predicate: (limit: UsageLimit) => boolean): UsageLimit | undefined {
	return limits.filter(limit => getUsageFraction(limit) !== undefined).find(predicate);
}

function normalizeWindowId(limit: UsageLimit): string {
	return (limit.scope.windowId || limit.window?.id || "").toLowerCase();
}

function includesLower(value: string | undefined, needle: string): boolean {
	return Boolean(value?.toLowerCase().includes(needle));
}

function inferGeminiTier(model: Model): string | undefined {
	const text = `${model.id} ${model.name}`.toLowerCase();
	if (text.includes("3-flash")) return "3-flash";
	if (text.includes("flash")) return "flash";
	if (text.includes("pro")) return "pro";
	return undefined;
}

function normalizeTier(value: string | undefined): string | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized || undefined;
}


function selectAnthropic(limits: UsageLimit[], model: Model): { primary: UsageLimit | undefined; secondary: UsageLimit | undefined } {
	const modelText = `${model.id} ${model.name}`.toLowerCase();
	const tier = modelText.includes("opus") ? "opus" : modelText.includes("sonnet") ? "sonnet" : undefined;
	const shared5h = findLimit(limits, limit => limit.id === "anthropic:5h" || normalizeWindowId(limit) === "5h");
	const shared7d = findLimit(
		limits,
		limit => limit.id === "anthropic:7d" || (normalizeWindowId(limit) === "7d" && limit.scope.shared === true),
	);
	const tier7d = tier
		? findLimit(
				limits,
				limit => normalizeWindowId(limit) === "7d" && normalizeTier(limit.scope.tier) === tier,
			)
		: undefined;
	return {
		primary: shared5h ?? tier7d ?? shared7d,
		secondary: tier7d ?? (shared5h ? shared7d : undefined),
	};
}

function selectCodex(limits: UsageLimit[]): { primary: UsageLimit | undefined; secondary: UsageLimit | undefined } {
	const primary = findLimit(limits, limit => limit.id === "openai-codex:primary" || includesLower(limit.id, "primary"));
	const secondary = findLimit(
		limits,
		limit => limit.id === "openai-codex:secondary" || includesLower(limit.id, "secondary"),
	);
	return { primary: primary ?? secondary, secondary };
}

function selectGemini(limits: UsageLimit[], model: Model): { primary: UsageLimit | undefined; tier: string | undefined } {
	const candidates = limits.filter(limit => getUsageFraction(limit) !== undefined);
	if (candidates.length === 0) return { primary: undefined, tier: undefined };
	const exact = candidates.find(limit => limit.scope.modelId === model.id);
	if (exact) return { primary: exact, tier: normalizeTier(exact.scope.tier) };
	const modelTier = inferGeminiTier(model);
	if (modelTier) {
		const tierMatch = candidates.find(limit => normalizeTier(limit.scope.tier) === modelTier);
		if (tierMatch) return { primary: tierMatch, tier: normalizeTier(tierMatch.scope.tier) };
	}
	const [best] = [...candidates].sort(compareLimits);
	return { primary: best, tier: normalizeTier(best?.scope.tier) };
}

function selectGeneric(limits: UsageLimit[]): { primary: UsageLimit | undefined; secondary: UsageLimit | undefined } {
	const sorted = limits.filter(limit => getUsageFraction(limit) !== undefined).sort(compareLimits);
	return { primary: sorted[0], secondary: sorted[1] };
}

export function selectUsageForModel(
	reports: readonly UsageReport[] | null | undefined,
	model: Model | undefined,
	config: UsageStatusConfig = DEFAULT_CONFIG,
): SelectedUsage | undefined {
	if (!config.enabled || !model || !reports || reports.length === 0) return undefined;
	const matchingReports = reports.filter(report => report.provider === model.provider && report.limits.length > 0);
	if (matchingReports.length === 0) return undefined;
	if (matchingReports.length > 1) return undefined;

	const report = matchingReports.sort((left, right) => right.fetchedAt - left.fetchedAt)[0];
	if (!report) return undefined;

	let selected: { primary: UsageLimit | undefined; secondary?: UsageLimit | undefined; tier?: string | undefined };
	switch (report.provider) {
		case "anthropic":
			selected = selectAnthropic(report.limits, model);
			break;
		case "openai-codex":
			selected = selectCodex(report.limits);
			break;
		case "google-gemini-cli":
			selected = selectGemini(report.limits, model);
			break;
		default:
			selected = selectGeneric(report.limits);
			break;
	}

	const primary = selected.primary;
	if (!primary) return undefined;
	const fraction = getUsageFraction(primary);
	if (fraction === undefined) return undefined;

	const secondary = selected.secondary && selected.secondary !== primary ? selected.secondary : undefined;
	let severity = getSeverity(primary, fraction, config);
	const secondarySeverity = secondary ? getLimitSeverity(secondary, config) : undefined;
	if (secondarySeverity) severity = maxSeverity(severity, secondarySeverity);

	return {
		report,
		primary,
		secondary,
		usedFraction: fraction,
		severity,
		modelTier: selected.tier,
	};
}

function formatPercent(fraction: number): string {
	return `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
}

function compactWindowLabel(limit: UsageLimit): string | undefined {
	const raw = limit.scope.windowId || limit.window?.id;
	if (!raw) return undefined;
	const normalized = raw.toLowerCase();
	if (normalized.startsWith("reset-") || normalized === "quota" || normalized === "primary" || normalized === "secondary") {
		return undefined;
	}
	return raw;
}

export function formatRelativeTime(targetMs: number | undefined, nowMs = Date.now()): string | undefined {
	if (typeof targetMs !== "number" || !Number.isFinite(targetMs)) return undefined;
	const remainingMs = targetMs - nowMs;
	if (remainingMs <= 0) return "now";
	const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	return `${minutes}m`;
}

function isWeeklyLimit(limit: UsageLimit): boolean {
	const windowId = normalizeWindowId(limit);
	if (windowId === "7d" || windowId === "weekly" || windowId === "week") return true;
	const duration = limit.window?.durationMs;
	return typeof duration === "number" && Number.isFinite(duration) && duration >= WEEKLY_WINDOW_MS - 60_000;
}

function renderLimitLabel(limit: UsageLimit): string | undefined {
	if (isWeeklyLimit(limit)) return "W";
	return compactWindowLabel(limit);
}

function renderLimitBase(limit: UsageLimit, percent: string): string {
	const label = renderLimitLabel(limit);
	return label ? `${label} ${percent}` : percent;
}

function renderLimitPart(limit: UsageLimit, config: UsageStatusConfig): string | undefined {
	const fraction = getUsageFraction(limit);
	if (fraction === undefined) return undefined;
	const percent = formatPercent(fraction);
	const base = renderLimitBase(limit, percent);
	const reset = config.showReset ? formatRelativeTime(limit.window?.resetsAt) : undefined;
	return reset ? `${base} (↻ ${reset})` : base;
}

function renderLimitCompact(limit: UsageLimit): string | undefined {
	const fraction = getUsageFraction(limit);
	return fraction === undefined ? undefined : renderLimitBase(limit, formatPercent(fraction));
}

function renderLimitPercent(limit: UsageLimit): string | undefined {
	const fraction = getUsageFraction(limit);
	return fraction === undefined ? undefined : formatPercent(fraction);
}

function withUsageIcon(body: string): string {
	return `${DEFAULT_USAGE_ICON} ${body}`;
}

export function renderUsage(selection: SelectedUsage, config: UsageStatusConfig = DEFAULT_CONFIG, width = DEFAULT_RENDER_WIDTH): RenderedUsage | undefined {
	if (!config.enabled) return undefined;
	const primaryFull = renderLimitPart(selection.primary, config);
	if (!primaryFull) return undefined;

	const secondary = selection.secondary;
	const secondaryFull = secondary ? renderLimitPart(secondary, config) : undefined;
	const primaryPercent = formatPercent(selection.usedFraction);
	const primaryCompact = renderLimitBase(selection.primary, primaryPercent);
	const secondaryPercent = secondary ? renderLimitPercent(secondary) : undefined;
	const secondaryCompact = secondary ? renderLimitCompact(secondary) : undefined;
	const fullBody = secondaryFull ? `${primaryFull} / ${secondaryFull}` : primaryFull;
	const compactBody = secondaryCompact ? `${primaryCompact} / ${secondaryCompact}` : primaryCompact;
	const percentBody = secondaryPercent ? `${primaryPercent} / ${secondaryPercent}` : primaryPercent;

	const variants = [
		withUsageIcon(fullBody),
		withUsageIcon(compactBody),
		withUsageIcon(percentBody),
		withUsageIcon(primaryCompact),
		withUsageIcon(primaryPercent),
		fullBody,
		compactBody,
		percentBody,
		primaryCompact,
		primaryPercent,
	];

	for (const text of variants) {
		if (text.length <= width) return { text, severity: selection.severity };
	}
	return undefined;
}

export function renderUsageForModel(
	reports: readonly UsageReport[] | null | undefined,
	model: Model | undefined,
	config: UsageStatusConfig = DEFAULT_CONFIG,
	width = DEFAULT_RENDER_WIDTH,
): RenderedUsage | undefined {
	const selected = selectUsageForModel(reports, model, config);
	return selected ? renderUsage(selected, config, width) : undefined;
}
