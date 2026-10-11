'use strict';
/** 코인 탭 — 거래량·상승·뉴스 조합 예상 상승 종목 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const CG = 'https://api.coingecko.com/api/v3';
const STABLE = new Set(['usdt','usdc','dai','fdusd','tusd','usdd','usde','busd','usdp','pyusd','usds','susds','usdt0','usd1','susd','frax','lusd','gusd','usdx','eurs','eurt','xaut','paxg','usd+','usdf','usdy','rlusd','usdz']);
const NOISE = /wrapped|staked|bridged|binance-peg|coinbase wrapped|wbeth|weth|wsteth|weeth|steth|reth|cbeth|meth|wbt|tether gold|pax gold/i;

const NEWS_FEEDS = [
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
  ['Decrypt', 'https://decrypt.co/feed'],
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
];
const POS = ['surge','soar','rally','jump','gain','rise','bull','breakout','approv','adopt','partnership','launch','upgrade','inflow','record','all-time high','ath','etf','institutional','accumulat','buyback','burn','listing','integration','expand','milestone','treasury','reserve','support'];
const NEG = ['hack','exploit','crash','plunge','dump','drop','fall','bear','lawsuit','sue','ban','delist','outflow','liquidat','phishing','stolen','fraud','scam','downgrade','halt','suspend','investigat','seize','bankrupt','warn','risk','vulnerab','attack'];

async function jget(url, tries) {
  tries = tries || 3;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await new Promise(s => setTimeout(s, 800)); }
  }
}
function sentiment(text) {
  const t = text.toLowerCase(); let s = 0;
  POS.forEach(w => { if (t.includes(w)) s++; });
  NEG.forEach(w => { if (t.includes(w)) s--; });
  return s;
}
function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  blocks.forEach(b => {
    const g = re => { const m = b.match(re); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : ''; };
    const title = g(/<title>([\s\S]*?)<\/title>/i);
    const desc = g(/<description>([\s\S]*?)<\/description>/i);
    const date = g(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    let link = g(/<link>([\s\S]*?)<\/link>/i);
    if (!/^https?:\/\//.test(link)) { const gm = b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i); const gv = gm ? gm[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; link = /^https?:\/\//.test(gv) ? gv : ''; }
    if (title) items.push({ title, desc: desc.slice(0, 300), date, link });
  });
  return items;
}
async function getNews() {
  const out = [];
  for (const [src, url] of NEWS_FEEDS) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!r.ok) continue;
      const xml = await r.text();
      parseRss(xml).slice(0, 40).forEach(it => out.push({ ...it, src, s: sentiment(it.title + ' ' + it.desc) }));
    } catch (e) {}
  }
  return out;
}
function matchCoins(item, coins) {
  const hay = (item.title + ' ' + item.desc).toLowerCase();
  const hit = [];
  coins.forEach(c => {
    const nm = c.name.toLowerCase();
    let ok = nm.length >= 4 && hay.includes(nm);
    if (!ok) { const sy = c.symbol.toLowerCase(); if (sy.length >= 3 && new RegExp('(^|[^a-z])' + sy.replace(/[^a-z0-9]/g, '') + '([^a-z]|$)').test(hay)) ok = true; }
    if (ok) hit.push(c.symbol.toUpperCase());
  });
  return hit;
}
function pct(arr, v) { if (!arr.length) return 0; let n = 0; arr.forEach(x => { if (v >= x) n++; }); return n / arr.length; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

let CACHE = { t: 0, v: null };
async function getCoinPicks() {
  if (CACHE.v && Date.now() - CACHE.t < 20 * 60e3) return CACHE.v;

  const markets = await jget(`${CG}/coins/markets?vs_currency=usd&order=volume_desc&per_page=200&page=1&price_change_percentage=24h,7d`);
  const clean = (markets || []).filter(m => !STABLE.has((m.symbol || '').toLowerCase()) && !NOISE.test(m.name || ''))
    .map(m => ({ id: m.id, symbol: m.symbol, name: m.name, price: m.current_price, mcap: m.market_cap,
      vol24h: m.total_volume, chg24h: m.price_change_percentage_24h_in_currency, chg7d: m.price_change_percentage_7d_in_currency }));

  // 후보: 24시간 거래대금 상위 25
  const cands = clean.filter(c => c.vol24h > 3e6).slice(0, 25);

  // 3~5일 거래량: 각 후보의 일별 거래량 합(최근 5일)
  const vol5 = [];
  for (let i = 0; i < cands.length; i += 5) {
    const batch = cands.slice(i, i + 5);
    const rs = await Promise.all(batch.map(async c => {
      try {
        const d = await jget(`${CG}/coins/${c.id}/market_chart?vs_currency=usd&days=7&interval=daily`, 2);
        const tv = (d.total_volumes || []).map(x => x[1]).filter(x => x != null);
        const last5 = tv.slice(-5);
        return { ...c, vol5d: last5.reduce((s, x) => s + x, 0), days: last5.length };
      } catch (e) { return { ...c, vol5d: c.vol24h * 5, days: 1, est: true }; }
    }));
    vol5.push(...rs);
  }
  const volTop = vol5.slice().sort((a, b) => (b.vol5d || 0) - (a.vol5d || 0)).slice(0, 10);

  // 상승 종목: 24시간 상승률 상위(거래대금 $10M 이상)
  const gainers = clean.filter(c => c.vol24h > 1e7 && c.chg24h != null)
    .sort((a, b) => b.chg24h - a.chg24h).slice(0, 10);

  // 뉴스
  const news = await getNews();
  const newsCoins = {};
  news.forEach(n => { n.coins = matchCoins(n, clean.slice(0, 120)); n.coins.forEach(sy => { const o = newsCoins[sy] || (newsCoins[sy] = { n: 0, s: 0, items: [] }); o.n++; o.s += n.s; if (o.items.length < 3) o.items.push({ t: n.title.slice(0, 110), src: n.src, s: n.s, link: n.link, date: n.date }); }); });

  // 예상 상승: 거래량 + 상승 + 뉴스 조합
  const pool = {};
  vol5.forEach(c => { pool[c.symbol] = { ...c }; });
  clean.slice(0, 120).forEach(c => { if (!pool[c.symbol]) pool[c.symbol] = { ...c }; });
  const list = Object.values(pool).filter(c => c.vol24h > 5e6);
  const vols = list.map(c => c.vol5d || c.vol24h).filter(Boolean);
  const m24 = list.map(c => c.chg24h).filter(x => x != null), m7 = list.map(c => c.chg7d).filter(x => x != null);
  const nc = list.map(c => (newsCoins[c.symbol.toUpperCase()] || {}).s || 0);
  const maxN = Math.max(1, ...nc.map(Math.abs));

  const W = { v: 15, m: 75, n: 10 };
  const pool2 = list.map(c => {
    const vS = pct(vols, c.vol5d || c.vol24h);
    const mS = 0.6 * pct(m24, c.chg24h) + 0.4 * pct(m7, c.chg7d);
    const nd = newsCoins[c.symbol.toUpperCase()] || { n: 0, s: 0, items: [] };
    const nS = clamp(nd.s / maxN, -1, 1);
    const why = [];
    if (vS > 0.7) why.push('5일 거래량 상위');
    if (c.chg24h != null && c.chg24h > 5) why.push('24h +' + c.chg24h.toFixed(1) + '%');
    if (c.chg7d != null && c.chg7d > 10) why.push('7일 +' + c.chg7d.toFixed(1) + '%');
    if (nd.n) why.push('뉴스 ' + nd.n + '건 ' + (nd.s > 0 ? '긍정' : nd.s < 0 ? '부정' : '중립'));
    return { id: c.id, symbol: c.symbol, name: c.name, price: c.price, vol24h: c.vol24h, vol5d: c.vol5d || null, chg24h: c.chg24h, chg7d: c.chg7d,
      comp: { v: +vS.toFixed(4), m: +mS.toFixed(4), n: +((nS + 1) / 2).toFixed(4) }, why, news: nd.n, newsS: nd.s, articles: nd.items };
  });
  const scoreOf = (c, w) => +(100 * (w.v * c.comp.v + w.m * c.comp.m + w.n * c.comp.n) / ((w.v + w.m + w.n) || 1)).toFixed(1);
  pool2.forEach(c => { c.score = scoreOf(c, W); });
  const picks = pool2.slice().sort((a, b) => b.score - a.score).slice(0, 10);
  const artBy = {}; pool2.forEach(c => { if (c.articles && c.articles.length) artBy[c.symbol.toUpperCase()] = c.articles; });
  const attach = c => Object.assign({}, c, { articles: artBy[c.symbol.toUpperCase()] || [] });

  const res = { updatedAt: new Date().toISOString(), source: 'CoinGecko + Cointelegraph/Decrypt/CoinDesk',
    weights: W, volTop: volTop.map(attach), gainers: gainers.map(attach), picks, pool: pool2.sort((a, b) => b.score - a.score),
    all: clean.slice(0, 200).map(c => ({ symbol: c.symbol, name: c.name, price: c.price, chg24h: c.chg24h, chg7d: c.chg7d, vol24h: c.vol24h })),
    newsCount: news.length,
    news: news.slice(0, 20).map(n => ({ t: n.title.slice(0, 120), src: n.src, s: n.s, link: n.link, date: n.date, coins: n.coins })) };
  CACHE = { t: Date.now(), v: res };
  return res;
}
module.exports = { getCoinPicks };
