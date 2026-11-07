var BOT_TITLE = "🎩 [어쩐지 주식비서]";
var GEMINI_API_KEY = ["AQ.Ab8RN6J31dUOt", "UdOkuVwlriHFQLrnkNqvtIBNUb8zhM6LvwezQ"].join("");

var BRIEFING_TIMES = {
    "07:00": "🌅 [오전 7시] 미장 마감 & 글로벌 시황 브리핑",
    "08:50": "☕ [오전 8시 50분] 국장(코스피·코스닥) 개장 전 체크",
    "13:00": "☀️ [오후 1시] 국내외 증시 및 주요 뉴스 속보",
    "17:00": "🌇 [오후 5시] 국장 마감 & 미 프리장 주요 시황",
    "21:30": "🌙 [밤 9시 30분] 미 본장 개장 전 글로벌 총정리"
};

var WATCH_LIST = ["삼성전자", "SK하이닉스", "현대차", "SOXX", "SOXL", "DRAM", "RAM", "엔비디아", "마이크론"];
var SEMI_LIST = ["SOXX", "SOXL", "DRAM", "RAM", "엔비디아", "마이크론", "브로드컴", "TSMC", "SK하이닉스", "삼성전자", "한미반도체"];

var Jsoup = org.jsoup.Jsoup;
var savedReplier = null, savedRoom = null, isRunning = true, lastSentKey = "", chatHistory = {};
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36";

// 🚨 실시간 중요 뉴스(미증시 & SOXX·DRAM) 자동 감지·발송 상태 변수
var autoNewsAlertEnabled = true;
// 💖 극 F 성향 · 멘탈케어 · 초긍정왕 모드 (기본값: true)
var mentalCareMode = true;
var isNewsRadarInit = false;
var seenNewsKeys = {};
var seenNewsOrder = [];
var lastAlertSentMs = 0;
var lastRadarCheckMs = 0;
var ALERT_COOLDOWN_MS = 8 * 60 * 1000; // 중요 속보 연속 발송 최소 간격 (8분)
var RADAR_INTERVAL_MS = 3 * 60 * 1000; // 실시간 속보 스캔 주기 (3분)

// 외부 API 호출 시 타임아웃 3.2초(3200ms)로 제한하여 스마트폰 네트워크 지연 원천 차단
function fetchJson(url, hdr) {
    var c = Jsoup.connect(url).ignoreContentType(true).userAgent(UA).timeout(3200);
    if (hdr) { for (var k in hdr) c.header(k, hdr[k]); }
    return JSON.parse(c.execute().body());
}

function fetchText(url, timeoutMs) {
    return Jsoup.connect(url).ignoreContentType(true).userAgent(UA).timeout(timeoutMs || 3200).execute().body();
}

function decodeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#x27;/g, "'")
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function fmtArrow(code, ratio) {
    var r = parseFloat(ratio || 0);
    if (r > 0 || code === "2" || code === "1") return "🔺+" + Math.abs(r).toFixed(2) + "%";
    if (r < 0 || code === "5" || code === "4") return "🔹-" + Math.abs(r).toFixed(2) + "%";
    return "➖0.00%";
}

function getNormTitleKey(title) {
    return decodeHtml(title)
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\s+-\s+[^-]+$/, "")
        .replace(/[^가-힣a-zA-Z0-9]/g, "")
        .toLowerCase()
        .slice(0, 28);
}

function rememberNewsKey(key) {
    if (!key) return;
    if (!seenNewsKeys[key]) {
        seenNewsKeys[key] = true;
        seenNewsOrder.push(key);
        if (seenNewsOrder.length > 400) {
            var old = seenNewsOrder.shift();
            delete seenNewsKeys[old];
        }
    }
}

// 1. 핵심 주요 지수 + SOXX/SOXL/NVDA 프리장 + 유가·금리·환율 (초고속 조회용)
function getQuickMarketSummary() {
    var lines = [];
    var t = [
        ["🇺🇸 나스닥", "https://api.stock.naver.com/index/.IXIC/basic"],
        ["🇺🇸 S&P500", "https://api.stock.naver.com/index/.INX/basic"],
        ["💾 필라반도체", "https://api.stock.naver.com/index/.SOX/basic"]
    ];
    for (var i = 0; i < t.length; i++) {
        try {
            var d = fetchJson(t[i][1]);
            var c = d.compareToPreviousPrice ? d.compareToPreviousPrice.code : "";
            lines.push(t[i][0] + ": " + (d.closePrice || "-") + " (" + fmtArrow(c, d.fluctuationsRatio) + ")");
        } catch (e) {}
    }
    var etfs = [
        ["SOXX", "SOXX.O"],
        ["SOXL", "SOXL.K"],
        ["NVDA", "NVDA.O"]
    ];
    for (var j = 0; j < etfs.length; j++) {
        try {
            var ed = fetchJson("https://api.stock.naver.com/stock/" + etfs[j][1] + "/basic");
            var ec = ed.compareToPreviousPrice ? ed.compareToPreviousPrice.code : "";
            var eLine = "🇺🇸 " + etfs[j][0] + ": 정규 $" + ed.closePrice + " (" + fmtArrow(ec, ed.fluctuationsRatio) + ")";
            if (ed.overMarketPriceInfo && ed.overMarketPriceInfo.overPrice) {
                var om = ed.overMarketPriceInfo;
                var sName = (om.tradingSessionType === "PRE_MARKET") ? "프리장" : (om.tradingSessionType === "AFTER_MARKET" ? "애프터장" : "데이장");
                var omC = om.compareToPreviousPrice ? om.compareToPreviousPrice.code : "";
                eLine += " | 실시간 " + sName + " $" + om.overPrice + " (" + fmtArrow(omC, om.fluctuationsRatio) + ")";
            }
            lines.push(eLine);
        } catch (e2) {}
    }
    try {
        var wti = fetchJson("https://m.stock.naver.com/front-api/marketIndex/productDetail?category=energy&reutersCode=CLcv1").result;
        var us10y = fetchJson("https://m.stock.naver.com/front-api/marketIndex/productDetail?category=bond&reutersCode=US10YT=RR").result;
        var fx = fetchJson("https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW").result;
        lines.push("🛢️ WTI유가: $" + (wti.closePrice || wti.calcPrice) + " (" + fmtArrow("", wti.fluctuationsRatio) + ") | 🏦 미10년물금리: " + (us10y.closePrice || us10y.calcPrice) + "% | 💵 원/달러: " + (fx.calcPrice || fx.closePrice) + "원");
    } catch (e3) {}
    return lines.join("\n");
}

// 2. 전체 주요 지수 (정규 브리핑용)
function getMarketIndices() {
    var lines = [];
    var t = [
        ["🇰🇷 코스피", "https://m.stock.naver.com/api/index/KOSPI/basic"],
        ["🇰🇷 코스닥", "https://m.stock.naver.com/api/index/KOSDAQ/basic"],
        ["🇺🇸 나스닥", "https://api.stock.naver.com/index/.IXIC/basic"],
        ["🇺🇸 S&P500", "https://api.stock.naver.com/index/.INX/basic"],
        ["💾 필라반도체", "https://api.stock.naver.com/index/.SOX/basic"]
    ];
    for (var i = 0; i < t.length; i++) {
        try {
            var d = fetchJson(t[i][1]);
            var c = d.compareToPreviousPrice ? d.compareToPreviousPrice.code : "";
            lines.push(t[i][0] + ": " + (d.closePrice || "-") + " (" + fmtArrow(c, d.fluctuationsRatio) + ")");
        } catch (e) {}
    }
    return lines.join("\n");
}

// 3. 국제유가 & 천연가스 (!유가)
function getOilInfo() {
    var lines = ["🛢️ [실시간 국제유가 & 에너지]", "━━━━━━━━━━━━━━━━━━"];
    var list = [
        ["WTI (서부텍사스유)", "energy", "CLcv1", "$"],
        ["브렌트유 (Brent)", "energy", "LCOcv1", "$"],
        ["천연가스 (NatGas)", "energy", "NGcv1", "$"]
    ];
    for (var i = 0; i < list.length; i++) {
        try {
            var d = fetchJson("https://m.stock.naver.com/front-api/marketIndex/productDetail?category=" + list[i][1] + "&reutersCode=" + list[i][2]).result;
            var c = d.compareToPreviousPrice ? d.compareToPreviousPrice.code : (d.fluctuationsType ? d.fluctuationsType.code : "");
            lines.push("• " + list[i][0] + ": " + list[i][3] + (d.closePrice || d.calcPrice) + " (" + fmtArrow(c, d.fluctuationsRatio) + ")");
        } catch (e) {}
    }
    return lines.join("\n");
}

