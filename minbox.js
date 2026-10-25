'use strict';
/**
 * 시장 체온 — 1분봉 박스권·지지/저항 스캐너 (Yahoo 1분봉 데이터)
 *
 *  - 데이터: Yahoo v8 chart interval=1m&range=2d → 마지막 약 180개 봉(롤링 창)
 *  - 박스권: 창 안 고가/저가 폭이 좁고(기본 4.5% 이하) 지지·저항 터치가 각 2회 이상
 *  - 매수 신호: 지지 근처(지지가 +0.6% 이내)에서 직전 봉보다 상승 마감(지지 반등)
 *  - 매도 신호: 저항 근처(저항가 -0.6% 이내)에서 직전 봉보다 하락 마감(저항 익절)
 *  - Yahoo 1분봉은 지연이 있을 수 있음 — 실사용 시 KIS 분봉 API로 교체 가능
 */
const CACHE = new Map(); // sym -> {t, bars}
const TTL = 60e3;
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' };

function sessKey(t) { const d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

function parseChart(sym, j) {
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp || !res.indicators || !res.indicators.quote || !res.indicators.quote[0]) return null;
  const q = res.indicators.quote[0], bars = [];
  res.timestamp.forEach((t, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) return;
    bars.push({ t: t * 1000, o, h, l, c });
  });
  return bars.length ? bars : null;
}

async function fetch1m(code) { // code: KRX 6자리 → .KS → .KQ 순 시도
  for (const sfx of ['.KS', '.KQ']) {
    const s = String(code).includes('.') ? String(code) : code + sfx;
    const c = CACHE.get(s);
    if (c && Date.now() - c.t < TTL) return c.bars;
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch('https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?interval=1m&range=2d', { headers: UA });
        if (!r.ok) continue;
        const bars = parseChart(s, await r.json());
        if (!bars) continue;
        CACHE.set(s, { t: Date.now(), bars: bars.slice(-180) }); // 롤링 창: 최근 180봉
        return bars.slice(-180);
      } catch (e) {}
    }
  }
  return null;
}

/** bars: 1분봉 배열(시간 오름차순) → 박스권·지지/저항 분석 */
function analyze(bars, opt) {
  opt = opt || {};
  const boxMax = opt.boxMaxPct == null ? 4.5 : opt.boxMaxPct, near = opt.nearPct == null ? 0.6 : opt.nearPct, minTouch = opt.minTouches == null ? 2 : opt.minTouches;
  if (!bars || bars.length < 30) return { ok: false, why: '봉 부족(' + (bars ? bars.length : 0) + '개)' };
  let sup = Infinity, res = -Infinity;
  bars.forEach(b => { if (b.l < sup) sup = b.l; if (b.h > res) res = b.h; });
  if (!(sup > 0) || !(res > 0) || res <= sup) return { ok: false, why: '가격 이상' };
  const boxPct = +(100 * (res - sup) / sup).toFixed(2);
  let sTouch = 0, rTouch = 0;
  bars.forEach(b => { if (b.l <= sup * (1 + near / 100)) sTouch++; if (b.h >= res * (1 - near / 100)) rTouch++; });
  const box = boxPct <= boxMax && sTouch >= minTouch && rTouch >= minTouch;
  const last = bars[bars.length - 1], prev = bars[bars.length - 2] || last;
  const nearSup = last.c <= sup * (1 + near / 100), nearRes = last.c >= res * (1 - near / 100);
  const buySig = !!(box && nearSup && last.c > prev.c), sellSig = !!(box && nearRes && last.c < prev.c);
  return { ok: true, support: sup, resistance: res, boxPct, sTouch, rTouch, box,
    price: last.c, time: last.t, buySig, sellSig,
    why: buySig ? '박스권 지지 반등' : sellSig ? '박스권 저항 하락' : box ? '박스 중간' : '박스 아님(폭 ' + boxPct + '%)' };
}

/** codes: KRX 6자리 배열, names: code→이름 → 종목별 분석(8개씩 병렬, 60초 캐시) */
async function scan(codes, names, opt) {
  const out = [], list = (codes || []).filter(Boolean).slice(0, (opt && opt.max) || 40);
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async code => {
      const a = analyze(await fetch1m(code), opt);
      if (a && a.ok) out.push(Object.assign({ code, name: (names && names[code]) || '' }, a));
    }));
  }
  return out;
}

module.exports = { analyze, scan, fetch1m };
