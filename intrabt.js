'use strict';
/**
 * 당일 매매 장중 백테스트 — 야후 5분봉(최근 약 60거래일)
 *  - 종목 선정: 전날 종가까지의 일봉으로 계산(미래 데이터 사용 없음)
 *  - 진입: 진입 시각(기본 09:05) 5분봉 시가
 *  - 청산: 5분봉 고가/저가로 손절·익절 체크(같은 봉에 둘 다 닿으면 손절 우선 = 보수적), 아니면 마지막 봉 종가
 *  - 수수료: 매일 새로 사고 팔므로 매 거래마다 왕복 fee 차감
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kst = t => new Date((t + 9 * 3600) * 1000).toISOString(); // 'YYYY-MM-DDTHH:MM'
async function ychart(sym, range, interval) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const res = (await r.json()).chart.result[0];
      if (!res || !res.timestamp) continue;
      return { t: res.timestamp, q: res.indicators.quote[0] };
    } catch (e) { /* next */ }
  }
  return null;
}
async function loadOne(sym) {
  const [m5, d1] = await Promise.all([ychart(sym, '60d', '5m'), ychart(sym, '6mo', '1d')]);
  if (!m5 || !d1) return null;
  const days = {};
  m5.t.forEach((t, i) => {
    const o = m5.q.open[i], h = m5.q.high[i], l = m5.q.low[i], c = m5.q.close[i]; if (o == null || c == null) return;
    const s = kst(t), d = s.slice(0, 10), hm = s.slice(11, 16);
    (days[d] = days[d] || []).push({ hm, o, h: h ?? Math.max(o, c), l: l ?? Math.min(o, c), c });
  });
  const daily = []; d1.t.forEach((t, i) => { const c = d1.q.close[i]; if (c != null) daily.push([kst(t).slice(0, 10), c]); });
  return { days, daily };
}
const CACHE = {};
async function loadAll(uni) {
  const key = uni.length, E = CACHE[key] || (CACHE[key] = { v: null, t: 0, p: null });
  if (E.v && Date.now() - E.t < 6 * 3600e3) return E.v;
  if (E.p) return E.p;
  E.p = (async () => {
    const out = [];
    for (let i = 0; i < uni.length; i += 6) {
      const rs = await Promise.all(uni.slice(i, i + 6).map(async u => ({ u, d: await loadOne(u.sym) })));
      rs.forEach(({ u, d }) => { if (d && Object.keys(d.days).length > 20 && d.daily.length > 40) out.push({ ...u, ...d }); });
      await sleep(250);
    }
    const allDays = [...new Set(out.flatMap(s => Object.keys(s.days)))].sort();
    E.v = { stocks: out, days: allDays, loadedAt: new Date().toISOString() }; E.t = Date.now();
    return E.v;
  })();
  try { return await E.p; } finally { E.p = null; }
}
function rsiOf(s) { if (s.length < 15) return null; let g = 0, l = 0; for (let i = s.length - 14; i < s.length; i++) { const d = s[i] - s[i - 1]; if (d >= 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
/** 전날까지 일봉으로 앱 점수(추세·모멘텀·위치) */
function prevSig(daily, day, extra) {
  const s = []; for (const [d, c] of daily) { if (d >= day) break; s.push(c); }
  if (extra != null) s.push(extra);
  const w = s.slice(-21); if (w.length < 12) return null;
  const n = w.length, price = w[n - 1], sma = w.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, n), mom = (price - w[n - 6]) / w[n - 6] * 100;
  const hi = Math.max(...w), lo = Math.min(...w), pos = (price - lo) / ((hi - lo) || 1) * 100;
  const trend = price > sma ? 1 : -1, m = mom > 3 ? 1 : mom < -3 ? -1 : 0, p = pos < 25 ? 1 : pos > 80 ? -1 : 0;
  return { sc: trend + m + p, sc2: trend + m, mom, rsi: rsiOf(w), prevClose: price };
}
/** 한 종목·하루 시뮬레이션 */
function simDay(bars, P) {
  const i0 = bars.findIndex(b => b.hm >= P.entry); if (i0 < 0) return null;
  let entryIdx = i0, px = bars[i0].o;
  if (P.orb) { // 오프닝 레인지(09:00~09:30) 고점 돌파 시 진입, 14:30 이후는 진입 안 함
    const rng = bars.filter(b => b.hm < '09:30'); if (!rng.length) return null; const hi = Math.max(...rng.map(b => b.h));
    entryIdx = bars.findIndex(b => b.hm >= '09:30' && b.hm <= P.lastEntry && b.h > hi); if (entryIdx < 0) return null;
    px = Math.max(hi, bars[entryIdx].o);
  }
  const sl = P.sl == null ? null : px * (1 + P.sl / 100), tp = P.tp == null ? null : px * (1 + P.tp / 100);
  for (let k = entryIdx; k < bars.length; k++) {
    const b = bars[k]; if (b.hm > P.exit) { const c = bars[k - 1].c; return { r: c / px - 1, why: 'close' }; }
    const lo = k === entryIdx && P.orb ? Math.min(b.c, px) : b.l, hi = k === entryIdx && P.orb ? Math.max(b.c, px) : b.h;
    if (sl != null && lo <= sl) return { r: P.sl / 100, why: 'stop' };
    if (tp != null && hi >= tp) return { r: P.tp / 100, why: 'take' };
  }
  return { r: bars[bars.length - 1].c / px - 1, why: 'close' };
}
const SELECT = {
  trend: rows => rows.filter(r => r.g.sc2 >= 2).sort((a, b) => b.g.mom - a.g.mom),
  score: rows => rows.slice().sort((a, b) => b.g.sc - a.g.sc || b.g.mom - a.g.mom),
  rsi: rows => rows.filter(r => r.g.rsi != null && r.g.rsi < 30).sort((a, b) => a.g.rsi - b.g.rsi),
  all: rows => rows,
};
function run(H, o) {
  const K = o.k || 5, fee = o.fee || 0;
  const base = { entry: '09:05', exit: o.exit || '14:55', lastEntry: '14:30', sl: o.sl, tp: o.tp };
  const STR = [
    ['추세·모멘텀 상위 · 손절/익절', 'trend', {}],
    ['추세·모멘텀 상위 · 시가→마감(손절/익절 없음)', 'trend', { sl: null, tp: null }],
    ['추세·모멘텀 상위 · 30분 고점 돌파 진입', 'trend', { orb: true }],
    ['신호 점수 상위 · 손절/익절', 'score', {}],
    ['RSI<30 과매도 · 손절/익절', 'rsi', {}],
    ['전체 종목 · 시가→마감(기준선)', 'all', { sl: null, tp: null }],
  ];
  const acc = STR.map(() => ({ eq: 100, curve: [0], rs: [], trades: [], why: { stop: 0, take: 0, close: 0 }, days: 0 }));
  const D = H.days.slice(1); const dts = [];
  D.forEach(day => {
    const rows = [];
    H.stocks.forEach(s => { const bars = s.days[day]; if (!bars || bars.length < 30) return; const g = prevSig(s.daily, day); if (!g) return; rows.push({ s, g, bars }); });
    if (rows.length < K + 3) return;
    dts.push(day);
    STR.forEach(([nm, sel, extra], i) => {
      const P = Object.assign({}, base, extra), A = acc[i];
      const pick = sel === 'all' ? rows : SELECT[sel](rows).slice(0, K);
      const res = pick.map(r => simDay(r.bars, P)).filter(Boolean);
      const f = sel === 'all' ? 0 : fee;
      const r = res.length ? res.reduce((a, x) => a + x.r - f, 0) / res.length : 0;
      res.forEach(x => { A.trades.push(x.r - f); A.why[x.why]++; });
      if (res.length) A.days++;
      A.eq *= 1 + r; A.curve.push(+(A.eq - 100).toFixed(2)); A.rs.push(r);
    });
  });
  const out = STR.map(([nm], i) => {
    const A = acc[i], n = A.rs.length, avg = A.rs.reduce((a, b) => a + b, 0) / (n || 1);
    const sd = Math.sqrt(A.rs.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, n - 1));
    let pk = 100, mdd = 0; A.curve.forEach(v => { const e = 100 + v; pk = Math.max(pk, e); mdd = Math.min(mdd, e / pk - 1); });
    const T = A.trades;
    return { name: nm, total: +(A.eq - 100).toFixed(2), trades: T.length, tradeDays: A.days,
      avgTrade: T.length ? +(100 * T.reduce((a, b) => a + b, 0) / T.length).toFixed(3) : null,
      win: T.length ? Math.round(100 * T.filter(x => x > 0).length / T.length) : null,
      sharpe: sd ? +(avg / sd * Math.sqrt(250)).toFixed(2) : null, mdd: +(mdd * 100).toFixed(1), why: A.why, curve: A.curve };
  });
  return { days: dts.length, from: dts[0], to: dts[dts.length - 1], results: out, dates: [D[0]].concat(dts), overnight: runOvernight(H, o) };
}
/** 오버나이트: d일 14:55 봉 종가에 사서 다음 거래일 첫 봉(09:00) 시가 또는 09:30 에 판다.
 *  종목 선정은 d-1일까지 일봉 + d일 14:55 가격(장중 확인 가능한 값)으로 계산 */
function runOvernight(H, o) {
  const K = o.k || 5, fee = o.fee || 0, D = H.days;
  const STR = [
    ['오버나이트 · 추세·모멘텀 상위 → 다음 날 시가', 'trend', 'open'],
    ['오버나이트 · 추세·모멘텀 상위 → 다음 날 09:30', 'trend', '0930'],
    ['오버나이트 · 신호 점수 상위 → 다음 날 시가', 'score', 'open'],
    ['오버나이트 · RSI<30 과매도 → 다음 날 시가', 'rsi', 'open'],
    ['오버나이트 · 전체 종목 → 다음 날 시가 (기준선)', 'all', 'open'],
  ];
  const acc = STR.map(() => ({ eq: 100, curve: [0], rs: [], trades: [] })); const dts = [];
  for (let i = 1; i + 1 < D.length; i++) {
    const day = D[i], nx = D[i + 1], rows = [];
    H.stocks.forEach(s => {
      const b0 = s.days[day], b1 = s.days[nx]; if (!b0 || !b1 || b0.length < 30 || b1.length < 7) return;
      const last = b0.filter(b => b.hm <= '14:55').pop(); if (!last) return;
      const g = prevSig(s.daily, day, last.c); if (!g) return;
      const e930 = b1.find(b => b.hm >= '09:30'); rows.push({ g, px: last.c, open: b1[0].o, p930: e930 ? e930.o : b1[b1.length - 1].c });
    });
    if (rows.length < K + 3) continue; dts.push(nx);
    STR.forEach(([nm, sel, ex], j) => {
      const A = acc[j], pick = sel === 'all' ? rows : SELECT[sel](rows).slice(0, K), f = sel === 'all' ? 0 : fee;
      const rs = pick.map(r => (ex === 'open' ? r.open : r.p930) / r.px - 1 - f);
      const r = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
      rs.forEach(x => A.trades.push(x)); A.eq *= 1 + r; A.curve.push(+(A.eq - 100).toFixed(2)); A.rs.push(r);
    });
  }
  const results = STR.map(([nm], j) => { const A = acc[j], n = A.rs.length, avg = A.rs.reduce((a, b) => a + b, 0) / (n || 1);
    const sd = Math.sqrt(A.rs.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, n - 1)); let pk = 100, mdd = 0;
    A.curve.forEach(v => { const e = 100 + v; pk = Math.max(pk, e); mdd = Math.min(mdd, e / pk - 1); }); const T = A.trades;
    return { name: nm, total: +(A.eq - 100).toFixed(2), trades: T.length, avgTrade: T.length ? +(100 * T.reduce((a, b) => a + b, 0) / T.length).toFixed(3) : null,
      win: T.length ? Math.round(100 * T.filter(x => x > 0).length / T.length) : null, sharpe: sd ? +(avg / sd * Math.sqrt(250)).toFixed(2) : null, mdd: +(mdd * 100).toFixed(1), curve: A.curve }; });
  return { nights: dts.length, results };
}
async function backtest(uni, opt) {
  opt = opt || {};
  const o = { k: [3, 5, 10].includes(+opt.k) ? +opt.k : 5, fee: Math.max(0, Math.min(2, +(opt.fee ?? 0.3))) / 100,
    sl: opt.sl == null ? -1.5 : +opt.sl, tp: opt.tp == null ? 2 : +opt.tp, exit: '14:55' };
  const H = await loadAll(uni);
  const r = run(H, o);
  return { universe: uni.length, stocks: H.stocks.length, k: o.k, fee: +(o.fee * 100).toFixed(2), sl: o.sl, tp: o.tp, loadedAt: H.loadedAt, ...r,
    note: '야후 5분봉은 최근 약 60거래일만 제공되고, 09:00~15:00 구간만 있어 15:00 이후(15:20 동시호가 포함) 체결은 반영되지 않습니다. 청산 시각 15:15 대신 15:00 직전 봉 종가로 계산했습니다. 같은 5분봉 안에서 손절·익절 가격이 모두 닿으면 손절로 처리했습니다(보수적). 오버나이트는 15:20 종가 동시호가 대신 14:55 봉 종가에 산다고 가정했습니다. 현재 거래대금 상위 종목만 대상이라 생존 편향이 있고, 호가 공백·체결 지연은 반영하지 않았습니다.' };
}
module.exports = { backtest, _t: { simDay, prevSig } };
