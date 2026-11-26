"""Bundle the page controls and static network rules for Chrome and Edge."""
from pathlib import Path
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "extension"
DIST = ROOT / "dist"
SOURCE = DEST / "panel.js"
VERSION = re.search(r"^// @version\s+(\S+)", SOURCE.read_text(encoding="utf-8"), re.MULTILINE).group(1)


def escaped_byte(character):
    """Percent escapes are case-insensitive, but ordinary URL path letters are not."""
    digits = f"{ord(character):02x}"
    return "%" + "".join(f"[{digit}{digit.upper()}]" if digit.isalpha() else digit for digit in digits)


def segment(literal):
    return "".join(f"({char}|{escaped_byte(char)})" for char in literal)


def write_json(name, obj):
    (DEST / name).write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


# requestDomains matches the destination, including subdomains. Separate host
# families keep each compiled regex within Chrome's RE2 memory budget.
hosts = [
    ("instructure.com", r"^https?://[a-z0-9.:-]+/"),
    ("edu", r"^https?://canvas[.][a-z0-9.:-]+/"),
]
number = r"(?:(?:%3)?[0-9])+"
# Serialized URL paths are ASCII. Exclude slash, question mark and fragment.
item = r"[!-\x22$-.0->@-~]+"
end = r"/?(?:[?]|$)"
quiz = f"api/v1/courses/{number}/quizzes/{number}/submissions/{item}/"
routes = []
for prefix in ["", "api/v1/"]:
    base = prefix + segment("page_views")
    routes.append((base, ["post"]))
    routes.append((base + "/" + item, ["post", "put", "patch"]))
routes.append((quiz + segment("events"), ["post"]))

DEST.mkdir(parents=True, exist_ok=True)
DIST.mkdir(exist_ok=True)
panel_script = {"js": ["panel.js"], "world": "MAIN", "run_at": "document_start", "all_frames": True}
write_json("manifest.json", {
    "manifest_version": 3,
    "name": "Canvas Ghost Mode Network Filter",
    "version": VERSION,
    "minimum_chrome_version": "111",
    "description": "Shows Canvas Ghost Mode controls and filters selected page-view and Classic Quiz activity requests.",
    "permissions": ["declarativeNetRequest"],
    "content_scripts": [
        {"matches": ["*://*.instructure.com/*"], **panel_script},
        {
            "matches": ["*://*.edu/*"],
            "include_globs": ["*://canvas.*.edu/*", "*://canvas.*.edu:*/*"],
            **panel_script,
        },
    ],
    "declarative_net_request": {
        "rule_resources": [{"id": "canvas_activity", "enabled": True, "path": "rules.json"}]
    }
})

rules = []
for domain, authority in hosts:
    for path, methods in routes:
        rules.append({
            "id": len(rules) + 1,
            "priority": 1,
            "action": {"type": "block"},
            "condition": {
                "requestDomains": [domain],
                "regexFilter": authority + path + end,
                "isUrlFilterCaseSensitive": True,
                "requestMethods": methods,
                # This includes document POSTs, fetches, XHR, and beacons.
                "excludedResourceTypes": ["websocket"],
            }
        })
write_json("rules.json", rules)

install = f"""Canvas Ghost Mode {VERSION} for Chrome and Edge

Extract the ZIP to a folder you will keep. Open chrome://extensions or
edge://extensions, enable Developer mode, click Load unpacked and select
the folder containing manifest.json. The extension is listed as
Canvas Ghost Mode Network Filter.

When updating an existing unpacked installation, copy the new files into
the same folder and click Reload on the extension card. If you installed
the older Tampermonkey script, disable that copy to avoid running both.

Refresh the Canvas page. The panel starts in the bottom-right corner and
remembers where you drag it. Alt+Shift+G expands or collapses the panel.
Automatic loading covers instructure.com, its subdomains, and
canvas.<school>.edu. If the panel is missing on one of these sites, open
the extension's Details and allow site access for your Canvas hostname.

For a custom school domain, open manifest.json in a text editor. Add the
Canvas origin followed by /* to the first content_scripts entry's matches
array. For example, for https://learn.example.org/courses/123 it becomes
["*://*.instructure.com/*", "https://learn.example.org/*"].
Save, reload the extension and refresh Canvas. This enables the in-page
panel and filters there. The static network rules retain their original
domain scope.
"""
archive = DIST / f"canvas-ghost-mode-{VERSION}.zip"
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for name in ["manifest.json", "panel.js", "rules.json"]:
        bundle.write(DEST / name, arcname=name)
    bundle.writestr("INSTALL.txt", install)

(DIST / "canvas-ghost-mode.user.js").write_bytes(SOURCE.read_bytes())
print(f"Built {archive.name} and canvas-ghost-mode.user.js")
