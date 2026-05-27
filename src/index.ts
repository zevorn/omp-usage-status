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

const STATUS_LINE_SEPARATOR = " > ";
const PLAY_STATUS_MARKER = "▶";
const ANSI_SEQUENCE_SOURCE = "\\x1B(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1B\\\\)|[()][A-Za-z0-9]|[=>])";
const ANSI_SEQUENCE_PATTERN = new RegExp(ANSI_SEQUENCE_SOURCE, "g");
const ANSI_SEQUENCE_STICKY_PATTERN = new RegExp(ANSI_SEQUENCE_SOURCE, "y");
const TRAILING_PLAY_STATUS_MARKER_PATTERN = new RegExp(`(?:[\\t ]|${ANSI_SEQUENCE_SOURCE})*${PLAY_STATUS_MARKER}(?:${ANSI_SEQUENCE_SOURCE})*$`);

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
		if (typeof theme.getBgAnsi === "function" && typeof theme.getFgAnsi === "function") {
			const background = theme.getBgAnsi("statusLineBg");
			segmentText = `${background}${theme.getFgAnsi(token)}${text}\x1b[0m`;
			separator = `${background}${theme.getFgAnsi("statusLineSep")}${STATUS_LINE_SEPARATOR}\x1b[0m`;
		} else if (typeof theme.bg === "function") {
			segmentText = theme.bg("statusLineBg", foreground(theme, token, text));
			separator = theme.bg("statusLineBg", foreground(theme, "statusLineSep", STATUS_LINE_SEPARATOR));
		} else {
			segmentText = foreground(theme, token, text);
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

interface SplitStatusLineContent {
	content: string;
	width: number;
	suffix: string;
	suffixWidth: number;
}

interface SeparatorInsertion {
	text: string;
	width: number;
}

interface ShrinkableGap {
	start: number;
	width: number;
}

const HORIZONTAL_FILL_CHARS = "─━═╌╍┄┅┈┉";

function trimLeadingMarkerGap(suffix: string): string {
	const markerIndex = suffix.indexOf(PLAY_STATUS_MARKER);
	if (markerIndex <= 0) return suffix;

	let ansiPrefix = "";
	let index = 0;
	while (index < markerIndex) {
		const code = suffix.charCodeAt(index);
		if (code === 9 || code === 32) {
			index += 1;
			continue;
		}
		ANSI_SEQUENCE_STICKY_PATTERN.lastIndex = index;
		const match = ANSI_SEQUENCE_STICKY_PATTERN.exec(suffix);
		if (!match || ANSI_SEQUENCE_STICKY_PATTERN.lastIndex > markerIndex) return suffix.slice(markerIndex);
		ansiPrefix += match[0];
		index = ANSI_SEQUENCE_STICKY_PATTERN.lastIndex;
	}

	return `${ansiPrefix}${suffix.slice(markerIndex)}`;
}

function splitTrailingPlayStatusMarker(content: string, width: number): SplitStatusLineContent {
	const match = TRAILING_PLAY_STATUS_MARKER_PATTERN.exec(content);
	if (!match) return { content, width, suffix: "", suffixWidth: 0 };
	const rawSuffix = match[0];
	const rawSuffixWidth = visibleWidth(rawSuffix);
	if (rawSuffixWidth === 0) return { content, width, suffix: "", suffixWidth: 0 };
	const suffix = trimLeadingMarkerGap(rawSuffix);
	const suffixWidth = visibleWidth(suffix);
	if (suffixWidth === 0) return { content, width, suffix: "", suffixWidth: 0 };
	return {
		content: content.slice(0, match.index),
		width: Math.max(0, width - rawSuffixWidth),
		suffix,
		suffixWidth,
	};
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

function separatorAfter(content: string, segment: StatusLinePatchSegment): SeparatorInsertion {
	if (!content) return { text: "", width: 0 };
	const plain = stripAnsi(content);
	if (!plain) return { text: "", width: 0 };
	const separator = plain.endsWith(" ") || plain.endsWith("\t") ? removeLeadingVisibleWhitespace(segment.separator) : segment.separator;
	return { text: separator, width: visibleWidth(separator) };
}

function findShrinkableGap(content: string, requiredWidth: number): ShrinkableGap | undefined {
	if (requiredWidth <= 0) return undefined;
	let best: ShrinkableGap | undefined;
	let runStart = -1;
	let runWidth = 0;
	let runChar = "";

	const finishRun = () => {
		if (runWidth >= requiredWidth && (!best || runWidth > best.width)) {
			best = { start: runStart, width: runWidth };
		}
		runStart = -1;
		runWidth = 0;
		runChar = "";
	};

	for (let index = 0; index < content.length;) {
		ANSI_SEQUENCE_STICKY_PATTERN.lastIndex = index;
		const match = ANSI_SEQUENCE_STICKY_PATTERN.exec(content);
		if (match) {
			index = ANSI_SEQUENCE_STICKY_PATTERN.lastIndex;
			continue;
		}

		const char = content[index];
		if (char && HORIZONTAL_FILL_CHARS.includes(char)) {
			if (runStart >= 0 && char === runChar) {
				runWidth += 1;
			} else {
				finishRun();
				runStart = index;
				runWidth = 1;
				runChar = char;
			}
		} else {
			finishRun();
		}
		index += 1;
	}
	finishRun();
	return best;
}

function insertUsageIntoShrinkableGap(base: SplitStatusLineContent, targetWidth: number, segment: StatusLinePatchSegment): StatusLineBorderLike | undefined {
	const gapProbe = findShrinkableGap(base.content, 1);
	if (!gapProbe) return undefined;
	const prefix = base.content.slice(0, gapProbe.start);
	const separator = separatorAfter(prefix, segment);
	const addWidth = separator.width + segment.width;
	const currentWidth = base.width + base.suffixWidth;
	const slack = Math.max(0, targetWidth - currentWidth);
	const requiredRemoval = addWidth - slack;
	if (requiredRemoval <= 0) {
		return {
			content: `${base.content.slice(0, gapProbe.start)}${separator.text}${segment.text}${base.suffix}${base.content.slice(gapProbe.start)}`,
			width: currentWidth + addWidth,
		};
	}
	const gap = gapProbe.width >= requiredRemoval ? gapProbe : findShrinkableGap(base.content, requiredRemoval);
	if (!gap || gap.width < requiredRemoval) return undefined;
	return {
		content: `${base.content.slice(0, gap.start)}${separator.text}${segment.text}${base.suffix}${base.content.slice(gap.start + requiredRemoval)}`,
		width: currentWidth + addWidth - requiredRemoval,
	};
}

function appendUsageToTopBorder(border: StatusLineBorderLike, maxWidth: number, segment: StatusLinePatchSegment): StatusLineBorderLike {
	const content = typeof border.content === "string" ? border.content : "";
	if (content.includes(segment.text) || (segment.plainText.length > 0 && stripAnsi(content).includes(segment.plainText))) return border;
	const rawBaseWidth = typeof border.width === "number" && Number.isFinite(border.width) ? border.width : visibleWidth(content);
	const targetWidth = maxWidth > 0 ? maxWidth : rawBaseWidth;
	const base = splitTrailingPlayStatusMarker(content, rawBaseWidth);
	const separator = separatorAfter(base.content, segment);
	const appendedWidth = base.width + separator.width + segment.width + base.suffixWidth;
	if (appendedWidth <= targetWidth) {
		return {
			content: `${base.content}${separator.text}${segment.text}${base.suffix}`,
			width: appendedWidth,
		};
	}
	const inserted = insertUsageIntoShrinkableGap(base, targetWidth, segment);
	if (inserted) return inserted;
	if (maxWidth > 0) return border;
	return {
		content: `${base.content}${separator.text}${segment.text}${base.suffix}`,
		width: appendedWidth,
	};
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
		return appendUsageToTopBorder(border, width, segment);
	};

	state.component = component;
	state.original = original as (this: unknown, width: number) => StatusLineBorderLike;
	state.patched = patched;
	prototype.getTopBorder = patched;
	state.installed = true;
	return true;
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
		const next = content && segment ? appendUsageToTopBorder(content, 0, segment) : content;
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
	const editorInstalled = installEditorTopBorderPatch(pi);
	return statusLineInstalled || editorInstalled;
}

function setPiStatusLineSegment(segment: StatusLinePatchSegment | undefined): boolean {
	const state = getStatusLinePatchState();
	state.segment = segment;
	state.text = segment?.text;
	return state.installed || state.editorInstalled;
}

export function resetPiStatusLinePatchForTest(): void {
	const state = getStatusLinePatchState();
	const component = state.component;
	if (state.installed && component && state.original) {
		const prototype = component.prototype;
		if (prototype && prototype.getTopBorder === state.patched) prototype.getTopBorder = state.original;
	}
	const editorComponent = state.editorComponent;
	if (state.editorInstalled && editorComponent && state.editorOriginal) {
		const prototype = editorComponent.prototype;
		if (prototype && prototype.setTopBorder === state.editorPatched) prototype.setTopBorder = state.editorOriginal;
	}
	state.segment = undefined;
	state.text = undefined;
	state.installed = false;
	state.editorInstalled = false;
	state.component = undefined;
	state.editorComponent = undefined;
	state.original = undefined;
	state.patched = undefined;
	state.editorOriginal = undefined;
	state.editorPatched = undefined;
}

export class UsageStatusController {
	#config: UsageStatusConfig = { ...DEFAULT_CONFIG };
	#timer: ReturnType<typeof setInterval> | undefined;
	#refreshInFlight: Promise<void> | undefined;
	#dirty = false;
	#lastContext: ExtensionContext | undefined;
	#disposed = false;
	#lastText: string | undefined;

	constructor(private readonly logger?: { debug?: (message: string, meta?: Record<string, unknown>) => void; warn?: (message: string, meta?: Record<string, unknown>) => void }) {}

	async start(ctx: ExtensionContext): Promise<void> {
		this.#disposed = false;
		this.#lastContext = ctx;
		this.#config = await loadUsageStatusConfig(ctx.cwd, PLUGIN_NAME);
		this.#restartTimer();
		this.schedule(ctx, "start");
	}

	dispose(ctx?: ExtensionContext): void {
		this.#disposed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		this.#clear(ctx ?? this.#lastContext);
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
		this.#refreshInFlight = this.#refresh(ctx, reason)
			.catch(error => {
				this.logger?.warn?.("Usage status refresh failed", { error: String(error), reason });
			})
			.finally(() => {
				this.#refreshInFlight = undefined;
				if (this.#dirty && !this.#disposed && this.#lastContext) {
					this.#dirty = false;
					this.schedule(this.#lastContext, "dirty");
				}
			});
	}

	async flush(): Promise<void> {
		await this.#refreshInFlight;
	}

	async #refresh(ctx: ExtensionContext, reason: string): Promise<void> {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		if (!model) {
			this.logger?.debug?.("Usage status refresh skipped; active model unavailable", { reason });
			return;
		}

		const authStorage = getAuthStorage(ctx);
		if (typeof authStorage?.fetchUsageReports !== "function") {
			this.logger?.debug?.("Usage reports unavailable from OMP runtime", { reason });
			return;
		}

		const reports = await authStorage.fetchUsageReports({
			baseUrlResolver: provider => (provider === model.provider ? model.baseUrl : undefined),
		});
		if (reports == null) {
			this.logger?.debug?.("Usage reports unavailable from OMP runtime", { reason });
			return;
		}
		const rendered = renderUsageForModel(reports, model, this.#config, RENDER_WIDTH);
		this.#set(ctx, rendered);
	}

	#set(ctx: ExtensionContext, rendered: RenderedUsage | undefined): void {
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
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	#clear(ctx: ExtensionContext | undefined): void {
		if (!ctx) return;
		this.#lastText = undefined;
		setPiStatusLineSegment(undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
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
		controller.dispose(ctx);
	});
}