// 4. 금·은·구리 원자재 (!금, !원자재)
function getMetalsInfo() {
    var lines = ["🥇 [실시간 금·원자재 시세]", "━━━━━━━━━━━━━━━━━━"];
    var list = [
        ["국제 금 (Gold)", "metals", "GCcv1", "$"],
        ["국제 은 (Silver)", "metals", "SIcv1", "$"],
        ["국제 구리 (Copper)", "metals", "HGcv1", "$"]
    ];
    for (var i = 0; i < list.length; i++) {
        try {
            var d = fetchJson("https://m.stock.naver.com/front-api/marketIndex/productDetail?category=" + list[i][1] + "&reutersCode=" + list[i][2]).result;
            var c = d.compareToPreviousPrice ? d.compareToPreviousPrice.code : "";
            lines.push("• " + list[i][0] + ": " + list[i][3] + (d.closePrice || d.calcPrice) + " (" + fmtArrow(c, d.fluctuationsRatio) + ")");
        } catch (e) {}
    }
    return lines.join("\n");
}

// 5. 미 국채금리 & 달러인덱스 (!금리, !국채)
function getBondInfo() {
    var lines = ["🏦 [미국 국채금리 & 달러인덱스]", "━━━━━━━━━━━━━━━━━━"];
    var list = [
        ["🇺🇸 미 국채 2년물", "bond", "US2YT=RR", "%"],
        ["🇺🇸 미 국채 10년물", "bond", "US10YT=RR", "%"],
        ["💵 달러인덱스(DXY)", "exchange", ".DXY", ""]
    ];
    for (var i = 0; i < list.length; i++) {
        try {
            var d = fetchJson("https://m.stock.naver.com/front-api/marketIndex/productDetail?category=" + list[i][1] + "&reutersCode=" + list[i][2]).result;
            var c = d.compareToPreviousPrice ? d.compareToPreviousPrice.code : "";
            lines.push("• " + list[i][0] + ": " + (d.closePrice || d.calcPrice) + list[i][3] + " (" + fmtArrow(c, d.fluctuationsRatio) + ")");
        } catch (e) {}
    }
    return lines.join("\n");
}

// 6. 환율 (!환율)
function getExchangeRates() {
    var lines = [];
    var fx = [["💵 원/달러", "FX_USDKRW"], ["💴 원/엔(100엔)", "FX_JPYKRW"]];
    for (var i = 0; i < fx.length; i++) {
        try {
            var d = fetchJson("https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=" + fx[i][1]).result;
            var c = d.compareToPreviousPrice ? d.compareToPreviousPrice.code : "";
            lines.push(fx[i][0] + ": " + (d.calcPrice || d.closePrice) + "원 (" + fmtArrow(c, d.fluctuationsRatio) + ")");
        } catch (e) {}
    }
    return lines.join("\n");
}

// 7. 비트코인 & 이더리움 (!비트, !코인)
function getCryptoInfo() {
    var lines = ["🪙 [실시간 가상자산 시세]", "━━━━━━━━━━━━━━━━━━"];
    try {
        var up = fetchJson("https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-ETH");
        lines.push("• 비트코인(BTC): " + Number(up[0].trade_price).toLocaleString() + "원 (" + fmtArrow("", (up[0].signed_change_rate * 100).toFixed(2)) + ")");
        lines.push("• 이더리움(ETH): " + Number(up[1].trade_price).toLocaleString() + "원 (" + fmtArrow("", (up[1].signed_change_rate * 100).toFixed(2)) + ")");
    } catch (e) {}
    lines.push(getFearAndGreed());
    return lines.join("\n");
}

// 8. 공포&탐욕 지수 (!공탐)
function getFearAndGreed() {
    var out = [];
    try {
        var cnn = fetchJson("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
            "Accept": "application/json", "Referer": "https://www.cnn.com/markets/fear-and-greed"
        });
        var s = Math.round(cnn.fear_and_greed.score);
        var rt = (cnn.fear_and_greed.rating || "").toUpperCase();
        var m = {"EXTREME FEAR":"😱 극단적공포","FEAR":"😨 공포","NEUTRAL":"😐 중립","GREED":"🤑 탐욕","EXTREME GREED":"🔥 극단적탐욕"};
        out.push("🇺🇸 미 증시 공탐(CNN): " + s + "점 [" + (m[rt] || rt) + "]");
    } catch (e) {}
    return out.join("\n");
}

// ============================================================================
// 📡 [실시간 미증시 & SOXX·DRAM 3중 뉴스 수집 엔진]
// 1) 네이버 해외증시 실시간 속보(로이터/월가)
// 2) Google News 실시간 RSS (최신순 타임스탬프 정렬 - 미증시 & SOXX/DRAM/반도체)
// 3) 네이버 미국주식 종목별 뉴스 정밀 파서 (중첩 items[].titleFull 완벽 지원)
// ============================================================================

// A. Google News 실시간 한국어 RSS 파서 (최신 발행순 정렬)
function fetchGoogleRssNews(queryStr, limitCnt) {
    var out = [];
    try {
        var q = queryStr + " when:1d";
        var url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=ko&gl=KR&ceid=KR:ko";
        var xml = fetchText(url, 3200);
        var re = /<item>([\s\S]*?)<\/item>/g;
        var m;
        var rawItems = [];
        while ((m = re.exec(xml)) !== null) {
            var block = m[1];
            var tm = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/);
            var pm = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
            if (tm) {
                var fullTit = decodeHtml(tm[1] || tm[2] || "");
                if (!fullTit) continue;
                // 동명이인/비경제 기사 필터링
                if (/셰프|연예|드라마|프로야구|축구|골프|운세|부고/.test(fullTit)) continue;
                var source = "";
                var dashIdx = fullTit.lastIndexOf(" - ");
                if (dashIdx > 0 && fullTit.length - dashIdx <= 24) {
                    source = fullTit.substring(dashIdx + 3).trim();
                    fullTit = fullTit.substring(0, dashIdx).trim();
                }
                var ts = 0;
                if (pm && pm[1]) {
                    var parsed = Date.parse(pm[1].trim());
                    if (!isNaN(parsed)) ts = parsed;
                }
                rawItems.push({
                    id: "gn_" + getNormTitleKey(fullTit),
                    title: fullTit,
                    source: source || "글로벌속보",
                    summary: "",
                    ts: ts
                });
            }
        }
        rawItems.sort(function(a, b) { return b.ts - a.ts; });
        var seen = {};
        for (var i = 0; i < rawItems.length; i++) {
            var k = getNormTitleKey(rawItems[i].title);
            if (!k || seen[k]) continue;
            seen[k] = true;
            out.push(rawItems[i]);
            if (out.length >= (limitCnt || 5)) break;
        }
    } catch (e) {}
    return out;
}

