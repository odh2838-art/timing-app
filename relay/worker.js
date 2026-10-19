// rooru.invest 실시간 시세 중계 (Cloudflare Worker, 무료)
// 한국: 네이버 증권 실시간 · 미국: 야후 파이낸스 1분봉 · 차트 봉(?bars=종목&i=1m|5m|15m|60m|1d|1wk): 야후 파이낸스
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
async function bars(sym, iv) {
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
