# Rapid Draw Ink

Rapid Draw Ink brings low-latency, responsive handwriting to Obsidian Excalidraw on Onyx Boox e-ink devices by bridging hardware-accelerated stylus strokes into Obsidian via a local WebSocket.

This project is a fork of [boox-rapid-draw](https://github.com/sergeylappo/boox-rapid-draw) by Sergey Lappo.

## How It Works

The original Boox Rapid Draw creates a floating raw-drawing overlay using the Onyx Android SDK to render zero-latency pen strokes on e-ink.

Rapid Draw Ink extends this by streaming raw Onyx stroke coordinates over a local WebSocket server (`ws://127.0.0.1:8765`). A companion Obsidian plugin (`ink-onyx-bridge`) listens on this socket and seamlessly swaps out Excalidraw native freedraw strokes for smooth, accurate strokes built from the high-frequency Onyx hardware points without ever blocking pen input.

The plugin also accounts for overlay offsets and display pixel ratios, sweeps duplicate native strokes, pauses raw drawing when the virtual keyboard/IME is active, auto-reloads Excalidraw views updated externally (e.g. via LiveSync), and provides palm rejection (ignoring touch inputs on canvas while the pen is active).

## Requirements

- Onyx Boox e-ink tablet (tested on Boox Note Air 5C).
- Obsidian Mobile app with the [Obsidian Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin) (tested with v2.15.3).
- Onyx refresh mode for Obsidian set to **Regal** (recommended for cleanest display with minimal ghosting).

(Note: Support for the Ink / tldraw plugin is currently experimental and not working reliably).

## Installation and Setup

1. **Install the Android App**:
   - Download and install `RapidDrawInk-0.2.0.apk` from the [Releases](https://github.com/rainyluna/boox-rapid-draw-ink/releases) page.
   - **Important**: Ensure the original Boox Rapid Draw is turned off or uninstalled to prevent overlay conflicts.
   - Launch Rapid Draw Ink and grant the "Display over other apps" permission when prompted.
   - **Prevent App Freezing**: In Onyx App Optimization for Rapid Draw Ink, set background activity to allowed / disable sleep freezing. If the app icon shows a snowflake badge, long-press the icon and select **Unfreeze**.

2. **Install the Companion Obsidian Plugin**:
   - Download `ink-onyx-bridge-0.2.0.zip` from Releases or copy the contents of `obsidian-plugin/` (`manifest.json` and `main.js`) into your vault directory at:
     `<vault>/.obsidian/plugins/ink-onyx-bridge/`
   - Open Obsidian, go to Settings -> Community plugins, reload installed plugins, and enable **Onyx Ink Bridge**.
   - Optional: Use the command palette command `Toggle palm rejection` to enable/disable touch blocking while drawing.

## Known Issues and Limitations

- Tested only on a Boox Note Air 5C. Behavior on other Onyx devices or Android versions may vary.
- Alignment offsets may occasionally occur depending on zoom level or layout orientation.
- Keyboard or OCR handwriting inputs may occasionally conflict with overlay drawing.
- Single-dot stray strokes can occasionally appear when lifting the stylus.
- If drawing stops responding, check if the Onyx system froze the background service.

## Built with AI Assistance

This fork was developed by Luna with significant AI assistance building upon Sergey Lappo original foundation.

## License

MIT License. See [LICENSE](LICENSE) for details.
- Original work Copyright (c) 2024 Sergey Lappo
- Fork additions Copyright (c) 2026 rainyluna
