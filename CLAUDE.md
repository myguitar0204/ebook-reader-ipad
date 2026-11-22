# ebook-ipad — iPad 離線電子書閱讀器（PWA）

純靜態網頁，無伺服器、無建置步驟。書、封面、進度、標籤全部存在 iPad 瀏覽器的 IndexedDB，從 Safari「加入主畫面」後可完全離線使用。部署在 GitHub Pages（只放程式碼，不放書）。

與電腦版 `../ebook`（Python/FastAPI）是**各自獨立的專案**，閱讀邏輯（`reader.html`）由電腦版移植而來，`vendor/` 也是從電腦版複製。兩邊進度不同步。

## 開發與部署

```powershell
python -m http.server 8765 --bind 127.0.0.1   # 本機測試（Service Worker 只能在 localhost 或 HTTPS 下運作）
python build_sw.py                              # 任何網站檔案改動後都要重跑，否則 iPad 會繼續用快取的舊版
git push                                        # GitHub Pages 自動部署
```

## 結構

- `db.js`：IndexedDB 存取（`books` / `files` / `covers` 三個 store）、匯入、EPUB／PDF 中繼資料擷取、txt 解碼
- `index.html`：書庫（匯入、搜尋、排序、格式篩選、標籤、刪除、儲存空間顯示）
- `reader.html`：閱讀頁，依 `fmt` 分 epub / pdf / txt；含滑動翻頁
- `sw.js`：由 `build_sw.py` 產生，安裝時預先快取全部檔案（含 `vendor/cmaps/`），快取優先
- `manifest.webmanifest`、`icons/`：主畫面圖示與 PWA 設定

## 行為約定

- 匯入時把 File 複製成新的 Blob 存起來：從「檔案」App 選的 File 只是參照，iCloud 卸載後就讀不到
- 同檔名且同大小視為已匯入而略過
- epub.js 的 locations 快取存在書的資料（`locations` 欄位），不放 localStorage（上百本會超過 5 MB 上限）
- 字級、左右空白、翻頁方向、排序與格式篩選存在 localStorage
- 滑動翻頁：手指往左滑等同按右側按鈕；用 `screenX`（EPUB 的觸控來自 iframe，`clientX` 基準不同）；PDF 放大到可左右捲動時不觸發

## 踩過的坑

- 用 `new URL(href, base)` 解析 ZIP 內相對路徑時，基準不能用 `x:/` 之類，會被當成 Windows 磁碟機代號（`file:///X:/`），改用 `https://zip/`；解析完要 `decodeURIComponent`，否則中文路徑對不到 ZIP 項目
- pdf.js 的 `getDocument({ data })` 會轉移（清空）傳入的 ArrayBuffer，要傳副本
- Service Worker 安裝時要用 `cache: "reload"`，否則 GitHub Pages 的 `max-age=600` 期間內可能把舊檔存進新版快取
- 改版後要開兩次才會換成新版（第一次載入時新的 Service Worker 才在背景安裝），這是 PWA 的正常行為
- iOS 上 Safari 分頁與主畫面 App 的儲存空間是分開的，書要在主畫面 App 裡匯入
