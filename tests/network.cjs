// Network receipts from a fresh Chromium profile. All fixture DNS names resolve to loopback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const extension = path.join(__dirname, '../extension');
const browserOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' };
const artifacts = path.join(__dirname, '../test-results');
fs.mkdirSync(artifacts, { recursive: true });
const hosts = ['ghost-test.instructure.com', 'canvas.fixture.edu', 'unrelated.test', 'instructure.com.evil.test'];
const receipts = [];
const workerCode = `
async function deliver(event) {
  let result;
  try { result = (await fetch(event.data, {method:'PUT',body:'worker sample'})).status; }
  catch (e) { result = e.name; }
  (event.ports[0] || self).postMessage(result);
}
self.addEventListener('message', event => {
  const promise = deliver(event);
  if (event.waitUntil) event.waitUntil(promise);
});
`;
const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', data => chunks.push(data));
    req.on('end', () => {
        const url = new URL(req.url, 'http://' + req.headers.host);
        if (url.searchParams.has('case')) receipts.push({
            test: url.searchParams.get('case'), host: url.hostname,
            path: url.pathname, method: req.method, body: Buffer.concat(chunks).toString()
        });
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
        res.setHeader('Cache-Control', 'no-store');
        if (url.pathname === '/fixture') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<!doctype html><title>Loopback network fixture</title><main>Local fixture</main>');
        } else if (['/worker.js', '/sw.js'].includes(url.pathname)) {
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(workerCode + (url.pathname === '/sw.js' ?
                "self.addEventListener('install', e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate', e=>e.waitUntil(clients.claim()));" : ''));
        } else if (req.method === 'OPTIONS') {
            res.writeHead(204); res.end();
        } else {
            res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('delivered');
        }
    });
});