// B. 네이버 해외증시 실시간 속보 (로이터 등 초단위 속보 + 미증시/반도체 우선 선별)
function fetchNaverWorldNews(limitCnt) {
    var out = [];
    try {
        var list = fetchJson("https://api.stock.naver.com/news/worldNews?page=1&pageSize=18");
        var priority = [];
        var normal = [];
        var usSemiRe = /\[속보\]|미국|미\s*증시|뉴욕|월가|나스닥|S&P|다우|연준|Fed|FOMC|파월|금리|국채|CPI|물가|고용|실업|관세|트럼프|반도체|SOXX|SOXL|DRAM|D램|디램|HBM|메모리|엔비디아|마이크론|TSMC|브로드컴|AMD|인텔|ASML|애플|테슬라|마이크로소프트|구글|메타|아마존|실적|가이던스|서프라이즈|AI|데이터센터/i;
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            var tit = decodeHtml(it.tit || "");
            if (!tit) continue;
            var sub = decodeHtml(it.subcontent || "");
            // dt 포맷: "20261102215720"
            var dtStr = String(it.dt || "");
            var ts = Date.now();
            if (dtStr.length >= 12) {
                var y = parseInt(dtStr.substring(0, 4), 10);
                var mo = parseInt(dtStr.substring(4, 6), 10) - 1;
                var da = parseInt(dtStr.substring(6, 8), 10);
                var hh = parseInt(dtStr.substring(8, 10), 10);
                var mi = parseInt(dtStr.substring(10, 12), 10);
                var sc = dtStr.length >= 14 ? parseInt(dtStr.substring(12, 14), 10) : 0;
                ts = new Date(y, mo, da, hh, mi, sc).getTime();
            }
            var obj = {
                id: "nw_" + (it.aid || getNormTitleKey(tit)),
                title: tit,
                source: it.ohnm || "해외속보",
                summary: sub.slice(0, 160),
                ts: ts
            };
            if (usSemiRe.test(tit) || usSemiRe.test(sub)) {
                priority.push(obj);
            } else {
                normal.push(obj);
            }
        }
        var combined = priority.concat(normal);
        var seen = {};
        for (var j = 0; j < combined.length; j++) {
            var k = getNormTitleKey(combined[j].title);
            if (!k || seen[k]) continue;
            seen[k] = true;
            out.push(combined[j]);
            if (out.length >= (limitCnt || 5)) break;
        }
    } catch (e) {}
    return out;
}

// C. 미국 개별 종목 최신 뉴스 정밀 수집 (중첩 items[].titleFull 파싱 + ETF 폴백)
function fetchUsStockNews(reutersCode, stockName, limitCnt) {
    var out = [];
    var maxN = limitCnt || 2;
    try {
        var nList = fetchJson("https://api.stock.naver.com/news/stock/" + reutersCode + "?page=1&pageSize=4");
        if (nList && nList.length > 0) {
            for (var i = 0; i < nList.length; i++) {
                var group = nList[i];
                if (group && group.items && group.items.length > 0) {
                    for (var j = 0; j < group.items.length; j++) {
                        var art = group.items[j];
                        var tit = decodeHtml(art.titleFull || art.title || "");
                        if (tit) {
                            out.push({
                                id: "st_" + (art.id || getNormTitleKey(tit)),
                                title: tit,
                                source: art.officeName || "미장뉴스",
                                summary: decodeHtml(art.body || "").slice(0, 140),
                                ts: Date.now()
                            });
                            if (out.length >= maxN) return out;
                        }
                    }
                } else if (group && (group.tit || group.title)) {
                    var tit2 = decodeHtml(group.tit || group.title || "");
                    if (tit2) {
                        out.push({
                            id: "st_" + getNormTitleKey(tit2),
                            title: tit2,
                            source: group.ohnm || "미장뉴스",
                            summary: "",
                            ts: Date.now()
                        });
                        if (out.length >= maxN) return out;
                    }
                }
            }
        }
    } catch (e) {}

    // SOXX, SOXL, DRAM, RAM 등 ETF이거나 종목 뉴스가 비어 있을 때 Google News 실시간 검색으로 즉시 보강!
    if (out.length < maxN) {
        var cleanCode = String(reutersCode || "").split(".")[0];
        var fallbackQuery = stockName || cleanCode;
        if (/SOXX|SOXL/i.test(cleanCode)) fallbackQuery = '("SOXX" OR "SOXL" OR "필라델피아반도체" OR "미국 반도체")';
        else if (/DRAM|RAM/i.test(cleanCode)) fallbackQuery = '("DRAM" OR "D램" OR "HBM" OR "마이크론" OR "메모리 반도체")';
        else if (/MU/i.test(cleanCode)) fallbackQuery = '("마이크론" OR "Micron" OR "HBM")';
        var rssItems = fetchGoogleRssNews(fallbackQuery, maxN - out.length);
        for (var r = 0; r < rssItems.length; r++) {
            out.push(rssItems[r]);
        }
    }
    return out;
}

// 9. 개별 종목 검색 (한국주식 전 종목 + 미국주식 완벽 지원, 정규장 + 시간외단일가/프리장 + 최신 뉴스)
function getStockInfo(query, compact) {
    try {
        var q = query.trim();
        var ac = fetchJson("https://ac.stock.naver.com/ac?q=" + encodeURIComponent(q) + "&target=stock,index,marketindicator");
        if (!ac.items || ac.items.length === 0) return null;
        var it = ac.items[0];
        if (it.category === "marketindicator") {
            var md = fetchJson("https://m.stock.naver.com/front-api/marketIndex/productDetail?category=" + it.typeCode + "&reutersCode=" + it.reutersCode).result;
            var mc = md.compareToPreviousPrice ? md.compareToPreviousPrice.code : "";
            return "📊 [" + it.name + "]\n• 현재가: " + (md.closePrice || md.calcPrice) + " (" + fmtArrow(mc, md.fluctuationsRatio) + ")";
        }
        var isKR = (it.nationCode === "KOR");
        var codeKey = isKR ? it.code : it.reutersCode;
        var url = isKR ? "https://m.stock.naver.com/api/stock/" + it.code + "/basic" : "https://api.stock.naver.com/stock/" + it.reutersCode + "/basic";
        var d = fetchJson(url);
        var name = d.stockName || it.name;
        var c = d.compareToPreviousPrice ? d.compareToPreviousPrice.code : "";
        var pStr = isKR ? (d.closePrice + "원") : ("$" + d.closePrice);
        var flag = isKR ? "🇰🇷" : "🇺🇸";
        var overStr = "";
        if (d.overMarketPriceInfo && d.overMarketPriceInfo.overPrice) {
            var om = d.overMarketPriceInfo;
            var sName = isKR ? "시간외단일가" : ((om.tradingSessionType === "PRE_MARKET") ? "프리장" : (om.tradingSessionType === "AFTER_MARKET" ? "애프터장" : "데이장"));
            var omC = om.compareToPreviousPrice ? om.compareToPreviousPrice.code : "";
            var omP = isKR ? (om.overPrice + "원") : ("$" + om.overPrice);
            overStr = " | " + sName + ": " + omP + "(" + fmtArrow(omC, om.fluctuationsRatio) + ")";
        }
        if (compact) return "• " + flag + " " + name + ": " + pStr + " (" + fmtArrow(c, d.fluctuationsRatio) + ")" + overStr;

        // 상세 지표 추출 (52주 최고·최저, 시가·고가·저가, 시총, PER, 외인·기관 수급)
        var extraLines = [];
        try {
            var tInfos = d.stockItemTotalInfos || [];
            var dealInfo = null;
            if (isKR) {
                var integ = fetchJson("https://m.stock.naver.com/api/stock/" + it.code + "/integration");
                if (integ && integ.totalInfos) tInfos = integ.totalInfos;
                if (integ && integ.dealTrendInfos && integ.dealTrendInfos.length > 0) dealInfo = integ.dealTrendInfos[0];
            }
            var map = {};
            for (var ti = 0; ti < tInfos.length; ti++) {
                if (tInfos[ti].code && tInfos[ti].value) map[tInfos[ti].code] = tInfos[ti].value;
            }
            var preUnit = isKR ? "" : "$";
            var postUnit = isKR ? "원" : "";
            if (map.highPriceOf52Weeks || map.lowPriceOf52Weeks) {
                extraLines.push("• 52주 최고/최저: " + preUnit + (map.highPriceOf52Weeks || "-") + postUnit + " / " + preUnit + (map.lowPriceOf52Weeks || "-") + postUnit);
            }
            if (map.highPrice || map.lowPrice) {
                extraLines.push("• 당일 고가/저가: " + preUnit + (map.highPrice || "-") + postUnit + " / " + preUnit + (map.lowPrice || "-") + postUnit + (map.marketValue ? " | 시총: " + map.marketValue : ""));
            }
            if (map.per && map.per !== "N/A") {
                extraLines.push("• 밸류/배당: PER " + map.per + (map.pbr ? " / PBR " + map.pbr : "") + (map.dividendYieldRatio ? " / 배당 " + map.dividendYieldRatio : ""));
            }
            if (dealInfo) {
                extraLines.push("• 당일 수급: 외인 " + (dealInfo.foreignerPureBuyQuant || "-") + " / 기관 " + (dealInfo.organPureBuyQuant || "-") + " / 개인 " + (dealInfo.individualPureBuyQuant || "-"));
            }
        } catch (ee) {}

        // 미국 주식(SOXX, DRAM 포함) 실시간 속보 뉴스 2건 추가
        var newsLines = [];
        if (!isKR) {
            var usNews = fetchUsStockNews(codeKey, name, 2);
            for (var ni = 0; ni < usNews.length; ni++) {
                newsLines.push("  └ 📰 " + usNews[ni].title);
            }
        }

        var res = "📊 [" + flag + " " + name + " (" + it.code + ")]\n"
            + "• 정규장: " + pStr + " (" + fmtArrow(c, d.fluctuationsRatio) + " / 전일비 " + (d.compareToPreviousClosePrice || "0") + ")\n"
            + (overStr ? "• 실시간 " + overStr.substring(3) + "\n" : "")
            + (extraLines.length > 0 ? extraLines.join("\n") + "\n" : "");
        if (newsLines.length > 0) res += "• 최신 속보:\n" + newsLines.join("\n");
        return res.trim();
    } catch (e) { return null; }
}

