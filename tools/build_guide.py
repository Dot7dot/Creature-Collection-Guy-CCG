#!/usr/bin/env python3
"""
太平山生物圖鑑資料建置程式

資料來源（依優先順序）：
  1. 台灣山林悠遊網（林業及自然保育署）太平山國家森林遊樂區頁面與園區步道頁面的「特色物種」
     https://recreation.forest.gov.tw/Forest/RA?typ_id=0100001
  2. iNaturalist「太平山國家森林遊樂區」(place 149596) 研究級觀察紀錄
  3. TaiCOL 臺灣物種名錄 API：中文名、學名、科名、特有種、保育等級
  4. 中文維基百科（臺灣正體）物種簡介

輸出：
  guide/species.json  物種資料
  guide/img/*.jpg     物種照片（縮圖，僅使用 CC 授權照片）

用法：
  python3 tools/build_guide.py [--cache DIR]
"""
import argparse
import hashlib
import html
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'guide')
IMG_DIR = os.path.join(OUT_DIR, 'img')

RECREATION = 'https://recreation.forest.gov.tw'
AREA_URL = f'{RECREATION}/Forest/RA?typ_id=0100001'
# 位於太平山國家森林遊樂區內的步道
TRAIL_IDS = ['013', '014', '016', '018', '019', '020', '021', '165']
INAT_PLACE = 149596
INAT = 'https://api.inaturalist.org/v1'
TAICOL = 'https://api.taicol.tw/v2'
WIKI = 'https://zh.wikipedia.org/w/api.php'
UA = 'nature-journal-guide-builder/1.0'

# 每個類群最多收錄幾種（依觀察次數排序）
LIMITS = {
    'Mammalia': 999, 'Aves': 999, 'Amphibia': 999, 'Reptilia': 999,
    'Arachnida': 12, 'Insecta': 160, 'Plantae': 200,
}
# 可使用的照片授權（偏好順序）。不使用「保留所有權利」的照片。
LICENSES = ['cc0', 'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nd', 'cc-by-nc-nd']
LICENSE_LABEL = {
    'cc0': 'CC0', 'cc-by': 'CC BY', 'cc-by-sa': 'CC BY-SA', 'cc-by-nc': 'CC BY-NC',
    'cc-by-nc-sa': 'CC BY-NC-SA', 'cc-by-nd': 'CC BY-ND', 'cc-by-nc-nd': 'CC BY-NC-ND',
}

CJK = re.compile(r'[一-鿿]')


# ---------------------------------------------------------------- HTTP（含快取）
class Fetcher:
    def __init__(self, cache_dir):
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self.last = {}

    def _path(self, url):
        return os.path.join(self.cache_dir, hashlib.sha1(url.encode()).hexdigest())

    def get(self, url, binary=False, delay=1.0):
        p = self._path(url)
        if os.path.exists(p):
            with open(p, 'rb') as f:
                data = f.read()
            return data if binary else data.decode('utf-8', 'ignore')
        host = urllib.parse.urlparse(url).netloc
        wait = self.last.get(host, 0) + delay - time.time()
        if wait > 0:
            time.sleep(wait)
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = r.read()
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 3:
                    raise
                print(f'  retry {url[:90]} ({e})', file=sys.stderr)
                slow = getattr(e, 'code', None) == 429
                time.sleep((20 if slow else 3) * (attempt + 1))
        self.last[host] = time.time()
        with open(p, 'wb') as f:
            f.write(data)
        return data if binary else data.decode('utf-8', 'ignore')

    def json(self, url, delay=1.0):
        return json.loads(self.get(url, delay=delay))


def qs(params):
    return urllib.parse.urlencode(params)


def clean(text):
    text = html.unescape(re.sub(r'<[^>]+>', '', text or ''))
    return re.sub(r'\s+', ' ', text).strip()


def split_names(raw):
    names = [n.strip() for n in raw.split(';') if n.strip()]
    out = []
    for n in names:
        if n not in out:
            out.append(n)
    return out


