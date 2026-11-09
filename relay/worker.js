// rooru.invest 실시간 시세 중계 (Cloudflare Worker, 무료)
// 한국: 네이버 증권 실시간 · 미국·지수·선물(CL=F)·환율(KRW=X): 야후 파이낸스 1분봉 · 차트 봉(?bars=종목&i=1m|5m|15m|60m|1d|1wk): 야후 파이낸스 (한국 분봉 최근 6거래일은 네이버)
// 정해진 두 곳만 대신 불러오고, rooru.invest 앱 주소에서만 읽을 수 있다 (아무 주소나 대신 여는 중계가 아님).
// 개인 정보는 오가지 않는다: 앱이 보내는 것은 종목 코드뿐.

const APP_ORIGIN = "https://odh2838-art.github.io";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const KR_INDEX = { "^KS11": "KOSPI", "^KQ11": "KOSDAQ" };

// 위쪽 서버 호출: 5초 안에 답이 없으면 끊고, 429·5xx는 '잠깐 못 받음'으로 던진다 (없는 종목(null)과 구분해 저장하지 않게)
async function up(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (r.status === 429 || r.status >= 500) { const e = new Error("upstream " + r.status); e.up = true; throw e; }
  return r.json();
}
const NAV_H = { "User-Agent": UA, "Referer": "https://m.stock.naver.com/" }, YH_H = { "User-Agent": UA };
const num = v => { const x = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(x) && x !== 0 ? x : null; };

async function naver(sym) {
  const idx = KR_INDEX[sym];
  const url = idx ? `https://polling.finance.naver.com/api/realtime/domestic/index/${idx}`
                  : `https://polling.finance.naver.com/api/realtime/domestic/stock/${sym.split(".")[0]}`;
  const x = ((await up(url, NAV_H)).datas || [])[0];
  if (!x) return null;
  const p = num(x.closePrice);
  if (!p) return null;
  const t = x.localTradedAt || new Date().toISOString();
  return { p, o: num(x.openPrice), h: num(x.highPrice), l: num(x.lowPrice), v: num(x.accumulatedTradingVolume),
           d: t.slice(0, 10), t, st: x.marketStatus || "" };
}

