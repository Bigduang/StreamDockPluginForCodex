/**
 * PropertyInspector utilities
 * Adapted from MiraboxSpace/StreamDock-Plugin-SDK SDNodeJsSDK
 */

let $websocket, $uuid, $action, $context, $settings, $lang, $FileID = '';

// Send a message to the plugin backend
WebSocket.prototype.sendToPlugin = function (payload) {
    this.send(JSON.stringify({
        event: 'sendToPlugin',
        action: $action,
        context: $uuid,
        payload
    }));
};

// Set the key state from the property inspector
WebSocket.prototype.setState = function (state) {
    this.send(JSON.stringify({
        event: 'setState',
        context: $context,
        payload: { state }
    }));
};

// Open a URL from the property inspector
WebSocket.prototype.openUrl = function (url) {
    this.send(JSON.stringify({
        event: 'openUrl',
        payload: { url }
    }));
};

// Persist settings (debounced to avoid flooding)
WebSocket.prototype.saveData = $.debounce(function (payload) {
    this.send(JSON.stringify({
        event: 'setSettings',
        context: $uuid,
        payload
    }));
});

// StreamDock entry point – called by the software when the PI loads
async function connectElgatoStreamDeckSocket(port, uuid, event, app, info) {
    info = JSON.parse(info);
    $uuid    = uuid;
    $action  = info.action;
    $context = info.context;

    $websocket = new WebSocket('ws://127.0.0.1:' + port);
    $websocket.onopen = () => $websocket.send(JSON.stringify({ event, uuid }));

    $websocket.onmessage = (e) => {
        const data = JSON.parse(e.data);

        if (data.event === 'didReceiveSettings') {
            $settings = new Proxy(data.payload.settings, {
                get(target, property) {
                    return target[property];
                },
                set(target, property, value) {
                    target[property] = value;
                    $websocket.saveData(data.payload.settings);
                    return true;
                }
            });
            if (!$back) $dom.main.style.display = 'block';
        }

        $propEvent[data.event]?.(data.payload);
    };

    // Auto-translate if $local is enabled
    if (!$local) return;

    $lang = await new Promise((resolve) => {
        const req = new XMLHttpRequest();
        req.open('GET', `../../${JSON.parse(app).application.language}.json`);
        req.send();
        req.onreadystatechange = () => {
            if (req.readyState === 4) {
                resolve(JSON.parse(req.responseText).Localization);
            }
        };
    });

    const walker = document.createTreeWalker($dom.main, NodeFilter.SHOW_TEXT, (node) =>
        node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    );
    while (walker.nextNode()) {
        walker.currentNode.data = $lang[walker.currentNode.data] || walker.currentNode.data;
    }

    const translate = (item) => {
        if (item.placeholder?.trim()) {
            item.placeholder = $lang[item.placeholder] || item.placeholder;
        }
    };
    $('input', true).forEach(translate);
    $('textarea', true).forEach(translate);
}

// File picker callback
Array.from($('input[type="file"]', true)).forEach((item) =>
    item.addEventListener('click', () => { $FileID = item.id; })
);
const onFilePickerReturn = (url) => $emit.send(`File-${$FileID}`, JSON.parse(url));