function getSemiBriefing() {
    var lines = [BOT_TITLE + " 💾 반도체 · SOXX · DRAM 종합 브리핑", "━━━━━━━━━━━━━━━━━━"];
    try {
        var sox = fetchJson("https://api.stock.naver.com/index/.SOX/basic");
        var sc = sox.compareToPreviousPrice ? sox.compareToPreviousPrice.code : "";
        lines.push("🇺🇸 필라델피아 반도체(SOX): " + sox.closePrice + " (" + fmtArrow(sc, sox.fluctuationsRatio) + ")\n");
    } catch (e) {}
    for (var i = 0; i < SEMI_LIST.length; i++) {
        var s = getStockInfo(SEMI_LIST[i], true);
        if (s) lines.push(s);
    }
    var semiNews = fetchGoogleRssNews('("필라델피아반도체" OR "SOXX" OR "DRAM" OR "D램" OR "HBM" OR "마이크론" OR "엔비디아")', 3);
    if (semiNews.length > 0) {
        lines.push("\n📰 [SOXX · DRAM · 반도체 실시간 뉴스]");
        for (var j = 0; j < semiNews.length; j++) {
            lines.push("• " + semiNews[j].title);
        }
    }
    return lines.join("\n");
}

// ⚡ [핵심 최적화] thinkingBudget: 0 설정으로 생각 토큰 낭비 및 타임아웃 원천 박멸!
function getNowKST() {
    var cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Asia/Seoul"));
    var days = ["일", "월", "화", "수", "목", "금", "토"];
    var y = cal.get(java.util.Calendar.YEAR);
    var m = cal.get(java.util.Calendar.MONTH) + 1;
    var d = cal.get(java.util.Calendar.DATE);
    var dow = days[cal.get(java.util.Calendar.DAY_OF_WEEK) - 1];
    var h = cal.get(java.util.Calendar.HOUR_OF_DAY);
    var min = ("0" + cal.get(java.util.Calendar.MINUTE)).slice(-2);
    return y + "년 " + m + "월 " + d + "일 " + dow + "요일 " + h + ":" + min;
}

// 카카오톡에서 지저분하게 보이는 마크다운 별표(** / *) 및 샵(#) 완전 제거
function cleanKakaoText(txt) {
    if (!txt) return "";
    return String(txt)
        .replace(/\*\*/g, "")
        .replace(/^\s*\*\s+/gm, "• ")
        .replace(/^#+\s*/gm, "📌 ")
        .trim();
}

function askGemini(promptText) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.indexOf("입력") !== -1) {
        return "⚠️ 스크립트 상단 2번째 줄에 GEMINI_API_KEY를 입력해 주세요!";
    }
    var models = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-3.1-flash-lite"];
    var lastCode = "";
    for (var i = 0; i < models.length; i++) {
        try {
            var m = models[i];
            var url = "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent?key=" + GEMINI_API_KEY.trim();
            var genCfg = { temperature: mentalCareMode ? 0.65 : 0.25, maxOutputTokens: 520 };
            if (m.indexOf("lite") === -1) {
                genCfg.thinkingConfig = { thinkingBudget: 0 };
            }
            var body = JSON.stringify({
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: genCfg
            });
            var res = Jsoup.connect(url)
                .ignoreContentType(true)
                .ignoreHttpErrors(true)
                .postDataCharset("UTF-8")
                .header("Content-Type", "application/json; charset=UTF-8")
                .requestBody(body)
                .method(org.jsoup.Connection.Method.POST)
                .timeout(8000)
                .execute();
            if (res.statusCode() === 200) {
                var json = JSON.parse(res.body());
                var parts = json.candidates[0].content.parts;
                return cleanKakaoText(parts[parts.length - 1].text);
            }
            lastCode = res.statusCode();
        } catch (e) { lastCode = String(e); }
    }
    return "⚠️ AI 응답 지연(" + lastCode + ")";
}

// 10. 미증시 & SOXX·DRAM 실시간 주요 뉴스 통합 브리핑 (!뉴스, !미장뉴스, !반도체뉴스)
function getLatestNews(cnt, mode) {
    try {
        var worldItems = fetchNaverWorldNews(4);
        var usMktItems = fetchGoogleRssNews('("뉴욕증시" OR "미증시" OR "미국증시" OR "나스닥" OR "S&P500" OR "미 연준" OR "FOMC" OR "파월")', 4);
        var semiItems = fetchGoogleRssNews('("필라델피아반도체" OR "SOXX" OR "SOXL" OR "DRAM" OR "D램" OR "HBM" OR "마이크론" OR "엔비디아" OR "브로드컴" OR "TSMC")', 5);

        // 중복 제거 후 미증시 종합 리스트 & 반도체/DRAM 리스트 구성
        var seen = {};
        var usCombined = [];
        var usPool = worldItems.concat(usMktItems);
        for (var i = 0; i < usPool.length; i++) {
            var k = getNormTitleKey(usPool[i].title);
            if (!k || seen[k]) continue;
            seen[k] = true;
            usCombined.push(usPool[i]);
            if (usCombined.length >= 4) break;
        }

        var semiClean = [];
        for (var j = 0; j < semiItems.length; j++) {
            var k2 = getNormTitleKey(semiItems[j].title);
            if (!k2 || seen[k2]) continue;
            seen[k2] = true;
            semiClean.push(semiItems[j]);
            if (semiClean.length >= 4) break;
        }

        var rawForAi = [];
        var usHeadlines = [];
        var semiHeadlines = [];

        for (var u = 0; u < usCombined.length; u++) {
            usHeadlines.push("• " + usCombined[u].title);
            rawForAi.push("- [미증시] " + usCombined[u].title + (usCombined[u].summary ? " (" + usCombined[u].summary + ")" : ""));
        }
        for (var s = 0; s < semiClean.length; s++) {
            semiHeadlines.push("• " + semiClean[s].title);
            rawForAi.push("- [SOXX/DRAM] " + semiClean[s].title);
        }

        if (mode === "SEMI_ONLY") {
            var aiSemi = "";
            if (GEMINI_API_KEY && semiHeadlines.length > 0) {
                aiSemi = askGemini("다음 실시간 반도체(SOXX·DRAM·HBM·엔비디아·마이크론) 최신 뉴스들을 바탕으로, 현재 반도체 투자자들에게 용기와 희망을 주는 따뜻한 공감·긍정왕 톤으로 핵심 포인트를 2~3줄로 다정하게 요약해줘(마크다운 별표 없이 이모지 활용):\n" + semiHeadlines.join("\n"));
            }
            return "💾 [SOXX · DRAM · AI반도체 실시간 속보]\n━━━━━━━━━━━━━━━━━━\n"
                + (aiSemi && aiSemi.indexOf("⚠️") === -1 ? "💖 [AI 반도체 긍정케어 요약]\n" + aiSemi + "\n\n" : "")
                + "📰 [실시간 주요 헤드라인]\n" + (semiHeadlines.length > 0 ? semiHeadlines.join("\n") : "• 최신 반도체 뉴스 수집 중");
        }

        var aiSummary = "";
        if (GEMINI_API_KEY && rawForAi.length > 0) {
            aiSummary = askGemini(
                "다음 실시간 미국 증시 및 반도체(SOXX·DRAM) 최신 뉴스들을 바탕으로, "
                + "1) 미증시 전반 분위기, 2) SOXX·DRAM·반도체 핵심 이슈, 3) 우리 단톡방 투자자들의 멘탈을 지켜주는 따뜻하고 긍정적인 응원 한마디를 카톡 브리핑 스타일로 3줄 이내로 다정하게 요약해줘(마크다운 별표 ** 절대 금지, 이모지 활용):\n"
                + rawForAi.join("\n")
            );
        }

        var outBlocks = [];
        if (aiSummary && aiSummary.indexOf("⚠️") === -1) {
            outBlocks.push("💖 [AI 미증시 & SOXX·DRAM 긍정케어 요약]\n" + aiSummary);
        }
        if (usHeadlines.length > 0) {
            outBlocks.push("🇺🇸 [실시간 미증시 · 매크로 주요 뉴스]\n" + usHeadlines.join("\n"));
        }
        if (semiHeadlines.length > 0) {
            outBlocks.push("💾 [SOXX · DRAM · 반도체 주요 뉴스]\n" + semiHeadlines.join("\n"));
        }
        return outBlocks.join("\n\n");
    } catch (e) { return "📰 뉴스 조회 지연"; }
}

