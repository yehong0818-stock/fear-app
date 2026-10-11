// 해외 주식 공포지수 앱 — 의존성 없는 Node 서버 (Node 18+)
// 실행: node server.js  →  http://localhost:8080
const http = require('http');
const fs = require('fs');
const path = require('path');

const KIS = require('./kis.js');
const COINS = require('./coins.js');
const COINBT = require('./coinbt.js');
const KRBT = require('./krbt.js');
const INTRA = require('./intrabt.js');
const SHORT = require('./shortbt.js');
const PORT = process.env.PORT || 8080;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CACHE_MS = 5 * 60 * 1000;
const cache = {};

async function cached(key, fn, ttl) {
  const c = cache[key];
  if (c && Date.now() - c.t < (ttl || CACHE_MS)) return c.v;
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
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5y&interval=1d`, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('Yahoo ' + r.status);
      const res = (await r.json()).chart.result[0];
      const q = res.indicators.quote[0].close;
      const series = res.timestamp.map((t, i) => [t * 1000, q[i]]).filter(p => p[1] != null);
      return { price: res.meta.regularMarketPrice, prevClose: res.meta.chartPreviousClose, time: res.meta.regularMarketTime * 1000, series };
    } catch (e) { last = e; }
  }
  throw last;
}

const BASE_QUOTES = [
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
const SYMFILE = path.join(__dirname, 'symbols.json');
let SYM = { added: [], removed: [] };
try { const j = JSON.parse(fs.readFileSync(SYMFILE, 'utf8')); if (j) SYM = { added: j.added || [], removed: j.removed || [] }; } catch {}
function buildQuotes() {
  const base = BASE_QUOTES.filter(q => !SYM.removed.includes(q[0]));
  const extra = SYM.added.filter(q => !SYM.removed.includes(q[0]) && !base.some(b => b[0] === q[0]));
  return [...base, ...extra];
}
let QUOTES = buildQuotes();
function saveSym() { try { fs.writeFileSync(SYMFILE, JSON.stringify(SYM)); } catch {} }
function invalidateAll() {
  delete cache.quotes; delete cache.backtest; delete cache.compare;
  try { fs.unlinkSync(CORR_FILE); } catch {}
}
async function lookupName(sym) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const m = (await r.json()).chart.result[0].meta;
      return { name: m.shortName || m.longName || sym, currency: m.currency || '' };
    } catch {}
  }
  return null;
}


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
        return { symbol: sym, name, sector, currency: res.meta.currency, price, changePct: (price - prev) / prev * 100, monthPct: (price - series[0][1]) / series[0][1] * 100, vol: res.meta.regularMarketVolume || null, series };
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
const KRX_BASE = 'https://data-dbg.krx.co.kr/svc/apis';
function krxDd(back){ const d=new Date(Date.now()-back*864e5); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`; }
async function krxFetch(path, basDd){
  try {
    const u = new URL(KRX_BASE + '/' + path);
    u.searchParams.set('basDd', basDd); u.searchParams.set('AUTH_KEY', KRX_KEY);
    const r = await fetch(u, { headers: { AUTH_KEY: KRX_KEY, 'User-Agent': UA } });
    if (r.status === 401) return { unauth: true, status: 401 };
    if (!r.ok) return { error: true, status: r.status };
    const j = await r.json().catch(() => null);
    return { rows: (j && j.OutBlock_1) || [] };
  } catch (e) { return { error: true, msg: String((e && e.message) || e) }; }
}
async function krxLatest(path){
  let unauth = false;
  for (let b = 2; b <= 10; b++) {
    const dd = krxDd(b); const r = await krxFetch(path, dd);
    if (r.unauth) { unauth = true; break; }
    if (r.rows && r.rows.length) return { basDd: dd, rows: r.rows };
  }
  return unauth ? { unauth: true } : { rows: [] };
}
async function yahooSeries(sym, range) {
  let last;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range || '1mo'}&interval=1d`, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('Yahoo ' + r.status);
      const res = (await r.json()).chart.result[0];
      const q = res.indicators.quote[0].close;
      const series = res.timestamp.map((t, i) => [t * 1000, q[i]]).filter(p => p[1] != null);
      if (!series.length) throw new Error('empty');
      return { currency: res.meta.currency, series, price: res.meta.regularMarketPrice };
    } catch (e) { last = e; }
  }
  return null;
}
/** CNN F&G 현재값을 숫자로 (now 는 {score,...} 객체) */
function fngNum(f) { const v = f && f.now; const n = v && typeof v === 'object' ? v.score : v; return n == null || !isFinite(+n) ? null : +n; }
function krxAction(s, price, fg, vX) {
  if (!s || s.length < 12) return { action: '관망', strength: '-', why: '데이터 부족' };
  const n = s.length, avg = a => s.slice(-a).reduce((x, y) => x + y, 0) / a;
  const w = Math.min(20, n), sma = avg(w), mom = (price - s[n - 6]) / s[n - 6] * 100;
  const hi = Math.max(...s), lo = Math.min(...s), pos = (price - lo) / ((hi - lo) || 1) * 100;
  let score = 0;
  if (price > sma) score++; else score--;
  if (mom > 3) score++; else if (mom < -3) score--;
  if (pos < 25) score++; else if (pos > 80) score--;
  if (fg != null) { if (fg <= 25) score++; else if (fg >= 75) score--; }
  if (vX != null) { if (vX >= 30) score++; else if (vX < 15) score--; }
  const vixBuy = vX != null && vX >= 30;
  let act, strength;
  if (vixBuy) { act = '매수'; strength = (fg != null && fg <= 25) ? '강' : '약'; }
  else if (score <= -2) { act = '매도'; strength = '강'; }
  else if (score === -1) { act = '매도'; strength = '약'; }
  else { act = '관망'; strength = '-'; }
  const comp = { trend: price > sma ? 1 : -1, mom: mom > 3 ? 1 : mom < -3 ? -1 : 0, pos: pos < 25 ? 1 : pos > 80 ? -1 : 0,
    fg: fg == null ? 0 : fg <= 25 ? 1 : fg >= 75 ? -1 : 0, vix: vX == null ? 0 : vX >= 30 ? 1 : vX < 15 ? -1 : 0, rsi: 0 };
  return { action: act, strength, score, comp, mom: +mom.toFixed(2) };
}
function rsi14(cl){ if(!cl||cl.length<15)return null; let g=0,l=0; for(let i=cl.length-14;i<cl.length;i++){const d=cl[i]-cl[i-1]; if(d>=0)g+=d; else l-=d;} if(l===0)return 100; const rs=g/l; return +(100-100/(1+rs)).toFixed(1); }
function maArr(cl, n){ const out=[]; let sum=0; for(let i=0;i<cl.length;i++){ sum+=cl[i]; if(i>=n) sum-=cl[i-n]; out.push(i+1>=n ? sum/n : null); } return out; }
function maTurn(cl){
  if(!cl || cl.length<30) return null;
  const m5=maArr(cl,5), m10=maArr(cl,10), m20=maArr(cl,20), L=cl.length-1;
  if(m5[L]==null||m10[L]==null||m20[L]==null) return null;
  let crossAgo=null;
  for(let back=1;back<=8;back++){ const i=L-back; if(i<0||m5[i]==null||m20[i]==null)break; if(m5[i]<=m20[i] && m5[L]>m20[L]) crossAgo=back; else break; }
  if(crossAgo==null){ // 8일 내 교차가 아니어도, 아직 역배열/혼조에서 상향 전환 중이면 탐지
    if(m5[L]>m20[L]){ for(let back=1;back<=8;back++){ const i=L-back; if(i<0||m5[i]==null||m20[i]==null)break; if(m5[i]<=m20[i]){ crossAgo=back; break; } } }
  }
  const nowOrder = (m5[L]>m10[L] && m10[L]>m20[L]) ? '정배열' : (m5[L]>m20[L] ? '전환 중' : '역배열');
  const turning = m5[L]>m20[L] && crossAgo!=null && crossAgo<=5;
  return { ma5:+m5[L].toFixed(1), ma10:+m10[L].toFixed(1), ma20:+m20[L].toFixed(1), crossAgo, order:nowOrder, turning };
}
const LEV_RE = /레버리지|인버스|숏|곱버스|선물인버스|[23]X/i;
async function getKrxTop() {
  if (!KRX_KEY) return { noKey: true, rows: [] };
  const ds = await cached('krxstocks', getKrxStocks, 3600e3);
  const etf = await cached('krxetf', getKrxEtf, 3600e3);
  if (ds.noKey || ds.unauthorized) return { noKey: ds.noKey || false, unauthorized: ds.unauthorized || false, rows: [], msg: ds.msg };
  const rows = [];
  (ds.list || []).forEach(x => { if (x.trdval) rows.push({ type: '주식', code: x.code, name: x.name, market: x.market, price: x.price, pct: x.pct, trdval: x.trdval, mktcap: x.mktcap, lev: false }); });
  ((etf && etf.items) || []).forEach(x => { if (x.trdval) rows.push({ type: 'ETF', code: x.code, name: x.name, market: 'ETF', price: x.price, pct: x.pct, trdval: x.trdval, nav: x.nav, lev: LEV_RE.test(x.name) }); });
  rows.sort((a, b) => b.trdval - a.trdval);
  const top = rows.slice(0, 60);
  const [fng, vx] = await Promise.all([cached('fng', getFng).catch(() => null), cached('vix', getVix).catch(() => null)]);
  const fg = fngNum(fng), vX = vx && vx.price;
  const sigs = await Promise.all(top.map(async x => {
    const ysym = x.code + (x.market === 'KOSDAQ' ? '.KQ' : '.KS');
    const [r, r6] = await Promise.all([
      cached('kh:' + ysym, () => yahooSeries(ysym, '1mo'), 3600e3),
      cached('kh6:' + ysym, () => yahooSeries(ysym, '6mo'), 3600e3),
    ]);
    if (!r || !r.series || r.series.length < 12) return null;
    const cl = r.series.map(p => p[1]);
    const g = krxAction(cl, x.price || r.price, fg, vX);
    g.rsi = rsi14(cl); if (g.comp && g.rsi != null) g.comp.rsi = g.rsi < 30 ? 1 : g.rsi > 70 ? -1 : 0;
    g.ma = r6 && r6.series ? maTurn(r6.series.map(p => p[1])) : null;
    return g;
  }));
  top.forEach((x, i) => { const g = sigs[i]; if (g) { x.action = g.action; x.strength = g.strength; x.rsi = g.rsi; x.ma = g.ma; x.comp = g.comp; x.mom5 = g.mom; x.score = g.score; } });
  return { basDd: ds.basDd, fng: fg ?? null, vix: vX ?? null, rows: top, computedAt: new Date().toISOString() };
}
async function getKrxHist(code, market) {
  if (!code) return null;
  const ysym = code + (market === 'KOSDAQ' ? '.KQ' : '.KS');
  const r = await cached('kh:' + ysym, () => yahooSeries(ysym, '1mo'), 3600e3);
  if (!r) return null;
  const cls = r.series.map(p => p[1]);
  const first = cls[0], last = cls[cls.length - 1];
  return { code, ysym, closes: cls, first, last, monthPct: +(((last - first) / first) * 100).toFixed(2), n: cls.length };
}

function krxWeekdaysBack(n){
  const out=[]; const d=new Date(Date.now()-2*864e5);
  while(out.length<n){ const w=d.getDay(); if(w!==0&&w!==6){ const p=x=>String(x).padStart(2,'0'); out.push(`${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`); } d.setDate(d.getDate()-1); }
  return out;
}
async function getKrxHist() {
  if (!KRX_KEY) return { noKey: true, days: [], s: {} };
  const days=[]; const recs={}; let scanned=0, unauth=false;
  for (const dd of krxWeekdaysBack(46)) {
    if (days.length >= 30) break; scanned++;
    const [a, b] = await Promise.all([krxFetch('sto/stk_bydd_trd', dd), krxFetch('sto/ksq_bydd_trd', dd)]);
    if (a.unauth || b.unauth) { unauth=true; break; }
    const rows=[...(a.rows||[]), ...(b.rows||[])];
    if (!rows.length) continue;
    days.push(dd); recs[dd]=rows;
  }
  if (unauth) return { unauthorized: true, days: [], s: {} };
  if (!days.length) return { days: [], s: {} };
  days.reverse();
  const s2={};
  for (const dd of days) for (const r of recs[dd]) {
    const k=r.ISU_CD; if(!k) continue;
    let o=s2[k]; if(!o){ o={ n:r.ISU_NM, m:r.MKT_NM||'', o:[], h:[], l:[], c:[], v:[] }; s2[k]=o; }
    o.o.push(+r.TDD_OPNPRC||null); o.h.push(+r.TDD_HGPRC||null); o.l.push(+r.TDD_LWPRC||null);
    o.c.push(+r.TDD_CLSPRC||null); o.v.push(+r.ACC_TRDVOL||null);
  }
  const last = recs[days[days.length-1]] || [];
  last.forEach(r => { const o=s2[r.ISU_CD]; if(o){ o.px=+r.TDD_CLSPRC||null; o.pct=r.FLUC_RT===''?null:+r.FLUC_RT; o.td=+r.ACC_TRDVAL||null; } });
  return { days, first: days[0], last: days[days.length-1], count: Object.keys(s2).length, s: s2, builtAt: new Date().toISOString() };
}
function candle(cl, op, hi, lo){
  if (cl==null||op==null||hi==null||lo==null) return null;
  const body=Math.abs(cl-op), rng=hi-lo; if(rng<=0) return null;
  const up=cl>op, lower=Math.min(cl,op)-lo, upper=hi-Math.max(cl,op);
  const hammer = up && body>0 && lower >= 3*body && upper <= body && body/rng <= 0.35;
  return { up, body, rng, lower, upper, hammer, doji: body/rng<=0.1 };
}
function getKrxScan() {
  const h = cache.krxhist && (cache.krxhist.v || cache.krxhist); if(!h || !h.days || !h.s) return { loading: true, list: [], hammer: [], counts:{} };
  const turning=[], hammer=[], all=[], orders={정배열:0,전환중:0,역배열:0};
  for (const k of Object.keys(h.s)) {
    const o=h.s[k]; const cl=o.c.filter(x=>x!=null); if(cl.length<25) continue;
    const m5=maArr(cl,5), m10=maArr(cl,10), m20=maArr(cl,20), L=cl.length-1;
    if(m5[L]==null||m10[L]==null||m20[L]==null) continue;
    let crossAgo=null;
    for(let back=1;back<=8;back++){ const i=L-back; if(i<0||m5[i]==null||m20[i]==null)break; if(m5[i]<=m20[i]){ crossAgo=back; break; } }
    const up20 = m5[L]>m20[L];
    const st = (m5[L]>m10[L]&&m10[L]>m20[L])?'정배열':(up20?'전환중':'역배열'); orders[st]++;
    const rsi = rsi14(cl);
    const mom5 = L>=5 && cl[L-5] ? +((cl[L]/cl[L-5]-1)*100).toFixed(2) : null;
    const base = { code:k, name:o.n, market:o.m, price:o.px, pct:o.pct, trdval:o.td, rsi, mom5,
      ma5:+m5[L].toFixed(0), ma10:+m10[L].toFixed(0), ma20:+m20[L].toFixed(0), crossAgo, order:st };
    all.push(base);
    if (up20 && crossAgo!=null && crossAgo<=5) turning.push(base);
    const n=o.c.length;
    if (n>=3) {
      const c1=candle(o.c[n-3],o.o[n-3],o.h[n-3],o.l[n-3]);
      const c2=candle(o.c[n-2],o.o[n-2],o.h[n-2],o.l[n-2]);
      const c3=candle(o.c[n-1],o.o[n-1],o.h[n-1],o.l[n-1]);
      if (c1&&c2&&c3 && !c1.up && !c2.up && c3.hammer) {
        const wickRatio = +(c3.lower/(c3.body||1)).toFixed(1);
        hammer.push({ ...base, wickRatio, bodyPct: +((c3.body/c3.rng)*100).toFixed(0) });
      }
    }
  }
  turning.sort((a,b)=>(b.trdval||0)-(a.trdval||0));
  hammer.sort((a,b)=>(b.trdval||0)-(a.trdval||0)); hammer.splice(20);
  // RSI 과매도 후보: 거래대금 순위(trdRank) 포함, RSI<35 만
  all.sort((a,b)=>(b.trdval||0)-(a.trdval||0)); all.forEach((x,i)=>x.trdRank=i+1);
  const rsiLow = all.filter(x=>x.rsi!=null&&x.rsi<35&&x.trdRank<=500);
  // 추세·모멘텀 상위: 20일선 위 + 1주 +3% 초과, 1주 등락률 순 (단기·당일 자동매매 기본 신호)
  const trendTop = all.filter(x=>x.trdRank<=500&&x.mom5!=null&&x.mom5>3&&x.price!=null&&x.price>x.ma20).sort((a,b)=>b.mom5-a.mom5).slice(0,80);
  return { first:h.first, last:h.last, universe:h.count, days:h.days.length, turning, hammer, rsiLow, trendTop, orders, computedAt:new Date().toISOString() };
}

async function getKrxIdx() {
  if (!KRX_KEY) return { noKey: true, groups: {} };
  const groups = { KOSPI: 'idx/kospi_dd_trd', KOSDAQ: 'idx/kosdaq_dd_trd', KRX: 'idx/krx_dd_trd' };
  const out = {}; let basDd = null, unauth = 0;
  for (const g of Object.keys(groups)) {
    const r = await krxLatest(groups[g]);
    if (r.unauth) { unauth++; continue; }
    out[g] = (r.rows || []).map(x => ({ name: x.IDX_NM, price: +x.CLSPRC_IDX || null, chg: +x.CMPPREVDD_IDX || null,
      pct: x.FLUC_RT === '' ? null : +x.FLUC_RT, trdval: x.ACC_TRDVAL ? +x.ACC_TRDVAL : null, mktcap: x.MKTCAP ? +x.MKTCAP : null }))
      .filter(x => x.name && x.price);
    if (r.basDd && !basDd) basDd = r.basDd;
  }
  if (!Object.keys(out).length) return { unauthorized: true, groups: {}, basDd, msg: 'KRX 401 — 지수 서비스 이용신청·승인이 필요합니다.' };
  return { basDd, groups: out, computedAt: new Date().toISOString() };
}
async function getKrxStocks() {
  if (!KRX_KEY) return { noKey: true, list: [] };
  const stk = await krxLatest('sto/stk_bydd_trd');
  const ksq = await krxLatest('sto/ksq_bydd_trd');
  if (stk.unauth || ksq.unauth) return { unauthorized: true, list: [], msg: 'KRX 401 — 유가증권/코스닥 일별매매정보 이용신청·승인이 필요합니다.' };
  const isu = await krxFetch('sto/stk_isu_base_info', stk.basDd || krxDd(2));
  const bm = {}; ((isu && isu.rows) || []).forEach(x => { bm[x.ISU_SRT_CD] = x; });
  const list = [...(stk.rows || []), ...(ksq.rows || [])].map(x => {
    const b = bm[x.ISU_CD] || {}; const price = +x.TDD_CLSPRC || null; const shrs = b.LIST_SHRS ? +b.LIST_SHRS : null;
    return { code: x.ISU_CD, name: x.ISU_NM, market: x.MKT_NM || '', sect: x.SECT_TP_NM || '', price,
      chg: +x.CMPPREVDD_PRC || 0, pct: x.FLUC_RT === '' ? null : +x.FLUC_RT,
      open: +x.TDD_OPNPRC || null, high: +x.TDD_HGPRC || null, low: +x.TDD_LWPRC || null,
      vol: x.ACC_TRDVOL ? +x.ACC_TRDVOL : null, trdval: x.ACC_TRDVAL ? +x.ACC_TRDVAL : null,
      mktcap: shrs && price ? shrs * price : null, parval: b.PARVAL ? +b.PARVAL : null, listdd: b.LIST_DD || null, eng: b.ISU_ENG_NM || null };
  });
  return { basDd: stk.basDd, list };
}
async function getKrxEtf() {
  if (!KRX_KEY) return { noKey: true, items: [] };
  const r = await krxLatest('etp/etf_bydd_trd');
  if (r.unauth) return { unauthorized: true, items: [], msg: 'KRX 401 — ETF 일별매매정보 이용신청·승인이 필요합니다.' };
  const items = (r.rows || []).map(x => ({ code: x.ISU_CD, name: x.ISU_NM, price: +x.TDD_CLSPRC || null,
    pct: x.FLUC_RT === '' ? null : +x.FLUC_RT, nav: x.NAV ? +x.NAV : null,
    trdval: x.ACC_TRDVAL ? +x.ACC_TRDVAL : null })).filter(x => x.name && x.trdval)
    .sort((a, b) => b.trdval - a.trdval);
  return { basDd: r.basDd, items, computedAt: new Date().toISOString() };
}
async function getKrxCmdty() {
  if (!KRX_KEY) return { noKey: true };
  const [g, o] = await Promise.all([krxLatest('gen/gold_bydd_trd'), krxLatest('gen/oil_bydd_trd')]);
  if (g.unauth || o.unauth) return { unauthorized: true, msg: 'KRX 401 — 금/석유시장 이용신청·승인이 필요합니다.' };
  return { basDd: g.basDd || o.basDd,
    gold: (g.rows || []).map(x => ({ name: x.ISU_NM, price: +x.TDD_CLSPRC || null, pct: x.FLUC_RT === '' ? null : +x.FLUC_RT, trdval: x.ACC_TRDVAL ? +x.ACC_TRDVAL : null })),
    oil: (o.rows || []).map(x => ({ name: x.OIL_NM, price: (+x.WT_AVG_PRC || 0) > 0 ? +x.WT_AVG_PRC : null, vol: x.ACC_TRDVOL ? +x.ACC_TRDVOL : null })) };
}

async function getForeign() {
  if (!KRX_KEY) return { kospi: null, kosdaq: null, noKey: true };
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(Date.now() - 2 * 864e5);
  const basDd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  try {
    const u = new URL('https://data-dbg.krx.co.kr/svc/apis/sto/stk_bydd_trd');
    u.searchParams.set('basDd', basDd); u.searchParams.set('AUTH_KEY', KRX_KEY);
    const r = await fetch(u, { headers: { AUTH_KEY: KRX_KEY, 'User-Agent': UA } });
    if (r.status === 401) return { kospi: null, kosdaq: null, noKey: false, unauthorized: true, status: 401, basDd,
      msg: 'KRX가 인증키를 거절했습니다(401 Unauthorized API Call). openapi.krx.co.kr 마이페이지에서 데이터별 API 이용신청 승인 후 사용할 수 있습니다.' };
    if (!r.ok) return { kospi: null, kosdaq: null, noKey: false, error: true, status: r.status, msg: 'KRX 응답 오류 ' + r.status };
    const j = await r.json().catch(() => null);
    if (!j || !j.OutBlock_1) return { kospi: null, kosdaq: null, noKey: false, error: true, msg: 'KRX 응답에 데이터가 없습니다.' };
    return { kospi: null, kosdaq: null, noKey: false, ok: true, basDd, rows: j.OutBlock_1.length, sample: j.OutBlock_1[0],
      msg: 'KRX OpenAPI는 투자자별(외국인) 거래실적을 제공하지 않습니다.' };
  } catch (e) { return { kospi: null, kosdaq: null, noKey: false, error: true, msg: String((e && e.message) || e) }; }
}


function recs(quotes, fng, vix) {
  const fg = fngNum(fng), vX = vix?.price;
  const base = '분할 매수·손절 원칙 유지';
  return quotes.map(q => {
    if (q.error) return { symbol: q.symbol, name: q.name, sector: q.sector, error: true };
    const s = (q.series || []).map(p2 => p2[1]);
    if (s.length < 12) return { symbol: q.symbol, name: q.name, sector: q.sector, error: true };
    const n = s.length, price = q.price;
    const avg = a => s.slice(-a).reduce((x, y) => x + y, 0) / a;
    const w = Math.min(20, n), sma20 = avg(w), mom = (price - s[n - 6]) / s[n - 6] * 100;
    const hi = Math.max(...s), lo = Math.min(...s);
    const pos = (price - lo) / (hi - lo || 1) * 100;
    let score = 0, why = [];
    if (price > sma20) { score++; why.push(`단기 흐름 상승(${w}일 평균 위, ${sma20 < s[n-2] ? '평균 선 상승 중' : '평균선 회복'})`) } else { score--; why.push(`단기 흐름 약세(${w}일 평균 아래)`) }
    if (mom > 3) { score++; why.push(`1주 +${mom.toFixed(1)}% 상승 압력`) } else if (mom < -3) { score--; why.push(`1주 ${mom.toFixed(1)}% 하락`) }
    if (pos < 25) { score++; why.push(`1개월 박스 저권(${pos.toFixed(0)}% 위치)`) } else if (pos > 80) { score--; why.push(`1개월 고권(${pos.toFixed(0)}% 위치) · 차익 실현 주의`) }
    if (fg != null) { if (fg <= 25) { score++; why.push(`공포탐욕 ${fg} 극단적 공포`) } else if (fg >= 75) { score--; why.push(`공포탐욕 ${fg} 탐욕 과열`) } }
    if (vX != null) { if (vX >= 30) { score++; why.push(`VIX ${vX.toFixed(1)} 공포 확산`) } else if (vX < 15) { score--; why.push(`VIX ${vX.toFixed(1)} 저변동 · 하방 점프 대비`) } }
    // 매수는 VIX 30 이상일 때만 (5년 백테스트에서 기준선 대비 우위 확인)
    const vixBuy = vX != null && vX >= 30;
    let act, strength;
    if (vixBuy) {
      act = '매수'; strength = (fg != null && fg <= 25) ? '강' : '약';
      why.unshift(`VIX ${vX.toFixed(1)} · 30 이상 매수 구간`);
      if (fg != null && fg <= 25) why.unshift(`공포탐욕 ${fg} 극단적 공포`);
    }
    else if (score <= -2) { act = '매도'; strength = '강' }
    else if (score === -1) { act = '매도'; strength = '약' }
    else { act = '관망'; strength = '-' }
    const tip = act === '매수' ? (score >= 1 ? 'VIX 30 구간 · 분할 매수 1회차' : 'VIX 30 구간 · 분할로 신중히')
      : act === '매도' ? (pos < 30 ? '추가 하락 시 분할 익매' : '목표가 도달분 익매')
      : (vX == null ? 'VIX 데이터 없음 · 신호 판정 보류' : 'VIX 30 신호 대기 · 적립 유지');
    return { symbol: q.symbol, name: q.name, sector: q.sector, action: act, strength, why: why.join(' · '), tip, price };
  }).sort((a, b) => a.sector.localeCompare(b.sector) || (b.strength === '강' ? 0 : b.strength === '약' ? 1 : 2) - (a.strength === '강' ? 0 : a.strength === '약' ? 1 : 2));
}

async function getDaily(sym) {
  let last;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d`, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('Yahoo ' + r.status);
      const res = (await r.json()).chart.result[0];
      const c = res.indicators.quote[0].close || [];
      const out = res.timestamp.map((t, i) => [t * 1000, c[i]]).filter(p2 => p2[1] != null);
      if (out.length < 40) throw new Error('short');
      return out;
    } catch (e) { last = e; }
  }
  throw last;
}
const dkey = ts => new Date(ts).toISOString().slice(0, 10);
function dayScore(s, i, fg, vix) {
  const price = s[i], w = Math.min(20, i + 1);
  let sum = 0; for (let k = i - w + 1; k <= i; k++) sum += s[k];
  const sma = sum / w, back = s[Math.max(0, i - 5)], mom = (price - back) / (back || 1) * 100;
  const seg = s.slice(Math.max(0, i - 20), i + 1);
  const lo = Math.min(...seg), hi = Math.max(...seg), pos = (price - lo) / ((hi - lo) || 1) * 100;
  let sc = 0;
  if (price > sma) sc++; else sc--;
  if (mom > 3) sc++; else if (mom < -3) sc--;
  if (i + 1 >= 20) { if (pos < 25) sc++; else if (pos > 80) sc--; }
  if (fg != null) { if (fg <= 25) sc++; else if (fg >= 75) sc--; }
  if (vix != null) { if (vix >= 30) sc++; else if (vix < 15) sc--; }
  return sc;
}
const actOf = sc => sc >= 2 ? '매수' : sc <= -2 ? '매도' : '관망';
function agg(rows) {
  const f = k => rows.filter(r => r[k] != null);
  const mean = k => { const a = f(k); return a.length ? +(a.reduce((x, y) => x + y[k], 0) / a.length).toFixed(2) : null };
  const hit = k => { const a = f(k); return a.length ? Math.round(a.filter(r => r[k] > 0).length / a.length * 100) : null };
  const win = k => { const a = f(k).filter(r => r[k] > 0); return a.length ? +(a.reduce((x, y) => x + y[k], 0) / a.length).toFixed(2) : null };
  const loss = k => { const a = f(k).filter(r => r[k] < 0); return a.length ? +(a.reduce((x, y) => x + y[k], 0) / a.length).toFixed(2) : null };
  const w21 = win('r21'), l21 = loss('r21'), w63 = win('r63'), l63 = loss('r63');
  return { n: rows.length, r5: mean('r5'), r21: mean('r21'), r63: mean('r63'), hit21: hit('r21'), hit63: hit('r63'),
    win21: w21, loss21: l21, rr21: (w21 != null && l21) ? +Math.abs(w21 / l21).toFixed(2) : null,
    win63: w63, loss63: l63, rr63: (w63 != null && l63) ? +Math.abs(w63 / l63).toFixed(2) : null };
}
async function getBacktest() {
  const [fng, vix] = await Promise.all([cached('fng', getFng).catch(() => null), cached('d5_^VIX', () => getDaily('^VIX'), 12 * 3600e3).catch(() => null)]);
  const fm = {}, vm = {};
  (fng?.history || []).forEach(p2 => { fm[dkey(p2[0])] = p2[1] });
  (vix || []).forEach(p2 => { vm[dkey(p2[0])] = p2[1] });
  const syms = QUOTES.map(q => q[0]);
  const res = await Promise.all(syms.map(async sy => {
    try { return await cached('d1_' + sy, () => getDaily(sy)); } catch { return null }
  }));
  const rows = { 매수: [], 매도: [], 관망: [], 전체: [], VIX30: [], VIX30FG: [], VIX30_20: [] };
  let okSyms = 0, first = null, lastD = null;
  res.forEach(sr => {
    if (!sr || sr.length < 60) return;
    okSyms++;
    const s = sr.map(x => x[1]);
    if (!first) first = dkey(sr[0][0]);
    lastD = dkey(sr[sr.length - 1][0]);
    for (let i = 20; i < s.length - 5; i++) {
      const fg = fm[dkey(sr[i][0])], vx = vm[dkey(sr[i][0])];
      const sc = dayScore(s, i, fg, vx), act = actOf(sc);
      const rec = { r5: +(((s[i + 5] / s[i]) - 1) * 100).toFixed(2) };
      if (i + 21 < s.length) rec.r21 = +(((s[i + 21] / s[i]) - 1) * 100).toFixed(2);
      if (i + 63 < s.length) rec.r63 = +(((s[i + 63] / s[i]) - 1) * 100).toFixed(2);
      rows[act].push(rec); rows['전체'].push(rec);
      if (vx != null && vx >= 30) { rows['VIX30'].push(rec); if (fg != null && fg <= 25) rows['VIX30FG'].push(rec); }
      if (vx != null && vx >= 20 && vx < 30) rows['VIX30_20'].push(rec);
    }
  });
  const spx = await cached('d5_^GSPC', () => getDaily('^GSPC'), 12 * 3600e3).catch(() => null);
  const mkt = [];
  let risk = null;
  if (spx && spx.length > 70) {
    const ss = spx.map(x => x[1]);
    const mk = (label, test) => {
      const rr = [];
      for (let i = 20; i < ss.length - 21; i++) {
        const vx = vm[dkey(spx[i][0])], fg = fm[dkey(spx[i][0])];
        if (!test(vx, fg)) continue;
        const r2 = { r21: +(((ss[i + 21] / ss[i]) - 1) * 100).toFixed(2) };
        if (i + 63 < ss.length) r2.r63 = +(((ss[i + 63] / ss[i]) - 1) * 100).toFixed(2);
        rr.push(r2);
      }
      return Object.assign({ signal: label }, agg(rr));
    };
    mkt.push(mk('VIX 30 이상', vx => vx != null && vx >= 30));
    mkt.push(mk('공포·탐욕 25 미만', (vx, fg) => fg != null && fg <= 25));
    mkt.push(mk('VIX 30↑ + 공포·탐욕 25↓', (vx, fg) => vx != null && vx >= 30 && fg != null && fg <= 25));
    const runMdd = expFn => {
      let eq = 100, peak = 100, worst = 0;
      for (let i = 1; i < ss.length; i++) {
        const r = expFn(i - 1) ? (ss[i] / ss[i - 1] - 1) : 0;
        eq *= (1 + r); if (eq > peak) peak = eq;
        const dd = eq / peak - 1; if (dd < worst) worst = dd;
      }
      return +(worst * 100).toFixed(1);
    };
    risk = {
      bh: runMdd(() => true),
      vix30: runMdd(i => { const v = vm[dkey(spx[i][0])]; return v != null && v >= 30 }),
      fg25: runMdd(i => { const f = fm[dkey(spx[i][0])]; return f != null && f <= 25 }),
      note: '조건일 때만 S&P 500 보유, 나머지는 현금(이자 없음) 가정',
    };
  }
  const fgDates = Object.keys(fm).sort();
  const years = first ? +((new Date(lastD) - new Date(first)) / 31557600000).toFixed(1) : null;
  return { window: '최근 ' + (years || 5) + '년 일별 데이터', years, symbols: okSyms, from: first, to: lastD,
    risk,
    fgFrom: fgDates[0] || null, fgTo: fgDates[fgDates.length - 1] || null, fgDays: fgDates.length, computedAt: new Date().toISOString(),
    items: [['매수', '매수 신호(현재 규칙)'], ['VIX30', '매수 신호(VIX 30 이상)'], ['VIX30FG', '매수 신호(VIX 30↑ + 공포탐욕 25↓)'], ['VIX30_20', '매수(VIX 20–30 대기 구간)'], ['매도', '매도 신호'], ['관망', '관망 신호'], ['전체', '전체(기준선)']]
      .map(([k, label]) => Object.assign({ signal: label, key: k }, agg(rows[k]))), market: mkt };
}

