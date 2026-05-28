import type { ExtensionAPI, ExtensionContext, AuthStorageLike, ExtensionThemeLike, StatusLineBorderLike } from "./omp-types";
import {
	DEFAULT_CONFIG,
	PLUGIN_NAME,
	STATUS_KEY,
	loadUsageStatusConfig,
	renderUsageForModel,
	type RenderedUsage,
	type UsageSeverity,
	type UsageStatusConfig,
} from "./usage-status";

const RENDER_WIDTH = 48;


function getAuthStorage(ctx: ExtensionContext): AuthStorageLike | undefined {
	return (ctx.modelRegistry as unknown as { authStorage?: AuthStorageLike }).authStorage;
}

const STATUS_LINE_SEPARATOR = " ";
const PLAY_STATUS_MARKER = "▶";
const HORIZONTAL_FILL_CHARS = "─━═╌╍┄┅┈┉-";
const MIN_PADDING_AFTER_USAGE = 3;
const ANSI_SEQUENCE_SOURCE = "\\x1B(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1B\\\\)|[()][A-Za-z0-9]|[=>])";
const STARTUP_RETRY_INTERVAL_MS = 250;
const STARTUP_RETRY_WINDOW_MS = 30_000;
const ANSI_RESET = "\x1b[0m";
const ANSI_SEQUENCE_PATTERN = new RegExp(ANSI_SEQUENCE_SOURCE, "g");
const ANSI_SEQUENCE_STICKY_PATTERN = new RegExp(ANSI_SEQUENCE_SOURCE, "y");

interface StatusLinePatchSegment {
	text: string;
	plainText: string;
	width: number;
	separator: string;
	separatorWidth: number;
}

function usageThemeToken(severity: UsageSeverity): string {
	return severity === "critical" ? "error" : severity === "warning" ? "warning" : "statusLineSpend";
}

function foreground(theme: ExtensionThemeLike, token: string, text: string): string {
	if (typeof theme.fg !== "function") return text;
	try {
		return theme.fg(token, text);
	} catch {
		return text;
	}
}

function statusLineSegment(ctx: ExtensionContext, severity: UsageSeverity, text: string): StatusLinePatchSegment {
	const theme = ctx.ui.theme;
	const token = usageThemeToken(severity);
	let segmentText = text;
	let separator = STATUS_LINE_SEPARATOR;

	try {
		if (typeof theme.getFgAnsi === "function") {
			segmentText = `${theme.getFgAnsi(token)}${text}${ANSI_RESET}`;
			separator = `${ANSI_RESET}${theme.getFgAnsi("statusLineSep")}${STATUS_LINE_SEPARATOR}${ANSI_RESET}`;
		} else {
			segmentText = foreground(theme, token, text);
			separator = foreground(theme, "statusLineSep", STATUS_LINE_SEPARATOR);
		}
	} catch {
		segmentText = foreground(theme, token, text);
		separator = STATUS_LINE_SEPARATOR;
	}

	return {
		text: segmentText,
		plainText: text,
		width: visibleWidth(segmentText),
		separator,
		separatorWidth: visibleWidth(separator),
	};
}

const STATUS_LINE_PATCH_KEY = Symbol.for("omp-usage-status.statusLinePatch");

type StatusLineComponentClass = NonNullable<ExtensionAPI["pi"]>["StatusLineComponent"];
type EditorComponentClass = NonNullable<ExtensionAPI["pi"]>["CustomEditor"];

interface StatusLinePatchState {
	segment: StatusLinePatchSegment | undefined;
	text: string | undefined;
	installed: boolean;
	editorInstalled: boolean;
	component: StatusLineComponentClass | undefined;
	editorComponent: EditorComponentClass | undefined;
	original: ((this: unknown, width: number) => StatusLineBorderLike) | undefined;
	patched: ((this: unknown, width: number) => StatusLineBorderLike) | undefined;
	editorOriginal: ((this: unknown, content: StatusLineBorderLike | undefined) => void) | undefined;
	editorPatched: ((this: unknown, content: StatusLineBorderLike | undefined) => void) | undefined;
}

