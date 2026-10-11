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

const CFG_PATH = path.join(__dirname, 'kis-config.json');
const LOG_FILE = path.join(__dirname, 'autotrade-log.jsonl');

const DEFAULTS = {
  env: 'demo', appKey: '', appSecret: '', account: '', product: '01',
  pin: '', dry: true, allowLive: false, orderType: 'market', excgId: 'KRX',
  auto: { on: false, buyScoreMin: 3, requireVix30: false, positionPct: 10,
    maxHoldings: 5, maxBuysPerDay: 3, stopLossPct: -5, takeProfitPct: 10,
    loopSeconds: 60, universeTop: 200, maxCandidates: 5 },
};
let C = JSON.parse(JSON.stringify(DEFAULTS));
try {
  const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  Object.assign(C, j); C.auto = Object.assign({}, DEFAULTS.auto, j.auto || {});
} catch (e) {}
// 환경변수가 있으면 그 값이 우선 (파일에는 저장하지 않음)
if (process.env.KIS_APP_KEY) C.appKey = process.env.KIS_APP_KEY;
if (process.env.KIS_APP_SECRET) C.appSecret = process.env.KIS_APP_SECRET;
if (process.env.KIS_ACCOUNT) C.account = String(process.env.KIS_ACCOUNT).replace(/[^0-9]/g, '');
if (process.env.KIS_PRODUCT) C.product = process.env.KIS_PRODUCT;
if (process.env.KIS_ENV) C.env = process.env.KIS_ENV;
if (process.env.TRADE_PIN) C.pin = process.env.TRADE_PIN;

function save() { try { fs.writeFileSync(CFG_PATH, JSON.stringify(C, null, 2)); } catch (e) {} }

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
async function order(side, code, qty) {
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
  if (C.dry) { log({ kind: 'dry_order', side, code, qty }); return { dry: true, msg: 'DRY-RUN: 주문 미전송', body }; }
  const j = await kis('POST', '/uapi/domestic-stock/v1/trading/order-cash', trId, body);
  log({ kind: 'order', side, code, qty, rc: j.rt_cd, odno: j.output?.ODNO, msg: j.msg1 });
  return j;
}

