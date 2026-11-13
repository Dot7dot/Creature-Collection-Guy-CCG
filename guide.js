'use strict';

/* ================= 太平山生物圖鑑 ================= */
const Guide = (() => {
  const CAT_LABEL = { animal: '動物', insect: '昆蟲', plant: '植物' };
  const GROUP_ORDER = {
    animal: ['哺乳類', '鳥類', '兩棲類', '爬蟲類', '蜘蛛類', '其他動物'],
    insect: ['蝴蝶', '蛾', '甲蟲', '蜻蜓豆娘', '蟬與椿象', '蜂與螞蟻', '蝗蟲與螽斯', '其他昆蟲'],
    plant: ['裸子植物', '雙子葉植物', '單子葉植物', '蘭花', '蕨類', '苔蘚'],
  };
  const SEASONS = ['春', '夏', '秋', '冬'];
  const NOW_MONTH = new Date().getMonth(); // 0-11

  let data = null;
  let loading = null;
  const ui = { cat: 'animal', chip: 'all', q: '' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const norm = (s) => String(s || '').toLowerCase().replace(/台/g, '臺').replace(/\s+/g, '');

  function load() {
    if (!loading) {
      loading = fetch('guide/species.json')
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((json) => {
          data = json;
          for (const sp of data.species) {
            sp._search = norm([sp.zh, ...(sp.alt || []), sp.sci, sp.family, sp.familySci, sp.group].join('|'));
          }
          renderMeta();
          render();
        })
        .catch((err) => {
          console.error(err);
          loading = null;
          $('#guideMeta').textContent = '圖鑑載入失敗，請檢查網路連線後再試一次';
        });
    }
    return loading;
  }

  function renderMeta() {
    const m = data.meta;
    const featured = data.species.filter((s) => s.featured).length;
    $('#guideMeta').textContent = `${m.place}・共 ${m.count} 種（官方特色物種 ${featured} 種）`;
    const src = m.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join('、');
    $('#guideSources').innerHTML =
      `資料來源：${src}。<br>照片與文字的著作權屬原作者，依各自標示的創用 CC 授權使用，僅供非商業的自然觀察與教育用途。` +
      `<br>資料整理日期：${esc(m.built)}`;
  }

  /* ---------- 篩選 ---------- */
  function matches(sp) {
    if (ui.q) return sp._search.includes(ui.q);
    if (sp.category !== ui.cat) return false;
    if (ui.chip === 'all') return true;
    if (ui.chip === 'featured') return sp.featured;
    if (ui.chip === 'month') return Boolean(sp.months && sp.months[NOW_MONTH] > 0);
    return sp.group === ui.chip;
  }

  function renderChips() {
    const box = $('#guideChips');
    box.hidden = Boolean(ui.q);
    if (ui.q) return;
    const inCat = data.species.filter((s) => s.category === ui.cat);
    const groups = GROUP_ORDER[ui.cat].filter((g) => inCat.some((s) => s.group === g));
    const chips = [
      ['all', '全部'],
      ['featured', '★ 官方特色物種'],
      ['month', `${NOW_MONTH + 1} 月可見`],
      ...groups.map((g) => [g, g]),
    ];
    if (!chips.some(([k]) => k === ui.chip)) ui.chip = 'all';
    box.innerHTML = chips.map(([k, label]) => {
      const n = inCat.filter((s) => k === 'all' || (k === 'featured' ? s.featured
        : k === 'month' ? s.months && s.months[NOW_MONTH] > 0 : s.group === k)).length;
      return `<button type="button" class="chip-btn${k === ui.chip ? ' active' : ''}" data-chip="${esc(k)}"` +
        ` aria-pressed="${k === ui.chip}">${esc(label)} ${n}</button>`;
    }).join('');
  }

  function render() {
    if (!data) return;
    for (const c of Object.keys(CAT_LABEL)) {
      const n = data.species.filter((s) => s.category === c && (!ui.q || s._search.includes(ui.q))).length;
      $(`[data-gcount="${c}"]`).textContent = n;
    }
    $$('.guide-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.gcat === ui.cat));
    $('.guide-tabs').classList.toggle('dim', Boolean(ui.q));
    renderChips();

    const list = data.species.filter(matches);
    $('#guideResult').textContent = ui.q ? `搜尋「${$('#guideSearch').value.trim()}」：${list.length} 種` : '';
    $('#guideEmpty').hidden = list.length > 0;
    $('#guideGrid').innerHTML = list.map(card).join('');
  }

  function card(sp) {
    const badges = [];
    if (sp.featured) badges.push('<span class="badge">官方</span>');
    if (sp.status.includes('臺灣特有')) badges.push('<span class="badge alt">特有</span>');
    const sub = ui.q ? `${CAT_LABEL[sp.category]}・${sp.group}` : (sp.family || sp.group);
    return `<button type="button" class="sp-card" data-sp="${esc(sp.id)}">
      <span class="sp-thumb"><img src="${esc(sp.photo)}" alt="${esc(sp.zh)}" loading="lazy" decoding="async">
        <span class="badges">${badges.join('')}</span></span>
      <span class="sp-text"><span class="sp-name">${esc(sp.zh)}</span>
        <span class="sp-sub">${esc(sub)}</span></span>
    </button>`;
  }

  /* ---------- 物種詳情 ---------- */
  const dialog = $('#species');
  let current = null;

  function monthChart(sp) {
    const m = sp.months || [];
    const total = m.reduce((a, b) => a + b, 0);
    if (!total) {
      const sensitive = sp.status.some((s) => s.includes('保育') || s.includes('IUCN') || s.includes('國家'));
      return sensitive
        ? '<p class="month-note">這是保育類或受威脅物種。為了保護牠們，公開的觀察資料會把位置模糊化，' +
          '所以不會出現在太平山的月份統計中，並不代表這裡看不到。</p>'
        : '<p class="month-note">iNaturalist 上還沒有這個物種在太平山的研究級觀察紀錄。</p>';
    }
    const max = Math.max(...m);
    const summary = m.map((n, i) => `${i + 1}月 ${n} 筆`).join('、');
    const peak = m.indexOf(max) + 1;
    const bars = m.map((n, i) => {
      const h = n ? Math.max(4, Math.round((n / max) * 100)) : 0;
      return `<div class="month-bar${n ? '' : ' zero'}${i === NOW_MONTH ? ' now' : ''}" tabindex="0"
        data-tip="${i + 1} 月：${n} 筆" aria-label="${i + 1} 月 ${n} 筆"><span style="height:${h}%"></span></div>`;
    }).join('');
    const labels = m.map((_, i) => `<span>${i + 1}</span>`).join('');
    return `<div class="months" role="img" aria-label="各月份觀察筆數：${esc(summary)}">
        <div class="month-bars">${bars}</div>
        <div class="month-labels" aria-hidden="true">${labels}</div>
      </div>
      <p class="month-note">共 ${sp.obs || total} 筆研究級紀錄，${peak} 月最多。` +
      `本月（${NOW_MONTH + 1} 月，淺色長條）${m[NOW_MONTH] ? `有 ${m[NOW_MONTH]} 筆` : '尚無紀錄'}。</p>`;
  }

  function credit(c) {
    if (!c) return '';
    const parts = [c.by, c.source, c.license].filter(Boolean).map(esc).join('／');
    return c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${parts}</a>` : parts;
  }

  function open(id) {
    const sp = data && data.species.find((s) => s.id === id);
    if (!sp) return;
    current = sp;
    $('#spImg').src = sp.photo;
    $('#spImg').alt = sp.zh;
    $('#spPhotoCredit').innerHTML = sp.credits.photo ? `照片：${credit(sp.credits.photo)}` : '';

    const tags = [
      `<span class="chip">${esc(CAT_LABEL[sp.category])}・${esc(sp.group)}</span>`,
      ...(sp.featured ? ['<span class="badge">官方特色物種</span>'] : []),
      ...sp.status.map((s) => `<span class="badge alt">${esc(s)}</span>`),
    ];

    let html = `<h2 class="sp-title">${esc(sp.zh)}</h2>
      <p class="sp-sci">${esc(sp.sci)}${sp.synonyms ? `<span class="sp-syn">（亦作 ${esc(sp.synonyms.join('、'))}）</span>` : ''}</p>
      ${sp.alt.length ? `<p class="sp-alt">別名：${esc(sp.alt.join('、'))}</p>` : ''}
      <div class="sp-tags">${tags.join('')}</div>`;

    html += `<div class="sp-section"><dl>
      ${sp.family ? `<dt>科名</dt><dd>${esc(sp.family)}${sp.familySci ? `（<i>${esc(sp.familySci)}</i>）` : ''}</dd>` : ''}
    </dl></div>`;

    const off = sp.official;
    if (off) {
      const seasons = SEASONS.map((s) => `<span class="season${off.seasons.includes(s) ? ' on' : ''}">${s}</span>`).join('');
      html += `<div class="sp-section official-box">
        <h3>太平山官方介紹</h3>
        ${off.description ? `<p>${esc(off.description)}</p>` : ''}
        <dl>
          ${off.distribution ? `<dt>分布</dt><dd>${esc(off.distribution)}</dd>` : ''}
          ${off.spots ? `<dt>觀賞地點</dt><dd>${esc(off.spots)}</dd>` : ''}
          ${off.trails.length ? `<dt>步道</dt><dd>${esc(off.trails.join('、'))}</dd>` : ''}
          ${off.seasons.length ? `<dt>建議季節</dt><dd><div class="season-row">${seasons}</div></dd>` : ''}
        </dl>
      </div>`;
    }
    if (sp.wiki) {
      html += `<div class="sp-section"><h3>物種簡介</h3><p>${esc(sp.wiki.text)}</p></div>`;
    }

    html += `<div class="sp-section"><h3>在太平山的觀察月份</h3>${monthChart(sp)}</div>`;

    const links = [];
    if (off) links.push(['太平山官方頁面', off.page]);
    if (sp.links.taieol) links.push(['臺灣生命大百科', sp.links.taieol]);
    if (sp.links.taicol) links.push(['TaiCOL 物種名錄', sp.links.taicol]);
    if (sp.links.inat) links.push(['iNaturalist', sp.links.inat]);
    if (sp.wiki) links.push(['維基百科', sp.wiki.url]);
    html += `<div class="sp-section"><h3>延伸閱讀</h3><div class="sp-links">
      ${links.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join('')}
    </div></div>`;

    const cr = [];
    if (sp.credits.photo) cr.push(`照片：${credit(sp.credits.photo)}`);
    if (sp.credits.text) cr.push(`官方介紹文字：${credit(sp.credits.text)}`);
    if (sp.credits.wiki) cr.push(`物種簡介：${credit(sp.credits.wiki)}`);
    html += `<div class="sp-section"><h3>資料來源與授權</h3><div class="sp-credits">${cr.join('<br>')}</div></div>`;

    html += `<div class="form-actions sp-section">
      <button id="spRecord" class="btn btn-primary" type="button">我看到了！拍照記錄</button>
    </div>`;

    $('#spBody').innerHTML = html;
    dialog.showModal();
    dialog.scrollTop = 0;
  }

  /* ---------- 月份圖提示 ---------- */
  let tip = null;
  function showTip(bar) {
    hideTip();
    const box = bar.closest('.months');
    tip = document.createElement('div');
    tip.className = 'month-tip';
    tip.textContent = bar.dataset.tip;
    const b = bar.getBoundingClientRect();
    const r = box.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(b.left - r.left + b.width / 2, 36), r.width - 36)}px`;
    box.append(tip);
  }
  function hideTip() { if (tip) { tip.remove(); tip = null; } }

  /* ---------- 事件 ---------- */
  $('#guideGrid').addEventListener('click', (e) => {
    const c = e.target.closest('[data-sp]');
    if (c) open(c.dataset.sp);
  });
  $('#guideChips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-chip]');
    if (!c) return;
    ui.chip = c.dataset.chip;
    render();
  });
  $$('.guide-tabs .tab').forEach((t) => t.addEventListener('click', () => {
    ui.cat = t.dataset.gcat;
    ui.chip = 'all';
    if (ui.q) { $('#guideSearch').value = ''; ui.q = ''; }
    render();
  }));
  let searchTimer;
  $('#guideSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { ui.q = norm(e.target.value); render(); }, 120);
  });

  $('#spBody').addEventListener('pointerover', (e) => { const b = e.target.closest('.month-bar'); if (b) showTip(b); });
  $('#spBody').addEventListener('pointerout', (e) => { if (e.target.closest('.month-bar')) hideTip(); });
  $('#spBody').addEventListener('focusin', (e) => { const b = e.target.closest('.month-bar'); if (b) showTip(b); });
  $('#spBody').addEventListener('focusout', hideTip);
  $('#spBody').addEventListener('click', (e) => {
    const b = e.target.closest('.month-bar');
    if (b) showTip(b);
    if (e.target.closest('#spRecord') && current) {
      setCameraPrefill({ name: current.zh, category: current.category === 'plant' ? 'plant' : 'animal' });
      dialog.close();
      showView('camera');
    }
  });

  $('#speciesClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', hideTip);

  $('.nav-btn[data-view="guide"]').addEventListener('click', load);

  return { load, open };
})();
