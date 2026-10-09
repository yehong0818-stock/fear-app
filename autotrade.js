#!/usr/bin/env node
/**
 * 시장 체온 — 자동매매 봇 (한국투자증권 KIS Developers 연동)
 *
 * ─ 기본은 안전 모드입니다 ─
 *   1) mode: "dry"  → 주문을 보내지 않고 기록만 합니다 (기본값)
 *   2) env:  "demo" → 모의투자 도메인을 씁니다 (기본값)
 *   실전으로 전환하려면 config 파일을 바꾸고 실행 시 --live 를 함께 줘야 합니다.
 *
 * 전략: 앱의 신호 엔진(거래대금·RSI·골든크로스·망치형 반전)을 그대로 사용
 *   - 골든크로스(역배열→정배열 전환)   +2
 *   - 망치형 반전(음봉·음봉·망치형)     +2
 *   - RSI 30 미만(과매도)              +1
 *   - RSI 30~50(약세)                  +1
 *   - 거래대금 상위                    +1
 *   합계가 buyScoreMin 이상이면 매수 후보.
 *
 * 사용법
 *   KIS_APP_KEY=... KIS_APP_SECRET=... KIS_ACCOUNT=12345678 node autotrade.js
 *   실전: KIS_ENV=real KIS_ACCOUNT=... node autotrade.js --live
 *
 * 이 프로그램은 사용자 본인 계좌용입니다. 제3자에게 제공·판매하면 규제 대상입니다.
 * 투자 판단과 손실의 책임은 사용자에게 있습니다.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── 설정 ──────────────────────────────────────────────
const CFG_PATH = path.join(__dirname, 'autotrade.config.json');
let CFG = {
  mode: 'dry', env: 'demo',
  signalUrl: 'http://localhost:8080/api/krxscan',
  universe: { topByTrdval: 200, maxCandidates: 5 },
  strategy: { buyScoreMin: 3, requireVix30: false,
    weights: { goldenCross: 2, hammer: 2, rsiOversold: 1, rsiWeak: 1, topTrdval: 1 } },
  risk: { maxHoldings: 5, maxBuysPerDay: 3, positionPct: 10, stopLossPct: -5, takeProfitPct: 10, dailyLossLimitPct: -3 },
  order: { type: 'market', excgId: 'KRX' },
  loopSeconds: 60,
  marketHours: { start: '09:00', end: '15:20' },
};
try { Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))); } catch (e) {}

const LIVE = process.argv.includes('--live');
const ENV = (process.env.KIS_ENV || CFG.env || 'demo').toLowerCase();   // demo | real
const APP_KEY = process.env.KIS_APP_KEY || '';
const APP_SECRET = process.env.KIS_APP_SECRET || '';
const ACCOUNT = (process.env.KIS_ACCOUNT || '').replace(/[^0-9]/g, ''); // 8자리
const PRODUCT = process.env.KIS_PRODUCT || '01';                        // 계좌상품코드
const DOMAIN = ENV === 'real'
  ? 'https://openapi.koreainvestment.com:9443'
  : 'https://openapivts.koreainvestment.com:29443';

const LOG_FILE = path.join(__dirname, 'autotrade-log.jsonl');
const STATE_FILE = path.join(__dirname, 'autotrade-state.json');

// ── 안전장치 ──────────────────────────────────────────
if (LIVE && ENV !== 'real') { console.error('[중단] --live 는 KIS_ENV=real 일 때만 허용됩니다. 모의투자는 --live 없이 실행하세요.'); process.exit(1); }
if (LIVE && process.env.ALLOW_LIVE !== '1') { console.error('[중단] 실전 주문은 ALLOW_LIVE=1 환경변수까지 필요합니다. (실수 방지 장치)'); process.exit(1); }
if (ENV === 'real' && !LIVE && CFG.mode === 'live') { console.error('[중단] config.mode=live 인데 --live 플래그가 없습니다.'); process.exit(1); }
const DRY = !LIVE || CFG.mode === 'dry' || process.env.DRY_RUN === '1';

// ── 유틸 ──────────────────────────────────────────────
const now = () => new Date();
function kst() { return new Date(now().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })); }
function ymd(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function log(o) { const line = JSON.stringify({ t: now().toISOString(), ...o }); console.log(line); try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {} }
function info(m) { console.log(`[${kst().toLocaleTimeString('ko-KR')}] ${m}`); }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) {} }
function inMarketHours() {
  const d = kst(); const w = d.getDay(); if (w === 0 || w === 6) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = CFG.marketHours.start.split(':').map(Number);
  const [eh, em] = CFG.marketHours.end.split(':').map(Number);
  return mins >= sh * 60 + sm && mins <= eh * 60 + em;
}

// ── KIS REST ─────────────────────────────────────────
let TOKEN = { v: '', exp: 0 };
async function kisToken() {
  if (TOKEN.v && Date.now() < TOKEN.exp) return TOKEN.v;
  const r = await fetch(`${DOMAIN}/oauth2/tokenP`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: APP_KEY, appsecret: APP_SECRET }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('토큰 발급 실패: ' + JSON.stringify(j));
  TOKEN = { v: j.access_token, exp: Date.now() + (j.expires_in ? (j.expires_in - 600) * 1000 : 6 * 3600e3) };
  return TOKEN.v;
}
function krxHeaders(trId) {
  return { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + TOKEN.v,
    appkey: APP_KEY, appsecret: APP_SECRET, tr_id: trId, custtype: 'P' };
}
async function kisCall(method, urlPath, trId, body, query) {
  await kisToken();
  const url = `${DOMAIN}${urlPath}` + (query ? '?' + new URLSearchParams(query).toString() : '');
  const opt = { method, headers: krxHeaders(trId) };
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (e) { j = { raw: txt }; }
  if (j.rt_cd && j.rt_cd !== '0') log({ kind: 'kis_error', trId, rt_cd: j.rt_cd, msg: j.msg1 || j.msg_cd });
  return j;
}
async function inquirePrice(code) {
  return kisCall('GET', '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', null,
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });
}
async function inquireBalance() {
  const trId = ENV === 'real' ? 'TTTC8434R' : 'VTTC8434R';
  const j = await kisCall('GET', '/uapi/domestic-stock/v1/trading/inquire-balance', trId, null, {
    CANO: ACCOUNT, ACNT_PRDT_CD: PRODUCT, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02',
    UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00',
    CTX_AREA_FK100: '', CTX_AREA_NK100: '',
  });
  const holdings = (j.output1 || []).filter(x => Number(x.hldg_qty) > 0).map(x => ({
    code: x.pdno, name: x.prdt_name, qty: Number(x.hldg_qty), avg: Number(x.pchs_avg_pric),
    pnlPct: Number(x.evlu_pfls_rt) }));
  const cash = Number(((j.output2 || [])[0] || {}).dnca_tot_amt || 0);
  return { holdings, cash };
}
/** 주문 — type: 'buy' | 'sell' */
async function order(code, qty, type) {
  const trId = ENV === 'real'
    ? (type === 'sell' ? 'TTTC0011U' : 'TTTC0012U')
    : (type === 'sell' ? 'VTTC0011U' : 'VTTC0012U');
  const market = CFG.order.type === 'market';
  const body = {
    CANO: ACCOUNT, ACNT_PRDT_CD: PRODUCT, PDNO: code,
    ORD_DVSN: market ? '01' : '00', ORD_QTY: String(qty),
    ORD_UNPR: market ? '0' : String((await inquirePrice(code)).output?.stck_prpr || 0),
    EXCG_ID_DVSN_CD: CFG.order.excgId, SLL_TYPE: type === 'sell' ? '01' : '', CNDT_PRIC: '',
  };
  if (DRY) { log({ kind: 'dry_order', type, code, qty, body }); info(`[DRY] ${type === 'buy' ? '매수' : '매도'} ${code} ${qty}주 (주문 미전송)`); return { dry: true }; }
  const j = await kisCall('POST', '/uapi/domestic-stock/v1/trading/order-cash', trId, body);
  log({ kind: 'order', type, code, qty, rt_cd: j.rt_cd, msg: j.msg1, odno: j.output?.ODNO });
  info(`${type === 'buy' ? '매수' : '매도'} ${code} ${qty}주 → ${j.rt_cd === '0' ? '접수' : '실패: ' + (j.msg1 || j.msg_cd)}`);
  return j;
}