// ── 신호 → 후보 ─────────────────────────────
async function signals() {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/krxscan`);
  const j = await r.json();
  if (j.loading) throw new Error('앱이 전 종목 스캔을 계산 중입니다.');
  return j;
}
function candidates(sig) {
  const A = C.auto, W = { gc: 2, hm: 2, rsiO: 1, rsiW: 1, top: 1 };
  const map = {};
  (sig.turning || []).forEach(x => { (map[x.code] = map[x.code] || { ...x }).gc = true; });
  (sig.hammer || []).forEach(x => { (map[x.code] = map[x.code] || { ...x }).hm = true; });
  let rows = Object.values(map);
  const byVal = [...rows].sort((a, b) => (b.trdval || 0) - (a.trdval || 0));
  const topN = new Set(byVal.slice(0, Math.max(1, Math.round(A.universeTop / 10))).map(x => x.code));
  if (A.requireVix30 && !(sig.vix != null && sig.vix >= 30)) return { list: [], note: `VIX ${sig.vix ?? '--'} < 30 → 보류` };
  rows.forEach(x => {
    let s = 0; const why = [];
    if (x.gc) { s += W.gc; why.push('골든크로스'); }
    if (x.hm) { s += W.hm; why.push('망치형'); }
    if (x.rsi != null && x.rsi < 30) { s += W.rsiO; why.push('RSI' + x.rsi); } else if (x.rsi != null && x.rsi <= 50) { s += W.rsiW; why.push('RSI' + x.rsi); }
    if (topN.has(x.code)) { s += W.top; why.push('거래대금'); }
    x._s = s; x._why = why;
  });
  rows = rows.filter(x => x._s >= A.buyScoreMin).sort((a, b) => b._s - a._s || (b.trdval || 0) - (a.trdval || 0));
  return { list: rows.slice(0, A.maxCandidates), note: `${rows.length}개 후보` };
}
function inHours() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  const m = d.getHours() * 60 + d.getMinutes(); return m >= 9 * 60 && m <= 15 * 60 + 30;
}
let state = { day: '', buys: 0 };
let running = false;
async function autoTick() {
  if (running) return; if (!C.auto.on || !C.appKey || !C.account) return;
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) { state = { day: today, buys: 0 }; }
  if (!inHours()) { log({ kind: 'auto_wait', msg: '장 시간 아님' }); return; }
  running = true;
  try {
    const bal = await balance();
    for (const h of bal.holdings) {
      if (h.pnlPct <= C.auto.stopLossPct) { log({ kind: 'auto_stop_loss', name: h.name, pnl: h.pnlPct }); await order('sell', h.code, h.qty); }
      else if (h.pnlPct >= C.auto.takeProfitPct) { log({ kind: 'auto_take_profit', name: h.name, pnl: h.pnlPct }); await order('sell', h.code, h.qty); }
    }
    const sig = await signals(); const { list, note } = candidates(sig);
    log({ kind: 'auto_scan', note, vix: sig.vix, n: list.length });
    const held = new Set(bal.holdings.map(h => h.code));
    for (const c of list) {
      if (state.buys >= C.auto.maxBuysPerDay) break;
      if (held.size >= C.auto.maxHoldings) break;
      if (held.has(c.code)) continue;
      const budget = Math.floor(bal.cash * C.auto.positionPct / 100);
      if (budget < 10000) break;
      let px = c.price; if (!px) { const p = await price(c.code); px = Number(p.output?.stck_prpr || 0); }
      const qty = Math.floor(budget / Number(px)); if (qty < 1) continue;
      log({ kind: 'auto_buy', name: c.name, code: c.code, score: c._s, why: c._why, qty });
      await order('buy', c.code, qty);
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
      account: C.account ? C.account.slice(0, 4) + '****' : '', auto: C.auto, autoRunning: C.auto.on,
    });
  }

  // 최초 PIN 설정(아직 PIN 없을 때만 허용)
  if (url === '/api/kis/setup') {
    const b = JSON.parse((await readBody(req)) || '{}');
    if (C.pin) { const c = pinOK(req, sp); if (!c.ok) return jres(res, { ok: false, msg: c.msg }, 403); }
    if (b.pin) C.pin = String(b.pin);
    if (b.appKey) C.appKey = String(b.appKey).trim();
    if (b.appSecret) C.appSecret = String(b.appSecret).trim();
    if (b.account) C.account = String(b.account).replace(/[^0-9]/g, '');
    if (b.product) C.product = String(b.product).trim();
    if (b.env) C.env = (b.env === 'real' ? 'real' : 'demo');
    if (typeof b.dry === 'boolean') C.dry = b.dry;
    if (typeof b.allowLive === 'boolean') C.allowLive = b.allowLive;
    if (b.orderType) C.orderType = b.orderType;
    if (b.excgId) C.excgId = b.excgId;
    if (b.auto) Object.assign(C.auto, b.auto);
    save();
    return jres(res, { ok: true, configured: !!(C.appKey && C.account), env: C.env, dry: C.dry });
  }

  // 이하 PIN 필요
  const c = pinOK(req, sp);
  if (!c.ok) return jres(res, { ok: false, msg: c.msg }, 403);

  if (url === '/api/kis/balance') {
    try { const b = await balance(); return jres(res, { ok: true, ...b }); }
    catch (e) { return jres(res, { ok: false, msg: String(e && e.message || e) }); }
  }
  if (url === '/api/kis/order') {
    const side = sp.get('side'); const code = (sp.get('code') || '').replace(/[^0-9]/g, ''); const qty = parseInt(sp.get('qty') || '0', 10);
    if (!['buy', 'sell'].includes(side) || !code || qty < 1) return jres(res, { ok: false, msg: 'side/code/qty를 확인하세요.' });
    try { const o = await order(side, code, qty); return jres(res, { ok: o.rt_cd === '0' || o.dry, dry: !!o.dry, raw: { rc: o.rt_cd, msg: o.msg1, odno: o.output?.ODNO } }); }
    catch (e) { return jres(res, { ok: false, msg: String(e && e.message || e) }); }
  }
  if (url === '/api/kis/auto') {
    if (sp.get('on') != null) { C.auto.on = sp.get('on') === '1'; save(); log({ kind: 'auto_toggle', on: C.auto.on }); }
    const extra = {}; ['buyScoreMin', 'positionPct', 'maxHoldings', 'maxBuysPerDay', 'stopLossPct', 'takeProfitPct', 'loopSeconds', 'maxCandidates', 'universeTop'].forEach(k => { if (sp.get(k) != null) extra[k] = Number(sp.get(k)); });
    if (sp.get('requireVix30') != null) extra.requireVix30 = sp.get('requireVix30') === '1';
    if (Object.keys(extra).length) { Object.assign(C.auto, extra); save(); }
    return jres(res, { ok: true, auto: C.auto });
  }
  if (url === '/api/kis/once') { try { await autoTick(); return jres(res, { ok: true, log: LOGS.slice(-12) }); } catch (e) { return jres(res, { ok: false, msg: String(e && e.message || e) }); } }
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

module.exports = { init, handle, startLoop, _t: { C, autoTick } };
