'use strict';
/**
 * 시장 체온 — 한국투자증권(KIS) 실전/모의 매매 모듈
 *
 * 안전 설계
 *  - 트레이딩 API는 모두 PIN 보호(x-trade-pin 헤더 또는 ?pin=)
 *  - 기본값: env=demo(모의), dry=true(주문 미전송)
 *  - 환경=real + dry=false 이면서 allowLive=false 이면 주문 거부 (이중 잠금)
 *  - 앱키·시크릿은 응답에 절대 싣지 않음 (마스킹만)
 */
const fs = require('fs');
const path = require('path');
const J = require('./journal.js');
const GCBT = require('./gcbt.js');
const MB = require('./minbox.js');

const CFG_PATH = path.join(__dirname, 'kis-config.json');
const LOG_FILE = path.join(__dirname, 'autotrade-log.jsonl');

const DEFAULTS = {
  env: 'demo', appKey: '', appSecret: '', account: '', product: '01',
  pin: '', dry: true, allowLive: false, orderType: 'market', excgId: 'KRX',
  auto: { on: false, buyScoreMin: 3, requireVix30: false, positionPct: 10,
    maxHoldings: 5, maxBuysPerDay: 3, stopLossPct: -3, takeProfitPct: 10,
    loopSeconds: 60, universeTop: 200, maxCandidates: 5,
    skipLosers: false, loserMinSells: 2, loserBlockDays: 30,
    mode: 'swing', holdDays: 0, rsiBuy: false, rsiMax: 30, signal: 'score', regime: 'off',
    dayEntryFrom: '09:00', dayEntryTo: '09:30', dayExitAt: '15:00', morningMinutes: 30, afternoonMinutes: 30, stopAnytime: 1,
    combo: 'r2m', comboFrom: '15:10', comboTo: '15:18', newsMin: 2 },
};
let C = JSON.parse(JSON.stringify(DEFAULTS));
try {
  const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  Object.assign(C, j); C.auto = Object.assign({}, DEFAULTS.auto, j.auto || {});
  if (j.auto && j.auto.morningMinutes == null) C.auto.morningMinutes = Math.max(1, hm(C.auto.dayEntryTo) - hm(C.auto.dayEntryFrom));
  if (j.auto && j.auto.afternoonMinutes == null) C.auto.afternoonMinutes = Math.max(1, hm('15:30') - hm(C.auto.dayExitAt));
} catch (e) {}
// 기존 당일 방식도 보유형으로 전환. 계좌·주문 허용 설정은 유지.
if (C.auto.mode === 'day') C.auto.mode = 'swing';
// 환경변수가 있으면 그 값이 우선 (파일에는 저장하지 않음)
if (process.env.KIS_APP_KEY) C.appKey = process.env.KIS_APP_KEY;
if (process.env.KIS_APP_SECRET) C.appSecret = process.env.KIS_APP_SECRET;
if (process.env.KIS_ACCOUNT) C.account = String(process.env.KIS_ACCOUNT).replace(/[^0-9]/g, '');
if (process.env.KIS_PRODUCT) C.product = process.env.KIS_PRODUCT;
if (process.env.KIS_ENV) C.env = process.env.KIS_ENV;
if (process.env.TRADE_PIN) C.pin = process.env.TRADE_PIN;

// 키·계좌는 환경별로 보관. 이전 단일 설정은 현재 환경에만 이관.
C.profiles = C.profiles || {};
if (!C.profiles[C.env]) C.profiles[C.env] = { appKey: C.appKey, appSecret: C.appSecret, account: C.account, product: C.product };
function profileStatus() {
  const out = {};
  for (const env of ['demo', 'real']) { const p = C.profiles[env] || {}; out[env] = { hasKey: !!p.appKey, hasSecret: !!p.appSecret, configured: !!(p.appKey && p.appSecret && p.account), account: p.account ? p.account.slice(0,4) + '****' : '', product: p.product || '01' }; }
  return out;
}
function updateProfile(b) {
  const env = b.env === 'real' ? 'real' : b.env === 'demo' ? 'demo' : C.env;
  const switched = env !== C.env;
  const p = Object.assign({ appKey:'', appSecret:'', account:'', product:'01' }, C.profiles[env] || {});
  if (b.appKey) p.appKey = String(b.appKey).trim();
  if (b.appSecret) p.appSecret = String(b.appSecret).trim();
  if (b.account) p.account = String(b.account).replace(/[^0-9]/g,'');
  if (b.product) p.product = String(b.product).trim();
  C.profiles[env] = p; C.env = env; Object.assign(C,p);
  TOK = { v:'', exp:0 };
  if (switched) { C.auto.on = false; C.dry = true; C.allowLive = false; }
  return switched;
}
function save() { try { fs.writeFileSync(CFG_PATH, JSON.stringify(C, null, 2)); } catch (e) {} }

// ── 캐시·종목 유니버스(server.js에서 주입) ──────────
const MEMCACHE = new Map();
async function cached(key, fn, ttl) { const c = MEMCACHE.get(key); if (c && Date.now() - c.t < (ttl || 60e3)) return c.data; const v = await fn(); MEMCACHE.set(key, { t: Date.now(), data: v }); return v; }
let UNIVERSE_GET = null;
function setUniverse(fn) { UNIVERSE_GET = fn; }

let PORT = process.env.PORT || 8080;
function init(p) { PORT = p || PORT; }

const LOGS = [];
function log(o) {
  const line = { t: new Date().toISOString(), ...o };
  LOGS.push(line); if (LOGS.length > 200) LOGS.shift();
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(line) + '\n'); } catch (e) {}
}

