/**
 * Common utilities for property inspector pages
 * Adapted from MiraboxSpace/StreamDock-Plugin-SDK SDNodeJsSDK
 */

// Custom event bus
class EventPlus {
    constructor() {
        this.event = new EventTarget();
    }
    on(name, callback) {
        this.event.addEventListener(name, (e) => callback(e.detail));
    }
    send(name, data) {
        this.event.dispatchEvent(new CustomEvent(name, {
            detail: data,
            bubbles: false,
            cancelable: false
        }));
    }
}

// Utility extensions
String.prototype.fill = function () {
    return this >= 10 ? this : '0' + this;
};

// Global helpers and query shortcut
const $emit = new EventPlus();

/**
 * $ – shortcut for querySelector / querySelectorAll
 * @param {string} selector
 * @param {boolean} isAll  – when true, returns an array of all matching elements
 */
const $ = (selector, isAll = false) => {
    const methods = {
        on(event, callback) {
            this.addEventListener(event, callback);
            return this;
        },
        attr(name, value) {
            if (value !== undefined) this.setAttribute(name, value);
            return this;
        }
    };

    if (isAll) {
        return Array.from(document.querySelectorAll(selector)).map((el) =>
            Object.assign(el, methods)
        );
    }

    const el = document.querySelector(selector);
    if (!el) {
        console.warn(`$ selector "${selector}" returned no element`);
        return null;
    }
    return Object.assign(el, methods);
};

// Shorthand that throws if element is missing (useful for required elements)
const $$ = (selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`HTML element "${selector}" not found`);
    return Object.assign(el, {
        on(event, callback) { this.addEventListener(event, callback); return this; }
    });
};

// Throttle
$.throttle = (fn, delay = 200) => {
    let timer = null;
    return function (...args) {
        if (timer) return;
        timer = setTimeout(() => {
            fn.apply(this, args);
            timer = null;
        }, delay);
    };
};

// Debounce
$.debounce = (fn, delay = 300) => {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
};

// Restrict input fields to digits only
Array.from(document.querySelectorAll('input[type="num"]') || []).forEach((item) => {
    item.addEventListener('input', function limitNum() {
        if (!item.value || /^\d+$/.test(item.value)) return;
        item.value = item.value.slice(0, -1);
    });
});

// Quick id-selector helper
const $id = (id) => document.getElementById(id);
const $hash = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element #${id} not found`);
    return el;
};
