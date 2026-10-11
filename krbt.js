'use strict';
/** 국내 주식 추천 신호 백테스트 — 앱의 krxAction 규칙을 과거 날짜마다 그 시점 데이터만으로 재계산 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ydaily(sym, range) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const res = (await r.json()).chart.result[0];
      const c = res.indicators.quote[0].close || [];
      const out = res.timestamp.map((t, i) => [new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10), c[i]]).filter(p => p[1] != null);
      if (out.length > 60) return out;
    } catch (e) { /* next host */ }
  }
  return null;
}

const HC = {}; // 종목 수별 캐시 {key:{h,t,loading}}
/** uni: [{sym,name}] 현재 거래대금 상위 종목, fgHist: [[ms,score]] */
async function loadHist(uni, fgHist) {
  const key = String(uni.length), E = HC[key] || (HC[key] = { h: null, t: 0, loading: null });
  if (E.h && Date.now() - E.t < 12 * 3600e3) return E.h;
  if (E.loading) return E.loading;
  E.loading = (async () => {
    const [kospi, vix] = await Promise.all([ydaily('^KS11', '2y'), ydaily('^VIX', '2y')]);
    if (!kospi) throw new Error('코스피 지수 데이터를 받지 못했습니다');
    const dates = kospi.map(p => p[0]), di = {}; dates.forEach((d, i) => di[d] = i);
    const vm = {}; (vix || []).forEach(p => vm[p[0]] = p[1]);
    const fm = {}; (fgHist || []).forEach(p => fm[new Date(p[0]).toISOString().slice(0, 10)] = p[1]);
    // 미국 지표는 한국 장 시작 전 날짜 기준 → 직전 값(전방 채움)
    const vArr = [], fArr = []; let lv = null, lf = null;
    const allD = Object.keys(vm).concat(Object.keys(fm)).sort();
    let j = 0;
    dates.forEach(d => { while (j < allD.length && allD[j] < d) { const k = allD[j]; if (vm[k] != null) lv = vm[k]; if (fm[k] != null) lf = fm[k]; j++; } vArr.push(lv); fArr.push(lf); });
    const stocks = [];
    for (let i = 0; i < uni.length; i += 5) {
      const rs = await Promise.all(uni.slice(i, i + 5).map(async u => ({ u, h: await ydaily(u.sym, '2y') })));
      rs.forEach(({ u, h }) => {
        if (!h) return;
        const p = new Array(dates.length).fill(null); h.forEach(([d, v]) => { if (di[d] != null) p[di[d]] = v; });
        for (let k = 1; k < p.length; k++) if (p[k] == null && p[k - 1] != null) p[k] = p[k - 1];
        if (p.filter(x => x != null).length > 120) stocks.push({ sym: u.sym, name: u.name, p });
      });
      await sleep(300);
    }
    E.h = { dates, kospi: kospi.map(p => p[1]), vix: vArr, fg: fArr, stocks, fgFrom: Object.keys(fm).sort()[0] || null, loadedAt: new Date().toISOString() };
    E.t = Date.now();
    return E.h;
  })();
  try { return await E.loading; } finally { E.loading = null; }
}