function domain() { return C.env === 'real' ? 'https://openapi.koreainvestment.com:9443' : 'https://openapivts.koreainvestment.com:29443'; }

let TOK = { v: '', exp: 0 };
async function token() {
  if (TOK.v && Date.now() < TOK.exp) return TOK.v;
  const r = await fetch(domain() + '/oauth2/tokenP', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: C.appKey, appsecret: C.appSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('토큰 발급 실패: ' + (j.msg1 || j.msg_cd || j.error_description || '키·계좌를 확인하세요'));
  TOK = { v: j.access_token, exp: Date.now() + ((j.expires_in || 86400) - 600) * 1000 };
  log({ kind: 'token_ok', env: C.env });
  return TOK.v;
}
async function kis(method, p, trId, body, query) {
  const t = await token();
  const url = domain() + p + (query ? '?' + new URLSearchParams(query).toString() : '');
  const headers = {
    'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + t,
    appkey: C.appKey, appsecret: C.appSecret, tr_id: trId, custtype: 'P',
  };
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({ raw: 'parse_fail' }));
  if (j.rt_cd && j.rt_cd !== '0') log({ kind: 'kis_err', trId, rc: j.rt_cd, msg: j.msg1 || j.msg_cd });
  return j;
}
/** 주문 후 실제 체결 평균가 조회: 매수는 잔고의 매입평균가(가장 확실), 매도는 체결내역(필드명이 계좌/버전에 따라 달라 실패하면 null) */
async function fillAvgBuy(code) { try { const b = await balance(); const h = b.holdings.find(x => x.code === code); return h && h.avg > 0 ? h.avg : null; } catch (e) { return null; } }
async function fillAvgSell(odno, code) {
  try {
    const trId = C.env === 'real' ? 'TTTC0081R' : 'VTTC0081R';
    const d = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    const j = await kis('GET', '/uapi/domestic-stock/v1/trading/inquire-daily-ccld', trId, null, {
      CANO: C.account, ACNT_PRDT_CD: C.product, INQR_STRT_DT: d, INQR_END_DT: d, SLL_BUY_DVSN_CD: '00',
      INQR_DVSN: '00', PDNO: code, CCLD_DVSN: '00', ODNO: odno || '', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
    });
    const it = (j.output1 || []).find(x => !odno || String(x.odno) === String(odno)) || (j.output1 || [])[0];
    if (!it) { log({ kind: 'fill_unknown', side: 'sell', code, msg: '체결내역 없음' }); return null; }
    const raw = it.avg_prvs ?? it.avg_pric ?? it.avg_prc ?? it.pchs_avg_pric ?? it.ccld_avg_prvs;
    if (raw == null) log({ kind: 'fill_unknown', side: 'sell', code, keys: Object.keys(it).slice(0, 30) });
    const v = Number(String(raw ?? '').replace(/[^0-9.]/g, ''));
    return v > 0 ? v : null;
  } catch (e) { log({ kind: 'fill_unknown', side: 'sell', code, msg: String(e && e.message || e) }); return null; }
}
async function lastPrice(code) { try { const p = await price(code); return Number(p.output?.stck_prpr || 0); } catch (e) { return 0; } }
async function price(code) { return kis('GET', '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', null, { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }); }
async function balance() {
  const trId = C.env === 'real' ? 'TTTC8434R' : 'VTTC8434R';
  const j = await kis('GET', '/uapi/domestic-stock/v1/trading/inquire-balance', trId, null, {
    CANO: C.account, ACNT_PRDT_CD: C.product, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02',
    UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00',
    CTX_AREA_FK100: '', CTX_AREA_NK100: '',
  });
  if (j.rt_cd !== '0') throw new Error(j.msg1 || j.msg_cd || '잔고 조회 실패');
  const holdings = (j.output1 || []).filter(x => Number(x.hldg_qty) > 0).map(x => ({
    code: x.pdno, name: x.prdt_name, qty: Number(x.hldg_qty), avg: Number(x.pchs_avg_pric),
    price: Number(x.prpr || 0), pnlPct: Number(x.evlu_pfls_rt || 0), pnl: Number(x.evlu_pfls_amt || 0),
  }));
  const o2 = (j.output2 || [])[0] || {};
  return { cash: Number(o2.dnca_tot_amt || 0), buyable: Number(o2.prvs_rcdl_excc_amt || o2.dnca_tot_amt || 0), holdings };
}
let NAMEC = {};
async function stockInfo(code) {
  if (NAMEC[code]) return NAMEC[code];
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/krxstock?q=${encodeURIComponent(code)}`);
    const j = await r.json();
    const it = (j.items || []).find(x => x.code === code) || (j.items || [])[0];
    if (it) { NAMEC[code] = { name: it.name, market: it.market }; return NAMEC[code]; }
  } catch (e) {}
  return { name: code };
}
async function order(side, code, qty, meta) {
  meta = meta || {};
  if (!C.appKey || !C.account) throw new Error('KIS 설정이 필요합니다.');
  if (C.env === 'real' && !C.dry && !C.allowLive) throw new Error('실전 주문이 잠겨 있습니다(allowLive=false). 설정에서 허용해야 주문됩니다.');
  const trId = C.env === 'real' ? (side === 'sell' ? 'TTTC0011U' : 'TTTC0012U') : (side === 'sell' ? 'VTTC0011U' : 'VTTC0012U');
  let unpr = '0';
  if (C.orderType === 'limit') { const p = await price(code); unpr = String(p.output?.stck_prpr || 0); }
  const body = {
    CANO: C.account, ACNT_PRDT_CD: C.product, PDNO: code, ORD_DVSN: C.orderType === 'market' ? '01' : '00',
    ORD_QTY: String(qty), ORD_UNPR: unpr, EXCG_ID_DVSN_CD: C.excgId,
    SLL_TYPE: side === 'sell' ? '01' : '', CNDT_PRIC: '',
  };
  const info = await stockInfo(code);
  const price = C.dry ? (C.orderType === 'limit' ? Number(unpr) || 0 : await lastPrice(code)) : Number(unpr) || await lastPrice(code);
  if (C.dry) {
    const rec = J.add({ side, code, name: info.name, qty, price, reason: meta.reason || '수동 주문', src: meta.src || 'manual', tag: meta.tag || '', bt: meta.bt || null, env: C.env, dry: true });
    log({ kind: 'dry_order', side, code, name: info.name, qty, journalId: rec.id });
    return { dry: true, msg: 'DRY-RUN: 주문 미전송', body, journal: rec };
  }
  const j = await kis('POST', '/uapi/domestic-stock/v1/trading/order-cash', trId, body);
  const rec = J.add({ side, code, name: info.name, qty, price, reason: meta.reason || '수동 주문', src: meta.src || 'manual', tag: meta.tag || '', bt: meta.bt || null, env: C.env, dry: false, odno: j.output?.ODNO });
  log({ kind: 'order', side, code, name: info.name, qty, rc: j.rt_cd, odno: j.output?.ODNO, msg: j.msg1, journalId: rec.id });
  // 실제 체결 평균가 기록(백테스트 기준가와 비교용). 조회 실패해도 주문 자체는 성공 처리
  if (j.rt_cd === '0') {
    const fill = side === 'buy' ? await fillAvgBuy(code) : await fillAvgSell(j.output?.ODNO, code);
    if (fill) { const u = J.attachFill(rec.id, fill); log({ kind: 'fill_ok', side, code, fill, bt: meta.bt || null, slip: u && u.slip }); }
  }
  return { ...j, journal: rec };
}

// ── 신호 → 후보 ─────────────────────────────
async function signals() {
  const to = (p, ms) => Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]); // 준비 중이면 기존 방식으로 fallback
  const [r, g, n] = await Promise.all([
    fetch(`http://127.0.0.1:${PORT}/api/krxscan`).then(x => x.json()),
    to(fetch(`http://127.0.0.1:${PORT}/api/gcstrict`).then(x => x.json()).catch(() => null), 25000),
    fetch(`http://127.0.0.1:${PORT}/api/newsheat`).then(x => x.json()).catch(() => null),
  ]);
  const j = r;
  if (j.loading) throw new Error('앱이 전 종목 스캔을 계산 중입니다.');
  j.gcStrict = g && !g.error && !g.loading ? g : null;
  j.news = n || null;
  if ((C.auto.regime || 'off') !== 'off') { try { j.kospi = await (await fetch(`http://127.0.0.1:${PORT}/api/kospireg`)).json(); } catch (e) { j.kospi = { ok: false }; } }
  return j;
}
function candidates(sig) {
  const A = C.auto, W = { gc: 2, hm: 2, rsiO: 1, rsiW: 1, top: 1 };
  const map = {};
  const gcl = (sig.gcStrict && sig.gcStrict.list) || [];
  if (gcl.length) {
    // 보완 골든크로스: 20·60·120일선 우상향 + 거래대금 상위 + 5일선 20일선 이탈·60일선 지지
    gcl.forEach(x => { (map[x.code] = map[x.code] || { ...x }).gcs = true; });
  } else {
    (sig.turning || []).forEach(x => { (map[x.code] = map[x.code] || { ...x }).gc = true; }); // 보완 목록 미준비 → 기존 방식
  }
  (sig.hammer || []).forEach(x => { (map[x.code] = map[x.code] || { ...x }).hm = true; });
  let rows = Object.values(map);
  const byVal = [...rows].sort((a, b) => (b.trdval || 0) - (a.trdval || 0));
  const topN = new Set(byVal.slice(0, Math.max(1, Math.round(A.universeTop / 10))).map(x => x.code));
  if (A.requireVix30 && !(sig.vix != null && sig.vix >= 30)) return { list: [], note: `VIX ${sig.vix ?? '--'} < 30 → 보류` };
  const rg = A.regime || 'off', kp = sig.kospi;
  if (rg !== 'off') {
    // 장세 필터: 코스피 데이터를 못 받으면 안전하게 신규 매수 보류
    if (!kp || !kp.ok) return { list: [], note: '장세 필터: 코스피 데이터 없음 → 신규 매수 보류' };
    const pass = kp.above && (rg !== 'strong' || kp.rising);
    if (!pass) return { list: [], note: `장세 필터: 코스피 ${kp.close} / 20일선 ${kp.ma20}${rg === 'strong' ? (kp.rising ? ' 상승' : ' 하락') : ''} → 신규 매수 보류` };
  }
  rows.forEach(x => {
    let s = 0; const why = [];
    if (x.gcs) { s += W.gc; why.push('골든크로스(보완: 20·60·120일선 우상향·60일선 지지)'); }
    else if (x.gc) { s += W.gc; why.push('골든크로스(기존)'); }
    if (x.hm) { s += W.hm; why.push('망치형'); }
    const nn = (sig.news && sig.news.counts && sig.news.counts[x.code]) || 0;
    x._news = nn; if (nn > 0) why.push('뉴스 ' + nn + '건');
    if (A.newsMin > 0 && nn >= Math.max(A.newsMin * 3, 6)) s += 1;
    if (x.rsi != null && x.rsi < 30) { s += W.rsiO; why.push('RSI' + x.rsi); } else if (x.rsi != null && x.rsi <= 50) { s += W.rsiW; why.push('RSI' + x.rsi); }
    if (topN.has(x.code)) { s += W.top; why.push('거래대금'); }
    x._s = s; x._why = why;
  });
  if (A.newsMin > 0) {
    // 뉴스 트래픽 필터: 07:00~11:30 시간별 수집 데이터 기준, 최소 건수 미만은 제외
    if (!sig.news || !sig.news.at) return { list: [], note: '뉴스 트래픽 데이터가 아직 수집되지 않았습니다(07:00~11:30 시간별) → 매수 보류' };
    rows = rows.filter(x => x._news >= A.newsMin);
  }
  let rsiRows = [];
  if (A.rsiBuy && rsiAllowed(A)) {
    // RSI<기준 종목은 점수와 무관하게 후보(거래대금 상위 universeTop 안에서, 레버리지·인버스·우선주 제외)
    const pool = (sig.rsiLow || []).filter(x => (x.trdRank || 1e9) <= (A.universeTop || 200) && x.rsi != null && x.rsi < (A.rsiMax || 30) && !/레버리지|인버스|우$|우B$/.test(x.name || ''));
    rsiRows = pool.slice(0, A.maxCandidates).map(x => ({ ...x, _s: A.buyScoreMin, _why: ['RSI' + x.rsi + '<' + (A.rsiMax || 30), '보유 ' + A.holdDays + '일'] }));
  }
  if ((A.signal || 'score') === 'trend') {
    // 추세·모멘텀 상위: 20일선 위 + 1주 +3% 초과 종목을 1주 상승률 순으로 (점수 임계 대신 사용)
    rows = (sig.trendTop || []).filter(x => (x.trdRank || 1e9) <= (A.universeTop || 200) && !/레버리지|인버스|우$|우B$/.test(x.name || ''))
      .map(x => ({ ...x, _s: A.buyScoreMin, _why: ['추세·모멘텀', '1주 +' + x.mom5 + '%', '거래대금 ' + x.trdRank + '위'] }));
  } else rows = rows.filter(x => x._s >= A.buyScoreMin);
  if ((A.signal || 'score') !== 'trend') rows = rows.sort((a, b) => b._s - a._s || b._news - a._news || (b.trdval || 0) - (a.trdval || 0));
  const seen = new Set(), list = [];
  rsiRows.concat(rows).forEach(x => { if (!seen.has(x.code) && list.length < A.maxCandidates) { seen.add(x.code); list.push(x); } });
  const sn = (A.signal || 'score') === 'trend' ? '추세·모멘텀 ' : '점수 ';
  const nn = A.newsMin > 0 ? ` · 뉴스≥${A.newsMin}건` : '';
  const rn = A.rsiBuy ? (rsiAllowed(A) ? ` · RSI 후보 ${rsiRows.length}` : ' · RSI 매수 꺼짐(10~20일 보유일 때만)') : '';
  return { list, note: `${rows.length}개 ${sn}후보${rn}${nn}` };
}
// ── 매매 방식 ───────────────────────────────
//  swing: 기존(손절·익절, holdDays>0 이면 기간 청산)  short: 단기(최대 holdDays 거래일)  day: 당일(장 시작 30분에만 진입, 마감 30분 전부터 전량 청산)
const MODE_PRESET = {
  swing: { stopLossPct: -3, takeProfitPct: 10, holdDays: 0, signal: 'score' },
  short: { stopLossPct: -3, takeProfitPct: 4, holdDays: 3, signal: 'trend' },
  day:   { stopLossPct: -3, takeProfitPct: 2, holdDays: 0, signal: 'trend' },
  combo: { stopLossPct: -3, takeProfitPct: 0, holdDays: 0, signal: 'score' },
};
// ── 단타 조합(백테스트 검증 통과 기법) ─────────
//  r2m : RSI2 눌림목 + 코스피 20일선 위   (종가 매수 → 종가가 5일선 위 또는 5거래일 → 종가 매도)
//  h   : r2m(슬롯 절반) + IBS 저점 반등(슬롯 절반, 종가 매수 → 다음 거래일 종가 매도)
//  r2  : RSI2 눌림목(시장 필터 없음)
const COMBO = { r2m: { name: 'RSI2 눌림목 + 코스피 필터', parts: ['r2m'] }, h: { name: 'RSI2(코스피 필터) + IBS 저점 반등', parts: ['r2m', 'ibs'] }, r2: { name: 'RSI2 눌림목', parts: ['r2'] } };
const BAD_NAME = /레버리지|인버스|우$|우B$|스팩|리츠/;
let comboDay = '';
async function comboTick(A, bal, now) {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (!tradeWindow(A, now)) return;
  const session = today + (now < hm('12:00') ? ':am' : ':pm');
  if (comboDay === session) return; // 시간대별 1회
  const r = await fetch(`http://127.0.0.1:${PORT}/api/shortlive?fresh=1`); const sg = await r.json();
  if (sg.error || !sg.priced) { log({ kind: 'auto_error', msg: '단타 조합: 장중 시세를 받지 못함 ' + (sg.error || '') }); return; }
  comboDay = session;
  const cfg = COMBO[A.combo] || COMBO.r2m, maxH = Math.max(1, A.maxHoldings || 5);
  const slots = cfg.parts.length === 2 ? { [cfg.parts[0]]: Math.ceil(maxH / 2), [cfg.parts[1]]: Math.floor(maxH / 2) } : { [cfg.parts[0]]: maxH };
  // 1) 청산: 앱이 이 전략 태그로 산 종목만
  const sold = new Set(), heldBy = { r2m: [], r2: [], ibs: [] };
  for (const h of bal.holdings) {
    const tag = J.holdTag(h.code); if (!heldBy[tag]) continue;
    const days = bizDaysSince(J.heldSince(h.code)), ma5 = sg.ma5[h.code], px = h.price || 0;
    let why = null;
    if (tag === 'ibs' && days >= 1) why = `IBS 반등 1일 보유 청산 ${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct}%`;
    if ((tag === 'r2m' || tag === 'r2') && (days >= 5 || (ma5 && px > ma5))) why = days >= 5 ? `RSI2 5거래일 경과 청산 ${h.pnlPct}%` : `RSI2 5일선 회복 청산 ${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct}%`;
    if (why) { log({ kind: 'auto_combo_exit', name: h.name, tag, days }); await order('sell', h.code, h.qty, { reason: why, src: 'auto', tag, bt: h.price || null }); sold.add(h.code); }
    else heldBy[tag].push(h.code);
  }
  // 2) 진입
  const held = new Set(bal.holdings.map(h => h.code)); let budgetBase = bal.cash, buys = 0;
  for (const part of cfg.parts) {
    let free = slots[part] - heldBy[part].length; if (free <= 0) continue;
    if (part === 'r2m' && !sg.kospi.above20) { log({ kind: 'auto_scan', note: `단타 조합: 코스피 ${sg.kospi.last} < 20일선 ${sg.kospi.ma20} → RSI2 신규 매수 보류` }); continue; }
    const list = (part === 'ibs' ? sg.ibs : sg.r2).filter(x => !held.has(x.code) && !BAD_NAME.test(x.name || ''));
    log({ kind: 'auto_scan', note: `단타 조합 ${part === 'ibs' ? 'IBS' : 'RSI2'} 후보 ${list.length} · 빈 슬롯 ${free}` });
    for (const c of list) {
      if (free <= 0 || state.buys >= A.maxBuysPerDay) break;
      const budget = Math.floor(budgetBase * A.positionPct / 100); if (budget < 10000) break;
      const qty = Math.floor(budget / Number(c.price)); if (qty < 1) continue;
      const why = part === 'ibs' ? `IBS ${c.ibs}·60일선 위·하락 마감` : `RSI2 ${c.rsi2}·60일선 위`;
      await order('buy', c.code, qty, { reason: '자동 매수[단타 조합 · ' + cfg.name + '] · ' + why, src: 'auto', tag: part, bt: c.price });
      held.add(c.code); free--; buys++; state.buys++;
    }
  }
  log({ kind: 'auto_combo_done', sold: sold.size, bought: buys, basis: sg.basis });
}
/** RSI 매수는 10~20거래일 보유(스윙 + 기간 청산)일 때만 허용 — 백테스트에서 5일 이하 보유는 우위가 없었음 */
function rsiAllowed(A) { A = A || C.auto; return (A.mode || 'swing') === 'swing' && A.holdDays >= 10 && A.holdDays <= 20; }
function kstNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })); }
function hm(s) { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); }
function sessionWindows(A) {
  const am = hm(A.dayEntryFrom || '09:00');
  const duration = (n, fallback) => Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : fallback;
  return [[am, Math.min(930, am + duration(A.morningMinutes, Math.max(1, hm(A.dayEntryTo || '09:30') - am)))],
    [Math.max(540, 930 - duration(A.afternoonMinutes, 30)), 930]];
}
function tradeWindow(A, now) {
  return now >= 540 && now <= 930 && sessionWindows(A).some(([from, to]) => now >= from && now <= to);
}
function kstMin() { const d = kstNow(); return d.getHours() * 60 + d.getMinutes(); }
/** 평일 기준 경과 거래일(공휴일 미반영) */
function bizDaysSince(iso) {
  if (!iso) return 0; const a = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Seoul' })), b = kstNow();
  a.setHours(0, 0, 0, 0); b.setHours(0, 0, 0, 0); let n = 0;
  for (const d = new Date(a); d < b; d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
function inHours() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  const m = d.getHours() * 60 + d.getMinutes(); return m >= 9 * 60 && m <= 15 * 60 + 30;
}
async function boxScanCodes(codes) { const m = {}; (await MB.scan(codes || [], {})).forEach(b => { m[b.code] = b; }); return m; }
let state = { day: '', buys: 0 };
let running = false;
async function autoTick() {
  if (running) return; if (!C.auto.on || !C.appKey || !C.account) return;
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) { state = { day: today, buys: 0 }; }
  if (!inHours()) { log({ kind: 'auto_wait', msg: '장 시간 아님' }); return; }
  running = true;
  try {
    const A = C.auto, mode = A.mode || 'swing', now = kstMin();
    const bal = await balance();
    if (mode === 'combo') {
      // 단타 조합: 손절(설정 시)만 장중 확인, 나머지는 종가 매매 시간에 일괄 처리
      if (A.stopLossPct < 0 && (A.stopAnytime == 1 || tradeWindow(A, now))) for (const h of bal.holdings) if (J.holdTag(h.code) && h.pnlPct <= A.stopLossPct) { await order('sell', h.code, h.qty, { reason: '자동 손절 ' + h.pnlPct + '%', src: 'auto', tag: J.holdTag(h.code), bt: h.price || null }); }
      await comboTick(A, bal, now); return;
    }
    const sold = new Set();
    const inExit = tradeWindow(A, now); // 두 구간 모두 매수·매도 허용
    const stopWin = A.stopAnytime == 1 || inExit; // 손절만 장중 상시 확인 옵션(stopAnytime=1)
    const boxMap = A.signal === 'box' && bal.holdings.length ? await boxScanCodes(bal.holdings.map(h => h.code)) : null;
    for (const h of bal.holdings) {
      const days = bizDaysSince(J.heldSince(h.code));
      const auto = J.heldSince(h.code) != null; // 앱 일지에 매수 기록이 있는 종목만 기간·당일 청산(직접 산 종목은 손절·익절만)
      let why = null, kind = null;
      if (A.stopLossPct < 0 && stopWin && h.pnlPct <= A.stopLossPct) { kind = 'auto_stop_loss'; why = '자동 손절 ' + h.pnlPct + '%'; }
      else if (A.takeProfitPct > 0 && inExit && h.pnlPct >= A.takeProfitPct) { kind = 'auto_take_profit'; why = '자동 익절 +' + h.pnlPct + '%'; }
      // 장 마감 자체는 매도 사유가 아님. 익절·손절·기간·신호 조건으로만 청산.
      else if (auto && A.holdDays > 0 && inExit && days >= A.holdDays) { kind = 'auto_time_exit'; why = '보유 ' + days + '거래일 기간 청산 ' + (h.pnlPct >= 0 ? '+' : '') + h.pnlPct + '%'; }
      else if (boxMap && boxMap[h.code] && boxMap[h.code].sellSig && inExit) { kind = 'auto_box_sell'; why = '박스권 저항 익절 ' + (h.pnlPct >= 0 ? '+' : '') + h.pnlPct + '%'; }
      if (kind) { log({ kind, name: h.name, pnl: h.pnlPct, days }); await order('sell', h.code, h.qty, { reason: why, src: 'auto' }); sold.add(h.code); }
    }
    if (!tradeWindow(A, now)) { log({ kind: 'auto_wait', msg: `설정된 매매 시간 아님 (오전 ${A.dayEntryFrom}부터 ${A.morningMinutes}분 / 오후 장 마감 ${A.afternoonMinutes}분 전부터)` }); return; }
    const sig = await signals(); const cand = candidates(sig);
    let list = cand.list, note = cand.note;
    if (A.signal === 'box') {
      // 1분봉 박스권: 유동성 상위 30종목 + 보유 종목을 스캔해 지지 반등 매수 후보만
      let uni = []; try { const ds = UNIVERSE_GET ? await UNIVERSE_GET() : null; uni = ((ds && ds.list) || []).filter(x => x.trdval && /KOSPI|KOSDAQ/.test(x.market) && !/스팩|SPAC|우$|우B$|리츠/.test(x.name)).sort((a, b) => b.trdval - a.trdval).slice(0, 30).map(x => ({ code: x.code, name: x.name })); } catch (e) {}
      const names = {}; uni.forEach(x => { names[x.code] = x.name; }); bal.holdings.forEach(h => { names[h.code] = h.name; });
      const syms = [...new Set([...bal.holdings.map(h => h.code), ...uni.map(x => x.code)])];
      const bs = await MB.scan(syms, names);
      list = bs.filter(b => b.buySig).map(b => ({ code: b.code, name: b.name || b.code, price: b.price, trdval: 0, _s: A.buyScoreMin, _why: ['1분봉 박스권', '지지 ' + b.support + '·저항 ' + b.resistance + '·폭 ' + b.boxPct + '%', '지지 반등'] }));
      note = `박스권 스캔 ${bs.length}종목 → 지지 반등 ${list.length}`;
      log({ kind: 'auto_boxscan', note });
    }
    log({ kind: 'auto_scan', note, vix: sig.vix, n: list.length });
    const held = new Set(bal.holdings.filter(h => !sold.has(h.code)).map(h => h.code));
    sold.forEach(c => held.add(c)); // 같은 날 판 종목은 다시 사지 않음
    let blocked = [];
    if (C.auto.skipLosers) { blocked = J.losers(C.auto.loserMinSells || 2, C.auto.loserBlockDays == null ? 30 : C.auto.loserBlockDays).filter(o => !o.released).map(o => o.code); if (blocked.length) log({ kind: 'auto_skip_losers', codes: blocked }); }
    const blockedSet = new Set(blocked);
    for (const c of list) {
      if (blockedSet.has(c.code)) { log({ kind: 'auto_skip', name: c.name, code: c.code, why: '손실 반복 종목 제외' }); continue; }
      if (state.buys >= C.auto.maxBuysPerDay) break;
      if (held.size - sold.size >= C.auto.maxHoldings) break;
      if (held.has(c.code)) continue;
      const budget = Math.floor(bal.cash * C.auto.positionPct / 100);
      if (budget < 10000) break;
      let px = c.price; if (!px) { const p = await price(c.code); px = Number(p.output?.stck_prpr || 0); }
      const qty = Math.floor(budget / Number(px)); if (qty < 1) continue;
      log({ kind: 'auto_buy', name: c.name, code: c.code, score: c._s, why: c._why, qty });
      await order('buy', c.code, qty, { reason: '자동 매수[' + ({ swing: '스윙', short: '단기', day: '당일' }[mode]) + '] · ' + (c._why || []).join('·') + ' (점수 ' + c._s + ')', src: 'auto', tag: mode, bt: Number(px) || null });
      state.buys++; held.add(c.code);
    }
  } catch (e) { log({ kind: 'auto_error', msg: String(e && e.message || e) }); }
  finally { running = false; }
}