function getStatusLinePatchState(): StatusLinePatchState {
	const globalState = globalThis as typeof globalThis & { [STATUS_LINE_PATCH_KEY]?: StatusLinePatchState };
	globalState[STATUS_LINE_PATCH_KEY] ??= {
		segment: undefined,
		text: undefined,
		installed: false,
		editorInstalled: false,
		component: undefined,
		editorComponent: undefined,
		original: undefined,
		patched: undefined,
		editorOriginal: undefined,
		editorPatched: undefined,
	};
	return globalState[STATUS_LINE_PATCH_KEY];
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_SEQUENCE_PATTERN, "");
}

function visibleWidth(text: string): number {
	return stripAnsi(text).length;
}

interface SeparatorInsertion {
	text: string;
	width: number;
}


function removeLeadingVisibleWhitespace(text: string): string {
	let index = 0;
	while (index < text.length) {
		ANSI_SEQUENCE_STICKY_PATTERN.lastIndex = index;
		const match = ANSI_SEQUENCE_STICKY_PATTERN.exec(text);
		if (match) {
			index = ANSI_SEQUENCE_STICKY_PATTERN.lastIndex;
			continue;
		}
		const code = text.charCodeAt(index);
		if (code === 9 || code === 32) return `${text.slice(0, index)}${text.slice(index + 1)}`;
		return text;
	}
	return text;
}

function isHorizontalPaddingChar(char: string | undefined): boolean {
	return char === " " || char === "\t" || (char !== undefined && HORIZONTAL_FILL_CHARS.includes(char));
}

interface LeadingHorizontalPadding {
	width: number;
	hasFollowingContent: boolean;
}

function leadingHorizontalPadding(text: string): LeadingHorizontalPadding {
	let width = 0;
	for (let index = 0; index < text.length;) {
		ANSI_SEQUENCE_STICKY_PATTERN.lastIndex = index;
		const match = ANSI_SEQUENCE_STICKY_PATTERN.exec(text);
		if (match) {
			index = ANSI_SEQUENCE_STICKY_PATTERN.lastIndex;
			continue;
		}
		if (!isHorizontalPaddingChar(text[index])) return { width, hasFollowingContent: true };
		width += 1;
		index += 1;
	}
	return { width, hasFollowingContent: false };
}


function separatorAfter(content: string, segment: StatusLinePatchSegment): SeparatorInsertion {
	if (!content) return { text: "", width: 0 };
	const plain = stripAnsi(content);
	if (!plain) return { text: "", width: 0 };
	const separator = plain.endsWith(" ") || plain.endsWith("\t") ? removeLeadingVisibleWhitespace(segment.separator) : segment.separator;
	return { text: separator, width: visibleWidth(separator) };
}

function removeVisiblePrefix(text: string, width: number): string {
	if (width <= 0) return text;
	let removed = 0;
	let index = 0;
	while (index < text.length && removed < width) {
		ANSI_SEQUENCE_STICKY_PATTERN.lastIndex = index;
		const match = ANSI_SEQUENCE_STICKY_PATTERN.exec(text);
		if (match) {
			index = ANSI_SEQUENCE_STICKY_PATTERN.lastIndex;
			continue;
		}
		index += 1;
		removed += 1;
	}
	return text.slice(index);
}

function skipAnsiSequences(text: string, index: number): number {
	while (index < text.length) {
		ANSI_SEQUENCE_STICKY_PATTERN.lastIndex = index;
		const match = ANSI_SEQUENCE_STICKY_PATTERN.exec(text);
		if (!match) return index;
		index = ANSI_SEQUENCE_STICKY_PATTERN.lastIndex;
	}
	return index;
}

function findPlayMarkerInsertion(content: string): number | undefined {
	const markerIndex = content.lastIndexOf(PLAY_STATUS_MARKER);
	return markerIndex < 0 ? undefined : skipAnsiSequences(content, markerIndex + PLAY_STATUS_MARKER.length);
}


