// ===== 自然手記設定 =====
//
// googleMapsApiKey：
//   填入 Google Maps API 金鑰後，地點名稱會改用「Google 地圖」的地點資料
//   （依熱門程度挑選方圓 placeRadius 公尺內最明顯的地點）。
//   留空則使用免費的 OpenStreetMap 地點資料。
//   申請方式請見 README.md 的「使用 Google 地圖地點」。
//
// placeRadius：搜尋附近地點的範圍（公尺）。範圍內沒有任何地點時，改記錄經緯度。
window.NATURE_CONFIG = {
  googleMapsApiKey: '',
  placeRadius: 100,
};
