// 書庫儲存層：書的資料、檔案、封面都存在本機 IndexedDB，不需要伺服器。
// books：書的資料（含進度、標籤、epub.js locations 快取）；files / covers：以書 id 為鍵的 Blob

const FORMATS = { epub: "epub", kepub: "epub", pdf: "pdf", txt: "txt" };  // kepub 是 Kobo 版 epub

const DB = (() => {
  let dbp;
  const open = () => dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("ebook", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("books", { keyPath: "id", autoIncrement: true });
      d.createObjectStore("files");
      d.createObjectStore("covers");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const store = async (name, mode = "readonly") => (await open()).transaction(name, mode).objectStore(name);

  return {
    list: async () => done((await store("books")).getAll()),
    get: async id => done((await store("books")).get(id)),
    file: async id => done((await store("files")).get(id)),
    cover: async id => done((await store("covers")).get(id)),
    async update(id, fields) {
      const s = await store("books", "readwrite");
      const b = await done(s.get(id));
      if (b) await done(s.put({ ...b, ...fields }));
    },
    async add(book, file, cover) {
      const tx = (await open()).transaction(["books", "files", "covers"], "readwrite");
      const id = await done(tx.objectStore("books").add(book));
      tx.objectStore("files").put(file, id);
      if (cover) tx.objectStore("covers").put(cover, id);
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
      return id;
    },
    async remove(id) {
      const tx = (await open()).transaction(["books", "files", "covers"], "readwrite");
      for (const n of ["books", "files", "covers"]) tx.objectStore(n).delete(id);
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    },
  };
})();

// ---------- 中繼資料與封面 ----------

const OPF_NS = "http://www.idpf.org/2007/opf";
const DC_NS = "http://purl.org/dc/elements/1.1/";

// 回傳 { title, author, cover: Blob|null }
async function epubMeta(buf) {
  const z = await JSZip.loadAsync(buf);
  const xml = async p => new DOMParser().parseFromString(await z.file(p).async("text"), "application/xml");
  const opfPath = (await xml("META-INF/container.xml")).getElementsByTagName("rootfile")[0].getAttribute("full-path");
  const opf = await xml(opfPath);
  const text = tag => (opf.getElementsByTagNameNS(DC_NS, tag)[0]?.textContent || "").trim();

  const items = [...opf.getElementsByTagNameNS(OPF_NS, "item")];
  const images = items.filter(i => (i.getAttribute("media-type") || "").startsWith("image/"));
  // 依序嘗試：EPUB3 cover-image → EPUB2 <meta name="cover"> → 名稱含 cover 的圖
  let cover = images.find(i => (i.getAttribute("properties") || "").split(/\s+/).includes("cover-image"));
  if (!cover) {
    const meta = [...opf.getElementsByTagNameNS(OPF_NS, "meta")].find(m => m.getAttribute("name") === "cover");
    if (meta) cover = images.find(i => i.getAttribute("id") === meta.getAttribute("content"));
  }
  cover ??= images.find(i => ((i.getAttribute("id") || "") + (i.getAttribute("href") || "")).toLowerCase().includes("cover"));

  let blob = null;
  if (cover) {
    // 以 URL 解析相對路徑（基準用 https，"x:/" 之類會被當成 Windows 磁碟機代號）；
    // URL 會把非 ASCII 字元編碼，解析完再解碼回 ZIP 內的原始路徑
    const href = decodeURIComponent(new URL(cover.getAttribute("href"), "https://zip/" + opfPath).pathname).slice(1);
    const entry = z.file(href);
    if (entry) blob = new Blob([await entry.async("uint8array")], { type: cover.getAttribute("media-type") });
  }
  return { title: text("title"), author: text("creator"), cover: blob };
}

async function pdfMeta(buf) {
  const doc = await pdfjsLib.getDocument({ data: buf, cMapUrl: "vendor/cmaps/", cMapPacked: true }).promise;
  try {
    const info = (await doc.getMetadata()).info || {};
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 300 / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.85));
    return { title: (info.Title || "").trim(), author: (info.Author || "").trim(), cover: blob };
  } finally {
    doc.destroy();
  }
}

// txt 依序嘗試的編碼（對應電腦版的 utf-8-sig → cp950 → gb18030 → utf-16）
function decodeTxt(buf) {
  for (const enc of ["utf-8", "big5", "gb18030", "utf-16le"]) {
    try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch {}
  }
  return new TextDecoder("utf-8").decode(buf);
}

const extOf = name => (name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();

// 匯入多個 File；同檔名且同大小視為已匯入而略過。onProgress(第幾本, 總數, 檔名)
async function importFiles(files, onProgress) {
  const existing = new Set((await DB.list()).map(b => b.filename + "|" + b.size));
  const result = { added: 0, skipped: [], failed: [] };
  let n = 0;
  for (const f of files) {
    onProgress?.(++n, files.length, f.name);
    const fmt = FORMATS[extOf(f.name)];
    if (!fmt) { result.skipped.push(f.name + "（不支援的格式）"); continue; }
    if (existing.has(f.name + "|" + f.size)) { result.skipped.push(f.name + "（已在書庫）"); continue; }
    try {
      // 複製成新的 Blob：從「檔案」App 選的 File 只是參照，來源被移動或 iCloud 卸載後就讀不到
      const buf = await f.arrayBuffer();
      let meta = { title: "", author: "", cover: null };
      try {
        if (fmt === "epub") meta = await epubMeta(buf.slice(0));
        if (fmt === "pdf") meta = await pdfMeta(buf.slice(0));  // pdf.js 會轉移（清空）傳入的 buffer，所以傳副本
      } catch (e) {  // 損毀或格式特殊的檔案仍列入書庫，只是沒有封面
        console.warn("無法讀取中繼資料：", f.name, e);
      }
      await DB.add({
        filename: f.name, title: meta.title, author: meta.author, fmt, size: f.size,
        added_at: Date.now(), last_read: 0, position: "", progress: 0, tags: [], has_cover: !!meta.cover,
      }, new Blob([buf], { type: f.type }), meta.cover);
      existing.add(f.name + "|" + f.size);
      result.added++;
    } catch (e) {
      result.failed.push(`${f.name}（${e.message || e}）`);
    }
  }
  return result;
}