# ---------------------------------------------------------------- 1. 官方特色物種
def parse_official_cards(page):
    """解析「特色物種」的物種卡片與標籤"""
    cards = []
    for block in page.split('<div class="gray_block">')[1:]:
        block = block.split('<div class="item">')[0]
        title = re.search(r'<div class="info_block">\s*<div class="title">\s*([^<]+?)\s*</div>', block)
        if not title:
            continue
        card = {'names': split_names(title.group(1))}
        img = re.search(r'<div class="full_photo">\s*<img src="([^"]+)"', block)
        card['photo'] = RECREATION + img.group(1) if img else None
        info = re.search(r'<div class="photo_info">(.*?)</div>\s*</div>', block, re.S)
        if info:
            parts = [clean(x) for x in re.findall(r'<div>(.*?)</div>', info.group(0), re.S)]
            card['photo_credit'] = dict(p.split('：', 1) for p in parts if '：' in p)
        card['seasons'] = [clean(x) for x in re.findall(r'<div class="circle">(.*?)</div>', block, re.S)]
        for label, key in [('物種描述', 'description'), ('分佈情形', 'distribution'), ('建議觀賞地點', 'spots')]:
            m = re.search(rf'<div class="bg_title">\s*{label}\s*</div>\s*<div class="text">(.*?)</div>', block, re.S)
            card[key] = clean(m.group(1)) if m else ''
        src = re.search(r'<div class="source">(.*?)</div>\s*(?:<div class="web">|</div>\s*</div>)', block, re.S)
        if src:
            parts = [clean(x) for x in re.findall(r'<div>(.*?)</div>', src.group(0), re.S)]
            card['text_credit'] = dict(p.split('：', 1) for p in parts if '：' in p)
        eol = re.search(r'<div class="web">\s*<a href="([^"]+)"', block)
        card['taieol'] = eol.group(1) if eol else None
        cards.append(card)
    tags = [
        {'names': split_names(t), 'taieol': u}
        for t, u in re.findall(r'<a class="tag" title="([^"]+?)\(另開新視窗\)" href="([^"]+)"', page)
    ]
    return cards, tags


def crawl_official(f):
    print('1. 官方特色物種')
    official = []
    page = f.get(AREA_URL)
    cards, tags = parse_official_cards(page)
    for c in cards + tags:
        c['where'] = '太平山國家森林遊樂區'
        c['page'] = AREA_URL
    official += cards + tags
    for tid in TRAIL_IDS:
        url = f'{RECREATION}/Trail/RT?tr_id={tid}'
        page = f.get(url)
        trail = clean(re.search(r'<title>(.*?)</title>', page, re.S).group(1)).split(' - ')[0]
        cards, tags = parse_official_cards(page)
        for c in cards + tags:
            c['where'] = trail
            c['page'] = url
            c['trail'] = trail
        official += cards + tags
    print(f'   卡片／標籤共 {len(official)} 筆')
    return official


# ---------------------------------------------------------------- 3. TaiCOL
def taicol_pick(data):
    data = [d for d in data if d.get('taxon_status') == 'accepted' and d.get('is_in_taiwan')] or data
    data = sorted(data, key=lambda d: d.get('rank') not in ('Species', 'Subspecies', 'Variety'))
    return data[0] if data else None


def taicol_by_common(f, names):
    for n in names:
        for variant in dict.fromkeys([n, n.replace('台', '臺')]):
            res = f.json(f'{TAICOL}/taxon?{qs({"common_name": variant})}', delay=0.3)
            hit = taicol_pick(res.get('data') or [])
            if hit:
                return hit
    return None


def taicol_by_name(f, sci):
    res = f.json(f'{TAICOL}/taxon?{qs({"scientific_name": sci})}', delay=0.3)
    return taicol_pick(res.get('data') or [])


def taicol_info(t):
    if not t:
        return {}
    higher = {h['rank']: h for h in t.get('higher_taxa') or []}

    def zh(rank):
        h = higher.get(rank)
        return h.get('common_name_c') if h else None

    alt = [a.strip() for a in (t.get('alternative_name_c') or '').split(',') if a.strip()]
    status = []
    if t.get('is_endemic'):
        status.append('臺灣特有')
    if t.get('alien_type') in ('naturalized', 'invasive'):
        status.append('外來種')
    elif t.get('alien_type') == 'cultured':
        status.append('栽培種')
    prot = {'I': '第一級保育類', 'II': '第二級保育類', 'III': '第三級保育類'}.get(t.get('protected'))
    if prot:
        status.append(prot)
    red = {'NCR': '國家極危', 'NEN': '國家瀕危', 'NVU': '國家易危', 'NNT': None, 'NLC': None}
    if red.get(t.get('redlist')):
        status.append(red[t['redlist']])
    return {
        'ranks': {r.lower(): {'name': h['simple_name']} for r, h in higher.items()},
        'kingdom': (higher.get('Kingdom') or {}).get('simple_name'),
        'taicol_id': t['taxon_id'],
        'sci': t['simple_name'],
        'zh': t.get('common_name_c'),
        'alt': alt,
        'family': zh('Family'),
        'family_sci': (higher.get('Family') or {}).get('simple_name'),
        'order': zh('Order'),
        'status': status,
    }