function overlayUsageAfterPlayMarker(content: string, width: number, segment: StatusLinePatchSegment): StatusLineBorderLike | undefined {
	const insertion = findPlayMarkerInsertion(content);
	if (insertion === undefined) return undefined;
	const prefix = content.slice(0, insertion);
	const tail = content.slice(insertion);
	const separator = separatorAfter(prefix, segment);
	const overlayWidth = separator.width + segment.width + segment.separatorWidth;
	const padding = leadingHorizontalPadding(tail);
	if (!padding.hasFollowingContent && padding.width === 0) {
		return {
			content: `${prefix}${separator.text}${segment.text}${segment.separator}`,
			width: width + overlayWidth,
		};
	}
	const requiredPadding = overlayWidth + (padding.hasFollowingContent ? MIN_PADDING_AFTER_USAGE : 0);
	if (padding.width < requiredPadding) return undefined;
	return {
		content: `${prefix}${separator.text}${segment.text}${segment.separator}${removeVisiblePrefix(tail, overlayWidth)}`,
		width,
	};
}

function overlayUsageToTopBorder(border: StatusLineBorderLike, segment: StatusLinePatchSegment): StatusLineBorderLike {
	const content = typeof border.content === "string" ? border.content : "";
	const width = typeof border.width === "number" && Number.isFinite(border.width) ? border.width : visibleWidth(content);
	return overlayUsageAfterPlayMarker(content, width, segment) ?? border;
}


function plainStatusLineSegment(text: string): StatusLinePatchSegment {
	return {
		text,
		plainText: stripAnsi(text),
		width: visibleWidth(text),
		separator: STATUS_LINE_SEPARATOR,
		separatorWidth: STATUS_LINE_SEPARATOR.length,
	};
}


function getCurrentStatusLineSegment(state = getStatusLinePatchState()): StatusLinePatchSegment | undefined {
	return state.segment ?? (state.text ? plainStatusLineSegment(state.text) : undefined);
}

function installStatusLineComponentPatch(pi: ExtensionAPI): boolean {
	const state = getStatusLinePatchState();
	const component = pi.pi?.StatusLineComponent;
	const prototype = component?.prototype;
	const current = prototype?.getTopBorder;
	if (!prototype || typeof current !== "function") return false;
	if (state.installed && state.component === component && current === state.patched) return true;

	const original = current === state.patched && state.original ? state.original : current;
	const patched = function patchedGetTopBorder(this: unknown, width: number): StatusLineBorderLike {
		const border = original.call(this, width);
		const segment = getCurrentStatusLineSegment(state);
		if (!border || !segment) return border ?? { content: "", width: 0 };
		return overlayUsageToTopBorder(border, segment);
	};

	state.component = component;
	state.original = original as (this: unknown, width: number) => StatusLineBorderLike;
	state.patched = patched;
	prototype.getTopBorder = patched;
	state.installed = true;
	return true;
}

function restoreEditorTopBorderPatch(state: StatusLinePatchState): void {
	const editorComponent = state.editorComponent;
	if (state.editorInstalled && editorComponent && state.editorOriginal) {
		const prototype = editorComponent.prototype;
		if (prototype && prototype.setTopBorder === state.editorPatched) prototype.setTopBorder = state.editorOriginal;
	}
	state.editorInstalled = false;
	state.editorComponent = undefined;
	state.editorOriginal = undefined;
	state.editorPatched = undefined;
}

function installEditorTopBorderPatch(pi: ExtensionAPI): boolean {
	const state = getStatusLinePatchState();
	const component = pi.pi?.CustomEditor;
	const prototype = component?.prototype;
	const current = prototype?.setTopBorder;
	if (!prototype || typeof current !== "function") return false;
	if (state.editorInstalled && state.editorComponent === component && current === state.editorPatched) return true;

	const original = current === state.editorPatched && state.editorOriginal ? state.editorOriginal : current;
	const patched = function patchedSetTopBorder(this: unknown, content: StatusLineBorderLike | undefined): void {
		const segment = getCurrentStatusLineSegment(state);
		const next = content && segment ? overlayUsageToTopBorder(content, segment) : content;
		original.call(this, next);
	};

	state.editorComponent = component;
	state.editorOriginal = original as (this: unknown, content: StatusLineBorderLike | undefined) => void;
	state.editorPatched = patched;
	prototype.setTopBorder = patched;
	state.editorInstalled = true;
	return true;
}

