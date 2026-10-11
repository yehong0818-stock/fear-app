'use strict';
/** 예상 상승 점수 가중치 백테스트 — 과거 데이터만 사용(미래 정보 누수 없음) */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const CG = 'https://api.coingecko.com/api/v3';
const STABLE = new Set(['usdt','usdc','dai','fdusd','tusd','usdd','usde','busd','usdp','pyusd','usds','susds','usdt0','usd1','susd','frax','lusd','gusd','usdx','eurs','eurt','xaut','paxg','rlusd','usdf','usdy','usdz']);
const NOISE = /wrapped|staked|bridged|binance-peg|wbeth|weth|wsteth|weeth|steth|reth|cbeth|tether gold|pax gold/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jget(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } });
      if (r.status === 429) { await sleep(4000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(1200); }
  }
  throw new Error('rate limited');
}
const pctRank = (arr, v) => { if (v == null || !arr.length) return 0.5; let n = 0; arr.forEach(x => { if (v >= x) n++; }); return n / arr.length; };

let HIST = null, HIST_T = 0, LOADING = null;
async function loadHist(N = 40, DAYS = 180) {
  if (HIST && Date.now() - HIST_T < 12 * 3600e3) return HIST;
  if (LOADING) return LOADING;
  LOADING = (async () => {
    const mk = await jget(`${CG}/coins/markets?vs_currency=usd&order=volume_desc&per_page=120&page=1`);
    const uni = mk.filter(m => !STABLE.has((m.symbol || '').toLowerCase()) && !NOISE.test(m.name || '') && m.total_volume > 1e7).slice(0, N);
    const coins = [];
    for (let i = 0; i < uni.length; i += 4) {
      const rs = await Promise.all(uni.slice(i, i + 4).map(async m => {
        try {
          const d = await jget(`${CG}/coins/${m.id}/market_chart?vs_currency=usd&days=${DAYS}&interval=daily`, 3);
          const day = t => new Date(t).toISOString().slice(0, 10);
          const P = {}, V = {};
          (d.prices || []).forEach(x => { P[day(x[0])] = x[1]; });
          (d.total_volumes || []).forEach(x => { V[day(x[0])] = x[1]; });
          return { id: m.id, symbol: m.symbol.toUpperCase(), name: m.name, P, V };
        } catch (e) { return null; }
      }));
      rs.filter(Boolean).forEach(c => coins.push(c));
      if (i + 4 < uni.length) await sleep(1100);
    }
    const dates = [...new Set(coins.flatMap(c => Object.keys(c.P)))].sort();
    const H = { dates, coins: coins.map(c => ({ ...c, p: dates.map(d => c.P[d] ?? null), v: dates.map(d => c.V[d] ?? null) })).map(({ P, V, ...r }) => r), loadedAt: new Date().toISOString() };
    HIST = H; HIST_T = Date.now(); LOADING = null;
    return H;
  })().catch(e => { LOADING = null; throw e; });
  return LOADING;
}

