'use strict';
/**
 * 매매일지 — 매수/매도 기록과 종목별·섹터별 이력 추적
 *  - 주문 1건마다 기록(수동·자동 공통)
 *  - 같은 종목/같은 섹터를 다시 매매하면 이전 횟수를 함께 기록
 *  - 매도 시 평균단가 기준 실현손익 계산
 */
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'kis-journal.json');

// 앱에서 추적하는 종목의 섹터(코드 기준). 없으면 시장구분으로 대체
const SECTOR_BY_CODE = {
  '005930': 'AI·반도체',
  '012450': '우주·방산', '272210': '우주·방산', 'DXYZ': '우주·방산',
  '267260': 'AI 전력', '010120': 'AI 전력', '298040': 'AI 전력',
  'VST': 'AI 전력', 'CEG': 'AI 전력', 'GEV': 'AI 전력', 'ETN': 'AI 전력', 'OKLO': 'AI 전력', 'SMR': 'AI 전력',
  'IONQ': 'AI', 'PLTR': 'AI',
  'NVDA': '미국 빅테크', 'TSLA': '미국 빅테크', 'GOOGL': '미국 빅테크',
  'VRT': '데이터센터 냉각', 'MOD': '데이터센터 냉각', 'NVT': '데이터센터 냉각', '3017': '데이터센터 냉각',
};

let J = [];
try { J = JSON.parse(fs.readFileSync(F, 'utf8')); if (!Array.isArray(J)) J = []; } catch (e) { J = []; }
function save() { try { fs.writeFileSync(F, JSON.stringify(J, null, 1)); } catch (e) {} }

function sectorOf(code, fallback) { return SECTOR_BY_CODE[code] || fallback || '미분류'; }

/** 현재 보유 수량·평균단가 (일지 기반) */
function position(code) {
  let qty = 0, cost = 0;
  J.filter(x => x.code === code).forEach(x => {
    if (x.side === 'buy') { cost += x.amount; qty += x.qty; }
    else { const avg = qty > 0 ? cost / qty : 0; cost -= avg * x.qty; qty -= x.qty; if (qty <= 0) { qty = Math.max(0, qty); cost = Math.max(0, cost); } }
  });
  return { qty, avg: qty > 0 ? cost / qty : 0, cost };
}

/** 현재 보유분을 처음 산 시각(보유 0 → 매수 시점). 없으면 null */
function heldSince(code) {
  let qty = 0, since = null;
  J.filter(x => x.code === code).forEach(x => {
    if (x.side === 'buy') { if (qty <= 0) since = x.ts; qty += x.qty; }
    else { qty -= x.qty; if (qty <= 0) { qty = 0; since = null; } }
  });
  return since;
}

/** 매매 1건 기록 */
function add(e) {
  const code = String(e.code || '').replace(/[^0-9A-Za-z]/g, '');
  const qty = Number(e.qty) || 0, price = Number(e.price) || 0;
  const sector = sectorOf(code, e.sector);
  const prevCode = J.filter(x => x.code === code);
  const prevSector = J.filter(x => x.sector === sector);
  const pos = position(code);

  let pnl = null, pnlPct = null, avgAt = pos.avg;
  if (e.side === 'sell' && pos.qty > 0) {
    pnl = +((price - pos.avg) * qty).toFixed(0);
    pnlPct = pos.avg > 0 ? +(((price - pos.avg) / pos.avg) * 100).toFixed(2) : null;
  }

  const rec = {
    id: J.length + 1, ts: new Date().toISOString(),
    side: e.side, code, name: e.name || code, sector,
    qty, price, amount: +(qty * price).toFixed(0),
    reason: e.reason || '', src: e.src || 'manual', env: e.env || 'demo', dry: !!e.dry, odno: e.odno || '',
    prevSameCode: prevCode.length, prevSameSector: prevSector.length,
    repeat: prevCode.length > 0,
    holdQtyAfter: e.side === 'buy' ? pos.qty + qty : Math.max(0, pos.qty - qty),
    avgAfter: avgAt,
  };
  if (pnl != null) { rec.pnl = pnl; rec.pnlPct = pnlPct; }
  J.push(rec); save();
  return rec;
}

/** 최근 기록 */
function recent(n) { return J.slice(-(n || 200)).reverse(); }

/** 종목별 요약 */
function byCode() {
  const m = {};
  J.forEach(x => {
    const o = m[x.code] || (m[x.code] = { code: x.code, name: x.name, sector: x.sector, trades: 0, buys: 0, sells: 0, buyQty: 0, sellQty: 0, realized: 0, firstTs: x.ts, lastTs: x.ts, reasons: [] });
    o.trades++; if (x.side === 'buy') { o.buys++; o.buyQty += x.qty; } else { o.sells++; o.sellQty += x.qty; if (x.pnl != null) o.realized += x.pnl; }
    o.lastTs = x.ts; o.name = x.name; o.sector = x.sector;
    if (x.reason && o.reasons.length < 3) o.reasons.push(x.reason);
  });
  return Object.values(m).map(o => ({ ...o, repeat: o.trades > 1, realized: +o.realized.toFixed(0) })).sort((a, b) => b.trades - a.trades || b.lastTs.localeCompare(a.lastTs));
}

