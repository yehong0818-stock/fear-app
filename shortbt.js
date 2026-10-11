'use strict';
/**
 * 단타 기법 백테스트 (일봉 OHLC, 약 2년) — 기법별·조합별 성과와 기간 분할 검증
 *  자금 모델: 기법마다 슬롯 K개(기본 5, 슬롯당 1/K 비중), 빈 슬롯은 현금
 *  미래 데이터 금지: 진입 판단은 진입 시점까지 알 수 있는 값만 사용
 *   - VB(변동성 돌파): 목표가 = 당일 시가 + K×전일 고저폭. 당일 고가가 목표가 이상이면 max(시가,목표가)에 매수 → 당일 종가 매도
 *   - GAP(갭 하락 반등): 전일 20일선 위 종목이 시가 −2% 이상 갭 하락 → 시가 매수 → 당일 종가 매도
 *   - ON(오버나이트 과매도): 당일 종가 기준 RSI14<30 → 종가 매수 → 다음 날 시가 매도
 *   - R2(RSI2 눌림목): 60일선 위 + RSI2<10 → 종가 매수 → 종가가 5일선 위로 오르거나 5거래일 지나면 종가 매도
 *  필터: 시장(코스피 전일 종가 > 전일 5일선), 종목(전일 종가 > 전일 5일선)
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function yohlc(sym) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const res = (await r.json()).chart.result[0], q = res.indicators.quote[0];
      const out = []; res.timestamp.forEach((t, i) => { if (q.open[i] != null && q.close[i] != null && q.high[i] != null && q.low[i] != null && q.open[i] > 0)
        out.push({ d: new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
      if (out.length > 120) return out;
    } catch (e) { /* next */ }
  }
  return null;
}
const CACHE = {};
async function load(uni) {
  const key = uni.length, E = CACHE[key] || (CACHE[key] = { v: null, t: 0, p: null });
  if (E.v && Date.now() - E.t < 12 * 3600e3) return E.v;
  if (E.p) return E.p;
  E.p = (async () => {
    const ks = await yohlc('^KS11'); if (!ks) throw new Error('코스피 지수 데이터를 받지 못했습니다');
    const dates = ks.map(x => x.d), di = {}; dates.forEach((d, i) => di[d] = i);
    const stocks = [];
    for (let i = 0; i < uni.length; i += 6) {
      const rs = await Promise.all(uni.slice(i, i + 6).map(async u => ({ u, b: await yohlc(u.sym) })));
      rs.forEach(({ u, b }) => {
        if (!b) return; const A = new Array(dates.length).fill(null);
        b.forEach(x => { if (di[x.d] != null && x.h > x.l) A[di[x.d]] = x; });
        if (A.filter(Boolean).length > 200) stocks.push({ sym: u.sym, code: u.sym.slice(0, 6), name: u.name, b: A });
      });
      await sleep(250);
    }
    E.v = { dates, kospi: ks.map(x => x.c), stocks, loadedAt: new Date().toISOString() }; E.t = Date.now();
    return E.v;
  })();
  try { return await E.p; } finally { E.p = null; }
}
// ── 지표(배열, 인덱스 t 값은 t일 종가까지 반영) ──
function prep(H) {
  const T = H.dates.length;
  const kma5 = H.kospi.map((_, t) => t >= 4 ? H.kospi.slice(t - 4, t + 1).reduce((a, b) => a + b, 0) / 5 : null);
  H.mkt = H.kospi.map((c, t) => kma5[t] != null && c > kma5[t]);
  const kma20 = H.kospi.map((_, t) => t >= 19 ? H.kospi.slice(t - 19, t + 1).reduce((a, b) => a + b, 0) / 20 : null);
  H.mkt20 = H.kospi.map((c, t) => kma20[t] != null && c > kma20[t]);
  H.stocks.forEach(s => {
    const c = s.b.map(x => x ? x.c : null);
    for (let t = 1; t < T; t++) if (c[t] == null && c[t - 1] != null) c[t] = c[t - 1];
    const ma = n => c.map((_, t) => { if (t < n - 1) return null; let sm = 0; for (let k = t - n + 1; k <= t; k++) { if (c[k] == null) return null; sm += c[k]; } return sm / n; });
    const rsi = n => c.map((_, t) => { if (t < n) return null; let g = 0, l = 0; for (let k = t - n + 1; k <= t; k++) { if (c[k] == null || c[k - 1] == null) return null; const d = c[k] - c[k - 1]; if (d >= 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); });
    const val = s.b.map(x => x ? x.c * x.v : 0);
    s.c = c; s.ma5 = ma(5); s.ma20 = ma(20); s.ma60 = ma(60); s.rsi2 = rsi(2); s.rsi14 = rsi(14);
    s.val20 = val.map((_, t) => t >= 19 ? val.slice(t - 19, t + 1).reduce((a, b) => a + b, 0) / 20 : 0);
    // 노이즈 비율(20일 평균): 1 − |시가−종가| / (고가−저가). 작을수록 추세성 강함
    const nz = s.b.map(x => x && x.h > x.l ? 1 - Math.abs(x.o - x.c) / (x.h - x.l) : null);
    s.noise20 = nz.map((_, t) => { if (t < 19) return null; const w = nz.slice(t - 19, t + 1).filter(v => v != null); return w.length > 10 ? w.reduce((a, b) => a + b, 0) / w.length : null; });
  });
  return H;
}
/** 기법 정의: 각 함수는 t일의 (슬롯 기준) 수익률 기여 배열을 반환 */
const TECH = {
  vb: { name: '변동성 돌파 (K=0.5, 당일 청산)', kind: 'day' },
  vbf: { name: '변동성 돌파 + 시장·종목 5일선 필터', kind: 'day' },
  vbn: { name: '변동성 돌파 + 필터 + 노이즈 K(적응형)', kind: 'day' },
  gap: { name: '갭 하락 반등 (−2%↓ 시가, 20일선 위)', kind: 'day' },
  on: { name: '오버나이트 과매도 (RSI14<30, 종가→시가)', kind: 'night' },
  onf: { name: '오버나이트 과매도 + 60일선 위', kind: 'night' },
  r2: { name: 'RSI2 눌림목 (60일선 위, 1~5일)', kind: 'swing' },
  r2m: { name: 'RSI2 눌림목 + 코스피 20일선 위', kind: 'swing' },
  r2s: { name: 'RSI2 눌림목 + 손절 −5%(종가)', kind: 'swing' },
  ibs: { name: 'IBS 종가 저점 반등 (60일선 위, 종가→다음 날 종가)', kind: 'swing' },
};
function dayTrades(H, t, key, P) {
  const out = [];
  H.stocks.forEach(s => {
    const b = s.b[t], p = s.b[t - 1]; if (!b || !p || s.c[t - 1] == null) return;
    if (key === 'vb' || key === 'vbf' || key === 'vbn') {
      if (key !== 'vb' && !(H.mkt[t - 1] && s.ma5[t - 1] != null && s.c[t - 1] > s.ma5[t - 1])) return;
      const K = key === 'vbn' ? Math.max(0.3, Math.min(0.8, s.noise20[t - 1] ?? 0.5)) : 0.5;
      const tgt = b.o + K * (p.h - p.l); if (!(b.h >= tgt) || p.h <= p.l) return;
      const px = Math.max(b.o, tgt); out.push({ s, r: b.c / px - 1, rank: s.val20[t - 1] });
    } else if (key === 'gap') {
      if (!(s.ma20[t - 1] != null && s.c[t - 1] > s.ma20[t - 1])) return;
      if (!(b.o <= s.c[t - 1] * 0.98)) return;
      out.push({ s, r: b.c / b.o - 1, rank: -(b.o / s.c[t - 1]) }); // 갭이 클수록 우선
    }
  });
  return out.sort((a, b) => b.rank - a.rank);
}
function nightTrades(H, t, key) {
  const out = [];
  H.stocks.forEach(s => {
    const b = s.b[t], n = s.b[t + 1]; if (!b || !n || s.rsi14[t] == null) return;
    if (!(s.rsi14[t] < 30)) return;
    if (key === 'onf' && !(s.ma60[t] != null && b.c > s.ma60[t])) return;
    out.push({ s, r: n.o / b.c - 1, rank: -s.rsi14[t] });
  });
  return out.sort((a, b) => b.rank - a.rank);
}
/** 한 기법의 일별 수익률 배열 (인덱스 = 날짜 t, 오버나이트는 t일 종가→t+1 시가를 t+1에 귀속) */
function series(H, key, P) {
  const T = H.dates.length, K = P.k, fee = P.fee, R = new Array(T).fill(0), trades = [];
  if (TECH[key].kind === 'day') {
    for (let t = 61; t < T; t++) { const tr = dayTrades(H, t, key, P).slice(0, K); tr.forEach(x => { const r = x.r - fee; R[t] += r / K; trades.push({ t, r, s: x.s }); }); }
  } else if (TECH[key].kind === 'night') {
    for (let t = 61; t + 1 < T; t++) { const tr = nightTrades(H, t, key).slice(0, K); tr.forEach(x => { const r = x.r - fee; R[t + 1] += r / K; trades.push({ t: t + 1, r, s: x.s }); }); }
  } else { // 스윙형(r2, r2m, r2s, ibs): 종가 매수 → 조건 충족 시 종가 매도
    let pos = [];
    const ibsOf = (s, t) => { const b = s.b[t]; return b && b.h > b.l ? (b.c - b.l) / (b.h - b.l) : null; };
    for (let t = 61; t < T; t++) {
      const keep = [];
      pos.forEach(p => { const c = p.s.c[t], c0 = p.s.c[t - 1]; R[t] += (c / c0 - 1) / K; p.days++;
        const exit = key === 'ibs' ? p.days >= 1 : (c > p.s.ma5[t] || p.days >= 5 || (key === 'r2s' && c / p.px - 1 <= -0.05));
        if (exit) { R[t] -= fee / K; trades.push({ t, r: c / p.px - 1 - fee, s: p.s }); } else keep.push(p); });
      pos = keep; const held = new Set(pos.map(p => p.s.sym));
      if (key === 'r2m' && !H.mkt20[t]) continue;
      const cand = key === 'ibs'
        ? H.stocks.filter(s => s.b[t] && !held.has(s.sym) && s.ma60[t] != null && s.c[t] > s.ma60[t] && ibsOf(s, t) != null && ibsOf(s, t) < 0.15 && s.b[t].c < s.c[t - 1]).sort((a, b) => ibsOf(a, t) - ibsOf(b, t))
        : H.stocks.filter(s => s.b[t] && !held.has(s.sym) && s.ma60[t] != null && s.c[t] > s.ma60[t] && s.rsi2[t] != null && s.rsi2[t] < 10)
        .sort((a, b) => a.rsi2[t] - b.rsi2[t]);
      cand.slice(0, K - pos.length).forEach(s => pos.push({ s, px: s.c[t], days: 0 }));
    }
  }
  return { R, trades };
}
function stats(H, R, trades, from, to) {
  let eq = 100, pk = 100, mdd = 0; const curve = [0], rs = [];
  for (let t = from; t <= to; t++) { eq *= 1 + R[t]; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); curve.push(+(eq - 100).toFixed(2)); rs.push(R[t]); }
  const n = rs.length, av = rs.reduce((a, b) => a + b, 0) / (n || 1), sd = Math.sqrt(rs.reduce((a, b) => a + (b - av) ** 2, 0) / Math.max(1, n - 1));
  const tr = trades.filter(x => x.t >= from && x.t <= to), active = rs.filter(x => x !== 0).length;
  return { total: +(eq - 100).toFixed(2), sharpe: sd ? +(av / sd * Math.sqrt(250)).toFixed(2) : null, mdd: +(mdd * 100).toFixed(1),
    trades: tr.length, avgTrade: tr.length ? +(100 * tr.reduce((a, b) => a + b.r, 0) / tr.length).toFixed(3) : null,
    win: tr.length ? Math.round(100 * tr.filter(x => x.r > 0).length / tr.length) : null, activeDays: Math.round(100 * active / (n || 1)), curve };
}
/** 조합: 시간대가 겹치지 않는 기법(당일 + 오버나이트)은 같은 자금으로 수익률 합산, 그 외는 자금을 나눠 평균 */
const COMBOS = [
  ['조합 A: 변동성 돌파(필터) + 오버나이트 과매도', ['vbf', 'onf'], 'sum'],
  ['조합 B: 변동성 돌파(노이즈 K) + 오버나이트 과매도', ['vbn', 'onf'], 'sum'],
  ['조합 C: 갭 하락 반등 + 오버나이트 과매도', ['gap', 'onf'], 'sum'],
  ['조합 D: A + RSI2 눌림목 (자금 반반)', ['vbf', 'onf', 'r2'], 'mix'],
  ['조합 E: RSI2 눌림목 + 오버나이트(60일선 위) (자금 반반)', ['r2', 'onf'], 'half'],
  ['조합 F: RSI2 눌림목 + IBS 저점 반등 (자금 반반)', ['r2', 'ibs'], 'half'],
  ['조합 G: RSI2(코스피 필터) + IBS + 오버나이트 (자금 1/3씩)', ['r2m', 'ibs', 'onf'], 'third'],
  ['조합 H: RSI2(코스피 필터) + IBS 저점 반등 (자금 반반)', ['r2m', 'ibs'], 'half'],
];
function combine(Rs, how) {
  const T = Rs[0].length, R = new Array(T).fill(0);
  // sum: 당일 기법과 야간 기법은 보유 시간이 겹치지 않아 같은 자금을 번갈아 씀
  // mix: [당일+야간] 묶음에 자금 절반, RSI2 눌림목에 나머지 절반
  for (let t = 0; t < T; t++) R[t] = how === 'sum' ? Rs.reduce((a, r) => a + r[t], 0)
    : how === 'half' ? (Rs[0][t] + Rs[1][t]) / 2 : how === 'third' ? (Rs[0][t] + Rs[1][t] + Rs[2][t]) / 3
    : (Rs[0][t] + Rs[1][t]) / 2 + Rs[2][t] / 2;
  return R;
}
async function backtest(uni, opt) {
  opt = opt || {};
  const P = { k: [3, 5, 10].includes(+opt.k) ? +opt.k : 5, fee: Math.max(0, Math.min(2, +(opt.fee ?? 0.3))) / 100 };
  const H = prep(await load(uni)); const T = H.dates.length, from = 61, mid = Math.floor((from + T - 1) / 2);
  const S = {}; Object.keys(TECH).forEach(k => S[k] = series(H, k, P));
  const row = (name, R, trades, kind, keys) => {
    const all = stats(H, R, trades, from, T - 1), a = stats(H, R, trades, from, mid), b = stats(H, R, trades, mid + 1, T - 1);
    const robust = a.total > 0 && b.total > 0 && all.sharpe > 0.5;
    return { name, kind, keys, ...all, first: { total: a.total, sharpe: a.sharpe }, second: { total: b.total, sharpe: b.sharpe }, robust };
  };
  const techs = Object.keys(TECH).map(k => row(TECH[k].name, S[k].R, S[k].trades, TECH[k].kind, [k]));
  const combos = COMBOS.map(([nm, ks, how]) => row(nm, combine(ks.map(k => S[k].R), how), [].concat(...ks.map(k => S[k].trades)), 'combo', ks));
  // 기준선: 코스피 보유
  const KR = new Array(T).fill(0); for (let t = from; t < T; t++) KR[t] = H.kospi[t] / H.kospi[t - 1] - 1;
  const kospi = stats(H, KR, [], from, T - 1);
  return { universe: uni.length, stocks: H.stocks.length, k: P.k, fee: +(P.fee * 100).toFixed(2), from: H.dates[from], mid: H.dates[mid], to: H.dates[T - 1],
    techs, combos, kospi: { total: kospi.total, mdd: kospi.mdd, curve: kospi.curve }, loadedAt: H.loadedAt,
    note: '일봉 OHLC로 계산했습니다. 변동성 돌파는 장중 목표가 도달 시 체결된다고 가정했고(실제는 호가·체결 지연으로 더 불리), 오버나이트·RSI2는 종가에 산다고 가정했습니다. 수수료·세금·슬리피지는 거래마다 왕복 ' + (P.fee * 100).toFixed(2) + '%로 차감했습니다. 「검증 통과」 = 앞 절반·뒤 절반 기간 모두 수익이고 전체 샤프 0.5 초과. 현재 거래대금 상위 종목 대상이라 생존 편향이 있습니다.' };
}
/** 오늘(장중) 자동매매 후보 계산용: 종목별 전일 고저폭·노이즈 K·필터 상태 */
async function liveTargets(uni) {
  const H = prep(await load(uni)); const T = H.dates.length;
  // 장중에는 야후 일봉 마지막 행이 '오늘(미완성)'일 수 있음 → 오늘 날짜면 하루 앞 행을 전일 기준으로 사용
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), t = H.dates[T - 1] === today ? T - 2 : T - 1;
  return { asOf: H.dates[t], market5: H.mkt[t], list: H.stocks.map(s => { const b = s.b[t]; if (!b) return null;
    return { code: s.code, name: s.name, range: +(b.h - b.l).toFixed(2), close: b.c, ma5: s.ma5[t], ma20: s.ma20[t], ma60: s.ma60[t], above5: s.ma5[t] != null && b.c > s.ma5[t],
      noiseK: +Math.max(0.3, Math.min(0.8, s.noise20[t] ?? 0.5)).toFixed(2), rsi14: s.rsi14[t] != null ? +s.rsi14[t].toFixed(1) : null, val20: s.val20[t] }; }).filter(Boolean) };
}
/** 오늘 신호(자동매매·추천용)
 *  fresh=false: 마지막 완성 일봉 기준(장 마감 후·장 전 추천)
 *  fresh=true : 전일까지 일봉 + 오늘 장중 시세(야후 5일 일봉의 오늘 행, 약 15~20분 지연)로 계산 — 종가 진입 직전 사용
 *  반환: r2(RSI2 눌림목) / ibs(IBS 저점) / on(오버나이트 과매도+60일선) 후보, 종목별 ma5(보유 RSI2 청산 판단용) */
