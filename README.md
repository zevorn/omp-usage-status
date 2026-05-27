# OMP Usage Status

OMP plugin that appends current-provider usage to the Pi status bar.

```text
K ⟲ > (sub) ▶ 🪙 5h 9% (↻ 1h53m) / W 36% (↻ 3d8h) ───── session summary
```

## Features

- Shows usage for the active provider/model only.
- Preserves existing status-line content, including the `▶` marker and session summary.
- Shortens filler lines when needed so usage remains visible.
- Uses warning/critical colors from the OMP theme without adding a background.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Enable the status segment. |
| `refreshIntervalMs` | `60000` | Refresh interval for usage and reset countdowns. |
| `showReset` | `true` | Show relative reset time. |
| `warningThreshold` | `0.8` | Usage fraction for warning styling. |
| `criticalThreshold` | `0.95` | Usage fraction for critical styling. |

## License

MIT
