// 해외 주식 공포지수 앱 — 의존성 없는 Node 서버 (Node 18+)
// 실행: node server.js  →  http://localhost:8080
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CACHE_MS = 5 * 60 * 1000;
const cache = {};

async function cached(key, fn) {
  const c = cache[key];
  if (c && Date.now() - c.t < CACHE_MS) return c.v;
  try {
    const v = await fn();
    cache[key] = { t: Date.now(), v };
    return v;
  } catch (e) {
    if (c) return c.v; // 실패 시 마지막 값 사용
    throw e;
  }
}

async function getFng() {
  const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    headers: { 'User-Agent': UA, Referer: 'https://edition.cnn.com/', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error('CNN ' + r.status);
  const d = await r.json();
  const pick = k => d[k] ? { score: d[k].score, rating: d[k].rating } : null;
  return {
    now: d.fear_and_greed,
    history: d.fear_and_greed_historical.data.map(p => [p.x, Math.round(p.y * 10) / 10]),
    parts: {
      momentum: pick('market_momentum_sp500'),
      strength: pick('stock_price_strength'),
      breadth: pick('stock_price_breadth'),
      putcall: pick('put_call_options'),
      volatility: pick('market_volatility_vix'),
      junk: pick('junk_bond_demand'),
      safehaven: pick('safe_haven_demand'),
    },
  };
}

async function getVix() {
  let last;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1y&interval=1d`, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('Yahoo ' + r.status);
      const res = (await r.json()).chart.result[0];
      const q = res.indicators.quote[0].close;
      const series = res.timestamp.map((t, i) => [t * 1000, q[i]]).filter(p => p[1] != null);
      return { price: res.meta.regularMarketPrice, prevClose: res.meta.chartPreviousClose, time: res.meta.regularMarketTime * 1000, series };
    } catch (e) { last = e; }
  }
  throw last;
}

const QUOTES = [
  // [심볼, 이름, 섹터]
  ['^GSPC', 'S&P 500', 'idx'], ['^IXIC', '나스닥', 'idx'], ['^SOX', '필라델피아 반도체', 'idx'],
  ['^KS11', '코스피', 'idx'], ['^KQ11', '코스닥', 'idx'],
  ['IONQ', '아이온큐', 'ai'], ['PLTR', '팔란티어', 'ai'],
  ['NVDA', '엔비디아', 'us'], ['TSLA', '테슬라', 'us'], ['GOOGL', '알파벳(구글)', 'us'], ['005930.KS', '삼성전자', 'ai'],
  ['012450.KS', '한화에어로스페이스', 'space'], ['272210.KS', '한화시스템', 'space'], ['DXYZ', '스페이스X 간접(DXYZ)', 'space'],
  ['VST', '비스트라', 'power'], ['CEG', '컨스텔레이션 에너지', 'power'], ['GEV', 'GE 버노바', 'power'],
  ['ETN', '이튼', 'power'], ['OKLO', '오클로', 'power'], ['SMR', '뉴스케일 파워', 'power'],
  ['267260.KS', 'HD현대일렉트릭', 'power'], ['010120.KS', 'LS일렉트릭', 'power'], ['298040.KS', '효성중공업', 'power'],
  ['VRT', '버티브', 'cool'], ['MOD', '모딘', 'cool'], ['NVT', '엔벤트', 'cool'], ['3017.TW', '아시아바이탈(AVC)', 'cool'],
  ['BTC-USD', '비트코인', 'coin'], ['ETH-USD', '이더리움', 'coin'], ['SOL-USD', '솔라나', 'coin'], ['XRP-USD', '리플(XRP)', 'coin'],
];

async function getQuotes() {
  const one = async ([sym, name, sector]) => {
    let last;
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`, { headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error('Yahoo ' + r.status);
        const res = (await r.json()).chart.result[0];
        const q = res.indicators.quote[0].close;
        const series = res.timestamp.map((t, i) => [t * 1000, q[i]]).filter(p => p[1] != null);
        const price = res.meta.regularMarketPrice;
        const prev = series.length > 1 ? series[series.length - 2][1] : res.meta.chartPreviousClose;
        return { symbol: sym, name, sector, currency: res.meta.currency, price, changePct: (price - prev) / prev * 100, monthPct: (price - series[0][1]) / series[0][1] * 100, series };
      } catch (e) { last = e; }
    }
    throw last;
  };
  const rs = await Promise.allSettled(QUOTES.map(one));
  return rs.map((r, i) => r.status === 'fulfilled' ? r.value
    : { symbol: QUOTES[i][0], name: QUOTES[i][1], sector: QUOTES[i][2], error: true });
}

