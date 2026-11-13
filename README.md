# Creature-Collection-Guy-CCG — 自然手記

一個用來記錄大自然的網頁 App，可直接部署在 GitHub Pages。

## 功能

- **正方形相機框**：開啟相機後在畫面中央的正方形框內拍照（也可從手機相簿選擇照片，會自動裁成正方形）
- **拍攝類別**：動物、植物、風景
- **照片名稱**與**備註**欄位
- **GPS 定位**：自動記錄拍攝地點，可在地圖上查看
- **拍攝時間**：自動記錄
- **分類相簿**：依動物／植物／風景分開瀏覽，可查看詳情、下載或刪除
- **兩種主題**：咖啡橘（深咖啡＋淺橘）、森林綠（深綠＋淺綠），右上角一鍵切換，會記住選擇
- 可加入主畫面當作 App 使用，支援離線開啟

## 資料儲存

所有照片與記錄都存在瀏覽器本機的 IndexedDB 中，不會上傳到任何伺服器。
清除瀏覽器網站資料會一併刪除照片，重要照片請在詳情頁「下載照片」備份。

## 部署到 GitHub Pages

1. 到 GitHub 儲存庫的 **Settings → Pages**
2. **Source** 選 **Deploy from a branch**
3. Branch 選 **main**、資料夾選 **/ (root)**，按 Save
4. 稍候約一分鐘，即可在 `https://<使用者名稱>.github.io/Creature-Collection-Guy-CCG/` 開啟

> 相機與 GPS 只能在 HTTPS 下使用，GitHub Pages 預設即為 HTTPS。

## 本機測試

```bash
python3 -m http.server 8000
# 開啟 http://localhost:8000
```