/** 하나의 가중치로 백테스트: step일마다 상위 K개 동일비중 매수 → hold일 후 평가 */
function runOne(H, w, opt) {
  const { hold = 7, K = 10, warm = 10 } = opt || {};
  const T = H.dates.length, tot = (w.v + w.m + w.n) || 1;
  const periods = [];
  let eq = 100, eqU = 100, eqB = 100;
  const curve = [{ d: H.dates[warm], s: 100, u: 100, b: 100 }];
  const btc = H.coins.find(c => c.symbol === 'BTC');
  for (let t = warm; t + hold < T; t += hold) {
    const rows = [];
    H.coins.forEach(c => {
      const p0 = c.p[t], p1 = c.p[t - 1], p7 = c.p[t - 7], pf = c.p[t + hold];
      if (p0 == null || p1 == null || p7 == null || pf == null) return;
      let v5 = 0, ok = 0; for (let k = t - 4; k <= t; k++) { if (c.v[k] != null) { v5 += c.v[k]; ok++; } }
      if (ok < 3) return;
      rows.push({ sym: c.symbol, v5, r1: p0 / p1 - 1, r7: p0 / p7 - 1, fwd: pf / p0 - 1 });
    });
    if (rows.length < K + 3) continue;
    const V = rows.map(r => r.v5), R1 = rows.map(r => r.r1), R7 = rows.map(r => r.r7);
    rows.forEach(r => {
      const vS = pctRank(V, r.v5), mS = 0.6 * pctRank(R1, r.r1) + 0.4 * pctRank(R7, r.r7), nS = 0.5; // 과거 뉴스 없음 → 중립
      r.score = (w.v * vS + w.m * mS + w.n * nS) / tot;
    });
    rows.sort((a, b) => b.score - a.score);
    const top = rows.slice(0, K);
    const rp = top.reduce((s, r) => s + r.fwd, 0) / top.length;
    const ru = rows.reduce((s, r) => s + r.fwd, 0) / rows.length;
    const rb = btc && btc.p[t] && btc.p[t + hold] ? btc.p[t + hold] / btc.p[t] - 1 : null;
    eq *= 1 + rp; eqU *= 1 + ru; if (rb != null) eqB *= 1 + rb;
    periods.push({ d: H.dates[t], rp, ru, rb, top: top.slice(0, 5).map(r => r.sym) });
    curve.push({ d: H.dates[t + hold], s: +eq.toFixed(2), u: +eqU.toFixed(2), b: +eqB.toFixed(2) });
  }
  const n = periods.length;
  if (!n) return { n: 0 };
  const avg = periods.reduce((s, p) => s + p.rp, 0) / n;
  const sd = Math.sqrt(periods.reduce((s, p) => s + (p.rp - avg) ** 2, 0) / Math.max(1, n - 1));
  let peak = 100, mdd = 0; curve.forEach(c => { if (c.s > peak) peak = c.s; mdd = Math.min(mdd, c.s / peak - 1); });
  return {
    n, total: +(eq - 100).toFixed(2), univ: +(eqU - 100).toFixed(2), btc: +(eqB - 100).toFixed(2),
    excess: +((eq - eqU) ).toFixed(2),
    avg: +(avg * 100).toFixed(2), win: +(100 * periods.filter(p => p.rp > 0).length / n).toFixed(0),
    beat: +(100 * periods.filter(p => p.rp > p.ru).length / n).toFixed(0),
    sharpe: sd ? +(avg / sd * Math.sqrt(365 / hold)).toFixed(2) : null, mdd: +(mdd * 100).toFixed(1),
    curve, last: periods.slice(-3).reverse().map(p => ({ d: p.d, r: +(p.rp * 100).toFixed(2), top: p.top })),
  };
}

const PRESETS = [
  ['기본(모멘텀 중심)', { v: 15, m: 75, n: 10 }], ['균형(이전 기본)', { v: 30, m: 50, n: 20 }],
  ['거래량 중심', { v: 60, m: 30, n: 10 }], ['뉴스 중심', { v: 25, m: 35, n: 40 }],
  ['거래량만', { v: 100, m: 0, n: 0 }], ['모멘텀만', { v: 0, m: 100, n: 0 }],
];
async function backtest(custom, hold) {
  const H = await loadHist();
  hold = [3, 7, 14].includes(+hold) ? +hold : 7;
  const list = PRESETS.slice();
  if (custom && (custom.v + custom.m + custom.n) > 0) list.unshift(['내 설정', custom]);
  const results = list.map(([name, w]) => ({ name, w, ...runOne(H, w, { hold }) }));
  return { hold, K: 10, coins: H.coins.length, from: H.dates[10], to: H.dates[H.dates.length - 1], days: H.dates.length, loadedAt: H.loadedAt,
    note: '과거 뉴스 데이터가 없어 백테스트에서 뉴스 성분은 중립(0.5)으로 고정됩니다. 현재 거래량 상위 코인만 대상이라 생존 편향이 있고, 수수료·슬리피지는 반영하지 않았습니다.',
    results };
}
module.exports = { backtest, loadHist };
