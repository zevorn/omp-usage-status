# OMP Usage Status

OMP plugin that shows current-provider usage in the Pi status bar.

```text
K ⟲ > (sub) ▶ 🪙 5h 9% (↻ 1h53m) / W 36% (↻ 3d8h) ───── session summary
```

## Features

- Shows usage for the active provider/model only.
- Preserves existing status-line content, including the `▶` marker and session summary.
- Overlays usage after `▶` only when existing filler has room; otherwise hides usage instead of moving right-side content.
- Suppresses shutdown-time redraws so `/exit` returns to a clean shell prompt.
- Uses warning/critical colors from the OMP theme without adding a background to the usage segment.

## Install

Install from GitHub until the npm package is published:

```sh
mkdir -p ~/.omp/plugins
cd ~/.omp/plugins
npm install github:zevorn/omp-usage-status
omp plugin doctor
```

Restart OMP after installation.

After the package is published to npm, OMP's plugin installer can be used when `bun` is available on `PATH`:

```sh
omp plugin install @oh-my-pi/omp-usage-status
omp plugin list
omp plugin doctor
```

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