// ── 라우팅 ──────────────────────────────────
function pinOK(req, sp) {
  const hdr = req.headers['x-trade-pin'] || '';
  const q = sp.get('pin') || '';
  const p = String(hdr || q);
  if (!C.pin) return { ok: false, code: 'no_pin', msg: '트레이딩 PIN이 설정되지 않았습니다. 먼저 PIN을 저장하세요.' };
  return p === C.pin ? { ok: true } : { ok: false, code: 'bad_pin', msg: 'PIN이 올바르지 않습니다.' };
}
function readBody(req) { return new Promise(res => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e5) req.destroy(); }); req.on('end', () => res(d)); }); }
function jres(res, obj, code) { res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

async function handle(req, res, url) {
  const sp = new URL(req.url, 'http://x').searchParams;

  if (url === '/api/kis/status') {
    return jres(res, {
      configured: !!(C.appKey && C.account), env: C.env, hasPin: !!C.pin, dry: C.dry,
      allowLive: C.allowLive, orderType: C.orderType, excgId: C.excgId,
      account: C.account ? C.account.slice(0, 4) + '****' : '', profiles: profileStatus(), auto: C.auto, autoRunning: C.auto.on,
    });
  }

  // 최초 PIN 설정(아직 PIN 없을 때만 허용)
  if (url === '/api/kis/setup') {
    const b = JSON.parse((await readBody(req)) || '{}');
    if (C.pin) { const c = pinOK(req, sp); if (!c.ok) return jres(res, { ok: false, msg: c.msg }, 403); }
    if (b.pin) C.pin = String(b.pin);
    if (running) return jres(res, { ok:false, msg:'자동매매 점검 중입니다. 잠시 후 다시 저장하세요.' }, 409);
    const switched = updateProfile(b);
    if (!switched && typeof b.dry === 'boolean') C.dry = b.dry;
    if (!switched && typeof b.allowLive === 'boolean') C.allowLive = b.allowLive;
    if (b.orderType) C.orderType = b.orderType;
    if (b.excgId) C.excgId = b.excgId;
    if (b.auto && !switched) Object.assign(C.auto, b.auto);
    save();
    return jres(res, { ok: true, configured: !!(C.appKey && C.account), env: C.env, dry: C.dry, switched, msg: switched ? '계좌 환경 변경: 자동매매 꺼짐 · 주문 미전송으로 전환했습니다.' : '선택한 환경의 키·계좌를 저장했습니다.' });
  }

  // 이하 PIN 필요 (단, PIN을 아직 만들지 않았다면 매매일지 조회·CSV는 허용 — 주문 기능은 계속 차단)
  const c = pinOK(req, sp);
  if (!c.ok && !((url === '/api/kis/journal' || url === '/api/kis/bench') && c.code === 'no_pin')) return jres(res, { ok: false, msg: c.msg }, 403);

  if (url === '/api/kis/balance') {
    try { const b = await balance(); return jres(res, { ok: true, ...b }); }
    catch (e) { return jres(res, { ok: false, msg: String(e && e.message || e) }); }
  }
  if (url === '/api/kis/order') {
    const side = sp.get('side'), code = (sp.get('code') || '').trim(), qty = Number(sp.get('qty'));
    if (sp.get('expectedEnv') && sp.get('expectedEnv') !== C.env) return jres(res, { ok:false, msg:'계좌 환경이 변경되었습니다. 확인 후 다시 주문하세요.' }, 409);
    if (!['buy', 'sell'].includes(side) || !/^[0-9A-Z]{6}$/.test(code) || !Number.isInteger(qty) || qty < 1) return jres(res, { ok: false, msg: '종목코드 6자리와 수량(양의 정수)을 확인하세요.' });
    try { const o = await order(side, code, qty); return jres(res, { ok: o.rt_cd === '0' || o.dry, dry: !!o.dry, raw: { rc: o.rt_cd, msg: o.msg1, odno: o.output?.ODNO } }); }
    catch (e) { return jres(res, { ok: false, msg: String(e && e.message || e) }); }
  }
  if (url === '/api/kis/auto') {
    if (sp.get('on') != null) { C.auto.on = sp.get('on') === '1'; save(); log({ kind: 'auto_toggle', on: C.auto.on }); }
    const extra = {}; ['buyScoreMin', 'positionPct', 'maxHoldings', 'maxBuysPerDay', 'stopLossPct', 'takeProfitPct', 'loopSeconds', 'maxCandidates', 'universeTop', 'loserMinSells', 'loserBlockDays'].forEach(k => { if (sp.get(k) != null) extra[k] = Number(sp.get(k)); });
    if (sp.get('requireVix30') != null) extra.requireVix30 = sp.get('requireVix30') === '1';
    if (sp.get('skipLosers') != null) extra.skipLosers = sp.get('skipLosers') === '1';
    ['holdDays', 'rsiMax', 'newsMin'].forEach(k => { if (sp.get(k) != null) extra[k] = Math.max(0, Math.min(20, Number(sp.get(k)) || 0)); });
    if (sp.get('rsiBuy') != null) extra.rsiBuy = sp.get('rsiBuy') === '1';
    if (['score', 'trend'].includes(sp.get('signal'))) extra.signal = sp.get('signal');
    if (['off', 'basic', 'strong'].includes(sp.get('regime'))) extra.regime = sp.get('regime');
    if (COMBO[sp.get('combo')]) extra.combo = sp.get('combo');
    ['dayEntryFrom', 'dayEntryTo', 'dayExitAt', 'comboFrom', 'comboTo'].forEach(k => { const v = sp.get(k); if (v && /^\d{1,2}:\d{2}$/.test(v)) extra[k] = v; });
    for (const k of ['morningMinutes', 'afternoonMinutes']) {
      if (sp.has(k)) { const n = Number(sp.get(k)); if (!Number.isInteger(n) || n < 1 || n > 180) return jres(res, { ok: false, msg: '매매 지속 시간은 1~180분의 정수로 설정하세요.' }, 400); extra[k] = n; }
    }
    for (const k of ['dayEntryFrom', 'dayExitAt']) {
      if (extra[k] && (hm(extra[k]) < 540 || hm(extra[k]) > 930 || Number(extra[k].split(':')[1]) > 59)) return jres(res, { ok: false, msg: '시작 시각은 09:00~15:30 범위로 설정하세요.' }, 400);
    }
    if (sp.get('stopAnytime') != null) extra.stopAnytime = sp.get('stopAnytime') === '1' ? 1 : 0;
    const md = sp.get('mode');
    if (md && MODE_PRESET[md]) { extra.mode = md; if (sp.get('preset') === '1') Object.assign(extra, MODE_PRESET[md]); }
    Object.keys(extra).forEach(k => { if (typeof extra[k] === 'number' && !isFinite(extra[k])) delete extra[k]; });
    if (extra.holdDays != null) extra.holdDays = Math.max(0, Math.min(60, Math.round(extra.holdDays)));
    if (Object.keys(extra).length) { Object.assign(C.auto, extra); save(); }
    const warn = C.auto.rsiBuy && !rsiAllowed() ? 'RSI 매수는 스윙 + 보유 10~20거래일일 때만 동작합니다. 지금 설정에서는 꺼진 상태로 동작합니다.' : '';
    return jres(res, { ok: true, auto: C.auto, rsiAllowed: rsiAllowed(), warn });
  }
  if (url === '/api/kis/once') { try { await autoTick(); return jres(res, { ok: true, log: LOGS.slice(-12) }); } catch (e) { return jres(res, { ok: false, msg: String(e && e.message || e) }); } }
  if (url === '/api/kis/journal') {
    const q0 = new URL(req.url, 'http://x').searchParams;
    if (q0.get('view') === 'monthly') return jres(res, { ok: true, monthly: J.monthly(), losers: J.losers(2, C.auto.loserBlockDays == null ? 30 : C.auto.loserBlockDays), blockDays: C.auto.loserBlockDays });
    if (q0.get('csv') === 'monthly') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="monthly-report.csv"', 'Cache-Control': 'no-store' }); return res.end(J.monthlyCsv()); }
    const sp2 = new URL(req.url, 'http://x').searchParams;
    if (sp2.get('csv') === '1') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="trade-journal.csv"', 'Cache-Control': 'no-store' }); return res.end(J.csv()); }
    return jres(res, { ok: true, ...J.summary() });
  }
  if (url === '/api/kis/boxlist') {
    let uni = [];
    try { const ds = UNIVERSE_GET ? await UNIVERSE_GET() : null; uni = ((ds && ds.list) || []).filter(x => x.trdval && /KOSPI|KOSDAQ/.test(x.market) && !/스팩|SPAC|우$|우B$|리츠/.test(x.name)).sort((a, b) => b.trdval - a.trdval).slice(0, 30).map(x => ({ code: x.code, name: x.name })); } catch (e) {}
    if (!uni.length) return jres(res, { ok: false, msg: '종목 목록(KRX)을 못 받았습니다' });
    const names = {}; uni.forEach(x => { names[x.code] = x.name; });
    const rows = await MB.scan(uni.map(x => x.code), names, { max: 30 });
    rows.sort((a, b) => (b.buySig - a.buySig) || (a.boxPct - b.boxPct));
    return jres(res, { ok: true, rows, at: new Date().toISOString() });
  }
  if (url === '/api/kis/bench') { let gc = null; try { gc = await cached('gcbt', async () => { const ds = await cached('krxstocks', getKrxStocks, 3600e3).catch(() => ({}));
      const uni = (ds.list || []).filter(x => x.trdval && /KOSPI|KOSDAQ/.test(x.market) && !/스팩|SPAC|우$|우B$|리츠/.test(x.name)).sort((a, b) => b.trdval - a.trdval).slice(0, 200).map(x => ({ sym: x.code + (x.market === 'KOSDAQ' ? '.KQ' : '.KS'), name: x.name }));
      return GCBT.backtest(uni, { hold: 20, fee: 0.3 }); }, 12 * 3600e3).catch(() => null); } catch (e) {}
    const st = gc && gc.risk ? gc.risk.find(r => r.exposure === 100 && r.stop === -3) : null;
    return jres(res, { ok: true, rows: J.bench(), totals: J.totals(), gcExpect: st ? { total: st.total, mdd: st.mdd, stopRate: st.stopRate, sharpe: st.sharpe, periods: gc.n, hold: gc.hold, from: gc.from, to: gc.to } : null }); }
  if (url === '/api/kis/log') { return jres(res, { ok: true, log: LOGS.slice(-60) }); }

  return jres(res, { ok: false, msg: 'unknown' }, 404);
}

let timer = null;
function startLoop() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { autoTick().catch(() => {}); }, Math.max(30, C.auto.loopSeconds || 60) * 1000);
  timer.unref && timer.unref();
}
startLoop();

module.exports = { init, handle, startLoop, setUniverse, _t: { C, updateProfile, profileStatus, autoTick, comboTick, resetCombo: () => { comboDay = ''; }, candidates, rsiAllowed, bizDaysSince, tradeWindow, sessionWindows, MODE_PRESET } };