// ── 신호 ─────────────────────────────────────────────
async function fetchSignals() {
  const r = await fetch(CFG.signalUrl);
  const j = await r.json();
  if (j.loading) throw new Error('앱이 전 종목 스캔을 계산 중입니다. 잠시 후 다시 시도하세요.');
  if (j.unauthorized || j.noKey) throw new Error('KRX 신호를 쓸 수 없습니다: ' + (j.msg || '키/승인 필요'));
  return j;
}
function score(row, flags) {
  const w = CFG.strategy.weights; let s = 0; const why = [];
  if (flags.gc) { s += w.goldenCross; why.push('골든크로스'); }
  if (flags.hm) { s += w.hammer; why.push('망치형'); }
  if (row.rsi != null && row.rsi < 30) { s += w.rsiOversold; why.push('RSI' + row.rsi + ' 과매도'); }
  else if (row.rsi != null && row.rsi <= 50) { s += w.rsiWeak; why.push('RSI' + row.rsi + ' 약세'); }
  if (flags.top) { s += w.topTrdval; why.push('거래대금상위'); }
  return { s, why };
}
function pickCandidates(sig) {
  const map = {};
  (sig.turning || []).forEach(x => { map[x.code] = map[x.code] || { ...x, gc: true }; map[x.code].gc = true; });
  (sig.hammer || []).forEach(x => { map[x.code] = map[x.code] || { ...x }; map[x.code].hm = true; });
  let rows = Object.values(map);
  // 거래대금 상위권 가점 대상
  const byVal = [...rows].sort((a, b) => (b.trdval || 0) - (a.trdval || 0));
  const topN = new Set(byVal.slice(0, Math.max(1, Math.round(CFG.universe.topByTrdval / 10))).map(x => x.code));
  if (CFG.strategy.requireVix30 && !(sig.vix != null && sig.vix >= 30)) {
    return { list: [], note: `VIX ${sig.vix} < 30 → 매수 보류(엄격 모드)` };
  }
  rows.forEach(x => { x._sc = score(x, { gc: x.gc, hm: x.hm, top: topN.has(x.code) }); });
  rows = rows.filter(x => x._sc.s >= CFG.strategy.buyScoreMin).sort((a, b) => b._sc.s - a._sc.s || (b.trdval || 0) - (a.trdval || 0));
  return { list: rows.slice(0, CFG.universe.maxCandidates), note: `${rows.length}개 후보 중 상위 ${Math.min(rows.length, CFG.universe.maxCandidates)}` };
}