async function getCompare() {
  const [spx, etf, fxs] = await Promise.all([
    cached('d5_^GSPC', () => getDaily('^GSPC'), 12 * 3600e3).catch(() => null),
    cached('d5_360750', () => getDaily('360750.KS'), 12 * 3600e3).catch(() => null),
    cached('d5_USDKRW', () => getDaily('USDKRW=X'), 12 * 3600e3).catch(() => null),
  ]);
  if (!spx || !etf) throw new Error('compare data unavailable');
  const ms = {}, me = {}, mf = {};
  spx.forEach(x => { ms[dkey(x[0])] = x[1] });
  etf.forEach(x => { me[dkey(x[0])] = x[1] });
  (fxs || []).forEach(x => { mf[dkey(x[0])] = x[1] });
  const d = Object.keys(ms).filter(k => me[k] != null).sort();
  return {
    d, spx: d.map(k => ms[k]), etf: d.map(k => me[k]), fx: d.map(k => (mf[k] != null ? mf[k] : null)),
    etfName: 'TIGER 미국S&P500', etfTicker: '360750',
    from: d[0], to: d[d.length - 1], computedAt: new Date().toISOString(),
  };
}

async function getCompareMulti(syms) {
  const ser = await Promise.all(syms.map(sym => cached('d5_' + sym, () => getDaily(sym), 12 * 3600e3).then(v => [sym, v]).catch(() => [sym, null])));
  const ok = ser.filter(x => x[1] && x[1].length);
  const bad = ser.filter(x => !x[1]).map(x => x[0]);
  if (!ok.length) throw new Error('no data');
  // 날짜 합집합 + 전방채움(서로 다른 휴장일 보정), 모든 종목이 시작된 날 이후만
  const maps = ok.map(([sym, arr]) => { const m = {}; arr.forEach(x => { m[dkey(x[0])] = x[1]; }); return [sym, m]; });
  const starts = maps.map(([, m]) => Object.keys(m).sort()[0]);
  const start = starts.sort().slice(-1)[0];
  const all = [...new Set(maps.flatMap(([, m]) => Object.keys(m)))].filter(k => k >= start).sort();
  const series = maps.map(([sym, m]) => { let lastv = null; return { sym, v: all.map(k => { if (m[k] != null) lastv = m[k]; return lastv; }) }; });
  let i0 = 0; while (i0 < all.length && series.some(x => x.v[i0] == null)) i0++;
  if (i0) { all.splice(0, i0); series.forEach(x => x.v.splice(0, i0)); }
  const names = { 'USDKRW=X': '원·달러 환율', '360750.KS': 'TIGER 미국S&P500' }; QUOTES.forEach(q => { names[q[0]] = q[1]; });
  return { d: all, series: series.map(x => ({ sym: x.sym, name: names[x.sym] || x.sym, v: x.v })), bad, from: all[0], to: all[all.length - 1] };
}