# ---------------------------------------------------------------- 2. iNaturalist
def inat_species_counts(f, iconic):
    out, page = [], 1
    while True:
        res = f.json(f'{INAT}/observations/species_counts?' + qs({
            'place_id': INAT_PLACE, 'iconic_taxa': iconic, 'quality_grade': 'research',
            'per_page': 500, 'page': page, 'locale': 'zh-TW', 'preferred_place_id': INAT_PLACE,
        }))
        out += res['results']
        if len(out) >= res['total_results'] or not res['results']:
            return out
        page += 1


def inat_month_counts(f):
    """每個月份的物種觀察數：{taxon_id: [1月..12月]}"""
    months = {}
    for m in range(1, 13):
        page = 1
        while True:
            res = f.json(f'{INAT}/observations/species_counts?' + qs({
                'place_id': INAT_PLACE, 'quality_grade': 'research', 'month': m,
                'per_page': 500, 'page': page,
            }))
            for r in res['results']:
                months.setdefault(r['taxon']['id'], [0] * 12)[m - 1] += r['count']
            if page * 500 >= res['total_results'] or not res['results']:
                break
            page += 1
    return months


def inat_taxa(f, ids):
    out = {}
    ids = list(ids)
    for i in range(0, len(ids), 30):
        chunk = ','.join(str(x) for x in ids[i:i + 30])
        res = f.json(f'{INAT}/taxa/{chunk}?' + qs({'locale': 'zh-TW', 'preferred_place_id': INAT_PLACE}))
        for t in res['results']:
            out[t['id']] = t
    return out


def inat_find(f, sci):
    """以學名找 iNaturalist 物種"""
    want = sci.replace(' var. ', ' ').replace(' subsp. ', ' ').replace(' f. ', ' ')
    for q in dict.fromkeys([want, ' '.join(want.split()[:2])]):
        res = f.json(f'{INAT}/taxa?' + qs({'q': q, 'is_active': 'true', 'per_page': 5}))
        for t in res['results']:
            if t['name'] == q:
                return t
    return None


def pick_photo(taxon):
    photos = []
    if taxon.get('default_photo'):
        photos.append(taxon['default_photo'])
    photos += [tp['photo'] for tp in taxon.get('taxon_photos') or []]
    best = None
    for p in photos:
        lic = (p.get('license_code') or '').lower()
        if lic not in LICENSES or not p.get('medium_url'):
            continue
        rank = LICENSES.index(lic)
        if '-nd' not in lic:
            return p
        if best is None or rank < LICENSES.index(best['license_code'].lower()):
            best = p
    return best


def ancestor_names(taxon):
    return {a['rank']: a for a in taxon.get('ancestors') or []}


# ---------------------------------------------------------------- 分類
def classify(iconic, anc):
    """回傳 (category, group)。category: animal / insect / plant"""
    names = {r: a['name'] for r, a in anc.items()}
    if iconic == 'Insecta':
        order = names.get('order')
        if order == 'Lepidoptera':
            return 'insect', '蝴蝶' if names.get('superfamily') == 'Papilionoidea' else '蛾'
        return 'insect', {
            'Coleoptera': '甲蟲', 'Odonata': '蜻蜓豆娘', 'Hemiptera': '蟬與椿象',
            'Hymenoptera': '蜂與螞蟻', 'Orthoptera': '蝗蟲與螽斯',
        }.get(order, '其他昆蟲')
    if iconic == 'Plantae':
        cls = names.get('class')
        phylum = names.get('phylum')
        if phylum in ('Bryophyta', 'Marchantiophyta', 'Anthocerotophyta'):
            return 'plant', '苔蘚'
        if cls in ('Polypodiopsida', 'Lycopodiopsida'):
            return 'plant', '蕨類'
        if cls in ('Pinopsida', 'Cycadopsida', 'Ginkgoopsida', 'Gnetopsida'):
            return 'plant', '裸子植物'
        if names.get('family') == 'Orchidaceae':
            return 'plant', '蘭花'
        if cls == 'Liliopsida':
            return 'plant', '單子葉植物'
        return 'plant', '雙子葉植物'
    return 'animal', {
        'Mammalia': '哺乳類', 'Aves': '鳥類', 'Amphibia': '兩棲類', 'Reptilia': '爬蟲類', 'Arachnida': '蜘蛛類',
    }.get(iconic, '其他動物')