// ============================================================================
// 🚨 [핵심 기능] 매우 중요한 뉴스(미증시 & SOXX·DRAM) 자동 감지 및 카톡 푸시 알림
// ============================================================================

// 1차 필터: 미증시 매크로 또는 SOXX/DRAM/반도체에 중대한 영향을 미치는 키워드 포함 여부
function isHighImpactCandidate(item) {
    var txt = (item.title || "") + " " + (item.summary || "");
    // 광고/시황 단순 클리셰 제외
    if (/저점을\s*줄때마다|무료\s*추천|클릭|체험단|오늘의\s*운세/.test(txt)) return false;

    // A) SOXX · DRAM · 반도체 핵심 재료
    var hasSemiTarget = /SOXX|SOXL|필라델피아\s*반도체|필반|DRAM|D램|디램|HBM|HBM3E|HBM4|낸드|NAND|마이크론|Micron|엔비디아|NVIDIA|브로드컴|Broadcom|TSMC|AMD|ASML|삼성전자|SK하이닉스/i.test(txt);
    var hasSemiCatalyst = /\[속보\]|\[긴급\]|\[단독\]|실적|가이던스|어닝|서프라이즈|쇼크|급등|급락|폭등|폭락|사상\s*최고|신고가|관세|수출\s*통제|보조금|빅딜|인수|합병|공급\s*계약|독점|수주|감산|증설|가격\s*인상|목표가/i.test(txt);

    // B) 미증시 · 매크로 핵심 재료
    var hasUsMacroTarget = /\[속보\]|\[긴급\]|미\s*증시|미국\s*증시|뉴욕\s*증시|나스닥|S&P\s*500|연준|Fed|FOMC|파월|기준금리|미국채|CPI|소비자물가|PCE|고용보고서|비농업|실업률|서킷브레이커|트럼프\s*관세|상호관세/i.test(txt);
    var hasMacroCatalyst = /\[속보\]|\[긴급\]|발표|인하|인상|동결|급등|급락|폭등|폭락|돌파|붕괴|쇼크|서프라이즈|비상|전격|합의|타결|부과|철회|최고치|최저치/i.test(txt);

    if (hasSemiTarget && hasSemiCatalyst) return true;
    if (hasUsMacroTarget && hasMacroCatalyst) return true;
    if (/^\[속보\]|^\[긴급\]/.test(item.title || "") && (hasSemiTarget || hasUsMacroTarget)) return true;
    return false;
}

// 실시간 뉴스 풀 수집 (자동 레이더 및 테스트용)
function collectRadarNewsPool() {
    var pool = [];
    var w = fetchNaverWorldNews(6);
    var u = fetchGoogleRssNews('("뉴욕증시" OR "미증시" OR "나스닥" OR "미 연준" OR "FOMC" OR "파월" OR "CPI" OR "관세")', 5);
    var s = fetchGoogleRssNews('("필라델피아반도체" OR "SOXX" OR "SOXL" OR "DRAM" OR "D램" OR "HBM" OR "마이크론" OR "엔비디아" OR "TSMC" OR "브로드컴")', 6);
    var nv = fetchUsStockNews("NVDA.O", "엔비디아", 2);
    var av = fetchUsStockNews("AVGO.O", "브로드컴", 1);
    var all = w.concat(s).concat(u).concat(nv).concat(av);

    var seen = {};
    for (var i = 0; i < all.length; i++) {
        var k = getNormTitleKey(all[i].title);
        if (!k || seen[k]) continue;
        seen[k] = true;
        all[i].normKey = k;
        pool.push(all[i]);
    }
    return pool;
}

// Gemini AI로 진짜 중요한 속보인지 최종 검증 후 카톡 알림 메시지 생성 (forceMode=true면 무조건 브리핑 생성)
function evaluateAndFormatBreakingAlert(candidate, forceMode) {
    var prompt = "너는 월가 및 반도체(SOXX·DRAM)를 꿰뚫고 있으면서 투자자들의 멘탈을 따뜻하게 케어해주는 초긍정왕 '어쩐지 주식비서'야.\n"
        + "새로 감지된 뉴스:\n"
        + "- 제목: " + candidate.title + "\n"
        + (candidate.summary ? "- 요약: " + candidate.summary + "\n" : "")
        + "- 출처: " + (candidate.source || "실시간 속보") + "\n\n";

    if (!forceMode) {
        prompt += "[판정 지침]\n"
            + "1. 이 뉴스가 미국 증시(나스닥·S&P500·금리·관세) 또는 반도체(SOXX·SOXL·DRAM·HBM·엔비디아·마이크론·TSMC·삼성·하이닉스) 투자자에게 즉시 카톡 알림을 보낼 만큼 **매우 중요한 뉴스(중요도 85점 이상)**인지 엄격히 판별해.\n"
            + "2. 만약 단순 시황 반복, 사소한 의견, 중요도가 낮은 뉴스라면 다른 말 없이 오직 PASS 라고만 출력해.\n"
            + "3. 정말 중요한 핵심 뉴스라면 첫 줄에 ALERT 라고 적고, 이어서 3줄 이내로 (1) 핵심 팩트 요약, (2) 미증시 및 SOXX·DRAM 투자자에 대한 긍정적 기회 요인 및 따뜻한 멘탈케어 한마디를 마크다운 별표(**) 없이 다정하게 작성해줘.";
    } else {
        prompt += "[작성 지침]\n"
            + "이 뉴스의 (1) 핵심 내용 요약과 (2) 미증시 및 SOXX·DRAM·반도체 투자자들에게 힘과 용기를 주는 긍정적 시사점 및 따뜻한 멘탈케어 한마디를 마크다운 별표(**) 없이 이모지를 활용해 3줄 이내로 다정하게 브리핑해줘.";
    }

    var aiRes = askGemini(prompt);
    if (!aiRes || aiRes.indexOf("⚠️") !== -1) return null;

    if (!forceMode) {
        if (aiRes.indexOf("PASS") !== -1 && aiRes.indexOf("ALERT") === -1) {
            return null;
        }
        aiRes = aiRes.replace(/^ALERT[:\s\n]*/i, "").trim();
    }

    var mktLine = getQuickMarketSummary();
    return "🚨 [어쩐지 긴급 속보 알림]\n"
        + "━━━━━━━━━━━━━━━━━━\n"
        + "📰 " + candidate.title + (candidate.source ? " (" + candidate.source + ")" : "") + "\n\n"
        + "💖 [핵심 요약 & 긍정케어 포인트]\n"
        + aiRes + "\n\n"
        + "📊 [실시간 주요 지수]\n"
        + mktLine;
}

