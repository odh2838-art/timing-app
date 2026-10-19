// rooru.invest 실시간 시세 중계 (Cloudflare Worker, 무료)
// 한국: 네이버 증권 실시간 · 미국: 야후 파이낸스 1분봉 · 차트 봉(?bars=종목&i=1m|5m|15m|60m|1d|1wk): 야후 파이낸스 (한국 분봉 최근 6거래일은 네이버)
// 정해진 두 곳만 대신 불러오고, rooru.invest 앱 주소에서만 읽을 수 있다 (아무 주소나 대신 여는 중계가 아님).
// 개인 정보는 오가지 않는다: 앱이 보내는 것은 종목 코드뿐.

const APP_ORIGIN = "https://odh2838-art.github.io";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const KR_INDEX = { "^KS11": "KOSPI", "^KQ11": "KOSDAQ" };

const num = v => { const x = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(x) && x !== 0 ? x : null; };

async function naver(sym) {
  const idx = KR_INDEX[sym];
  const url = idx ? `https://polling.finance.naver.com/api/realtime/domestic/index/${idx}`
                  : `https://polling.finance.naver.com/api/realtime/domestic/stock/${sym.split(".")[0]}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, "Referer": "https://m.stock.naver.com/" } });
  const x = ((await r.json()).datas || [])[0];
  if (!x) return null;
  const p = num(x.closePrice);
  if (!p) return null;
  const t = x.localTradedAt || new Date().toISOString();
  return { p, o: num(x.openPrice), h: num(x.highPrice), l: num(x.lowPrice), v: num(x.accumulatedTradingVolume),
           d: t.slice(0, 10), t, st: x.marketStatus || "" };
}

async function yahoo(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const res = (await r.json())?.chart?.result?.[0];
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
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`, { headers: { "User-Agent": UA } });
  const res = (await r.json())?.chart?.result?.[0];
  if (!res || !res.timestamp) return null;
  const c = res.indicators?.quote?.[0]?.close || [], t0 = res.timestamp[0];
  const pts = res.timestamp.map((t, i) => [Math.round((t - t0) / 60), c[i]]).filter(p => p[1] != null).map(p => [p[0], +p[1].toFixed(2)]);
  return { pts, prev: res.meta?.chartPreviousClose ?? null, start: new Date(t0 * 1000).toISOString() };
}

// 차트 봉: [시각(초), 시가, 고가, 저가, 종가, 거래량]. 간격마다 받을 기간 (야후 한도 안: 1분봉 7일, 5·15분봉 60일, 1시간봉 730일)
const RANGE = { "1m": "5d", "5m": "1mo", "15m": "1mo", "60m": "6mo", "1d": "2y", "1wk": "10y" };
const STEP = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };

// 한국 분봉: 야후는 15:00~15:30 (마감 동시호가 포함, 하루 거래량의 15~20%)이 빠져서, 최근 6거래일은 네이버 1분봉으로 채운다.
// 네이버 분봉은 최근 6거래일만 주고 시간외(15:40~20:00)도 섞여 있어서, 정규장 09:00~15:30만 남기고 간격에 맞게 묶는다.
async function naverBars(sym, iv) {
  const step = STEP[iv]; if (!step) return null;
  const code = sym.split(".")[0], kst = d => new Date(d.getTime() + 9 * 3600e3).toISOString().replace(/\D/g, "").slice(0, 8);
  const now = new Date(), from = kst(new Date(now.getTime() - 14 * 864e5)), to = kst(now);
  const r = await fetch(`https://api.stock.naver.com/chart/domestic/item/${code}/minute?startDateTime=${from}0000&endDateTime=${to}2359`,
                        { headers: { "User-Agent": UA, "Referer": "https://m.stock.naver.com/" } });
  const xs = await r.json();
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
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${range}&includePrePost=false`, { headers: { "User-Agent": UA } });
  const res = (await r.json())?.chart?.result?.[0];
  if (!res || !res.timestamp) return null;
  const q = res.indicators?.quote?.[0] || {};
  const rows = res.timestamp.map((t, i) => [t, q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i], q.volume?.[i]])
    .filter(x => x[4] != null && x[2] != null && x[3] != null);
  return { tz: res.meta?.exchangeTimezoneName || "", prev: res.meta?.chartPreviousClose ?? null, iv, rows };
}

export default {
  async fetch(req) {
    const cors = { "Access-Control-Allow-Origin": APP_ORIGIN, "Vary": "Origin", "Cache-Control": "no-store",
                   "Content-Type": "application/json; charset=utf-8" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const u = new URL(req.url);
    const b = (u.searchParams.get("bars") || "").trim().toUpperCase(), iv = RANGE[u.searchParams.get("i")] ? u.searchParams.get("i") : "1m";
    if (b) {
      if (!/^\^?[A-Z0-9.-]{1,15}$/.test(b)) return new Response("null", { status: 400, headers: cors });
      let out = null;
      try { out = await bars(b, iv); } catch (e) { out = null; }
      return new Response(JSON.stringify(out), { headers: cors });
    }
    const syms = (u.searchParams.get("s") || "").split(",").map(s => s.trim().toUpperCase())
      .filter(s => /^\^?[A-Z0-9.-]{1,15}$/.test(s)).slice(0, 40);
    const out = {};
    await Promise.all(syms.map(async s => {
      try {
        out[s] = (/\.(KS|KQ)$/.test(s) || KR_INDEX[s]) ? await naver(s) : await yahoo(s);
        if (out[s] && s.startsWith("^")) { try { out[s].day = await intraday(s); } catch (e) {} }
      } catch (e) { out[s] = null; }
    }));
    return new Response(JSON.stringify(out), { headers: cors });
  },
};