# ---------------------------------------------------------------- 4. 維基百科
def _trim(text):
    text = re.sub(r'\s*\n+\s*', '\n', text.strip())
    if len(text) > 420:
        cut = max(text.rfind('。', 0, 420), text.rfind('；', 0, 420))
        text = text[:cut + 1] if cut > 80 else text[:420] + '…'
    return text


def wiki_batch(f, titles):
    """一次查詢多個條目（每批 20 個），回傳 {原始標題: {'text','url','title'}}"""
    found = {}
    titles = list(dict.fromkeys(t for t in titles if t))
    for i in range(0, len(titles), 20):
        chunk = titles[i:i + 20]
        try:
            res = f.json(WIKI + '?' + qs({
                'action': 'query', 'prop': 'extracts', 'exintro': 1, 'explaintext': 1, 'exlimit': 20,
                'redirects': 1, 'format': 'json', 'variant': 'zh-tw', 'titles': '|'.join(chunk),
            }), delay=2.0)
        except Exception as e:  # noqa: BLE001
            print(f'   ! 維基百科批次查詢失敗：{e}')
            continue
        q = res.get('query', {})
        alias = {}
        for key in ('normalized', 'converted', 'redirects'):
            for m in q.get(key) or []:
                alias[m['from']] = m['to']
        pages = {p['title']: p for p in (q.get('pages') or {}).values()}

        def resolve(t):
            seen = set()
            while t in alias and t not in seen:
                seen.add(t)
                t = alias[t]
            return t

        for t in chunk:
            p = pages.get(resolve(t))
            if p and p.get('extract'):
                found[t] = {
                    'text': _trim(p['extract']),
                    'url': 'https://zh.wikipedia.org/zh-tw/' + urllib.parse.quote(p['title'].replace(' ', '_')),
                }
    return found


