# Creature-Collection-Guy-CCG — 自然手記

一個用來記錄大自然的網頁 App，可直接部署在 GitHub Pages。

## 功能

- **正方形相機框**：開啟相機後在畫面中央的正方形框內拍照（也可從手機相簿選擇照片，會自動裁成正方形）
- **拍攝類別**：動物、植物、風景
- **照片名稱**與**備註**欄位
- **GPS 定位 + 附近地點**：自動找出方圓 100 公尺內最明顯的地點，直接顯示地點名稱；
  範圍內沒有任何地點時才改記錄經緯度。點地點可在 Google 地圖上查看
- **背景搜尋地點**：定位與地點搜尋都在背景進行，按下儲存立即完成，地點名稱找到後自動補上；
  沒網路或 App 中途關閉時，會在恢復網路或下次開啟時自動重試
- **拍攝時間**：自動記錄
- **分類相簿**：依動物／植物／風景分開瀏覽，可查看詳情、下載或刪除
- **編輯照片資訊**：可修改類別、名稱、地點名稱與備註；地點可自行輸入，或按「自動搜尋附近地點」重新搜尋
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

## 地點資料來源

預設使用免費、免金鑰的 **OpenStreetMap** 地點資料（依景點、古蹟、公園、自然地標等類型的重要程度與距離挑選）。

### 使用 Google 地圖地點（選用）

想改用 Google 地圖的地點（依熱門程度挑選），需要一組 Google Maps API 金鑰：

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案並啟用帳單
   （Google 依用量計費，每月有免費額度，建議同時設定預算提醒）
2. 在「API 和服務」中啟用 **Maps JavaScript API** 與 **Places API (New)**
3. 建立 API 金鑰，並設定限制：
   - 應用程式限制：**網站**，加入 `https://dot7dot.github.io/*`
   - API 限制：只勾選上面兩個 API
4. 把金鑰填進 `config.js` 的 `googleMapsApiKey`，推送到 main 即可

> 金鑰會出現在網頁原始碼中，這是 Google 地圖網頁版的正常用法，務必做好第 3 步的網站限制。

## 本機測試

```bash
python3 -m http.server 8000
# 開啟 http://localhost:8000
```
