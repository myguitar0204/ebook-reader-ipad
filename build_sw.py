"""產生 sw.js：把所有網站檔案列入離線快取，版本號取檔案內容的雜湊。

任何網站檔案有改動後都要重跑一次（python build_sw.py），iPad 才會抓到新版。
"""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).parent
SKIP = {"sw.js", "build_sw.py", "README.md", "CLAUDE.md", ".gitignore", ".nojekyll"}

files = sorted(
    p.relative_to(ROOT).as_posix()
    for p in ROOT.rglob("*")
    if p.is_file() and p.name not in SKIP and not any(part.startswith(".") for part in p.relative_to(ROOT).parts)
)
digest = hashlib.sha256()
for f in files:
    digest.update(f.encode() + (ROOT / f).read_bytes())
version = digest.hexdigest()[:12]

sw = f"""// 由 build_sw.py 產生，請勿手動修改
const CACHE = "ebook-{version}";
const FILES = {json.dumps(["./"] + files, ensure_ascii=False, indent=0)};

// 安裝時一次快取全部檔案，之後完全離線可用。cache: "reload" 略過瀏覽器的 HTTP 快取，
// 否則 GitHub Pages 的 max-age=600 期間內可能把舊版檔案存進新版快取
self.addEventListener("install", e => {{
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(f, {{ cache: "reload" }}))))
    .then(() => self.skipWaiting()));
}});
self.addEventListener("activate", e => {{
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
}});
// 快取優先；查詢字串不同（reader.html?id=3）仍視為同一頁
self.addEventListener("fetch", e => {{
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, {{ ignoreSearch: true }}).then(r => r || fetch(e.request)));
}});
"""
(ROOT / "sw.js").write_text(sw, encoding="utf-8", newline="\n")
print(f"sw.js：{len(files)} 個檔案，版本 {version}")