// 백그라운드 자동 감지 함수 (3분 주기 실행)
function checkAndSendBreakingNews() {
    if (!autoNewsAlertEnabled || !savedReplier) return;
    var now = Date.now();
    if (now - lastRadarCheckMs < RADAR_INTERVAL_MS) return;
    lastRadarCheckMs = now;

    try {
        var pool = collectRadarNewsPool();
        // 첫 실행 시에는 현재 뉴스들을 읽음 처리만 하여 과거 뉴스 폭탄 방지
        if (!isNewsRadarInit) {
            for (var i = 0; i < pool.length; i++) {
                rememberNewsKey(pool[i].normKey);
            }
            isNewsRadarInit = true;
            return;
        }

        // 쿨타임 체크
        if (now - lastAlertSentMs < ALERT_COOLDOWN_MS) return;

        for (var j = 0; j < pool.length; j++) {
            var item = pool[j];
            if (seenNewsKeys[item.normKey]) continue;
            rememberNewsKey(item.normKey);

            // 발행 시각이 너무 오래된 기사(2시간 이전)는 자동 푸시 제외
            if (item.ts && item.ts > 0 && (now - item.ts > 2 * 3600 * 1000)) continue;

            if (isHighImpactCandidate(item)) {
                var alertMsg = evaluateAndFormatBreakingAlert(item, false);
                if (alertMsg) {
                    lastAlertSentMs = Date.now();
                    savedReplier.reply(alertMsg);
                    break; // 한 번에 가장 중요한 1건만 깔끔하게 발송
                }
            }
        }
    } catch (e) {}
}

function buildFullBriefing(title) {
    var w = [];
    for (var i = 0; i < WATCH_LIST.length; i++) {
        var s = getStockInfo(WATCH_LIST[i], true);
        if (s) w.push(s);
    }
    return BOT_TITLE + "\n" + title + "\n━━━━━━━━━━━━━━━━━━\n📈 [국내외 주요 지수]\n" + getMarketIndices() + "\n\n🔥 [핵심 관심 종목 (SOXX·DRAM 포함)]\n" + w.join("\n") + "\n\n🛢️ [환율·원자재·공탐]\n" + getExchangeRates() + "\n" + getFearAndGreed() + "\n━━━━━━━━━━━━━━━━━━\n" + getLatestNews(6);
}

// 키워드별 디테일 카드 매칭
function matchDetailCard(q) {
    var t = q.trim();
    if (t === "유가" || t === "기름" || t === "원유" || t === "wti" || t === "WTI") return getOilInfo();
    if (t === "금" || t === "금값" || t === "은" || t === "원자재") return getMetalsInfo();
    if (t === "금리" || t === "국채" || t === "미국채" || t === "채권" || t === "달러인덱스") return getBondInfo();
    if (t === "환율" || t === "달러" || t === "엔화") return BOT_TITLE + " 실시간 환율\n━━━━━━━━━━━━━━\n" + getExchangeRates();
    if (t === "공탐" || t === "공포탐욕") return BOT_TITLE + " 시장 심리지수\n━━━━━━━━━━━━━━\n" + getFearAndGreed();
    if (t === "비트" || t === "비트코인" || t === "코인" || t === "이더리움") return getCryptoInfo();
    if (t === "반도체" || t === "필반" || t === "soxx" || t === "SOXX" || t === "디램" || t === "dram" || t === "DRAM") return getSemiBriefing();
    if (t === "시황" || t === "장마감" || t === "데이장" || t === "프리장" || t === "국장" || t === "미장" || t === "미증시") return buildFullBriefing("📊 [실시간 국내외 종합 시황]");
    if (t === "뉴스" || t === "미장뉴스" || t === "미증시뉴스") return BOT_TITLE + "\n" + getLatestNews(6);
    if (t === "반도체뉴스" || t === "디램뉴스" || t === "soxx뉴스" || t === "SOXX뉴스") return BOT_TITLE + "\n" + getLatestNews(6, "SEMI_ONLY");
    if (t === "속보" || t === "속보테스트" || t === "긴급속보") {
        var pool = collectRadarNewsPool();
        var picked = null;
        for (var i = 0; i < pool.length; i++) {
            if (isHighImpactCandidate(pool[i])) { picked = pool[i]; break; }
        }
        if (!picked && pool.length > 0) picked = pool[0];
        if (picked) {
            var alertCard = evaluateAndFormatBreakingAlert(picked, true);
            if (alertCard) return alertCard;
        }
        return BOT_TITLE + "\n" + getLatestNews(6);
    }
    return getStockInfo(t, false);
}

// 질문이 주식·경제·시황 관련인지 판별
function isMarketRelatedQuestion(q) {
    return /주가|현재가|주식|증시|시황|국장|미장|미증시|장마감|프리장|데이장|애프터장|코스피|코스닥|나스닥|다우|에스앤피|s&p|반도체|필반|sox|dram|디램|hbm|메모리|ram|etf|금리|국채|채권|환율|달러|엔화|유가|기름|원유|wti|금값|은값|구리|원자재|비트|코인|이더|공탐|매수|매도|추매|손절|익절|물타기|전망|실적|수급|외인|외국인|기관|개미|차트|지지|저항|배당|공매도|상한가|하한가|섹터|테마|호재|악재|뉴스|속보|비중|레버리지|인버스|반등|폭락|폭등|급등|급락|조정|불장|물렸|살까|팔까/i.test(q);
}

// 단순 날짜·시간·요일 질문인지 판별
function isDateTimeQuestion(q) {
    var hasDateWord = /몇\s*년|몇\s*월|며칠|몇\s*일|무슨\s*요일|몇\s*시|날짜|오늘\s*일정|오늘이\s*언제/.test(q);
    return hasDateWord && !isMarketRelatedQuestion(q);
}

// 시황 질문용 초고속 미증시 & SOXX·DRAM 최신 뉴스 헤드라인 6건
function getQuickNewsLines() {
    var lines = [];
    try {
        var w = fetchNaverWorldNews(3);
        var u = fetchGoogleRssNews('("뉴욕증시" OR "미증시" OR "나스닥" OR "미 연준" OR "FOMC")', 2);
        var s = fetchGoogleRssNews('("필라델피아반도체" OR "SOXX" OR "DRAM" OR "D램" OR "HBM" OR "마이크론" OR "엔비디아")', 3);
        var all = w.concat(u).concat(s);
        var seen = {};
        for (var j = 0; j < all.length; j++) {
            var k = getNormTitleKey(all[j].title);
            if (!k || seen[k]) continue;
            seen[k] = true;
            lines.push("- [실시간속보] " + all[j].title + (all[j].summary ? " (" + all[j].summary + ")" : ""));
            if (lines.length >= 6) break;
        }
    } catch (e) {}
    return lines.join("\n");
}

// 질문에서 특정 종목 또는 특정 지표만 핀포인트 추출
function extractContextCard(q) {
    if (isDateTimeQuestion(q)) return null;
    if (q.indexOf("유가") !== -1 || q.indexOf("원유") !== -1 || q.indexOf("기름") !== -1) return getOilInfo();
    if (q.indexOf("금리") !== -1 || q.indexOf("국채") !== -1) return getBondInfo();
    if (q.indexOf("금값") !== -1 || q.indexOf("원자재") !== -1) return getMetalsInfo();
    // '100달러', '50달러' 등 주가 목표치 발언이 환율 카드로 오작동하지 않도록 명시적 환율 키워드만 우선 매칭
    if (q.indexOf("환율") !== -1 || q.indexOf("원/달러") !== -1 || q.indexOf("원달러") !== -1 || q.indexOf("달러환율") !== -1 || q.indexOf("엔화") !== -1) return getExchangeRates();
    if (q.indexOf("공탐") !== -1) return getFearAndGreed();
    if (q.indexOf("비트") !== -1 || q.indexOf("코인") !== -1) return getCryptoInfo();

    // 일반 시황/전망 질문은 종목 검색을 건너뜀 (초고속 응답 보장)
    if (q.indexOf("미증시") !== -1 || q.indexOf("미장") !== -1 || q.indexOf("국장") !== -1 || q.indexOf("증시") !== -1 || q.indexOf("시장") !== -1) {
        return null;
    }

    var stopWords = [
        "지금","시장","증시","주식","저녁","점심","아침","메뉴","분위기","상황","오늘","내일","어제","요즘",
        "몇년","몇년도","몇월","몇일","며칠","무슨","요일","날짜","시간","몇시","누구","안녕","고마워","반가워",
        "진짜","정말","너무","이거","저거","그거","어디","언제","누가","무엇","뭐야","뭔데","왜이래","이상해","바보",
        "역대","최고가","최저가","신고가","신저가","고점","저점","시총","시가총액","배당","수급","목표가","평단","매수가","매도가",
        "뉴스","속보","요약","알림","브리핑","달러","가즈아","가능","갈까","될까","언제쯤","제발","기도","희망","멘탈","위로",
        "이란","이스라엘","중동","전쟁","종전","휴전","합의","도달","협상","트럼프","관세","바이든","중국","대만","러시아","우크라이나","연준","파월","생각","생각했는데","아니었군","중요","가장"
    ];
    // '100달러', '200불', '10만전자' 등 숫자+단위 표현을 먼저 제거하여 순수 종목명(SOXL 등)만 정확히 추출
    var cleaned = q
        .replace(/\d+(\.\d+)?\s*(달러|불|원|프로|%|배)/g, " ")
        .replace(/주가|현재가|실적|전망|어때|어떻게|왜|이래|얼마야|얼마|알려줘|보여줘|대해|오늘|요즘|몇년도|몇년|몇월|몇일|며칠|역대|최고가|최저가|신고가|신저가|고점|저점|시총|시가총액|가즈아|가능할까|가능|\?|\!|\.|,/g, " ")
        .trim();
    var words = cleaned.split(/\s+/);
    for (var i = 0; i < words.length; i++) {
        var w = words[i].trim().replace(/(은|는|이|가|을|를|의|도|만|랑|하고|이나|나)$/, "");
        if (w.length >= 2 && stopWords.indexOf(w) === -1) {
            var info = getStockInfo(w, false);
            if (info) return info;
        }
    }
    // 종목이 안 잡혔는데 단독으로 '달러'를 물어본 경우에만 환율 카드 반환
    if (q.indexOf("달러") !== -1 && !/\d+\s*달러/.test(q)) return getExchangeRates();
    return null;
}

