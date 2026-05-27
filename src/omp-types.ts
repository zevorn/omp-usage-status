export type Provider = string;

export type UsageUnit = "percent" | "tokens" | "requests" | "usd" | "minutes" | "bytes" | "unknown";
export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

export interface UsageWindow {
	id: string;
	label: string;
	durationMs?: number | undefined;
	resetsAt?: number | undefined;
}

export interface UsageAmount {
	used?: number;
	limit?: number;
	remaining?: number;
	usedFraction?: number;
	remainingFraction?: number;
	unit: UsageUnit;
}

export interface UsageScope {
	provider: Provider;
	accountId?: string | undefined;
	projectId?: string | undefined;
	orgId?: string | undefined;
	modelId?: string | undefined;
	tier?: string | undefined;
	windowId?: string | undefined;
	shared?: boolean | undefined;
}

export interface UsageLimit {
	id: string;
	label: string;
	scope: UsageScope;
	window?: UsageWindow | undefined;
	amount: UsageAmount;
	status?: UsageStatus | undefined;
	notes?: string[] | undefined;
}

export interface UsageReport {
	provider: Provider;
	fetchedAt: number;
	limits: UsageLimit[];
	metadata?: Record<string, unknown> | undefined;
	raw?: unknown;
}

export interface Model {
	id: string;
	name: string;
	api: string;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	premiumMultiplier?: number | undefined;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string> | undefined;
}

export interface ExtensionThemeLike {
	fg?(token: string, value: string): string;
	bg?(token: string, value: string): string;
	getFgAnsi?(token: string): string;
	getBgAnsi?(token: string): string;
}

export interface ExtensionUIContextLike {
	setStatus(key: string, text: string | undefined): void;
	readonly theme: ExtensionThemeLike;
}

export interface StatusLineBorderLike {
	content: string;
	width: number;
}

export interface StatusLineComponentPrototypeLike {
	getTopBorder?(width: number): StatusLineBorderLike;
}

export interface StatusLineComponentClassLike {
	prototype?: StatusLineComponentPrototypeLike;
}

export interface EditorComponentPrototypeLike {
	setTopBorder?(content: StatusLineBorderLike | undefined): void;
}

export interface EditorComponentClassLike {
	prototype?: EditorComponentPrototypeLike;
}

export interface ExtensionRuntimeExportsLike {
	StatusLineComponent?: StatusLineComponentClassLike;
	CustomEditor?: EditorComponentClassLike;
}

export type FetchUsageReports = (options?: {
	baseUrlResolver?: (provider: string) => string | undefined;
}) => Promise<UsageReport[] | null>;

export interface AuthStorageLike {
	fetchUsageReports?: FetchUsageReports;
}

export interface ExtensionContext {
	ui: ExtensionUIContextLike;
	hasUI: boolean;
	cwd: string;
	modelRegistry: { authStorage?: AuthStorageLike };
	model: Model | undefined;
}

export interface ExtensionLoggerLike {
	debug?(message: string, meta?: Record<string, unknown>): void;
	warn?(message: string, meta?: Record<string, unknown>): void;
}

export interface ExtensionAPI {
	logger: ExtensionLoggerLike;
	pi?: ExtensionRuntimeExportsLike;
	setLabel(entryIdOrLabel: string, label?: string | undefined): void;
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
}