async function getKr() {
  const SYMS = [['^KS11', '코스피'], ['^KQ11', '코스닥'], ['USDKRW=X', '원·달러 환율']];
  const items = await Promise.all(SYMS.map(async ([sym, name]) => {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d`, { headers: { 'User-Agent': UA } });
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
  if (url.indexOf('/api/kis') === 0) {
    try { return await KIS.handle(req, res, url); } catch (e) { res.writeHead(500, {'Content-Type': 'application/json; charset=utf-8'}); return res.end(JSON.stringify({ ok:false, msg:String(e && e.message || e) })); }
  }
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
    if (url === '/api/symbols') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        total: QUOTES.length, base: BASE_QUOTES.length, custom: SYM.added, removed: SYM.removed,
        sectors: [...new Set(BASE_QUOTES.map(q => q[2]))],
      }));
    }
    if (url === '/api/symbols/add' || url === '/api/symbols/remove' || url === '/api/symbols/restore') {
      const qp = k => decodeURIComponent((req.url.match(new RegExp('[?&]' + k + '=([^&]*)')) || [])[1] || '').trim();
      const sym = qp('symbol').toUpperCase();
      let done = false, msg = '';
      if (!sym) { msg = '심볼이 없습니다'; }
      else if (url.endsWith('/add')) {
        if (QUOTES.some(x => x[0] === sym)) msg = '이미 있는 종목입니다';
        else {
          let name = qp('name'), sector = qp('sector') || 'us';
          if (!name) { const lk = await lookupName(sym); name = lk ? lk.name : sym; }
          SYM.added.push([sym, name, sector]);
          SYM.removed = SYM.removed.filter(x => x !== sym);
          done = true;
        }
      } else if (url.endsWith('/remove')) {
        const isBase = BASE_QUOTES.some(x => x[0] === sym);
        if (SYM.added.some(x => x[0] === sym)) SYM.added = SYM.added.filter(x => x[0] !== sym);
        else if (isBase && !SYM.removed.includes(sym)) SYM.removed.push(sym);
        else msg = '없는 종목입니다';
        if (!msg) done = true;
      } else {
        if (SYM.removed.includes(sym)) { SYM.removed = SYM.removed.filter(x => x !== sym); done = true; }
        else msg = '복원할 종목이 없습니다';
      }
      if (done) { saveSym(); QUOTES = buildQuotes(); invalidateAll(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: done, msg, total: QUOTES.length, custom: SYM.added, removed: SYM.removed }));
    }
    if (url === '/api/krxstock') {
      const q = decodeURIComponent((req.url.match(/[?&]q=([^&]*)/) || [])[1] || '').trim();
      const ds = await cached('krxstocks', getKrxStocks, 3600e3);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      if (ds.noKey || ds.unauthorized) return res.end(JSON.stringify({ noKey: ds.noKey || false, unauthorized: ds.unauthorized || false, items: [], msg: ds.msg }));
      if (!q) return res.end(JSON.stringify({ basDd: ds.basDd, count: 0, items: [] }));
      const key = q.toLowerCase().replace(/\s/g, '');
      const items = (ds.list || []).filter(x => x.name.toLowerCase().replace(/\s/g, '').includes(key) || x.code.includes(key)).slice(0, 20);
      return res.end(JSON.stringify({ basDd: ds.basDd, count: items.length, items, computedAt: new Date().toISOString() }));
    }
    if (url === '/api/krxetf') {
      const data = await cached('krxetf', getKrxEtf, 3600e3);
      const view = { ...data, items: (data.items || []).slice(0, 15) };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(view));
    }
    if (url === '/api/krxscan') {
      let data; const _h = cache.krxhist && (cache.krxhist.v || cache.krxhist); if (_h && _h.days && _h.s) data = await cached('krxscan', () => getKrxScan(), 30*60e3); else { delete cache.krxscan; data = getKrxScan(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/krxtop') {
      const data = await cached('krxtop', getKrxTop, 3600e3);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/krxhist') {
      const m = req.url.match(/[?&]code=([^&]*)/); const code = decodeURIComponent((m && m[1]) || '').trim();
      const mm = req.url.match(/[?&]market=([^&]*)/); const market = decodeURIComponent((mm && mm[1]) || '').trim();
      const data = await getKrxHist(code, market);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data || { error: true }));
    }
    if (url === '/api/krxcmdty') {
      const data = await cached('krxcmdty', getKrxCmdty, 3600e3);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/coinbt') {
      const wq = decodeURIComponent((req.url.match(/[?&]w=([^&]*)/) || [])[1] || '');
      const hq = (req.url.match(/[?&]hold=(\d+)/) || [])[1];
      const a = wq.split(',').map(Number);
      const custom = a.length === 3 && a.every(x => x >= 0 && x <= 100) ? { v: a[0], m: a[1], n: a[2] } : null;
      const data = await COINBT.backtest(custom, hq);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/krbt') {
      const hq = (req.url.match(/[?&]hold=(\d+)/) || [])[1];
      const [ds, fng] = await Promise.all([cached('krxstocks', getKrxStocks, 3600e3).catch(() => ({})), cached('fng', getFng).catch(() => null)]);
      const uni = (ds.list || []).filter(x => x.trdval && /KOSPI|KOSDAQ/.test(x.market) && !/스팩|SPAC|우$|우B$/.test(x.name))
        .sort((a, b) => b.trdval - a.trdval).slice(0, (req.url.match(/[?&]n=200\b/) ? 200 : 60)).map(x => ({ sym: x.code + (x.market === 'KOSDAQ' ? '.KQ' : '.KS'), name: x.name }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      if (!uni.length) return res.end(JSON.stringify({ error: 'KRX 종목 목록을 불러오지 못했습니다' }));
      const wq = decodeURIComponent((req.url.match(/[?&]w=([^&]*)/) || [])[1] || '');
      const wa = wq ? wq.split(',').map(Number) : null;
      const fq = (req.url.match(/[?&]fee=([\d.]+)/) || [])[1];
      const data = await KRBT.backtest(uni, fng && fng.history, hq, wa && wa.length === 6 ? wa : null, fq == null ? 0.3 : +fq);
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/kospireg') {
      const r = await cached('kospireg', async () => {
        const y = await yahooSeries('^KS11', '3mo'); const c = y && y.series ? y.series.map(p => p[1]) : [];
        if (c.length < 26) return { ok: false };
        const ma = e => c.slice(e - 19, e + 1).reduce((a, b) => a + b, 0) / 20, L = c.length - 1;
        const m = ma(L), m5 = ma(L - 5);
        return { ok: true, close: +c[L].toFixed(2), ma20: +m.toFixed(2), ma20prev5: +m5.toFixed(2), above: c[L] > m, rising: m > m5, at: new Date().toISOString() };
      }, 15 * 60e3).catch(() => ({ ok: false }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(r));
    }
    if (url === '/api/shortbt' || url === '/api/shortlive') {
      const g = k => (req.url.match(new RegExp('[?&]' + k + '=(-?[\\d.]+)')) || [])[1];
      const ds = await cached('krxstocks', getKrxStocks, 3600e3).catch(() => ({}));
      const N = g('n') === '60' ? 60 : 200;
      const uni = (ds.list || []).filter(x => x.trdval && /KOSPI|KOSDAQ/.test(x.market) && !/스팩|SPAC|우$|우B$|리츠/.test(x.name))
        .sort((a, b) => b.trdval - a.trdval).slice(0, N).map(x => ({ sym: x.code + (x.market === 'KOSDAQ' ? '.KQ' : '.KS'), name: x.name }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      if (!uni.length) return res.end(JSON.stringify({ error: 'KRX 종목 목록을 불러오지 못했습니다' }));
      try {
        const data = url === '/api/shortbt' ? await SHORT.backtest(uni, { k: g('k'), fee: g('fee') }) : await SHORT.liveSignals(uni, g('fresh') === '1');
        return res.end(JSON.stringify(data));
      } catch (e) { return res.end(JSON.stringify({ error: String(e && e.message || e) })); }
    }
    if (url === '/api/intrabt') {
      const g = k => (req.url.match(new RegExp('[?&]' + k + '=(-?[\\d.]+)')) || [])[1];
      const ds = await cached('krxstocks', getKrxStocks, 3600e3).catch(() => ({}));
      const N = g('n') === '200' ? 200 : 60;
      const uni = (ds.list || []).filter(x => x.trdval && /KOSPI|KOSDAQ/.test(x.market) && !/스팩|SPAC|우$|우B$/.test(x.name))
        .sort((a, b) => b.trdval - a.trdval).slice(0, N).map(x => ({ sym: x.code + (x.market === 'KOSDAQ' ? '.KQ' : '.KS'), name: x.name }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      if (!uni.length) return res.end(JSON.stringify({ error: 'KRX 종목 목록을 불러오지 못했습니다' }));
      const data = await INTRA.backtest(uni, { k: g('k'), fee: g('fee'), sl: g('sl'), tp: g('tp') });
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/krxsearch') {
      const q = decodeURIComponent((req.url.match(/[?&]q=([^&]*)/) || [])[1] || '').trim();
      const [ds, ef] = await Promise.all([cached('krxstocks', getKrxStocks, 3600e3).catch(() => ({})), cached('krxetf', getKrxEtf, 3600e3).catch(() => ({}))]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      if (!q) return res.end(JSON.stringify({ items: [] }));
      const key = q.toLowerCase().replace(/\s/g, '');
      const norm = x => String(x || '').toLowerCase().replace(/\s/g, '');
      const pool = (ds.list || []).map(x => ({ code: x.code, name: x.name, market: x.market, trdval: x.trdval || 0, eng: x.eng || '' }))
        .concat((ef.items || []).map(x => ({ code: x.code, name: x.name, market: 'ETF', trdval: x.trdval || 0, eng: '' })));
      const hit = pool.filter(x => norm(x.name).includes(key) || x.code.includes(key) || norm(x.eng).includes(key)).map(x => {
        const nm = norm(x.name); const rank = nm === key || x.code === key ? 0 : nm.startsWith(key) ? 1 : 2;
        return { ...x, rank, sym: x.code + (x.market === 'KOSDAQ' ? '.KQ' : '.KS') };
      }).sort((a, b) => a.rank - b.rank || b.trdval - a.trdval).slice(0, 12).map(({ rank, eng, ...r }) => r);
      return res.end(JSON.stringify({ basDd: ds.basDd || ef.basDd, items: hit }));
    }
    if (url === '/api/coinpicks') {
      const data = await cached('coinpicks', COINS.getCoinPicks, 20*60e3);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/krxidx') {
      const data = await cached('krxidx', getKrxIdx, 3600e3);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/topvalue') {
      const [qq, rr, cc] = await Promise.all([
        cached('quotes', getQuotes),
        cached('recs', async () => recs(await cached('quotes', getQuotes), await cached('fng', getFng).catch(() => null), await cached('vix', getVix).catch(() => null)), 300e3).catch(() => []),
        cached('compare', getCompare, 3600e3).catch(() => null),
      ]);
      let usdkrw = null;
      if (cc && cc.fx) { for (let i = cc.fx.length - 1; i >= 0; i--) if (cc.fx[i] != null) { usdkrw = cc.fx[i]; break } }
      const rows = [];
      qq.filter(q => !q.error && q.price != null && q.vol != null).forEach(q => {
        const c = q.currency || '';
        if (String(q.symbol || '').startsWith('^')) return; // 지수는 '거래대금' 개념이 없어 제외
        const isCrypto = /-USD$/i.test(q.symbol || '') || q.sector === 'coin';
        let usd = null, native = null;
        if (isCrypto) { usd = q.vol; native = q.vol; }             // Yahoo 암호화폐 volume = USD 환산 24h 거래대금
        else if (c === 'USD') { native = q.price * q.vol; usd = native; }
        else if (c === 'KRW' && usdkrw) { native = q.price * q.vol; usd = native / usdkrw; }
        if (usd == null) return;
        const r = (rr || []).find(x => x.symbol === q.symbol) || {};
        rows.push({ symbol: q.symbol, name: q.name, sector: q.sector, currency: c, valueUsd: +usd.toFixed(0),
          valueNative: +native.toFixed(0), changePct: +q.changePct.toFixed(2),
          action: r.action || null, strength: r.strength || null, tip: r.tip || '', why: r.why || '' });
      });
      rows.sort((a, b) => b.valueUsd - a.valueUsd);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ usdkrw, rows, skipped: qq.filter(q => !q.error && q.vol != null && (String(q.symbol||'').startsWith('^') || !['USD','KRW'].includes(q.currency||''))).map(q => q.symbol), computedAt: new Date().toISOString() }));
    }
    if (url === '/api/cmpchoices') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ list: [['USDKRW=X', '원·달러 환율', 'fx'], ['360750.KS', 'TIGER 미국S&P500', 'etf']].concat(QUOTES.map(q => [q[0], q[1], q[2]])) }));
    }
    if (url === '/api/cmpmulti') {
      const raw = decodeURIComponent((req.url.match(/[?&]syms=([^&]*)/) || [])[1] || '');
      const syms = [...new Set(raw.split(',').map(x => x.trim().toUpperCase()).filter(x => /^[\^A-Z0-9.=\-]{1,20}$/.test(x)))].slice(0, 3);
      if (syms.length < 1) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '종목을 1~3개 지정하세요' })); }
      const data = await cached('cmpm_' + syms.join(','), () => getCompareMulti(syms), 3600e3);
      try { const ds = cache.krxstocks && (cache.krxstocks.v || cache.krxstocks); const ef = cache.krxetf && (cache.krxetf.v || cache.krxetf);
        const nm = {}; ((ds && ds.list) || []).forEach(x => { nm[x.code] = x.name; }); ((ef && ef.items) || []).forEach(x => { nm[x.code] = x.name; });
        data.series.forEach(x => { if (x.name === x.sym) { const c = x.sym.split('.')[0]; if (nm[c]) x.name = nm[c]; } }); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/compare') {
      const data = await cached('compare', getCompare, 3600e3);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (url === '/api/backtest') {
      const data = await cached('backtest', getBacktest, 3600e3);
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
}).listen(PORT, async () => {
  try { KIS.init(PORT); } catch(e){}
  try { cache.krxhist = await cached('krxhist', getKrxHist, 6*3600e3); console.log('[warm] krxhist', cache.krxhist && cache.krxhist.count, '종목'); } catch(e){ console.log('[warm] krxhist fail', e && e.message); }
  console.log('공포지수 앱 실행 중: http://localhost:' + PORT);
  (async () => {
    // 비교 차트가 가장 느림 → 가장 먼저, 시작 시 미리 받아 둔다
    await cached('compare', getCompare, 3600e3).catch(() => {});
    await Promise.all([
      cached('quotes', getQuotes).catch(() => {}),
      cached('fng', getFng).catch(() => {}),
      cached('vix', getVix).catch(() => {}),
    ]);
    await cached('backtest', getBacktest, 3600e3).catch(() => {});
  })();
});