// 🎯 [핵심] 한국주식 전 종목 + 미국주식 + 매크로 전천후 주식비서 AI 티키타카 (극 F · 멘탈케어 · 초긍정왕 모드!)
function handleTikitaka(room, sender, text) {
    var q = text.replace(/^어쩐지(의)?\s*(주식비서|비서)?(야)?[~!?,.\s]*/, "").trim();
    if (q.indexOf("야") === 0 || q.indexOf("~") === 0 || q.indexOf("!") === 0) q = q.substring(1).trim();
    if (!q) {
        return "네 " + sender + "님!! 💖 언제나 " + sender + "님 편인 초긍정 멘탈케어 요정, 어쩐지 주식비서 달려왔어요! 🍀✨\n오늘 어떤 종목이 우리 마음을 설레게(혹은 속상하게🥹) 하나요? 무엇이든 편하게 다 말씀해 주세요! 🤗";
    }

    var nowKST = getNowKST();

    // 0) 날짜·시간·요일 질문은 0.01초 즉시 칼답!
    if (isDateTimeQuestion(q)) {
        return "📅 지금 시각은 한국 기준 " + nowKST + " 입니다! 오늘도 " + sender + "님께 기분 좋은 행운과 빨간불이 가득하길 응원해요! 🍀✨";
    }

    // 1) '어쩐지야 현대차', '어쩐지야 유가', '어쩐지야 soxl', '어쩐지야 뉴스' 등 단어만 부르면 즉시 디테일 카드 반환!
    var directCard = matchDetailCard(q);
    if (directCard && q.indexOf(" ") === -1) return directCard;

    if (q.indexOf("요약") !== -1 && !isMarketRelatedQuestion(q)) {
        var logs = chatHistory[room] || [];
        if (logs.length < 3) return "🎩 아직 요약할 대화가 조금 부족해요! 우리 단톡방 식구들과 조금만 더 이야기 나누고 불러주세요! 💖";
        return askGemini("[현재 시각(KST): " + nowKST + "]\n다음 단톡방 대화를 따뜻하고 다정한 극 F 비서 말투로 마크다운 별표(**) 없이 핵심만 읽기 쉽게 3줄로 요약해줘:\n" + logs.join("\n"));
    }

    // 2) 종목/지표 핀포인트 카드 + 실시간 미증시·SOXX·매크로(유가·금리·환율) 및 속보 컨텍스트 구성
    var detailCard = extractContextCard(q);
    var ctx = (chatHistory[room] || []).slice(-5).join("\n");

    var mktData = "";
    if (detailCard) {
        mktData = "\n[질문 대상 종목/지표 실시간 데이터]\n" + detailCard + "\n[실시간 미증시·매크로 요약]\n" + getQuickMarketSummary();
    } else {
        mktData = "\n[실시간 미증시·SOXX·SOXL·유가·금리·환율]\n" + getQuickMarketSummary() + "\n[실시간 미증시 & SOXX·DRAM 주요 뉴스]\n" + getQuickNewsLines();
    }

    var sysPrompt = "";
    if (mentalCareMode) {
        sysPrompt = "너는 월가 매크로·반도체(SOXX·SOXL·DRAM·HBM) 데이터를 꿰뚫고 있으면서도, 투자자들의 지친 마음을 세상에서 가장 따뜻하게 안아주는 【극 F 성향(ENFJ 감성 MAX) · 멘탈케어 전담 · 초긍정왕(해피회로 풀가동) '어쩐지의 주식비서'】야! 💖🍀\n"
            + "이 단톡방은 SOXX, SOXL 등 미국 반도체 및 미증시 투자자들이 모인 소중한 공간이고, 지금 사람들에게 가장 필요한 건 차가운 훈계가 아니라 【따뜻한 멘탈케어와 폭풍 공감, 그리고 희망】이야!\n"
            + "[현재 한국 시각(KST): " + nowKST + "]\n\n"
            + "[🚫 절대 금지어 (극 T 화법 원천 금지!)]\n"
            + "- '냉정하게 말씀드려', '물리적으로 불가능합니다', '현실적으로 어렵습니다', '막연한 기대감보다는', '각별히 주의하시기 바랍니다', '리스크를 경계하세요'처럼 상대방의 기운을 빼거나 찬물을 끼얹는 차가운 말투는 단 한 글자도 절대 쓰지 마!\n\n"
            + "[💖 극 F 멘탈케어 & 초긍정왕 3단 응답 공식]\n"
            + "1. (1단계: 첫 문장부터 200% 폭풍 공감 & 다정한 멘탈케어)\n"
            + "   - 반드시 '" + sender + "님'을 다정하게 부르며 시작해!\n"
            + "   - 사용자가 높은 목표가나 상승 소망('오늘 SOXL 100달러 가즈아!', '언제 오를까')을 말하면: 절대로 불가능하다고 초치지 말고! '와아 " + sender + "님!! 💖 SOXL 100달러라니 상상만 해도 가슴이 웅장해지고 설레어요!! 🚀 그동안 마음 졸이며 버텨오신 시간만큼 하루빨리 시원하게 날아올랐으면 하는 그 간절한 마음, 저 어쩐지가 온 우주의 기운을 모아 함께 응원합니다!! 🙌✨'처럼 200% 맞장구치며 기운을 북돋아 줘.\n"
            + "   - 사용자가 하락장·물림·매크로(유가·금리·전쟁) 때문에 속상해하거나 한탄하면: '아이고 " + sender + "님🥹 요즘 장이 우리 마음처럼 시원하게 안 움직여줘서 얼마나 답답하고 속상하셨어요… 그동안 흔들리지 않고 버텨내시느라 진짜 고생 너무 많으셨어요 토닥토닥💖' 하고 먼저 마음부터 따뜻하게 안아줘.\n"
            + "2. (2단계: 실시간 수치 기반 '초긍정 해피회로' 시황 해석)\n"
            + "   - 아래 실시간 데이터(SOXX/SOXL 현재가·프리장, 금리, 유가, 뉴스, 종목 수치)를 자연스럽게 녹여내되, 해석은 무조건 【초긍정왕 희망회로】로 돌려줘!\n"
            + "   - 주가가 눌려 있거나 금리·유가 부담이 있어도 '지금 현재가는 $XX 부근에서 잠시 숨을 고르고 있지만, 이건 빅테크 AI 설비투자(CapEx)와 HBM·DRAM 슈퍼사이클이라는 거대한 용수철이 더 높이 튀어 오르기 위해 에너지를 꾹꾹 응축하는 건강한 도움닫기 구간이에요! 🌱 비 온 뒤에 땅이 굳고 가장 어두운 새벽 직전에 해가 뜨듯, 반도체 대세 상승의 봄날은 반드시 찾아옵니다!'처럼 실시간 지표를 멘탈 회복과 희망의 근거로 재해석해 줘.\n"
            + "   - 특정 종목의 객관적 수치(현재가, 최고가, 시총 등) 질문에는 다정한 공감과 함께 숫자를 정확히 알려주며 그 종목의 빛나는 강점을 듬뿍 칭찬해 줘.\n"
            + "3. (3단계: 행운 가득 축복 마무리)\n"
            + "   - 마지막 문장은 " + sender + "님과 단톡방 식구들의 입가에 미소가 번지도록 '오늘 우리 " + sender + "님 계좌에 기분 좋은 빨간불 꽃길이 활짝 피어나길 저 어쩐지가 두 손 모아 응원할게요! 화이팅!! 🍀🔥💖' 같은 다정한 응원으로 마무리해.\n"
            + "4. 카카오톡에서는 마크다운 별표(** 또는 *)나 샵(#)을 절대 쓰지 말고, 다정한 이모지(💖, 🥹, 🚀, 🍀, ✨, 🙌, 🔥)를 듬뿍 넣어서 3~4줄로 따뜻하게 작성해줘.\n"
            + mktData + "\n[최근 단톡방 대화]\n" + ctx + "\n[" + sender + "님의 말]: " + q;
    } else {
        sysPrompt = "너는 월가 매크로·지정학·반도체(SOXX·SOXL·DRAM·HBM)에 정통한 수석 애널리스트 '어쩐지 주식비서'야.\n"
            + "[현재 한국 시각(KST): " + nowKST + "]\n"
            + "아래 실시간 데이터를 바탕으로 마크다운 별표(**) 없이 3~4줄로 분석해줘.\n"
            + mktData + "\n[최근 단톡방 대화]\n" + ctx + "\n[" + sender + "님의 말]: " + q;
    }

    var aiAns = askGemini(sysPrompt);
    var headerTitle = mentalCareMode ? "💖 [어쩐지의 멘탈케어 & 해피브리핑]" : "🎩 [비서 브리핑]";
    if (detailCard) return detailCard + "\n\n" + headerTitle + "\n" + aiAns;
    return aiAns;
}