// 한국 종목 여러 개를 한 번에 (요청 수 절약). 장이 닫혀 있으면 네이버 시세 값이 NXT 시간외(~20:00) 가격으로 바뀌어서
// 한국거래소 종가와 달라진다 (10/20 삼성전자 209,000 vs 거래소 211,500) → 그때는 1분봉 정규장 마지막 봉(15:30)을 종가로.
async function naverMany(syms) {
  const codes = syms.map(s => s.split(".")[0]), out = {};
  for (const x of ((await up(`https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(",")}`, NAV_H)).datas || [])) {
    const s = syms[codes.indexOf(String(x.itemCode || ""))], p = num(x.closePrice);
    if (!s || !p) continue;
    const t = x.localTradedAt || new Date().toISOString();
    out[s] = { p, o: num(x.openPrice), h: num(x.highPrice), l: num(x.lowPrice), v: num(x.accumulatedTradingVolume), tv: num(x.accumulatedTradingValueRaw), d: t.slice(0, 10), t, st: x.marketStatus || "" };
  }
  return out;
}
// 그날 15:30 마감 봉 하나만 받음 (응답이 작아서 여러 종목도 가벼움). 없으면 null
// 수능 날은 10:00~16:30 (엔진 app.py KR_LATE와 같게, 해마다 추가)
const KR_LATE = ["20261119"];
const krClose = day => KR_LATE.includes(day) ? "1630" : "1530";
// 지금(한국 시간)이 거래소 정규장 안인지. 정규장 밖이면 네이버 값이 NXT 프리·애프터마켓(08:00~20:00) 가격이라 'OPEN'이어도 거래소 종가를 씀 (10/22 확인: 18:31에 OPEN·NXT 가격)
function krRegular() {
  const now = new Date(Date.now() + 9 * 3600e3), day = now.toISOString().slice(0, 10).replace(/-/g, ""), hm = now.toISOString().slice(11, 16).replace(":", "");
  if (!(now.getUTCDay() % 6)) return false;
  return hm >= (KR_LATE.includes(day) ? "1000" : "0900") && hm < krClose(day);
}
async function close1530(code, day) {
  const hm = krClose(day);
  const xs = await up(`https://api.stock.naver.com/chart/domestic/item/${code}/minute?startDateTime=${day}${hm}&endDateTime=${day}${hm}`, NAV_H);
  const x = Array.isArray(xs) ? xs.find(y => String(y.localDateTime || "").slice(0, 12) === day + hm) : null;
  return x ? num(x.currentPrice) : null;
}
// 장이 닫혀 있을 때 한국 종목들의 거래소 종가: 마지막 거래일을 첫 종목으로 찾고 (오늘 15:30 뒤면 오늘, 아니면 그 전 평일들), 나머지는 그날 것만
async function krxCloses(qs) {
  const ks = Object.keys(qs); if (!ks.length) return;
  const now = new Date(Date.now() + 9 * 3600e3), ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
  const cand = []; const d = new Date(now), today = ymd(now);
  if (now.toISOString().slice(11, 16).replace(":", "") <= krClose(today)) d.setUTCDate(d.getUTCDate() - 1);
  while (cand.length < 3) { if (d.getUTCDay() % 6) cand.push(ymd(d)); d.setUTCDate(d.getUTCDate() - 1); }
  let day = null;
  for (const c of cand) { const p = await close1530(ks[0].split(".")[0], c).catch(() => null); if (p) { day = c; set(ks[0], p, c); break; } }
  if (!day) return;
  await Promise.all(ks.slice(1, 25).map(async s => { const p = await close1530(s.split(".")[0], day).catch(() => null); if (p) set(s, p, day); }));
  function set(s, p, c) { const q = qs[s], dd = `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6)}`;
    Object.assign(q, { p, d: dd, t: `${dd}T${krClose(c).slice(0, 2)}:${krClose(c).slice(2)}:00+09:00`, st: "CLOSE", h: q.d === dd && q.h ? Math.max(q.h, p) : p, l: q.d === dd && q.l ? Math.min(q.l, p) : p, src: "krx" });
    if (q.d !== dd) { q.o = p; q.v = null; q.tv = null; } }
}

async function yahoo(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
  const res = (await up(url, YH_H))?.chart?.result?.[0];
  if (!res) return null;
  const m = res.meta, q = res.indicators?.quote?.[0] || {};
  const tz = m.exchangeTimezoneName || "America/New_York";
  const when = new Date((m.regularMarketTime || Date.now() / 1000) * 1000);
  return { p: m.regularMarketPrice, o: (q.open || []).find(v => v != null) ?? null, h: m.regularMarketDayHigh ?? null,
           l: m.regularMarketDayLow ?? null, v: m.regularMarketVolume ?? null, prev: m.chartPreviousClose ?? m.previousClose ?? null,
           d: when.toLocaleDateString("en-CA", { timeZone: tz }), t: when.toISOString() };
}

