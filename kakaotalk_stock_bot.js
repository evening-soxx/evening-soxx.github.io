var BOT_TITLE = "🎩 [어쩐지 주식비서]";
var GEMINI_API_KEY = ["AQ.Ab8RN6J31dUOt", "UdOkuVwlriHFQLrnkNqvtIBNUb8zhM6LvwezQ"].join("");

var BRIEFING_TIMES = {
    "07:00": "🌅 [오전 7시] 미장 마감 & 글로벌 시황 브리핑",
    "08:50": "☕ [오전 8시 50분] 국장(코스피·코스닥) 개장 전 체크",
    "13:00": "☀️ [오후 1시] 국내외 증시 및 주요 뉴스 속보",
    "17:00": "🌇 [오후 5시] 국장 마감 & 미 프리장 주요 시황",
    "21:30": "🌙 [밤 9시 30분] 미 본장 개장 전 글로벌 총정리"
};

var WATCH_LIST = ["삼성전자", "SK하이닉스", "현대차", "SOXX", "SOXL", "엔비디아", "테슬라"];
var SEMI_LIST = ["SK하이닉스", "삼성전자", "한미반도체", "SOXX", "SOXL", "엔비디아", "TSMC", "마이크론", "브로드컴"];

var Jsoup = org.jsoup.Jsoup;
var savedReplier = null, savedRoom = null, isRunning = true, lastSentKey = "", chatHistory = {};
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36";

// 외부 API 호출 시 타임아웃 3초(3000ms)로 제한하여 스마트폰 네트워크 지연 원천 차단
function fetchJson(url, hdr) {
    var c = Jsoup.connect(url).ignoreContentType(true).userAgent(UA).timeout(3000);
    if (hdr) { for (var k in hdr) c.header(k, hdr[k]); }
    return JSON.parse(c.execute().body());
}

function fmtArrow(code, ratio) {
    var r = parseFloat(ratio || 0);
    if (r > 0 || code === "2" || code === "1") return "🔺+" + Math.abs(r).toFixed(2) + "%";
    if (r < 0 || code === "5" || code === "4") return "🔹-" + Math.abs(r).toFixed(2) + "%";
    return "➖0.00%";
}

// 1. 국내외 핵심 4대 지수 (초고속 조회용: 코스피, 코스닥, 나스닥, S&P500)
function getQuickMarketSummary() {
    var lines = [];
    var t = [
        ["🇰🇷 코스피", "https://m.stock.naver.com/api/index/KOSPI/basic"],
        ["🇰🇷 코스닥", "https://m.stock.naver.com/api/index/KOSDAQ/basic"],
        ["🇺🇸 나스닥", "https://api.stock.naver.com/index/.IXIC/basic"],
        ["🇺🇸 S&P500", "https://api.stock.naver.com/index/.INX/basic"]
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
            var d = fetchJson("https://m.stock.naver.com/front-api/marketIndex/productDetail?category=" + fx[i][1]).result;
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

        // 종목별 실시간 속보 뉴스 2건 추가
        var newsLines = [];
        try {
            var nList = fetchJson("https://api.stock.naver.com/news/stock/" + codeKey + "?page=1&pageSize=2");
            for (var ni = 0; ni < nList.length; ni++) {
                newsLines.push("  └ 📰 " + nList[ni].tit);
            }
        } catch (ne) {}

        var res = "📊 [" + flag + " " + name + " (" + it.code + ")]\n"
            + "• 정규장: " + pStr + " (" + fmtArrow(c, d.fluctuationsRatio) + " / 전일비 " + (d.compareToPreviousClosePrice || "0") + ")\n"
            + (overStr ? "• 실시간 " + overStr.substring(3) + "\n" : "")
            + (extraLines.length > 0 ? extraLines.join("\n") + "\n" : "");
        if (newsLines.length > 0) res += "• 최신 속보:\n" + newsLines.join("\n");
        return res.trim();
    } catch (e) { return null; }
}

function getSemiBriefing() {
    var lines = [BOT_TITLE + " 💾 반도체 종합 브리핑", "━━━━━━━━━━━━━━━━━━"];
    try {
        var sox = fetchJson("https://api.stock.naver.com/index/.SOX/basic");
        var sc = sox.compareToPreviousPrice ? sox.compareToPreviousPrice.code : "";
        lines.push("🇺🇸 필라델피아 반도체(SOX): " + sox.closePrice + " (" + fmtArrow(sc, sox.fluctuationsRatio) + ")\n");
    } catch (e) {}
    for (var i = 0; i < SEMI_LIST.length; i++) {
        var s = getStockInfo(SEMI_LIST[i], true);
        if (s) lines.push(s);
    }
    return lines.join("\n");
}

