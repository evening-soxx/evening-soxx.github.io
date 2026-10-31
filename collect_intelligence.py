#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SOXX & RAM (DRAM) 반도체·거시경제(전쟁·유가·채권) 인텔리전스 수집 엔진
- 미국 ETF/종목/채권/유가/환율: CNBC Harmony & Quote API (레이트리밋 0%, 초고속)
- 한국 종목(삼성전자·SK하이닉스): 네이버 금융 차트 API (외국인 지분율 포함)
- Roundhill Memory ETF (DRAM): 일별 자금 유입(AUM/설정좌수) 및 보유 포트폴리오
- 글로벌 뉴스: Google News RSS (메모리·RAM, SOXX·AI, 전쟁·지정학, 유가·에너지, 채권·금리, 월가 영문속보)
"""

import json
import math
import os
import re
import ssl
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}

KST = timezone(timedelta(hours=9))


def http_get(url, timeout=10):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def fetch_cnbc_bars(cnbc_sym):
    now = datetime.now(KST)
    start_str = (now - timedelta(days=380)).strftime("%Y%m%d000000")
    end_str = (now + timedelta(days=2)).strftime("%Y%m%d000000")
    encoded = urllib.parse.quote(cnbc_sym)
    url = f"https://ts-api.cnbc.com/harmony/app/bars/{encoded}/1D/{start_str}/{end_str}/adjusted/EST5EDT.json"
    raw = http_get(url, timeout=10)
    data = json.loads(raw)
    bars = data.get("barData", {}).get("priceBars", [])
    candles = []
    for b in bars:
        try:
            c = float(b["close"])
            o = float(b.get("open", c))
            h = float(b.get("high", c))
            l = float(b.get("low", c))
            v = int(float(b.get("volume") or 0))
            tt = str(b.get("tradeTime", ""))[:8]
            if len(tt) == 8:
                dt = f"{tt[:4]}-{tt[4:6]}-{tt[6:8]}"
            else:
                continue
            candles.append({
                "date": dt,
                "open": round(o, 4),
                "high": round(h, 4),
                "low": round(l, 4),
                "close": round(c, 4),
                "volume": v,
            })
        except Exception:
            continue

    # Overlay live quote from CNBC real-time quote endpoint if newer
    try:
        q_url = f"https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols={encoded}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json"
        q_data = json.loads(http_get(q_url, timeout=6))
        fq = q_data.get("FormattedQuoteResult", {}).get("FormattedQuote", [{}])[0]
        last_str = str(fq.get("last", "")).replace(",", "").replace("%", "").strip()
        prev_str = str(fq.get("previous_day_closing", "")).replace(",", "").replace("%", "").strip()
        if last_str and candles:
            last_val = float(last_str)
            candles[-1]["close"] = round(last_val, 4)
            if last_val > candles[-1]["high"]:
                candles[-1]["high"] = round(last_val, 4)
            if last_val < candles[-1]["low"]:
                candles[-1]["low"] = round(last_val, 4)
            if prev_str and len(candles) >= 2:
                prev_val = float(prev_str)
                # PRE_MKT(정규장 개장 전)에는 previous_day_closing이 전일 종가(last_val)와 동일하게 내려오므로 덮어쓰지 않음
                if abs(prev_val - last_val) > 1e-4:
                    candles[-2]["close"] = round(prev_val, 4)
    except Exception:
        pass

    return candles


def fetch_naver_domestic_bars(code):
    now = datetime.now(KST)
    start_str = (now - timedelta(days=380)).strftime("%Y%m%d0000")
    end_str = (now + timedelta(days=1)).strftime("%Y%m%d2359")
    url = f"https://api.stock.naver.com/chart/domestic/item/{code}/day?startDateTime={start_str}&endDateTime={end_str}"
    raw = http_get(url, timeout=10)
    rows = json.loads(raw)
    candles = []
    foreign_rate = None
    for r in rows:
        ld = str(r.get("localDate", ""))
        if len(ld) == 8:
            dt = f"{ld[:4]}-{ld[4:6]}-{ld[6:8]}"
        else:
            continue
        c = float(r["closePrice"])
        o = float(r.get("openPrice", c))
        h = float(r.get("highPrice", c))
        l = float(r.get("lowPrice", c))
        v = int(r.get("accumulatedTradingVolume", 0))
        if r.get("foreignRetentionRate") is not None:
            foreign_rate = float(r["foreignRetentionRate"])
        candles.append({
            "date": dt,
            "open": round(o, 2),
            "high": round(h, 2),
            "low": round(l, 2),
            "close": round(c, 2),
            "volume": v,
        })

    # 네이버 실시간 폴링 API로 KRX 정규장 공식 종가 및 전일대비 등락 보정 (NXT 시간외 혼선 방지)
    try:
        rt_url = f"https://polling.finance.naver.com/api/realtime/domestic/stock/{code}"
        rt_data = json.loads(http_get(rt_url, timeout=6))
        d = (rt_data.get("datas") or [{}])[0]
        close_str = str(d.get("closePrice", "")).replace(",", "").strip()
        diff_str = str(d.get("compareToPreviousClosePrice", "")).replace(",", "").strip()
        if close_str and candles:
            close_val = float(close_str)
            candles[-1]["close"] = round(close_val, 2)
            if close_val > candles[-1]["high"]:
                candles[-1]["high"] = round(close_val, 2)
            if close_val < candles[-1]["low"]:
                candles[-1]["low"] = round(close_val, 2)
            if diff_str and len(candles) >= 2:
                diff_val = float(diff_str)
                prev_krx = close_val - diff_val
                if prev_krx > 0:
                    candles[-2]["close"] = round(prev_krx, 2)
    except Exception:
        pass

    return candles, foreign_rate


def calc_sma(values, period):
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def calc_rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50.0
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [max(0.0, d) for d in deltas]
    losses = [max(0.0, -d) for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100.0 - (100.0 / (1.0 + rs)), 1)


def calc_atr_pct(candles, period=20):
    if len(candles) < period + 1:
        return 0.0
    trs = []
    for i in range(-period, 0):
        cur = candles[i]
        prev_close = candles[i - 1]["close"]
        tr = max(
            cur["high"] - cur["low"],
            abs(cur["high"] - prev_close),
            abs(cur["low"] - prev_close),
        )
        if cur["close"] > 0:
            trs.append((tr / cur["close"]) * 100.0)
    return round(sum(trs) / len(trs), 2) if trs else 0.0


def calc_return(closes, days_ago):
    if len(closes) <= days_ago or closes[-1 - days_ago] == 0:
        if len(closes) >= 2 and closes[0] > 0:
            return round(((closes[-1] - closes[0]) / closes[0]) * 100.0, 2)
        return 0.0
    return round(((closes[-1] - closes[-1 - days_ago]) / closes[-1 - days_ago]) * 100.0, 2)


def calc_weighted_rs_raw(closes):
    if not closes:
        return 0.0
    r_3m = calc_return(closes, min(63, len(closes) - 1))
    r_6m = calc_return(closes, min(126, len(closes) - 1))
    r_9m = calc_return(closes, min(189, len(closes) - 1))
    r_12m = calc_return(closes, min(250, len(closes) - 1))
    return 0.4 * r_3m + 0.2 * r_6m + 0.2 * r_9m + 0.2 * r_12m


def analyze_ticker(info):
    symbol = info["symbol"]
    foreign_rate = None
    if symbol.endswith(".KS"):
        code = symbol.replace(".KS", "")
        candles, foreign_rate = fetch_naver_domestic_bars(code)
    else:
        cnbc_sym = info.get("cnbc_symbol", symbol)
        candles = fetch_cnbc_bars(cnbc_sym)

    if not candles:
        raise ValueError(f"No candles for {symbol}")

    closes = [c["close"] for c in candles]
    highs = [c["high"] for c in candles]
    lows = [c["low"] for c in candles]

    last_close = closes[-1]
    prev_close = closes[-2] if len(closes) >= 2 else last_close
    chg = last_close - prev_close
    chg_pct = (chg / prev_close * 100.0) if prev_close else 0.0

    sma20 = calc_sma(closes, 20)
    sma50 = calc_sma(closes, 50)
    sma150 = calc_sma(closes, 150)
    sma200 = calc_sma(closes, 200)
    sma200_prev20 = calc_sma(closes[:-20], 200) if len(closes) > 220 else None

    high_52w = max(highs) if highs else last_close
    low_52w = min(lows) if lows else last_close
    pos_52w = ((last_close - low_52w) / (high_52w - low_52w) * 100.0) if high_52w > low_52w else 50.0
    from_high_pct = ((last_close - high_52w) / high_52w * 100.0) if high_52w else 0.0

    # MTT (Mark Minervini Trend Template) 5대 조건 (신규상장 ETF 등은 가용 이평선 기준 보정)
    mtt_c1 = bool(sma50 and last_close > sma50)
    mtt_c2 = bool((sma50 and sma150 and sma50 > sma150) or (sma20 and sma50 and not sma150 and sma20 > sma50))
    mtt_c3 = bool((sma150 and sma200 and sma150 > sma200) or (sma50 and not sma200 and last_close > sma50))
    mtt_c4 = bool((sma200 and sma200_prev20 and sma200 > sma200_prev20) or (sma50 and not sma200 and last_close > sma50))
    mtt_c5 = bool(high_52w and last_close >= high_52w * 0.80)
    mtt_score = sum([mtt_c1, mtt_c2, mtt_c3, mtt_c4, mtt_c5])
    mtt_pass = (mtt_score == 5)

    recent_20 = candles[-20:]
    support_20d = min(c["low"] for c in recent_20)
    resistance_20d = max(c["high"] for c in recent_20)

    rsi14 = calc_rsi(closes, 14)
    atr_pct = calc_atr_pct(candles, 20)

    ret_1w = calc_return(closes, 5)
    ret_1m = calc_return(closes, 21)
    ret_3m = calc_return(closes, 63)
    ret_6m = calc_return(closes, 126)
    ret_1y = calc_return(closes, min(250, len(closes) - 1))
    rs_raw = calc_weighted_rs_raw(closes)

    decimals = 3 if info.get("unit") == "%" else (0 if info.get("currency") == "KRW" else 2)

    return {
        **info,
        "price": round(last_close, decimals),
        "prev_close": round(prev_close, decimals),
        "change": round(chg, decimals),
        "change_pct": round(chg_pct, 2),
        "high_52w": round(high_52w, decimals),
        "low_52w": round(low_52w, decimals),
        "pos_52w": round(pos_52w, 1),
        "from_high_pct": round(from_high_pct, 2),
        "is_new_high": from_high_pct >= -1.8,
        "sma20": round(sma20, decimals) if sma20 else None,
        "sma50": round(sma50, decimals) if sma50 else None,
        "sma150": round(sma150, decimals) if sma150 else None,
        "sma200": round(sma200, decimals) if sma200 else None,
        "above_sma20": bool(sma20 and last_close >= sma20),
        "above_sma50": bool(sma50 and last_close >= sma50),
        "above_sma200": bool(sma200 and last_close >= sma200) if sma200 else bool(sma50 and last_close >= sma50),
        "mtt_pass": mtt_pass,
        "mtt_score": mtt_score,
        "rsi14": rsi14,
        "atr_pct": atr_pct,
        "support_20d": round(support_20d, decimals),
        "resistance_20d": round(resistance_20d, decimals),
        "ret_1w": ret_1w,
        "ret_1m": ret_1m,
        "ret_3m": ret_3m,
        "ret_6m": ret_6m,
        "ret_1y": ret_1y,
        "rs_raw": round(rs_raw, 2),
        "foreign_rate": foreign_rate,
        "latest_date": candles[-1]["date"],
        "history": candles[-90:],
    }


def fetch_dram_etf_flow():
    try:
        raw = http_get("https://stockeasy.intellio.kr/stockdata/api/v1/memory-prices/dram-etf/overview", timeout=8)
        d = json.loads(raw)
        series = d.get("series", [])[-60:]
        holdings = d.get("holdings", [])
        shares_now = d.get("current_shares", 0)
        shares_1d = series[-2]["shares_outstanding"] if len(series) >= 2 else shares_now
        shares_5d = series[-6]["shares_outstanding"] if len(series) >= 6 else shares_now
        shares_20d = series[-21]["shares_outstanding"] if len(series) >= 21 else shares_now
        nav_now = d.get("current_nav", 50.0) or (series[-2].get("nav") if len(series) >= 2 else 50.0) or 50.0
        inflow_1d_usd = (shares_now - shares_1d) * nav_now
        inflow_5d_usd = (shares_now - shares_5d) * nav_now
        inflow_20d_usd = (shares_now - shares_20d) * nav_now

        clean_holdings = []
        for h in holdings:
            nm = str(h.get("name", ""))
            tk = str(h.get("ticker", ""))
            is_mm = bool(h.get("is_money_market", False))
            if is_mm or "Treasury Bill" in nm or "Government Obligations" in nm or "Cash" in nm or tk in ("KRW", "CNY", "TWD"):
                continue
            clean_holdings.append({
                "ticker": tk,
                "name": nm,
                "weight": round(float(h.get("weight", 0.0)), 2),
                "market_value": round(float(h.get("market_value", 0.0)), 0),
                "is_money_market": False,
            })

        return {
            "ticker": "DRAM",
            "fund_name": d.get("fund_name", "Roundhill Memory ETF"),
            "inception_date": d.get("inception_date", "2026-04-02"),
            "latest_date": d.get("latest_date", ""),
            "current_aum": d.get("current_aum", 0.0),
            "current_shares": shares_now,
            "shares_change_1d": shares_now - shares_1d,
            "current_nav": nav_now,
            "current_price": d.get("current_price", 0.0),
            "premium_discount_pct": round(((d.get("current_price", nav_now) - nav_now) / nav_now) * 100.0, 2) if nav_now else 0.0,
            "inflow_1d_usd": round(inflow_1d_usd, 0),
            "inflow_5d_usd": round(inflow_5d_usd, 0),
            "inflow_20d_usd": round(inflow_20d_usd, 0),
            "series": series,
            "holdings": clean_holdings,
        }
    except Exception as e:
        print("DRAM ETF flow fallback:", e)
        return None


def fetch_google_rss(query, category, lang="ko", limit=10):
    q_with_time = f"{query} when:1d" if "when:" not in query else query
    encoded = urllib.parse.quote(q_with_time)
    if lang == "ko":
        url = f"https://news.google.com/rss/search?q={encoded}&hl=ko&gl=KR&ceid=KR:ko"
    else:
        url = f"https://news.google.com/rss/search?q={encoded}&hl=en-US&gl=US&ceid=US:en"

    items = []
    try:
        xml_text = http_get(url, timeout=8)
        root = ET.fromstring(xml_text)
        for item in root.findall(".//item"):
            title = item.findtext("title", "").strip()
            link = item.findtext("link", "").strip()
            pub_date = item.findtext("pubDate", "").strip()
            source_el = item.find("source")
            source = source_el.text.strip() if source_el is not None and source_el.text else "Global News"

            if " - " in title:
                parts = title.rsplit(" - ", 1)
                if len(parts[1]) < 28:
                    title = parts[0].strip()
                    if source == "Global News":
                        source = parts[1].strip()

            dt_str = pub_date
            ts = 0
            try:
                from email.utils import parsedate_to_datetime
                dt_obj = parsedate_to_datetime(pub_date).astimezone(KST)
                dt_str = dt_obj.strftime("%m.%d %H:%M")
                ts = dt_obj.timestamp()
            except Exception:
                pass

            items.append({
                "title": title,
                "link": link,
                "source": source,
                "date": dt_str,
                "timestamp": ts,
                "category": category,
                "lang": lang,
            })
        items.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
        items = items[:limit]
    except Exception as e:
        print(f"RSS Error [{category}]: {e}")
    return items


def fetch_cnbc_queryly(query, category, limit=8):
    items = []
    try:
        encoded = urllib.parse.quote(query)
        url = f"https://api.queryly.com/cnbc/json.aspx?queryly_key=31a35d40a9a64ab3&query={encoded}&endindex=0&batchsize={limit}&sort=date"
        raw = http_get(url, timeout=8)
        data = json.loads(raw)
        for r in data.get("results", []):
            title = str(r.get("cn:title") or r.get("title") or "").strip()
            link = str(r.get("url") or r.get("cn:liveURL") or "#").strip()
            pub_iso = str(r.get("datePublished") or r.get("cn:lastPubDate") or "").strip()
            if not title or not pub_iso:
                continue
            ts = 0
            dt_str = pub_iso[:16]
            try:
                dt_obj = datetime.fromisoformat(pub_iso.replace("Z", "+00:00")).astimezone(KST)
                dt_str = dt_obj.strftime("%m.%d %H:%M")
                ts = dt_obj.timestamp()
            except Exception:
                pass
            items.append({
                "title": title,
                "link": link,
                "source": "CNBC Live",
                "date": dt_str,
                "timestamp": ts,
                "category": category,
                "lang": "en",
            })
    except Exception as e:
        print(f"CNBC Queryly Error [{category}]: {e}")
    return items


def main():
    print("🚀 SOXX & RAM (DRAM) 반도체·매크로 인텔리전스 수집 시작...")

    etf_defs = [
        {
            "symbol": "SOXX",
            "cnbc_symbol": "SOXX",
            "display_ticker": "SOXX",
            "name_kr": "iShares 미국 반도체 ETF",
            "name_en": "iShares Semiconductor ETF",
            "role": "비메모리 · AI 가속기 · 반도체 장비 본진",
            "currency": "USD",
            "leverage": "1X 현물",
            "expense_ratio": "0.35%",
            "description": "엔비디아·브로드컴·AMD·마이크론·어플라이드·램리서치 등 미국 상장 핵심 반도체 30개 종목에 투자하는 대표 벤치마크 ETF입니다.",
        },
        {
            "symbol": "SOXL",
            "cnbc_symbol": "SOXL",
            "display_ticker": "SOXL",
            "name_kr": "Direxion 반도체 3배 레버리지 ETF",
            "name_en": "Direxion Daily Semiconductor Bull 3X Shares",
            "role": "미국 반도체 지수(SOXX 계열) 일간 3배 레버리지",
            "currency": "USD",
            "leverage": "3X 레버리지",
            "expense_ratio": "0.76%",
            "description": "NYSE 반도체 지수(ICESEMI)의 일간 수익률 300%를 추종하는 3배 레버리지 ETF입니다. SOXX 구성 종목과 거의 동일한 포트폴리오를 3배 탄력으로 추종합니다.",
        },
        {
            "symbol": "RAM",
            "cnbc_symbol": "RAM",
            "display_ticker": "RAM",
            "name_kr": "T-REX 2X 롱 DRAM 데일리 타깃 ETF",
            "name_en": "Roundhill T-REX 2X Long DRAM Daily Target ETF",
            "role": "글로벌 메모리(DRAM) 일간 2배 레버리지",
            "currency": "USD",
            "leverage": "2X 레버리지",
            "expense_ratio": "1.50%",
            "description": "Roundhill Memory ETF(DRAM)의 일간 수익률 200%를 추종하는 2배 레버리지 ETF입니다. 삼성전자·SK하이닉스·마이크론 3대장의 탄력을 극대화합니다.",
        },
        {
            "symbol": "DRAM",
            "cnbc_symbol": "DRAM",
            "display_ticker": "DRAM",
            "name_kr": "Roundhill 글로벌 메모리 ETF (RAM 모펀드)",
            "name_en": "Roundhill Memory ETF",
            "role": "RAM의 기초자산 · 삼성전자·SK하이닉스·마이크론 집중",
            "currency": "USD",
            "leverage": "1X 원지수",
            "expense_ratio": "0.59%",
            "description": "RAM이 추종하는 모(母)펀드로, 삼성전자·SK하이닉스·마이크론(MU) 등 글로벌 HBM·DRAM·NAND 메모리 핵심 기업에 직접 투자합니다.",
        },
    ]

    etfs = []
    for ed in etf_defs:
        try:
            etfs.append(analyze_ticker(ed))
            print(f"  ✓ ETF 수집 완료: {ed['symbol']} (${etfs[-1]['price']}, {etfs[-1]['change_pct']:+.2f}%)")
        except Exception as e:
            print(f"  ✗ ETF 수집 실패: {ed['symbol']} -> {e}")

    holding_defs = [
        {"symbol": "005930.KS", "display_ticker": "005930", "name_kr": "삼성전자", "name_en": "Samsung Electronics", "etf_group": "RAM·DRAM 핵심", "sub_sector": "HBM · DRAM · 파운드리", "currency": "KRW", "dram_weight": 25.82, "soxx_weight": 0.0, "note": "DRAM ETF 보유 최상위(현물+스왑 약 25.8%). HBM3E/HBM4 및 범용 DRAM·낸드 글로벌 최대 생산능력 보유"},
        {"symbol": "000660.KS", "display_ticker": "000660", "name_kr": "SK하이닉스", "name_en": "SK hynix", "etf_group": "RAM·DRAM 핵심", "sub_sector": "HBM · 고대역폭 메모리 1위", "currency": "KRW", "dram_weight": 21.82, "soxx_weight": 0.0, "note": "DRAM ETF 핵심 축(현물+스왑 약 21.8%). 엔비디아향 HBM 핵심 공급사로 메모리 영업이익률 선도"},
        {"symbol": "MU", "cnbc_symbol": "MU", "display_ticker": "MU", "name_kr": "마이크론 테크놀로지", "name_en": "Micron Technology", "etf_group": "SOXX + RAM 교집합", "sub_sector": "미국 유일 HBM · DRAM · NAND", "currency": "USD", "dram_weight": 27.87, "soxx_weight": 5.45, "note": "SOXX와 RAM(DRAM 현물+스왑 합산 약 27.9%) 양쪽 모두의 핵심 축. 미국 장중 RAM 가격을 움직이는 1순위 동력"},
        {"symbol": "SNDK", "cnbc_symbol": "SNDK", "display_ticker": "SNDK", "name_kr": "샌디스크", "name_en": "SanDisk Corporation", "etf_group": "RAM·DRAM 핵심", "sub_sector": "NAND 플래시 · AI 데이터센터 eSSD", "currency": "USD", "dram_weight": 4.36, "soxx_weight": 0.0, "note": "DRAM ETF 핵심 편입(4.36%). 웨스턴디지털에서 분사한 순수 NAND 플래시 및 AI 서버용 엔터프라이즈 SSD 전문 기업"},
        {"symbol": "WDC", "cnbc_symbol": "WDC", "display_ticker": "WDC", "name_kr": "웨스턴디지털", "name_en": "Western Digital", "etf_group": "RAM·DRAM 핵심", "sub_sector": "데이터센터 대용량 HDD · 스토리지", "currency": "USD", "dram_weight": 3.62, "soxx_weight": 0.0, "note": "샌디스크(NAND) 분사 이후 AI 클라우드·하이퍼스케일 데이터센터용 초고용량 스토리지에 집중"},
        {"symbol": "STX", "cnbc_symbol": "STX", "display_ticker": "STX", "name_kr": "씨게이트", "name_en": "Seagate Technology", "etf_group": "RAM·DRAM 연관", "sub_sector": "AI 데이터센터 대용량 스토리지", "currency": "USD", "dram_weight": 4.11, "soxx_weight": 0.0, "note": "DRAM ETF 편입(4.11%). 클라우드·AI 데이터센터 니어라인(HAMR) 스토리지 과점 공급사"},
        {"symbol": "042700.KS", "display_ticker": "042700", "name_kr": "한미반도체", "name_en": "HANMI Semiconductor", "etf_group": "RAM·DRAM 연관", "sub_sector": "HBM TC본더 후공정 장비 1위", "currency": "KRW", "dram_weight": 0.0, "soxx_weight": 0.0, "note": "SK하이닉스·마이크론향 HBM3E/HBM4 적층용 듀얼 TC본더 글로벌 독점적 공급사"},
        {"symbol": "NVDA", "cnbc_symbol": "NVDA", "display_ticker": "NVDA", "name_kr": "엔비디아", "name_en": "NVIDIA", "etf_group": "SOXX 핵심", "sub_sector": "AI GPU 가속기 · 데이터센터", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 9.15, "note": "SOXX 최상위 비중. HBM 메모리의 최대 수요처이자 글로벌 AI 투자 사이클의 나침반"},
        {"symbol": "AVGO", "cnbc_symbol": "AVGO", "display_ticker": "AVGO", "name_kr": "브로드컴", "name_en": "Broadcom", "etf_group": "SOXX 핵심", "sub_sector": "AI 맞춤형 칩(ASIC) · 네트워킹", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 8.85, "note": "구글·메타·빅테크 맞춤형 AI 가속기(XPU) 및 데이터센터 초고속 네트워킹 1위"},
        {"symbol": "AMD", "cnbc_symbol": "AMD", "display_ticker": "AMD", "name_kr": "AMD", "name_en": "Advanced Micro Devices", "etf_group": "SOXX 핵심", "sub_sector": "AI 가속기(MI시리즈) · 서버 CPU", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 7.40, "note": "엔비디아 대항마 MI 시리즈 AI GPU 및 EPYC 데이터센터 CPU 점유율 확대"},
        {"symbol": "QCOM", "cnbc_symbol": "QCOM", "display_ticker": "QCOM", "name_kr": "퀄컴", "name_en": "Qualcomm", "etf_group": "SOXX 핵심", "sub_sector": "온디바이스 AI · 모바일/PC 칩", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 6.10, "note": "스마트폰·AI PC·전장용 스냅드래곤 플랫폼 선도, 모바일 LPDDR 수요와 직결"},
        {"symbol": "TXN", "cnbc_symbol": "TXN", "display_ticker": "TXN", "name_kr": "텍사스 인스트루먼트", "name_en": "Texas Instruments", "etf_group": "SOXX 핵심", "sub_sector": "아날로그 · 산업/자동차용 반도체", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 5.80, "note": "글로벌 실물 경기와 산업·자동차 재고 사이클을 가장 먼저 보여주는 아날로그 반도체 대표주"},
        {"symbol": "MRVL", "cnbc_symbol": "MRVL", "display_ticker": "MRVL", "name_kr": "마벨 테크놀로지", "name_en": "Marvell Technology", "etf_group": "SOXX 핵심", "sub_sector": "광통신 DSP · 커스텀 AI 칩", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 3.45, "note": "AI 데이터센터 내부 초고속 광연결(Optical DSP) 및 클라우드 맞춤형 실리콘 강자"},
        {"symbol": "INTC", "cnbc_symbol": "INTC", "display_ticker": "INTC", "name_kr": "인텔", "name_en": "Intel", "etf_group": "SOXX 핵심", "sub_sector": "x86 CPU · 미국 파운드리", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 3.80, "note": "미국 반도체 공급망 지원(CHIPS Act)의 핵심 수혜주이자 서버/PC CPU 기본 축"},
        {"symbol": "NXPI", "cnbc_symbol": "NXPI", "display_ticker": "NXPI", "name_kr": "NXP 세미컨덕터", "name_en": "NXP Semiconductors", "etf_group": "SOXX 핵심", "sub_sector": "차량용 전장 · 산업용 MCU", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 3.20, "note": "전기차·자율주행 차량용 반도체 및 보안 칩 글로벌 핵심 기업"},
        {"symbol": "MPWR", "cnbc_symbol": "MPWR", "display_ticker": "MPWR", "name_kr": "모놀리식 파워 시스템즈", "name_en": "Monolithic Power Systems", "etf_group": "SOXX 핵심", "sub_sector": "AI 서버 전력관리 반도체(PMIC)", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 2.95, "note": "고전력 AI GPU 서버와 HBM 전력 효율을 제어하는 고마진 전력관리 칩 선도"},
        {"symbol": "ON", "cnbc_symbol": "ON", "display_ticker": "ON", "name_kr": "온세미컨덕터", "name_en": "ON Semiconductor", "etf_group": "SOXX 핵심", "sub_sector": "SiC 전력반도체 · 이미지센서", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 2.40, "note": "전기차·에너지 인프라용 실리콘 카바이드(SiC) 전력반도체 핵심 공급사"},
        {"symbol": "TSM", "cnbc_symbol": "TSM", "display_ticker": "TSM", "name_kr": "TSMC", "name_en": "Taiwan Semiconductor", "etf_group": "SOXX 핵심", "sub_sector": "파운드리 독점 · CoWoS 패키징", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 4.25, "note": "엔비디아·AMD AI 칩과 HBM을 하나로 묶는 CoWoS 첨단 패키징 독점 파운드리 (대만 해협 지정학 핵심)"},
        {"symbol": "ASML", "cnbc_symbol": "ASML", "display_ticker": "ASML", "name_kr": "ASML", "name_en": "ASML Holding", "etf_group": "SOXX 핵심", "sub_sector": "EUV 극자외선 노광장비 독점", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 3.90, "note": "선단 파운드리와 차세대 1c/1d DRAM 미세공정에 필수적인 EUV 장비 전 세계 독점 공급"},
        {"symbol": "AMAT", "cnbc_symbol": "AMAT", "display_ticker": "AMAT", "name_kr": "어플라이드 머티어리얼즈", "name_en": "Applied Materials", "etf_group": "SOXX 핵심", "sub_sector": "반도체 전공정 증착·식각 장비 1위", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 4.90, "note": "HBM TSV(실리콘관통전극) 및 GAA 공정 전환 수혜를 입는 세계 최대 반도체 장비사"},
        {"symbol": "LRCX", "cnbc_symbol": "LRCX", "display_ticker": "LRCX", "name_kr": "램리서치", "name_en": "Lam Research", "etf_group": "SOXX 핵심", "sub_sector": "메모리 식각 · HBM TSV 핵심 장비", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 4.55, "note": "삼성전자·SK하이닉스·마이크론의 HBM 적층 식각 및 고단화 NAND 투자에 가장 민감한 장비주"},
        {"symbol": "KLAC", "cnbc_symbol": "KLAC", "display_ticker": "KLAC", "name_kr": "KLA 코퍼레이션", "name_en": "KLA Corporation", "etf_group": "SOXX 핵심", "sub_sector": "반도체 수율 계측 · 검사 장비 1위", "currency": "USD", "dram_weight": 0.0, "soxx_weight": 4.30, "note": "초미세 공정과 HBM 적층 수율 확보를 위한 웨이퍼 검사·계측 장비 독보적 1위"},
    ]

    holdings = []
    for hd in holding_defs:
        try:
            holdings.append(analyze_ticker(hd))
            print(f"  ✓ 보유종목 수집 완료: {hd['display_ticker']:6s} ({hd['name_kr']}) -> {holdings[-1]['price']} ({holdings[-1]['change_pct']:+.2f}%)")
        except Exception as e:
            print(f"  ✗ 보유종목 수집 실패: {hd['display_ticker']} -> {e}")

    all_for_rs = holdings + etfs
    sorted_raw = sorted(x["rs_raw"] for x in all_for_rs)
    n_total = len(sorted_raw)
    for item in all_for_rs:
        rank = sum(1 for v in sorted_raw if v <= item["rs_raw"])
        item["rs_score"] = min(99, max(1, int(round((rank / max(1, n_total)) * 99))))

    macro_defs = [
        {
            "symbol": "US10Y",
            "cnbc_symbol": "US10Y",
            "id": "us10y",
            "name_kr": "미국 10년물 국채금리",
            "category": "채권 · 금리",
            "unit": "%",
            "warn_above": 5.00,
            "caution_above": 4.50,
            "impact_desc": "5.0% 돌파 시 기술주·레버리지(RAM) 밸류에이션 압박 확대 / 안정 시 반도체 멀티플 확장",
        },
        {
            "symbol": "US5Y",
            "cnbc_symbol": "US5Y",
            "id": "us5y",
            "name_kr": "미국 5년물 국채금리",
            "category": "채권 · 금리",
            "unit": "%",
            "warn_above": 4.80,
            "caution_above": 4.30,
            "impact_desc": "연준(Fed) 중기 통화정책 기대감과 기업 회사채 조달 금리의 기준점",
        },
        {
            "symbol": "TLT",
            "cnbc_symbol": "TLT",
            "id": "tlt",
            "name_kr": "미국 장기국채 ETF (TLT)",
            "category": "채권 · 가격",
            "unit": "$",
            "warn_above": 999,
            "caution_above": 999,
            "impact_desc": "TLT 반등(금리 하락) 시 SOXX·RAM에 우호적 유동성 환경 조성",
        },
        {
            "symbol": "WTI",
            "cnbc_symbol": "@CL.1",
            "id": "wti",
            "name_kr": "WTI 서부텍사스 원유",
            "category": "유가 · 에너지",
            "unit": "$",
            "warn_above": 100.0,
            "caution_above": 90.0,
            "impact_desc": "$100 상회 시 인플레이션 재점화 및 금리 인하 지연·파운드리 전력비 부담 자극",
        },
        {
            "symbol": "BRENT",
            "cnbc_symbol": "@LCO.1",
            "id": "brent",
            "name_kr": "브렌트유 (국제 유가)",
            "category": "유가 · 지정학",
            "unit": "$",
            "warn_above": 105.0,
            "caution_above": 92.0,
            "impact_desc": "중동 호르무즈 해협·홍해 분쟁 등 지정학적 전쟁 리스크의 즉각적 바로미터",
        },
        {
            "symbol": "GOLD",
            "cnbc_symbol": "@GC.1",
            "id": "gold",
            "name_kr": "국제 금 선물 (안전자산)",
            "category": "전쟁 · 안전자산",
            "unit": "$",
            "warn_above": 99999,
            "caution_above": 99999,
            "impact_desc": "급등 시 지정학 긴장(전쟁·관세) 또는 화폐가치 헤지 수요 유입 신호",
        },
        {
            "symbol": "VIX",
            "cnbc_symbol": ".VIX",
            "id": "vix",
            "name_kr": "VIX 변동성 (공포지수)",
            "category": "시장 위험도",
            "unit": "pt",
            "warn_above": 25.0,
            "caution_above": 20.0,
            "impact_desc": "20 이하 시 2배 레버리지(RAM) 보유 양호 / 25 이상 급등 시 변동성 끌림(음의 복리) 경계",
        },
        {
            "symbol": "USDKRW",
            "cnbc_symbol": "KRW=",
            "id": "usdkrw",
            "name_kr": "달러/원 환율",
            "category": "환율 · 외국인 수급",
            "unit": "원",
            "warn_above": 1400.0,
            "caution_above": 1360.0,
            "impact_desc": "환율 안정/하락 시 삼성전자·SK하이닉스로 외국인 현물 순매수 강도 강화",
        },
    ]

    macros = []
    for md in macro_defs:
        try:
            item = analyze_ticker(md)
            val = item["price"]
            if val >= md["warn_above"]:
                status = "경계"
                status_code = "warn"
            elif val >= md["caution_above"]:
                status = "주의 관찰"
                status_code = "caution"
            else:
                status = "안정"
                status_code = "good"
            item["status"] = status
            item["status_code"] = status_code
            macros.append(item)
            print(f"  ✓ 매크로 수집 완료: {md['name_kr']} ({val}{md['unit']})")
        except Exception as e:
            print(f"  ✗ 매크로 수집 실패: {md['name_kr']} -> {e}")

    dram_flow = fetch_dram_etf_flow()

    news_queries = [
        ("(SK하이닉스 OR 삼성전자 OR 마이크론 OR HBM OR 샌디스크 OR 한미반도체 OR D램) 반도체 when:1d", "메모리 · RAM", "ko", 12),
        ("(엔비디아 OR 브로드컴 OR TSMC OR AMD OR 인텔 OR 필라델피아반도체 OR 마벨 OR ASML) when:1d", "SOXX · AI반도체", "ko", 12),
        ("(중동 OR 이란 OR 호르무즈 OR 대만 해협 OR 트럼프 관세 OR 수출통제) when:1d", "전쟁 · 지정학", "ko", 8),
        ("(국제유가 OR WTI OR 브렌트유 OR 원유) when:1d", "유가 · 에너지", "ko", 8),
        ("(미국 국채 OR 연준 OR FOMC OR 금리 OR 국고채 OR 환율) when:1d", "채권 · 금리", "ko", 8),
        ("(SOXX OR NVIDIA OR Micron OR Intel OR AMD OR TSMC OR Broadcom OR HBM) semiconductor when:1d", "월가 영문속보", "en", 10),
    ]

    all_news = []
    seen_titles = set()
    for q, cat, lang, lim in news_queries:
        items = fetch_google_rss(q, cat, lang=lang, limit=lim)
        if len(items) < 4:
            # 1일 내 기사가 적으면 3일 범위로 보강
            items = fetch_google_rss(q.replace("when:1d", "when:3d"), cat, lang=lang, limit=lim)
        for it in items:
            norm = re.sub(r"\s+", "", it["title"])[:30]
            if norm not in seen_titles:
                seen_titles.add(norm)
                all_news.append(it)
        print(f"  ✓ 뉴스 수집 완료: [{cat}] {len(items)}건")

    cnbc_queries = [
        ("NVIDIA OR Broadcom OR AMD OR Intel OR TSMC OR Marvell OR semiconductor", "월가 영문속보", 8),
        ("Micron OR HBM OR DRAM OR SanDisk OR memory chip", "월가 영문속보", 6),
    ]
    for cq, ccat, clim in cnbc_queries:
        citems = fetch_cnbc_queryly(cq, ccat, limit=clim)
        for it in citems:
            norm = re.sub(r"\s+", "", it["title"])[:30]
            if norm not in seen_titles:
                seen_titles.add(norm)
                all_news.append(it)

    all_news.sort(key=lambda x: x.get("timestamp", 0), reverse=True)

    soxx_item = next((x for x in etfs if x["symbol"] == "SOXX"), None)
    soxl_item = next((x for x in etfs if x["symbol"] == "SOXL"), None)
    ram_item = next((x for x in etfs if x["symbol"] == "RAM"), None)
    dram_item = next((x for x in etfs if x["symbol"] == "DRAM"), None)
    us10y = next((x for x in macros if x["id"] == "us10y"), None)
    wti = next((x for x in macros if x["id"] == "wti"), None)
    vix = next((x for x in macros if x["id"] == "vix"), None)

    mtt_count = sum(1 for h in holdings if h["mtt_pass"])
    above50_count = sum(1 for h in holdings if h["above_sma50"])
    newhigh_count = sum(1 for h in holdings if h["is_new_high"])

    score = 65
    if soxx_item and soxx_item["above_sma50"]:
        score += 10
    if dram_item and dram_item["above_sma20"]:
        score += 10
    if vix and vix["price"] < 20:
        score += 10
    elif vix and vix["price"] >= 25:
        score -= 15
    if us10y and us10y["price"] >= 5.0:
        score -= 10
    if wti and wti["price"] >= 100.0:
        score -= 5
    score = max(15, min(98, score))

    if score >= 75:
        signal_label = "우호적 (추세 순항)"
        signal_color = "green"
        recommended_exposure = "70% ~ 90% (SOXX 중심 + RAM 추세 대응)"
    elif score >= 50:
        signal_label = "중립 · 선별 대응"
        signal_color = "amber"
        recommended_exposure = "40% ~ 60% (SOXX 현물 위주, RAM 분할 관리)"
    else:
        signal_label = "방어 · 레버리지 축소"
        signal_color = "red"
        recommended_exposure = "20% 이하 (현금 비중 확대 및 RAM 변동성 경계)"

    top_gainers = sorted(holdings, key=lambda x: x["change_pct"], reverse=True)[:4]
    top_rs = sorted(holdings, key=lambda x: x["rs_raw"], reverse=True)[:4]

    top_gainers_str = ", ".join(f"{x['name_kr']}({x['change_pct']:+.2f}%)" for x in top_gainers[:3])
    dram_aum_b = (dram_flow["current_aum"] / 1e9) if dram_flow else 19.19
    soxx_p = soxx_item["price"] if soxx_item else 0.0
    soxx_c = soxx_item["change_pct"] if soxx_item else 0.0
    soxl_p = soxl_item["price"] if soxl_item else 0.0
    soxl_c = soxl_item["change_pct"] if soxl_item else 0.0
    dram_p = dram_item["price"] if dram_item else 0.0
    dram_c = dram_item["change_pct"] if dram_item else 0.0
    ram_p = ram_item["price"] if ram_item else 0.0
    ram_c = ram_item["change_pct"] if ram_item else 0.0
    us10y_p = us10y["price"] if us10y else 0.0
    wti_p = wti["price"] if wti else 0.0
    vix_p = vix["price"] if vix else 0.0

    briefing = {
        "headline": f"SOXX({soxx_c:+.2f}%)·SOXL({soxl_c:+.2f}%)·RAM({ram_c:+.2f}%) 반등 속 미 10년물 금리({us10y_p}%)·WTI 유가(${wti_p}) 점검",
        "score": score,
        "signal_label": signal_label,
        "signal_color": signal_color,
        "recommended_exposure": recommended_exposure,
        "mtt_count": mtt_count,
        "above50_count": above50_count,
        "newhigh_count": newhigh_count,
        "total_holdings": len(holdings),
        "pillars": [
            {
                "title": "1. SOXX · SOXL(3X) & RAM(2X) · DRAM 4대 ETF 흐름 판독",
                "body": (
                    f"비메모리·장비 본진인 SOXX는 ${soxx_p} ({soxx_c:+.2f}%), "
                    f"반도체 3배 레버리지인 SOXL은 ${soxl_p} ({soxl_c:+.2f}%), "
                    f"메모리 원지수인 DRAM ETF는 ${dram_p} ({dram_c:+.2f}%), "
                    f"메모리 2배 레버리지인 RAM은 ${ram_p} ({ram_c:+.2f}%)을 기록하고 있습니다. "
                    f"핵심 감시 {len(holdings)}개 종목 중 {above50_count}개 종목이 50일 이동평균선 위에서 추세를 유지 중이며, "
                    f"미너비니 정배열(MTT)을 충족한 종목은 {mtt_count}개입니다."
                ),
            },
            {
                "title": "2. 메모리 3대장 (삼성전자 · SK하이닉스 · 마이크론) & 자금 유입",
                "body": (
                    f"RAM의 기초자산인 Roundhill DRAM ETF(순자산 약 ${dram_aum_b:.2f}B)는 "
                    f"삼성전자(18.7%), SK하이닉스(15.0%), 마이크론 스왑(약 25.2%)을 핵심 축으로 운용됩니다. "
                    f"당일 주가 탄력 상위 종목은 {top_gainers_str} 순으로, "
                    f"HBM 및 서버용 DRAM 가격 흐름이 한국·미국 메모리 주가를 동시에 견인하고 있습니다."
                ),
            },
            {
                "title": "3. 채권 금리 · 국제 유가 · 전쟁 지정학 리스크",
                "body": (
                    f"미국 10년물 국채금리는 {us10y_p}%로 심리적 저항선인 5.00% 부근에서 움직이고 있으며, "
                    f"WTI 원유는 배럴당 ${wti_p} 수준입니다. "
                    f"유가가 $100 위에서 고착화될 경우 인플레이션 우려를 통해 국채 금리 하방을 막을 수 있으므로, "
                    f"2배 레버리지인 RAM 운용 시에는 VIX 지수({vix_p})가 20 이하에서 안정되는지 함께 확인하는 것이 안전합니다."
                ),
            },
        ],
        "top_rs_names": [f"{x['name_kr']} ({x['display_ticker']})" for x in top_rs],
    }

    payload = {
        "updated_at": datetime.now(KST).strftime("%Y.%m.%d %H:%M KST"),
        "updated_iso": datetime.now(KST).isoformat(),
        "briefing": briefing,
        "etfs": etfs,
        "dram_flow": dram_flow,
        "macros": macros,
        "holdings": holdings,
        "news": all_news,
    }

    out_dir = os.path.dirname(os.path.abspath(__file__))
    json_path = os.path.join(out_dir, "intelligence_data.json")
    js_path = os.path.join(out_dir, "intelligence_data.js")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    with open(js_path, "w", encoding="utf-8") as f:
        f.write("window.SOXX_RAM_DATA = ")
        json.dump(payload, f, ensure_ascii=False)
        f.write(";\n")

    print(f"\n✅ 인텔리전스 데이터 생성 완료! (ETF {len(etfs)}종, 보유종목 {len(holdings)}종, 매크로 {len(macros)}종, 뉴스 {len(all_news)}건)")


if __name__ == "__main__":
    main()