const KEYFILE = path.join(__dirname, 'krx-key.txt');
let KRX_KEY = process.env.KRX_KEY || (fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE, 'utf8').trim() : '');
let FOREIGN = null; // {kospi:{day,d5,date}, kosdaq:{day,date}}
async function getForeign() {
  if (!KRX_KEY) return { noKey: true };
  const d = new Date(); const pad = n => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const dayRows = {};
  for (const [mkt, out] of [['STK', 'kospi'], ['KSQ', 'kosdaq']]) {
    let v;
    try {
      const u = new URL('https://openapi.krx.co.kr/auth/request/Main.cmd');
      u.searchParams.set('AUTH_KEY', KRX_KEY); u.searchParams.set('comp_cod', 'krx');
      u.searchParams.set('trCd', 'gen_trd_val_rfq_invr'); u.searchParams.set('sectorCd', '9999999999999');
      u.searchParams.set('strtDd', today); u.searchParams.set('endDd', today);
      u.searchParams.set('basDd', today); u.searchParams.set('mktId', mkt); u.searchParams.set('inqTpCd', '1');
      u.searchParams.set('share', '1'); u.searchParams.set('money', '1'); u.searchParams.set('csvxls_isNo', 'false');
      const r = await fetch(u, { headers: { 'User-Agent': UA } });
      const j = await r.json();
      const rows = j.OutBlock_1 || [];
      const vals = rows.filter(x => x.invstCd === '9000').map(x => ({ dd: x.basDd, net: +(x.netPrcAmt || x.sbPrcAmt - x.bgPrcAmt || 0) }));
      if (vals.length) dayRows[out] = vals;
    } catch (e) { dayRows[out] = null; }
  }
  const acc = v => { const d5 = v.slice(0, 5).reduce((s, x) => s + x.net, 0); return { day: v[0].net, dayDate: v[0].dd, d5, date: v[0].dd }; };
  return { kospi: dayRows.kospi ? acc(dayRows.kospi) : null, kosdaq: dayRows.kosdaq ? acc(dayRows.kosdaq) : null };
}

