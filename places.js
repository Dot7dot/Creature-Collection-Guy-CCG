'use strict';

/**
 * 附近地點查詢：找出指定座標方圓 radius 公尺內「最明顯」的地點。
 * - 有 Google Maps API 金鑰：使用 Google 地圖 Places（依熱門程度排序）
 * - 沒有金鑰：使用 OpenStreetMap（Overpass API），依地點類型重要性與距離評分
 * 回傳 { name, source, id? } 或 null（範圍內沒有地點）。查詢失敗時拋出錯誤。
 */
const Places = (() => {
  const cfg = window.NATURE_CONFIG || {};
  const RADIUS = cfg.placeRadius || 100;
  const LANG = 'zh-TW';

  function distance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
  }

  /* ---------- Google 地圖 ---------- */
  let googleReady = null;

  function loadGoogle(key) {
    if (googleReady) return googleReady;
    googleReady = new Promise((resolve, reject) => {
      window.__natureGoogleInit = () => resolve();
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}` +
        `&v=weekly&loading=async&language=${LANG}&callback=__natureGoogleInit`;
      s.async = true;
      s.onerror = () => { googleReady = null; reject(new Error('無法載入 Google 地圖')); };
      document.head.append(s);
    });
    return googleReady;
  }

  async function nearbyGoogle(lat, lng) {
    await loadGoogle(cfg.googleMapsApiKey);
    const { Place, SearchNearbyRankPreference } = await google.maps.importLibrary('places');
    const { places } = await Place.searchNearby({
      fields: ['id', 'displayName', 'location'],
      locationRestriction: { center: { lat, lng }, radius: RADIUS },
      rankPreference: SearchNearbyRankPreference.POPULARITY,
      maxResultCount: 5,
      language: LANG,
    });
    const top = (places || []).find((p) => p.displayName);
    return top ? { name: top.displayName, source: 'google', id: top.id } : null;
  }

  /* ---------- OpenStreetMap ---------- */
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];

  // 地點類型的「明顯程度」加權
  const WEIGHTS = {
    tourism: { attraction: 40, viewpoint: 35, museum: 35, zoo: 35, theme_park: 35, gallery: 25, information: 0, '*': 20 },
    historic: { '*': 30 },
    natural: { peak: 35, waterfall: 35, beach: 30, cave_entrance: 30, spring: 25, bay: 25, cape: 25, wood: 15, tree: 10, '*': 20 },
    leisure: { nature_reserve: 35, park: 30, garden: 25, '*': 10 },
    boundary: { national_park: 40, protected_area: 30 },
    waterway: { waterfall: 35, '*': 10 },
    railway: { station: 25, '*': 5 },
    public_transport: { station: 20, '*': 5 },
    aeroway: { aerodrome: 30, '*': 5 },
    amenity: { place_of_worship: 20, university: 20, school: 12, library: 15, townhall: 15, '*': 8 },
    building: { '*': 6 },
    shop: { '*': 4 },
    office: { '*': 3 },
    man_made: { lighthouse: 30, tower: 15, bridge: 15, '*': 5 },
  };
  const KEYS = Object.keys(WEIGHTS);

  function osmScore(tags, dist) {
    let best = 0;
    for (const k of KEYS) {
      if (!tags[k]) continue;
      const w = WEIGHTS[k][tags[k]] ?? WEIGHTS[k]['*'] ?? 0;
      best = Math.max(best, w);
    }
    if (tags.wikidata || tags.wikipedia) best += 30;
    return best - (dist / RADIUS) * 15; // 越近越好，但類型重要性優先
  }

  async function nearbyOsm(lat, lng) {
    const filter = `[name][~"^(${KEYS.join('|')})$"~"."]`;
    const query = `[out:json][timeout:10];nwr(around:${RADIUS},${lat},${lng})${filter};out center tags 60;`;
    let lastErr;
    for (const url of OVERPASS) {
      try {
        const res = await withTimeout(fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        }), 12000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        let best = null;
        for (const el of data.elements || []) {
          const p = el.center || el;
          if (p.lat == null || !el.tags) continue;
          const d = distance(lat, lng, p.lat, p.lon);
          if (d > RADIUS) continue;
          const score = osmScore(el.tags, d);
          if (!best || score > best.score) {
            const name = el.tags['name:zh-Hant'] || el.tags['name:zh-TW'] || el.tags.name;
            best = { score, name, id: `${el.type}/${el.id}` };
          }
        }
        return best ? { name: best.name, source: 'osm', id: best.id } : null;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  return {
    radius: RADIUS,
    usesGoogle: Boolean(cfg.googleMapsApiKey),
    nearby(lat, lng) {
      return cfg.googleMapsApiKey ? withTimeout(nearbyGoogle(lat, lng), 15000) : nearbyOsm(lat, lng);
    },
  };
})();