// ── 1회 사이클 ───────────────────────────────────────
async function cycle() {
  const st = loadState(); const today = ymd(kst());
  if (st.day !== today) { st.day = today; st.buys = 0; st.dayStartEquity = null; saveState(st); }
  if (!inMarketHours()) { info('장 시간이 아닙니다. 대기…'); return; }

  const bal = await inquireBalance();
  if (st.dayStartEquity == null) { st.dayStartEquity = bal.cash + bal.holdings.reduce((s, h) => s + h.qty * h.avg, 0); saveState(st); }

  // 손절·익절 점검
  for (const h of bal.holdings) {
    if (h.pnlPct <= CFG.risk.stopLossPct) { info(`손절: ${h.name} ${h.pnlPct}%`); await order(h.code, h.qty, 'sell'); }
    else if (h.pnlPct >= CFG.risk.takeProfitPct) { info(`익절: ${h.name} ${h.pnlPct}%`); await order(h.code, h.qty, 'sell'); }
  }

  // 신규 매수
  const sig = await fetchSignals();
  const { list, note } = pickCandidates(sig);
  info(`신호: ${note} | VIX ${sig.vix ?? '--'} | 후보 ${list.length}개`);
  const held = new Set(bal.holdings.map(h => h.code));
  for (const c of list) {
    if (st.buys >= CFG.risk.maxBuysPerDay) { info('일일 매수 한도 도달'); break; }
    if (held.size >= CFG.risk.maxHoldings) { info('최대 보유 종목 수 도달'); break; }
    if (held.has(c.code)) continue;
    const budget = Math.floor(bal.cash * CFG.risk.positionPct / 100);
    if (budget < 10000) { info('주문 가능 금액 부족'); break; }
    const price = c.price || (await inquirePrice(c.code)).output?.stck_prpr;
    const qty = Math.floor(budget / Number(price));
    if (qty < 1) continue;
    info(`매수 후보: ${c.name}(${c.code}) 점수 ${c._sc.s} [${c._sc.why.join(', ')}] ${qty}주`);
    await order(c.code, qty, 'buy');
    st.buys++; held.add(c.code); bal.cash -= qty * Number(price); saveState(st);
  }
}

// ── 실행 ─────────────────────────────────────────────
async function main() {
  console.log('=== 시장 체온 자동매매 봇 ===');
  console.log(`모드: ${DRY ? 'DRY-RUN(주문 미전송)' : '실주문'} | 환경: ${ENV === 'real' ? '실전' : '모의투자'} | 계좌: ${ACCOUNT ? ACCOUNT.slice(0, 4) + '****' : '(미설정)'}`);
  if (!APP_KEY || !APP_SECRET || !ACCOUNT) { console.error('[중단] KIS_APP_KEY · KIS_APP_SECRET · KIS_ACCOUNT 환경변수를 설정하세요.'); process.exit(1); }
  console.log(`신호: ${CFG.signalUrl} | 매수 임계점수: ${CFG.strategy.buyScoreMin} | 주기: ${CFG.loopSeconds}s`);
  const once = process.argv.includes('--once');
  do {
    try { await cycle(); } catch (e) { console.error('사이클 오류:', e.message); }
    if (once) break;
    await new Promise(r => setTimeout(r, CFG.loopSeconds * 1000));
  } while (true);
}
main();
