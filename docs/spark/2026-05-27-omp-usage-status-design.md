# OMP Usage Status Plugin Design

## Context

The current working directory is an empty repository with no existing project files and no commits. This spec therefore designs a new, independent OMP plugin package rather than changes to an existing codebase.

OMP already has a runtime extension system, plugin installation/loading support, a Pi interactive status bar, provider/model metadata, auth storage, and normalized provider usage types. OMP usage providers currently include Claude/Anthropic, OpenAI Codex, Google Gemini CLI, and other coding-plan style providers. The plugin should consume those normalized OMP usage reports instead of reimplementing provider-specific quota APIs.

## Goal

Create an OMP plugin that appends current-provider usage information to the Pi status bar. It should behave like the usage section in claude-hud, but generalized across OMP-supported coding-plan providers such as Claude, Codex, and Gemini.

The plugin must:

- Display usage only for the provider/model currently active in the OMP session.
- Support every OMP provider that exposes normalized `UsageReport` / `UsageLimit` data.
- Hide itself when usage data is unavailable, unsupported, expired, or ambiguous.
- Preserve existing Pi status bar content and append a compact usage segment.
- Reuse OMP auth, cache, credential ranking, and usage-fetching logic.

## Non-goals

- Do not build a dashboard for all accounts or all providers.
- Do not display email, account id, org id, project id, refresh token state, or credential identity.
- Do not implement Claude/Codex/Gemini quota HTTP clients inside the plugin.
- Do not require auth-broker/auth-gateway mode for ordinary local OMP use.
- Do not replace or restyle the whole Pi status bar.

## Recommended approach

Use a generic `UsageReport` adapter layer.

The plugin should depend on OMP's normalized usage-report surface, not provider-private APIs. This keeps provider behavior consistent with the rest of OMP, avoids duplicated OAuth/cache/ranking logic, and allows future OMP usage providers to appear in the status bar without plugin-specific fetch code.

If the extension runtime does not yet expose a direct read-only usage-report accessor, the implementation should add the smallest OMP core API needed for extensions to request cached/current usage reports. That API should return normalized reports and preserve OMP's existing cache and last-good semantics.

## Architecture

### Extension entrypoint

The plugin is an OMP runtime extension package. It registers event listeners during extension load and performs all runtime work from event handlers after OMP initializes the extension context.

### Components

1. **Usage source**
   - Reads OMP-normalized `UsageReport[]` data.
   - Uses existing OMP usage providers, auth storage, usage cache, and credential ranking.
   - Does not directly call provider quota APIs.

2. **Provider selector**
   - Reads the active session model/provider from extension context.
   - Filters usage reports to the active provider.
   - Ignores reports from non-active providers by default.

3. **Limit normalizer**
   - Chooses the most useful `UsageLimit` entries for the active provider/model.
   - Prefers limits with a numeric `amount.usedFraction`.
   - Prioritizes short-window usage, exhausted/warning limits, and model/tier matches.

4. **Status renderer**
   - Converts selected limits into a short status-bar segment.
   - Produces width-aware output with graceful degradation.
   - Omits private account metadata.

5. **Status bar integration**
   - Updates the Pi status bar/widget surface with the plugin segment.
   - Appends to existing status content rather than replacing it.
   - Clears the segment when no trustworthy usage exists.

## Provider behavior

### Claude / Anthropic

- Prefer the 5-hour shared Claude limit when available.
- Include the 7-day shared limit only when the status bar has enough room or when the 5-hour limit is unavailable.
- If tier-specific 7-day limits exist, show them only when they better match the active model tier.

Example full format:

```text
🪙 5h 42% (↻ 1h20m)
```

### OpenAI Codex

- Prefer the provider's primary usage window.
- Use the secondary window when primary is unavailable or exhausted state is reported there.
- Show compact window labels so primary and weekly Codex limits stay distinguishable.

Example full format:

```text
🪙 5h 18% (↻ 2h05m) / W 35% (↻ 3d8h)
```

### Google Gemini CLI

- Prefer a bucket whose `scope.modelId` matches the active model id.
- If no exact model match exists, prefer a bucket whose tier matches the active model family, such as Flash or Pro.
- If no model/tier relationship can be established, show the best available Gemini quota bucket only if it has a numeric usage fraction.

Example full format:

```text
🪙 63% (↻ 23m)
```