/** 앱 krxAction 과 같은 점수: 최근 1개월(약 21거래일) 종가 창 사용. 구성요소(c)와 RSI14 도 반환 */
function rsiOf(s) { if (s.length < 15) return null; let g = 0, l = 0; for (let i = s.length - 14; i < s.length; i++) { const d = s[i] - s[i - 1]; if (d >= 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
function sigAt(p, t, fg, vx) {
  const s = []; for (let k = Math.max(0, t - 20); k <= t; k++) if (p[k] != null) s.push(p[k]);
  if (s.length < 12) return null;
  const n = s.length, price = s[n - 1], w = Math.min(20, n);
  const sma = s.slice(-w).reduce((a, b) => a + b, 0) / w, mom = (price - s[n - 6]) / s[n - 6] * 100;
  const hi = Math.max(...s), lo = Math.min(...s), pos = (price - lo) / ((hi - lo) || 1) * 100, rsi = rsiOf(s);
  const c = { trend: price > sma ? 1 : -1, mom: mom > 3 ? 1 : mom < -3 ? -1 : 0, pos: pos < 25 ? 1 : pos > 80 ? -1 : 0,
    fg: fg == null ? 0 : fg <= 25 ? 1 : fg >= 75 ? -1 : 0, vix: vx == null ? 0 : vx >= 30 ? 1 : vx < 15 ? -1 : 0,
    rsi: rsi == null ? 0 : rsi < 30 ? 1 : rsi > 70 ? -1 : 0 };
  const score = c.trend + c.mom + c.pos + c.fg + c.vix; // 앱 기본 규칙(RSI 미포함)
  const act = vx != null && vx >= 30 ? '매수' : score <= -1 ? '매도' : '관망';
  return { score, act, mom, rsi, c };
}
/** 가중 점수: w = {trend,mom,pos,fg,vix,rsi} 0~100 → -1~+1 범위 */
const WK = ['trend', 'mom', 'pos', 'fg', 'vix', 'rsi'];
function wScore(c, w) { let t = 0, a = 0; WK.forEach(k => { t += w[k] || 0; a += (w[k] || 0) * c[k]; }); return t ? a / t : 0; }
const WPRESETS = [
  ['균형(앱 기본 규칙)', { trend: 20, mom: 20, pos: 20, fg: 20, vix: 20, rsi: 0 }],
  ['추세·모멘텀 중심', { trend: 40, mom: 40, pos: 0, fg: 10, vix: 10, rsi: 0 }],
  ['역발상(과매도) 중심', { trend: 0, mom: 0, pos: 35, fg: 20, vix: 15, rsi: 30 }],
  ['RSI 포함 균형', { trend: 17, mom: 17, pos: 17, fg: 17, vix: 16, rsi: 16 }],
];
/** 매수 조건 후보 */
const BUYRULES = [
  ['VIX ≥ 30 (현재 규칙)', (g, vx) => vx != null && vx >= 30],
  ['VIX ≥ 25', (g, vx) => vx != null && vx >= 25],
  ['RSI < 30', g => g.rsi != null && g.rsi < 30],
  ['RSI < 35', g => g.rsi != null && g.rsi < 35],
  ['VIX ≥ 25 또는 RSI < 30', (g, vx) => (vx != null && vx >= 25) || (g.rsi != null && g.rsi < 30)],
  ['RSI < 30 + 공포(F&G ≤ 25)', (g, vx, fg) => g.rsi != null && g.rsi < 30 && fg != null && fg <= 25],
];

const STRATS = [
  ['신호 점수 상위 10', 'top'],
  ['매도 신호 제외 전체', 'nosell'],
  ['매수 신호 때만 보유', 'buyonly'],
  ['매도 신호만 (역검증)', 'sellonly'],
  ['추세·모멘텀 점수 상위 10', 'trendtop'],
  ['역발상(저점) 상위 10', 'contra'],
  ['추세·모멘텀 상위 10 + 장세 필터(코스피 20일선 위)', 'trendreg'],
  ['추세·모멘텀 상위 10 + 강한 필터(코스피 20일선 위·20일선 상승)', 'trendreg2'],
];
function run(H, hold, W, fee) {
  fee = fee || 0; const prevSel = {};
  const T = H.dates.length, warm = 25, K = 10;
  const eq = {}, curves = {}, per = {};
  const NAMES = STRATS.map(x => x[0]).concat(['내 가중치 상위 10']).concat(WPRESETS.map(x => '가중:' + x[0])).concat(BUYRULES.map(x => '매수:' + x[0]));
  NAMES.forEach(n => { eq[n] = 100; curves[n] = [0]; per[n] = []; });
  const bAcc = BUYRULES.map(() => ({ f: [], ex: [], hits: 0 }));
  let eU = 100, eK = 100; const cU = [0], cK = [0], dts = [H.dates[warm]], pU = [];
  const acc = { 매수: [], 매도: [], 관망: [] };
  // 위험 관리 비교: 추세·모멘텀 상위 10 × 투자 비중(100/50/30%) × 손절(없음/-3/-5%, 종가 기준)
  const RG = []; [100, 50, 30].forEach(ex => [null, -3, -5].forEach(sl => RG.push({ ex, sl, eq: 100, curve: [0], rs: [], prev: new Set(), stops: 0, n: 0 })));
  for (let t = warm; t + hold < T; t += hold) {
    const fg = H.fg[t], vx = H.vix[t];
    // 장세 필터: t일 종가까지의 코스피만 사용(미래 데이터 없음)
    const kma = (e, n) => { let s = 0; for (let k = e - n + 1; k <= e; k++) s += H.kospi[k]; return s / n; };
    const reg1 = t >= 20 && H.kospi[t] > kma(t, 20), reg2 = reg1 && t >= 25 && kma(t, 20) > kma(t - 5, 20);
    const rows = [];
    H.stocks.forEach(s => {
      const p0 = s.p[t], pf = s.p[t + hold]; if (p0 == null || pf == null) return;
      const g = sigAt(s.p, t, fg, vx); if (!g) return;
      rows.push({ sym: s.sym, name: s.name, fwd: pf / p0 - 1, sc: g.score, act: g.act, mom: g.mom, sc2: g.c.trend + g.c.mom, sc3: -g.mom + 100 * g.c.pos, g,
        ws: wScore(g.c, W), wp: WPRESETS.map(x => wScore(g.c, x[1])) });
    });
    if (rows.length < K + 3) continue;
    rows.forEach(r => acc[r.act].push(r.fwd));
    const mean = a => a.length ? a.reduce((x, r) => x + r.fwd, 0) / a.length : 0;
    const ru = mean(rows), rk = H.kospi[t + hold] / H.kospi[t] - 1;
    const topBy = key => rows.slice().sort((a, b) => b[key] - a[key] || b.mom - a.mom).slice(0, K);
    const pick = {
      top: topBy('sc'),
      nosell: rows.filter(r => r.act !== '매도'),
      buyonly: rows.filter(r => r.act === '매수'),
      sellonly: rows.filter(r => r.act === '매도'),
      trendtop: topBy('sc2'),
      trendreg: reg1 ? topBy('sc2') : [],
      trendreg2: reg2 ? topBy('sc2') : [],
      contra: rows.slice().sort((a, b) => b.sc3 - a.sc3).slice(0, K),
    };
    // 수수료: 새로 편입한 비중만큼 왕복 비용(fee) 차감. 해당 없음 → 현금(비용 0)
    const add = (n, sel) => { const ps = prevSel[n] || new Set(), cur = new Set(sel.map(x => x.sym));
      const turn = sel.length ? sel.filter(x => !ps.has(x.sym)).length / sel.length : 0; prevSel[n] = cur;
      const r = sel.length ? mean(sel) - fee * turn : 0; eq[n] *= 1 + r; curves[n].push(+(eq[n] - 100).toFixed(2)); per[n].push({ r, ru, inv: sel.length > 0 }); };
    STRATS.forEach(([n, k]) => add(n, pick[k]));
    const byW = f => rows.slice().sort((a, b) => f(b) - f(a) || b.mom - a.mom).slice(0, K);
    add('내 가중치 상위 10', byW(r => r.ws));
    { const sel = topBy('sc2');
      RG.forEach(G => {
        let tot = 0; const keep = new Set();
        sel.forEach(r => {
          const s = H.stocks.find(z => z.sym === r.sym), p0 = s.p[t]; let ret = s.p[t + hold] / p0 - 1, stopped = false;
          if (G.sl != null) for (let k = 1; k <= hold; k++) { const q = s.p[t + k]; if (q != null && q / p0 - 1 <= G.sl / 100) { ret = q / p0 - 1; stopped = true; break; } }
          const isNew = !G.prev.has(r.sym); tot += ret - (isNew ? fee : 0); // 왕복 비용은 신규 편입 때 1회(손절 매도 포함)
          if (stopped) G.stops++; else keep.add(r.sym); G.n++;
        });
        const r = sel.length ? (tot / sel.length) * G.ex / 100 : 0; G.prev = keep;
        G.eq *= 1 + r; G.curve.push(+(G.eq - 100).toFixed(2)); G.rs.push(r);
      }); }
    WPRESETS.forEach((x, i) => add('가중:' + x[0], byW(r => r.wp[i])));
    BUYRULES.forEach(([nm, fn], i) => { const sel = rows.filter(r => fn(r.g, vx, fg)); add('매수:' + nm, sel); if (sel.length) bAcc[i].hits++; sel.forEach(r => { bAcc[i].f.push(r.fwd - fee); bAcc[i].ex.push(r.fwd - fee - ru); }); });
    eU *= 1 + ru; eK *= 1 + rk; cU.push(+(eU - 100).toFixed(2)); cK.push(+(eK - 100).toFixed(2)); pU.push(ru);
    dts.push(H.dates[t + hold]);
  }
  const n = pU.length;
  const stat = name => {
    const P = per[name], rs = P.map(x => x.r), avg = rs.reduce((a, b) => a + b, 0) / (rs.length || 1);
    const sd = Math.sqrt(rs.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, rs.length - 1));
    let pk = 0, mdd = 0; curves[name].forEach(v => { const e = 100 + v; if (e > 100 + pk) pk = v; mdd = Math.min(mdd, e / (100 + pk) - 1); });
    const inv = P.filter(x => x.inv);
    return { name, total: +(eq[name] - 100).toFixed(2), win: inv.length ? Math.round(100 * inv.filter(x => x.r > 0).length / inv.length) : null,
      beat: inv.length ? Math.round(100 * inv.filter(x => x.r > x.ru).length / inv.length) : null,
      invested: Math.round(100 * inv.length / (P.length || 1)),
      sharpe: sd ? +(avg / sd * Math.sqrt(250 / hold)).toFixed(2) : null, mdd: +(mdd * 100).toFixed(1), curve: curves[name] };
  };
  const accOut = Object.keys(acc).map(k => { const a = acc[k]; return { act: k, n: a.length,
    avg: a.length ? +(100 * a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null,
    hit: a.length ? Math.round(100 * a.filter(x => x > 0).length / a.length) : null }; });
  return { n, dates: dts, univ: { total: +(eU - 100).toFixed(2), curve: cU }, kospi: { total: +(eK - 100).toFixed(2), curve: cK },
    results: STRATS.map(([nm]) => stat(nm)).concat([stat('내 가중치 상위 10')]),
    wpresets: WPRESETS.map(([nm, w]) => Object.assign(stat('가중:' + nm), { name: nm, w })),
    buyrules: BUYRULES.map(([nm], i) => { const b = bAcc[i], st = stat('매수:' + nm), av = a => a.length ? +(100 * a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null;
      return Object.assign(st, { name: nm, n: b.f.length, periods: b.hits, avg: av(b.f), excess: av(b.ex), hit: b.f.length ? Math.round(100 * b.f.filter(x => x > 0).length / b.f.length) : null }); }),
    weights: W, accuracy: accOut,
    risk: RG.map(G => { const m = G.rs.length, av = G.rs.reduce((a, b) => a + b, 0) / (m || 1), sd = Math.sqrt(G.rs.reduce((a, b) => a + (b - av) ** 2, 0) / Math.max(1, m - 1));
      let pk = 100, mdd = 0; G.curve.forEach(v => { const e = 100 + v; pk = Math.max(pk, e); mdd = Math.min(mdd, e / pk - 1); });
      let worst = 0; G.rs.forEach(x => { worst = Math.min(worst, x); });
      return { exposure: G.ex, stop: G.sl, total: +(G.eq - 100).toFixed(2), sharpe: sd ? +(av / sd * Math.sqrt(250 / hold)).toFixed(2) : null, mdd: +(mdd * 100).toFixed(1),
        worst: +(worst * 100).toFixed(1), stopRate: G.n ? Math.round(100 * G.stops / G.n) : 0, calmar: mdd ? +((G.eq / 100 - 1) / -mdd).toFixed(2) : null, curve: G.curve }; }) };
}
async function backtest(uni, fgHist, hold, w, feePct) {
  hold = [1, 3, 5, 10, 20].includes(+hold) ? +hold : 10;
  const fee = Math.max(0, Math.min(2, +feePct || 0)) / 100;
  const W = {}; WK.forEach((k, i) => { const v = w && w[i] != null && isFinite(w[i]) ? Math.max(0, Math.min(100, +w[i])) : WPRESETS[0][1][k]; W[k] = v; });
  if (!WK.some(k => W[k] > 0)) Object.assign(W, WPRESETS[0][1]);
  const H = await loadHist(uni, fgHist);
  const r = run(H, hold, W, fee);
  return { hold, fee: +(fee * 100).toFixed(2), universe: uni.length, stocks: H.stocks.length, from: r.dates[0], to: r.dates[r.dates.length - 1], fgFrom: H.fgFrom, loadedAt: H.loadedAt, ...r,
    note: '현재 거래대금 상위 종목만 대상이라 생존 편향이 있고, ' + (fee ? `수수료·세금·슬리피지는 왕복 ${(fee * 100).toFixed(2)}%로 가정해 새로 편입한 비중만큼 차감했습니다(전체 평균·코스피 기준선은 미차감).` : '수수료·세금·슬리피지는 반영하지 않았습니다.') + ' 공포·탐욕 지수는 CNN 제공 기간(약 1년)만 반영되고 그 이전은 0점(중립) 처리됩니다. VIX·공포탐욕은 한국 장 시작 전 확정된 직전 미국 거래일 값을 씁니다.' };
}
module.exports = { backtest, WK, WPRESETS };