function recs(quotes, fng, vix) {
  const fg = fng?.now, vX = vix?.price;
  const base = '분할 매수·손절 원칙 유지';
  return quotes.map(q => {
    if (q.error) return { symbol: q.symbol, name: q.name, sector: q.sector, error: true };
    const s = (q.series || []).map(p2 => p2[1]);
    if (s.length < 21) return { symbol: q.symbol, name: q.name, sector: q.sector, error: true };
    const n = s.length, price = q.price;
    const avg = a => s.slice(-a).reduce((x, y) => x + y, 0) / a;
    const sma5 = avg(5), sma20 = avg(20), mom = (price - s[n - 6]) / s[n - 6] * 100;
    const hi = Math.max(...s), lo = Math.min(...s);
    const pos = (price - lo) / (hi - lo || 1) * 100;
    let score = 0, why = [];
    if (price > sma20) { score++; why.push(`단기 흐름 상승(20일 평균 위, ${sma20 < s[n-2] ? '평균 선 상승 중' : '평균선 회복'})`) } else { score--; why.push('단기 흐름 약세(20일 평균 아래)') }
    if (mom > 3) { score++; why.push(`1주 +${mom.toFixed(1)}% 상승 압력`) } else if (mom < -3) { score--; why.push(`1주 ${mom.toFixed(1)}% 하락`) }
    if (pos < 25) { score++; why.push(`1개월 박스 저권(${pos.toFixed(0)}% 위치)`) } else if (pos > 80) { score--; why.push(`1개월 고권(${pos.toFixed(0)}% 위치) · 차익 실현 주의`) }
    if (fg != null) { if (fg <= 25) { score++; why.push(`공포탐욕 ${fg} 극단적 공포`) } else if (fg >= 75) { score--; why.push(`공포탐욕 ${fg} 탐욕 과열`) } }
    if (vX != null) { if (vX >= 30) { score++; why.push(`VIX ${vX.toFixed(1)} 공포 확산`) } else if (vX < 15) { score--; why.push(`VIX ${vX.toFixed(1)} 저변동 · 하방 점프 대비`) } }
    let act, strength;
    if (score >= 2) { act = '매수'; strength = '강' } else if (score === 1) { act = '매수'; strength = '약' }
    else if (score <= -2) { act = '매도'; strength = '강' } else if (score === -1) { act = '매도'; strength = '약' }
    else { act = '관망'; strength = '-' }
    const tip = act === '매수' ? (pos > 70 ? '눌림목 대기 우선' : base)
      : act === '매도' ? (pos < 30 ? '추가 하락 시 분할 익매' : '목표가 도달분 익매')
      : price > sma20 ? '보유 유지 · 추세 꺾이면 재평가' : '신호 대기';
    return { symbol: q.symbol, name: q.name, sector: q.sector, action: act, strength, why: why.join(' · '), tip, price };
  }).sort((a, b) => a.sector.localeCompare(b.sector) || (b.strength === '강' ? 0 : b.strength === '약' ? 1 : 2) - (a.strength === '강' ? 0 : a.strength === '약' ? 1 : 2));
}

async function getKr() {
  const SYMS = [['^KS11', '코스피'], ['^KQ11', '코스닥'], ['USDKRW=X', '원·달러 환율']];
  const items = await Promise.all(SYMS.map(async ([sym, name]) => {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('yahoo ' + sym + ' ' + r.status);
    const j = await r.json();
    const res = j.chart.result[0], m = res.meta;
    const q = (res.indicators.quote[0].close || []).filter(v => v != null);
    if (!q.length) throw new Error('yahoo ' + sym + ' empty');
    const last = m.regularMarketPrice ?? q[q.length - 1];
    const prev = m.previousClose ?? q[q.length - 2];
    const month = q[q.length - 22] ?? q[0];
    return { key: sym, name, price: last, changePct: +(((last - prev) / prev) * 100).toFixed(2), monthPct: +(((last - month) / month) * 100).toFixed(1), hi52: Math.max(...q), lo52: Math.min(...q) };
  }));
  const ks = items[0];
  let foreign = null;
  try { foreign = await cached('foreign', getForeign); } catch {}
  return { items, hi52: ks.hi52, lo52: ks.lo52, fromHi: +(((ks.price - ks.hi52) / ks.hi52) * 100).toFixed(1), foreign };
}
async function getBtcFng() {
  const r = await fetch('https://api.alternative.me/fng/?limit=31');
  if (!r.ok) throw new Error('alternative.me ' + r.status);
  const d = await r.json();
  return {
    now: +d.data[0].value,
    rating: d.data[0].value_classification.toLowerCase(),
    yesterday: d.data[1] ? +d.data[1].value : null,
    week: d.data[7] ? +d.data[7].value : null,
    month: d.data[29] ? +d.data[29].value : null,
    trend: d.data.map(x => +x.value).reverse(),
  };
}