// 지수의 오늘 흐름 (5분 간격): 시장 카드의 장중 선. [장 시작 뒤 몇 분, 값]
async function intraday(sym) {
  const res = (await up(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`, YH_H))?.chart?.result?.[0];
  if (!res || !res.timestamp) return null;
  const c = res.indicators?.quote?.[0]?.close || [], t0 = res.timestamp[0];
  const pts = res.timestamp.map((t, i) => [Math.round((t - t0) / 60), c[i]]).filter(p => p[1] != null).map(p => [p[0], +p[1].toFixed(2)]);
  return { pts, prev: res.meta?.chartPreviousClose ?? null, start: new Date(t0 * 1000).toISOString() };
}

// 차트 봉: [시각(초), 시가, 고가, 저가, 종가, 거래량]. 간격마다 받을 기간 (야후 한도 안: 1분봉 7일, 5·15분봉 60일, 1시간봉 730일)
const RANGE = Object.freeze(Object.assign(Object.create(null), { "1m": "5d", "5m": "1mo", "15m": "1mo", "60m": "6mo", "1d": "2y", "1wk": "10y" }));
const STEP = Object.freeze(Object.assign(Object.create(null), { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 }));

// 한국 분봉: 야후는 15:00~15:30 (마감 동시호가 포함, 하루 거래량의 15~20%)이 빠져서, 최근 6거래일은 네이버 1분봉으로 채운다.
// 네이버 분봉은 최근 6거래일만 주고 시간외(15:40~20:00)도 섞여 있어서, 정규장 09:00~15:30만 남기고 간격에 맞게 묶는다.
async function naverBars(sym, iv) {
  const step = STEP[iv]; if (!step) return null;
  const code = sym.split(".")[0], kst = d => new Date(d.getTime() + 9 * 3600e3).toISOString().replace(/\D/g, "").slice(0, 8);
  const now = new Date(), from = kst(new Date(now.getTime() - 14 * 864e5)), to = kst(now);
  const xs = await up(`https://api.stock.naver.com/chart/domestic/item/${code}/minute?startDateTime=${from}0000&endDateTime=${to}2359`, NAV_H);
  if (!Array.isArray(xs) || !xs.length) return null;
  const out = [];
  for (const x of xs) {
    const s = String(x.localDateTime || ""), hm = s.slice(8, 12);
    if (s.length < 12 || hm < "0900" || hm > "1530") continue;
    const o = num(x.openPrice), h = num(x.highPrice), l = num(x.lowPrice), c = num(x.currentPrice);
    if (!c || !h || !l) continue;
    const t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)) / 1000 - 9 * 3600;
    const k = Math.floor((t + 9 * 3600) / step) * step - 9 * 3600, v = Number(x.accumulatedTradingVolume) || 0, last = out[out.length - 1];
    if (last && last[0] === k) { last[2] = Math.max(last[2], h); last[3] = Math.min(last[3], l); last[4] = c; last[5] += v; }
    else out.push([k, o || c, h, l, c, v]);
  }
  return out.length ? out : null;
}
const kstDay = t => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);

async function bars(sym, iv) {
  const out = await yahooBars(sym, iv);
  if (!/\.(KS|KQ)$/.test(sym) || !STEP[iv]) return out;
  let nv = null; try { nv = await naverBars(sym, iv); } catch (e) { nv = null; }
  if (!nv) return out;
  const days = new Set(nv.map(x => kstDay(x[0])));   // 네이버가 있는 날은 네이버로, 그 전 날은 야후로
  const old = (out?.rows || []).filter(x => !days.has(kstDay(x[0])) && x[0] < nv[0][0]);
  return { tz: "Asia/Seoul", prev: out?.prev ?? null, iv, src: "naver", rows: old.concat(nv) };
}