# ---------------------------------------------------------------- 照片
def save_image(f, url, name):
    path = os.path.join(IMG_DIR, name)
    if not os.path.exists(path):
        data = f.get(url, binary=True, delay=0.3)
        im = Image.open(io.BytesIO(data)).convert('RGB')
        im.thumbnail((480, 480))
        im.save(path, 'JPEG', quality=78, optimize=True, progressive=True)
    return f'guide/img/{name}'


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(ROOT, '.cache', 'guide'))
    args = ap.parse_args()
    f = Fetcher(args.cache)
    os.makedirs(IMG_DIR, exist_ok=True)

    species = {}  # key -> entry

    # ---- 官方資料
    official = crawl_official(f)
    off_by_key = {}
    for c in official:
        t = taicol_by_common(f, c['names'])
        info = taicol_info(t)
        key = info.get('sci') or c['names'][0]
        e = off_by_key.get(key)
        if not e:
            e = off_by_key[key] = {'official': None, 'tag_names': [], 'trails': [], 'taicol': info, 'raw_names': []}
        e['raw_names'] += c['names']
        if c.get('trail'):
            e['trails'].append(c['trail'])
        if 'description' in c and not e['official']:
            e['official'] = c
        e.setdefault('pages', []).append(c['page'])
        if not e.get('taieol') and c.get('taieol'):
            e['taieol'] = c['taieol']
    print(f'   官方物種（去重複後）{len(off_by_key)} 種')

    # ---- iNaturalist 候選
    print('2. iNaturalist 太平山觀察紀錄')
    counts = {}
    iconic_of = {}
    for iconic, limit in LIMITS.items():
        rows = inat_species_counts(f, iconic)
        n = 0
        for r in rows:
            t = r['taxon']
            if t['rank'] not in ('species', 'subspecies', 'variety', 'form'):
                continue
            counts[t['id']] = r['count']
            iconic_of[t['id']] = iconic
            if n < limit:
                species[t['id']] = {'inat_id': t['id']}
                n += 1
        print(f'   {iconic}: 共 {len(rows)} 種，收錄前 {n} 種')

    # 官方物種對應到 iNaturalist
    for key, e in off_by_key.items():
        sci = e['taicol'].get('sci')
        t = inat_find(f, sci) if sci else None
        if t:
            e['inat_id'] = t['id']
            iconic_of.setdefault(t['id'], t.get('iconic_taxon_name'))
            species.setdefault(t['id'], {'inat_id': t['id']})
            species[t['id']]['off'] = e
        else:
            species[f'off:{key}'] = {'inat_id': None, 'off': e}
            print(f'   ! 官方物種在 iNaturalist 找不到：{key}')

    print('   取得物種詳細資料…')
    taxa = inat_taxa(f, [s['inat_id'] for s in species.values() if s['inat_id']])
    print('   取得各月份觀察數…')
    months = inat_month_counts(f)

    # ---- 組合
    print('3. TaiCOL + 照片')
    out = []
    for i, (key, s) in enumerate(species.items()):
        t = taxa.get(s['inat_id']) if s['inat_id'] else None
        off = s.get('off')
        oc = off['official'] if off else None
        if off:
            tc = off['taicol']
        else:
            tc = taicol_info(taicol_by_name(f, t['name']))
            if not tc and t.get('rank') != 'species':
                tc = taicol_info(taicol_by_name(f, ' '.join(t['name'].split()[:2])))

        zh = tc.get('zh') or (off['raw_names'][0] if off else None) or (t or {}).get('preferred_common_name')
        if not zh or not CJK.search(zh):
            continue
        sci = tc.get('sci') or (t['name'] if t else '')
        alt = []
        for n in (off['raw_names'] if off else []) + tc.get('alt', []) + ([t.get('preferred_common_name')] if t else []):
            if n and n != zh and CJK.search(n) and n not in alt and n.replace('台', '臺') != zh:
                alt.append(n)

        iconic = iconic_of.get(s['inat_id']) if s['inat_id'] else None
        anc = ancestor_names(t) if t else tc.get('ranks', {})
        if not iconic:
            cls = anc.get('class', {}).get('name')
            iconic = 'Plantae' if tc.get('kingdom') == 'Plantae' else cls
        category, group = classify(iconic, anc)

        entry = {
            'id': f'inat-{s["inat_id"]}' if s['inat_id'] else 'off-' + hashlib.md5(key.encode()).hexdigest()[:8],
            'zh': zh,
            'alt': alt[:5],
            'sci': sci,
            'category': category,
            'group': group,
            'family': tc.get('family') or (anc.get('family', {}).get('preferred_common_name')),
            'familySci': tc.get('family_sci') or anc.get('family', {}).get('name'),
            'status': tc.get('status', []),
            'featured': bool(off),
            'obs': counts.get(s['inat_id'], 0) if s['inat_id'] else 0,
            'months': months.get(s['inat_id']) if s['inat_id'] else None,
            'links': {},
            'credits': {},
        }
        if s['inat_id']:
            entry['links']['inat'] = f'https://www.inaturalist.org/taxa/{s["inat_id"]}'
        if tc.get('taicol_id'):
            entry['links']['taicol'] = f'https://taicol.tw/zh-hant/taxon/{tc["taicol_id"]}'
        if off and off.get('taieol'):
            entry['links']['taieol'] = off['taieol']

        # 官方說明
        if off:
            entry['official'] = {
                'description': oc['description'] if oc else '',
                'distribution': oc['distribution'] if oc else '',
                'spots': oc['spots'] if oc else '',
                'seasons': oc['seasons'] if oc else [],
                'trails': sorted(set(off['trails'])),
                'page': off['pages'][0],
            }
            if oc and oc.get('text_credit'):
                tcred = oc['text_credit']
                entry['credits']['text'] = {
                    'by': tcred.get('作者', ''), 'source': tcred.get('提供者', ''),
                    'license': tcred.get('授權方式', '').replace('CC by by-nc', 'CC BY-NC'),
                }

        # 維基百科：先記下候選標題，稍後批次查詢
        titles = []
        if t and t.get('wikipedia_url') and 'zh.wikipedia' in t['wikipedia_url']:
            titles.append(urllib.parse.unquote(t['wikipedia_url'].rsplit('/', 1)[-1]))
        titles += [zh, sci]
        if not (oc and oc.get('description')):
            entry['_wiki_titles'] = list(dict.fromkeys(titles))

        # 照片：官方照片優先，其次 iNaturalist CC 授權照片
        try:
            if oc and oc.get('photo'):
                entry['photo'] = save_image(f, oc['photo'], entry['id'] + '.jpg')
                pc = oc.get('photo_credit', {})
                entry['credits']['photo'] = {
                    'by': pc.get('拍攝者', ''), 'source': pc.get('提供者', ''),
                    'license': pc.get('授權方式', '').replace('CC by by-nc', 'CC BY-NC'),
                    'url': off['pages'][0],
                }
            elif t:
                p = pick_photo(t)
                if p:
                    entry['photo'] = save_image(f, p['medium_url'], entry['id'] + '.jpg')
                    by = re.sub(r'^\(c\)\s*', '', p.get('attribution', '')).split(',')[0].strip()
                    entry['credits']['photo'] = {
                        'by': by, 'source': 'iNaturalist',
                        'license': LICENSE_LABEL.get(p['license_code'].lower(), p['license_code']),
                        'url': f'https://www.inaturalist.org/photos/{p["id"]}',
                    }
        except Exception as e:  # noqa: BLE001
            print(f'   ! 照片下載失敗 {zh}: {e}')
        if 'photo' not in entry:
            print(f'   - 無可用照片：{zh}')
            continue
        out.append(entry)
        if (i + 1) % 50 == 0:
            print(f'   {i + 1}/{len(species)}')

    print('4. 維基百科物種簡介（批次查詢）')
    wanted = [t for e in out for t in e.get('_wiki_titles', [])]
    wiki = wiki_batch(f, wanted)
    for e in out:
        genus = e['sci'].split()[0] if e['sci'] else '\0'
        for t in e.pop('_wiki_titles', []):
            w = wiki.get(t)
            if w and genus in w['text']:  # 確認是同一個物種／屬的條目
                e['wiki'] = w
                e['credits']['wiki'] = {'source': '維基百科', 'license': 'CC BY-SA 4.0', 'url': w['url']}
                break
    print(f'   有維基百科簡介：{sum(1 for e in out if "wiki" in e)} 種')

    order = {'animal': 0, 'insect': 1, 'plant': 2}
    out.sort(key=lambda e: (order[e['category']], not e['featured'], -e['obs'], e['zh']))
    meta = {
        'title': '太平山生物圖鑑',
        'built': date.today().isoformat(),
        'place': '宜蘭縣 太平山國家森林遊樂區',
        'sources': [
            {'name': '台灣山林悠遊網－太平山國家森林遊樂區（林業及自然保育署）', 'url': AREA_URL},
            {'name': 'iNaturalist 太平山國家森林遊樂區觀察紀錄', 'url': f'https://www.inaturalist.org/places/{INAT_PLACE}'},
            {'name': 'TaiCOL 臺灣物種名錄', 'url': 'https://taicol.tw/'},
            {'name': '中文維基百科', 'url': 'https://zh.wikipedia.org/'},
        ],
        'count': len(out),
    }
    with open(os.path.join(OUT_DIR, 'species.json'), 'w', encoding='utf-8') as fp:
        json.dump({'meta': meta, 'species': out}, fp, ensure_ascii=False, separators=(',', ':'))

    # 移除不再使用的照片
    used = {os.path.basename(e['photo']) for e in out}
    for name in os.listdir(IMG_DIR):
        if name not in used:
            os.remove(os.path.join(IMG_DIR, name))

    by = {}
    for e in out:
        by.setdefault((e['category'], e['group']), 0)
        by[(e['category'], e['group'])] += 1
    print(f'\n完成：{len(out)} 種（官方特色物種 {sum(e["featured"] for e in out)} 種）')
    for k, v in sorted(by.items()):
        print(f'   {k[0]:7s} {k[1]}: {v}')


if __name__ == '__main__':
    main()