// ── 전 종목 상관관계: 매주 자동 갱신 ─────────────────────
// 주간(금요일 마감) 로그수익률 52주 → 51개 수익률로 상관계수 계산.
// 미국 금요일 장 마감(UTC 21:00) 이후 새 주가 생기면 자동으로 다시 계산하고 디스크에 저장.
const CORR_FILE = path.join(__dirname, 'corr-cache.json');
const DAY = 864e5;
const isoDay = t => new Date(t).toISOString().slice(0, 10);
function weekKey(ms) { // 그 날이 속한 주의 금요일(UTC). 토·일은 다음 주 금요일로
  const d = new Date(ms), dow = d.getUTCDay();
  return isoDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + ((5 - dow + 7) % 7) * DAY);
}
function lastCompletedFriday(now = Date.now()) {
  const d = new Date(now), dow = d.getUTCDay();
  let fri = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((dow - 5 + 7) % 7) * DAY;
  if (fri + 21 * 3600e3 > now) fri -= 7 * DAY; // 금요일 미국 장 마감 전이면 지난주
  return isoDay(fri);
}
async function dailyYear(sym) {
  let last;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('Yahoo ' + r.status);
      const res = (await r.json()).chart.result[0], c = res.indicators.quote[0].close;
      return res.timestamp.map((t, i) => [t * 1000, c[i]]).filter(p => p[1] != null);
    } catch (e) { last = e; }
  }
  throw last;
}
const pearson = (a, b) => {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(saa * sbb);
};
async function computeCorr(endWeek) {
  const raw = await Promise.all(QUOTES.map(q => dailyYear(q[0])));
  // 주별 마지막 종가
  const weekly = raw.map(rows => { const m = new Map(); rows.forEach(([t, v]) => m.set(weekKey(t), v)); return m; });
  // 53주 가격 → 52개 주간 수익률. 현재 = 최근 51개, 지난주 = 그 이전 51개, 단기 = 최근 13개
  const keys = [];
  for (let k = Date.parse(endWeek); keys.length < 53; k -= 7 * DAY) keys.unshift(isoDay(k));
  const px = weekly.map(m => {
    let lastV = null; const before = [...m.keys()].filter(k => k < keys[0]).sort();
    if (before.length) lastV = m.get(before[before.length - 1]);
    return keys.map(k => (m.has(k) ? (lastV = m.get(k)) : lastV));
  });
  const ok = px.map(s => s.every(v => v != null && v > 0));
  const rets = px.map(s => s.slice(1).map((v, i) => Math.log(v / s[i])));
  const n = QUOTES.length;
  const matrix = (from, to) => {
    const C = [];
    for (let i = 0; i < n; i++) { C.push([]); for (let j = 0; j < n; j++) C[i].push(ok[i] && ok[j] ? +pearson(rets[i].slice(from, to), rets[j].slice(from, to)).toFixed(3) : null); }
    return C;
  };
  const R = rets[0].length;               // 52
  const C = matrix(R - 51, R);            // 이번 주 기준 51주
  const P = matrix(R - 52, R - 1);        // 지난주 기준 51주
  const S13 = matrix(R - 13, R);          // 최근 13주
  const S13p = matrix(R - 14, R - 1);     // 지난주 기준 최근 13주
  const secs = [...new Set(QUOTES.map(q => q[2]))];
  const M = secs.map(a => secs.map(b => {
    const v = []; QUOTES.forEach((qa, i) => QUOTES.forEach((qb, j) => { if (i !== j && qa[2] === a && qb[2] === b && C[i][j] != null) v.push(C[i][j]); }));
    return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(3) : null;
  }));
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (C[i][j] != null) pairs.push([i, j, C[i][j]]);
  pairs.sort((a, b) => b[2] - a[2]);
  const off = pairs.map(p => p[2]);
  // ── 변화 감지 ──
  // 급변: 51주 상관이 1주 만에 ±0.10 이상 (과거 30주 기준 상위 1%)
  // 단기 이탈: 최근 13주 상관이 51주 상관과 ±0.50 이상 차이 (상위 5%), 이번 주 새로 넘어선 것만 '새로' 표시
  const JUMP = 0.10, GAP = 0.50, alerts = [];
  for (const [i, j] of pairs) {
    const d1 = +(C[i][j] - P[i][j]).toFixed(3), gap = +(S13[i][j] - C[i][j]).toFixed(3), gapPrev = S13p[i][j] - P[i][j];
    if (Math.abs(d1) >= JUMP) alerts.push({ type: 'jump', i, j, now: C[i][j], prev: P[i][j], delta: d1, isNew: true });
    if (Math.abs(gap) >= GAP) alerts.push({ type: 'gap', i, j, now: C[i][j], short: S13[i][j], delta: gap, isNew: Math.abs(gapPrev) < GAP });
  }
  alerts.sort((a, b) => (b.isNew - a.isNew) || (a.type === 'jump' ? -1 : 0) - (b.type === 'jump' ? -1 : 0) || Math.abs(b.delta) - Math.abs(a.delta));
  return {
    symbols: QUOTES.map(q => ({ symbol: q[0], name: q[1], sector: q[2] })),
    C, P, S13, S13p, sectors: secs, M, top: pairs.slice(0, 8), bottom: pairs.slice(-8).reverse(),
    alerts, thresholds: { jump: JUMP, gap: GAP },
    avg: +(off.reduce((s, x) => s + x, 0) / off.length).toFixed(3),
    weeks: 51, start: keys[2], end: keys[keys.length - 1], prevEnd: keys[keys.length - 2], computedAt: new Date().toISOString(),
  };
}
let CORR = null, corrBusy = null;
try { CORR = JSON.parse(fs.readFileSync(CORR_FILE, 'utf8')); } catch {}
async function getCorr() {
  const want = lastCompletedFriday();
  const stale = !CORR || CORR.end !== want || CORR.symbols.length !== QUOTES.length || !CORR.alerts || !CORR.S13p;
  if (!stale) return CORR;
  if (!corrBusy) corrBusy = computeCorr(want).then(d => {
    CORR = d; try { fs.writeFileSync(CORR_FILE, JSON.stringify(d)); } catch {}
    console.log('상관관계 갱신:', d.end); return d;
  }).finally(() => { corrBusy = null; });
  try { return await corrBusy; } catch (e) { if (CORR) return CORR; throw e; }
}
// 서버가 켜져 있는 동안 6시간마다 새 주가 생겼는지 확인 → 매주 토요일 아침(한국시간) 자동 갱신
setInterval(() => getCorr().catch(e => console.error('상관관계 갱신 실패', e.message)), 6 * 3600e3);
getCorr().catch(() => {});

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/sw.js': ['sw.js', 'text/javascript'],
};

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/api/setkrx') {
      const m2 = (req.url.match(/[?&]key=([^&]*)/) || [])[1] || '';
      const k = decodeURIComponent(m2).trim();
      if (k) { KRX_KEY = k; fs.writeFileSync(KEYFILE, k); } else { KRX_KEY = ''; try { fs.unlinkSync(KEYFILE); } catch {} }
      delete cache.foreign;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    const api = { '/api/fng': ['fng', getFng], '/api/vix': ['vix', getVix], '/api/btc': ['btc', getBtcFng], '/api/kr': ['kr', getKr], '/api/quotes': ['quotes', getQuotes] };
    if (api[url]) {
      const data = await cached(api[url][0], api[url][1]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/recs') {
      const [qq, fg, vx] = await Promise.all([cached('quotes', getQuotes), cached('fng', getFng).catch(() => null), cached('vix', getVix).catch(() => null)]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ items: recs(qq, fg, vx), fng: fg?.now ?? null, vix: vx?.price ?? null, computedAt: new Date().toISOString() }));
    }
    if (url === '/api/corr') {
      const data = await getCorr();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    const s = STATIC[url];
    if (s) {
      res.writeHead(200, { 'Content-Type': s[1] });
      return res.end(fs.readFileSync(path.join(__dirname, s[0])));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => console.log('공포지수 앱 실행 중: http://localhost:' + PORT));