async function yahooBars(sym, iv) {
  const range = RANGE[iv] || "1d";
  const res = (await up(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${range}&includePrePost=false`, YH_H))?.chart?.result?.[0];
  if (!res || !res.timestamp) return null;
  const q = res.indicators?.quote?.[0] || {};
  const rows = res.timestamp.map((t, i) => [t, q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i], q.volume?.[i]])
    .filter(x => x[4] != null && x[2] != null && x[3] != null).slice(-3000);
  return { tz: res.meta?.exchangeTimezoneName || "", prev: res.meta?.chartPreviousClose ?? null, iv, rows };
}

// 같은 요청은 잠깐 저장해 두고 다시 씀 (시세 20초 · 봉 60초): 여러 번 눌러도 위쪽 서버를 매번 부르지 않게 (무료 한도 보호)
// (workers.dev 주소에서는 Cache API가 동작하지 않을 수 있어서, 같은 실행 환경 안의 메모리 저장도 함께 씀)
const MEM = new Map();
async function cached(key, ttl, make, ctx) {
  const m = MEM.get(key);
  if (m && Date.now() - m.at < ttl * 1000) return m.body;
  if (m) MEM.delete(key);
  const cache = typeof caches !== "undefined" ? caches.default : null, k = new Request("https://cache.rooru.invest/" + key);
  const hit = cache ? await cache.match(k).catch(() => null) : null;
  if (hit) return hit.text();
  const body = await make();
  MEM.set(key, { at: Date.now(), body }); if (MEM.size > 600) MEM.delete(MEM.keys().next().value);
  if (cache) ctx?.waitUntil?.(cache.put(k, new Response(body, { headers: { "Cache-Control": `public, max-age=${ttl}`, "Content-Type": "application/json" } })).catch(() => {}));
  return body;
}

// 한국 종목은 6자리.KS/.KQ, 그 외는 야후 심볼(지수 ^GSPC · 선물 CL=F · 환율 KRW=X)
const symOk = s => /^\d{6}\.(KS|KQ)$/.test(s) || /^\^?[A-Z][A-Z0-9.-]{0,14}(=[FX])?$/.test(s);

export default {
  async fetch(req, env, ctx) {
    const cors = { "Access-Control-Allow-Origin": APP_ORIGIN, "Vary": "Origin", "Cache-Control": "no-store",
                   "Content-Type": "application/json; charset=utf-8" };
    const origin = req.headers.get("Origin");
    if (origin !== APP_ORIGIN) return new Response("null", { status: 403, headers: cors });   // 앱 주소에서 온 요청만 (Origin 없는 비브라우저 요청도 거절)
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") || "", "Access-Control-Max-Age": "86400" } });
    if (req.method !== "GET") return new Response("null", { status: 405, headers: cors });
    const u = new URL(req.url);
    const b = (u.searchParams.get("bars") || "").trim().toUpperCase(), iq = u.searchParams.get("i") || "1m", iv = Object.hasOwn(RANGE, iq) ? iq : "1m";
    if (b) {
      if (!symOk(b)) return new Response("null", { status: 400, headers: cors });
      const body = await cached(`bars/${b}/${iv}`, 60, async () => { let out = null; try { out = await bars(b, iv); } catch (e) { out = null; } return JSON.stringify(out); }, ctx);
      return new Response(body, { headers: cors });
    }
    const syms = (u.searchParams.get("s") || "").split(",").map(s => s.trim().toUpperCase())
      .filter(symOk).slice(0, 40);
    const uniq = [...new Set(syms)].sort();
    if (!uniq.length) return new Response("{}", { headers: cors });
    // 종목별로 20초 저장: 어떤 조합으로 물어봐도 이미 받은 종목은 다시 안 받음
    const now = Date.now(), out = {}, need = [];
    for (const s of uniq) { const m = MEM.get("q1/" + s); if (m && now - m.at < 20000) out[s] = m.v; else need.push(s); }
    if (need.length) {
      try { const { out: got, errs } = await quotes(need);
        for (const s of need) { out[s] = got[s] ?? null; if (!errs.has(s)) { MEM.set("q1/" + s, { at: now, v: out[s] }); if (MEM.size > 600) MEM.delete(MEM.keys().next().value); } } }   // 위쪽이 잠깐 못 준 건 저장하지 않음
      catch (e) { for (const s of need) out[s] = out[s] ?? null; }   // 서브요청 한도 등으로 터져도 빈 값
    }
    return new Response(JSON.stringify(out), { headers: cors });
  },
};

async function quotes(syms) {
    const out = {}, errs = new Set(), kr = syms.filter(s => /\.(KS|KQ)$/.test(s));
    if (kr.length) {
      let m = {}; try { m = await naverMany(kr); } catch (e) { m = {}; kr.forEach(s => errs.add(s)); }
      const shut = {};
      const reg = krRegular();
      for (const s of kr) { out[s] = m[s] || null; if (out[s] && (!reg || out[s].st !== "OPEN")) shut[s] = out[s]; }
      try { await krxCloses(shut); } catch (e) {}
    }
    await Promise.all(syms.filter(s => !kr.includes(s)).map(async s => {
      try {
        out[s] = KR_INDEX[s] ? await naver(s) : await yahoo(s);
        if (out[s] && s.startsWith("^") && ["^GSPC", "^KS11", "^KQ11", "^IXIC", "^VIX", "^TNX"].includes(s)) { try { out[s].day = await intraday(s); } catch (e) {} }   // 장중 선은 앱이 쓰는 지수만
      } catch (e) { out[s] = null; if (e && e.up || e?.name === "TimeoutError") errs.add(s); }
    }));
    return { out, errs };
}