export function installPiStatusLinePatch(pi: ExtensionAPI): boolean {
	const statusLineInstalled = installStatusLineComponentPatch(pi);
	if (statusLineInstalled) {
		restoreEditorTopBorderPatch(getStatusLinePatchState());
		return true;
	}
	return installEditorTopBorderPatch(pi);
}

function setPiStatusLineSegment(segment: StatusLinePatchSegment | undefined): boolean {
	const state = getStatusLinePatchState();
	state.segment = segment;
	state.text = segment?.text;
	return state.installed || state.editorInstalled;
}

function requestStatusLineRender(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, "");
}


export function resetPiStatusLinePatchForTest(): void {
	const state = getStatusLinePatchState();
	const component = state.component;
	if (state.installed && component && state.original) {
		const prototype = component.prototype;
		if (prototype && prototype.getTopBorder === state.patched) prototype.getTopBorder = state.original;
	}
	restoreEditorTopBorderPatch(state);
	state.segment = undefined;
	state.text = undefined;
	state.installed = false;
	state.component = undefined;
	state.original = undefined;
	state.patched = undefined;
}

export class UsageStatusController {
	#config: UsageStatusConfig = { ...DEFAULT_CONFIG };
	#timer: ReturnType<typeof setInterval> | undefined;
	#startupRetryTimer: ReturnType<typeof setTimeout> | undefined;
	#startupRetryUntil = 0;
	#refreshInFlight: Promise<void> | undefined;
	#generation = 0;
	#dirty = false;
	#lastContext: ExtensionContext | undefined;
	#disposed = false;
	#lastText: string | undefined;

	constructor(private readonly logger?: { debug?: (message: string, meta?: Record<string, unknown>) => void; warn?: (message: string, meta?: Record<string, unknown>) => void }) {}

