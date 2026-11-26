// ==UserScript==
// @name         Canvas Ghost Mode 4.3.0
// @namespace    http://tampermonkey.net/
// @version      4.3.0
// @description  In-page visibility masking, activity-request filtering, and hook diagnostics.
// @author       realdawgace, improvements for kindmops
// @match        *://*.instructure.com/*
// @include      /^https?:\/\/canvas\.[^/]+\.edu(?::\d+)?\/.*$/
// @run-at       document-start
// @sandbox      raw
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    // Replace older versions, then reload open Canvas tabs. No build step.
    // Hooks run in each matching frame; only the top document displays controls.
    // Local masking cannot hide server requests, browser extensions, worker traffic,
    // unmatched frames, cached native functions, or other network transports.
    // Blocked fetch rejects; blocked XHR send throws NetworkError; beacon returns false.
    // These explicit failures may cause callers to retry. No server response is fabricated.
    // Changed network methods are rewrapped at DOM ready, on Check page hooks, and every
    // three seconds. A replaced function can bypass filtering before the next check.
    // Canvas page-view route/method source:
    // https://github.com/instructure/canvas-lms/blob/master/ui/boot/initializers/trackPageViews.ts
    // Quiz-event route source:
    // https://developerdocs.instructure.com/services/canvas/resources/quiz_submission_events

    const CONFIG = Object.freeze({
        storageKey: 'canvas-ghost-mode:v4',
        instanceKey: '__canvasGhostModeV4',
        hostId: 'canvas-ghost-mode-v4',
        maxLogEntries: 60,
        renderDelayMs: 80,
        healthIntervalMs: 3000,
        edge: 12,
        panelWidth: 364,
        rules: [
            { name: 'page-view events', methods: ['POST'], path: /^\/(?:api\/v1\/)?page_views\/?$/ },
            { name: 'page-view updates', methods: ['PUT', 'PATCH', 'POST'], path: /^\/(?:api\/v1\/)?page_views\/[^/]+\/?$/ },
            { name: 'quiz activity', methods: ['POST'], path: /^\/api\/v1\/courses\/\d+\/quizzes\/\d+\/submissions\/[^/]+\/events\/?$/ }
        ]
    });
    if (window[CONFIG.instanceKey]) return;

    const state = { active: true, collapsed: false, focusMask: true, networkFilter: true, position: null };
    let blockedRequests = 0;
    const logs = [];
    const hooks = [];
    const networkHooks = [];
    const xhrRequests = new WeakMap();
    const nativeAdd = EventTarget.prototype.addEventListener;
    const xhrOpened = window.XMLHttpRequest?.OPENED ?? 1;
    const requestGetters = typeof Request === 'function' ? Object.getOwnPropertyDescriptors(Request.prototype) : {};
    let host;
    let renderTimer;
    let render = () => {};

    function readSettings(raw) {
        try {
            const saved = JSON.parse(raw || 'null');
            for (const key of ['active', 'collapsed', 'focusMask', 'networkFilter']) {
                if (typeof saved?.[key] === 'boolean') state[key] = saved[key];
            }
            const pos = saved?.position;
            if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) state.position = { x: pos.x, y: pos.y };
        } catch { /* Keep defaults when storage is unavailable or invalid. */ }
    }
    try { readSettings(localStorage.getItem(CONFIG.storageKey)); } catch { /* Optional storage. */ }

    function save() {
        try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(state)); } catch { /* Controls still work. */ }
    }
    function scheduleRender() {
        if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = undefined; render(); }, CONFIG.renderDelayMs);
    }
    function log(channel, message) {
        logs.push({ channel, message });
        if (logs.length > CONFIG.maxLogEntries) logs.shift();
        scheduleRender();
    }
    function recordRequest(channel, name) {
        blockedRequests += 1;
        log(channel, name);
    }
    function listen(target, type, handler, options) {
        nativeAdd.call(target, type, handler, options);
    }
    function sameDescriptor(a, b) {
        return Boolean(a && b && a.value === b.value && a.get === b.get && a.set === b.set);
    }
    function unavailable(id, label, reason) {
        hooks.push({ id, label, check: () => false, reason });
        log('system', `${label}: ${reason}`);
    }
    function patch(target, property, descriptor, id, label) {
        try {
            Object.defineProperty(target, property, { configurable: true, ...descriptor });
            const installed = Object.getOwnPropertyDescriptor(target, property);
            const check = () => sameDescriptor(Object.getOwnPropertyDescriptor(target, property), installed);
            hooks.push({ id, label, check, reason: 'changed by another script' });
        } catch {
            unavailable(id, label, 'hook unavailable');
        }
    }
    function inspectHooks() {
        return hooks.map(({ id, label, check, reason, readStatus }) => {
            if (readStatus) return { id, label, ...readStatus() };
            const ok = check();
            const status = ok ? 'ready' : reason === 'changed by another script' ? 'changed' : 'unavailable';
            return { id, label, ok, status, reason: ok ? 'installed' : reason };
        });
    }
    function manageNetworkHook(resolveTarget, property, createWrapper, id, label) {
        let installedTarget;
        let installedDescriptor;
        let failure = '';
        let lastNotice = '';
        let everInstalled = false;
        const check = () => {
            try {
                const target = resolveTarget();
                return Boolean(target && target === installedTarget && sameDescriptor(Object.getOwnPropertyDescriptor(target, property), installedDescriptor));
            } catch { return false; }
        };
        function note(reason) {
            if (reason !== lastNotice) { lastNotice = reason; log('system', `${label}: ${reason}`); }
        }
        const hook = {
            id, label,
            readStatus() {
                if (check()) return { ok: true, status: 'ready', reason: 'installed' };
                if (failure) return { ok: false, status: 'unavailable', reason: failure };
                return { ok: false, status: 'changed', reason: 'function replaced; reattachment pending' };
            },
            repair() {
                if (check()) return;
                try {
                    const target = resolveTarget();
                    const delegate = target?.[property];
                    if (!target || typeof delegate !== 'function') {
                        failure = 'API unavailable'; note(failure); return;
                    }
                    const before = Object.getOwnPropertyDescriptor(target, property);
                    if (before && !before.configurable && (!('value' in before) || !before.writable)) {
                        failure = 'property is locked'; note(failure); return;
                    }
                    // Each generation closes over its own immutable delegate. A page
                    // wrapper may retain an older generation without causing recursion.
                    const wrapper = createWrapper(delegate, target);
                    const descriptor = before && 'value' in before
                        ? { ...before, value: wrapper }
                        : { configurable: true, enumerable: before?.enumerable ?? true, writable: true, value: wrapper };
                    Object.defineProperty(target, property, descriptor);
                    const installed = Object.getOwnPropertyDescriptor(target, property);
                    installedTarget = target; installedDescriptor = installed; failure = '';
                    if (everInstalled || lastNotice) log('system', `${label}: hook reattached`);
                    everInstalled = true; lastNotice = '';
                } catch {
                    failure = 'repair failed; property could not be updated'; note(failure);
                }
            }
        };
        hooks.push(hook); networkHooks.push(hook); hook.repair();
    }
    function repairHooks() {
        for (const hook of networkHooks) hook.repair();
        render();
    }
    function maskProperty(property, maskedValue, label, optional = false) {
        let owner = document;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, property)) owner = Object.getPrototypeOf(owner);
        const descriptor = owner && Object.getOwnPropertyDescriptor(owner, property);
        if (!descriptor) { if (!optional) unavailable(property, label, 'API unavailable'); return; }
        const read = descriptor.get ? () => descriptor.get.call(document) : () => descriptor.value;
        patch(document, property, { get: () => state.active && state.focusMask ? maskedValue : read() }, property, label);
    }

    maskProperty('hidden', false, 'Hidden flag');
    maskProperty('visibilityState', 'visible', 'Page visibility');
    maskProperty('webkitHidden', false, 'Legacy hidden flag', true);
    maskProperty('webkitVisibilityState', 'visible', 'Legacy visibility', true);
    const nativeHasFocus = document.hasFocus;
    if (typeof nativeHasFocus === 'function') patch(document, 'hasFocus', {
        writable: true,
        value: function () { return state.active && state.focusMask ? true : Reflect.apply(nativeHasFocus, this, arguments); }
    }, 'focus', 'Page focus');
    else unavailable('focus', 'Page focus', 'API unavailable');

    const filterFocus = event => {
        // Element blur/focus events still reach editors and form validation.
        if (!state.active || !state.focusMask || (event.target !== document && event.target !== window)) return;
        event.stopImmediatePropagation();
    };
    for (const type of ['visibilitychange', 'webkitvisibilitychange', 'blur', 'focus', 'mouseleave']) {
        listen(window, type, filterFocus, true);
    }

    function matchRule(input, method) {
        if (!state.active || !state.networkFilter) return null;
        try {
            const url = new URL(input, document.baseURI);
            if (url.origin !== location.origin) return null;
            const path = decodeURIComponent(url.pathname);
            return CONFIG.rules.find(rule => rule.methods.includes(String(method).toUpperCase()) && rule.path.test(path)) || null;
        } catch { return null; }
    }
    function requestInfo(input) {
        // Native getters recognize Request objects from other same-origin realms.
        try {
            return {
                url: requestGetters.url.get.call(input),
                method: requestGetters.method.get.call(input),
                signal: requestGetters.signal.get.call(input)
            };
        } catch { return { url: input, method: 'GET', signal: null }; }
    }
    manageNetworkHook(() => window, 'fetch', delegate => {
        return function (input, init) {
            const request = requestInfo(input);
            const rule = matchRule(request.url, init?.method ?? request.method);
            if (rule) {
                const signal = init?.signal === undefined ? request.signal : init.signal;
                if (signal?.aborted) return Promise.reject(signal.reason);
                recordRequest('fetch', rule.name);
                return Promise.reject(new TypeError(`Canvas Ghost Mode blocked ${rule.name}`));
            }
            return Reflect.apply(delegate, this, arguments);
        };
    }, 'fetch', 'Fetch');

    manageNetworkHook(() => window.XMLHttpRequest?.prototype, 'open', delegate => {
        return function (method, url) {
            const previous = xhrRequests.get(this);
            let resolved;
            try { resolved = new URL(url, document.baseURI).href; } catch { resolved = ''; }
            const next = { method, url: resolved };
            // open() emits OPENED synchronously; handlers may send or open again.
            xhrRequests.set(this, next);
            try { return Reflect.apply(delegate, this, arguments); }
            catch (error) {
                if (xhrRequests.get(this) === next) {
                    if (previous) xhrRequests.set(this, previous);
                    else xhrRequests.delete(this);
                }
                throw error;
            }
        };
    }, 'xhr-open', 'XHR routing');
    manageNetworkHook(() => window.XMLHttpRequest?.prototype, 'send', (delegate, target) => {
        const abort = target.abort;
        return function () {
            const request = xhrRequests.get(this);
            const rule = request && this.readyState === xhrOpened && matchRule(request.url, request.method);
            if (rule) {
                recordRequest('xhr', rule.name);
                if (typeof abort === 'function') Reflect.apply(abort, this, []);
                throw new DOMException(`Canvas Ghost Mode blocked ${rule.name}`, 'NetworkError');
            }
            return Reflect.apply(delegate, this, arguments);
        };
    }, 'xhr-send', 'XHR filtering');
    manageNetworkHook(() => navigator, 'sendBeacon', delegate => {
        return function (url) {
            const rule = matchRule(url, 'POST');
            if (rule) { recordRequest('beacon', rule.name); return false; }
            return Reflect.apply(delegate, this, arguments);
        };
    }, 'beacon', 'Beacon');

    function setActive(value) {
        state.active = Boolean(value);
        save();
        log('system', state.active ? 'in-page filters resumed' : 'in-page filters paused');
        render();
    }
    listen(window, 'storage', event => {
        if (!event.isTrusted || event.key !== CONFIG.storageKey) return;
        readSettings(event.newValue);
        render();
    });

    // UI is intentionally confined to the top document. Every matching frame has
    // its own hook status/counters; the panel does not claim to aggregate them.
    function mount() {
        if (window.top !== window.self || !document.body) return;
        if (host) {
            if (host.parentNode !== document.body) document.body.appendChild(host);
            return;
        }
        host = document.createElement('div');
        host.id = CONFIG.hostId;
        host.style.cssText = `all:initial!important;position:fixed!important;right:${CONFIG.edge}px!important;bottom:${CONFIG.edge}px!important;z-index:2147483647!important;display:block!important;`;
        const shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = `
            :host {
                color-scheme:dark;
                --accent:#9b4dff;
                --accent-rgb:155,77,255;
                --muted:#a398b7;
                --line:#3c2257;
                --frame:#1b1626;
                --frame-hover:#2a203d;
                --text:#e8e3f2;
            }
            * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
            [hidden] { display:none!important; }
            .panel {
                width:min(${CONFIG.panelWidth}px,calc(100vw - ${CONFIG.edge * 2}px));
                max-height:calc(100dvh - ${CONFIG.edge * 2}px);
                overflow:auto;
                border:1px solid var(--line);
                border-radius:4px;
                background:rgba(14,12,20,.96);
                color:var(--text);
                box-shadow:0 14px 38px #0009,0 0 20px rgba(var(--accent-rgb),.17),0 0 6px rgba(var(--accent-rgb),.10);
                backdrop-filter:blur(8px);
                font:12px/1.35 "Segoe UI",system-ui,-apple-system,sans-serif;
                text-align:left;
                scrollbar-width:thin;
                scrollbar-color:#55317f #100d17;
            }
            button, input { font:inherit; }
            button { cursor:pointer; transition:background-color 100ms ease,border-color 100ms ease,color 100ms ease; }
            button:focus-visible, input:focus-visible { outline:1px solid #cba3ff; outline-offset:2px; }
            header {
                display:flex;
                align-items:center;
                gap:5px;
                height:26px;
                padding:0 6px;
                border-bottom:1px solid rgba(var(--accent-rgb),.26);
                border-radius:3px 3px 0 0;
                background:linear-gradient(180deg,rgba(var(--accent-rgb),.22),rgba(var(--accent-rgb),.12));
                touch-action:none;
                cursor:grab;
                user-select:none;
            }
            header:active { cursor:grabbing; }
            .brand { display:flex; align-items:center; justify-content:space-between; gap:8px; flex:1; min-width:0; }
            .brand b { font-size:12px; font-weight:500; letter-spacing:.1px; white-space:nowrap; }
            .brand small { overflow:hidden; color:#b3a5c9; font:9px Consolas,ui-monospace,monospace; white-space:nowrap; text-overflow:ellipsis; }
            .icon { display:grid; place-items:center; flex-shrink:0; width:18px; height:18px; padding:0; border:0; border-radius:2px; background:transparent; color:#d6cbe8; font:12px/1 "Segoe UI",sans-serif; }
            .icon:hover { background:rgba(var(--accent-rgb),.34); color:#fff; }
            .tabs { display:flex; align-items:flex-end; gap:2px; padding:6px 8px 0; border-bottom:1px solid rgba(var(--accent-rgb),.34); }
            .tab { position:relative; bottom:-1px; padding:4px 10px; border:1px solid transparent; border-radius:3px 3px 0 0; background:#171322; color:var(--muted); font-size:12px; font-weight:500; }
            .tab:hover { background:var(--frame-hover); color:#e0d7ee; }
            .tab[aria-selected=true] { background:#332044; color:#fff; border-color:rgba(var(--accent-rgb),.45); border-bottom-color:#130f1c; }
            .tab[aria-selected=true]::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; border-radius:2px 2px 0 0; background:var(--accent); }
            .body { padding:8px 10px 10px; }
            .eyebrow { display:flex; align-items:center; gap:7px; margin:0; color:var(--muted); font:10px/1.35 Consolas,ui-monospace,monospace; letter-spacing:.2px; }
            .eyebrow::before { content:''; width:14px; height:1px; background:rgba(var(--accent-rgb),.32); flex-shrink:0; }
            .eyebrow::after { content:''; flex:1; height:1px; background:rgba(var(--accent-rgb),.26); }
            .headline { display:flex; align-items:center; gap:7px; margin:2px 0 0; font-size:12px; font-weight:500; }
            .headline::after { content:''; flex:1; height:1px; background:rgba(var(--accent-rgb),.26); }
            .dot { width:5px; height:5px; background:var(--accent); box-shadow:0 0 5px rgba(var(--accent-rgb),.4); flex-shrink:0; }
            .panel[data-status=paused] .dot, .panel[data-status=limited] .dot { background:#eab571; box-shadow:none; }
            .sub { margin:5px 0 8px; color:var(--muted); font-size:10.5px; line-height:1.4; }
            .metrics { display:grid; gap:4px; margin:0 0 9px; }
            .metric { display:grid; grid-template-columns:72px minmax(0,1fr); gap:8px; align-items:center; }
            .metric strong { display:grid; place-items:center; min-height:22px; border:1px solid rgba(var(--accent-rgb),.23); border-radius:2px; background:linear-gradient(90deg,rgba(var(--accent-rgb),.18),rgba(var(--accent-rgb),.07)); color:#f2ecfa; font:500 12px Consolas,ui-monospace,monospace; }
            .metric span { color:#cbc1db; font-size:11px; }
            .row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; min-height:23px; margin:3px 0; padding:3px 6px; border:1px solid #282032; border-radius:2px; background:var(--frame); color:#cfc6dd; font-size:11px; }
            .ok { color:#c59dff; } .warn { color:#eab571; }
            .row code { font:10px Consolas,ui-monospace,monospace; text-align:right; }
            .health-head, .activity-head { display:flex; align-items:center; gap:7px; margin:8px 0 5px; }
            .health-head .eyebrow, .activity-head .eyebrow { flex:1; }
            .link, .primary { border:1px solid rgba(var(--accent-rgb),.46); border-radius:2px; background:rgba(var(--accent-rgb),.22); color:#eee6fb; font-weight:500; }
            .link { padding:3px 6px; font-size:10px; line-height:1.3; white-space:nowrap; }
            .primary { display:block; width:100%; height:26px; margin-top:8px; padding:2px 8px; font-size:12px; }
            .link:hover, .primary:hover { background:rgba(var(--accent-rgb),.36); border-color:rgba(var(--accent-rgb),.72); }
            .link:active, .primary:active { background:rgba(var(--accent-rgb),.56); }
            .note { margin:8px 0 0; padding-top:7px; border-top:1px solid rgba(var(--accent-rgb),.23); color:var(--muted); font-size:10px; line-height:1.45; }
            .activity-head { margin-top:2px; }
            .activity { list-style:none; padding:0; margin:0; height:210px; overflow:auto; border:1px solid #2d223b; border-radius:2px; background:#100c18; scrollbar-width:thin; scrollbar-color:#55317f #100d17; }
            .entry { display:grid; grid-template-columns:48px minmax(0,1fr); align-items:start; gap:8px; padding:6px; border-bottom:1px solid #251b31; font-size:11px; overflow-wrap:anywhere; }
            .entry b { padding-top:1px; color:#bd91f7; font:10px Consolas,ui-monospace,monospace; text-transform:uppercase; }
            .entry p { margin:0; color:#cfc5de; }
            .empty { color:var(--muted); padding:24px 8px; text-align:center; font-size:11px; }
            .setting { display:flex; align-items:flex-start; gap:8px; padding:5px 0 8px; border-bottom:1px solid rgba(var(--accent-rgb),.20); cursor:pointer; }
            .setting + .setting { margin-top:4px; }
            .setting input { appearance:none; display:grid; place-content:center; margin:1px 0 0; width:18px; height:18px; flex-shrink:0; border:1px solid #3b2a50; border-radius:2px; background:var(--frame); cursor:pointer; }
            .setting:hover input { border-color:rgba(var(--accent-rgb),.45); background:var(--frame-hover); }
            .setting input:checked::after { content:''; width:5px; height:9px; margin-top:-2px; border:solid var(--accent); border-width:0 2px 2px 0; transform:rotate(45deg); }
            .setting b { display:block; font-size:12px; font-weight:400; }
            .setting small { display:block; margin-top:3px; color:var(--muted); font-size:10.5px; line-height:1.4; }
            kbd { min-width:87px; padding:2px 5px; border:1px solid #39274d; border-radius:2px; background:var(--frame); color:#d1bde9; font:10px Consolas,ui-monospace,monospace; text-align:center; }
            .shortcut { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:7px; color:#b3a6c5; font-size:10.5px; }
            .collapsed { width:280px; }
            .collapsed header { border-bottom:0; border-radius:3px; }
            .collapsed .brand small { font-size:9px; }
            @media (forced-colors:active) { .setting input { appearance:auto; } .setting input:checked::after { content:none; } }
            @media (prefers-reduced-motion:reduce) { button { transition:none; } }
            @media print { .panel { display:none; } }
            @media (max-height:420px) { .activity { height:150px; } }
        `;
        function el(tag, className, text) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }
        function button(className, label) { const node = el('button', className, label); node.type = 'button'; return node; }
        const panel = el('section', 'panel');
        panel.setAttribute('aria-label', 'Canvas Ghost Mode controls');
        const header = el('header');
        header.setAttribute('data-drag-handle', '');
        header.title = 'Drag to move';
        const brand = el('div', 'brand');
        const versionLabel = 'IN-PAGE CONTROLS / 4.3.0';
        const version = el('small', '', versionLabel);
        brand.append(el('b', '', 'ghost mode'), version);
        const fold = button('icon', '▾');
        fold.setAttribute('aria-controls', 'ghost-content');
        header.append(fold, brand);
        const content = el('div'); content.id = 'ghost-content';
        const tabs = el('div', 'tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Ghost Mode views');
        const panels = {};
        const tabButtons = {};
        let selected = 'Status';
        function selectTab(name, moveFocus = false) {
            selected = name;
            for (const label of Object.keys(panels)) {
                panels[label].hidden = label !== name;
                tabButtons[label].setAttribute('aria-selected', String(label === name));
                tabButtons[label].tabIndex = label === name ? 0 : -1;
            }
            if (moveFocus) tabButtons[name].focus();
        }
        for (const name of ['Status', 'Activity', 'Settings']) {
            const tab = button('tab', name); tab.id = `ghost-tab-${name}`; tab.setAttribute('role', 'tab');
            const body = el('div', 'body'); body.id = `ghost-view-${name}`; body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', tab.id);
            tab.setAttribute('aria-controls', body.id);
            tabs.append(tab); panels[name] = body; tabButtons[name] = tab;
            listen(tab, 'click', () => selectTab(name));
            listen(tab, 'keydown', event => {
                const names = Object.keys(tabButtons);
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 : (names.indexOf(selected) + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
                selectTab(names[index], true);
            });
        }
        const title = el('span');
        const headline = el('h2', 'headline'); headline.append(el('span', 'dot'), title);
        const summary = el('p', 'sub');
        const statGrid = el('div', 'metrics');
        const requestCount = el('strong', '', '0');
        const ruleCount = el('strong', '', String(CONFIG.rules.length));
        for (const [number, label] of [[requestCount, 'in-page requests blocked'], [ruleCount, 'configured request rules']]) {
            const metric = el('div', 'metric'); metric.append(number, el('span', '', label)); statGrid.append(metric);
        }
        const healthHead = el('div', 'health-head');
        const healthLabel = el('p', 'eyebrow');
        const check = button('link', 'Check page hooks'); healthHead.append(healthLabel, check);
        const healthList = el('div');
        const healthRows = new Map();
        const healthGroups = [
            { label: 'Page visibility', ids: ['hidden', 'visibilityState', 'webkitHidden', 'webkitVisibilityState'] },
            { label: 'Page focus', ids: ['focus'] },
            { label: 'Fetch', ids: ['fetch'] },
            { label: 'XMLHttpRequest', ids: ['xhr-open', 'xhr-send'] },
            { label: 'Beacon', ids: ['beacon'] }
        ];
        for (const group of healthGroups) {
            const row = el('div', 'row'); const value = el('code');
            row.append(el('span', '', group.label), value); healthList.append(row); healthRows.set(group.label, value);
        }
        const pause = button('primary', 'Pause in-page filters');
        const diagnostics = el('p', 'note warn'); diagnostics.hidden = true;
        diagnostics.setAttribute('role', 'status');
        const scopeText = 'Pause applies to in-page filters. If the browser extension is enabled, its network rules stay active.';
        panels.Status.append(headline, summary, statGrid, healthHead, healthList, diagnostics, pause, el('p', 'note', scopeText));
        const activityHead = el('div', 'activity-head');
        const clear = button('link', 'Clear activity');
        activityHead.append(el('p', 'eyebrow', 'IN-PAGE DIAGNOSTICS'), clear);
        const activity = el('ol', 'activity'); activity.setAttribute('aria-label', 'Recent filter activity');
        panels.Activity.append(activityHead, activity, el('p', 'note', `Last ${CONFIG.maxLogEntries} request and hook notices in this document.`));
        const inputs = {};
        for (const [key, label, description] of [
            ['focusMask', 'Mask page visibility and focus', 'Report the document as visible and focused.'],
            ['networkFilter', 'Filter in-page activity requests', 'Apply the configured rules to this document’s fetch, XHR and beacon calls.']
        ]) {
            const row = el('label', 'setting'); const input = el('input'); input.type = 'checkbox'; input.setAttribute('aria-label', label);
            const text = el('span'); text.append(el('b', '', label), el('small', '', description)); row.append(input, text); panels.Settings.append(row); inputs[key] = input;
            listen(input, 'change', () => { state[key] = input.checked; save(); log('system', `${key === 'focusMask' ? 'visibility masking' : 'request filtering'} ${input.checked ? 'enabled' : 'disabled'}`); render(); });
        }
        panels.Settings.append(el('p', 'note', scopeText));
        for (const [name, keys] of [['Collapse / expand', 'Alt Shift G'], ['Pause / resume in-page filters', 'Alt Shift P']]) {
            const row = el('div', 'shortcut'); row.append(el('span', '', name), el('kbd', '', keys)); panels.Settings.append(row);
        }
        const reset = button('link', 'Reset panel position'); reset.style.marginTop = '9px'; panels.Settings.append(reset);
        content.append(tabs, panels.Status, panels.Activity, panels.Settings);
        panel.append(header, content); shadow.append(style, panel); document.body.appendChild(host);

        function place() {
            if (!state.position) return;
            const bounds = host.getBoundingClientRect();
            const x = Math.max(CONFIG.edge, Math.min(state.position.x, innerWidth - bounds.width - CONFIG.edge));
            const y = Math.max(CONFIG.edge, Math.min(state.position.y, innerHeight - bounds.height - CONFIG.edge));
            host.style.setProperty('left', `${x}px`, 'important'); host.style.setProperty('top', `${y}px`, 'important');
            host.style.setProperty('right', 'auto', 'important'); host.style.setProperty('bottom', 'auto', 'important');
        }
        let lastLogKey = '';
        render = () => {
            const hookStatus = inspectHooks();
            const healthy = hookStatus.filter(hook => hook.ok).length;
            const limited = healthy !== hookStatus.length || !state.focusMask || !state.networkFilter;
            panel.dataset.status = state.active ? limited ? 'limited' : 'on' : 'paused';
            title.textContent = state.active ? limited ? 'Limited in-page coverage' : 'In-page filters on' : 'In-page filters paused';
            summary.textContent = state.active ? `${state.focusMask ? 'Visibility masking enabled' : 'Visibility masking off'} · ${state.networkFilter ? 'request filter enabled' : 'request filter off'}` : 'Resume to apply visibility masking and request rules in this document.';
            panel.classList.toggle('collapsed', state.collapsed);
            content.hidden = state.collapsed;
            version.textContent = state.collapsed ? title.textContent : versionLabel;
            fold.textContent = state.collapsed ? '▸' : '▾';
            fold.setAttribute('aria-label', state.collapsed ? 'Expand panel' : 'Collapse panel'); fold.setAttribute('aria-expanded', String(!state.collapsed));
            pause.textContent = state.active ? 'Pause in-page filters' : 'Resume in-page filters';
            requestCount.textContent = blockedRequests.toLocaleString();
            healthLabel.textContent = `PAGE HOOKS · ${healthy}/${hookStatus.length}`;
            for (const group of healthGroups) {
                const members = hookStatus.filter(hook => group.ids.includes(hook.id));
                const ok = members.length > 0 && members.every(hook => hook.ok);
                const value = healthRows.get(group.label); value.className = ok ? 'ok' : 'warn';
                value.textContent = ok ? 'ready' : members.some(hook => hook.reason === 'property is locked') ? 'locked' : members.some(hook => hook.status === 'unavailable') ? 'unavailable' : 'reattaching';
                value.title = members.map(hook => `${hook.label}: ${hook.reason}`).join('\n');
            }
            const failed = hookStatus.filter(hook => !hook.ok);
            diagnostics.hidden = failed.length === 0;
            diagnostics.textContent = failed.map(hook => `${hook.label}: ${hook.reason}.`).join(' ');
            for (const [key, input] of Object.entries(inputs)) input.checked = state[key];
            const logKey = JSON.stringify(logs);
            if (logKey !== lastLogKey) {
                lastLogKey = logKey; activity.replaceChildren();
                if (!logs.length) activity.append(el('li', 'empty', 'No recent activity.'));
                for (const entry of logs.slice().reverse()) {
                    const row = el('li', 'entry'); row.append(el('b', '', entry.channel), el('p', '', entry.message)); activity.append(row);
                }
            }
            place();
        };
        listen(pause, 'click', () => setActive(!state.active));
        listen(fold, 'click', () => { state.collapsed = !state.collapsed; save(); render(); });
        listen(clear, 'click', () => { logs.length = 0; render(); });
        listen(check, 'click', () => {
            repairHooks();
            const failed = inspectHooks().filter(hook => !hook.ok);
            log('system', failed.length ? `${failed.length} page hooks need attention` : 'all page hooks verified');
            render();
        });
        listen(reset, 'click', () => { state.position = null; host.style.removeProperty('left'); host.style.removeProperty('top'); host.style.setProperty('right', `${CONFIG.edge}px`, 'important'); host.style.setProperty('bottom', `${CONFIG.edge}px`, 'important'); save(); render(); });
        listen(window, 'resize', place);
        let drag = null;
        listen(header, 'pointerdown', event => {
            if (event.button !== 0 || event.target.closest('button')) return;
            const bounds = host.getBoundingClientRect(); drag = { id: event.pointerId, x: event.clientX - bounds.left, y: event.clientY - bounds.top };
            header.setPointerCapture(event.pointerId);
        });
        listen(header, 'pointermove', event => { if (!drag || event.pointerId !== drag.id) return; state.position = { x: event.clientX - drag.x, y: event.clientY - drag.y }; place(); });
        const dragCleanup = () => { if (drag && header.hasPointerCapture(drag.id)) header.releasePointerCapture(drag.id); drag = null; };
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(header, type, () => { dragCleanup(); save(); });
        listen(window, 'keydown', event => {
            if (!event.isTrusted || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.repeat) return;
            if (event.code === 'KeyG') { event.preventDefault(); state.collapsed = !state.collapsed; save(); render(); }
            if (event.code === 'KeyP') { event.preventDefault(); setActive(!state.active); }
        });
        selectTab('Status'); render();
    }

    Object.defineProperty(window, CONFIG.instanceKey, { value: true });
    log('system', 'page hooks initialized');
    function refreshPage() {
        mount();
        repairHooks();
    }
    setInterval(refreshPage, CONFIG.healthIntervalMs);
    listen(document, 'DOMContentLoaded', refreshPage, { once: true });
    if (document.body) mount();
})();