/** 섹터별 요약 */
function bySector() {
  const m = {};
  J.forEach(x => {
    const o = m[x.sector] || (m[x.sector] = { sector: x.sector, trades: 0, buys: 0, sells: 0, realized: 0, codes: {}, lastTs: x.ts });
    o.trades++; if (x.side === 'buy') o.buys++; else { o.sells++; if (x.pnl != null) o.realized += x.pnl; }
    o.codes[x.code] = (o.codes[x.code] || 0) + 1; o.lastTs = x.ts;
  });
  return Object.values(m).map(o => ({ sector: o.sector, trades: o.trades, buys: o.buys, sells: o.sells, realized: +o.realized.toFixed(0), codes: Object.keys(o.codes).length, repeat: o.trades > 1, lastTs: o.lastTs })).sort((a, b) => b.trades - a.trades);
}

function totals() {
  const buys = J.filter(x => x.side === 'buy').length, sells = J.filter(x => x.side === 'sell').length;
  const realized = J.reduce((s, x) => s + (x.pnl || 0), 0);
  const wins = J.filter(x => x.pnl != null && x.pnl > 0).length, losses = J.filter(x => x.pnl != null && x.pnl <= 0).length;
  return { trades: J.length, buys, sells, realized: +realized.toFixed(0), wins, losses,
    winRate: (wins + losses) ? +((wins / (wins + losses)) * 100).toFixed(1) : null,
    dry: J.filter(x => x.dry).length, last: J.length ? J[J.length - 1].ts : null };
}


/** 월별 손익 요약 */
function monthly() {
  const m = {};
  J.forEach(x => {
    const k = String(x.ts).slice(0, 7);
    const o = m[k] || (m[k] = { month: k, trades: 0, buys: 0, sells: 0, realized: 0, wins: 0, losses: 0, codes: {} });
    o.trades++; if (x.side === 'buy') o.buys++;
    else { o.sells++; if (x.pnl != null) { o.realized += x.pnl; if (x.pnl > 0) o.wins++; else o.losses++; } }
    o.codes[x.code] = 1;
  });
  return Object.values(m).map(o => ({ ...o, realized: +o.realized.toFixed(0), codes: Object.keys(o.codes).length,
    winRate: (o.wins + o.losses) ? +((o.wins / (o.wins + o.losses)) * 100).toFixed(1) : null }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

/** 손실 반복 종목 (매도 n회 이상 & 누적 실현손실) — blockDays 지나면 자동 해제 */
function losers(minSells, blockDays) {
  minSells = minSells || 2;
  blockDays = blockDays == null ? 30 : Number(blockDays);
  const now = Date.now();
  const m = {};
  J.forEach(x => {
    if (x.pnl == null) return;
    const o = m[x.code] || (m[x.code] = { code: x.code, name: x.name, sector: x.sector, sells: 0, realized: 0, wins: 0, losses: 0, lastSell: x.ts });
    o.sells++; o.realized += x.pnl; if (x.pnl > 0) o.wins++; else o.losses++;
    o.name = x.name; o.sector = x.sector;
    if (String(x.ts) > String(o.lastSell)) o.lastSell = x.ts;
  });
  return Object.values(m).filter(o => o.sells >= minSells && o.realized < 0)
    .map(o => {
      const last = new Date(o.lastSell).getTime();
      const days = Math.floor((now - last) / 864e5);
      const remain = blockDays > 0 ? Math.max(0, blockDays - days) : null;
      return { ...o, realized: +o.realized.toFixed(0), winRate: +((o.wins / o.sells) * 100).toFixed(1),
        daysSince: days, remainDays: remain, released: blockDays > 0 && days >= blockDays };
    })
    .sort((a, b) => a.realized - b.realized);
}

/** 매수 제외 대상 여부 (기간 지나면 해제) */
function isBlocked(code, minSells, blockDays) {
  return losers(minSells, blockDays).some(o => o.code === code && !o.released);
}


/** 월간 리포트 CSV */
function monthlyCsv() {
  const head = ['월', '매매건수', '매수', '매도', '종목수', '실현손익', '이익매도', '손실매도', '승률%'];
  const rows = monthly().map(o => [o.month, o.trades, o.buys, o.sells, o.codes, o.realized, o.wins, o.losses, o.winRate != null ? o.winRate : '']);
  return '\uFEFF' + [head, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
}

function summary() { return { entries: recent(200), byCode: byCode(), bySector: bySector(), monthly: monthly(), losers: losers(2, 30), totals: totals() }; }

function csv() {
  const head = ['일시', '구분', '종목코드', '종목명', '섹터', '수량', '단가', '금액', '사유', '출처', '실현손익', '손익률%', '환경', '재매매', '이전동일종목', '이전동일섹터', '주문번호'];
  const rows = J.map(x => [x.ts, x.side === 'buy' ? '매수' : '매도', x.code, x.name, x.sector, x.qty, x.price, x.amount,
    (x.reason || '').replace(/[",\n]/g, ' '), x.src, x.pnl != null ? x.pnl : '', x.pnlPct != null ? x.pnlPct : '',
    x.env, x.repeat ? 'Y' : 'N', x.prevSameCode, x.prevSameSector, x.odno || '']);
  return '\uFEFF' + [head, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
}

module.exports = { add, summary, recent, byCode, bySector, monthly, losers, isBlocked, totals, csv, monthlyCsv, position, heldSince, _reset: () => { J = []; save(); } };