	async start(ctx: ExtensionContext): Promise<void> {
		this.#generation += 1;
		const generation = this.#generation;
		this.#disposed = false;
		this.#lastContext = ctx;
		const config = await loadUsageStatusConfig(ctx.cwd, PLUGIN_NAME);
		if (this.#disposed || generation !== this.#generation) return;
		this.#config = config;
		this.#cancelStartupRetry();
		this.#startupRetryUntil = Date.now() + STARTUP_RETRY_WINDOW_MS;
		this.#restartTimer();
		this.schedule(ctx, "start");
	}

	dispose(ctx?: ExtensionContext, options?: { render?: boolean }): void {
		this.#disposed = true;
		this.#generation += 1;
		this.#cancelStartupRetry();
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		this.#clear(ctx ?? this.#lastContext, options);
	}

	schedule(ctx: ExtensionContext, reason: string): void {
		if (this.#disposed) return;
		this.#lastContext = ctx;
		if (!this.#config.enabled) {
			this.#clear(ctx);
			return;
		}
		if (this.#refreshInFlight) {
			this.#dirty = true;
			return;
		}
		const generation = this.#generation;
		let retryStartup = false;
		this.#refreshInFlight = this.#refresh(ctx, reason, generation)
			.then(ready => {
				retryStartup = !ready && generation === this.#generation && !this.#disposed;
			})
			.catch(error => {
				if (!this.#disposed && generation === this.#generation) {
					this.logger?.warn?.("Usage status refresh failed", { error: String(error), reason });
				}
			})
			.finally(() => {
				this.#refreshInFlight = undefined;
				if (this.#dirty && !this.#disposed && this.#lastContext) {
					this.#dirty = false;
					this.schedule(this.#lastContext, "dirty");
					return;
				}
				if (retryStartup) this.#scheduleStartupRetry(ctx, generation);
			});
	}

	async flush(): Promise<void> {
		await this.#refreshInFlight;
	}

	async #refresh(ctx: ExtensionContext, reason: string, generation: number): Promise<boolean> {
		if (this.#disposed || generation !== this.#generation) return true;
		if (!ctx.hasUI) return true;
		const model = ctx.model;
		if (!model) {
			this.logger?.debug?.("Usage status refresh skipped; active model unavailable", { reason });
			return false;
		}

		const authStorage = getAuthStorage(ctx);
		if (typeof authStorage?.fetchUsageReports !== "function") {
			this.logger?.debug?.("Usage reports unavailable from OMP runtime", { reason });
			return false;
		}

		const reports = await authStorage.fetchUsageReports({
			baseUrlResolver: provider => (provider === model.provider ? model.baseUrl : undefined),
		});
		if (this.#disposed || generation !== this.#generation) return true;
		if (reports == null) {
			this.logger?.debug?.("Usage reports unavailable from OMP runtime", { reason });
			return false;
		}
		const rendered = renderUsageForModel(reports, model, this.#config, RENDER_WIDTH);
		this.#set(ctx, rendered, generation);
		return true;
	}

	#set(ctx: ExtensionContext, rendered: RenderedUsage | undefined, generation: number): void {
		if (this.#disposed || generation !== this.#generation) return;
		if (!rendered) {
			this.#clear(ctx);
			return;
		}
		const segment = statusLineSegment(ctx, rendered.severity, rendered.text);
		const cacheKey = `${segment.separator}\u0000${segment.text}`;
		if (cacheKey === this.#lastText) return;
		if (!setPiStatusLineSegment(segment)) {
			this.logger?.warn?.("OMP status line patch unavailable; usage segment hidden");
			this.#clear(ctx);
			return;
		}
		this.#lastText = cacheKey;
		this.#cancelStartupRetry();
		requestStatusLineRender(ctx);
	}

	#clear(ctx: ExtensionContext | undefined, options?: { render?: boolean }): void {
		this.#lastText = undefined;
		setPiStatusLineSegment(undefined);
		if (ctx && options?.render !== false) requestStatusLineRender(ctx);
	}

	#restartTimer(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		if (!this.#config.enabled || this.#config.refreshIntervalMs <= 0) return;
		this.#timer = setInterval(() => {
			if (this.#lastContext) this.schedule(this.#lastContext, "timer");
		}, this.#config.refreshIntervalMs);
		(this.#timer as { unref?: () => void }).unref?.();
	}

	#scheduleStartupRetry(ctx: ExtensionContext, generation: number): void {
		if (this.#disposed || generation !== this.#generation || this.#startupRetryTimer || this.#lastText || Date.now() >= this.#startupRetryUntil) return;
		this.#startupRetryTimer = setTimeout(() => {
			this.#startupRetryTimer = undefined;
			if (!this.#disposed && generation === this.#generation) this.schedule(ctx, "startup_retry");
		}, STARTUP_RETRY_INTERVAL_MS);
		(this.#startupRetryTimer as { unref?: () => void }).unref?.();
	}

	#cancelStartupRetry(): void {
		if (!this.#startupRetryTimer) return;
		clearTimeout(this.#startupRetryTimer);
		this.#startupRetryTimer = undefined;
	}
}

export default function usageStatusBarExtension(pi: ExtensionAPI): void {
	pi.setLabel("Usage Status");
	const patched = installPiStatusLinePatch(pi);
	if (!patched) {
		pi.logger?.warn?.("Usage Status could not patch the Pi status line; usage segment will stay hidden");
	}
	const controller = new UsageStatusController(pi.logger);

	pi.on("session_start", async (_event, ctx) => {
		await controller.start(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		controller.dispose(ctx);
		await controller.start(ctx);
	});
	pi.on("session_branch", async (_event, ctx) => {
		controller.schedule(ctx, "session_branch");
	});
	pi.on("session_tree", async (_event, ctx) => {
		controller.schedule(ctx, "session_tree");
	});
	pi.on("session_compact", async (_event, ctx) => {
		controller.schedule(ctx, "session_compact");
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		controller.schedule(ctx, "before_agent_start");
	});
	pi.on("turn_end", async (_event, ctx) => {
		controller.schedule(ctx, "turn_end");
	});
	pi.on("agent_end", async (_event, ctx) => {
		controller.schedule(ctx, "agent_end");
	});
	pi.on("auto_retry_end", async (_event, ctx) => {
		controller.schedule(ctx, "auto_retry_end");
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		controller.dispose(ctx, { render: false });
	});
}
