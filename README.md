# Canvas Ghost Mode

A Chrome/Edge extension with compact violet controls for Canvas page visibility masking and selected activity-request filters. Version 4.3 uses a charcoal, Dear ImGui-inspired interface with a draggable title bar, compact tabs, and inset controls.

![Canvas Ghost Mode panel](docs/panel.png)

## Install

1. Download the extension ZIP from [Releases](https://github.com/bodanator/canvas-ghost-mode/releases/latest) and extract it to a folder you will keep.
2. Open `chrome://extensions` or `edge://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
3. Select the extracted folder containing `manifest.json`. The browser lists the extension as **Canvas Ghost Mode Network Filter**.
4. Disable any older Canvas Ghost Mode Tampermonkey copy, then refresh your Canvas page. The panel starts in the bottom-right corner.

For a source checkout, load the `extension` folder directly. To update an existing unpacked installation, replace its files, click **Reload** on the extension card, and refresh Canvas.

Automatic loading covers `instructure.com`, its subdomains, and `canvas.<school>.edu`. Check the extension's **Details → Site access** if the panel is missing on a supported site. A custom hostname needs both a content-script match and corresponding network rules to receive both types of filtering.

## Controls

| Action | Control |
| --- | --- |
| Move the panel | Drag its title bar |
| Collapse or expand | Title-bar triangle or `Alt+Shift+G` |
| Pause or resume page filters | Status button or `Alt+Shift+P` |
| Inspect and reattach page hooks | **Check page hooks** |
| Change filtering or restore position | **Settings** |

Settings are stored in the Canvas origin's local storage. Matching frames have their own hooks and diagnostics, while the top document displays the panel. The panel reattaches after page-body replacement.

## Network coverage

The browser's declarative network rules block these writes to supported destination hosts, including requests made through workers and native browser APIs.

| Endpoint | Blocked methods |
| --- | --- |
| `/page_views` and `/api/v1/page_views` | `POST` |
| `/page_views/<id>` and `/api/v1/page_views/<id>` | `POST`, `PUT`, `PATCH` |
| `/api/v1/courses/<course>/quizzes/<quiz>/submissions/<submission>/events` | `POST` |

Rules accept query strings, optional trailing slashes, encoded letters in `page_views` and `events`, and encoded decimal course/quiz IDs. The Classic Quiz rule suppresses the entire event batch at its endpoint.

Pausing the panel affects its page-level masking and fetch/XHR/beacon wrappers. Browser network rules stay active until the extension is disabled. The displayed counter counts requests intercepted by this document's wrappers. Ordinary course loads, answer saves, and final submissions still reach Canvas and can create server records. Custom hosts, other endpoints, and New Quizzes require separate coverage. A page can also detect or replace page-world hooks.

The shipped extension makes no requests of its own and bundles all interface styles. It stores only panel settings, with a bounded in-memory list of request-rule and hook notices. The list omits request URLs, bodies, and timestamps.

## Build and verify

The installed extension has no runtime dependencies. Python 3 builds the ZIP and standalone userscript. Node.js 20+ and Playwright run the browser checks.

```sh
python scripts/build.py
npm ci
npx playwright install chromium
npm test
```

Builds appear in `dist`. For an existing Chromium or Chrome for Testing installation, set `CHROME_PATH` to its executable before running the tests.

The network tests compare an extension-disabled control with the actual unpacked extension. A local HTTP receiver records whether requests arrived and verifies allowed request methods and bodies. The panel tests use the normal manifest entry point and real browser input. Test artifacts are written to `test-results`.

Version 4.3.0 passed these checks in Chrome for Testing 156.0.8078.4 using isolated profiles and loopback servers.

| Receiver or interface check | Extension disabled | Extension enabled |
| --- | --- | --- |
| Targeted activity writes received | 13 of 13 | 0 of 13 |
| Allowed requests received, including document load | 9 of 9 | 9 of 9 |
| Targeted cross-origin preflights received | 1 | 0 |
| Panel interaction scenarios | — | 7 of 7 passed |

Network cases cover original browser fetch/XHR/beacon functions, dedicated workers, service workers, cross-origin requests, form POSTs, both hostname patterns, and encoded routes. Allowed answer-save and final-submission bodies arrived intact. Panel checks cover controls, keyboard shortcuts, reload persistence, body replacement, dragging, a 375-pixel viewport, frame scope, and network rules while page filters are paused. This verification used local fixtures. Live school-account behavior remains untested.

## Project files

| Path | Purpose |
| --- | --- |
| `extension/panel.js` | Page hooks, UI, and standalone userscript metadata |
| `scripts/build.py` | Generates the manifest, ten network rules, and installable packages |
| `extension/manifest.json` | Generated extension configuration |
| `extension/rules.json` | Generated browser network rules |
| `tests` | Local HTTP receiver and browser verification |

Original userscript attribution is preserved in `panel.js`. The interface follows the supplied miasma ImGui visual reference.

Browser behavior follows the [Chrome declarativeNetRequest API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) and [content-script manifest](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts). The test setup follows [Playwright's extension testing guidance](https://playwright.dev/docs/chrome-extensions).