### Future providers

For future OMP providers, the fallback rule is:

1. Filter reports to the active provider.
2. Prefer numeric percentage-style limits.
3. Prefer shorter reset windows.
4. Prefer warning/exhausted limits over normal limits.
5. Hide if the selected limit cannot be rendered without ambiguity.

## Data flow

1. OMP loads the plugin extension.
2. The plugin registers event listeners and initializes an empty status segment.
3. A refresh-triggering event occurs, such as session start, model change, turn end, retry end, or a timer tick.
4. The plugin schedules a usage refresh.
5. If another refresh is already in flight, the plugin marks itself dirty and waits for the current refresh to finish.
6. The refresh reads normalized usage reports from OMP.
7. The provider selector filters reports to the active provider.
8. The limit normalizer picks the best display limit(s).
9. The renderer formats a compact status segment.
10. The plugin updates the Pi status bar segment, or clears it when no valid segment exists.

## Refresh policy

- Event-driven refresh is primary.
- A low-frequency timer updates reset countdowns and catches provider-cache changes while the session is idle.
- Default timer interval: `60000` ms.
- Fetching must never happen synchronously inside the render path.
- At most one usage refresh may run at a time.
- Refresh failures must not throw unhandled errors and must not block the TUI.

## Display and configuration

Default configuration:

```json
{
  "enabled": true,
  "scope": "current-provider",
  "refreshIntervalMs": 60000,
  "showProviderLabel": "auto",
  "showReset": true,
  "warningThreshold": 0.8,
  "criticalThreshold": 0.95
}
```

Configuration affects display only. It must not change how OMP authenticates, fetches, ranks, or caches provider usage.

### Width-aware rendering

The renderer should degrade in this order:

1. Full: window/percentage/reset, e.g. `🪙 5h 18% (↻ 2h05m) / W 35% (↻ 3d8h)`.
2. Medium: window/percentage, e.g. `🪙 5h 18% / W 35%`.
3. Short: primary window/percentage, e.g. `🪙 5h 18%`.
4. Minimal: percentage only, e.g. `18%`.
5. Hidden when even the minimal segment cannot fit or would be misleading.

### Colors

- Normal: below `warningThreshold`.
- Warning: at or above `warningThreshold`.
- Critical: at or above `criticalThreshold`, or when the selected limit status is `exhausted`.

The plugin should use existing Pi theme tokens. If no dedicated usage token exists, it should reuse status-line spend/warning/error colors rather than requiring new theme fields.

## Error handling and privacy

- Missing usage reports: hide the segment.
- Unsupported provider: hide the segment.
- Missing or expired auth: hide the segment.
- Network failure: rely on OMP's cache/last-good behavior; do not create a separate provider-fetch cache in the plugin.
- Ambiguous limits: hide rather than guess.
- Multiple accounts or credentials: defer to OMP's aggregate usage/ranking behavior.
- Private identity fields must never be rendered.
- Errors should be logged at debug/warn level, not shown as repeated notifications.

## Testing strategy

Tests should target behavior and invariants rather than exact decorative strings.

Required coverage:

- Provider filtering:
  - Claude session shows only Anthropic/Claude usage.
  - Codex session shows only OpenAI Codex usage.
  - Gemini session prefers current model or tier.
- Missing data:
  - No report hides the segment.
  - No matching limit hides the segment.
  - Limits without numeric usage hide unless a safe provider-specific fallback exists.
- Limit selection:
  - Short windows beat long windows when both are normal.
  - Warning/exhausted limits are prioritized.
  - Reset time is rendered as relative time.
- Rendering:
  - Output degrades as available width shrinks.
  - No rendered output includes email, account id, org id, or project id.
- Refresh behavior:
  - Concurrent events coalesce into one in-flight refresh.
  - Fetch failure does not throw and does not block status rendering.

## Acceptance criteria

- Installing and enabling the plugin appends current-provider usage to the Pi status bar without removing existing status content.
- Claude, Codex, and Gemini display usage whenever OMP has normalized usage data for the active provider/model.
- Providers with no usage data show no usage segment.
- The plugin never implements provider-specific quota HTTP calls itself.
- The plugin does not expose private account identifiers in the status bar.
- Usage refreshes do not run in the render path and do not noticeably slow TUI interaction.
- The design remains compatible with future OMP usage providers that emit normalized `UsageReport` data.
