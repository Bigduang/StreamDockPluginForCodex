const { Plugins, Actions, log } = require('./utils/plugin');
const https = require('https');
const { execSync } = require('child_process');

const plugin = new Plugins();

// ── Ask Codex action ─────────────────────────────────────────────────────────
// Sends a user-defined prompt to the OpenAI Chat Completions API and copies
// the response text to the system clipboard.

plugin['ask-codex'] = new Actions({
    default: {
        apiKey: '',
        model: 'gpt-4o-mini',
        prompt: 'Explain this concept in one paragraph: ',
        maxTokens: 256,
        temperature: 0.7
    },

    _willAppear({ context }) {
        plugin.setTitle(context, 'Ask\nCodex');
    },

    _willDisappear() {},

    _propertyInspectorDidAppear({ context }) {
        const settings = this.data[context] || { ...this.default };
        plugin.sendToPropertyInspector({ event: 'getSettings', settings });
    },

    keyUp({ context, payload: { settings } }) {
        const cfg = Object.assign({ ...this.default }, settings || this.data[context]);

        if (!cfg.apiKey) {
            log.warn('ask-codex: No API key configured');
            plugin.setTitle(context, 'No\nAPI Key');
            plugin.showAlert(context);
            return;
        }

        const prompt = cfg.prompt || this.default.prompt;
        log.info(`ask-codex: Sending prompt: "${prompt}"`);
        plugin.setTitle(context, 'Wait...');

        const body = JSON.stringify({
            model: cfg.model || this.default.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : this.default.maxTokens,
            temperature: cfg.temperature !== undefined && cfg.temperature !== ''
                ? Number(cfg.temperature)
                : this.default.temperature
        });

        const options = {
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + cfg.apiKey,
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) {
                        log.error('ask-codex: API error:', json.error.message);
                        plugin.setTitle(context, 'Error');
                        plugin.showAlert(context);
                        return;
                    }
                    const text = json.choices?.[0]?.message?.content?.trim() || '';
                    copyToClipboard(text);
                    plugin.setTitle(context, 'Copied!');
                    plugin.showOk(context);
                    log.info('ask-codex: Response copied to clipboard');
                    // Reset title after 2 seconds
                    setTimeout(() => plugin.setTitle(context, 'Ask\nCodex'), 2000);
                } catch (err) {
                    log.error('ask-codex: Failed to parse response:', err);
                    plugin.setTitle(context, 'Error');
                    plugin.showAlert(context);
                }
            });
        });

        req.on('error', (err) => {
            log.error('ask-codex: Request error:', err);
            plugin.setTitle(context, 'Error');
            plugin.showAlert(context);
        });

        req.write(body);
        req.end();
    }
});

// ── Open ChatGPT action ───────────────────────────────────────────────────────
// Opens the configured URL (default: ChatGPT) in the system's default browser.

plugin['open-chatgpt'] = new Actions({
    default: {
        url: 'https://chatgpt.com'
    },

    _willAppear({ context }) {
        plugin.setTitle(context, 'Open\nChatGPT');
    },

    _willDisappear() {},

    _propertyInspectorDidAppear({ context }) {
        const settings = this.data[context] || { ...this.default };
        plugin.sendToPropertyInspector({ event: 'getSettings', settings });
    },

    keyUp({ context, payload: { settings } }) {
        const cfg = Object.assign({ ...this.default }, settings || this.data[context]);
        const url = cfg.url || this.default.url;
        plugin.openUrl(url);
        log.info(`open-chatgpt: Opened ${url}`);
    }
});

// ── Clipboard helper ──────────────────────────────────────────────────────────

function copyToClipboard(text) {
    try {
        if (process.platform === 'win32') {
            execSync('clip', { input: text });
        } else if (process.platform === 'darwin') {
            execSync('pbcopy', { input: text });
        } else {
            execSync('xclip -selection clipboard', { input: text });
        }
    } catch (err) {
        log.error('copyToClipboard: Failed to copy:', err);
    }
}