async function nativeWorld(context, page) {
    const session = await context.newCDPSession(page);
    const { frameTree } = await session.send('Page.getFrameTree');
    const { executionContextId } = await session.send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id, worldName: 'ghost-network-native-verification'
    });
    async function evaluate(fn, argument) {
        const result = await session.send('Runtime.callFunctionOn', {
            executionContextId, functionDeclaration: fn.toString(),
            arguments: argument === undefined ? [] : [{ value: argument }],
            awaitPromise: true, returnByValue: true
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
    // The shipping content script runs in MAIN. This browser-created isolated world
    // exposes a separate set of untouched built-ins from the same document origin.
    const native = await evaluate(() => {
        window.savedFetch = fetch.bind(window);
        window.savedOpen = XMLHttpRequest.prototype.open;
        window.savedSend = XMLHttpRequest.prototype.send;
        window.savedBeacon = navigator.sendBeacon.bind(navigator);
        return [fetch, XMLHttpRequest.prototype.open, XMLHttpRequest.prototype.send, navigator.sendBeacon]
            .every(fn => Function.prototype.toString.call(fn).includes('[native code]'));
    });
    assert.equal(native, true, 'network probes must use original browser APIs');
    return { evaluate, session };
}

async function run(enabled, port) {
    receipts.length = 0;
    const origins = hosts.map(host => 'http://' + host + ':' + port);
    const mapping = hosts.map(host => 'MAP ' + host + ' 127.0.0.1').concat('MAP * ~NOTFOUND').join(',');
    const args = ['--no-proxy-server', '--disable-background-networking',
        '--host-resolver-rules=' + mapping, '--unsafely-treat-insecure-origin-as-secure=' + origins.join(',')];
    if (enabled) args.push('--disable-extensions-except=' + extension, '--load-extension=' + extension);
    const context = await chromium.launchPersistentContext('', {
        ...browserOptions, headless: true, args, ignoreDefaultArgs: ['--disable-extensions'],
    });
    const result = { enabled, extensionVersion: JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).version,
        browser: context.browser().version(), observed: {}, networkFailures: [] };
    try {
        context.on('requestfailed', request => {
            const url = new URL(request.url());
            if (url.searchParams.has('case')) result.networkFailures.push({test:url.searchParams.get('case'), error:request.failure()?.errorText});
        });
        const page = await context.newPage();
        await page.goto(origins[0] + '/fixture?case=document');
        const native = await nativeWorld(context, page);
        const quiz = '/api/v1/courses/1/quizzes/2/submissions/3';
        const steps = [
            ['saved-fetch', '/page_views/cached?id=22', 'PUT', true],
            ['collection', '/api/v1/page_views/', 'POST', true],
            ['classic-quiz', quiz + '/events', 'POST', true],
            ['encoded-page', '/%70age%5Fviews/abc', 'PATCH', true],
            ['encoded-quiz', '/api/v1/courses/%31/quizzes/2/submissions/3/%65vents/', 'POST', true],
            ['edu', origins[1] + '/page_views/edu', 'PUT', true],
            ['edu-quiz', origins[1] + quiz + '/events', 'POST', true],
            ['quiz-save', quiz + '/complete', 'POST', false],
            ['answer-save', '/api/v1/quiz_submissions/3/questions', 'POST', false],
            ['answer-load', '/api/v1/quiz_submissions/3/questions', 'GET', false],
            ['read', quiz + '/events', 'GET', false],
            ['page-read', '/page_views/read-only', 'GET', false],
            ['other-path', '/login?next=/page_views/abc', 'POST', false],
            ['other-host', origins[2] + '/page_views/abc', 'POST', false],
            ['suffix-lookalike', origins[3] + '/page_views/abc', 'POST', false],
        ];
        function tagged(url, name) {
            const target = new URL(url, origins[0]);
            target.searchParams.set('case', name);
            return target.href;
        }
        for (const [name, route, method] of steps) {
            result.observed[name] = await native.evaluate(async ({url, method}) => {
                try { return (await window.savedFetch(url, {method, body: method === 'GET' ? undefined : 'exact body'})).status; }
                catch (e) { return e.name; }
            }, {url: tagged(route, name), method});
        }
        result.observed.xhr = await native.evaluate(url => new Promise(resolve => {
            const xhr = new XMLHttpRequest();
            window.savedOpen.call(xhr, 'PUT', url);
            xhr.onload = () => resolve(xhr.status); xhr.onerror = () => resolve('network error');
            xhr.timeout = 5000; xhr.ontimeout = () => resolve('timeout');
            try { window.savedSend.call(xhr, 'xhr sample'); }
            catch (error) { resolve(error.name); }
        }), tagged('/page_views/native-xhr', 'xhr'));
        result.observed.beacon = await native.evaluate(url => window.savedBeacon(url, 'beacon sample'), tagged('/page_views/beacon', 'beacon'));
        result.observed.worker = await native.evaluate(url => new Promise((resolve, reject) => {
            const worker = new Worker('/worker.js');
            worker.onmessage = event => { worker.terminate(); resolve(event.data); };
            worker.onerror = event => reject(new Error(event.message));
            worker.postMessage(url);
        }), tagged('/page_views/worker', 'worker'));
        // Register through the document world. The request itself runs inside the
        // service worker, which has no page-world userscript wrappers.
        result.observed.serviceworker = await page.evaluate(async url => {
            await navigator.serviceWorker.register('/sw.js');
            const registration = await navigator.serviceWorker.ready;
            const channel = new MessageChannel();
            const ack = new Promise(resolve => channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); });
            registration.active.postMessage(url, [channel.port2]);
            return ack;
        }, tagged('/page_views/sw', 'serviceworker'));
        const other = await context.newPage();
        await other.goto(origins[2] + '/fixture');
        const otherNative = await nativeWorld(context, other);
        result.observed.cross = await otherNative.evaluate(async url => {
            try { return (await window.savedFetch(url, {method:'PUT',body:'cross origin'})).status; }
            catch (e) { return e.name; }
        }, tagged('/page_views/cors', 'cross'));
        await other.goto(origins[0] + '/fixture');
        const navigation = other.waitForNavigation({waitUntil:'commit', timeout:6000}).catch(e => e.message);
        await other.evaluate(url => { const form = document.createElement('form'); form.method='post'; form.action=url; document.body.append(form); form.submit(); }, tagged('/page_views/form', 'form'));
        await navigation;
        // Allow async beacons and committed form requests to reach the fixture.
        await new Promise(done => setTimeout(done, 350));
        result.receipts = receipts.slice();
        const blocked = [...steps.filter(s => s[3]).map(s => s[0]), 'xhr','beacon','worker','serviceworker','cross','form'];
        for (const name of blocked) {
            assert.equal(receipts.some(row => row.test === name && row.method !== 'OPTIONS'), !enabled,
                name + ' target request, extension ' + (enabled ? 'on' : 'off') + ': ' + JSON.stringify(result));
        }
        for (const [name, , method] of steps.filter(s => !s[3])) {
            assert.equal(result.observed[name], 200, name);
            const received = receipts.filter(row => row.test === name && row.method === method);
            assert.equal(received.length, 1, name);
            if (method !== 'GET') assert.equal(received[0].body, 'exact body', name);
        }
        assert.ok(receipts.some(row => row.test === 'document' && row.method === 'GET'));
        result.crossOriginPreflights = receipts.filter(row => row.test === 'cross' && row.method === 'OPTIONS').length;
        if (enabled) assert.equal(result.crossOriginPreflights, 0, 'blocked cross-origin preflight reached server');
        result.blockedCases = blocked;
        result.passedThroughCases = steps.filter(s => !s[3]).map(s => s[0]);
        if (enabled) {
            for (const name of blocked.filter(name => name !== 'serviceworker')) {
                assert.ok(result.networkFailures.some(failure => failure.test === name && failure.error.includes('ERR_BLOCKED_BY_CLIENT')),
                    name + ' must be blocked by the browser network stack');
            }
            assert.equal(result.observed.xhr, 'network error', 'native XHR must fail asynchronously from DNR');
            assert.equal(result.observed.beacon, true, 'native beacon queues before network rule blocks it');
        }
        console.log(JSON.stringify({ enabled, targetsDelivered: receipts.filter(row => blocked.includes(row.test) && row.method !== 'OPTIONS').length,
            remainingTestRequests: receipts.filter(row => !blocked.includes(row.test) && row.method !== 'OPTIONS').length, crossOriginPreflights: result.crossOriginPreflights }));
        return result;
    } finally { await context.close(); }
}

async function main() {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    const reports = [];
    for (const enabled of [false, true]) reports.push(await run(enabled, port));
    fs.writeFileSync(path.join(artifacts, 'network-report.json'), JSON.stringify(reports, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