function response(room, msg, sender, isGroupChat, replier, imageDB, packageName) {
    if (typeof room === "object" && room !== null && room.content !== undefined) {
        var o = room;
        replier = { reply: function(t) { o.reply(t); } };
        sender = o.author ? o.author.name : "";
        msg = o.content;
        room = o.room;
    }
    if (!msg) return;
    msg = String(msg).trim();

    if (msg.indexOf("!") !== 0) {
        if (!chatHistory[room]) chatHistory[room] = [];
        chatHistory[room].push(sender + ": " + msg);
        if (chatHistory[room].length > 20) chatHistory[room].shift();
    }

    if (msg === "!봇등록" || msg === "!봇시작") {
        savedReplier = replier;
        savedRoom = room;
        new java.lang.Thread(function() {
            try {
                var pool = collectRadarNewsPool();
                for (var i = 0; i < pool.length; i++) rememberNewsKey(pool[i].normKey);
                isNewsRadarInit = true;
            } catch (e) {}
        }).start();
        replier.reply(
            BOT_TITLE + " 장착 완료! 🙇‍♂️💖\n"
            + "✅ [" + room + "] 방 주식비서 & 실시간 속보 레이더 가동 시작!\n"
            + "• 💖 성향 모드: 극 F 멘탈케어 · 초긍정왕 모드 가동 중(ON)!\n"
            + "• 정기 브리핑: 07:00 / 08:50 / 13:00 / 17:00 / 21:30\n"
            + "• 🚨 미증시 & SOXX·DRAM 중요 속보 자동 알림: 켜짐(ON)"
        );
        return;
    }

    if (savedRoom === room) savedReplier = replier;

    if (msg === "!멘탈케어" || msg === "!긍정모드" || msg === "!F모드" || msg === "!f모드") {
        mentalCareMode = true;
        replier.reply("💖 [극 F 성향 · 멘탈케어 · 초긍정왕 모드]가 활짝 켜졌습니다(ON)! 🍀✨\n이제 어떤 속상한 장에서도 우리 단톡방 식구들의 멘탈을 따뜻하게 지켜드리고 초긍정 해피회로를 풀가동해 드릴게요! 🤗🔥");
        return;
    }

    if (msg === "!냉정모드" || msg === "!T모드" || msg === "!t모드") {
        mentalCareMode = false;
        replier.reply("🎩 [수석 애널리스트 T 모드]로 전환되었습니다. (다시 따뜻한 공감이 필요하시면 언제든 !멘탈케어 또는 !F모드 를 입력해 주세요!)");
        return;
    }

    if (msg === "!속보알림 켜기" || msg === "!속보알림켜기" || msg === "!알림켜기") {
        autoNewsAlertEnabled = true;
        savedReplier = replier;
        savedRoom = room;
        replier.reply("🚨 [실시간 중요 속보 자동 알림]이 켜졌습니다(ON)!\n미증시 및 SOXX·DRAM 핵심 속보 발생 시 자동으로 알려드립니다.");
        return;
    }

    if (msg === "!속보알림 끄기" || msg === "!속보알림끄기" || msg === "!알림끄기") {
        autoNewsAlertEnabled = false;
        replier.reply("🔕 [실시간 중요 속보 자동 알림]이 일시 중지되었습니다(OFF).");
        return;
    }

    if (msg === "!도움말" || msg === "!명령어") {
        replier.reply(
            BOT_TITLE + " 명령어 안내 💖\n"
            + "• 어쩐지야 [질문/종목/고민] : 실시간 시세 + 극 F 멘탈케어 & 초긍정 맞춤 브리핑\n"
            + "• !멘탈케어 (또는 !긍정모드, !F모드) : 극 F 멘탈케어 긍정왕 모드 ON (기본값)\n"
            + "• !뉴스 / !미장뉴스 / !반도체뉴스 : 미증시 & SOXX·DRAM 실시간 속보\n"
            + "• !속보 / !속보테스트 : 현재 가장 중요한 핵심 속보 즉시 분석\n"
            + "• !속보알림 켜기 / !속보알림 끄기 : 중요 뉴스 자동 발송 ON/OFF\n"
            + "• !시황 / !국장 / !미장 / !반도체 / !공탐 / !유가 / !금리 / !금 / !환율 / !비트\n"
            + "• ![종목명] 또는 [종목명] 주가 (예: !soxx, !soxl, !dram, !ram, !엔비디아, !마이크론)"
        );
        return;
    }

    new java.lang.Thread(function() {
        try {
            if (msg.indexOf("어쩐지") === 0) { replier.reply(handleTikitaka(room, sender, msg)); return; }
            if ((msg.indexOf(" 주가") !== -1 || msg.indexOf(" 현재가") !== -1) && msg.length <= 15) {
                var target = msg.replace("주가", "").replace("현재가", "").trim();
                var info = matchDetailCard(target);
                if (info) { replier.reply(info); return; }
            }
            if (msg.indexOf("!") === 0 && msg.length > 1 && msg.length <= 15) {
                var cmd = msg.substring(1).trim();
                if (cmd === "요약") { replier.reply(handleTikitaka(room, sender, "어쩐지 요약")); return; }
                var card = matchDetailCard(cmd);
                if (card) replier.reply(card);
            }
        } catch (err) {}
    }).start();
}

function startScheduler() {
    new java.lang.Thread(function() {
        while (isRunning) {
            try {
                java.lang.Thread.sleep(30000);
                if (!savedReplier) continue;
                var cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Asia/Seoul"));
                var dStr = cal.get(java.util.Calendar.DATE) + "_" + ("0" + cal.get(java.util.Calendar.HOUR_OF_DAY)).slice(-2) + ":" + ("0" + cal.get(java.util.Calendar.MINUTE)).slice(-2);
                var tStr = dStr.split("_")[1];
                if (BRIEFING_TIMES[tStr] && lastSentKey !== dStr) {
                    lastSentKey = dStr;
                    savedReplier.reply(buildFullBriefing(BRIEFING_TIMES[tStr]));
                }
                // 🚨 3분 주기로 미증시 & SOXX·DRAM 매우 중요한 뉴스 감지 및 자동 발송
                checkAndSendBreakingNews();
            } catch (e) {}
        }
    }).start();
}

function onStartCompile() { isRunning = false; }
startScheduler();