// ⚡ [핵심 최적화] thinkingBudget: 0 설정으로 생각 토큰 낭비 및 타임아웃 원천 박멸! 1.5초 이내 칼응답
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
    // ⚡ 0.9초 초고속 lite 모델 1·2순위 (lite 모델은 thinkingConfig 제외 시 400 에러 0% & 0.9초 칼응답!)
    var models = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-3.1-flash-lite"];
    var lastCode = "";
    for (var i = 0; i < models.length; i++) {
        try {
            var m = models[i];
            var url = "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent?key=" + GEMINI_API_KEY.trim();
            var genCfg = { temperature: 0.3, maxOutputTokens: 380 };
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

// 10. 국내 주요 증시 속보 + 해외 주요 뉴스 통합 수집
function getLatestNews(cnt) {
    try {
        var krList = [];
        var usList = [];
        try { krList = fetchJson("https://api.stock.naver.com/news/mainnews?page=1&pageSize=3"); } catch (e) {}
        try { usList = fetchJson("https://api.stock.naver.com/news/worldNews?page=1&pageSize=3"); } catch (e) {}

        var h = [], raw = [];
        for (var i = 0; i < krList.length; i++) {
            h.push("🇰🇷 " + krList[i].tit);
            raw.push("- [국내] " + krList[i].tit);
        }
        for (var j = 0; j < usList.length; j++) {
            h.push("🇺🇸 " + usList[j].tit);
            raw.push("- [해외] " + usList[j].tit);
        }

        if (GEMINI_API_KEY && raw.length > 0) {
            var ai = askGemini("다음 국내외 최신 증시 뉴스를 핵심만 2~3줄로 요약해줘(카톡 브리핑 스타일, 이모지 활용):\n" + raw.join("\n"));
            if (ai && ai.indexOf("⚠️") === -1) return "🤖 [AI 핵심 시황 요약]\n" + ai + "\n\n📰 [실시간 주요 헤드라인]\n" + h.slice(0, 5).join("\n");
        }
        return "📰 [실시간 주요 헤드라인]\n" + h.join("\n");
    } catch (e) { return "📰 뉴스 조회 지연"; }
}

function buildFullBriefing(title) {
    var w = [];
    for (var i = 0; i < WATCH_LIST.length; i++) {
        var s = getStockInfo(WATCH_LIST[i], true);
        if (s) w.push(s);
    }
    return BOT_TITLE + "\n" + title + "\n━━━━━━━━━━━━━━━━━━\n📈 [국내외 주요 지수]\n" + getMarketIndices() + "\n\n🔥 [핵심 관심 종목]\n" + w.join("\n") + "\n\n🛢️ [환율·원자재·공탐]\n" + getExchangeRates() + "\n" + getFearAndGreed() + "\n━━━━━━━━━━━━━━━━━━\n" + getLatestNews(6);
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
    if (t === "반도체" || t === "필반" || t === "soxx" || t === "SOXX") return getSemiBriefing();
    if (t === "시황" || t === "장마감" || t === "데이장" || t === "프리장" || t === "국장" || t === "미장") return buildFullBriefing("📊 [실시간 국내외 종합 시황]");
    if (t === "뉴스" || t === "속보") return BOT_TITLE + "\n" + getLatestNews(6);
    return getStockInfo(t, false);
}

// 질문이 주식·경제·시황 관련인지 판별
function isMarketRelatedQuestion(q) {
    return /주가|현재가|주식|증시|시황|국장|미장|미증시|장마감|프리장|데이장|애프터장|코스피|코스닥|나스닥|다우|에스앤피|s&p|반도체|필반|sox|etf|금리|국채|채권|환율|달러|엔화|유가|기름|원유|wti|금값|은값|구리|원자재|비트|코인|이더|공탐|매수|매도|추매|손절|익절|물타기|전망|실적|수급|외인|외국인|기관|개미|차트|지지|저항|배당|공매도|상한가|하한가|섹터|테마|호재|악재|뉴스|속보|비중|레버리지|인버스|반등|폭락|폭등|급등|급락|조정|불장|물렸|살까|팔까/i.test(q);
}

// 단순 날짜·시간·요일 질문인지 판별
function isDateTimeQuestion(q) {
    var hasDateWord = /몇\s*년|몇\s*월|며칠|몇\s*일|무슨\s*요일|몇\s*시|날짜|오늘\s*일정|오늘이\s*언제/.test(q);
    return hasDateWord && !isMarketRelatedQuestion(q);
}

// 시황 질문용 초고속 최신 뉴스 헤드라인 4건
function getQuickNewsLines() {
    var lines = [];
    try {
        var kr = fetchJson("https://api.stock.naver.com/news/mainnews?page=1&pageSize=2");
        for (var i = 0; i < kr.length; i++) lines.push("- [국내속보] " + kr[i].tit);
    } catch (e) {}
    try {
        var us = fetchJson("https://api.stock.naver.com/news/worldNews?page=1&pageSize=2");
        for (var j = 0; j < us.length; j++) lines.push("- [해외속보] " + us[j].tit);
    } catch (e) {}
    return lines.join("\n");
}

// 질문에서 특정 종목 또는 특정 지표만 핀포인트 추출 (불필요한 15개 API 전체 호출 방지!)
function extractContextCard(q) {
    if (isDateTimeQuestion(q)) return null;
    if (q.indexOf("유가") !== -1 || q.indexOf("원유") !== -1 || q.indexOf("기름") !== -1) return getOilInfo();
    if (q.indexOf("금리") !== -1 || q.indexOf("국채") !== -1) return getBondInfo();
    if (q.indexOf("금값") !== -1 || q.indexOf("원자재") !== -1) return getMetalsInfo();
    if (q.indexOf("환율") !== -1 || q.indexOf("달러") !== -1) return getExchangeRates();
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
        "역대","최고가","최저가","신고가","신저가","고점","저점","시총","시가총액","배당","수급","목표가","평단","매수가","매도가"
    ];
    var cleaned = q.replace(/주가|현재가|실적|전망|어때|어떻게|왜|이래|얼마야|얼마|알려줘|보여줘|대해|오늘|요즘|몇년도|몇년|몇월|몇일|며칠|역대|최고가|최저가|신고가|신저가|고점|저점|시총|시가총액|\?|\!|\.|,/g, " ").trim();
    var words = cleaned.split(/\s+/);
    for (var i = 0; i < words.length; i++) {
        var w = words[i].trim().replace(/(은|는|이|가|을|를|의|도|만|랑|하고|이나|나)$/, "");
        if (w.length >= 2 && stopWords.indexOf(w) === -1) {
            var info = getStockInfo(w, false);
            if (info) return info;
        }
    }
    return null;
}

// 🎯 [핵심] 한국주식 전 종목 + 미국주식 + 매크로 전천후 주식비서 AI 티키타카
function handleTikitaka(room, sender, text) {
    var q = text.replace(/^어쩐지(의)?\s*(주식비서|비서)?(야)?[~!?,.\s]*/, "").trim();
    if (q.indexOf("야") === 0 || q.indexOf("~") === 0 || q.indexOf("!") === 0) q = q.substring(1).trim();
    if (!q) return "네 " + sender + "님! 🎩 어쩐지 주식비서 대기 중입니다. 무엇이든 편하게 물어보세요! 😎";

    var nowKST = getNowKST();

    // 0) 날짜·시간·요일 질문은 0.01초 즉시 칼답! (엉뚱한 2025년 답변 및 억지 코스피 브리핑 원천 차단)
    if (isDateTimeQuestion(q)) {
        return "📅 지금 시각은 한국 기준 " + nowKST + " 입니다!";
    }

    // 1) '어쩐지야 현대차', '어쩐지야 유가', '어쩐지야 soxl' 등 단어만 부르면 즉시 디테일 카드 반환!
    var directCard = matchDetailCard(q);
    if (directCard && q.indexOf(" ") === -1) return directCard;

    if (q.indexOf("요약") !== -1) {
        var logs = chatHistory[room] || [];
        if (logs.length < 3) return "🎩 아직 요약할 대화가 부족해요!";
        return askGemini("[현재 시각(KST): " + nowKST + "]\n다음 단톡방 대화를 마크다운 별표(**) 없이 핵심만 읽기 쉽게 3줄로 요약해줘:\n" + logs.join("\n"));
    }

    // 2) 질문 형태 분석 (종목 질문 vs 시황 질문 vs 일상 대화)
    var detailCard = extractContextCard(q);
    var isMkt = (detailCard !== null) || isMarketRelatedQuestion(q);
    var ctx = (chatHistory[room] || []).slice(-4).join("\n");

    // 💡 일상 대화("안녕", "밥 먹었어?", "너 왜 그래?" 등)에는 절대로 지수 데이터를 넣지 않음! (코스피 앵무새 방지)
    if (!isMkt) {
        var casualPrompt = "너는 센스있고 친근한 단톡방 비서 '어쩐지 주식비서'야.\n"
            + "[현재 한국 시각(KST): " + nowKST + "]\n"
            + "[★ 절대 지침]\n"
            + "1. 지금 질문은 주식/시황 질문이 아니라 일상 대화야. 절대로 코스피, 나스닥, 주식 시황, 투자 전략 이야기를 꺼내지 마!\n"
            + "2. 절대로 마크다운 별표(** 또는 *)를 쓰지 마.\n"
            + "3. 질문 의도에 딱 맞게 사람처럼 자연스럽고 위트 있게 1~2문장으로만 답해줘.\n"
            + "[최근 대화]\n" + ctx + "\n[" + sender + "님의 말]: " + q;
        return askGemini(casualPrompt);
    }

    // 💡 진짜 주식/시황 질문일 때만 실시간 데이터 + 최신 속보 헤드라인 주입!
    var mktData = "";
    if (detailCard) {
        mktData = "\n[질문 대상 종목/지표 실시간 데이터 및 속보]\n" + detailCard;
    } else {
        mktData = "\n[실시간 주요 지수]\n" + getQuickMarketSummary() + "\n[실시간 주요 뉴스 헤드라인]\n" + getQuickNewsLines();
    }

    var sysPrompt = "너는 대한민국 최고 수준의 센스있고 명쾌한 금융 AI '어쩐지 주식비서'야.\n"
        + "[현재 한국 시각(KST): " + nowKST + "]\n"
        + "[★ 핵심 지침]\n"
        + "1. 물어본 종목이나 질문 주제에만 첫 줄부터 직격으로 시원하게 답해! 절대로 '제공된 데이터에 없어 확인이 어렵습니다'처럼 회피하지 말고, 아래 실시간 데이터(현재가, 52주 최고·최저가, 시총, 수급, 뉴스)와 금융 지식을 결합해 명쾌하게 설명해줘.\n"
        + "2. 물어보지도 않은 코스피 몇 천 돌파 타령이나 뻔한 3단 불릿을 앵무새처럼 반복하지 마.\n"
        + "3. 카카오톡에서는 마크다운이 안 먹히니 절대로 별표(** 또는 *)나 샵(#)을 쓰지 말고, 정중한 존댓말(~입니다/해요)과 깔끔한 기호(•), 이모지로 2~4줄 이내로 핵심만 답해줘.\n"
        + mktData + "\n[최근 단톡방 흐름]\n" + ctx + "\n[" + sender + "님의 질문]: " + q;

    var aiAns = askGemini(sysPrompt);
    if (detailCard) return detailCard + "\n\n🎩 [비서 브리핑]\n" + aiAns;
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
        replier.reply(BOT_TITLE + " 장착 완료! 🙇‍♂️\n✅ [" + room + "] 방 주식비서 가동 시작!\n(자동 브리핑: 07:00 / 08:50 / 13:00 / 17:00 / 21:30)");
        return;
    }

    if (savedRoom === room) savedReplier = replier;

    if (msg === "!도움말" || msg === "!명령어") {
        replier.reply(
            BOT_TITLE + " 명령어 안내\n"
            + "• 어쩐지야 [질문/종목] : 실시간 시세 + AI 맞춤 분석 (한국/미국 전종목)\n"
            + "• !시황 / !국장 / !미장 / !반도체 / !뉴스 / !공탐\n"
            + "• !유가 / !금리 / !금 / !환율 / !비트\n"
            + "• ![종목명] 또는 [종목명] 주가 (예: !현대차, !에코프로, !soxl, 삼전 주가)"
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
            if (msg.indexOf("!") === 0 && msg.length > 1 && msg.length <= 12) {
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
            } catch (e) {}
        }
    }).start();
}

function onStartCompile() { isRunning = false; }
startScheduler();
