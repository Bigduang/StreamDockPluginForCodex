# StreamDockPluginForCodex

A [StreamDock](https://www.mirabox.com/) plugin that integrates **OpenAI Codex / ChatGPT** into your StreamDock workflow, letting you trigger AI-powered code assistance and open ChatGPT directly from your programmable keys.

---

## Features

| Action | Description |
|--------|-------------|
| **Ask Codex** | Sends a configurable prompt to the OpenAI Chat Completions API and copies the response to your system clipboard |
| **Open ChatGPT** | Opens ChatGPT (or any custom URL) in your default browser |

---

## Requirements

- [StreamDock](https://www.mirabox.com/) software **≥ 2.9** (Windows 10 / macOS 10.13+)
- An [OpenAI API key](https://platform.openai.com/api-keys) (for the **Ask Codex** action)
- Node.js **≥ 18** (only needed to build the plugin backend from source)

---

## Installation

### Pre-built (recommended)

1. Download the latest release ZIP from the [Releases](../../releases) page.
2. Unzip and place the `com.bigduang.streamdock.codex.sdPlugin` folder inside the StreamDock plugins directory:
   - **Windows**: `%APPDATA%\HotSpot\StreamDock\plugins\`
   - **macOS**: `~/Library/Application Support/HotSpot/StreamDock/plugins/`
3. Restart StreamDock.

### Build from source

```bash
cd com.bigduang.streamdock.codex.sdPlugin/plugin
npm install
npm run build
```

After building, copy the entire `com.bigduang.streamdock.codex.sdPlugin` folder to the StreamDock plugins directory as described above.

---

## Configuration

### Ask Codex

Open the property inspector for the **Ask Codex** key:

| Field | Description | Default |
|-------|-------------|---------|
| **API Key** | Your OpenAI secret key (`sk-…`) | *(required)* |
| **Model** | OpenAI model to use | `gpt-4o-mini` |
| **Prompt** | The prompt sent on each key press | `Explain this concept in one paragraph: ` |
| **Max Tokens** | Maximum response length | `256` |
| **Temperature** | Response creativity (0 = deterministic, 2 = very creative) | `0.7` |

### Open ChatGPT

| Field | Description | Default |
|-------|-------------|---------|
| **URL** | URL to open in the browser | `https://chatgpt.com` |

---

## Plugin Structure

```
com.bigduang.streamdock.codex.sdPlugin/
├── manifest.json                    # Plugin metadata & actions
├── en.json                          # English localisation
├── zh_CN.json                       # Simplified Chinese localisation
├── plugin/
│   ├── index.js                     # Backend entry point (Node.js)
│   ├── package.json                 # npm dependencies
│   └── utils/
│       └── plugin.js                # StreamDock WebSocket SDK
├── propertyInspector/
│   ├── askCodex/
│   │   ├── index.html               # Ask Codex configuration UI
│   │   └── index.js                 # Ask Codex configuration logic
│   ├── openChatGPT/
│   │   ├── index.html               # Open ChatGPT configuration UI
│   │   └── index.js                 # Open ChatGPT configuration logic
│   └── utils/
│       ├── action.js                # StreamDock property inspector SDK
│       └── common.js                # Shared utilities ($ helper, event bus)
└── static/
    ├── css/
    │   └── sdpi.css                 # Standard StreamDock property inspector styles
    └── icons/
        ├── plugin.svg               # Plugin / category icon
        ├── ask-codex.svg            # Ask Codex action icon
        └── open-chatgpt.svg         # Open ChatGPT action icon
```

---

## Privacy & Security

- Your OpenAI API key is stored locally inside the StreamDock settings file and is **never** transmitted anywhere other than `api.openai.com`.
- No telemetry or analytics are collected.

---

## License

MIT © Bigduang
