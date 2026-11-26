/* Loads the actual unpacked extension. Fixture scripts only observe page behavior. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const extension = path.join(__dirname, '../extension');
const browserOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' };
const artifacts = path.join(__dirname, '../test-results');
fs.mkdirSync(artifacts, { recursive: true });
const hosts = ['ghost-test.instructure.com','canvas.fixture.edu','library.fixture.edu'];
const requests = [];
const findings = [];
const server = http.createServer((req,res) => {
    const url = new URL(req.url,'http://'+req.headers.host);
    const parts=[];
    req.on('data',chunk=>parts.push(chunk));
    req.on('end',()=>{
        requests.push({host:url.hostname, path:url.pathname, method:req.method, body:Buffer.concat(parts).toString()});
        res.setHeader('Cache-Control','no-store');
        if (url.pathname === '/fixture') {
            const child = url.searchParams.get('child');
            const frame = hosts.includes(child) ? `<iframe id="child" src="http://${child}:${server.address().port}/fixture"></iframe>` : '';
            res.writeHead(200,{'Content-Type':'text/html'});
            res.end(`<!doctype html><html><head><title>Loopback extension test</title><script>
                window.fixtureAtStart = { hiddenHook: Object.hasOwn(document,'hidden'), focusHook: Object.hasOwn(document,'hasFocus') };
                let visibilityEvents = 0;
                document.addEventListener('visibilitychange', () => visibilityEvents++);
                window.fixtureVisibilityPasses = () => { const before = visibilityEvents; document.dispatchEvent(new Event('visibilitychange')); return visibilityEvents > before; };
            </script></head><body><main><h1>Local fixture</h1>${frame}</main></body></html>`);
        } else if (url.pathname === '/probe-worker.js') {
            res.writeHead(200,{'Content-Type':'text/javascript'});
            res.end(`onmessage=async e=>{ try{postMessage({status:(await fetch(e.data,{method:'PUT',body:'worker fixture'})).status});}catch(error){postMessage({error:error.name});} };`);
        } else { res.writeHead(200,{'Content-Type':'text/plain'}); res.end('Loopback receipt'); }
    });
});

async function verify(name,fn) {
    try { await fn(); findings.push({name,pass:true}); console.log('PASS '+name); }
    catch (error) { findings.push({name,pass:false,error:error.message}); console.error('FAIL '+name+' '+error.message); }
}

async function main() {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port;
    const origin=host=>`http://${host}:${port}`;
    const context=await chromium.launchPersistentContext('',{
        ...browserOptions,headless:true,ignoreDefaultArgs:['--disable-extensions'],
        args:['--no-proxy-server','--disable-background-networking','--disable-component-update','--disable-sync',
            '--host-resolver-rules='+hosts.map(h=>'MAP '+h+' 127.0.0.1').concat('MAP * ~NOTFOUND').join(','),
            '--disable-extensions-except='+extension,'--load-extension='+extension]
    });
    try {
        const page=await context.newPage();
        page.setDefaultTimeout(4500);
        const panel=page.locator('#canvas-ghost-mode-v4');
        // Chromium's accessibility tree includes real controls in closed shadow roots.
        // Send normal mouse input using each visible control's browser-reported geometry.
        const cdp=await context.newCDPSession(page);
        await cdp.send('Accessibility.enable');
        async function axNode(role,name) {
            const deadline=Date.now()+4500;
            let available=[];
            do {
                const {nodes}=await cdp.send('Accessibility.getFullAXTree');
                available=nodes.filter(n=>!n.ignored && n.role?.value===role);
                const hit=available.find(n=>name instanceof RegExp ? name.test(n.name?.value || '') : n.name?.value===name);
                if(hit) return hit;
                await new Promise(resolve=>setTimeout(resolve,45));
            } while(Date.now()<deadline);
            throw new Error(`Missing ${role} ${name}. Available: ${available.map(n=>n.name?.value).join(', ')}`);
        }
        function control(role,name) {
            return {
                waitFor:()=>axNode(role,name),
                click:async()=>{
                    const node=await axNode(role,name);
                    const params={backendNodeId:node.backendDOMNodeId};
                    await cdp.send('DOM.scrollIntoViewIfNeeded',params);
                    const {model}=await cdp.send('DOM.getBoxModel',params);
                    const [x0,y0,,,x2,y2]=model.border;
                    await page.mouse.click((x0+x2)/2,(y0+y2)/2);
                }
            };
        }
        const button=name=>control('button',name);
        const tab=name=>control('tab',name);
        await verify('extension shows a usable panel before page interactions',async()=>{
            await page.goto(origin(hosts[0])+'/fixture');
            await panel.waitFor();
            assert.equal(await panel.count(),1);
            assert.deepEqual(await page.evaluate(()=>window.fixtureAtStart),{hiddenHook:true,focusHook:true});
            assert.equal(await page.evaluate(()=>window.fixtureVisibilityPasses()),false);
            await button('Pause in-page filters').waitFor();
            await tab('Settings').click();
            const checkbox=control('checkbox','Mask page visibility and focus');
            await checkbox.click(); assert.equal(await page.evaluate(()=>fixtureVisibilityPasses()),true);
            await checkbox.click(); assert.equal(await page.evaluate(()=>fixtureVisibilityPasses()),false);
            await panel.screenshot({path:path.join(artifacts,'panel-settings.png')});
            await tab('Status').click();
            await button('Check page hooks').click();
            await tab('Activity').click();
            await axNode('StaticText',/all page hooks verified/i);
            await panel.screenshot({path:path.join(artifacts,'panel-activity.png')});
            await button('Clear activity').click();
            await tab('Status').click();
        });

        await verify('real keyboard and button controls persist across reload',async()=>{
            await page.goto(origin(hosts[0])+'/fixture');
            await button('Pause in-page filters').click();
            assert.equal(await page.evaluate(()=>fixtureVisibilityPasses()),true);
            await page.keyboard.press('Alt+Shift+G');
            await button('Expand panel').waitFor();
            await page.reload(); await button('Expand panel').click();
            await button('Resume in-page filters').waitFor();
            await page.keyboard.press('Alt+Shift+P');
            await button('Pause in-page filters').waitFor();
            assert.equal(await page.evaluate(()=>fixtureVisibilityPasses()),false);
        });

        await verify('body replacement preserves one functioning panel',async()=>{
            await page.goto(origin(hosts[0])+'/fixture');
            await button('Pause in-page filters').waitFor();
            await page.evaluate(()=>{
                const next=document.createElement('body'); const note=document.createElement('p');
                note.textContent='Replacement fixture body'; next.append(note); document.documentElement.replaceChild(next,document.body);
            });
            await button('Pause in-page filters').click();
            assert.equal(await panel.count(),1); assert.equal(await page.evaluate(()=>fixtureVisibilityPasses()),true);
            await button('Resume in-page filters').click();
            assert.equal(await page.evaluate(()=>fixtureVisibilityPasses()),false);
        });

        await verify('drag position persists after reload and clamps on a narrow viewport',async()=>{
            await page.goto(origin(hosts[0])+'/fixture');
            await button('Pause in-page filters').waitFor();
            const before=await panel.boundingBox();
            // Trusted pointer input through the visible title bar, away from its collapse button.
            await page.mouse.move(before.x+100,before.y+13);
            await page.mouse.down();
            await page.mouse.move(before.x-35,before.y-70,{steps:8});
            await page.mouse.up();
            const moved=await panel.boundingBox();
            assert.ok(Math.abs(before.x-moved.x)>30 || Math.abs(before.y-moved.y)>30,'panel follows drag');
            await page.reload();
            await button('Pause in-page filters').waitFor();
            const reloaded=await panel.boundingBox();
            assert.ok(Math.abs(reloaded.x-moved.x)<3 && Math.abs(reloaded.y-moved.y)<3,'drag coordinates survive reload');
            await page.setViewportSize({width:375,height:667});
            await page.waitForTimeout(100);
            const narrow=await panel.boundingBox();
            assert.ok(narrow.x>=0 && narrow.y>=0 && narrow.x+narrow.width<=375 && narrow.y+narrow.height<=667,
                'narrow panel remains inside viewport: '+JSON.stringify(narrow));
            await button('Pause in-page filters').click();
            assert.equal(await page.evaluate(()=>fixtureVisibilityPasses()),true);
            await button('Resume in-page filters').click();
            await panel.screenshot({path:path.join(artifacts,'panel-narrow.png')});
            await page.setViewportSize({width:1280,height:720});
        });

        await verify('matching .edu top and matching cross-origin child receive page-world hooks',async()=>{
            await page.goto(origin(hosts[1])+'/fixture?child='+hosts[0]);
            await panel.waitFor();
            const frame=await (await page.locator('#child').elementHandle()).contentFrame();
            await frame.waitForFunction(()=>Boolean(window.fixtureAtStart));
            for(const target of [page,frame]) {
                assert.deepEqual(await target.evaluate(()=>window.fixtureAtStart),{hiddenHook:true,focusHook:true});
                assert.equal(await target.evaluate(()=>fixtureVisibilityPasses()),false);
            }
            assert.equal(await panel.count(),1);
            assert.equal(await frame.locator('#canvas-ghost-mode-v4').count(),0);
            await panel.screenshot({path:path.join(artifacts,'panel-installed.png')});
        });

        await verify('unrelated .edu top stays untouched when a matching child is embedded',async()=>{
            await page.goto(origin(hosts[2])+'/fixture?child='+hosts[0]);
            const frame=await (await page.locator('#child').elementHandle()).contentFrame();
            await frame.waitForFunction(()=>Boolean(window.fixtureAtStart));
            assert.deepEqual(await page.evaluate(()=>window.fixtureAtStart),{hiddenHook:false,focusHook:false});
            assert.equal(await page.evaluate(()=>fixtureVisibilityPasses()),true);
            assert.deepEqual(await frame.evaluate(()=>window.fixtureAtStart),{hiddenHook:true,focusHook:true});
            assert.equal(await frame.evaluate(()=>fixtureVisibilityPasses()),false);
            assert.equal(await panel.count(),0);
            assert.equal(await frame.locator('#canvas-ghost-mode-v4').count(),0);
        });

        await verify('worker request filtering remains active with in-page filters paused',async()=>{
            await page.goto(origin(hosts[0])+'/fixture');
            await button('Pause in-page filters').click();
            const outcomes=await page.evaluate(async()=>{
                const worker=new Worker('/probe-worker.js');
                const send=url=>new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=e=>reject(new Error(e.message));worker.postMessage(url);});
                try { return {blocked:await send('/page_views/worker'), allowed:await send('/ordinary-worker')}; }
                finally {worker.terminate();}
            });
            assert.deepEqual(outcomes,{blocked:{error:'TypeError'},allowed:{status:200}});
            assert.equal(requests.filter(r=>r.path==='/page_views/worker').length,0);
            assert.equal(requests.filter(r=>r.path==='/ordinary-worker' && r.method==='PUT' && r.body==='worker fixture').length,1);
            await button('Resume in-page filters').click();
        });
        const passed=findings.filter(f=>f.pass).length;
        const report={browser:context.browser().version(),extensionVersion:JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'))).version,passed,total:findings.length,findings,requests};
        fs.writeFileSync(path.join(artifacts,'panel-report.json'),JSON.stringify(report,null,2));
        console.log(`${passed}/${findings.length} normal-installation scenarios passed`);
        if(passed!==findings.length)process.exitCode=1;
    } finally {await context.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
