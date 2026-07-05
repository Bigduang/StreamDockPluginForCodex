// StreamDock SDK utility for Node.js plugins
// Based on MiraboxSpace/StreamDock-Plugin-SDK SDNodeJsSDK

const path = require('path');
const fs = require('fs');
const now = new Date();
const logDir = path.join(__dirname, '..', 'log');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const log = require('log4js').configure({
    appenders: {
        file: {
            type: 'file',
            filename: path.join(logDir, `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.log`)
        }
    },
    categories: {
        default: { appenders: ['file'], level: 'info' }
    }
}).getLogger();

// Main thread error handling
process.on('uncaughtException', (error) => {
    log.error('Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason) => {
    log.error('Unhandled Rejection:', reason);
});

// Plugin class - connects to StreamDock via WebSocket
const WebSocket = require('ws');
class Plugins {
    static language = process.argv[5];

    constructor() {
        if (Plugins.instance) {
            return Plugins.instance;
        }
        this.ws = new WebSocket('ws://127.0.0.1:' + process.argv[2]);
        this.ws.on('open', () =>
            this.ws.send(JSON.stringify({ uuid: process.argv[3], event: process.argv[4] }))
        );
        this.ws.on('close', process.exit);
        this.ws.on('message', (e) => {
            const data = JSON.parse(e.toString());
            const action = data.action?.split('.').pop();
            this[action]?.[data.event]?.(data);
            this[data.event]?.(data);
        });
        Plugins.instance = this;
    }

    // Set the title on a key
    setTitle(context, str, row = 0, num = 6) {
        let newStr = '';
        if (row) {
            let nowRow = 1;
            const strArr = str.split('');
            strArr.forEach((item, index) => {
                if (nowRow < row && index >= nowRow * num) { nowRow++; newStr += '\n'; }
                if (nowRow <= row && index < nowRow * num) { newStr += item; }
            });
            if (strArr.length > row * num) { newStr = newStr.substring(0, newStr.length - 1); newStr += '..'; }
        }
        this.ws.send(JSON.stringify({
            event: 'setTitle',
            context,
            payload: { target: 0, title: newStr || str }
        }));
    }

    // Set key state
    setState(context, state) {
        this.ws.send(JSON.stringify({
            event: 'setState',
            context,
            payload: { state }
        }));
    }

    // Save persistent settings
    setSettings(context, payload) {
        this.ws.send(JSON.stringify({
            event: 'setSettings',
            context,
            payload
        }));
    }

    // Send data to property inspector
    sendToPropertyInspector(payload) {
        this.ws.send(JSON.stringify({
            action: Actions.currentAction,
            context: Actions.currentContext,
            payload,
            event: 'sendToPropertyInspector'
        }));
    }

    // Open URL in default browser
    openUrl(url) {
        this.ws.send(JSON.stringify({
            event: 'openUrl',
            payload: { url }
        }));
    }

    // Show alert (error indicator) on key
    showAlert(context) {
        this.ws.send(JSON.stringify({
            event: 'showAlert',
            context
        }));
    }

    // Show OK (success indicator) on key
    showOk(context) {
        this.ws.send(JSON.stringify({
            event: 'showOk',
            context
        }));
    }
}

// Action class - handles individual key actions
class Actions {
    constructor(data) {
        this.data = {};
        this.default = {};
        Object.assign(this, data);
    }

    static currentAction = null;
    static currentContext = null;

    propertyInspectorDidAppear(data) {
        Actions.currentAction = data.action;
        Actions.currentContext = data.context;
        this._propertyInspectorDidAppear?.(data);
    }

    willAppear(data) {
        const { context, payload: { settings } } = data;
        this.data[context] = Object.assign({ ...this.default }, settings);
        this._willAppear?.(data);
    }

    willDisappear(data) {
        this._willDisappear?.(data);
        delete this.data[data.context];
    }
}

module.exports = { log, Plugins, Actions };
