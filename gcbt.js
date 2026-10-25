'use strict';
/**
 * 보완 골든크로스 백테스트 — 기존 골든크로스(5일선 상향 돌파)와 보완 조건 비교
 *  보완 조건: 20·60·120일선이 모두 5거래일 전보다 위(우상향) + 5일선이 20일선 아래(이탈·눌림목) + 종가가 60일선 위(지지) + 거래대금 상위 200
 *  뉴스 기사 수는 과거 데이터가 없어 백테스트에서 제외(기술적 조건만 검증)
 *  데이터: 야후 2년 일봉 OHLCV (단타 백테스트와 캐시 공유) · 자금: 신호 날에만 동일비중 매수, 없으면 현금
 */
const SHORT = require('./shortbt.js');
const RULES = [
  ['기존 골든크로스 (5일선 상향 돌파)', 'old'],
  ['보완 골든크로스 (우상향·지지·유동성)', 'strict'],
  ['합집합 (기존 + 보완)', 'both'],
];
function run(H, hold, fee) {
  const T = H.dates.length, warm = 130;
  const eq = {}, curves = {}, per = {}, cnt = {};
  // 손절(종가 기준) 시나리오: 없음/-3/-5% × 전체/50/30% 투자 비중
  const RG = []; [100, 50, 30].forEach(ex => [null, -3, -5].forEach(sl => RG.push({ ex, sl, eq: 100, curve: [0], rs: [], stops: 0, n: 0 })));
  RULES.forEach(([n]) => { eq[n] = 100; curves[n] = [0]; per[n] = []; cnt[n] = { n: 0, periods: 0 }; });
  let eU = 100, eK = 100; const cU = [0], cK = [0], dts = [H.dates[warm]];
  for (let t = warm; t + hold < T; t += hold) {
    const rows = [];
    H.stocks.forEach(s => {
      const b0 = s.b[t], bf = s.b[t + hold]; if (!b0 || !bf) return;
      const c = []; for (let i = Math.max(0, t - 134); i <= t; i++) if (s.b[i]) c.push(s.b[i].c);
      if (c.length < 135) return;
      const ma = n => { if (c.length < n) return null; return c.slice(-n).reduce((x, y) => x + y, 0) / n; };
      const maPrev = n => { if (c.length < n + 5) return null; return c.slice(-(n + 5), -5).reduce((x, y) => x + y, 0) / n; };
      const m5 = ma(5), m20 = ma(20), m60 = ma(60), m120 = ma(120);
      const p20 = maPrev(20), p60 = maPrev(60), p120 = maPrev(120), p5 = maPrev(5);
      if (m5 == null || m20 == null || m60 == null || m120 == null || p5 == null || p20 == null || p60 == null || p120 == null) return;
      const price = b0.c, tv = (b0.v || 0) * price;
      if (tv <= 0) return;
      const strict = m20 > p20 && m60 > p60 && m120 > p120 && m5 < m20 && price >= m60;
      const old = m5 > m20 && p5 <= p20; // 금일 5일선이 20일선을 상향 돌파
      rows.push({ s, strict, old, fwd: bf.c / price - 1, price, tv });
    });
    if (rows.length < 30) continue;
    rows.sort((a, b) => b.tv - a.tv);
    const top = rows.slice(0, 200); // 유동성 상위 200 (두 규칙에 동일 적용해 공정 비교)
    dts.push(H.dates[t + hold]);
    const mean = a => a.length ? a.reduce((x, r) => x + r.fwd, 0) / a.length : 0;
    const ru = mean(top);
    const picks = {
      '기존 골든크로스 (5일선 상향 돌파)': top.filter(r => r.old),
      '보완 골든크로스 (우상향·지지·유동성)': top.filter(r => r.strict),
      '합집합 (기존 + 보완)': top.filter(r => r.old || r.strict),
    };
    RULES.forEach(([nm]) => {
      const sel = picks[nm], r = sel.length ? mean(sel) - fee : 0;
      if (sel.length) cnt[nm].periods++;
      cnt[nm].n += sel.length;
      eq[nm] *= 1 + r; curves[nm].push(+(eq[nm] - 100).toFixed(2)); per[nm].push({ r, ru, inv: sel.length > 0 });
      RG.forEach(G => {
        if (nm !== '보완 골든크로스 (우상향·지지·유동성)') return;
        let tot = 0, stops = 0;
        sel.forEach(x => { const s = x.s, px0 = x.price; let ret = x.fwd;
          if (G.sl != null) for (let k = 1; k <= hold; k++) { const b = s.b[t + k]; if (b && b.c / px0 - 1 <= G.sl / 100) { ret = b.c / px0 - 1; stops++; break; } }
          tot += ret - fee; });
        const rr = sel.length ? (tot / sel.length) * G.ex / 100 : 0; G.stops += stops; G.n += sel.length;
        G.eq *= 1 + rr; G.curve.push(+(G.eq - 100).toFixed(2)); G.rs.push(rr);
      });
    });
    eU *= 1 + ru; eK *= 1 + (H.kospi[t + hold] / H.kospi[t] - 1);
    cU.push(+(eU - 100).toFixed(2)); cK.push(+(eK - 100).toFixed(2));
  }
  const stat = nm => {
    const P = per[nm], rs = P.map(x => x.r), avg = rs.reduce((a, b) => a + b, 0) / (rs.length || 1);
    const sd = Math.sqrt(rs.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, rs.length - 1));
    let pk = 100, mdd = 0; curves[nm].forEach(v => { const e = 100 + v; pk = Math.max(pk, e); mdd = Math.min(mdd, e / pk - 1); });
    const inv = P.filter(x => x.inv);
    return { name: nm, total: +(eq[nm] - 100).toFixed(2), n: cnt[nm].n, periods: cnt[nm].periods,
      avg: +(100 * avg).toFixed(2), excess: inv.length ? +(100 * inv.reduce((a, x) => a + (x.r - x.ru), 0) / inv.length).toFixed(2) : null,
      hit: inv.length ? Math.round(100 * inv.filter(x => x.r > 0).length / inv.length) : null,
      invested: Math.round(100 * inv.length / (P.length || 1)), sharpe: sd ? +(avg / sd * Math.sqrt(250 / hold)).toFixed(2) : null,
      mdd: +(mdd * 100).toFixed(1), curve: curves[nm] };
  };
  const risk = RG.map(G => { const m = G.rs.length, av = G.rs.reduce((a, b) => a + b, 0) / (m || 1), sd = Math.sqrt(G.rs.reduce((a, b) => a + (b - av) ** 2, 0) / Math.max(1, m - 1));
    let pk = 100, mdd = 0; G.curve.forEach(v => { const e = 100 + v; pk = Math.max(pk, e); mdd = Math.min(mdd, e / pk - 1); });
    return { exposure: G.ex, stop: G.sl, total: +(G.eq - 100).toFixed(2), sharpe: sd ? +(av / sd * Math.sqrt(250 / hold)).toFixed(2) : null, mdd: +(mdd * 100).toFixed(1),
      stopRate: G.n ? Math.round(100 * G.stops / G.n) : null, calmar: mdd ? +((G.eq / 100 - 1) / -mdd).toFixed(2) : null }; });
  return { n: dts.length - 1, dates: dts, univ: { total: +(eU - 100).toFixed(2), curve: cU }, kospi: { total: +(eK - 100).toFixed(2), curve: cK }, results: RULES.map(([nm]) => stat(nm)), risk };
}
async function backtest(uni, opt) {
  opt = opt || {};
  const hold = [5, 10, 20].includes(+opt.hold) ? +opt.hold : 10;
  const fee = Math.max(0, Math.min(2, +(opt.fee ?? 0.3))) / 100;
  const H = await SHORT.load(uni);
  const r = run(H, hold, fee);
  return { hold, fee: +(fee * 100).toFixed(2), universe: uni.length, stocks: H.stocks.length, from: r.dates[0], to: r.dates[r.dates.length - 1], ...r,
    note: '두 규칙에 같은 유동성 상위 200 필터를 적용해 공정하게 비교했습니다. 신호 날에만 해당 종목을 동일비중으로 사고 다음 신호일에 갈아탑니다(수수료 왕복 ' + (fee * 100).toFixed(2) + '% 차감, 해당 없는 날은 현금). 뉴스 기사 수는 과거 데이터가 없어 이 백테스트에 포함되지 않았습니다. 현재 거래대금 상위 종목 대상이라 생존 편향이 있습니다.' };
}
module.exports = { backtest, RULES };