const LIVE = { v: null, t: 0, p: null };
async function ybars(sym) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue; const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], i = res.timestamp.length - 1;
      const d = new Date((res.timestamp[i] + 9 * 3600) * 1000).toISOString().slice(0, 10);
      const c = res.meta.regularMarketPrice ?? q.close[i]; if (c == null) continue;
      return { d, o: q.open[i] ?? c, h: Math.max(q.high[i] ?? c, c), l: Math.min(q.low[i] ?? c, c), c };
    } catch (e) { /* next */ }
  }
  return null;
}
async function liveSignals(uni, fresh, k) {
  k = k || 5;
  const H = prep(await load(uni)), today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  let tY = H.dates.length - 1; while (tY > 0 && H.dates[tY] >= today) tY--; // 전일(완성) 인덱스
  let kNow = null, bars = {};
  if (fresh) {
    if (LIVE.v && Date.now() - LIVE.t < 3 * 60e3) ({ kNow, bars } = LIVE.v);
    else {
      const kb = await ybars('^KS11'); kNow = kb && kb.d === today ? kb.c : null;
      for (let i = 0; i < H.stocks.length; i += 8) {
        const rs = await Promise.all(H.stocks.slice(i, i + 8).map(async s => [s.code, await ybars(s.sym)]));
        rs.forEach(([c, b]) => { if (b && b.d === today) bars[c] = b; }); await sleep(150);
      }
      LIVE.v = { kNow, bars }; LIVE.t = Date.now();
    }
  }
  const useT = fresh ? tY : H.dates.length - 1; // fresh 가 아니면 마지막 행(장중이면 미완성일 수 있어 tY 사용)
  const base = fresh ? tY : (H.dates[H.dates.length - 1] === today ? tY : H.dates.length - 1);
  const kc = H.kospi.slice(0, base + 1); if (fresh && kNow) kc.push(kNow);
  const km20 = kc.length >= 20 ? kc.slice(-20).reduce((a, b) => a + b, 0) / 20 : null, mkt20 = km20 != null && kc[kc.length - 1] > km20;
  const rows = [];
  H.stocks.forEach(s => {
    const cl = s.c.slice(0, base + 1), ob = s.b[base]; let bar = ob;
    if (fresh) { const b = bars[s.code]; if (!b) return; cl.push(b.c); bar = b; }
    if (!bar || cl.length < 61 || cl.slice(-61).some(v => v == null)) return;
    const n = cl.length, p = cl[n - 1], avg = m => cl.slice(-m).reduce((a, b) => a + b, 0) / m;
    const rsi = m => { let g = 0, l = 0; for (let j = n - m; j < n; j++) { const d = cl[j] - cl[j - 1]; if (d >= 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); };
    const ma5 = avg(5), ma60 = avg(60), r2 = rsi(2), r14 = rsi(14), ibs = bar.h > bar.l ? (p - bar.l) / (bar.h - bar.l) : null;
    rows.push({ code: s.code, name: s.name, price: +p.toFixed(2), chg: +((p / cl[n - 2] - 1) * 100).toFixed(2), ma5: +ma5.toFixed(2), ma60: +ma60.toFixed(2),
      rsi2: +r2.toFixed(1), rsi14: +r14.toFixed(1), ibs: ibs == null ? null : +ibs.toFixed(2), above60: p > ma60, down: p < cl[n - 2], val20: s.val20[base] });
  });
  const r2 = rows.filter(x => x.above60 && x.rsi2 < 10).sort((a, b) => a.rsi2 - b.rsi2);
  const ibs = rows.filter(x => x.above60 && x.ibs != null && x.ibs < 0.15 && x.down).sort((a, b) => a.ibs - b.ibs);
  const on = rows.filter(x => x.above60 && x.rsi14 < 30).sort((a, b) => a.rsi14 - b.rsi14);
  const ma5 = {}; rows.forEach(x => ma5[x.code] = x.ma5);
  return { fresh: !!fresh, basis: fresh ? today + ' 장중(약 15~20분 지연)' : H.dates[base] + ' 종가', kospi: { last: +kc[kc.length - 1].toFixed(2), ma20: km20 && +km20.toFixed(2), above20: mkt20 },
    r2: r2.slice(0, 15), r2Blocked: !mkt20, ibs: ibs.slice(0, 15), on: on.slice(0, 15), ma5, priced: rows.length, at: new Date().toISOString() };
}
module.exports = { backtest, liveTargets, liveSignals, TECH, COMBOS };
