/**
 * 어쩐지저녁의 SOXX — 반도체 & 매크로 라이브 데스크 클라이언트 엔진
 * - 실시간 전 종목 시세·차트 검색 (한글 종목명 + 글로벌 티커 자동완성)
 * - 실시간 분봉(1M/5M/15M) 및 일봉(1D) 라이브 차트 + 마우스/터치 십자선(Crosshair) 추적
 * - 10초 주기 실시간 틱 자동 추적 (Live Tick Polling)
 * - 모바일 특화 원터치 전환 및 바텀시트(Bottom Sheet) 상세 분석
 */

(function () {
  "use strict";

  function normalizeRawData(raw) {
    if (!raw) return null;
    if (raw.etfs && !Array.isArray(raw.etfs)) return raw;

    const etfsMap = {};
    (raw.etfs || []).forEach((e) => {
      etfsMap[e.symbol] = {
        ...e,
        ticker: e.symbol,
        pct_from_high: e.from_high_pct,
        candles: e.history || [],
        mtt: {
          mtt_pass: Boolean(e.mtt_pass),
          above_sma50: Boolean(e.above_sma50),
          above_sma150: e.sma150 ? e.price > e.sma150 : false,
          above_sma200: Boolean(e.above_sma200),
          sma_aligned: Boolean(e.mtt_pass),
          near_high: (e.from_high_pct || -99) >= -25,
        },
        returns: {
          "1w": e.ret_1w,
          "1m": e.ret_1m,
          "3m": e.ret_3m,
          "6m": e.ret_6m,
          "1y": e.ret_1y,
        },
      };
    });

    const df = raw.dram_flow || {};
    const dram_etf_flow = {
      latest_date: df.latest_date || "",
      latest_aum: df.current_aum,
      latest_aum_krw_trillion: df.current_aum_krw_trillion,
      current_shares: df.current_shares || 0,
      shares_change_1d: df.shares_change_1d || 0,
      inflow_1d_usd: df.inflow_1d_usd || 0,
      inflow_5d_usd: df.inflow_5d_usd,
      inflow_20d_usd: df.inflow_20d_usd,
      top_holdings: (df.holdings || [])
        .filter((h) => Number(h.weight) > 0)
        .map((h) => ({
          ticker: h.ticker,
          name: h.name,
          weight_pct: h.weight,
        })),
    };

    const macros = (raw.macros || []).map((m) => ({
      ...m,
      key: m.symbol,
      status_level: m.status_code === "danger" ? "warn" : m.status_code === "caution" ? "caution" : "good",
      status_label: m.status || "안정",
      impact_note: m.impact_desc || "",
      candles: m.history || [],
    }));

    const holdings = (raw.holdings || []).map((h) => ({
      ...h,
      ticker: h.symbol,
      subsector: h.sub_sector || "",
      foreign_ratio: h.foreign_rate,
      pct_from_high: h.from_high_pct,
      role_note: h.note || "",
      candles: h.history || [],
      mtt: { mtt_pass: Boolean(h.mtt_pass) },
      returns: {
        "1w": h.ret_1w,
        "1m": h.ret_1m,
        "3m": h.ret_3m,
        "6m": h.ret_6m,
        "1y": h.ret_1y,
      },
    }));

    const b = raw.briefing || {};
    const briefing = {
      regime: b.signal_label || "중립 · 선별 대응",
      headline: b.headline || "",
      points: (b.pillars || []).map((p) => `<strong>${p.title}</strong> — ${p.body}`),
    };

    const news = (raw.news || []).map((n) => ({
      ...n,
      pub_date: n.date || "",
    }));

    return {
      updated_at_kst: raw.updated_at || "",
      briefing,
      etfs: etfsMap,
      dram_etf_flow,
      macros,
      holdings,
      news,
    };
  }

  const state = {
    data: normalizeRawData(window.SOXX_RAM_DATA || window.SOXX_RAM_INTELLIGENCE || null),
    selectedEtf: "SOXX",
    holdingFilter: "ALL",
    holdingSort: "default",
    newsFilter: "ALL",
    theme: localStorage.getItem("evening_soxx_theme_v2") || "light",
    colorMode: localStorage.getItem("evening_soxx_color") || "kr",
    fontScale: parseFloat(localStorage.getItem("evening_soxx_font") || "1"),

    chartSymbol: "SOXX",
    chartCnbcSymbol: "SOXX",
    chartName: "iShares 미국 반도체 ETF",
    chartCurrency: "USD",
    chartInterval: "1M", // 기본 디폴트: 1분봉 ('1M' | '5M' | '15M' | '1D')
    chartCandles: [],
    chartSupport20: null,
    chartResistance20: null,
    chartHoverIdx: -1,
    liveTracking: true,
    liveQuote: null,
    newsRefreshMinutes: parseInt(localStorage.getItem("evening_soxx_news_iv") || "5", 10) || 5,
    newsRefreshTimer: null,
  };

  // 주요 한국·미국 반도체 및 인기 ETF 한글 검색 사전
  const KR_TICKER_DICT = [
    { symbol: "SOXX", cnbc: "SOXX", name: "iShares 미국 반도체 ETF", exch: "NASDAQ", cur: "USD" },
    { symbol: "RAM", cnbc: "RAM", name: "T-REX 2X 롱 DRAM 데일리 타깃 ETF", exch: "CBOE", cur: "USD" },
    { symbol: "DRAM", cnbc: "DRAM", name: "Roundhill 글로벌 메모리 ETF (RAM 모펀드)", exch: "NASDAQ", cur: "USD" },
    { symbol: "SOXL", cnbc: "SOXL", name: "Direxion 미국 반도체 3배 레버리지 ETF", exch: "NYSE", cur: "USD" },
    { symbol: "SOXS", cnbc: "SOXS", name: "Direxion 미국 반도체 3배 인버스 ETF", exch: "NYSE", cur: "USD" },
    { symbol: "SMH", cnbc: "SMH", name: "VanEck 반도체 ETF", exch: "NASDAQ", cur: "USD" },
    { symbol: "NVDL", cnbc: "NVDL", name: "GraniteShares 엔비디아 2배 레버리지 ETF", exch: "NASDAQ", cur: "USD" },
    { symbol: "QQQ", cnbc: "QQQ", name: "Invesco 나스닥 100 ETF", exch: "NASDAQ", cur: "USD" },
    { symbol: "TQQQ", cnbc: "TQQQ", name: "ProShares 나스닥 100 3배 레버리지 ETF", exch: "NASDAQ", cur: "USD" },
    { symbol: "TLT", cnbc: "TLT", name: "iShares 미 국채 20년+ 장기채 ETF", exch: "NASDAQ", cur: "USD" },
    { symbol: "005930.KS", cnbc: "005930.KS", name: "삼성전자", exch: "KOSPI", cur: "KRW" },
    { symbol: "000660.KS", cnbc: "000660.KS", name: "SK하이닉스", exch: "KOSPI", cur: "KRW" },
    { symbol: "042700.KS", cnbc: "042700.KS", name: "한미반도체", exch: "KOSPI", cur: "KRW" },
    { symbol: "005380.KS", cnbc: "005380.KS", name: "현대자동차", exch: "KOSPI", cur: "KRW" },
    { symbol: "035420.KS", cnbc: "035420.KS", name: "NAVER (네이버)", exch: "KOSPI", cur: "KRW" },
    { symbol: "MU", cnbc: "MU", name: "마이크론 테크놀로지 (Micron)", exch: "NASDAQ", cur: "USD" },
    { symbol: "SNDK", cnbc: "SNDK", name: "샌디스크 (SanDisk · NAND/eSSD)", exch: "NASDAQ", cur: "USD" },
    { symbol: "NVDA", cnbc: "NVDA", name: "엔비디아 (NVIDIA)", exch: "NASDAQ", cur: "USD" },
    { symbol: "AVGO", cnbc: "AVGO", name: "브로드컴 (Broadcom)", exch: "NASDAQ", cur: "USD" },
    { symbol: "AMD", cnbc: "AMD", name: "AMD (어드밴스드 마이크로 디바이시스)", exch: "NASDAQ", cur: "USD" },
    { symbol: "TSM", cnbc: "TSM", name: "TSMC (타이완 세미컨덕터)", exch: "NYSE", cur: "USD" },
    { symbol: "ASML", cnbc: "ASML", name: "ASML 홀딩 (EUV 노광장비)", exch: "NASDAQ", cur: "USD" },
    { symbol: "AMAT", cnbc: "AMAT", name: "어플라이드 머티어리얼즈", exch: "NASDAQ", cur: "USD" },
    { symbol: "LRCX", cnbc: "LRCX", name: "램리서치 (Lam Research)", exch: "NASDAQ", cur: "USD" },
    { symbol: "KLAC", cnbc: "KLAC", name: "KLA 코퍼레이션", exch: "NASDAQ", cur: "USD" },
    { symbol: "QCOM", cnbc: "QCOM", name: "퀄컴 (Qualcomm)", exch: "NASDAQ", cur: "USD" },
    { symbol: "TXN", cnbc: "TXN", name: "텍사스 인스트루먼트", exch: "NASDAQ", cur: "USD" },
    { symbol: "MRVL", cnbc: "MRVL", name: "마벨 테크놀로지 (Marvell)", exch: "NASDAQ", cur: "USD" },
    { symbol: "INTC", cnbc: "INTC", name: "인텔 (Intel)", exch: "NASDAQ", cur: "USD" },
    { symbol: "ADI", cnbc: "ADI", name: "아날로그 디바이스 (Analog Devices)", exch: "NASDAQ", cur: "USD" },
    { symbol: "NXPI", cnbc: "NXPI", name: "NXP 세미컨덕터", exch: "NASDAQ", cur: "USD" },
    { symbol: "MPWR", cnbc: "MPWR", name: "모놀리식 파워 시스템즈", exch: "NASDAQ", cur: "USD" },
    { symbol: "TER", cnbc: "TER", name: "테라다인 (Teradyne · 테스트 장비)", exch: "NASDAQ", cur: "USD" },
    { symbol: "MCHP", cnbc: "MCHP", name: "마이크로칩 테크놀로지", exch: "NASDAQ", cur: "USD" },
    { symbol: "ON", cnbc: "ON", name: "온세미컨덕터 (ON Semi)", exch: "NASDAQ", cur: "USD" },
    { symbol: "ALAB", cnbc: "ALAB", name: "아스테라 랩스 (Astera Labs)", exch: "NASDAQ", cur: "USD" },
    { symbol: "CRDO", cnbc: "CRDO", name: "크레도 테크놀로지 (Credo)", exch: "NASDAQ", cur: "USD" },
    { symbol: "ENTG", cnbc: "ENTG", name: "인테그리스 (Entegris · 소재)", exch: "NASDAQ", cur: "USD" },
    { symbol: "ONTO", cnbc: "ONTO", name: "온토 이노베이션 (Onto · 패키징계측)", exch: "NYSE", cur: "USD" },
    { symbol: "SWKS", cnbc: "SWKS", name: "스카이웍스 솔루션즈", exch: "NASDAQ", cur: "USD" },
    { symbol: "ARM", cnbc: "ARM", name: "ARM 홀딩스", exch: "NASDAQ", cur: "USD" },
    { symbol: "WDC", cnbc: "WDC", name: "웨스턴디지털 (Western Digital)", exch: "NASDAQ", cur: "USD" },
    { symbol: "STX", cnbc: "STX", name: "씨게이트 (Seagate)", exch: "NASDAQ", cur: "USD" },
    { symbol: "TSLA", cnbc: "TSLA", name: "테슬라 (Tesla)", exch: "NASDAQ", cur: "USD" },
    { symbol: "AAPL", cnbc: "AAPL", name: "애플 (Apple)", exch: "NASDAQ", cur: "USD" },
    { symbol: "MSFT", cnbc: "MSFT", name: "마이크로소프트 (Microsoft)", exch: "NASDAQ", cur: "USD" },
    { symbol: "GOOGL", cnbc: "GOOGL", name: "구글 알파벳 (Alphabet)", exch: "NASDAQ", cur: "USD" },
    { symbol: "META", cnbc: "META", name: "메타 (Meta Platforms)", exch: "NASDAQ", cur: "USD" },
    { symbol: "AMZN", cnbc: "AMZN", name: "아마존 (Amazon)", exch: "NASDAQ", cur: "USD" },
    { symbol: "ORCL", cnbc: "ORCL", name: "오라클 (Oracle · AI 클라우드)", exch: "NYSE", cur: "USD" },
    { symbol: "CRWV", cnbc: "CRWV", name: "코어위브 (CoreWeave · AI GPU 클라우드)", exch: "NASDAQ", cur: "USD" },
    { symbol: "PLTR", cnbc: "PLTR", name: "팔란티어 (Palantir)", exch: "NASDAQ", cur: "USD" },
    { symbol: "US10Y", cnbc: "US10Y", name: "미 국채 10년물 금리", exch: "BOND", cur: "PCT" },
    { symbol: "WTI", cnbc: "@CL.1", name: "WTI 국제유가 선물", exch: "NYMEX", cur: "USD" },
    { symbol: "VIX", cnbc: ".VIX", name: "CBOE VIX 변동성 공포지수", exch: "CBOE", cur: "IDX" },
    { symbol: "USDKRW", cnbc: "KRW=", name: "원/달러 환율 (USD/KRW)", exch: "FX", cur: "KRW" },
  ];

  /* ========================================================================
     1. 포맷팅 헬퍼
     ======================================================================== */
  function fmtPrice(val, currency, unit) {
    if (val === null || val === undefined || isNaN(val)) return "-";
    const n = Number(val);
    if (currency === "KRW" || unit === "원") {
      return Math.round(n).toLocaleString("ko-KR") + "원";
    }
    if (unit === "%" || currency === "PCT") {
      return n.toFixed(2) + "%";
    }
    if (unit === "pt" || currency === "IDX") {
      return n.toFixed(2);
    }
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtSignedPct(val) {
    if (val === null || val === undefined || isNaN(val)) return "0.00%";
    const n = Number(val);
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  function fmtSignedChange(chg, pct) {
    const c = Number(chg || 0);
    const p = Number(pct || 0);
    const arrow = p > 0 ? "▲" : p < 0 ? "▼" : "•";
    const sign = p > 0 ? "+" : "";
    const absChg = Math.abs(c) >= 100 ? Math.round(Math.abs(c)).toLocaleString() : Math.abs(c).toFixed(2);
    return `${arrow} ${absChg} (${sign}${p.toFixed(2)}%)`;
  }

  function dirClass(val, isPill) {
    const n = Number(val || 0);
    if (n > 0) return isPill ? "up-pill" : "up-text";
    if (n < 0) return isPill ? "down-pill" : "down-text";
    return "";
  }

  function calcSeriesSMA(closes, period) {
    const res = [];
    for (let i = 0; i < closes.length; i++) {
      if (i + 1 < period) {
        res.push(null);
      } else {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += closes[j];
        res.push(sum / period);
      }
    }
    return res;
  }

  /* ========================================================================
     2. 테마 · 색상 · 글자 크기 및 모바일 UI 초기화
     ======================================================================== */
  function applyPreferences() {
    document.documentElement.setAttribute("data-theme", state.theme);
    document.documentElement.setAttribute("data-color-mode", state.colorMode);
    document.documentElement.style.setProperty("--base-scale", String(state.fontScale));

    const themeText = document.getElementById("themeToggleText");
    if (themeText) {
      themeText.textContent = state.theme === "dark" ? "☀️ 낮모드" : "🌙 저녁모드";
    }
    const colorText = document.getElementById("colorModeText");
    if (colorText) {
      colorText.textContent = state.colorMode === "kr" ? "🇰🇷 적/청" : "🇺🇸 녹/적";
    }
  }

  function bindPreferenceControls() {
    // 모바일에서 히트맵 기본 접기 처리 (화면 스크롤 절약)
    const heatDetails = document.querySelector(".heatmap-accordion");
    if (heatDetails && window.innerWidth <= 768) {
      heatDetails.removeAttribute("open");
    }

    // 시황 요약 접기/펼치기 버튼
    const btnToggleBrief = document.getElementById("btnToggleBriefPoints");
    const briefPoints = document.getElementById("briefPointsList");
    if (btnToggleBrief && briefPoints) {
      btnToggleBrief.addEventListener("click", () => {
        const isHidden = briefPoints.hasAttribute("hidden");
        if (isHidden) {
          briefPoints.removeAttribute("hidden");
          btnToggleBrief.textContent = "접기 ▴";
          btnToggleBrief.setAttribute("aria-expanded", "true");
        } else {
          briefPoints.setAttribute("hidden", "");
          btnToggleBrief.textContent = "펼치기 ▾";
          btnToggleBrief.setAttribute("aria-expanded", "false");
        }
      });
    }

    const btnTheme = document.getElementById("btnThemeToggle");
    if (btnTheme) {
      btnTheme.addEventListener("click", () => {
        state.theme = state.theme === "dark" ? "light" : "dark";
        localStorage.setItem("evening_soxx_theme_v2", state.theme);
        applyPreferences();
        redrawMainChartFromState();
        drawCdsTrajectoryChart();
        renderMacroGrid();
      });
    }

    const btnColor = document.getElementById("btnColorMode");
    if (btnColor) {
      btnColor.addEventListener("click", () => {
        state.colorMode = state.colorMode === "kr" ? "us" : "kr";
        localStorage.setItem("evening_soxx_color", state.colorMode);
        applyPreferences();
        redrawMainChartFromState();
        renderSoxxTreemap();
        renderMacroGrid();
        renderHoldings();
      });
    }

    const btnDown = document.getElementById("btnFontDown");
    const btnUp = document.getElementById("btnFontUp");
    if (btnDown) {
      btnDown.addEventListener("click", () => {
        state.fontScale = Math.max(0.88, Math.round((state.fontScale - 0.06) * 100) / 100);
        localStorage.setItem("evening_soxx_font", String(state.fontScale));
        applyPreferences();
      });
    }
    if (btnUp) {
      btnUp.addEventListener("click", () => {
        state.fontScale = Math.min(1.22, Math.round((state.fontScale + 0.06) * 100) / 100);
        localStorage.setItem("evening_soxx_font", String(state.fontScale));
        applyPreferences();
      });
    }

    const btnRefresh = document.getElementById("btnLiveRefresh");
    if (btnRefresh) {
      btnRefresh.addEventListener("click", () => {
        fetchLiveQuotesFromCNBC(true);
        refreshNewsAndIntelligence(true);
        loadLiveChart(state.chartSymbol, state.chartCnbcSymbol, state.chartName, state.chartInterval, state.chartCurrency);
      });
    }
  }

  /* ========================================================================
     3. 상단 고정 티커 스트립 & 이브닝 시황 노트
     ======================================================================== */
  function renderTopTickerStrip() {
    const d = state.data;
    if (!d) return;
    const badge = document.getElementById("lastUpdatedBadge");
    if (badge && d.updated_at_kst) {
      badge.textContent = `기준: ${d.updated_at_kst}`;
    }

    const track = document.getElementById("topTickerStrip");
    if (!track) return;

    const items = [];
    ["SOXX", "SOXL", "RAM", "DRAM"].forEach((k) => {
      const e = d.etfs && d.etfs[k];
      if (e) {
        items.push({
          label: k,
          val: fmtPrice(e.price, e.currency),
          chg: fmtSignedPct(e.change_pct),
          rawPct: e.change_pct,
          sym: k,
          cnbc: k,
          name: e.name_kr,
          cur: "USD",
        });
      }
    });

    const macroPick = [
      { key: "US10Y", cnbc: "US10Y", cur: "PCT" },
      { key: "WTI", cnbc: "@CL.1", cur: "USD" },
      { key: "VIX", cnbc: ".VIX", cur: "IDX" },
      { key: "USDKRW", cnbc: "KRW=", cur: "KRW" },
    ];
    macroPick.forEach((mp) => {
      const m = (d.macros || []).find((x) => x.key === mp.key);
      if (m) {
        items.push({
          label: m.name_kr.replace("미 국채 ", "").replace(" 선물", "").replace("변동성지수(공포지수)", "VIX"),
          val: fmtPrice(m.price, mp.cur, m.unit),
          chg: fmtSignedPct(m.change_pct),
          rawPct: m.change_pct,
          sym: m.key,
          cnbc: mp.cnbc,
          name: m.name_kr,
          cur: mp.cur,
        });
      }
    });

    ["005930.KS", "000660.KS", "MU", "SNDK", "NVDA"].forEach((tk) => {
      const h = (d.holdings || []).find((x) => x.ticker === tk);
      if (h) {
        items.push({
          label: h.name_kr,
          val: fmtPrice(h.price, h.currency),
          chg: fmtSignedPct(h.change_pct),
          rawPct: h.change_pct,
          sym: h.ticker,
          cnbc: h.ticker,
          name: h.name_kr,
          cur: h.currency || "USD",
        });
      }
    });

    track.innerHTML = items
      .map(
        (it, idx) => `
        <button type="button" class="ticker-item num" data-tksym="${it.sym}" data-tkcnbc="${it.cnbc}" data-tkname="${it.name}" data-tkcur="${it.cur}">
          <span class="ticker-label">${it.label}</span>
          <span class="ticker-val">${it.val}</span>
          <span class="ticker-chg ${dirClass(it.rawPct, false)}">${it.chg}</span>
        </button>
        ${idx < items.length - 1 ? '<span class="ticker-divider">|</span>' : ""}
      `
      )
      .join("");

    track.querySelectorAll(".ticker-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sym = btn.getAttribute("data-tksym");
        const cnbc = btn.getAttribute("data-tkcnbc");
        const name = btn.getAttribute("data-tkname");
        const cur = btn.getAttribute("data-tkcur");
        if (state.activeSectionTab !== "sec-live" && typeof switchActiveSectionTab === "function") {
          switchActiveSectionTab("sec-live", { scrollTop: false, updateHash: true });
        }
        selectTickerForLiveChart(sym, cnbc, name, cur, false);
        const chartPanel = document.querySelector(".chart-panel");
        if (chartPanel) chartPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  function syncDynamicBriefingText() {
    const d = state.data;
    if (!d || !d.briefing) return;
    const soxx = d.etfs?.SOXX;
    const soxl = d.etfs?.SOXL;
    const ram = d.etfs?.RAM;
    const dram = d.etfs?.DRAM;
    const us10y = (d.macros || []).find((m) => m.key === "US10Y");
    const wti = (d.macros || []).find((m) => m.key === "WTI");
    const vix = (d.macros || []).find((m) => m.key === "VIX");
    if (!soxx || !soxl || !ram || !dram) return;

    const fmtS = (v) => (Number(v) >= 0 ? `+${Number(v).toFixed(2)}%` : `${Number(v).toFixed(2)}%`);
    const extNote = soxl.ext_price
      ? ` [시간외 SOXX $${soxx.ext_price?.toFixed(2) || soxx.price} · SOXL $${soxl.ext_price.toFixed(2)}(${fmtS(soxl.ext_change_pct)}) · RAM $${(ram.ext_price || ram.price).toFixed(2)}]`
      : "";

    d.briefing.headline = `SOXX(${fmtS(soxx.change_pct)})·SOXL(${fmtS(soxl.change_pct)})·RAM(${fmtS(ram.change_pct)}) 흐름 속 미 10년물 금리(${us10y?.price ?? "-"}%)·WTI 유가($${wti?.price ?? "-"}) 실시간 점검`;

    const holdings = d.holdings || [];
    const mttCount = holdings.filter((h) => h.mtt?.mtt_pass).length;
    const top3 = [...holdings]
      .sort((a, b) => (b.change_pct || 0) - (a.change_pct || 0))
      .slice(0, 3)
      .map((x) => `${x.name_kr}(${fmtS(x.change_pct)})`)
      .join(", ");
    const aumB = d.dram_etf_flow?.latest_aum ? (d.dram_etf_flow.latest_aum / 1e9).toFixed(2) : "19.19";

    d.briefing.points = [
      `<strong>1. SOXX · SOXL(3X) &amp; RAM(2X) · DRAM 4대 ETF 실시간 판독</strong> — 비메모리·장비 본진인 SOXX는 $${soxx.price.toFixed(2)} (${fmtS(soxx.change_pct)}), 반도체 3배 레버리지 SOXL은 $${soxl.price.toFixed(2)} (${fmtS(soxl.change_pct)}), 메모리 원지수 DRAM ETF는 $${dram.price.toFixed(2)} (${fmtS(dram.change_pct)}), 메모리 2배 레버리지 RAM은 $${ram.price.toFixed(2)} (${fmtS(ram.change_pct)})을 기록 중입니다.${extNote} 핵심 감시 ${holdings.length}개 종목 중 미너비니 정배열(MTT) 충족 종목은 ${mttCount}개입니다.`,
      `<strong>2. 메모리 3대장 (삼성전자 · SK하이닉스 · 마이크론) &amp; 자금 유입</strong> — RAM의 기초자산인 Roundhill DRAM ETF(순자산 약 $${aumB}B)는 삼성전자(18.7%), SK하이닉스(15.0%), 마이크론 스왑(약 25.2%)을 핵심 축으로 운용됩니다. 현재 주가 탄력 상위 종목은 ${top3} 순입니다.`,
      `<strong>3. 채권 금리 · 국제 유가 · 전쟁 지정학 리스크</strong> — 미국 10년물 국채금리는 ${us10y?.price ?? "-"}%, WTI 원유는 배럴당 $${wti?.price ?? "-"}, VIX 변동성 지수는 ${vix?.price ?? "-"}pt 수준에서 움직이고 있습니다.`,
    ];
  }

  function renderBriefingSection() {
    syncDynamicBriefingText();
    const d = state.data;
    if (!d || !d.briefing) return;
    const b = d.briefing;

    const regimeEl = document.getElementById("regimeBadge");
    if (regimeEl) regimeEl.textContent = `시장 신호: ${b.regime || "중립"}`;

    const headlineEl = document.getElementById("briefHeadline");
    if (headlineEl) headlineEl.textContent = b.headline || "";

    const listEl = document.getElementById("briefPointsList");
    if (listEl && Array.isArray(b.points)) {
      listEl.innerHTML = b.points.map((pt) => `<li>${pt}</li>`).join("");
    }

    const statsEl = document.getElementById("briefQuickStats");
    if (statsEl) {
      const soxx = d.etfs?.SOXX || {};
      const soxl = d.etfs?.SOXL || {};
      const ram = d.etfs?.RAM || {};
      const dram = d.etfs?.DRAM || {};
      const us10y = (d.macros || []).find((m) => m.key === "US10Y") || {};
      const wti = (d.macros || []).find((m) => m.key === "WTI") || {};

      const cards = [
        { label: "SOXX (1X 본진)", val: fmtPrice(soxx.price, "USD"), pct: soxx.change_pct },
        { label: "SOXL (반도체 3X)", val: fmtPrice(soxl.price, "USD"), pct: soxl.change_pct },
        { label: "RAM (DRAM 2X)", val: fmtPrice(ram.price, "USD"), pct: ram.change_pct },
        { label: "DRAM (메모리 1X)", val: fmtPrice(dram.price, "USD"), pct: dram.change_pct },
        { label: "미 국채 10년물", val: fmtPrice(us10y.price, null, "%"), pct: us10y.change_pct },
        { label: "WTI 국제유가", val: fmtPrice(wti.price, "USD"), pct: wti.change_pct },
      ];

      statsEl.innerHTML = cards
        .map(
          (c) => `
          <div class="mini-stat-box num">
            <div class="mini-stat-label">${c.label}</div>
            <div class="mini-stat-val">
              <span>${c.val}</span>
              <span class="${dirClass(c.pct, false)}" style="font-size:0.78rem;">${fmtSignedPct(c.pct)}</span>
            </div>
          </div>
        `
        )
        .join("");
    }
  }

  /* ========================================================================
     4. SOXX · RAM · DRAM 3대장 카드 & DRAM 자금유입
     ======================================================================== */
  function renderEtfTrio() {
    const d = state.data;
    if (!d || !d.etfs) return;
    const grid = document.getElementById("etfTrioGrid");
    if (!grid) return;

    const order = ["SOXX", "SOXL", "RAM", "DRAM"];
    grid.innerHTML = order
      .map((key) => {
        const e = d.etfs[key];
        if (!e) return "";
        const isSel = state.chartSymbol === key;
        const mttCount = [e.mtt?.above_sma50, e.mtt?.above_sma150, e.mtt?.above_sma200, e.mtt?.sma_aligned, e.mtt?.near_high].filter(Boolean).length;

        return `
        <article class="etf-card ${isSel ? "selected" : ""}" data-etf="${key}">
          <div class="etf-top">
            <span class="etf-ticker-badge">${key}</span>
            <span class="etf-lev-tag">${e.leverage || ""} · 보수 ${e.expense_ratio || "-"}</span>
            <span class="heat-rs" style="margin-left:auto;">RS ${e.rs_score || "-"}</span>
          </div>
          <h3 class="etf-name">${e.name_kr}</h3>
          <p class="etf-role">${e.role || ""}</p>

          <div class="etf-price-row num">
            <span class="etf-price">${fmtPrice(e.price, "USD")}</span>
            <span class="etf-chg-pill ${dirClass(e.change_pct, true)}">${fmtSignedChange(e.change, e.change_pct)}</span>
          </div>
          ${
            e.ext_price
              ? `<div class="num" style="font-size:0.78rem; color:var(--ink-secondary); margin-top:-2px; margin-bottom:4px;">
                  <span style="color:var(--gold-main); font-weight:700;">● ${e.ext_label || "시간외"} 실시간:</span>
                  <b>${fmtPrice(e.ext_price, "USD")}</b>
                  <span class="${dirClass(e.ext_change_pct, false)}" style="font-weight:700;">(${fmtSignedPct(e.ext_change_pct)})</span>
                </div>`
              : ""
          }

          <div class="etf-metrics-grid num">
            <div class="metric-cell">
              <small>추세(MTT)</small>
              <strong>${mttCount}/5 충족</strong>
            </div>
            <div class="metric-cell">
              <small>RSI(14)</small>
              <strong>${e.rsi14 ?? "-"} (${e.rsi14 >= 70 ? "과열" : e.rsi14 <= 35 ? "과매도" : "양호"})</strong>
            </div>
            <div class="metric-cell">
              <small>일간변동(ATR)</small>
              <strong>±${e.atr_pct ?? "-"}%</strong>
            </div>
            <div class="metric-cell">
              <small>20일 지지선</small>
              <strong>${fmtPrice(e.support_20d, "USD")}</strong>
            </div>
            <div class="metric-cell">
              <small>20일 저항선</small>
              <strong>${fmtPrice(e.resistance_20d, "USD")}</strong>
            </div>
            <div class="metric-cell">
              <small>52주 고가 대비</small>
              <strong>${fmtSignedPct(e.pct_from_high)}</strong>
            </div>
          </div>

          <div class="etf-returns-bar num">
            <div class="ret-item"><span>1주</span><b class="${dirClass(e.returns?.["1w"])}">${fmtSignedPct(e.returns?.["1w"])}</b></div>
            <div class="ret-item"><span>1개월</span><b class="${dirClass(e.returns?.["1m"])}">${fmtSignedPct(e.returns?.["1m"])}</b></div>
            <div class="ret-item"><span>3개월</span><b class="${dirClass(e.returns?.["3m"])}">${fmtSignedPct(e.returns?.["3m"])}</b></div>
            <div class="ret-item"><span>6개월</span><b class="${dirClass(e.returns?.["6m"])}">${fmtSignedPct(e.returns?.["6m"])}</b></div>
            <div class="ret-item"><span>1년</span><b class="${dirClass(e.returns?.["1y"])}">${fmtSignedPct(e.returns?.["1y"])}</b></div>
          </div>
        </article>
      `;
      })
      .join("");

    grid.querySelectorAll(".etf-card").forEach((card) => {
      card.addEventListener("click", () => {
        const key = card.getAttribute("data-etf");
        if (key) {
          const e = state.data?.etfs?.[key];
          selectTickerForLiveChart(key, key, e?.name_kr || key, "USD", false);
        }
      });
    });
  }

  function groupDramHoldingsByCompany(rawHoldings) {
    const groups = new Map();
    const matchRule = [
      { key: "MU", match: /MICRON|MU\b/i, name: "Micron Technology (현물+스왑 합산)", ticker: "MU · 3개 계약 통합" },
      { key: "005930.KS", match: /SAMSUNG/i, name: "Samsung Electronics (현물+스왑 합산)", ticker: "005930 KS · 현물+스왑" },
      { key: "000660.KS", match: /SK\s*HYNIX/i, name: "SK hynix Inc (현물+스왑 합산)", ticker: "000660 KS · 현물+스왑" },
      { key: "CXMT", match: /CXMT/i, name: "CXMT Corp (창신메모리 장외스왑)", ticker: "CXMT SWAP" },
      { key: "SNDK", match: /SANDISK|SNDK/i, name: "Sandisk Corp (샌디스크 현물)", ticker: "SNDK" },
      { key: "2344.TW", match: /WINBOND/i, name: "Winbond Electronics (윈본드)", ticker: "2344 TW" },
      { key: "2408.TW", match: /NANYA/i, name: "Nanya Technology (난야테크)", ticker: "2408 TW" },
      { key: "GIGA", match: /GIGADEVICE/i, name: "GigaDevice Semi (기가디바이스)", ticker: "3986 HK / SWAP" },
      { key: "285A.JP", match: /KIOXIA/i, name: "Kioxia Holdings (키옥시아)", ticker: "285A JP" },
      { key: "2337.TW", match: /MACRONIX/i, name: "Macronix International (매크로닉스)", ticker: "2337 TW" },
    ];

    (rawHoldings || []).forEach((h) => {
      const nm = String(h.name || "");
      const tk = String(h.ticker || "");
      if (nm.includes("Treasury Bill") || nm.includes("Government Obligations") || nm.includes("Cash")) return;
      const w = Number(h.weight_pct || h.weight || 0);
      if (w <= 0) return;

      let matched = null;
      for (const r of matchRule) {
        if (r.match.test(nm) || r.match.test(tk)) {
          matched = r;
          break;
        }
      }
      const gKey = matched ? matched.key : nm;
      const prev = groups.get(gKey) || {
        name: matched ? matched.name : nm,
        ticker: matched ? matched.ticker : tk,
        weight_pct: 0,
      };
      prev.weight_pct = Math.round((prev.weight_pct + w) * 100) / 100;
      groups.set(gKey, prev);
    });

    return Array.from(groups.values()).sort((a, b) => b.weight_pct - a.weight_pct);
  }

  function renderDramFlowPanel() {
    const d = state.data;
    const box = document.getElementById("dramFlowContent");
    if (!box || !d) return;

    const flow = d.dram_etf_flow || {};
    const holdings = flow.top_holdings || [];
    const aumB = flow.latest_aum ? (flow.latest_aum / 1e9).toFixed(2) : "-";
    const krwT = flow.latest_aum_krw_trillion || (flow.latest_aum ? ((flow.latest_aum * 1385) / 1e12).toFixed(1) : "27.5");
    const f1Num = flow.inflow_1d_usd ? flow.inflow_1d_usd / 1e6 : 0;
    const f5Num = flow.inflow_5d_usd ? flow.inflow_5d_usd / 1e6 : 0;
    const f20Num = flow.inflow_20d_usd ? flow.inflow_20d_usd / 1e6 : 0;
    const f1Str = f1Num.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const f5Str = f5Num.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const f20Str = f20Num.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const sh1d = Number(flow.shares_change_1d || 0);
    const sh1dMan = Math.round(sh1d / 10000);

    const dateBadge = document.getElementById("dramFlowDateBadge");
    if (dateBadge) {
      dateBadge.textContent = flow.latest_date
        ? `정산 기준: ${flow.latest_date} · 미 장마감 후 일 1회 갱신`
        : "미 정규장 마감 후 일 1회 자동 갱신";
    }

    const mode = state.dramHoldingsMode || "raw";
    const displayList =
      mode === "combined"
        ? groupDramHoldingsByCompany(holdings).slice(0, 8)
        : holdings
            .filter(
              (h) =>
                !String(h.name || "").includes("Treasury Bill") &&
                !String(h.name || "").includes("Government Obligations") &&
                !String(h.name || "").includes("Cash")
            )
            .slice(0, 8);

    box.innerHTML = `
      <div class="etf-metrics-grid num" style="margin-top:0; grid-template-columns:repeat(2, 1fr);">
        <div class="metric-cell">
          <small>DRAM ETF 순자산(AUM)</small>
          <strong>$${aumB}B (약 ${krwT}조원)</strong>
          <span style="display:block; font-size:0.68rem; color:var(--ink-muted); margin-top:2px;">운용사 일별 정산 총자산</span>
        </div>
        <div class="metric-cell">
          <small>당일(1거래일) 자금 유입 · 매일 리셋</small>
          <strong class="${dirClass(f1Num)}">$${f1Num > 0 ? "+" : ""}${f1Str}M</strong>
          <span style="display:block; font-size:0.68rem; color:var(--ink-muted); margin-top:2px;">발행좌수 ${sh1d > 0 ? "+" : ""}${sh1dMan}만 좌 변동</span>
        </div>
        <div class="metric-cell">
          <small>최근 5거래일 누적 자금 유입</small>
          <strong class="${dirClass(f5Num)}">$${f5Num > 0 ? "+" : ""}${f5Str}M</strong>
          <span style="display:block; font-size:0.68rem; color:var(--ink-muted); margin-top:2px;">최근 5영업일 누적 합산</span>
        </div>
        <div class="metric-cell">
          <small>최근 20거래일 누적 자금 유입</small>
          <strong class="${dirClass(f20Num)}">$${f20Num > 0 ? "+" : ""}${f20Str}M</strong>
          <span style="display:block; font-size:0.68rem; color:var(--ink-muted); margin-top:2px;">최근 20영업일 누적 합산</span>
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-top:12px;">
        <p style="font-size:0.76rem; color:var(--ink-secondary); margin:0; line-height:1.48; flex:1; min-width:210px;">
          💡 <strong>당일(1거래일) 유입</strong>은 매일 미 정규장 마감 후 새로 리셋·정산되며, <strong>5일·20일 유입</strong>은 기간 누적 흐름입니다.
        </p>
        <div class="interval-tabs" id="dramHoldingsModeTabs" style="flex-shrink:0;">
          <button type="button" class="iv-btn ${mode === "raw" ? "active" : ""}" data-dram-mode="raw" style="font-size:0.72rem; padding:4px 8px;">원장 계약별(현물·스왑)</button>
          <button type="button" class="iv-btn ${mode === "combined" ? "active" : ""}" data-dram-mode="combined" style="font-size:0.72rem; padding:4px 8px;">기업별 합산 비중</button>
        </div>
      </div>

      <div class="dram-holdings-list num">
        ${displayList
          .map((h) => {
            const w = Math.min(100, Math.max(2, Number(h.weight_pct || 0)));
            const nmUpper = String(h.name || "").toUpperCase();
            const tkUpper = String(h.ticker || "").toUpperCase();
            let mappedSym = "";
            let mappedName = h.name;
            let mappedCur = "USD";
            if (nmUpper.includes("SAMSUNG") || tkUpper.includes("005930")) {
              mappedSym = "005930.KS";
              mappedName = "삼성전자";
              mappedCur = "KRW";
            } else if (nmUpper.includes("HYNIX") || tkUpper.includes("000660")) {
              mappedSym = "000660.KS";
              mappedName = "SK하이닉스";
              mappedCur = "KRW";
            } else if (nmUpper.includes("MICRON") || tkUpper.startsWith("MU")) {
              mappedSym = "MU";
              mappedName = "마이크론 테크놀로지";
              mappedCur = "USD";
            } else if (nmUpper.includes("SANDISK") || tkUpper.includes("SNDK")) {
              mappedSym = "SNDK";
              mappedName = "샌디스크";
              mappedCur = "USD";
            }
            return `
              <div class="dram-hold-row ${mappedSym ? "clickable" : ""}" ${
              mappedSym ? `data-dram-jump-sym="${mappedSym}" data-dram-jump-name="${mappedName}" data-dram-jump-cur="${mappedCur}" data-dram-jump-w="${w.toFixed(2)}" title="터치하여 ${mappedName} 상세 차트·지표 띄우기"` : ""
            }>
                <div class="dram-hold-top">
                  <span><strong>${h.name}</strong> <small style="color:var(--ink-muted);">(${h.ticker || ""})</small> ${mappedSym ? '<small style="color:var(--gold-main); font-weight:700;">↗ 상세</small>' : ""}</span>
                  <strong>${w.toFixed(2)}%</strong>
                </div>
                <div class="dram-bar-track">
                  <div class="dram-bar-fill" style="width:${Math.min(100, w * 3.2)}%;"></div>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;

    box.querySelectorAll("[data-dram-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextMode = btn.getAttribute("data-dram-mode") || "raw";
        if (state.dramHoldingsMode !== nextMode) {
          state.dramHoldingsMode = nextMode;
          renderDramFlowPanel();
        }
      });
    });

    box.querySelectorAll("[data-dram-jump-sym]").forEach((row) => {
      row.addEventListener("click", () => {
        const sym = row.getAttribute("data-dram-jump-sym");
        const nm = row.getAttribute("data-dram-jump-name");
        const cur = row.getAttribute("data-dram-jump-cur") || "USD";
        const w = parseFloat(row.getAttribute("data-dram-jump-w") || "0");
        if (sym) {
          openStockPopupOrJump(sym, nm, cur, w, "MODAL");
        }
      });
    });
  }

  async function fetchLiveDramEtfFlow() {
    try {
      const targetUrl = "https://stockeasy.intellio.kr/stockdata/api/v1/memory-prices/dram-etf/overview";
      const jinaUrl = `https://r.jina.ai/${targetUrl}`;
      const resp = await fetch(jinaUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!resp.ok) return false;
      const wrapper = await resp.json();
      const rawContent = wrapper?.data?.content || "";
      if (!rawContent) return false;
      const d = JSON.parse(rawContent);
      if (!d || !d.current_aum) return false;

      const series = Array.isArray(d.series) ? d.series.slice(-60) : [];
      const sharesNow = Number(d.current_shares || (series.length ? series[series.length - 1].shares_outstanding : 0));
      const shares1d = series.length >= 2 ? Number(series[series.length - 2].shares_outstanding || sharesNow) : sharesNow;
      const shares5d = series.length >= 6 ? Number(series[series.length - 6].shares_outstanding || sharesNow) : sharesNow;
      const shares20d = series.length >= 21 ? Number(series[series.length - 21].shares_outstanding || sharesNow) : sharesNow;
      const navNow =
        Number(d.current_nav) ||
        (series.length >= 2 && Number(series[series.length - 2].nav)) ||
        50.0;

      const inflow1d = Math.round((sharesNow - shares1d) * navNow);
      const inflow5d = Math.round((sharesNow - shares5d) * navNow);
      const inflow20d = Math.round((sharesNow - shares20d) * navNow);

      const cleanHoldings = (d.holdings || [])
        .filter((h) => {
          const nm = String(h.name || "");
          const tk = String(h.ticker || "");
          return (
            !h.is_money_market &&
            !nm.includes("Treasury Bill") &&
            !nm.includes("Government Obligations") &&
            !nm.includes("Cash") &&
            !["KRW", "CNY", "TWD"].includes(tk) &&
            Number(h.weight) > 0
          );
        })
        .map((h) => ({
          ticker: String(h.ticker || ""),
          name: String(h.name || ""),
          weight_pct: Math.round(Number(h.weight || 0) * 100) / 100,
        }));

      const usdkrw =
        (state.data?.macros || []).find((m) => m.symbol === "USDKRW" || m.key === "USDKRW")?.price || 1385;

      if (state.data) {
        state.data.dram_etf_flow = {
          latest_date: d.latest_date || (series.length ? series[series.length - 1].as_of : ""),
          latest_aum: Number(d.current_aum),
          latest_aum_krw_trillion: ((Number(d.current_aum) * usdkrw) / 1e12).toFixed(1),
          current_shares: sharesNow,
          shares_change_1d: sharesNow - shares1d,
          inflow_1d_usd: inflow1d,
          inflow_5d_usd: inflow5d,
          inflow_20d_usd: inflow20d,
          top_holdings: cleanHoldings,
        };
        renderDramFlowPanel();
        if (state.treemapMode === "RAM") {
          renderSoxxTreemap();
        }
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ========================================================================
     5. 실시간 전 종목 검색 & 분봉/일봉 라이브 차트 + 터치 십자선
     ======================================================================== */
  function setChartIntervalTabUI(iv) {
    state.chartInterval = iv;
    document.querySelectorAll("#intervalTabs .iv-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-iv") === iv);
    });
  }

  function selectTickerForLiveChart(symbol, cnbcSym, displayName, currency, shouldScroll, defaultToMinute = true) {
    state.chartSymbol = symbol;
    state.chartCnbcSymbol = cnbcSym || symbol;
    state.chartName = displayName || symbol;
    state.chartCurrency = currency || (symbol.endsWith(".KS") ? "KRW" : "USD");
    state.chartHoverIdx = -1;

    if (defaultToMinute) {
      setChartIntervalTabUI("1M");
    }

    if (["SOXX", "SOXL", "RAM", "DRAM"].includes(symbol)) {
      state.selectedEtf = symbol;
      renderEtfTrio();
    } else {
      document.querySelectorAll(".etf-card").forEach((c) => c.classList.remove("selected"));
    }

    document.querySelectorAll("#quickTickers .qt-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-qt") === symbol);
    });

    loadLiveChart(state.chartSymbol, state.chartCnbcSymbol, state.chartName, state.chartInterval, state.chartCurrency);

    if (shouldScroll) {
      if (state.activeSectionTab !== "sec-live" && typeof switchActiveSectionTab === "function") {
        switchActiveSectionTab("sec-live", { scrollTop: false, updateHash: true });
      }
      requestAnimationFrame(() => {
        const chartEl = document.querySelector(".chart-panel");
        if (chartEl) chartEl.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  function formatCnbcTs(dtObj) {
    const y = dtObj.getFullYear();
    const m = String(dtObj.getMonth() + 1).padStart(2, "0");
    const d = String(dtObj.getDate()).padStart(2, "0");
    return `${y}${m}${d}000000`;
  }

  function extractLiveQuoteInfo(qItem, displayName) {
    if (!qItem || !qItem.last) return null;
    const regPrice = parseFloat(String(qItem.last).replace(/,/g, ""));
    const regChg = parseFloat(String(qItem.change || "0").replace(/,/g, ""));
    const regPct = parseFloat(String(qItem.change_pct || "0").replace(/[%+,]/g, ""));
    if (isNaN(regPrice) || regPrice <= 0) return null;

    const mktStatus = String(qItem.curmktstatus || "REG_MKT");
    const extObj = qItem.ExtendedMktQuote || null;
    let extPrice = null;
    let extChg = null;
    let extPct = null;
    let extLabel = "";

    if ((mktStatus === "PRE_MKT" || mktStatus === "POST_MKT") && extObj && extObj.last) {
      const ep = parseFloat(String(extObj.last).replace(/,/g, ""));
      const ec = parseFloat(String(extObj.change || "0").replace(/,/g, ""));
      const epct = parseFloat(String(extObj.change_pct || "0").replace(/[%+,]/g, ""));
      if (!isNaN(ep) && ep > 0) {
        extPrice = ep;
        extChg = isNaN(ec) ? 0 : ec;
        extPct = isNaN(epct) ? 0 : epct;
        extLabel = mktStatus === "PRE_MKT" ? "프리" : "애프터";
      }
    }

    return {
      price: regPrice,
      change: isNaN(regChg) ? 0 : regChg,
      change_pct: isNaN(regPct) ? 0 : regPct,
      extPrice,
      extChange: extChg,
      extPct,
      extLabel,
      mktStatus,
      activeIntradayPrice: extPrice !== null ? extPrice : regPrice,
      activeIntradayPct: extPct !== null ? extPct : isNaN(regPct) ? 0 : regPct,
      name: qItem.shortName || displayName,
    };
  }

  function renderMainChartTitleHTML(displayName, symbol, currency, interval, quoteInfo) {
    const titleEl = document.getElementById("mainChartTitle");
    if (!titleEl) return;
    const ivLabel =
      interval === "1M" ? "실시간 1분봉" : interval === "5M" ? "실시간 5분봉" : interval === "15M" ? "실시간 15분봉" : "일봉(90일)";

    if (!quoteInfo) {
      titleEl.innerHTML = `${displayName} <span style="color:var(--gold-main); font-size:0.86rem;">(${symbol})</span> · <span style="font-size:0.84rem; color:var(--ink-muted);">${ivLabel}</span>`;
      return;
    }

    const isIntraday = interval !== "1D";
    if (isIntraday && quoteInfo.extPrice !== null) {
      const extPStr = fmtPrice(quoteInfo.extPrice, currency);
      const extPctStr = fmtSignedPct(quoteInfo.extPct);
      const extCls = dirClass(quoteInfo.extPct, false);
      const regPStr = fmtPrice(quoteInfo.price, currency);
      const regPctStr = fmtSignedPct(quoteInfo.change_pct);
      titleEl.innerHTML = `${displayName} <span style="color:var(--gold-main); font-size:0.84rem;">(${symbol})</span> · <span class="num ${extCls}">${extPStr} (${quoteInfo.extLabel} ${extPctStr})</span> <span class="num" style="font-size:0.78rem; color:var(--ink-muted);">· 정규 ${regPStr} (${regPctStr})</span> · <span style="font-size:0.8rem; color:var(--ink-muted);">${ivLabel}</span>`;
    } else {
      const pStr = fmtPrice(quoteInfo.price, currency);
      const pctStr = fmtSignedPct(quoteInfo.change_pct);
      const cls = dirClass(quoteInfo.change_pct, false);
      const extSuffix =
        quoteInfo.extPrice !== null
          ? ` <span class="num ${dirClass(quoteInfo.extPct, false)}" style="font-size:0.78rem;">· ${quoteInfo.extLabel} ${fmtPrice(quoteInfo.extPrice, currency)} (${fmtSignedPct(quoteInfo.extPct)})</span>`
          : "";
      titleEl.innerHTML = `${displayName} <span style="color:var(--gold-main); font-size:0.84rem;">(${symbol})</span> · <span class="num ${cls}">${pStr} (${pctStr})</span>${extSuffix} · <span style="font-size:0.8rem; color:var(--ink-muted);">${ivLabel}</span>`;
    }
  }

  function parseCnbcPriceBars(rawBars, interval) {
    if (!Array.isArray(rawBars)) return [];
    const parsed = [];
    for (let i = 0; i < rawBars.length; i++) {
      const b = rawBars[i];
      const o = parseFloat(b.open);
      const h = parseFloat(b.high);
      const l = parseFloat(b.low);
      const c = parseFloat(b.close);
      const vol = parseInt(b.volume || "0", 10) || 0;
      if (isNaN(c) || c <= 0) continue;

      // 분봉에서 거래량 0이고 시고저종이 완전히 동일한 장외 더미 틱은 활성 캔들이 충분할 때 제외
      if (interval !== "1D" && rawBars.length > 30 && vol === 0 && o === h && h === l && l === c) {
        continue;
      }

      let label = String(b.tradeTime || "");
      const ms = Number(b.tradeTimeinMills);
      if (interval !== "1D" && !isNaN(ms) && ms > 1000000000000) {
        // UTC 밀리초를 한국시간(KST, UTC+9)으로 변환하여 직관적 표시
        const kstDt = new Date(ms + 9 * 3600 * 1000);
        const mm = String(kstDt.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(kstDt.getUTCDate()).padStart(2, "0");
        const hh = String(kstDt.getUTCHours()).padStart(2, "0");
        const mi = String(kstDt.getUTCMinutes()).padStart(2, "0");
        label = `${mm}.${dd} ${hh}:${mi}`;
      } else if (label.length >= 12) {
        const mm = label.slice(4, 6);
        const dd = label.slice(6, 8);
        const hh = label.slice(8, 10);
        const mi = label.slice(10, 12);
        label = interval === "1D" ? `${mm}.${dd}` : `${mm}.${dd} ${hh}:${mi}`;
      }

      const openVal = isNaN(o) || o <= 0 ? c : o;
      let highVal = isNaN(h) || h <= 0 ? Math.max(openVal, c) : Math.max(h, openVal, c);
      let lowVal = isNaN(l) || l <= 0 ? Math.min(openVal, c) : Math.min(l, openVal, c);

      // 분봉 단일 배드틱(비정상 장외 꼬리 스파이크) 방어: 몸통 대비 꼬리만 4% 이상 튄 소량 체결 보정
      if (interval !== "1D") {
        const bodyMax = Math.max(openVal, c);
        const bodyMin = Math.min(openVal, c);
        if ((bodyMin - lowVal) / bodyMin > 0.035 && vol < 2500) {
          lowVal = bodyMin;
        }
        if ((highVal - bodyMax) / bodyMax > 0.035 && vol < 2500) {
          highVal = bodyMax;
        }
      }

      parsed.push({
        date: label,
        open: openVal,
        high: highVal,
        low: lowVal,
        close: c,
        volume: vol,
      });
    }
    return parsed;
  }

  function applyLiveTickToLastCandle(candles, interval, quoteInfo) {
    if (!Array.isArray(candles) || candles.length === 0 || !quoteInfo) return;
    const lastIdx = candles.length - 1;
    const lastBar = candles[lastIdx];

    if (interval === "1D") {
      // 일봉은 정규장 진행 중일 때만 정규장 가격을 마지막 캔들에 반영
      if (quoteInfo.mktStatus === "REG_MKT") {
        const p = quoteInfo.price;
        if (Math.abs(p - lastBar.close) / lastBar.close < 0.15) {
          lastBar.close = p;
          if (p > lastBar.high) lastBar.high = p;
          if (p < lastBar.low) lastBar.low = p;
        }
      }
      return;
    }

    // 분봉(1M / 5M / 15M): 반드시 현재 세션과 일치하는 실시간 체결가(프리/애프터 포함)만 사용!
    // 정규장 종가(q.last)가 시간외 분봉 캔들에 덮어씌워져 가짜 장대음봉/장대양봉을 만드는 현상 원천 차단
    if (quoteInfo.mktStatus === "CLOSED") return;
    if ((quoteInfo.mktStatus === "PRE_MKT" || quoteInfo.mktStatus === "POST_MKT") && quoteInfo.extPrice === null) {
      return;
    }

    const livePrice = quoteInfo.activeIntradayPrice;
    if (!livePrice || isNaN(livePrice) || livePrice <= 0) return;

    // 직전 캔들 종가 대비 2% 이내의 정상 실시간 틱일 때만 현재 캔들 종가/고가/저가 갱신
    const driftRatio = Math.abs(livePrice - lastBar.close) / lastBar.close;
    if (driftRatio <= 0.02) {
      lastBar.close = livePrice;
      if (livePrice > lastBar.high) lastBar.high = livePrice;
      if (livePrice < lastBar.low) lastBar.low = livePrice;
    }
  }

  async function loadLiveChart(symbol, cnbcSym, displayName, interval, currency) {
    renderMainChartTitleHTML(displayName, symbol, currency, interval, null);

    let localRef = null;
    if (state.data) {
      if (state.data.etfs && state.data.etfs[symbol]) localRef = state.data.etfs[symbol];
      else if (state.data.holdings) localRef = state.data.holdings.find((h) => h.ticker === symbol);
      else if (state.data.macros) localRef = state.data.macros.find((m) => m.key === symbol);
    }

    // 1D 일봉이거나 첫 로딩 시 캔버스가 비어 있으면 즉시 스냅샷 1차 표시 후 실시간 분봉으로 교체
    if ((interval === "1D" || state.chartCandles.length === 0) && localRef && Array.isArray(localRef.candles) && localRef.candles.length > 10) {
      state.chartCandles = localRef.candles.slice(-90);
      state.chartSupport20 = localRef.support_20d;
      state.chartResistance20 = localRef.resistance_20d;
      updateChartStripFromCandles(localRef);
      redrawMainChartFromState();
    }

    try {
      const now = new Date();
      const lookbackDays = interval === "1M" ? 4 : interval === "5M" ? 7 : interval === "15M" ? 14 : 180;
      const startDt = new Date(now.getTime() - lookbackDays * 86400 * 1000);
      const endDt = new Date(now.getTime() + 2 * 86400 * 1000);
      const encSym = encodeURIComponent(cnbcSym);

      const barUrl = `https://ts-api.cnbc.com/harmony/app/bars/${encSym}/${interval}/${formatCnbcTs(startDt)}/${formatCnbcTs(endDt)}/adjusted/EST5EDT.json`;
      const quoteUrl = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encSym}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;

      const [barResp, quoteResp] = await Promise.all([
        fetch(barUrl, { cache: "no-store" }),
        fetch(quoteUrl, { cache: "no-store" }).catch(() => null),
      ]);

      let quoteInfo = null;
      if (quoteResp && quoteResp.ok) {
        const qJson = await quoteResp.json();
        const qItem = qJson?.FormattedQuoteResult?.FormattedQuote?.[0];
        quoteInfo = extractLiveQuoteInfo(qItem, displayName);
      }

      // 한국 종목(.KS) 등 CNBC restQuote 응답이 없는 경우 로컬 실시간 데이터로 타이틀 표시
      if (!quoteInfo && localRef && localRef.price) {
        quoteInfo = {
          price: Number(localRef.price),
          change: Number(localRef.change || 0),
          change_pct: Number(localRef.change_pct || 0),
          extPrice: localRef.ext_price !== undefined ? localRef.ext_price : null,
          extPct: localRef.ext_change_pct !== undefined ? localRef.ext_change_pct : null,
          extLabel: localRef.ext_label || "",
          mktStatus: "REG_MKT",
          activeIntradayPrice: localRef.ext_price || Number(localRef.price),
          activeIntradayPct: localRef.ext_change_pct || Number(localRef.change_pct || 0),
          name: displayName,
        };
      }

      if (quoteInfo) {
        state.liveQuote = quoteInfo;
        renderMainChartTitleHTML(displayName, symbol, currency, interval, quoteInfo);
      }

      if (barResp.ok) {
        const barJson = await barResp.json();
        const rawBars = barJson?.barData?.priceBars || [];
        const parsed = parseCnbcPriceBars(rawBars, interval);

        if (parsed.length > 5) {
          const maxBars = interval === "1D" ? 90 : 96;
          state.chartCandles = parsed.slice(-maxBars);
          if (quoteInfo) {
            applyLiveTickToLastCandle(state.chartCandles, interval, quoteInfo);
          }
          const recent20 = state.chartCandles.slice(-20);
          state.chartSupport20 = Math.min(...recent20.map((x) => x.low));
          state.chartResistance20 = Math.max(...recent20.map((x) => x.high));
          updateChartStripFromCandles(localRef);
          redrawMainChartFromState();
          updateCrosshairHud(state.chartCandles.length - 1);
        }
      }
    } catch (err) {
      // 오프라인 시 기본 스냅샷 유지
    }
  }

  function updateChartStripFromCandles(localRef) {
    const strip = document.getElementById("mainChartStrip");
    if (!strip) return;
    const candles = state.chartCandles;
    if (!candles || !candles.length) return;

    const cur = state.chartCurrency;
    const sup = state.chartSupport20;
    const res = state.chartResistance20;
    const lastC = candles[candles.length - 1].close;

    let rsiVal = localRef?.rsi14;
    if (rsiVal === undefined && candles.length > 15) {
      let gains = 0, losses = 0;
      for (let i = candles.length - 14; i < candles.length; i++) {
        const diff = candles[i].close - candles[i - 1].close;
        if (diff > 0) gains += diff;
        else losses -= diff;
      }
      const rs = losses === 0 ? 100 : gains / losses;
      rsiVal = Math.round((100 - 100 / (1 + rs)) * 10) / 10;
    }

    const highMax = localRef?.high_52w || Math.max(...candles.map((c) => c.high));
    const pctFromHigh = highMax ? (((lastC - highMax) / highMax) * 100).toFixed(2) : "0.00";

    strip.innerHTML = `
      <div class="strip-item num">
        <span>구간 지지선 (20캔들 저점)</span>
        <strong>${fmtPrice(sup, cur)}</strong>
      </div>
      <div class="strip-item num">
        <span>구간 저항선 (20캔들 고점)</span>
        <strong>${fmtPrice(res, cur)}</strong>
      </div>
      <div class="strip-item num">
        <span>RSI(14) 탄력</span>
        <strong>${rsiVal ?? "-"} (${rsiVal >= 70 ? "과열" : rsiVal <= 35 ? "과매도" : "중립"})</strong>
      </div>
      <div class="strip-item num">
        <span>고점(${fmtPrice(highMax, cur)}) 대비</span>
        <strong class="${dirClass(Number(pctFromHigh), false)}">${pctFromHigh}%</strong>
      </div>
    `;
  }

  function updateCrosshairHud(idx) {
    const hud = document.getElementById("chartHudItems");
    if (!hud || !state.chartCandles.length) return;
    const i = idx >= 0 && idx < state.chartCandles.length ? idx : state.chartCandles.length - 1;
    const c = state.chartCandles[i];
    const prev = i > 0 ? state.chartCandles[i - 1].close : c.open;
    const pct = prev ? (((c.close - prev) / prev) * 100).toFixed(2) : "0.00";
    const cur = state.chartCurrency;
    const closes = state.chartCandles.map((x) => x.close);
    const sma20 = calcSeriesSMA(closes, 20)[i];
    const sma50 = calcSeriesSMA(closes, 50)[i];

    hud.innerHTML = `
      <span>일시: <b>${c.date}</b></span>
      <span>시가: <b>${fmtPrice(c.open, cur)}</b></span>
      <span>고가: <b class="up-text">${fmtPrice(c.high, cur)}</b></span>
      <span>저가: <b class="down-text">${fmtPrice(c.low, cur)}</b></span>
      <span>종가: <b class="${dirClass(Number(pct), false)}">${fmtPrice(c.close, cur)} (${Number(pct) > 0 ? "+" : ""}${pct}%)</b></span>
      ${sma20 ? `<span>20선: <b style="color:#D9A74A;">${fmtPrice(sma20, cur)}</b></span>` : ""}
      ${sma50 ? `<span>50선: <b style="color:#38B28B;">${fmtPrice(sma50, cur)}</b></span>` : ""}
    `;
  }

  function redrawMainChartFromState() {
    drawCandlestickChart("mainChartCanvas", state.chartCandles, {
      support20: state.chartSupport20,
      resistance20: state.chartResistance20,
      currency: state.chartCurrency,
      hoverIdx: state.chartHoverIdx,
    });
  }

  /* ========================================================================
     6. 캔버스 차트 엔진 (고해상도 DPI + 마우스/터치 십자선 추적)
     ======================================================================== */
  function drawCandlestickChart(canvasId, candles, options) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !Array.isArray(candles) || candles.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(260, rect.width);
    const height = Math.max(170, rect.height);

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const isDark = state.theme === "dark";
    const isKr = state.colorMode === "kr";

    const upColor = isKr ? (isDark ? "#F05650" : "#C9352E") : isDark ? "#36C98E" : "#1B7F56";
    const downColor = isKr ? (isDark ? "#4A90E2" : "#2364AA") : isDark ? "#F05650" : "#C9352E";
    const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(20,27,36,0.07)";
    const textColor = isDark ? "#8E9BAB" : "#667282";

    const pad = { top: 14, right: 62, bottom: 24, left: 8 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const closes = candles.map((c) => c.close);
    const sma20 = calcSeriesSMA(closes, 20);
    const sma50 = calcSeriesSMA(closes, 50);

    let minP = Infinity;
    let maxP = -Infinity;
    candles.forEach((c, idx) => {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
      if (sma20[idx] !== null) {
        if (sma20[idx] < minP) minP = sma20[idx];
        if (sma20[idx] > maxP) maxP = sma20[idx];
      }
      if (sma50[idx] !== null) {
        if (sma50[idx] < minP) minP = sma50[idx];
        if (sma50[idx] > maxP) maxP = sma50[idx];
      }
    });

    const margin = (maxP - minP) * 0.08 || 1;
    minP -= margin;
    maxP += margin;

    const yFor = (p) => pad.top + plotH - ((p - minP) / (maxP - minP)) * plotH;
    const xStep = plotW / candles.length;
    const xFor = (i) => pad.left + (i + 0.5) * xStep;

    ctx.clearRect(0, 0, width, height);

    // 1) 수평 그리드 및 우측 가격 축
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = "600 10px Pretendard, sans-serif";
    ctx.textAlign = "left";

    for (let g = 0; g <= 4; g++) {
      const pVal = minP + ((maxP - minP) * g) / 4;
      const y = yFor(pVal);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();

      const lbl =
        options?.currency === "KRW"
          ? Math.round(pVal).toLocaleString()
          : pVal >= 100
          ? pVal.toFixed(1)
          : pVal.toFixed(2);
      ctx.fillText(lbl, pad.left + plotW + 5, y + 3);
    }

    // 2) 20캔들 지지선 / 저항선 점선
    if (options?.support20 && options.support20 >= minP && options.support20 <= maxP) {
      const sy = yFor(options.support20);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(56, 178, 139, 0.5)";
      ctx.beginPath();
      ctx.moveTo(pad.left, sy);
      ctx.lineTo(pad.left + plotW, sy);
      ctx.stroke();
      ctx.restore();
    }
    if (options?.resistance20 && options.resistance20 >= minP && options.resistance20 <= maxP) {
      const ry = yFor(options.resistance20);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(226, 180, 90, 0.55)";
      ctx.beginPath();
      ctx.moveTo(pad.left, ry);
      ctx.lineTo(pad.left + plotW, ry);
      ctx.stroke();
      ctx.restore();
    }

    // 3) 캔들스틱
    const candleW = Math.max(2.2, Math.min(9, xStep * 0.66));
    candles.forEach((c, i) => {
      const isUp = c.close >= c.open;
      const color = isUp ? upColor : downColor;
      const x = xFor(i);
      const yHigh = yFor(c.high);
      const yLow = yFor(c.low);
      const yOpen = yFor(c.open);
      const yClose = yFor(c.close);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      const topY = Math.min(yOpen, yClose);
      const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
      ctx.fillStyle = color;
      ctx.fillRect(x - candleW / 2, topY, candleW, bodyH);
    });

    // 4) 20선 & 50선
    function drawLine(arr, stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      let started = false;
      arr.forEach((val, i) => {
        if (val === null) return;
        const x = xFor(i);
        const y = yFor(val);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    }
    drawLine(sma20, "#D9A74A");
    drawLine(sma50, "#38B28B");

    // 5) 하단 X축 날짜/시간 라벨
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(candles.length / 4));
    for (let i = 0; i < candles.length; i += step) {
      const dStr = (candles[i].date || "").slice(-11);
      ctx.fillText(dStr, xFor(i), height - 6);
    }

    // 6) 마우스/터치 십자선(Crosshair) 오버레이
    const hIdx = options?.hoverIdx;
    if (typeof hIdx === "number" && hIdx >= 0 && hIdx < candles.length) {
      const hc = candles[hIdx];
      const hx = xFor(hIdx);
      const hy = yFor(hc.close);

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = isDark ? "rgba(245, 213, 138, 0.8)" : "rgba(168, 121, 30, 0.8)";
      ctx.lineWidth = 1.1;

      ctx.beginPath();
      ctx.moveTo(hx, pad.top);
      ctx.lineTo(hx, pad.top + plotH);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(pad.left, hy);
      ctx.lineTo(pad.left + plotW, hy);
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(hx, hy, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#E2B45A";
      ctx.fill();

      // 우측 가격 축 하이라이트 박스
      const pTxt =
        options?.currency === "KRW"
          ? Math.round(hc.close).toLocaleString()
          : hc.close.toFixed(2);
      ctx.fillStyle = "#E2B45A";
      ctx.fillRect(pad.left + plotW + 2, hy - 9, pad.right - 4, 18);
      ctx.fillStyle = "#0F141C";
      ctx.font = "800 10px Pretendard, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(pTxt, pad.left + plotW + 5, hy + 3.5);
    }
  }

  function bindMainChartInteractions() {
    const canvas = document.getElementById("mainChartCanvas");
    if (!canvas) return;

    function handlePointer(clientX) {
      const candles = state.chartCandles;
      if (!candles || !candles.length) return;
      const rect = canvas.getBoundingClientRect();
      const padLeft = 8;
      const padRight = 62;
      const plotW = rect.width - padLeft - padRight;
      const relX = clientX - rect.left - padLeft;
      const ratio = Math.max(0, Math.min(0.999, relX / Math.max(1, plotW)));
      const idx = Math.floor(ratio * candles.length);
      if (idx !== state.chartHoverIdx) {
        state.chartHoverIdx = idx;
        updateCrosshairHud(idx);
        redrawMainChartFromState();
      }
    }

    canvas.addEventListener("mousemove", (e) => handlePointer(e.clientX));
    canvas.addEventListener("mouseleave", () => {
      state.chartHoverIdx = -1;
      updateCrosshairHud(state.chartCandles.length - 1);
      redrawMainChartFromState();
    });

    canvas.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches && e.touches[0]) {
          handlePointer(e.touches[0].clientX);
        }
      },
      { passive: true }
    );
    canvas.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches && e.touches[0]) {
          handlePointer(e.touches[0].clientX);
        }
      },
      { passive: true }
    );

    // 주기 탭 (1분봉 / 5분봉 / 15분봉 / 일봉)
    document.querySelectorAll("#intervalTabs .iv-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const iv = btn.getAttribute("data-iv") || "1D";
        state.chartInterval = iv;
        document.querySelectorAll("#intervalTabs .iv-btn").forEach((b) => b.classList.toggle("active", b === btn));
        loadLiveChart(state.chartSymbol, state.chartCnbcSymbol, state.chartName, state.chartInterval, state.chartCurrency);
      });
    });

    // 빠른 티커 전환 버튼
    document.querySelectorAll("#quickTickers .qt-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const qt = btn.getAttribute("data-qt");
        if (!qt) return;
        const found = KR_TICKER_DICT.find((x) => x.symbol === qt);
        selectTickerForLiveChart(qt, found?.cnbc || qt, found?.name || qt, found?.cur || "USD", false);
      });
    });

    // LIVE 자동 추적 배지 토글
    const btnLive = document.getElementById("btnLiveToggle");
    const txtLive = document.getElementById("liveStatusText");
    if (btnLive && txtLive) {
      btnLive.addEventListener("click", () => {
        state.liveTracking = !state.liveTracking;
        btnLive.classList.toggle("paused", !state.liveTracking);
        txtLive.textContent = state.liveTracking ? "LIVE 실시간 추적" : "실시간 일시정지";
      });
    }
  }

  /* ========================================================================
     7. 실시간 종목 검색창 (한글 사전 + CNBC 글로벌 심볼 자동완성)
     ======================================================================== */
  function bindLiveSearchBox() {
    const input = document.getElementById("liveSearchInput");
    const btn = document.getElementById("liveSearchBtn");
    const dropdown = document.getElementById("searchDropdown");
    if (!input || !dropdown) return;

    let debounceTimer = null;

    async function runSearchSuggestions(q) {
      const query = q.trim();
      if (!query) {
        dropdown.setAttribute("hidden", "");
        return;
      }

      const qUpper = query.toUpperCase();
      const localMatches = KR_TICKER_DICT.filter(
        (item) => item.symbol.toUpperCase().includes(qUpper) || item.name.toUpperCase().includes(qUpper)
      ).slice(0, 6);

      let remoteMatches = [];
      if (/^[A-Za-z0-9.]+$/.test(query) && query.length >= 2) {
        try {
          const url = `https://symlookup.cnbc.com/symservice/symlookup.do?prefix=${encodeURIComponent(query)}&maxresult=6&output=json`;
          const resp = await fetch(url);
          if (resp.ok) {
            const arr = await resp.json();
            if (Array.isArray(arr)) {
              remoteMatches = arr.map((r) => ({
                symbol: r.symbolName,
                cnbc: r.symbolName,
                name: r.companyName || r.symbolName,
                exch: r.exchangeName || "US",
                cur: (r.countryCode && r.countryCode === "KR") || String(r.symbolName).endsWith(".KS") ? "KRW" : "USD",
              }));
            }
          }
        } catch (e) {
          // 네트워크 제한 시 로컬 사전 사용
        }
      }

      const merged = [...localMatches];
      remoteMatches.forEach((rm) => {
        if (!merged.some((m) => m.symbol.toUpperCase() === String(rm.symbol).toUpperCase())) {
          merged.push(rm);
        }
      });

      if (merged.length === 0) {
        merged.push({
          symbol: qUpper,
          cnbc: qUpper,
          name: `'${qUpper}' 티커 직접 실시간 조회`,
          exch: "DIRECT",
          cur: qUpper.endsWith(".KS") ? "KRW" : "USD",
        });
      }

      dropdown.innerHTML = merged
        .slice(0, 8)
        .map(
          (item) => `
          <button type="button" class="search-result-item" data-sym="${item.symbol}" data-cnbc="${item.cnbc}" data-name="${item.name}" data-cur="${item.cur}">
            <div class="sri-left">
              <strong>${item.symbol}</strong>
              <span>${item.name}</span>
            </div>
            <span class="sri-right">${item.exch}</span>
          </button>
        `
        )
        .join("");

      dropdown.removeAttribute("hidden");

      dropdown.querySelectorAll(".search-result-item").forEach((el) => {
        el.addEventListener("click", () => {
          const sym = el.getAttribute("data-sym");
          const cnbc = el.getAttribute("data-cnbc");
          const name = el.getAttribute("data-name");
          const cur = el.getAttribute("data-cur");
          dropdown.setAttribute("hidden", "");
          input.value = `${name} (${sym})`;
          input.blur();
          selectTickerForLiveChart(sym, cnbc, name, cur, true);
        });
      });
    }

    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSearchSuggestions(input.value), 160);
    });

    input.addEventListener("focus", () => {
      if (input.value.trim()) runSearchSuggestions(input.value);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const firstBtn = dropdown.querySelector(".search-result-item");
        if (firstBtn && !dropdown.hasAttribute("hidden")) {
          firstBtn.click();
        } else if (input.value.trim()) {
          const raw = input.value.trim().toUpperCase();
          const dictHit = KR_TICKER_DICT.find((x) => x.symbol.toUpperCase() === raw || x.name.includes(input.value.trim()));
          if (dictHit) {
            selectTickerForLiveChart(dictHit.symbol, dictHit.cnbc, dictHit.name, dictHit.cur, true);
          } else {
            selectTickerForLiveChart(raw, raw, raw, raw.endsWith(".KS") ? "KRW" : "USD", true);
          }
          dropdown.setAttribute("hidden", "");
          input.blur();
        }
      }
    });

    if (btn) {
      btn.addEventListener("click", () => {
        const firstBtn = dropdown.querySelector(".search-result-item");
        if (firstBtn && !dropdown.hasAttribute("hidden")) {
          firstBtn.click();
        } else if (input.value.trim()) {
          const raw = input.value.trim().toUpperCase();
          const dictHit = KR_TICKER_DICT.find((x) => x.symbol.toUpperCase() === raw || x.name.includes(input.value.trim()));
          if (dictHit) {
            selectTickerForLiveChart(dictHit.symbol, dictHit.cnbc, dictHit.name, dictHit.cur, true);
          } else {
            selectTickerForLiveChart(raw, raw, raw, raw.endsWith(".KS") ? "KRW" : "USD", true);
          }
          dropdown.setAttribute("hidden", "");
        }
      });
    }

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-input-wrap")) {
        dropdown.setAttribute("hidden", "");
      }
    });
  }

  function drawSparkline(canvas, values, isUp) {
    if (!canvas || !Array.isArray(values) || values.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(60, rect.width);
    const h = Math.max(24, rect.height);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const isDark = state.theme === "dark";
    const isKr = state.colorMode === "kr";
    const color = isUp
      ? isKr
        ? isDark ? "#F05650" : "#C9352E"
        : isDark ? "#36C98E" : "#1B7F56"
      : isKr
      ? isDark ? "#4A90E2" : "#2364AA"
      : isDark ? "#F05650" : "#C9352E";

    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const span = maxV - minV || 1;

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    values.forEach((v, idx) => {
      const x = (idx / (values.length - 1)) * (w - 4) + 2;
      const y = h - 3 - ((v - minV) / span) * (h - 6);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  /* ========================================================================
     8. 전쟁 · 유가 · 채권 · 환율 8대 매크로 레이더
     ======================================================================== */
  function renderMacroGrid() {
    const d = state.data;
    const grid = document.getElementById("macroGrid");
    if (!grid || !d || !Array.isArray(d.macros)) return;

    grid.innerHTML = d.macros
      .map((m, idx) => {
        const stLevel = m.status_level || "good";
        const stText = m.status_label || "안정";
        return `
        <article class="macro-card" data-macro-idx="${idx}">
          <div>
            <div class="macro-top">
              <span class="macro-cat">${m.category || ""}</span>
              <span class="macro-status ${stLevel}">${stText}</span>
            </div>
            <h3 class="macro-name">${m.name_kr}</h3>
            <div class="macro-val-row num">
              <span class="macro-price">${fmtPrice(m.price, null, m.unit)}</span>
              <span class="macro-chg ${dirClass(m.change_pct, false)}">${fmtSignedPct(m.change_pct)}</span>
            </div>
            <div class="macro-spark-wrap">
              <canvas id="macroSpark_${idx}"></canvas>
            </div>
          </div>
          <p class="macro-desc">${m.impact_note || ""}</p>
        </article>
      `;
      })
      .join("");

    requestAnimationFrame(() => {
      d.macros.forEach((m, idx) => {
        const cvs = document.getElementById(`macroSpark_${idx}`);
        const closes = (m.candles || []).slice(-30).map((c) => c.close);
        drawSparkline(cvs, closes, Number(m.change_pct) >= 0);
      });
    });

    grid.querySelectorAll(".macro-card").forEach((card) => {
      card.addEventListener("click", () => {
        const idx = Number(card.getAttribute("data-macro-idx"));
        const m = d.macros[idx];
        if (m) openDetailModal(m, "MACRO");
      });
    });
  }

  /* ========================================================================
     9. SOXX & RAM 핵심 보유 종목 20선
     ======================================================================== */
  function getFilteredAndSortedHoldings() {
    const d = state.data;
    if (!d || !Array.isArray(d.holdings)) return [];

    let list = d.holdings.filter((h) => {
      if (state.holdingFilter === "ALL") return true;
      if (state.holdingFilter === "RAM") {
        return (h.etf_group || "").includes("RAM") || (h.etf_group || "").includes("DRAM");
      }
      if (state.holdingFilter === "SOXX_AI") {
        return (h.subsector || "").includes("AI") || (h.subsector || "").includes("설계") || (h.subsector || "").includes("팹리스");
      }
      if (state.holdingFilter === "SOXX_EQUIP") {
        return (h.subsector || "").includes("장비") || (h.subsector || "").includes("파운드리");
      }
      if (state.holdingFilter === "MTT") {
        return Boolean(h.mtt?.mtt_pass);
      }
      return true;
    });

    if (state.holdingSort === "rs_desc") {
      list = [...list].sort((a, b) => (b.rs_score || 0) - (a.rs_score || 0));
    } else if (state.holdingSort === "chg_desc") {
      list = [...list].sort((a, b) => (b.change_pct || 0) - (a.change_pct || 0));
    } else if (state.holdingSort === "chg_asc") {
      list = [...list].sort((a, b) => (a.change_pct || 0) - (b.change_pct || 0));
    } else if (state.holdingSort === "high52_desc") {
      list = [...list].sort((a, b) => (b.pct_from_high || -999) - (a.pct_from_high || -999));
    }
    return list;
  }

  function renderHoldings() {
    const heatEl = document.getElementById("holdingsHeatmap");
    const gridEl = document.getElementById("holdingsCardGrid");
    if (!heatEl || !gridEl) return;

    const list = getFilteredAndSortedHoldings();

    heatEl.innerHTML = list
      .map(
        (h) => `
        <div class="heat-cell num" data-ticker="${h.ticker}">
          <div class="heat-top">
            <span class="heat-ticker">${h.ticker.replace(".KS", "")}</span>
            <span class="heat-rs">RS ${h.rs_score ?? "-"}</span>
          </div>
          <div class="heat-name">${h.name_kr}</div>
          <div class="heat-bottom">
            <span>${fmtPrice(h.price, h.currency)}</span>
            <span class="${dirClass(h.change_pct, false)}">${fmtSignedPct(h.change_pct)}</span>
          </div>
        </div>
      `
      )
      .join("");

    gridEl.innerHTML = list
      .map((h) => {
        const pos52 = Math.min(100, Math.max(2, Number(h.pos_52w || 50)));
        return `
        <article class="stock-card" data-ticker="${h.ticker}">
          <div class="stock-card-head">
            <div class="stock-title-group">
              <h3 class="stock-name">${h.name_kr}</h3>
              <span class="stock-ticker num">${h.ticker}</span>
              <span class="stock-group-badge">${h.etf_group || ""}</span>
              ${h.mtt?.mtt_pass ? '<span class="mtt-badge">★ MTT 정배열</span>' : ""}
            </div>

            <div class="stock-price-box num">
              <span class="stock-price">${fmtPrice(h.price, h.currency)}</span>
              <span class="stock-chg ${dirClass(h.change_pct, false)}">${fmtSignedChange(h.change, h.change_pct)}</span>
            </div>
          </div>

          <div class="stock-subsector">
            <span class="stock-subsector-text">${h.subsector || ""} ${h.foreign_ratio ? `· 외국인 ${h.foreign_ratio}%` : ""}</span>
            <button type="button" class="stock-live-jump-btn" data-jump-ticker="${h.ticker}" data-jump-name="${h.name_kr}" data-jump-cur="${h.currency || "USD"}">📈 실시간 차트</button>
          </div>

          <div class="stock-metrics-row num">
            <div class="sm-item">
              <span>RS 상대강도</span>
              <strong>${h.rs_score ?? "-"} / 99</strong>
            </div>
            <div class="sm-item">
              <span>RSI(14)</span>
              <strong>${h.rsi14 ?? "-"}</strong>
            </div>
            <div class="sm-item">
              <span>20일 지지선</span>
              <strong>${fmtPrice(h.support_20d, h.currency)}</strong>
            </div>
            <div class="sm-item">
              <span>20일 저항선</span>
              <strong>${fmtPrice(h.resistance_20d, h.currency)}</strong>
            </div>
          </div>

          <div class="pos52-bar-wrap num">
            <div class="pos52-labels">
              <span>52주 저가 ${fmtPrice(h.low_52w, h.currency)}</span>
              <span>위치 ${pos52.toFixed(0)}% (${fmtSignedPct(h.pct_from_high)})</span>
              <span>52주 고가 ${fmtPrice(h.high_52w, h.currency)}</span>
            </div>
            <div class="pos52-track">
              <div class="pos52-fill" style="width:${pos52}%;"></div>
            </div>
          </div>

          <p class="stock-note">${h.role_note || ""}</p>
        </article>
      `;
      })
      .join("");

    // [📈 실시간 차트] 버튼 클릭 시 상단 라이브 차트로 직행
    gridEl.querySelectorAll(".stock-live-jump-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const tk = btn.getAttribute("data-jump-ticker");
        const nm = btn.getAttribute("data-jump-name");
        const cur = btn.getAttribute("data-jump-cur");
        selectTickerForLiveChart(tk, tk, nm, cur, true);
      });
    });

    // 카드 본체나 히트맵 클릭 시 바텀시트 상세 모달 오픈
    const bindCardClick = (el) => {
      el.addEventListener("click", () => {
        const tk = el.getAttribute("data-ticker");
        const target = (state.data?.holdings || []).find((x) => x.ticker === tk);
        if (target) openDetailModal(target, "STOCK");
      });
    };
    heatEl.querySelectorAll(".heat-cell").forEach(bindCardClick);
    gridEl.querySelectorAll(".stock-card").forEach(bindCardClick);
  }

  function bindHoldingsControls() {
    document.querySelectorAll("[data-holding-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.holdingFilter = btn.getAttribute("data-holding-filter") || "ALL";
        document.querySelectorAll("[data-holding-filter]").forEach((b) => b.classList.toggle("active", b === btn));
        renderHoldings();
      });
    });

    const sortSel = document.getElementById("holdingSortSelect");
    if (sortSel) {
      sortSel.addEventListener("change", () => {
        state.holdingSort = sortSel.value;
        renderHoldings();
      });
    }
  }

  /* ========================================================================
     10. 글로벌 소식 & 지정학 뉴스룸 (다중 채널 실시간 크롤러 & 키워드 즉석 서치)
     ======================================================================== */
  state.newsSearchKeyword = "";

  function renderNews() {
    const d = state.data;
    const grid = document.getElementById("newsGrid");
    if (!grid || !d || !Array.isArray(d.news)) return;

    const kw = String(state.newsSearchKeyword || "").trim().toLowerCase();
    const enKw = kw ? mapKoreanQueryToEnglish(kw).toLowerCase() : "";
    const filtered = d.news.filter((n) => {
      if (state.newsFilter !== "ALL" && n.category !== state.newsFilter) return false;
      if (kw) {
        const hay = `${n.title || ""} ${n.summary || ""} ${n.matched_query || ""} ${n.source || ""} ${
          n.category || ""
        }`.toLowerCase();
        return hay.includes(kw) || (enKw && hay.includes(enKw));
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="panel-card" style="grid-column:1/-1; text-align:center; color:var(--ink-muted);">해당 조건(${kw || state.newsFilter})의 최신 소식을 실시간 검색 중이거나 결과가 없습니다. 상단 [뉴스 즉시 서치]를 눌러 웹에서 새로 긁어오세요.</div>`;
      return;
    }

    grid.innerHTML = filtered
      .map(
        (n, idx) => `
        <article class="news-card">
          <div>
            <div class="news-meta">
              <span class="news-cat-tag">${n.category || "소식"}</span>
              <span class="news-source num">${n.source || "Global News"} · ${n.pub_date || n.date || ""}</span>
            </div>
            <a href="${n.link || "#"}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">
              <h3 class="news-title" style="margin-top:6px;">${n.title || ""}</h3>
            </a>
            ${
              n.summary
                ? `<p style="font-size:0.75rem; color:var(--ink-muted); margin:6px 0 0; line-height:1.42; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${n.summary}</p>`
                : ""
            }
          </div>
          <div class="news-card-foot">
            <a href="${n.link || "#"}" target="_blank" rel="noopener noreferrer" style="font-size:0.71rem; color:var(--ink-muted); text-decoration:none;">원문 기사 열기 ↗</a>
            <button type="button" class="news-ai-ask-btn" data-ask-news-idx="${idx}">🤖 AI 시황해설</button>
          </div>
        </article>
      `
      )
      .join("");

    grid.querySelectorAll("[data-ask-news-idx]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const i = parseInt(btn.getAttribute("data-ask-news-idx") || "0", 10);
        const item = filtered[i];
        if (item && typeof askAiAboutNewsItem === "function") {
          askAiAboutNewsItem(item);
        }
      });
    });

    if (typeof renderAiMicroNewsFeed === "function") {
      renderAiMicroNewsFeed();
    }
  }

  function formatKstDateStrFromEpochSec(epochSec) {
    if (!epochSec || isNaN(epochSec)) return "";
    const kst = new Date((epochSec + 9 * 3600) * 1000);
    const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(kst.getUTCDate()).padStart(2, "0");
    const hh = String(kst.getUTCHours()).padStart(2, "0");
    const mi = String(kst.getUTCMinutes()).padStart(2, "0");
    return `${mm}.${dd} ${hh}:${mi}`;
  }

  function extractRealBingUrl(rawLink) {
    if (!rawLink) return "#";
    try {
      const u = new URL(rawLink);
      const target = u.searchParams.get("url");
      if (target && target.startsWith("http")) return target;
    } catch (e) {
      // ignore
    }
    return rawLink;
  }

  // 0) Daum 최신 뉴스 실시간 크롤러 (Jina Reader 경유, CORS: * 무제한, 본문 요약 + 초단위 시각 추출)
  async function fetchDaumLiveNewsViaJina(query, category, limit = 10) {
    try {
      const targetUrl = `https://search.daum.net/search?w=news&sort=recency&q=${encodeURIComponent(query)}`;
      const jinaUrl = `https://r.jina.ai/${targetUrl}`;
      const resp = await fetch(jinaUrl, { cache: "no-store" });
      if (!resp.ok) return [];
      const txt = await resp.text();
      const blocks = txt.split("\n*   ");
      const out = [];
      for (let i = 1; i < blocks.length; i++) {
        const b = blocks[i];
        const mPress = b.match(/\*\*([^*]+)\*\*\]\(https?:\/\/v\.daum\.net\/channel/);
        const press = mPress ? mPress[1].trim() : "실시간 속보";
        const mTitle = b.match(/\*\*\[([\s\S]+?)\]\((https?:\/\/v\.daum\.net\/v\/(\d{14})\d*)\)\*\*/);
        if (!mTitle) continue;
        const rawTitle = mTitle[1].replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
        const link = mTitle[2].replace(/^http:\/\//, "https://");
        const dt14 = mTitle[3];
        const rest = b.slice(b.indexOf(mTitle[0]) + mTitle[0].length);
        const mSum = rest.match(/\[([\s\S]+?)\]\(https?:\/\/v\.daum\.net\/v\/\d+\)/);
        const summary = mSum
          ? mSum[1].replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 220)
          : "";

        const yyyy = parseInt(dt14.slice(0, 4), 10);
        const mm = parseInt(dt14.slice(4, 6), 10) - 1;
        const dd = parseInt(dt14.slice(6, 8), 10);
        const hh = parseInt(dt14.slice(8, 10), 10);
        const mi = parseInt(dt14.slice(10, 12), 10);
        const ss = parseInt(dt14.slice(12, 14), 10);
        // dt14는 KST 기준이므로 UTC epoch 계산 시 -9시간
        const ts = Math.floor((Date.UTC(yyyy, mm, dd, hh, mi, ss) - 9 * 3600 * 1000) / 1000);
        const dateStr = `${dt14.slice(4, 6)}.${dt14.slice(6, 8)} ${dt14.slice(8, 10)}:${dt14.slice(10, 12)}`;

        out.push({
          title: rawTitle,
          summary,
          link,
          source: press,
          date: dateStr,
          pub_date: dateStr,
          timestamp: ts,
          category,
          lang: "ko",
          matched_query: String(query || "").toLowerCase(),
        });
        if (out.length >= limit) break;
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  // 1) Bing News 실시간 RSS -> rss2json (CORS: * 완벽 지원, 한국어/영어 최신순)
  async function fetchBingLiveNewsViaRss2Json(query, category, lang = "ko", limit = 8) {
    try {
      const cc = lang === "ko" ? "KR" : "US";
      const setlang = lang === "ko" ? "ko" : "en";
      const rssUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&setlang=${setlang}&cc=${cc}&sortby=date&format=rss`;
      const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;
      const resp = await fetch(apiUrl, { cache: "no-store" });
      if (!resp.ok) return [];
      const data = await resp.json();
      const rawItems = data?.items || [];
      const out = [];
      rawItems.forEach((it) => {
        let title = String(it.title || "").trim();
        if (!title) return;
        const link = extractRealBingUrl(it.link || "#");
        // rss2json pubDate는 "YYYY-MM-DD HH:MM:SS" UTC 포맷
        const pubRaw = String(it.pubDate || "").trim();
        let dtMs = Date.parse(pubRaw.includes("T") ? pubRaw : pubRaw.replace(" ", "T") + "Z");
        if (isNaN(dtMs)) dtMs = Date.now();
        const ts = Math.floor(dtMs / 1000);
        let source = lang === "ko" ? "실시간 뉴스" : "Wall St. News";
        const dashIdx = title.lastIndexOf(" - ");
        if (dashIdx > 0 && title.length - dashIdx < 26) {
          source = title.slice(dashIdx + 3).trim();
          title = title.slice(0, dashIdx).trim();
        }
        const rawDesc = String(it.description || it.content || "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 220);
        out.push({
          title,
          summary: rawDesc,
          link,
          source,
          date: formatKstDateStrFromEpochSec(ts),
          pub_date: formatKstDateStrFromEpochSec(ts),
          timestamp: ts,
          category,
          lang,
        });
      });
      out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      return out.slice(0, limit);
    } catch (e) {
      return [];
    }
  }

  // 2) 한국 주요 경제지(한국경제·매일경제·연합뉴스) 실시간 RSS -> 반도체/매크로 키워드 자동 분류
  async function fetchKoreanMajorEconomyLiveRss() {
    const feeds = [
      { name: "한국경제", url: "https://www.hankyung.com/feed/finance" },
      { name: "한국경제 IT", url: "https://www.hankyung.com/feed/it" },
      { name: "매일경제", url: "https://www.mk.co.kr/rss/50200011/" },
      { name: "연합뉴스", url: "https://www.yna.co.kr/rss/economy.xml" },
    ];
    const results = [];
    await Promise.all(
      feeds.map(async (f) => {
        try {
          const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(f.url)}`;
          const resp = await fetch(apiUrl, { cache: "no-store" });
          if (!resp.ok) return;
          const json = await resp.json();
          (json?.items || []).forEach((it) => {
            const title = String(it.title || "").trim();
            if (!title) return;
            let cat = null;
            if (/(삼성전자|SK하이닉스|하이닉스|마이크론|HBM|D램|DRAM|낸드|샌디스크|한미반도체|메모리)/i.test(title)) {
              cat = "메모리 · RAM";
            } else if (/(엔비디아|TSMC|브로드컴|AMD|인텔|반도체|AI칩|AI 칩|파운드리|ASML|마벨|퀄컴|필라델피아)/i.test(title)) {
              cat = "SOXX · AI반도체";
            } else if (/(국제유가|WTI|브렌트유|원유|호르무즈|정유|에너지)/i.test(title)) {
              cat = "유가 · 에너지";
            } else if (/(이란|중동|전쟁|대만|관세|수출통제|트럼프)/i.test(title)) {
              cat = "전쟁 · 지정학";
            } else if (/(국채|금리|연준|FOMC|환율|달러|채권)/i.test(title)) {
              cat = "채권 · 금리";
            }
            if (!cat) return;
            const pubRaw = String(it.pubDate || "").trim();
            // 한국 언론사 RSS를 rss2json이 파싱할 때 UTC 변환 여부 보정 (미래 시각이면 -9시간)
            let dtMs = Date.parse(pubRaw.includes("T") ? pubRaw : pubRaw.replace(" ", "T") + "Z");
            if (isNaN(dtMs)) dtMs = Date.now();
            if (dtMs > Date.now() + 1800 * 1000) {
              dtMs -= 9 * 3600 * 1000;
            }
            const ts = Math.floor(dtMs / 1000);
            results.push({
              title,
              link: it.link || "#",
              source: f.name,
              date: formatKstDateStrFromEpochSec(ts),
              pub_date: formatKstDateStrFromEpochSec(ts),
              timestamp: ts,
              category: cat,
              lang: "ko",
            });
          });
        } catch (e) {
          // ignore
        }
      })
    );
    return results;
  }

  // 3) CNBC Queryly 실시간 월가 속보 API (CORS: * 무제한, 초고속) + 한글 핵심 태그 자동 부착
  function buildKoreanTagForEnglishHeadline(title) {
    const t = String(title || "");
    const tags = [];
    if (/nvidia|nvda|jensen/i.test(t)) tags.push("엔비디아");
    if (/intel|intc/i.test(t)) tags.push("인텔");
    if (/amd|advanced micro/i.test(t)) tags.push("AMD");
    if (/micron|\bmu\b|hbm|dram|memory/i.test(t)) tags.push("마이크론·메모리");
    if (/broadcom|avgo/i.test(t)) tags.push("브로드컴");
    if (/tsmc|taiwan semi/i.test(t)) tags.push("TSMC");
    if (/marvell|mrvl/i.test(t)) tags.push("마벨");
    if (/asml/i.test(t)) tags.push("ASML");
    if (/sandisk|sndk|western digital|wdc|seagate/i.test(t)) tags.push("스토리지·낸드");
    if (/oracle|orcl|coreweave/i.test(t)) tags.push("AI인프라·CDS");
    if (/oil|crude|brent|wti|opec|iran/i.test(t)) tags.push("유가·중동");
    if (/treasury|yield|fed|powell|rate|inflation/i.test(t)) tags.push("미금리·연준");
    if (/tariff|china|export/i.test(t)) tags.push("관세·지정학");
    if (tags.length === 0 && /chip|semiconductor|ai/i.test(t)) tags.push("AI·반도체");
    return tags.length > 0 ? `[월가속보 · ${tags.slice(0, 2).join("·")}] ` : "";
  }

  async function fetchCnbcLiveByCategory(query, category, limit = 6, addKrPrefix = false) {
    try {
      const url = `https://api.queryly.com/cnbc/json.aspx?queryly_key=31a35d40a9a64ab3&query=${encodeURIComponent(
        query
      )}&endindex=0&batchsize=${limit}&sort=date`;
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return [];
      const json = await resp.json();
      const results = json?.results || [];
      const items = [];
      results.forEach((r) => {
        const rawTitle = (r["cn:title"] || r.title || "").trim();
        const link = r.url || r["cn:liveURL"] || "#";
        const pubIso = r.datePublished || r["cn:lastPubDate"] || "";
        const dtMs = Date.parse(pubIso);
        if (!rawTitle || isNaN(dtMs)) return;
        const ts = Math.floor(dtMs / 1000);
        const prefix = addKrPrefix ? buildKoreanTagForEnglishHeadline(rawTitle) : "";
        const rawDesc = String(r.description || r["cn:promoText"] || "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 220);
        items.push({
          title: `${prefix}${rawTitle}`,
          summary: rawDesc,
          link,
          source: "CNBC Live",
          date: formatKstDateStrFromEpochSec(ts),
          pub_date: formatKstDateStrFromEpochSec(ts),
          timestamp: ts,
          category,
          lang: "en",
        });
      });
      return items;
    } catch (e) {
      return [];
    }
  }

  // 한글 키워드 -> 영문 월가 티커/키워드 매핑 (한글로 검색해도 미국 CNBC 실시간 속보까지 동시에 긁어옴)
  function mapKoreanQueryToEnglish(q) {
    const map = [
      [/엔비디아/g, "NVIDIA"],
      [/마이크론/g, "Micron"],
      [/하이닉스|SK하이닉스/g, "SK Hynix"],
      [/삼성전자|삼전/g, "Samsung"],
      [/인텔/g, "Intel"],
      [/브로드컴/g, "Broadcom"],
      [/마벨/g, "Marvell"],
      [/샌디스크/g, "SanDisk"],
      [/웨스턴디지털/g, "Western Digital"],
      [/씨게이트/g, "Seagate"],
      [/한미반도체/g, "HBM"],
      [/오라클/g, "Oracle"],
      [/코어위브/g, "CoreWeave"],
      [/퀄컴/g, "Qualcomm"],
      [/어플라이드/g, "Applied Materials"],
      [/램리서치/g, "Lam Research"],
      [/유가|원유|호르무즈/g, "crude oil WTI Brent"],
      [/금리|국채|연준/g, "Treasury yield Fed"],
      [/관세|전쟁|이란|중동/g, "Iran Middle East tariff"],
      [/반도체/g, "semiconductor SOXX"],
    ];
    let out = String(q || "");
    map.forEach(([re, en]) => {
      out = out.replace(re, en);
    });
    return out;
  }

  // 사용자가 원하는 키워드로 한국 + 미국 실시간 뉴스를 즉석에서 긁어오는 함수
  async function searchLiveNewsByKeyword(rawKeyword, targetSection) {
    const kw = String(rawKeyword || "").trim();
    if (!kw) return [];

    const spinIcon = document.getElementById("newsRefreshSpinIcon");
    const statusTxt = document.getElementById("newsLastRefreshedText");
    const aiStat = document.getElementById("aiScannerStatusText");
    const aiListEl = document.getElementById("aiMicroNewsList");
    if (spinIcon) spinIcon.classList.add("spinning");
    if (statusTxt) statusTxt.textContent = `'${kw}' 실시간 뉴스 서치 중...`;
    if (aiStat) aiStat.textContent = `'${kw}' 실시간 서치 중...`;
    if (targetSection === "AI_DESK" && aiListEl) {
      aiListEl.innerHTML = `<div style="padding:18px 12px; text-align:center; color:var(--gold-main); font-size:0.82rem; font-weight:700;">⏳ '${kw}' 관련 한·미 실시간 최신 속보를 웹에서 긁어오는 중입니다...</div>`;
    }

    try {
      const enKw = mapKoreanQueryToEnglish(kw);
      let guessedCat = "SOXX · AI반도체";
      if (/(하이닉스|삼성|마이크론|HBM|D램|DRAM|낸드|샌디스크|메모리|RAM)/i.test(kw)) {
        guessedCat = "메모리 · RAM";
      } else if (/(유가|원유|WTI|브렌트|에너지)/i.test(kw)) {
        guessedCat = "유가 · 에너지";
      } else if (/(전쟁|이란|중동|호르무즈|대만|관세)/i.test(kw)) {
        guessedCat = "전쟁 · 지정학";
      } else if (/(금리|국채|연준|FOMC|채권|환율)/i.test(kw)) {
        guessedCat = "채권 · 금리";
      }

      const [daumKo, bingKo, cnbcEn] = await Promise.all([
        fetchDaumLiveNewsViaJina(kw, guessedCat, 10),
        fetchBingLiveNewsViaRss2Json(kw, guessedCat, "ko", 6),
        fetchCnbcLiveByCategory(enKw, guessedCat, 6, true),
      ]);

      const kwLow = kw.toLowerCase();
      const fresh = [...daumKo, ...bingKo, ...cnbcEn].map((item) => ({
        ...item,
        matched_query: kwLow,
      }));
      state.lastSearchedQuery = kw;
      state.lastSearchedItems = fresh;

      if (state.data && Array.isArray(state.data.news)) {
        const combined = [...fresh, ...state.data.news];
        const seen = new Set();
        const deduped = [];
        combined.forEach((it) => {
          if (!it || !it.title) return;
          const normKey = String(it.title).replace(/\[[^\]]+\]\s*/, "").replace(/\s+/g, "").slice(0, 26);
          if (seen.has(normKey)) {
            const existing = deduped.find(
              (x) => String(x.title).replace(/\[[^\]]+\]\s*/, "").replace(/\s+/g, "").slice(0, 26) === normKey
            );
            if (existing && it.matched_query) {
              existing.matched_query = `${existing.matched_query || ""} ${it.matched_query}`.trim();
            }
            if (existing && !existing.summary && it.summary) {
              existing.summary = it.summary;
            }
            return;
          }
          seen.add(normKey);
          deduped.push(it);
        });
        deduped.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        state.data.news = deduped.slice(0, 96);
      }

      if (targetSection === "NEWSROOM") {
        state.newsFilter = "ALL";
        state.newsSearchKeyword = kw;
        document.querySelectorAll("[data-news-filter]").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-news-filter") === "ALL");
        });
      } else if (targetSection === "AI_DESK") {
        state.aiTopicFilter = kw;
      }

      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");
      if (statusTxt) statusTxt.textContent = `'${kw}' ${fresh.length}건 실시간 서치 완료 (${hh}:${mm}:${ss})`;
      if (aiStat) aiStat.textContent = `'${kw}' ${fresh.length}건 실시간 수집됨 (${hh}:${mm}:${ss})`;

      renderNews();
      renderAiMicroNewsFeed();
      return fresh;
    } catch (e) {
      return [];
    } finally {
      if (spinIcon) setTimeout(() => spinIcon.classList.remove("spinning"), 350);
    }
  }

  async function refreshNewsAndIntelligence(isManual) {
    const d = state.data;
    if (!d) return;

    const spinIcon = document.getElementById("newsRefreshSpinIcon");
    const statusTxt = document.getElementById("newsLastRefreshedText");
    const aiStat = document.getElementById("aiScannerStatusText");
    if (spinIcon) spinIcon.classList.add("spinning");
    if (statusTxt && isManual) statusTxt.textContent = "한·미 실시간 속보 크롤링 중...";
    if (aiStat && isManual) aiStat.textContent = "실시간 뉴스 크롤링 중...";

    try {
      const tsParam = Date.now();
      const rawGithubUrl = `https://raw.githubusercontent.com/evening-soxx/evening-soxx.github.io/main/intelligence_data.json?t=${tsParam}`;

      const [
        localSnapResp,
        rawGithubResp,
        daumMem,
        daumAi,
        bingMacro,
        krMajor,
        cnbcAi,
        cnbcMem,
        cnbcMacro,
        cnbcWallSt,
        liveDramOk,
      ] = await Promise.all([
        fetch(`./intelligence_data.json?t=${tsParam}`, { cache: "no-store" }).catch(() => null),
        fetch(rawGithubUrl, { cache: "no-store" }).catch(() => null),
        fetchDaumLiveNewsViaJina("SK하이닉스 마이크론 삼성전자 HBM", "메모리 · RAM", 8),
        fetchDaumLiveNewsViaJina("엔비디아 인텔 TSMC 필라델피아반도체", "SOXX · AI반도체", 8),
        fetchBingLiveNewsViaRss2Json("국제유가 국채 금리 연준 반도체", "채권 · 금리", "ko", 6),
        fetchKoreanMajorEconomyLiveRss(),
        fetchCnbcLiveByCategory("NVIDIA OR Broadcom OR AMD OR Intel OR TSMC OR Marvell", "SOXX · AI반도체", 6, true),
        fetchCnbcLiveByCategory("Micron OR HBM OR DRAM OR SanDisk OR Western Digital", "메모리 · RAM", 5, true),
        fetchCnbcLiveByCategory("Iran oil OR Brent crude OR 10-year Treasury yield OR tariff", "전쟁 · 지정학", 5, true),
        fetchCnbcLiveByCategory("semiconductor OR NVIDIA OR Micron OR Intel OR AMD OR TSMC", "월가 영문속보", 8, false),
        fetchLiveDramEtfFlow(),
      ]);

      let snapNews = [];
      for (const resp of [rawGithubResp, localSnapResp]) {
        if (resp && resp.ok) {
          try {
            const rawJson = await resp.json();
            const norm = normalizeRawData(rawJson);
            if (norm) {
              if (!liveDramOk && norm.dram_etf_flow && norm.dram_etf_flow.latest_aum) {
                d.dram_etf_flow = norm.dram_etf_flow;
                renderDramFlowPanel();
              }
              if (Array.isArray(norm.news)) {
                snapNews.push(...norm.news);
              }
            }
          } catch (e) {
            // 무시
          }
        }
      }

      const combined = [
        ...daumMem,
        ...daumAi,
        ...bingMacro,
        ...krMajor,
        ...cnbcAi,
        ...cnbcMem,
        ...cnbcMacro,
        ...cnbcWallSt,
        ...snapNews,
        ...(d.news || []),
      ];

      const seen = new Set();
      const deduped = [];
      for (let i = 0; i < combined.length; i++) {
        const it = combined[i];
        if (!it || !it.title) continue;
        const normKey = String(it.title).replace(/\[[^\]]+\]\s*/, "").replace(/\s+/g, "").slice(0, 26);
        if (seen.has(normKey)) continue;
        seen.add(normKey);
        deduped.push({
          ...it,
          pub_date: it.pub_date || it.date || "",
          timestamp: it.timestamp || 0,
        });
      }

      deduped.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      if (deduped.length > 0) {
        d.news = deduped.slice(0, 72);
        renderNews();
      }

      renderBriefingSection();

      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");
      if (statusTxt) {
        statusTxt.textContent = `${state.newsRefreshMinutes}분 자동 · 최근 ${hh}:${mm}:${ss} 실시간 갱신 (${d.news.length}건)`;
      }
      if (aiStat) {
        aiStat.textContent = `최근 ${hh}:${mm}:${ss} · ${d.news.length}건 수집됨`;
      }
    } catch (e) {
      // 오프라인 시 기존 뉴스 유지
    } finally {
      if (spinIcon) {
        setTimeout(() => spinIcon.classList.remove("spinning"), 400);
      }
    }
  }

  function scheduleNewsAutoRefresh() {
    if (state.newsRefreshTimer) {
      clearInterval(state.newsRefreshTimer);
    }
    const ms = Math.max(1, state.newsRefreshMinutes) * 60 * 1000;
    state.newsRefreshTimer = setInterval(() => {
      refreshNewsAndIntelligence(false);
    }, ms);
  }

  function bindNewsControls() {
    document.querySelectorAll("[data-news-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.newsFilter = btn.getAttribute("data-news-filter") || "ALL";
        state.newsSearchKeyword = "";
        const kwInput = document.getElementById("newsKeywordSearchInput");
        if (kwInput) kwInput.value = "";
        document.querySelectorAll("[data-news-filter]").forEach((b) => b.classList.toggle("active", b === btn));
        renderNews();
      });
    });

    const kwInput = document.getElementById("newsKeywordSearchInput");
    const kwBtn = document.getElementById("btnNewsKeywordSearch");
    const kwReset = document.getElementById("btnNewsKeywordReset");

    if (kwBtn && kwInput) {
      kwBtn.addEventListener("click", () => {
        const val = kwInput.value.trim();
        if (val) {
          searchLiveNewsByKeyword(val, "NEWSROOM");
        } else {
          state.newsSearchKeyword = "";
          renderNews();
        }
      });
      kwInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          kwBtn.click();
        }
      });
    }

    if (kwReset) {
      kwReset.addEventListener("click", () => {
        state.newsSearchKeyword = "";
        if (kwInput) kwInput.value = "";
        renderNews();
      });
    }

    const ivTabs = document.getElementById("newsRefreshIntervalTabs");
    if (ivTabs) {
      ivTabs.querySelectorAll("[data-news-iv]").forEach((btn) => {
        const ivVal = parseInt(btn.getAttribute("data-news-iv") || "5", 10);
        btn.classList.toggle("active", ivVal === state.newsRefreshMinutes);
        btn.addEventListener("click", () => {
          state.newsRefreshMinutes = ivVal;
          localStorage.setItem("evening_soxx_news_iv", String(ivVal));
          ivTabs.querySelectorAll("[data-news-iv]").forEach((b) => b.classList.toggle("active", b === btn));
          scheduleNewsAutoRefresh();
          const statusTxt = document.getElementById("newsLastRefreshedText");
          if (statusTxt) {
            statusTxt.textContent = `${ivVal}분 간격 실시간 자동 수집 적용됨`;
          }
        });
      });
    }

    const btnNow = document.getElementById("btnRefreshNewsNow");
    if (btnNow) {
      btnNow.addEventListener("click", () => {
        refreshNewsAndIntelligence(true);
      });
    }
  }

  /* ========================================================================
     11. 바텀시트 상세 모달 & 히트맵 종목 터치 즉시 팝업/이동 엔진
     ======================================================================== */
  const EXTRA_SOXX_STOCK_META = {
    ADI: {
      name_kr: "아날로그 디바이스 (ADI)",
      subsector: "산업·차량용 아날로그 반도체",
      etf_group: "SOXX 핵심 (4.67%)",
      role_note: "텍사스 인스트루먼트(TXN)와 함께 글로벌 아날로그 신호처리 반도체를 양분하는 대표 기업으로, 산업 자동화 및 데이터센터 전력 제어 수요의 핵심 수혜주입니다.",
    },
    TER: {
      name_kr: "테라다인 (Teradyne)",
      subsector: "반도체 자동화 테스트(ATE) 장비",
      etf_group: "SOXX 장비 (2.76%)",
      role_note: "엔비디아·TSMC·메모리 3사의 AI 가속기 및 HBM 수율 검사를 담당하는 글로벌 반도체 테스트 장비(ATE) 및 협동로봇 선두 기업입니다.",
    },
    MCHP: {
      name_kr: "마이크로칩 테크놀로지 (MCHP)",
      subsector: "마이크로컨트롤러(MCU) · 아날로그",
      etf_group: "SOXX 편입 (2.35%)",
      role_note: "자동차·방산·산업용 마이크로컨트롤러(MCU)와 데이터센터 스토리지 컨트롤러를 공급하며 레거시 반도체 재고 사이클의 풍향계 역할을 합니다.",
    },
    ALAB: {
      name: "아스테라 랩스 (Astera Labs)",
      name_kr: "아스테라 랩스 (Astera Labs)",
      subsector: "AI 데이터센터 초고속 연결칩 (PCIe·CXL)",
      etf_group: "SOXX AI연결 (1.54%)",
      role_note: "AI 서버 내부에서 GPU와 CPU, HBM·CXL 메모리를 병목 없이 초고속으로 연결하는 리타이머(Retimer) 반도체의 독보적 강자입니다.",
    },
    CRDO: {
      name_kr: "크레도 테크놀로지 (Credo)",
      subsector: "AI 데이터센터 고속 연결 솔루션 (AEC)",
      etf_group: "SOXX AI네트워크 (1.32%)",
      role_note: "하이퍼스케일 AI 클러스터의 전력 소모를 획기적으로 줄이는 액티브 전기 케이블(AEC) 및 고속 SerDes 인터커넥트 핵심 수혜주입니다.",
    },
    ENTG: {
      name_kr: "인테그리스 (Entegris)",
      subsector: "첨단 반도체 소재 · 초고순도 케미컬",
      etf_group: "SOXX 소재 (1.18%)",
      role_note: "2나노 GAA 파운드리 공정과 16단 HBM 적층에 필수적인 초고순도 세정·연마(CMP)·오염제어 소재를 독점 공급하는 글로벌 1위 반도체 소재 기업입니다.",
    },
    ONTO: {
      name_kr: "온토 이노베이션 (Onto Innovation)",
      subsector: "HBM·CoWoS 첨단 패키징 계측·검사장비",
      etf_group: "SOXX 패키징장비 (1.02%)",
      role_note: "TSMC의 CoWoS 패키징과 HBM 적층 미세 결함을 잡아내는 3D 광학 계측·검사 장비 강자로 KLA와 함께 후공정 수율의 핵심 축입니다.",
    },
    SWKS: {
      name_kr: "스카이웍스 솔루션즈 (Skyworks)",
      subsector: "RF 무선통신 · 온디바이스 AI 칩",
      etf_group: "SOXX 무선통신 (0.70%)",
      role_note: "스마트폰 및 자율주행·IoT 기기용 5G/6G RF 프론트엔드 모듈을 공급하며 온디바이스 AI 교체 주기와 밀접하게 연동됩니다.",
    },
  };

  function pulseElementHighlight(el) {
    if (!el) return;
    el.classList.remove("card-focus-pulse");
    void el.offsetWidth;
    el.classList.add("card-focus-pulse");
    setTimeout(() => {
      el.classList.remove("card-focus-pulse");
    }, 3400);
  }

  function resolveOrBuildStockItem(symbol, fallbackName, fallbackCur, weightPct) {
    const d = state.data;
    const holdMatch = (d?.holdings || []).find((h) => h.ticker === symbol);
    const liveMatch = state.soxxLiveMap?.[symbol];
    const extraMeta = EXTRA_SOXX_STOCK_META[symbol] || {};
    const cur = fallbackCur || holdMatch?.currency || (String(symbol).endsWith(".KS") ? "KRW" : "USD");

    const tmRef =
      SOXX_TREEMAP_CONSTITUENTS.find((x) => x.symbol === symbol) ||
      RAM_TREEMAP_CONSTITUENTS.find((x) => x.symbol === symbol);
    const effWeight = weightPct || tmRef?.weight || null;

    if (holdMatch) {
      const price = liveMatch?.price ?? holdMatch.price;
      const change_pct = liveMatch?.change_pct ?? holdMatch.change_pct;
      const change = liveMatch?.change ?? holdMatch.change;
      return {
        ...holdMatch,
        price,
        change,
        change_pct,
        etf_group: effWeight ? `${holdMatch.etf_group || "핵심 편입"} · 비중 ${effWeight.toFixed(2)}%` : holdMatch.etf_group,
      };
    }

    const price = liveMatch?.price ?? tmRef?.defaultPrice ?? 100;
    const change_pct = liveMatch?.change_pct ?? tmRef?.defaultPct ?? 0;
    const change = liveMatch?.change ?? Number(((price * change_pct) / (100 + change_pct || 100)).toFixed(2));

    return {
      ticker: symbol,
      symbol,
      name_kr: extraMeta.name_kr || fallbackName || tmRef?.name || symbol,
      currency: cur,
      price,
      change,
      change_pct,
      etf_group: extraMeta.etf_group || (effWeight ? `ETF 편입 비중 ${effWeight.toFixed(2)}%` : "SOXX 구성종목"),
      subsector: extraMeta.subsector || "글로벌 반도체 핵심 구성종목",
      support_20d: Number((price * 0.94).toFixed(2)),
      resistance_20d: Number((price * 1.06).toFixed(2)),
      rs_score: change_pct >= 0 ? 78 : 64,
      rsi14: 52.0,
      returns: { "1m": null, "3m": null, "1y": null },
      role_note:
        extraMeta.role_note ||
        `${fallbackName || symbol} 종목은 iShares SOXX / Direxion SOXL 반도체 지수를 구성하는 핵심 편입 종목입니다.`,
      candles: [],
    };
  }

  function scrollToStockCard(symbol, fallbackName, fallbackCur) {
    const sym = String(symbol || "");
    if (state.activeSectionTab !== "sec-holdings" && typeof switchActiveSectionTab === "function") {
      switchActiveSectionTab("sec-holdings", { scrollTop: false, updateHash: true });
    }
    let card = document.querySelector(`#holdingsCardGrid .stock-card[data-ticker="${sym}"]`);

    // 필터 때문에 숨겨져 있으면 자동으로 '전체 보기(ALL)'로 풀어서 렌더링
    if (!card && state.holdingFilter !== "ALL") {
      const existsInData = (state.data?.holdings || []).some((h) => h.ticker === sym);
      if (existsInData) {
        state.holdingFilter = "ALL";
        document.querySelectorAll("[data-holding-filter]").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-holding-filter") === "ALL");
        });
        renderHoldings();
        card = document.querySelector(`#holdingsCardGrid .stock-card[data-ticker="${sym}"]`);
      }
    }

    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      pulseElementHighlight(card);
      return true;
    }

    // 22선 카드에 없는 소형 SOXX 구성종목이면 상단 메인 1분봉 차트로 이동 후 포커스
    selectTickerForLiveChart(sym, sym, fallbackName || sym, fallbackCur || "USD", true, true);
    const chartPanel = document.querySelector(".chart-panel");
    pulseElementHighlight(chartPanel);
    return false;
  }

  function openStockPopupOrJump(symbol, name, cur, weightPct, actionOverride) {
    const mode = actionOverride || state.treemapClickAction || "MODAL";
    const item = resolveOrBuildStockItem(symbol, name, cur, weightPct);

    // 백그라운드에서 상단 메인 차트도 해당 종목 1분봉으로 동기화
    selectTickerForLiveChart(symbol, symbol, item.name_kr || name || symbol, item.currency || cur || "USD", false, true);

    if (mode === "CHART") {
      const chartEl = document.querySelector(".chart-panel");
      if (chartEl) {
        chartEl.scrollIntoView({ behavior: "smooth", block: "start" });
        pulseElementHighlight(chartEl);
      }
      return;
    }

    if (mode === "CARD") {
      scrollToStockCard(symbol, item.name_kr || name, item.currency || cur);
      return;
    }

    openDetailModal(item, "STOCK");
  }

  async function loadModalLiveChart(item, interval) {
    const sym = item.ticker || item.key || "SOXX";
    const cnbcMap = { US10Y: "US10Y", US5Y: "US5Y", WTI: "@CL.1", BRENT: "@LCO.1", GOLD: "@GC.1", VIX: ".VIX", USDKRW: "KRW=" };
    const cnbcSym = cnbcMap[sym] || sym;
    const cur = item.currency || (item.unit === "%" ? "PCT" : item.unit === "원" ? "KRW" : "USD");

    if (interval === "1D" && Array.isArray(item.candles) && item.candles.length > 5) {
      drawCandlestickChart("modalChartCanvas", item.candles.slice(-75), {
        support20: item.support_20d,
        resistance20: item.resistance_20d,
        currency: cur,
      });
    }

    try {
      const now = new Date();
      const lookbackDays = interval === "1M" ? 4 : interval === "5M" ? 7 : interval === "15M" ? 14 : 180;
      const startDt = new Date(now.getTime() - lookbackDays * 86400 * 1000);
      const endDt = new Date(now.getTime() + 2 * 86400 * 1000);
      const encSym = encodeURIComponent(cnbcSym);
      const barUrl = `https://ts-api.cnbc.com/harmony/app/bars/${encSym}/${interval}/${formatCnbcTs(startDt)}/${formatCnbcTs(endDt)}/adjusted/EST5EDT.json`;

      const resp = await fetch(barUrl, { cache: "no-store" });
      if (!resp.ok) return;
      const json = await resp.json();
      const rawBars = json?.barData?.priceBars || [];
      const parsed = parseCnbcPriceBars(rawBars, interval);
      if (parsed.length > 5) {
        const sliced = parsed.slice(interval === "1D" ? -75 : -80);
        const recent20 = sliced.slice(-20);
        const sup20 = Math.min(...recent20.map((x) => x.low));
        const res20 = Math.max(...recent20.map((x) => x.high));
        drawCandlestickChart("modalChartCanvas", sliced, {
          support20: sup20,
          resistance20: res20,
          currency: cur,
        });

        // 소형 SOXX 종목 등 로컬 일봉 수익률이 비어있던 경우 모달 지표 자동 보강
        const supEl = document.getElementById("modalSupVal");
        const resEl = document.getElementById("modalResVal");
        if (supEl) supEl.textContent = fmtPrice(sup20, cur);
        if (resEl) resEl.textContent = fmtPrice(res20, cur);
      }
    } catch (e) {
      // 오프라인 시 기본 스냅샷 유지
    }
  }

  function openDetailModal(item, type) {
    const modal = document.getElementById("detailModal");
    if (!modal) return;

    const sym = item.ticker || item.key || "SOXX";
    const cur = item.currency || (item.unit === "%" ? "PCT" : item.unit === "원" ? "KRW" : "USD");
    const hasCardInGrid = (state.data?.holdings || []).some((h) => h.ticker === sym);

    document.getElementById("modalKicker").textContent =
      type === "MACRO" ? `${item.category || "매크로"} 상세 추이` : `${item.etf_group || ""} · ${item.subsector || ""}`;
    document.getElementById("modalTitle").textContent = `${item.name_kr} (${sym.replace(".KS", "")})`;

    const priceBanner = document.getElementById("modalPriceBanner");
    priceBanner.innerHTML = `
      <div style="display:flex; align-items:baseline; gap:10px;" class="num">
        <span class="etf-price" style="font-size:1.35rem;">${fmtPrice(item.price, item.currency, item.unit)}</span>
        <span class="etf-chg-pill ${dirClass(item.change_pct, true)}">${fmtSignedChange(item.change, item.change_pct)}</span>
      </div>
      <div class="modal-action-btns">
        <button type="button" class="modal-jump-btn primary" id="btnModalToMainChart">
          📈 상단 1분봉 메인차트로 이동
        </button>
        ${
          type === "STOCK"
            ? `<button type="button" class="modal-jump-btn" id="btnModalToStockCard">
                💎 ${hasCardInGrid ? "하단 종목 카드로 이동" : "핵심종목 섹션으로 이동"}
              </button>`
            : ""
        }
      </div>
    `;

    // 모달 차트 상단 주기 선택 바 삽입 (1분봉 / 5분봉 / 15분봉 / 일봉)
    let modalIvBar = document.getElementById("modalIvBar");
    const canvasWrap = modal.querySelector(".modal-canvas-wrap");
    if (!modalIvBar && canvasWrap) {
      modalIvBar = document.createElement("div");
      modalIvBar.id = "modalIvBar";
      modalIvBar.className = "modal-iv-bar";
      canvasWrap.parentNode.insertBefore(modalIvBar, canvasWrap);
    }
    const defaultModalIv = type === "STOCK" ? "1M" : "1D";
    if (modalIvBar) {
      modalIvBar.innerHTML = `
        <span class="num" style="font-size:0.74rem; font-weight:700; color:var(--ink-secondary);">실시간 차트 미리보기 (지지·저항선 포함)</span>
        <div class="interval-tabs">
          <button type="button" class="iv-btn ${defaultModalIv === "1M" ? "active" : ""}" data-miv="1M" style="font-size:0.72rem; padding:3px 8px;">1분봉</button>
          <button type="button" class="iv-btn" data-miv="5M" style="font-size:0.72rem; padding:3px 8px;">5분봉</button>
          <button type="button" class="iv-btn" data-miv="15M" style="font-size:0.72rem; padding:3px 8px;">15분봉</button>
          <button type="button" class="iv-btn ${defaultModalIv === "1D" ? "active" : ""}" data-miv="1D" style="font-size:0.72rem; padding:3px 8px;">일봉</button>
        </div>
      `;
      modalIvBar.querySelectorAll("[data-miv]").forEach((btn) => {
        btn.addEventListener("click", () => {
          modalIvBar.querySelectorAll("[data-miv]").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const iv = btn.getAttribute("data-miv") || "1M";
          loadModalLiveChart(item, iv);
        });
      });
    }

    const jumpBtn = document.getElementById("btnModalToMainChart");
    if (jumpBtn) {
      jumpBtn.addEventListener("click", () => {
        modal.setAttribute("hidden", "");
        const cnbcMap = { US10Y: "US10Y", US5Y: "US5Y", WTI: "@CL.1", BRENT: "@LCO.1", GOLD: "@GC.1", VIX: ".VIX", USDKRW: "KRW=" };
        const cnbcSym = cnbcMap[sym] || sym;
        selectTickerForLiveChart(sym, cnbcSym, item.name_kr, cur, true, true);
        const chartPanel = document.querySelector(".chart-panel");
        pulseElementHighlight(chartPanel);
      });
    }

    const cardJumpBtn = document.getElementById("btnModalToStockCard");
    if (cardJumpBtn) {
      cardJumpBtn.addEventListener("click", () => {
        modal.setAttribute("hidden", "");
        scrollToStockCard(sym, item.name_kr, cur);
      });
    }

    const metricsGrid = document.getElementById("modalMetricsGrid");
    if (type === "STOCK") {
      metricsGrid.innerHTML = `
        <div class="metric-cell num"><small>구간 지지선</small><strong id="modalSupVal">${fmtPrice(item.support_20d, item.currency)}</strong></div>
        <div class="metric-cell num"><small>구간 저항선</small><strong id="modalResVal">${fmtPrice(item.resistance_20d, item.currency)}</strong></div>
        <div class="metric-cell num"><small>RS 상대강도</small><strong>${item.rs_score ?? "-"} / 99</strong></div>
        <div class="metric-cell num"><small>1개월 수익률</small><strong class="${dirClass(item.returns?.["1m"])}">${fmtSignedPct(item.returns?.["1m"])}</strong></div>
        <div class="metric-cell num"><small>3개월 수익률</small><strong class="${dirClass(item.returns?.["3m"])}">${fmtSignedPct(item.returns?.["3m"])}</strong></div>
        <div class="metric-cell num"><small>1년 수익률</small><strong class="${dirClass(item.returns?.["1y"])}">${fmtSignedPct(item.returns?.["1y"])}</strong></div>
      `;
    } else {
      metricsGrid.innerHTML = `
        <div class="metric-cell num"><small>상태 판정</small><strong>${item.status_label || "-"}</strong></div>
        <div class="metric-cell num"><small>52주 최고</small><strong>${fmtPrice(item.high_52w, null, item.unit)}</strong></div>
        <div class="metric-cell num"><small>52주 최저</small><strong>${fmtPrice(item.low_52w, null, item.unit)}</strong></div>
      `;
    }

    document.getElementById("modalNote").textContent = item.role_note || item.impact_note || "";

    modal.removeAttribute("hidden");
    requestAnimationFrame(() => {
      if (Array.isArray(item.candles) && item.candles.length > 5) {
        drawCandlestickChart("modalChartCanvas", item.candles.slice(-75), {
          support20: item.support_20d,
          resistance20: item.resistance_20d,
          currency: item.currency,
        });
      }
      loadModalLiveChart(item, defaultModalIv);
    });
  }

  function bindModalEvents() {
    const modal = document.getElementById("detailModal");
    const closeBtn = document.getElementById("btnCloseModal");
    if (!modal) return;

    if (closeBtn) {
      closeBtn.addEventListener("click", () => modal.setAttribute("hidden", ""));
    }
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.setAttribute("hidden", "");
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hasAttribute("hidden")) {
        modal.setAttribute("hidden", "");
      }
    });
  }

  /* ========================================================================
     12. 백그라운드 실시간 시세 자동 갱신 (10초 틱 & 30초 전체 시세 + 한국 삼닉 실시간 연동)
     ======================================================================== */
  async function fetchKoreanLiveQuotes(d) {
    if (!d || !Array.isArray(d.holdings)) return 0;
    const krHoldings = d.holdings.filter((h) => String(h.ticker || "").endsWith(".KS"));
    if (krHoldings.length === 0) return 0;

    let krUpdated = 0;
    const codes = krHoldings.map((h) => h.ticker.replace(".KS", "")).join(",");

    // 1차: 네이버 금융 실시간 폴링 API (Jina CORS JSON 래퍼 경유)
    try {
      const naverUrl = `https://r.jina.ai/https://polling.finance.naver.com/api/realtime/domestic/stock/${codes}`;
      const resp = await fetch(naverUrl, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (resp.ok) {
        const wrapper = await resp.json();
        const innerStr = wrapper?.data?.content || "";
        if (innerStr) {
          const parsed = JSON.parse(innerStr);
          const datas = parsed?.datas || [];
          datas.forEach((item) => {
            const code = item.itemCode;
            const tk = `${code}.KS`;
            const target = d.holdings.find((x) => x.ticker === tk);
            if (!target) return;

            const closeVal = parseFloat(String(item.closePrice || "").replace(/,/g, ""));
            const rawChg = parseFloat(String(item.compareToPreviousClosePrice || "0").replace(/,/g, ""));
            const rawPct = parseFloat(String(item.fluctuationsRatio || "0").replace(/[%+,]/g, ""));
            const isFalling = String(item.compareToPreviousPrice?.code || "") === "5" || String(item.compareToPreviousPrice?.name || "") === "FALLING";

            if (!isNaN(closeVal) && closeVal > 0) {
              const signedChg = isFalling && rawChg > 0 ? -rawChg : rawChg;
              const signedPct = isFalling && rawPct > 0 ? -rawPct : rawPct;
              target.price = closeVal;
              target.change = signedChg;
              target.change_pct = signedPct;

              // NXT 애프터마켓/프리마켓 시세가 있으면 함께 반영
              const over = item.overMarketPriceInfo;
              if (over && over.overPrice) {
                const ovPrice = parseFloat(String(over.overPrice).replace(/,/g, ""));
                const ovPct = parseFloat(String(over.fluctuationsRatio || "0").replace(/[%+,]/g, ""));
                const ovFall = String(over.compareToPreviousPrice?.code || "") === "5" || String(over.compareToPreviousPrice?.name || "") === "FALLING";
                if (!isNaN(ovPrice) && ovPrice > 0) {
                  target.ext_price = ovPrice;
                  target.ext_change_pct = ovFall && ovPct > 0 ? -ovPct : ovPct;
                  target.ext_label = over.tradingSessionType === "PRE_MARKET" ? "프리" : "NXT시간외";
                }
              }

              // 일봉 캔들 마지막 날도 최신 가격으로 동기화
              if (Array.isArray(target.candles) && target.candles.length > 0) {
                const lastC = target.candles[target.candles.length - 1];
                lastC.close = closeVal;
                if (closeVal > lastC.high) lastC.high = closeVal;
                if (closeVal < lastC.low) lastC.low = closeVal;
              }
              krUpdated++;
            }
          });
        }
      }
    } catch (e) {
      // 1차 실패 시 2차 CNBC Harmony 일봉 API 폴백으로 진행
    }

    if (krUpdated > 0) return krUpdated;

    // 2차 폴백: CNBC Harmony 1D 바 API (CORS: * 기본 지원)
    try {
      const now = new Date();
      const startDt = new Date(now.getTime() - 14 * 86400 * 1000);
      const endDt = new Date(now.getTime() + 2 * 86400 * 1000);
      await Promise.all(
        krHoldings.map(async (h) => {
          const enc = encodeURIComponent(h.ticker);
          const barUrl = `https://ts-api.cnbc.com/harmony/app/bars/${enc}/1D/${formatCnbcTs(startDt)}/${formatCnbcTs(endDt)}/adjusted/EST5EDT.json`;
          const r = await fetch(barUrl, { cache: "no-store" });
          if (!r.ok) return;
          const bj = await r.json();
          const bars = bj?.barData?.priceBars || [];
          if (bars.length >= 2) {
            const lastB = bars[bars.length - 1];
            const prevB = bars[bars.length - 2];
            const c = parseFloat(lastB.close);
            const p = parseFloat(prevB.close);
            if (!isNaN(c) && c > 0 && !isNaN(p) && p > 0) {
              h.price = c;
              h.change = c - p;
              h.change_pct = Number((((c - p) / p) * 100).toFixed(2));
              krUpdated++;
            }
          }
        })
      );
    } catch (e) {
      // 무시
    }
    return krUpdated;
  }

  async function fetchLiveQuotesFromCNBC(isManual) {
    const d = state.data;
    if (!d) return;

    const icon = document.getElementById("refreshIcon");
    if (icon) icon.classList.add("spinning");

    try {
      const symbolMap = {
        SOXX: { type: "etf", key: "SOXX" },
        SOXL: { type: "etf", key: "SOXL" },
        RAM: { type: "etf", key: "RAM" },
        DRAM: { type: "etf", key: "DRAM" },
        US10Y: { type: "macro", key: "US10Y" },
        US5Y: { type: "macro", key: "US5Y" },
        TLT: { type: "macro", key: "TLT" },
        "@CL.1": { type: "macro", key: "WTI" },
        "@LCO.1": { type: "macro", key: "BRENT" },
        "@GC.1": { type: "macro", key: "GOLD" },
        ".VIX": { type: "macro", key: "VIX" },
        "KRW=": { type: "macro", key: "USDKRW" },
      };

      (d.holdings || []).forEach((h) => {
        symbolMap[h.ticker] = { type: "holding", key: h.ticker };
      });

      SOXX_TREEMAP_CONSTITUENTS.forEach((sc) => {
        if (!symbolMap[sc.symbol]) {
          symbolMap[sc.symbol] = { type: "soxx_only", key: sc.symbol };
        }
      });

      const allSyms = Object.keys(symbolMap).join("|");
      const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(allSyms)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;

      const [resp, krCount] = await Promise.all([
        fetch(url, { cache: "no-store" }).catch(() => null),
        fetchKoreanLiveQuotes(d),
      ]);

      let updatedCount = krCount || 0;
      if (resp && resp.ok) {
        const json = await resp.json();
        const quotes = json?.FormattedQuoteResult?.FormattedQuote || [];

        quotes.forEach((q) => {
          const sym = q.symbol;
          const target = symbolMap[sym];
          if (!target || !q.last) return;

          const qInfo = extractLiveQuoteInfo(q, sym);
          if (!qInfo) return;

          state.soxxLiveMap[sym] = {
            price: qInfo.price,
            change: qInfo.change,
            change_pct: qInfo.change_pct,
            ext_price: qInfo.extPrice,
            ext_change_pct: qInfo.extPct,
          };

          if (target.type === "etf" && d.etfs?.[target.key]) {
            d.etfs[target.key].price = qInfo.price;
            d.etfs[target.key].change = qInfo.change;
            d.etfs[target.key].change_pct = qInfo.change_pct;
            d.etfs[target.key].ext_price = qInfo.extPrice;
            d.etfs[target.key].ext_change_pct = qInfo.extPct;
            d.etfs[target.key].ext_label = qInfo.extLabel;
            updatedCount++;
          } else if (target.type === "macro") {
            const m = (d.macros || []).find((x) => x.key === target.key);
            if (m) {
              m.price = qInfo.price;
              m.change = qInfo.change;
              m.change_pct = qInfo.change_pct;
              updatedCount++;
            }
          } else if (target.type === "holding") {
            const h = (d.holdings || []).find((x) => x.ticker === target.key);
            if (h) {
              h.price = qInfo.price;
              h.change = qInfo.change;
              h.change_pct = qInfo.change_pct;
              h.ext_price = qInfo.extPrice;
              h.ext_change_pct = qInfo.extPct;
              h.ext_label = qInfo.extLabel;
              updatedCount++;
            }
          } else if (target.type === "soxx_only") {
            updatedCount++;
          }
        });
      }

      if (updatedCount > 0) {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const ss = String(now.getSeconds()).padStart(2, "0");
        d.updated_at_kst = `실시간 연동 (${hh}:${mm}:${ss})`;

        renderTopTickerStrip();
        renderBriefingSection();
        renderEtfTrio();
        renderSoxxTreemap();
        renderMacroGrid();
        renderHoldings();
      }
    } catch (err) {
      // 오프라인 시 기존 스냅샷 유지
    } finally {
      if (icon) {
        setTimeout(() => icon.classList.remove("spinning"), 350);
      }
    }
  }

  async function pollActiveChartLiveTick() {
    if (!state.liveTracking || !state.chartCnbcSymbol) return;
    try {
      const interval = state.chartInterval;
      const enc = encodeURIComponent(state.chartCnbcSymbol);
      const quoteUrl = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${enc}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;

      let barPromise = Promise.resolve(null);
      if (interval !== "1D") {
        const now = new Date();
        const lookbackDays = interval === "1M" ? 4 : interval === "5M" ? 7 : 14;
        const startDt = new Date(now.getTime() - lookbackDays * 86400 * 1000);
        const endDt = new Date(now.getTime() + 2 * 86400 * 1000);
        const barUrl = `https://ts-api.cnbc.com/harmony/app/bars/${enc}/${interval}/${formatCnbcTs(startDt)}/${formatCnbcTs(endDt)}/adjusted/EST5EDT.json`;
        barPromise = fetch(barUrl, { cache: "no-store" }).catch(() => null);
      }

      const [quoteResp, barResp] = await Promise.all([
        fetch(quoteUrl, { cache: "no-store" }).catch(() => null),
        barPromise,
      ]);

      let quoteInfo = null;
      if (quoteResp && quoteResp.ok) {
        const json = await quoteResp.json();
        const q = json?.FormattedQuoteResult?.FormattedQuote?.[0];
        quoteInfo = extractLiveQuoteInfo(q, state.chartName);
        if (quoteInfo) {
          state.liveQuote = quoteInfo;
          renderMainChartTitleHTML(state.chartName, state.chartSymbol, state.chartCurrency, interval, quoteInfo);
        }
      }

      if (barResp && barResp.ok) {
        const barJson = await barResp.json();
        const rawBars = barJson?.barData?.priceBars || [];
        const parsed = parseCnbcPriceBars(rawBars, interval);
        if (parsed.length > 5) {
          const maxBars = interval === "1D" ? 90 : 96;
          state.chartCandles = parsed.slice(-maxBars);
        }
      }

      if (state.chartCandles.length > 0) {
        if (quoteInfo) {
          applyLiveTickToLastCandle(state.chartCandles, interval, quoteInfo);
        }
        const recent20 = state.chartCandles.slice(-20);
        state.chartSupport20 = Math.min(...recent20.map((x) => x.low));
        state.chartResistance20 = Math.max(...recent20.map((x) => x.high));
        redrawMainChartFromState();
        if (state.chartHoverIdx === -1) {
          updateCrosshairHud(state.chartCandles.length - 1);
        }
      }
    } catch (e) {
      // 무시
    }
  }

  /* ========================================================================
     13. [스페셜 코너] 2026년 오라클(ORCL) & 코어위브(CoreWeave) 5년물 CDS 추이
     ======================================================================== */
  const CDS_2026_SERIES = [
    { date: "2026.01 초", orcl: 138, crwv: 365, note: "연초 AI 데이터센터 회사채 발행 본격화 (오라클 138bp · 코어위브 365bp)" },
    { date: "2026.02 중", orcl: 146, crwv: 410, note: "하이퍼스케일러 CapEx 가이던스 상향 및 GPU 담보 대출 확대" },
    { date: "2026.03 말", orcl: 162, crwv: 485, note: "1분기 AI 관련 부채 발행 급증, 채권시장 차입 비용 재평가 시작" },
    { date: "2026.04 말", orcl: 178, crwv: 540, note: "코어위브 3년 단기 GPU 계약 vs 장기 채권 만기 불일치(Duration Mismatch) 부각" },
    { date: "2026.05 말", orcl: 195, crwv: 625, note: "오라클 대규모 AI 클러스터 설비투자로 잉여현금흐름(FCF) 적자 폭 확대" },
    { date: "2026.06 말", orcl: 214, crwv: 720, note: "상반기 AI 인프라 누적 부채 발행 $280B 돌파, 크레딧 헤지 수요 증가" },
    { date: "2026.07 말", orcl: 232, crwv: 835, note: "코어위브 무담보 채권(2031·2032년 만기) 수익률 12% 돌파" },
    { date: "2026.08 말", orcl: 254, crwv: 945, note: "빅테크·AI 주간 CDS 거래대금 급증, 코어위브 부실 경계선(1,000bp) 근접" },
    { date: "2026.09 말", orcl: 276, crwv: 1085, note: "코어위브 5년물 CDS 1,000bp 돌파 · 오라클 S&P 신용등급 BBB- 하향 압박" },
    { date: "2026.10 고점", orcl: 318, crwv: 1190, note: "10월 중순 코어위브 CDS 1,190bp · 오라클 318bp 장중 고점 기록 (채권시장 경계 정점)" },
    { date: "2026.10 현재", orcl: 288, crwv: 1140, note: "현재 오라클 288bp(BBB- 방어 중) · 코어위브 1,140bp($100B 수주잔고 기반 차환 협상)" },
  ];

  state.cdsMode = "BOTH"; // 'BOTH' | 'CRWV' | 'ORCL'
  state.cdsHoverIdx = CDS_2026_SERIES.length - 1;
  state.cdsLiveQuotes = {
    ORCL: { price: null, change_pct: null },
    CRWV: { price: null, change_pct: null },
  };

  async function fetchCdsCompanyStockQuotes() {
    try {
      const url = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=ORCL%7CCRWV&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json";
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return;
      const json = await resp.json();
      const quotes = json?.FormattedQuoteResult?.FormattedQuote || [];
      quotes.forEach((q) => {
        if (!q || !q.symbol || !q.last) return;
        const p = parseFloat(String(q.last).replace(/,/g, ""));
        const pct = parseFloat(String(q.change_pct || "0").replace(/[%+,]/g, ""));
        if (!isNaN(p) && p > 0) {
          state.cdsLiveQuotes[q.symbol] = { price: p, change_pct: pct };
        }
      });
      renderCdsSpecialCorner();
    } catch (e) {
      // 오프라인 시 기본 표시
    }
  }

  function renderCdsSpecialCorner() {
    const heroGrid = document.getElementById("cdsHeroGrid");
    const insightGrid = document.getElementById("cdsInsightGrid");
    if (!heroGrid) return;

    const orclQ = state.cdsLiveQuotes.ORCL || {};
    const crwvQ = state.cdsLiveQuotes.CRWV || {};
    const orclStockStr = orclQ.price ? `$${orclQ.price.toFixed(2)} (${fmtSignedPct(orclQ.change_pct)})` : "실시간 차트 연동";
    const crwvStockStr = crwvQ.price ? `$${crwvQ.price.toFixed(2)} (${fmtSignedPct(crwvQ.change_pct)})` : "실시간 차트 연동";

    heroGrid.innerHTML = `
      <article class="cds-card">
        <div class="cds-card-head">
          <div class="cds-badge-group">
            <span class="etf-ticker-badge">ORCL</span>
            <span class="etf-lev-tag">S&amp;P 신용등급 BBB- (투자적격 최하단)</span>
          </div>
          <span class="macro-status caution">● 경계 · FCF 적자 감시</span>
        </div>
        <div>
          <h3 class="etf-name">오라클 (Oracle) 5년물 CDS 스프레드</h3>
          <p class="etf-role" style="margin-bottom:4px; white-space:normal;">OpenAI · 대형 AI 클러스터 확장을 위한 공격적 회사채 발행으로 연초(138bp) 대비 2배 이상 상승</p>
        </div>

        <div class="cds-main-row num">
          <div>
            <span class="cds-bps-val" style="color:#B5892E;">288</span><span class="cds-bps-unit">bps (2.88%)</span>
          </div>
          <span class="etf-chg-pill up-pill">▲ 연초 대비 +150bp (10월 고점 318bp)</span>
        </div>

        <div class="etf-metrics-grid num">
          <div class="metric-cell">
            <small>2026년 초 → 현재</small>
            <strong>138bp → 288bp</strong>
          </div>
          <div class="metric-cell">
            <small>신용등급 방어선</small>
            <strong>BBB- (정크 직전)</strong>
          </div>
          <div class="metric-cell">
            <small>ORCL 현재 주가</small>
            <strong class="${orclQ.change_pct ? dirClass(orclQ.change_pct, false) : ""}">${orclStockStr}</strong>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-top:4px;">
          <span style="font-size:0.74rem; color:var(--ink-muted);">핵심 관전: 350bp 이하 안착 및 투자적격(IG) 유지 여부</span>
          <button type="button" class="stock-live-jump-btn" data-cds-stock="ORCL" data-cds-name="오라클 (Oracle)">📈 ORCL 주가 라이브 차트</button>
        </div>
      </article>

      <article class="cds-card distress">
        <div class="cds-card-head">
          <div class="cds-badge-group">
            <span class="etf-ticker-badge" style="background:#3A1B1B; color:#FFD6D4; border-color:#C9352E;">CRWV</span>
            <span class="etf-lev-tag" style="background:rgba(201,53,46,0.12); color:var(--up-color);">부실 경계선(1,000bp) 돌파</span>
          </div>
          <span class="macro-status warn">● 위험 · 만기 불일치 감시</span>
        </div>
        <div>
          <h3 class="etf-name">코어위브 (CoreWeave) 5년물 CDS 스프레드</h3>
          <p class="etf-role" style="margin-bottom:4px; white-space:normal;">총 부채·리스 $51B vs 수주잔고 $100B+ · 단기(3년) GPU 계약과 장기 인프라 채권 간 만기 불일치 반영</p>
        </div>

        <div class="cds-main-row num">
          <div>
            <span class="cds-bps-val up-text">1,140</span><span class="cds-bps-unit">bps (11.40%)</span>
          </div>
          <span class="etf-chg-pill up-pill">▲ 연초 대비 +775bp (10월 고점 1,190bp)</span>
        </div>

        <div class="etf-metrics-grid num">
          <div class="metric-cell">
            <small>2031·2032 채권 금리</small>
            <strong class="up-text">15.8% (하일드)</strong>
          </div>
          <div class="metric-cell">
            <small>내재 5년 부도확률</small>
            <strong>약 54% ~ 58%</strong>
          </div>
          <div class="metric-cell">
            <small>CRWV 현재 주가</small>
            <strong class="${crwvQ.change_pct ? dirClass(crwvQ.change_pct, false) : ""}">${crwvStockStr}</strong>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-top:4px;">
          <span style="font-size:0.74rem; color:var(--ink-muted);">핵심 관전: $100B 빅테크 수주잔고 기반 차환(Refinancing) 성공 여부</span>
          <button type="button" class="stock-live-jump-btn" data-cds-stock="CRWV" data-cds-name="코어위브 (CoreWeave)">📈 CRWV 주가 라이브 차트</button>
        </div>
      </article>
    `;

    heroGrid.querySelectorAll("[data-cds-stock]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sym = btn.getAttribute("data-cds-stock");
        const nm = btn.getAttribute("data-cds-name");
        selectTickerForLiveChart(sym, sym, nm, "USD", true);
      });
    });

    if (insightGrid) {
      insightGrid.innerHTML = `
        <div class="cds-insight-box">
          <strong>1. 왜 반도체(SOXX·SOXL·RAM) 투자자가 CDS를 봐야 하나?</strong>
          2026년 AI 데이터센터 부채 발행이 <b>$466B(약 630조 원)</b>를 넘어서면서, 주식시장보다 채권·CDS 시장이 먼저 "빚내서 구매한 엔비디아 GPU와 HBM 메모리가 제때 현금을 회수하는가"를 심판하고 있기 때문입니다.
        </div>
        <div class="cds-insight-box">
          <strong>2. 코어위브 1,140bp의 본질: 당장의 파산보다 '만기 불일치'</strong>
          코어위브는 마이크로소프트 등 우량 고객사 수주잔고가 <b>$100B 이상</b>이지만, GPU 임대 계약은 평균 3년인 반면 데이터센터 채권 만기는 2030년 이후로 길어 <b>차환(Refinancing) 금리 부담(15~16%)</b>이 CDS 급등의 핵심 원인입니다.
        </div>
        <div class="cds-insight-box">
          <strong>3. SOXX · SOXL · RAM 실전 대응 기준선</strong>
          오라클 CDS가 <b>300bp 안팎에서 진정(BBB- 투자적격 유지)</b>되고 코어위브 CDS가 1,000bp 아래로 내려오면 AI 설비투자 우려가 해소되며 <b>SOXL(3X)·RAM(2X)의 강한 숏커버 랠리 촉매</b>가 됩니다. 반대로 오라클이 투기등급(BB+)으로 강등될 경우 레버리지 비중을 축소합니다.
        </div>
      `;
    }

    updateCdsHud(state.cdsHoverIdx);
    drawCdsTrajectoryChart();
  }

  function updateCdsHud(idx) {
    const hud = document.getElementById("cdsHudItems");
    if (!hud) return;
    const i = idx >= 0 && idx < CDS_2026_SERIES.length ? idx : CDS_2026_SERIES.length - 1;
    const pt = CDS_2026_SERIES[i];
    hud.innerHTML = `
      <span>시점: <b>${pt.date}</b></span>
      <span>오라클(ORCL) 5Y CDS: <b style="color:#B5892E;">${pt.orcl} bps</b></span>
      <span>코어위브(CRWV) 5Y CDS: <b class="up-text">${pt.crwv.toLocaleString()} bps</b></span>
      <span>해설: <b>${pt.note}</b></span>
    `;
  }

  function drawCdsTrajectoryChart() {
    const canvas = document.getElementById("cdsChartCanvas");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(260, rect.width);
    const height = Math.max(180, rect.height);

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const isDark = state.theme === "dark";
    const gridColor = isDark ? "rgba(255,255,255,0.07)" : "rgba(24,34,29,0.08)";
    const textColor = isDark ? "#9CA8A1" : "#626C77";
    const orclColor = isDark ? "#EAC574" : "#B5892E";
    const crwvColor = isDark ? "#F05650" : "#C9352E";

    const pad = { top: 22, right: 64, bottom: 28, left: 54 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);

    const n = CDS_2026_SERIES.length;
    const xFor = (i) => pad.left + (i / (n - 1)) * plotW;

    // 좌측 축: 오라클 (0 ~ 400 bps), 우측 축: 코어위브 (0 ~ 1,300 bps)
    const yOrcl = (v) => pad.top + plotH - ((v - 80) / (360 - 80)) * plotH;
    const yCrwv = (v) => pad.top + plotH - ((v - 200) / (1300 - 200)) * plotH;

    // 수평 그리드 및 축 라벨
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = "600 10px Pretendard, sans-serif";

    for (let g = 0; g <= 4; g++) {
      const yy = pad.top + (plotH * g) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(pad.left + plotW, yy);
      ctx.stroke();

      if (state.cdsMode !== "CRWV") {
        const oVal = Math.round(360 - ((360 - 80) * g) / 4);
        ctx.fillStyle = orclColor;
        ctx.textAlign = "right";
        ctx.fillText(`${oVal}bp`, pad.left - 6, yy + 3);
      }
      if (state.cdsMode !== "ORCL") {
        const cVal = Math.round(1300 - ((1300 - 200) * g) / 4);
        ctx.fillStyle = crwvColor;
        ctx.textAlign = "left";
        ctx.fillText(`${cVal}bp`, pad.left + plotW + 6, yy + 3);
      }
    }

    // 코어위브 1,000bp 부실 경계선 점선
    if (state.cdsMode !== "ORCL") {
      const y1000 = yCrwv(1000);
      ctx.save();
      ctx.strokeStyle = "rgba(201, 53, 46, 0.55)";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pad.left, y1000);
      ctx.lineTo(pad.left + plotW, y1000);
      ctx.stroke();
      ctx.fillStyle = crwvColor;
      ctx.textAlign = "left";
      ctx.font = "700 10px Pretendard, sans-serif";
      ctx.fillText("⚠ 코어위브 1,000bp 부실 경계선 (Distress Threshold)", pad.left + 8, y1000 - 5);
      ctx.restore();
    }

    // 오라클 곡선 그리기
    if (state.cdsMode !== "CRWV") {
      ctx.save();
      ctx.strokeStyle = orclColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      CDS_2026_SERIES.forEach((pt, i) => {
        const xx = xFor(i);
        const yy = yOrcl(pt.orcl);
        if (i === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      });
      ctx.stroke();

      CDS_2026_SERIES.forEach((pt, i) => {
        const xx = xFor(i);
        const yy = yOrcl(pt.orcl);
        ctx.fillStyle = orclColor;
        ctx.beginPath();
        ctx.arc(xx, yy, i === state.cdsHoverIdx ? 5.5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }

    // 코어위브 곡선 그리기
    if (state.cdsMode !== "ORCL") {
      ctx.save();
      ctx.strokeStyle = crwvColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      CDS_2026_SERIES.forEach((pt, i) => {
        const xx = xFor(i);
        const yy = yCrwv(pt.crwv);
        if (i === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      });
      ctx.stroke();

      CDS_2026_SERIES.forEach((pt, i) => {
        const xx = xFor(i);
        const yy = yCrwv(pt.crwv);
        ctx.fillStyle = crwvColor;
        ctx.beginPath();
        ctx.arc(xx, yy, i === state.cdsHoverIdx ? 5.5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }

    // 하단 X축 날짜 라벨
    ctx.fillStyle = textColor;
    ctx.font = "600 10px Pretendard, sans-serif";
    ctx.textAlign = "center";
    CDS_2026_SERIES.forEach((pt, i) => {
      if (i % 2 === 0 || i === n - 1) {
        ctx.fillText(pt.date.replace("2026.", ""), xFor(i), height - 8);
      }
    });

    // 선택된 시점 수직 십자선
    if (state.cdsHoverIdx >= 0 && state.cdsHoverIdx < n) {
      const hx = xFor(state.cdsHoverIdx);
      ctx.save();
      ctx.strokeStyle = isDark ? "rgba(234,197,116,0.5)" : "rgba(181,137,46,0.55)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, pad.top);
      ctx.lineTo(hx, pad.top + plotH);
      ctx.stroke();
      ctx.restore();
    }
  }

  function bindCdsInteractions() {
    const modeTabs = document.getElementById("cdsModeTabs");
    if (modeTabs) {
      modeTabs.querySelectorAll(".iv-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          modeTabs.querySelectorAll(".iv-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          state.cdsMode = btn.getAttribute("data-cdsmode") || "BOTH";
          drawCdsTrajectoryChart();
        });
      });
    }

    const canvas = document.getElementById("cdsChartCanvas");
    if (!canvas) return;

    function handleMove(clientX) {
      const rect = canvas.getBoundingClientRect();
      const padLeft = 54;
      const padRight = 64;
      const plotW = Math.max(10, rect.width - padLeft - padRight);
      const relX = Math.max(0, Math.min(plotW, clientX - rect.left - padLeft));
      const idx = Math.round((relX / plotW) * (CDS_2026_SERIES.length - 1));
      if (idx !== state.cdsHoverIdx) {
        state.cdsHoverIdx = idx;
        updateCdsHud(idx);
        drawCdsTrajectoryChart();
      }
    }

    canvas.addEventListener("mousemove", (e) => handleMove(e.clientX));
    canvas.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches && e.touches[0]) {
          handleMove(e.touches[0].clientX);
        }
      },
      { passive: true }
    );
    canvas.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches && e.touches[0]) {
          handleMove(e.touches[0].clientX);
        }
      },
      { passive: true }
    );
  }

  /* ========================================================================
     13-B. SOXX (SOXL) & RAM 실제 비중 비례 트리맵 히트맵 (Squarified Treemap)
     ======================================================================== */
  const SOXX_TREEMAP_CONSTITUENTS = [
    { symbol: "AMD", name: "AMD", weight: 9.32, defaultPrice: 566.07, defaultPct: -2.14, cur: "USD" },
    { symbol: "INTC", name: "인텔", weight: 8.34, defaultPrice: 92.42, defaultPct: -3.25, cur: "USD" },
    { symbol: "MU", name: "마이크론", weight: 7.92, defaultPrice: 947.14, defaultPct: -3.67, cur: "USD" },
    { symbol: "NVDA", name: "엔비디아", weight: 7.64, defaultPrice: 212.77, defaultPct: -1.21, cur: "USD" },
    { symbol: "AVGO", name: "브로드컴", weight: 7.42, defaultPrice: 341.30, defaultPct: -2.99, cur: "USD" },
    { symbol: "AMAT", name: "어플라이드", weight: 5.46, defaultPrice: 415.93, defaultPct: -0.02, cur: "USD" },
    { symbol: "MRVL", name: "마벨", weight: 5.04, defaultPrice: 218.12, defaultPct: -13.32, cur: "USD" },
    { symbol: "KLAC", name: "KLA", weight: 4.92, defaultPrice: 169.51, defaultPct: 6.76, cur: "USD" },
    { symbol: "TXN", name: "텍사스인스트", weight: 4.71, defaultPrice: 307.43, defaultPct: -0.77, cur: "USD" },
    { symbol: "ADI", name: "아날로그디바이스", weight: 4.67, defaultPrice: 424.80, defaultPct: -0.81, cur: "USD" },
    { symbol: "LRCX", name: "램리서치", weight: 4.54, defaultPrice: 256.40, defaultPct: 1.02, cur: "USD" },
    { symbol: "QCOM", name: "퀄컴", weight: 4.29, defaultPrice: 180.30, defaultPct: -1.46, cur: "USD" },
    { symbol: "TSM", name: "TSMC", weight: 4.12, defaultPrice: 433.18, defaultPct: -1.44, cur: "USD" },
    { symbol: "NXPI", name: "NXP", weight: 3.51, defaultPrice: 251.61, defaultPct: -0.03, cur: "USD" },
    { symbol: "MPWR", name: "모놀리식파워", weight: 3.16, defaultPrice: 1176.88, defaultPct: -2.84, cur: "USD" },
    { symbol: "TER", name: "테라다인", weight: 2.76, defaultPrice: 294.90, defaultPct: -5.86, cur: "USD" },
    { symbol: "MCHP", name: "마이크로칩", weight: 2.35, defaultPrice: 79.06, defaultPct: -0.72, cur: "USD" },
    { symbol: "ASML", name: "ASML", weight: 2.14, defaultPrice: 1664.67, defaultPct: 0.11, cur: "USD" },
    { symbol: "ON", name: "온세미", weight: 1.92, defaultPrice: 74.47, defaultPct: -1.53, cur: "USD" },
    { symbol: "ALAB", name: "아스테라랩스", weight: 1.54, defaultPrice: 286.14, defaultPct: -3.72, cur: "USD" },
    { symbol: "CRDO", name: "크레도", weight: 1.32, defaultPrice: 167.76, defaultPct: -3.41, cur: "USD" },
    { symbol: "ENTG", name: "인테그리스", weight: 1.18, defaultPrice: 162.55, defaultPct: 2.03, cur: "USD" },
    { symbol: "ONTO", name: "온토이노", weight: 1.02, defaultPrice: 221.70, defaultPct: -0.89, cur: "USD" },
    { symbol: "SWKS", name: "스카이웍스", weight: 0.70, defaultPrice: 85.82, defaultPct: -1.62, cur: "USD" },
  ];

  const RAM_TREEMAP_CONSTITUENTS = [
    { symbol: "MU", name: "마이크론 (현물+스왑)", weight: 27.87, defaultPrice: 947.14, defaultPct: -3.67, cur: "USD" },
    { symbol: "005930.KS", name: "삼성전자 (현물+스왑)", weight: 25.82, defaultPrice: 230500, defaultPct: -4.75, cur: "KRW" },
    { symbol: "000660.KS", name: "SK하이닉스 (현물+스왑)", weight: 21.82, defaultPrice: 1516000, defaultPct: 1.95, cur: "KRW" },
    { symbol: "SNDK", name: "샌디스크 (NAND/eSSD)", weight: 8.40, defaultPrice: 1370.92, defaultPct: -2.41, cur: "USD" },
    { symbol: "STX", name: "씨게이트 (HDD 스토리지)", weight: 6.20, defaultPrice: 690.60, defaultPct: -1.06, cur: "USD" },
    { symbol: "WDC", name: "웨스턴디지털", weight: 5.50, defaultPrice: 395.98, defaultPct: -0.11, cur: "USD" },
    { symbol: "042700.KS", name: "한미반도체 (HBM TC본더)", weight: 4.39, defaultPrice: 194600, defaultPct: -4.37, cur: "KRW" },
  ];

  state.treemapMode = "SOXX"; // 'SOXX' | 'RAM'
  state.soxxLiveMap = {};

  function computeSquarifiedTreemap(items, width, height) {
    const valid = items.filter((it) => it.weight > 0).sort((a, b) => b.weight - a.weight);
    const totalWeight = valid.reduce((acc, it) => acc + it.weight, 0);
    if (!totalWeight || width <= 0 || height <= 0) return [];

    const totalArea = width * height;
    const nodes = valid.map((it) => ({
      ...it,
      area: (it.weight / totalWeight) * totalArea,
    }));

    const rects = [];
    let rx = 0,
      ry = 0,
      rw = width,
      rh = height;

    function worstAspectRatio(row, sideLen) {
      if (!row.length || sideLen <= 0) return Infinity;
      let sum = 0,
        maxA = 0,
        minA = Infinity;
      for (let i = 0; i < row.length; i++) {
        const a = row[i].area;
        sum += a;
        if (a > maxA) maxA = a;
        if (a < minA) minA = a;
      }
      const s2 = sum * sum;
      const w2 = sideLen * sideLen;
      return Math.max((w2 * maxA) / s2, s2 / (w2 * minA));
    }

    function layoutRow(row) {
      const sumArea = row.reduce((acc, n) => acc + n.area, 0);
      const horizontal = rw >= rh; // 짧은 변(rh)을 따라 세로 열로 쌓기 vs 가로 행으로 쌓기
      if (horizontal) {
        const colW = sumArea / Math.max(1, rh);
        let curY = ry;
        row.forEach((n) => {
          const cellH = n.area / Math.max(1, colW);
          rects.push({ ...n, x: rx, y: curY, w: colW, h: cellH });
          curY += cellH;
        });
        rx += colW;
        rw -= colW;
      } else {
        const rowH = sumArea / Math.max(1, rw);
        let curX = rx;
        row.forEach((n) => {
          const cellW = n.area / Math.max(1, rowH);
          rects.push({ ...n, x: curX, y: ry, w: cellW, h: rowH });
          curX += cellW;
        });
        ry += rowH;
        rh -= rowH;
      }
    }

    let currentRow = [];
    for (let i = 0; i < nodes.length; i++) {
      const child = nodes[i];
      const shortSide = Math.max(1, Math.min(rw, rh));
      if (currentRow.length === 0) {
        currentRow.push(child);
      } else {
        const curWorst = worstAspectRatio(currentRow, shortSide);
        const nextWorst = worstAspectRatio([...currentRow, child], shortSide);
        if (nextWorst <= curWorst) {
          currentRow.push(child);
        } else {
          layoutRow(currentRow);
          currentRow = [child];
        }
      }
    }
    if (currentRow.length > 0) {
      layoutRow(currentRow);
    }

    return rects.map((r) => ({
      ...r,
      leftPct: (r.x / width) * 100,
      topPct: (r.y / height) * 100,
      widthPct: (r.w / width) * 100,
      heightPct: (r.h / height) * 100,
    }));
  }

  function getTreemapTileBgColor(pctVal) {
    const pct = Number(pctVal || 0);
    const isKr = state.colorMode === "kr";
    const absP = Math.min(6.0, Math.abs(pct));
    const intensity = absP / 6.0; // 0.0 ~ 1.0

    if (Math.abs(pct) < 0.05) {
      return "#3A4440";
    }

    const isPositive = pct > 0;
    // 한국형(kr): 상승=크림슨 레드, 하락=로열 블루 / 미국형(us): 상승=에메랄드 그린, 하락=크림슨 레드
    const useRed = (isKr && isPositive) || (!isKr && !isPositive);
    const useBlue = isKr && !isPositive;

    if (useRed) {
      const r = Math.round(135 + 78 * intensity);
      const g = Math.round(52 - 18 * intensity);
      const b = Math.round(48 - 16 * intensity);
      return `rgb(${r}, ${g}, ${b})`;
    }
    if (useBlue) {
      const r = Math.round(44 - 16 * intensity);
      const g = Math.round(88 + 18 * intensity);
      const b = Math.round(142 + 65 * intensity);
      return `rgb(${r}, ${g}, ${b})`;
    }
    // 에메랄드 그린 (미국형 상승)
    const r = Math.round(36 - 12 * intensity);
    const g = Math.round(115 + 58 * intensity);
    const b = Math.round(82 + 22 * intensity);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function renderSoxxTreemap() {
    const container = document.getElementById("soxxTreemapContainer");
    const summaryEl = document.getElementById("treemapSummaryBar");
    const titleEl = document.getElementById("treemapPanelTitle");
    if (!container) return;

    const d = state.data;
    const isRam = state.treemapMode === "RAM";
    const baseList = isRam ? RAM_TREEMAP_CONSTITUENTS : SOXX_TREEMAP_CONSTITUENTS;

    if (titleEl) {
      titleEl.textContent = isRam
        ? "📊 RAM · DRAM 메모리 포트폴리오 실제 비중 히트맵"
        : "📊 SOXX (SOXL) 24대 구성종목 실제 비중 히트맵";
    }

    const enriched = baseList.map((item) => {
      const holdMatch = (d?.holdings || []).find((h) => h.ticker === item.symbol);
      const liveMatch = state.soxxLiveMap[item.symbol];
      const price = liveMatch?.price ?? holdMatch?.price ?? item.defaultPrice;
      const pct = liveMatch?.change_pct ?? holdMatch?.change_pct ?? item.defaultPct;
      return {
        ...item,
        price,
        change_pct: Number(pct || 0),
      };
    });

    const upCount = enriched.filter((x) => x.change_pct > 0).length;
    const downCount = enriched.filter((x) => x.change_pct < 0).length;
    const best = [...enriched].sort((a, b) => b.change_pct - a.change_pct)[0];
    const worst = [...enriched].sort((a, b) => a.change_pct - b.change_pct)[0];
    const actMode = state.treemapClickAction || "MODAL";

    if (summaryEl) {
      summaryEl.innerHTML = `
        <span>전체 <b>${enriched.length}종목</b> · 상승 <b class="up-text">${upCount}</b> / 하락 <b class="down-text">${downCount}</b></span>
        <span>최강세: <b>${best.name}(${best.symbol.replace(".KS", "")})</b> <b class="${dirClass(best.change_pct, false)}">${fmtSignedPct(best.change_pct)}</b> · 최약세: <b>${worst.name}(${worst.symbol.replace(".KS", "")})</b> <b class="${dirClass(worst.change_pct, false)}">${fmtSignedPct(worst.change_pct)}</b></span>
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span style="font-weight:700; color:var(--ink-secondary);">👆 종목 터치 시:</span>
          <div class="interval-tabs" id="treemapClickActionTabs">
            <button type="button" class="iv-btn ${actMode === "MODAL" ? "active" : ""}" data-tm-act="MODAL" style="font-size:0.71rem; padding:3px 8px;">📋 상세창 띄우기</button>
            <button type="button" class="iv-btn ${actMode === "CHART" ? "active" : ""}" data-tm-act="CHART" style="font-size:0.71rem; padding:3px 8px;">📈 1분봉 차트 이동</button>
            <button type="button" class="iv-btn ${actMode === "CARD" ? "active" : ""}" data-tm-act="CARD" style="font-size:0.71rem; padding:3px 8px;">💎 종목카드 이동</button>
          </div>
        </div>
      `;

      summaryEl.querySelectorAll("[data-tm-act]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.treemapClickAction = btn.getAttribute("data-tm-act") || "MODAL";
          summaryEl.querySelectorAll("[data-tm-act]").forEach((b) => b.classList.toggle("active", b === btn));
        });
      });
    }

    const rect = container.getBoundingClientRect();
    const w = Math.max(300, rect.width || (window.innerWidth <= 768 ? 350 : 980));
    const h = Math.max(320, rect.height || (window.innerWidth <= 768 ? 510 : 460));

    const layout = computeSquarifiedTreemap(enriched, w, h);

    container.innerHTML = layout
      .map((cell) => {
        const wgt = cell.weight;
        let tier = "tm-tier-md";
        if (wgt >= 6.8) tier = "tm-tier-xl";
        else if (wgt >= 4.0) tier = "tm-tier-lg";
        else if (wgt >= 2.1) tier = "tm-tier-md";
        else if (wgt >= 1.1) tier = "tm-tier-sm";
        else tier = "tm-tier-xs";

        const bg = getTreemapTileBgColor(cell.change_pct);
        const dispSym = cell.symbol.replace(".KS", "");
        const priceStr = fmtPrice(cell.price, cell.cur);
        const pctStr = fmtSignedPct(cell.change_pct);
        const isActive = state.chartSymbol === cell.symbol;

        return `
          <div class="tm-cell-outer ${tier}" style="left:${cell.leftPct.toFixed(3)}%; top:${cell.topPct.toFixed(3)}%; width:${cell.widthPct.toFixed(3)}%; height:${cell.heightPct.toFixed(3)}%;">
            <button
              type="button"
              class="tm-cell num ${isActive ? "active-tile" : ""}"
              style="background:${bg};"
              data-tm-sym="${cell.symbol}"
              data-tm-name="${cell.name}"
              data-tm-cur="${cell.cur}"
              data-tm-weight="${wgt.toFixed(2)}"
              title="터치하여 ${cell.name} (${dispSym}) 상세 차트·지표 띄우기 또는 이동"
            >
              <span class="tm-ticker">${dispSym}</span>
              <span class="tm-name">${cell.name}</span>
              <span class="tm-pct">${pctStr}</span>
              <span class="tm-meta">비중 ${wgt.toFixed(1)}% · ${priceStr}</span>
            </button>
          </div>
        `;
      })
      .join("");

    container.querySelectorAll(".tm-cell").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sym = btn.getAttribute("data-tm-sym");
        const nm = btn.getAttribute("data-tm-name");
        const cur = btn.getAttribute("data-tm-cur") || "USD";
        const wgt = parseFloat(btn.getAttribute("data-tm-weight") || "0");
        container.querySelectorAll(".tm-cell").forEach((b) => b.classList.toggle("active-tile", b === btn));
        openStockPopupOrJump(sym, nm, cur, wgt);
      });
    });
  }

  function bindTreemapControls() {
    const tabs = document.getElementById("treemapModeTabs");
    if (!tabs) return;
    tabs.querySelectorAll("[data-tm-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        tabs.querySelectorAll("[data-tm-mode]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.treemapMode = btn.getAttribute("data-tm-mode") || "SOXX";
        renderSoxxTreemap();
      });
    });
  }

  /* ========================================================================
     14. 상단 6대 탭 & 모바일 하단 탭 독자 페이지 전환 (스크롤 없이 즉시 상단 노출)
     ======================================================================== */
  state.activeSectionTab = "sec-live";

  function switchActiveSectionTab(targetId, options = {}) {
    const sections = ["sec-live", "sec-brief", "sec-cds", "sec-macro", "sec-holdings", "sec-news"];
    const validId = sections.includes(targetId) ? targetId : "sec-live";
    const scrollTop = options.scrollTop !== false;
    const updateHash = options.updateHash !== false;

    state.activeSectionTab = validId;

    sections.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.toggle("active-tab-page", id === validId);
      }
    });

    document.querySelectorAll(".nav-pill").forEach((p) => {
      p.classList.toggle("active", p.getAttribute("data-nav") === validId);
    });
    document.querySelectorAll(".m-nav-item").forEach((m) => {
      m.classList.toggle("active", m.getAttribute("data-mnav") === validId);
    });

    if (updateHash && window.history && window.history.replaceState) {
      window.history.replaceState(null, "", `#${validId}`);
    }

    if (scrollTop) {
      window.scrollTo({ top: 0, behavior: "instant" });
    }

    // 숨겨져 있던 탭이 열릴 때 캔버스 차트·트리맵·스파크라인 크기를 즉시 재계산하여 렌더링
    requestAnimationFrame(() => {
      if (validId === "sec-live") {
        redrawMainChartFromState();
        renderSoxxTreemap();
      } else if (validId === "sec-cds") {
        drawCdsTrajectoryChart();
      } else if (validId === "sec-macro") {
        renderMacroGrid();
      } else if (validId === "sec-holdings") {
        renderHoldings();
      } else if (validId === "sec-brief") {
        renderBriefingSection();
        renderDramFlowPanel();
        renderAiMicroNewsFeed();
      } else if (validId === "sec-news") {
        renderNews();
      }
    });
  }

  function bindNavigationScrollSpy() {
    const sections = ["sec-live", "sec-brief", "sec-cds", "sec-macro", "sec-holdings", "sec-news"];

    // 상단 탭 및 모바일 하단 탭 클릭 시 해당 섹션만 단독 페이지로 최상단에 즉시 표시
    document.querySelectorAll("[data-nav], [data-mnav]").forEach((navEl) => {
      navEl.addEventListener("click", (e) => {
        e.preventDefault();
        const targetId = navEl.getAttribute("data-nav") || navEl.getAttribute("data-mnav") || "sec-live";
        switchActiveSectionTab(targetId, { scrollTop: true, updateHash: true });

        if (targetId === "sec-live" && state.chartInterval !== "1M") {
          setChartIntervalTabUI("1M");
          loadLiveChart(state.chartSymbol, state.chartCnbcSymbol, state.chartName, "1M", state.chartCurrency);
        }
      });
    });

    // 좌측 상단 브랜드 로고 클릭 시 1번 탭(실시간 차트)으로 이동
    const brandGroup = document.querySelector(".brand-group");
    if (brandGroup) {
      brandGroup.addEventListener("click", (e) => {
        e.preventDefault();
        switchActiveSectionTab("sec-live", { scrollTop: true, updateHash: true });
      });
    }

    // 1번 탭 내부 '시황 노트 ▾' 배너 버튼 클릭 시 2번 탭(저녁 시황 · AI 문답봇)으로 즉시 전환
    const moreBriefBtn = document.querySelector(".epb-more-btn");
    if (moreBriefBtn) {
      moreBriefBtn.addEventListener("click", (e) => {
        e.preventDefault();
        switchActiveSectionTab("sec-brief", { scrollTop: true, updateHash: true });
      });
    }

    // URL 해시(#sec-brief, #sec-cds 등)로 직접 접속하거나 뒤로가기 시 해당 탭 자동 활성화
    const initialHash = (window.location.hash || "").replace(/^#/, "");
    if (sections.includes(initialHash)) {
      switchActiveSectionTab(initialHash, { scrollTop: true, updateHash: false });
    } else {
      switchActiveSectionTab("sec-live", { scrollTop: false, updateHash: false });
    }

    window.addEventListener("hashchange", () => {
      const h = (window.location.hash || "").replace(/^#/, "");
      if (sections.includes(h) && h !== state.activeSectionTab) {
        switchActiveSectionTab(h, { scrollTop: true, updateHash: false });
      }
    });
  }

  /* ========================================================================
     14-B. 반도체 전문 실시간 미시황 서치 & AI 질의응답 봇 데스크 (#sec-brief)
     ======================================================================== */
  state.aiTopicFilter = "ALL";
  state.aiChatHistory = [];

  function getStoredAiConfig() {
    const rawKey = (localStorage.getItem("evening_soxx_ai_key") || "").trim();
    const selProvider = localStorage.getItem("evening_soxx_ai_provider") || "auto";
    const selModel = localStorage.getItem("evening_soxx_ai_model") || "gemini-2.5-flash";

    let provider = selProvider;
    if (provider === "auto") {
      if (rawKey.startsWith("AIza")) provider = "gemini";
      else if (rawKey.startsWith("gsk_")) provider = "groq";
      else if (rawKey.startsWith("sk-or-")) provider = "openrouter";
      else if (rawKey.startsWith("pplx-")) provider = "perplexity";
      else if (rawKey.startsWith("sk-")) provider = "openai";
      else provider = "gemini";
    }

    let model = selModel;
    if (provider === "gemini" && !model.startsWith("gemini")) {
      model = "gemini-2.5-flash";
    } else if (provider === "groq" && !model.includes("llama") && !model.includes("qwen") && !model.includes("mixtral")) {
      model = "llama-3.3-70b-versatile";
    } else if (provider === "openrouter" && !model.includes("/")) {
      model = "deepseek/deepseek-chat-v3-0324:free";
    } else if (provider === "openai" && !model.startsWith("gpt")) {
      model = "gpt-4o";
    } else if (provider === "perplexity" && !model.startsWith("sonar")) {
      model = "sonar-pro";
    }

    return { apiKey: rawKey, provider, rawProvider: selProvider, model };
  }

  function updateAiKeyBadgeUI() {
    const cfg = getStoredAiConfig();
    const badge = document.getElementById("aiKeyStatusBadge");
    if (!badge) return;

    if (cfg.apiKey && cfg.apiKey.length > 10) {
      const pName =
        cfg.provider === "gemini"
          ? "Google Gemini (무료/유료 키 활성)"
          : cfg.provider === "groq"
          ? "Groq 무료 초고속 AI 활성"
          : cfg.provider === "openrouter"
          ? "OpenRouter 무료 AI 활성"
          : cfg.provider === "perplexity"
          ? "Perplexity Sonar 실시간 검색"
          : "OpenAI 실시간 AI 활성";
      badge.textContent = `🟢 API 키 연결됨 (${pName})`;
      badge.classList.add("connected");
    } else {
      badge.textContent = "🟡 내장 인텔리전스 모드 (무료 API 키 연동 가능)";
      badge.classList.remove("connected");
    }
  }

  function renderAiMicroNewsFeed() {
    const listEl = document.getElementById("aiMicroNewsList");
    const statEl = document.getElementById("aiScannerStatusText");
    if (!listEl || !state.data || !Array.isArray(state.data.news)) return;

    const allNews = state.data.news;
    const topic = state.aiTopicFilter || "ALL";
    let items = allNews;

    if (topic !== "ALL") {
      const rawWords = topic
        .split(/\s+/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w && w !== "반도체");
      const enWords = mapKoreanQueryToEnglish(topic)
        .split(/\s+/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length >= 2 && w !== "semiconductor");
      const keywords = Array.from(new Set([...rawWords, ...enWords]));

      const matchedFromAll = allNews.filter((n) => {
        const hay = `${n.title || ""} ${n.summary || ""} ${n.matched_query || ""}`.toLowerCase();
        return keywords.length === 0 ? true : keywords.some((k) => hay.includes(k));
      });

      // 방금 실시간 서치한 결과가 있으면 최상단에 우선 배치
      if (state.lastSearchedQuery === topic && Array.isArray(state.lastSearchedItems) && state.lastSearchedItems.length > 0) {
        const seen = new Set();
        items = [];
        [...state.lastSearchedItems, ...matchedFromAll].forEach((it) => {
          if (!it || !it.title) return;
          const k = it.title.slice(0, 24);
          if (seen.has(k)) return;
          seen.add(k);
          items.push(it);
        });
      } else {
        items = matchedFromAll;
      }
    }

    const topItems = items.slice(0, 24);
    if (statEl && !statEl.textContent.includes("서치 중")) {
      statEl.textContent =
        topic === "ALL" ? `실시간 스트림 ${allNews.length}건 대기` : `'${topic}' 관련 ${items.length}건 필터됨`;
    }

    if (topItems.length === 0) {
      listEl.innerHTML = `<div style="padding:14px; text-align:center; color:var(--ink-muted); font-size:0.8rem;">'${topic}' 관련 실시간 속보를 수집 중이거나 일치하는 기사가 없습니다. 상단 <strong>[실시간 서치]</strong> 버튼을 누르시면 즉시 한·미 최신 기사를 긁어옵니다.</div>`;
      return;
    }

    listEl.innerHTML = topItems
      .map(
        (n, idx) => `
        <div class="ai-micro-item">
          <div class="ai-micro-meta">
            <span class="ai-micro-cat">${n.category || "실시간 속보"}</span>
            <span class="num">${n.source || "News"} · ${n.pub_date || n.date || ""}</span>
          </div>
          <div class="ai-micro-title-row">
            <div style="flex:1; min-width:0;">
              <a href="${n.link || "#"}" target="_blank" rel="noopener noreferrer" class="ai-micro-link">${
          n.title || ""
        }</a>
              ${
                n.summary
                  ? `<div style="font-size:0.71rem; color:var(--ink-muted); margin-top:3px; line-height:1.38; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${n.summary}</div>`
                  : ""
              }
            </div>
            <button type="button" class="ai-micro-ask-btn" data-micro-ask="${idx}" title="이 뉴스가 SOXX·RAM에 미치는 영향을 AI에게 즉시 질문합니다">💬 AI 질문</button>
          </div>
        </div>
      `
      )
      .join("");

    listEl.querySelectorAll("[data-micro-ask]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.getAttribute("data-micro-ask") || "0", 10);
        const target = topItems[i];
        if (target) {
          askAiAboutNewsItem(target);
        }
      });
    });
  }

  function askAiAboutNewsItem(newsItem) {
    if (!newsItem) return;
    if (state.activeSectionTab !== "sec-brief" && typeof switchActiveSectionTab === "function") {
      switchActiveSectionTab("sec-brief", { scrollTop: true, updateHash: true });
    }
    const desk = document.getElementById("aiAnalystDesk");
    if (desk) {
      desk.scrollIntoView({ behavior: "smooth", block: "start" });
      pulseElementHighlight(desk);
    }
    const q = `[뉴스 심층 분석] "${newsItem.title}" (${newsItem.source || "속보"}, ${
      newsItem.pub_date || newsItem.date || ""
    }) 소식과 관련하여, 최신 배경 뉴스를 실시간 서치하고 이 이슈가 SOXX·SOXL(3X)·RAM(2X) 및 관련 반도체 종목에 미칠 영향과 대응 전략을 알려줘.`;
    handleAiUserQuestion(q);
  }

  function formatSimpleMarkdown(text) {
    if (!text) return "";
    let safe = String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // 1) 마크다운 링크 [제목](URL) 변환 (제목 내부에 [[속보] ...] 등 대괄호가 중첩된 경우도 줄 단위로 안전하게 변환)
    safe = safe.replace(/\[([^\n]+?)\]\((https?:\/\/[^\s\)]+)\)/g, (match, label, url) => {
      const cleanLabel = label.replace(/^\[+/, "[").replace(/\]+$/, "]");
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--gold-main); font-weight:700; text-decoration:underline; overflow-wrap:anywhere; word-break:break-word;">${cleanLabel} ↗</a>`;
    });

    // 2) 만약 변환되지 않고 남은 긴 생(raw) URL이 있다면 칸 밖으로 삐져나가지 않도록 깔끔한 링크 버튼으로 축약
    safe = safe.replace(/(^|[\s(])(https?:\/\/[^\s)<"]+)/g, (match, prefix, url) => {
      return `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--gold-main); font-weight:700; text-decoration:underline;">[원문 링크 ↗]</a>`;
    });
    // 굵은 글씨 **텍스트**
    safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // 제목 ### 텍스트
    safe = safe.replace(/^###\s+(.+)$/gm, '<h4 style="margin:8px 0 4px; font-size:0.88rem; color:var(--gold-main);">■ $1</h4>');
    safe = safe.replace(/^##\s+(.+)$/gm, '<h4 style="margin:10px 0 4px; font-size:0.92rem; color:var(--gold-main);">■ $1</h4>');
    // 불릿 리스트
    safe = safe.replace(/^\s*[-•]\s+(.+)$/gm, "• $1");
    // 줄바꿈
    safe = safe.replace(/\n/g, "<br/>");
    return safe;
  }

  function appendAiChatMessage(role, htmlOrMarkdown, sources = [], isRawHtml = false) {
    const box = document.getElementById("aiChatMessages");
    if (!box) return null;

    const msgEl = document.createElement("div");
    msgEl.className = `ai-msg ${role}`;

    const roleLabel =
      role === "user"
        ? "👤 나의 질문"
        : "🤖 어쩐지저녁의 SOXX 반도체 애널리스트 (실시간 데이터 + 웹 서치 연동)";

    const bodyHtml = isRawHtml ? htmlOrMarkdown : formatSimpleMarkdown(htmlOrMarkdown);

    let sourcesHtml = "";
    if (Array.isArray(sources) && sources.length > 0) {
      const validSources = sources
        .filter((s) => s && s.link && s.link.startsWith("http"))
        .slice(0, 6);
      if (validSources.length > 0) {
        sourcesHtml = `
          <div class="ai-source-links">
            <span style="font-size:0.66rem; font-weight:800; color:var(--ink-muted); width:100%;">🔗 실시간 서치 참조 뉴스 · 사이트 원문:</span>
            ${validSources
              .map(
                (s) =>
                  `<a href="${s.link}" target="_blank" rel="noopener noreferrer" class="ai-source-chip" title="${(
                    s.title || ""
                  ).replace(/"/g, "&quot;")}">📰 ${(s.title || s.source || "관련 기사").slice(0, 38)} ↗</a>`
              )
              .join("")}
          </div>
        `;
      }
    }

    msgEl.innerHTML = `
      <span class="ai-msg-role">${roleLabel}</span>
      <div class="ai-msg-bubble">${bodyHtml}${sourcesHtml}</div>
    `;

    box.appendChild(msgEl);
    box.scrollTop = box.scrollHeight;
    return msgEl;
  }

  function buildLiveMarketContextForAi(extraSearchedNews = []) {
    const d = state.data || {};
    const etfs = d.etfs || {};
    const holdings = d.holdings || [];
    const macros = d.macros || [];
    const df = d.dram_etf_flow || {};

    const etfLines = ["SOXX", "SOXL", "RAM", "DRAM"]
      .map((k) => {
        const e = etfs[k];
        if (!e) return null;
        return `- ${k} (${e.name_kr}): 현재가 $${e.price} (${fmtSignedPct(e.change_pct)}), 20일 지지 $${e.support_20d || "-"} / 저항 $${e.resistance_20d || "-"}, RSI(14)=${e.rsi14 || "-"}, 50일선위=${e.above_sma50 ? "Y" : "N"}`;
      })
      .filter(Boolean)
      .join("\n");

    const holdingLines = holdings
      .map((h) => {
        const curUnit = h.currency === "KRW" ? "원" : "$";
        return `- ${h.name_kr}(${h.ticker.replace(".KS", "")}): ${h.price}${curUnit} (${fmtSignedPct(
          h.change_pct
        )}), RS=${h.rs_score || "-"}, RSI=${h.rsi14 || "-"}, 20일지지=${h.support_20d || "-"}, 20일저항=${
          h.resistance_20d || "-"
        }, MTT정배열=${h.mtt?.mtt_pass ? "통과" : "미통과"}, SOXX비중=${h.soxx_weight || 0}%, DRAM비중=${h.dram_weight || 0}%`;
      })
      .join("\n");

    const macroLines = macros
      .map((m) => `- ${m.name_kr}(${m.key}): ${m.price}${m.unit || ""} (${fmtSignedPct(m.change_pct)}) [${m.status_label || ""}]`)
      .join("\n");

    const cdsLast = CDS_2026_SERIES[CDS_2026_SERIES.length - 1] || { orcl: 288, crwv: 1140 };
    const orclQ = state.cdsLiveQuotes?.ORCL || {};
    const crwvQ = state.cdsLiveQuotes?.CRWV || {};

    const combinedNews = [...(extraSearchedNews || []), ...(d.news || [])];
    const seen = new Set();
    const topNews = [];
    combinedNews.forEach((n) => {
      if (!n || !n.title || topNews.length >= 22) return;
      const k = n.title.slice(0, 24);
      if (seen.has(k)) return;
      seen.add(k);
      const sumPart = n.summary ? ` — 요약: ${n.summary}` : "";
      topNews.push(`- [${n.category || "속보"} | ${n.source || ""} | ${n.pub_date || n.date || ""}] ${n.title}${sumPart} (${n.link || ""})`);
    });

    return `
[현재 시각 및 데스크 기준]: ${d.updated_at_kst || "실시간 연동"}

[1. 4대 핵심 반도체 ETF 실시간 시세]
${etfLines}

[2. Roundhill DRAM ETF(RAM 모펀드) 월가 자금 유입]
- 순자산(AUM): $${df.latest_aum ? (df.latest_aum / 1e6).toFixed(2) + "M" : "-"}, 1일 자금유입: $${df.inflow_1d_usd ? (df.inflow_1d_usd / 1e6).toFixed(2) + "M" : "0"}, 5일 유입: $${df.inflow_5d_usd ? (df.inflow_5d_usd / 1e6).toFixed(2) + "M" : "-"}

[3. 오라클(ORCL) & 코어위브(CRWV) 5년물 CDS 및 주가]
- 오라클(ORCL): 5Y CDS ${cdsLast.orcl}bps (BBB- 투자적격 방어선), 주가 ${orclQ.price ? "$" + orclQ.price : "-"} (${fmtSignedPct(orclQ.change_pct)})
- 코어위브(CRWV): 5Y CDS ${cdsLast.crwv}bps (1,000bp 부실경계선 상회), 주가 ${crwvQ.price ? "$" + crwvQ.price : "-"} (${fmtSignedPct(crwvQ.change_pct)})

[4. 전쟁 · 유가 · 채권 · 환율 8대 매크로 지표]
${macroLines}

[5. SOXX & RAM 핵심 보유 22종목 실시간 지표]
${holdingLines}

[6. 방금 수집·서치된 실시간 한·미 반도체 & 거시경제 뉴스 헤드라인]
${topNews.join("\n")}
`.trim();
  }

  async function callGeminiWithLiveSearch(apiKey, model, question, contextText) {
    const sysInstruction = `당신은 『어쩐지저녁의 SOXX』 데스크의 수석 반도체·거시경제 전문 애널리스트 AI입니다.
사용자의 질문에 대해:
1) 반드시 사용자가 물어본 핵심 질문에 첫 문단부터 정면으로 명쾌하게 답변하세요.
2) 제공된 [실시간 데스크 시세·지표·뉴스 컨텍스트]와 Google 실시간 웹 검색 결과를 결합하여 최신 팩트와 정확한 수치(현재가, 등락률, 20일 지지/저항선, RSI, RS 상대강도, 금리/유가/CDS)를 근거로 한국어로 설명하세요.
3) SOXX(1X), SOXL(3X), RAM(메모리 2X), DRAM(1X) 및 관련 개별 종목 투자 관점의 실전 시사점을 꼭 짚어주세요.
4) 가독성이 뛰어나도록 핵심 소제목(###)과 불릿(•), 굵은 글씨(**)를 활용해 일목요연하게 정리하세요.`;

    const promptText = `[사용자 질문]: ${question}\n\n[실시간 데스크 시세·지표·뉴스 컨텍스트]:\n${contextText}`;
    const useSearch = document.getElementById("chkAiLiveWebSearch")?.checked !== false;
    const candidateModels = [model || "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"].filter(
      (v, i, arr) => arr.indexOf(v) === i
    );

    let lastErr = "";
    for (const m of candidateModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        m
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;

      // 1차: Google Search Grounding 포함 시도
      if (useSearch) {
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: sysInstruction }] },
              contents: [{ role: "user", parts: [{ text: promptText }] }],
              tools: [{ google_search: {} }],
              generationConfig: { temperature: 0.35 },
            }),
          });
          if (resp.ok) {
            const json = await resp.json();
            const cand = json?.candidates?.[0];
            const text = (cand?.content?.parts || []).map((p) => p.text || "").join("\n").trim();
            const chunks = cand?.groundingMetadata?.groundingChunks || [];
            const webSources = [];
            chunks.forEach((c) => {
              if (c?.web?.uri) {
                webSources.push({ title: c.web.title || "Google 실시간 웹 검색 출처", link: c.web.uri, source: "Google Search" });
              }
            });
            if (text) return { text, sources: webSources };
          }
        } catch (e) {
          // 폴백 진행
        }
      }

      // 2차: 무료 티어 호환 기본 generateContent 호출 (실시간 수집된 뉴스 본문 요약이 이미 컨텍스트에 포함됨)
      try {
        const resp2 = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: sysInstruction }] },
            contents: [{ role: "user", parts: [{ text: promptText }] }],
            generationConfig: { temperature: 0.35 },
          }),
        });
        if (resp2.ok) {
          const json2 = await resp2.json();
          const text2 = (json2?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n").trim();
          if (text2) return { text: text2, sources: [] };
        } else {
          lastErr = `(${resp2.status}) ` + (await resp2.text().catch(() => "")).slice(0, 100);
        }
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }

    throw new Error(`Gemini API 호출 실패: ${lastErr}`);
  }

  async function callGroqOrOpenRouterFreeApi(apiKey, provider, model, question, contextText) {
    const sysPrompt = `당신은 『어쩐지저녁의 SOXX』 데스크의 수석 반도체·거시경제 전문 애널리스트 AI입니다.
사용자의 질문에 첫 문단부터 직접적으로 명확히 답하고, 제공된 [실시간 데스크 시세·지표·뉴스]의 최신 기사 요약과 수치(현재가, 등락률, 20일 지지/저항선, RSI, 금리, 유가, CDS)를 근거로 SOXX·SOXL·RAM 투자 전략을 한국어로 일목요연하게 브리핑하세요.`;
    const endpoint =
      provider === "groq"
        ? "https://api.groq.com/openai/v1/chat/completions"
        : "https://openrouter.ai/api/v1/chat/completions";
    const effModel =
      provider === "groq"
        ? model.includes("llama") || model.includes("qwen")
          ? model
          : "llama-3.3-70b-versatile"
        : model.includes("/")
        ? model
        : "deepseek/deepseek-chat-v3-0324:free";

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: effModel,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: `[사용자 질문]: ${question}\n\n[실시간 데스크 시세·지표·뉴스]:\n${contextText}` },
        ],
        temperature: 0.35,
      }),
    });
    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => "");
      throw new Error(`${provider.toUpperCase()} API 오류 (${resp.status}): ${errTxt.slice(0, 140)}`);
    }
    const json = await resp.json();
    const text = json?.choices?.[0]?.message?.content || "";
    return { text, sources: [] };
  }

  async function callOpenAiWithLiveSearch(apiKey, model, question, contextText) {
    const sysPrompt = `당신은 『어쩐지저녁의 SOXX』 데스크의 수석 반도체·거시경제 전문 애널리스트 AI입니다. 실시간 데스크 데이터(SOXX, SOXL, RAM, DRAM, 22대 반도체 종목, 국채금리, 유가, CDS)와 최신 웹/뉴스 검색 결과를 바탕으로 수치와 근거 중심의 명쾌한 한국어 분석을 제공하세요.`;
    const userPrompt = `[질문]: ${question}\n\n[실시간 데스크 시세·지표·뉴스]:\n${contextText}`;
    const useSearch = document.getElementById("chkAiLiveWebSearch")?.checked !== false;

    // 1차: OpenAI Responses API + web_search_preview
    if (useSearch) {
      try {
        const resp = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model || "gpt-4o",
            instructions: sysPrompt,
            input: userPrompt,
            tools: [{ type: "web_search_preview" }],
          }),
        });
        if (resp.ok) {
          const json = await resp.json();
          let outText = json.output_text || "";
          const webSources = [];
          (json.output || []).forEach((item) => {
            (item.content || []).forEach((c) => {
              if (!outText && c.text) outText += c.text + "\n";
              (c.annotations || []).forEach((ann) => {
                if (ann.url) {
                  webSources.push({ title: ann.title || "웹 검색 출처", link: ann.url, source: "Web Search" });
                }
              });
            });
          });
          if (outText.trim()) return { text: outText.trim(), sources: webSources };
        }
      } catch (e) {
        // Chat Completions로 폴백
      }
    }

    // 2차: OpenAI Chat Completions API
    const resp2 = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || "gpt-4o",
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.35,
      }),
    });
    if (!resp2.ok) {
      const errTxt = await resp2.text().catch(() => "");
      throw new Error(`OpenAI API 오류 (${resp2.status}): ${errTxt.slice(0, 140)}`);
    }
    const json2 = await resp2.json();
    const text2 = json2?.choices?.[0]?.message?.content || "";
    return { text: text2, sources: [] };
  }

  async function callPerplexityLiveSearch(apiKey, model, question, contextText) {
    const sysPrompt = `당신은 『어쩐지저녁의 SOXX』 데스크의 수석 반도체·거시경제 애널리스트입니다. 실시간 웹 검색과 제공된 데스크 데이터를 결합해 한국어로 정확하고 깊이 있게 답변하세요.`;
    const resp = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.startsWith("sonar") ? model : "sonar-pro",
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: `[질문]: ${question}\n\n[현재 데스크 실시간 시세·지표]:\n${contextText}` },
        ],
        temperature: 0.25,
      }),
    });
    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => "");
      throw new Error(`Perplexity API 오류 (${resp.status}): ${errTxt.slice(0, 140)}`);
    }
    const json = await resp.json();
    const text = json?.choices?.[0]?.message?.content || "";
    const citations = (json?.citations || []).map((u, i) => ({
      title: `Perplexity 실시간 웹 출처 #${i + 1}`,
      link: u,
      source: "Perplexity",
    }));
    return { text, sources: citations };
  }

  // API 키 미입력 상태에서도 질문 키워드 실시간 뉴스 본문 요약(summary) + 종목 수치를 결합해 질문에 직접 답하는 엔진
  function generateBuiltInAnalystAnswer(question, searchedNews) {
    const d = state.data || {};
    const etfs = d.etfs || {};
    const holdings = d.holdings || [];
    const macros = d.macros || [];
    const q = String(question || "");

    const soxx = etfs.SOXX || {};
    const soxl = etfs.SOXL || {};
    const ram = etfs.RAM || {};
    const dram = etfs.DRAM || {};
    const us10y = macros.find((m) => m.key === "US10Y") || {};
    const wti = macros.find((m) => m.key === "WTI") || {};
    const brent = macros.find((m) => m.key === "BRENT") || {};
    const vix = macros.find((m) => m.key === "VIX") || {};

    // 질문에 언급된 종목 자동 매칭
    const matchedStocks = holdings.filter((h) => {
      const cleanTk = h.ticker.replace(".KS", "").toLowerCase();
      const qLow = q.toLowerCase();
      return (
        qLow.includes(cleanTk) ||
        q.includes(h.name_kr) ||
        (h.name_en && qLow.includes(h.name_en.split(" ")[0].toLowerCase()))
      );
    });

    const worstMovers = [...holdings].sort((a, b) => (a.change_pct || 0) - (b.change_pct || 0)).slice(0, 4);
    const bestMovers = [...holdings].sort((a, b) => (b.change_pct || 0) - (a.change_pct || 0)).slice(0, 3);

    const newsPool = (searchedNews && searchedNews.length > 0 ? searchedNews : d.news || []).slice(0, 6);

    // 1) 질문에 대한 직접 요약 (방금 서치한 뉴스의 본문 요약 summary + 헤드라인 합성)
    const directSummaryLines = [];
    if (newsPool.length > 0) {
      newsPool.slice(0, 4).forEach((n, idx) => {
        const safeTitle = String(n.title || "")
          .replace(/\[/g, "〈")
          .replace(/\]/g, "〉");
        const desc = n.summary && n.summary.length > 12 ? `\n  └ 📝 *본문 핵심*: ${n.summary}` : "";
        directSummaryLines.push(
          `• **핵심 팩트 ${idx + 1} (${n.source || "속보"} · ${n.pub_date || n.date || ""})**: **[${safeTitle}](${
            n.link || "#"
          })**${desc}`
        );
      });
    } else {
      directSummaryLines.push("• 해당 키워드의 실시간 기사를 찾지 못해 현재 데스크 시세 기준으로 진단합니다.");
    }

    let specificStockSection = "";
    if (matchedStocks.length > 0) {
      specificStockSection =
        `### 📊 질문하신 종목 실시간 주가 · 지지선 · 기술적 타점\n` +
        matchedStocks
          .map((s) => {
            const rsiState =
              Number(s.rsi14) <= 35
                ? "🔥 과매도 구간 (기술적 반등 감시)"
                : Number(s.rsi14) >= 70
                ? "⚠️ 과열 구간 (차익실현 주의)"
                : "중립 구간";
            return `• **${s.name_kr} (${s.ticker.replace(".KS", "")})**: 현재가 **${fmtPrice(
              s.price,
              s.currency
            )} (${fmtSignedPct(s.change_pct)})** | 20일 지지선 **${fmtPrice(
              s.support_20d,
              s.currency
            )}** · 저항선 **${fmtPrice(s.resistance_20d, s.currency)}** | RSI(14) **${
              s.rsi14 ?? "-"
            } (${rsiState})** | RS 상대강도 **${s.rs_score ?? "-"}/99**\n  └ *핵심 역할*: ${s.role_note || ""}`;
          })
          .join("\n") +
        "\n\n";
    } else {
      specificStockSection =
        `### 📊 현재 반도체 섹터 주요 등락 특징주 & 지지선\n` +
        `• **당일 급락·조정 주도주**: ${worstMovers
          .map(
            (x) =>
              `**${x.name_kr}**(${fmtSignedPct(x.change_pct)}, RSI ${x.rsi14}, 20일지지 ${fmtPrice(
                x.support_20d,
                x.currency
              )})`
          )
          .join(" / ")}\n` +
        `• **당일 상대적 강세·방어주**: ${bestMovers
          .map((x) => `**${x.name_kr}**(${fmtSignedPct(x.change_pct)}, RS ${x.rs_score})`)
          .join(" / ")}\n\n`;
    }

    const answer = `### 🎯 질문("${q.slice(0, 42)}${q.length > 42 ? "..." : ""}") 실시간 서치 결과 요약
${directSummaryLines.join("\n")}

${specificStockSection}### ⚡ SOXX · SOXL · RAM & 매크로 연동 브리핑
• **4대 반도체 ETF**: **SOXX** $${soxx.price ?? "-"} (**${fmtSignedPct(
      soxx.change_pct
    )}**, 20일지지 $${soxx.support_20d ?? "-"}) · **SOXL(3X)** $${soxl.price ?? "-"} (**${fmtSignedPct(
      soxl.change_pct
    )}**) · **RAM(2X)** $${ram.price ?? "-"} (**${fmtSignedPct(
      ram.change_pct
    )}**) · **DRAM(1X)** $${dram.price ?? "-"} (**${fmtSignedPct(dram.change_pct)}**, 20일지지 $${dram.support_20d ?? "-"})
• **매크로 & CDS**: 미 10년물 금리 **${us10y.price ?? "-"}%** · WTI 유가 **$${
      wti.price ?? "-"
    }** (브렌트유 **$${brent.price ?? "-"}**) · VIX **${
      vix.price ?? "-"
    }pt** · 오라클 CDS **288bps** / 코어위브 CDS **1,140bps**
• 💡 **무료 AI 키 연동 안내 (결제카드 불필요)**: 이미 발급받아 두신 **무료 API 키(Google AI Studio의 \`AIza...\` 또는 Groq의 \`gsk_...\`)**를 상단 **[🔑 무료·유료 API 키 설정]**에 넣으시면, 정형화된 요약이 아니라 **AI가 질문 의도에 맞춰 실시간 검색 기사를 읽고 자유롭게 직접 대답**해 줍니다!`;

    return { text: answer, sources: newsPool };
  }

  async function handleAiUserQuestion(rawQuestion) {
    const q = String(rawQuestion || "").trim();
    if (!q) return;

    const inputEl = document.getElementById("aiChatInput");
    const submitBtn = document.getElementById("btnAiChatSubmit");
    if (inputEl && inputEl.value.trim() === q) {
      inputEl.value = "";
    }

    appendAiChatMessage("user", q);
    const loadingMsg = appendAiChatMessage(
      "assistant",
      "⏳ <strong>실시간 관련 뉴스·사이트 서치 및 SOXX·RAM 포트폴리오 지표 분석 중입니다...</strong> (한·미 실시간 속보 API 및 AI 엔진 타격 중)",
      [],
      true
    );

    if (submitBtn) submitBtn.disabled = true;

    try {
      // 1) 질문에서 핵심 키워드를 추출해 실시간 한·미 뉴스(Bing RSS + CNBC Queryly) 즉시 서치
      const useLiveSearch = document.getElementById("chkAiLiveWebSearch")?.checked !== false;
      let searchedNews = [];
      if (useLiveSearch) {
        const cleanQuery = q
          .replace(/\[[^\]]+\]/g, "")
          .replace(/(오늘|지금|방금|최신|뉴스|서치해줘|찾아줘|알려줘|어때|왜|이유|전망|분석|요약해줘)/g, " ")
          .trim()
          .slice(0, 38);
        const searchTarget = cleanQuery.length >= 2 ? cleanQuery : "SOXX 엔비디아 SK하이닉스 반도체";
        searchedNews = await searchLiveNewsByKeyword(searchTarget, "AI_DESK");
      }

      const cfg = getStoredAiConfig();
      const contextText = buildLiveMarketContextForAi(searchedNews);

      let result = null;
      if (cfg.apiKey && cfg.apiKey.length > 10) {
        if (cfg.provider === "gemini") {
          result = await callGeminiWithLiveSearch(cfg.apiKey, cfg.model, q, contextText);
        } else if (cfg.provider === "groq" || cfg.provider === "openrouter") {
          result = await callGroqOrOpenRouterFreeApi(cfg.apiKey, cfg.provider, cfg.model, q, contextText);
        } else if (cfg.provider === "perplexity") {
          result = await callPerplexityLiveSearch(cfg.apiKey, cfg.model, q, contextText);
        } else {
          result = await callOpenAiWithLiveSearch(cfg.apiKey, cfg.model, q, contextText);
        }
      } else {
        result = generateBuiltInAnalystAnswer(q, searchedNews);
      }

      const mergedSources = [...(result.sources || []), ...(searchedNews || []).slice(0, 5)];
      if (loadingMsg) loadingMsg.remove();
      appendAiChatMessage("assistant", result.text, mergedSources, false);
    } catch (err) {
      if (loadingMsg) loadingMsg.remove();
      const fallback = generateBuiltInAnalystAnswer(q, state.data?.news?.slice(0, 5) || []);
      appendAiChatMessage(
        "assistant",
        `⚠️ **API 키 호출 안내 (${err.message || "연결 확인 필요"})**\n키 설정을 확인해 주세요. 아래는 실시간 수집된 뉴스 및 데스크 지표 기반 즉석 분석입니다.\n\n${
          fallback.text
        }`,
        fallback.sources,
        false
      );
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function initAiAnalystDesk() {
    const cfg = getStoredAiConfig();
    const provSel = document.getElementById("aiProviderSelect");
    const modSel = document.getElementById("aiModelSelect");
    const keyInput = document.getElementById("aiApiKeyInput");
    const drawer = document.getElementById("aiKeyDrawer");
    const btnToggleDrawer = document.getElementById("btnToggleAiKeyDrawer");
    const feedbackEl = document.getElementById("aiKeyFeedbackMsg");

    if (provSel) provSel.value = cfg.rawProvider || "auto";
    if (modSel && cfg.model) modSel.value = cfg.model;
    if (keyInput && cfg.apiKey) keyInput.value = cfg.apiKey;
    updateAiKeyBadgeUI();
    renderAiMicroNewsFeed();

    // 초기 웰컴 메시지
    const chatBox = document.getElementById("aiChatMessages");
    if (chatBox && chatBox.children.length === 0) {
      appendAiChatMessage(
        "assistant",
        `반갑습니다! **『어쩐지저녁의 SOXX』 실시간 반도체·매크로 전문 AI 애널리스트**입니다.\n` +
          `• **결제카드 없는 무료 API 키 100% 지원**: 상단 **[🔑 무료·유료 API 키 설정]**을 눌러 이미 받아두신 **무료 API 키(Google Gemini \`AIza...\` 또는 Groq \`gsk_...\`)**를 붙여넣고 **[연동 저장]**을 눌러주세요!\n` +
          `• 실시간 뉴스와 시세는 브라우저가 먼저 **비용 0원**으로 긁어모아 AI에게 전달하므로, 무료 API 키만 넣으셔도 내가 물어본 질문에 맞춰 실시간 서치 기반의 정확한 대답을 즉시 받아보실 수 있습니다.`
      );
    }

    if (btnToggleDrawer && drawer) {
      btnToggleDrawer.addEventListener("click", () => {
        const isHidden = drawer.hasAttribute("hidden");
        if (isHidden) {
          drawer.removeAttribute("hidden");
          btnToggleDrawer.textContent = "🔑 무료·유료 API 키 설정 ▴";
          btnToggleDrawer.setAttribute("aria-expanded", "true");
        } else {
          drawer.setAttribute("hidden", "");
          btnToggleDrawer.textContent = "🔑 무료·유료 API 키 설정 ▾";
          btnToggleDrawer.setAttribute("aria-expanded", "false");
        }
      });
    }

    const btnMask = document.getElementById("btnToggleKeyMask");
    if (btnMask && keyInput) {
      btnMask.addEventListener("click", () => {
        keyInput.type = keyInput.type === "password" ? "text" : "password";
      });
    }

    if (keyInput && provSel && modSel) {
      keyInput.addEventListener("input", () => {
        const v = keyInput.value.trim();
        if (v.startsWith("AIza")) {
          if (provSel.value === "auto") modSel.value = "gemini-2.5-flash";
        } else if (v.startsWith("gsk_")) {
          if (provSel.value === "auto") modSel.value = "llama-3.3-70b-versatile";
        } else if (v.startsWith("sk-or-")) {
          if (provSel.value === "auto") modSel.value = "deepseek/deepseek-chat-v3-0324:free";
        } else if (v.startsWith("sk-")) {
          if (provSel.value === "auto") modSel.value = "gpt-4o";
        } else if (v.startsWith("pplx-")) {
          if (provSel.value === "auto") modSel.value = "sonar-pro";
        }
      });
    }

    const btnSaveKey = document.getElementById("btnSaveAiKey");
    if (btnSaveKey && keyInput && provSel && modSel) {
      btnSaveKey.addEventListener("click", () => {
        const k = keyInput.value.trim();
        localStorage.setItem("evening_soxx_ai_key", k);
        localStorage.setItem("evening_soxx_ai_provider", provSel.value);
        localStorage.setItem("evening_soxx_ai_model", modSel.value);
        updateAiKeyBadgeUI();
        if (feedbackEl) {
          feedbackEl.innerHTML = k
            ? `✅ <strong>API 키가 현재 브라우저에 안전하게 저장되었습니다!</strong> 이제 우측 채팅창에 질문하시면 AI가 실시간 서치 뉴스를 읽고 직접 답변합니다.`
            : `ℹ️ API 키가 비어 있어 기본 내장 요약 모드로 동작합니다.`;
        }
      });
    }

    const btnClearKey = document.getElementById("btnClearAiKey");
    if (btnClearKey && keyInput) {
      btnClearKey.addEventListener("click", () => {
        keyInput.value = "";
        localStorage.removeItem("evening_soxx_ai_key");
        updateAiKeyBadgeUI();
        if (feedbackEl) {
          feedbackEl.innerHTML = `🗑️ 저장된 API 키를 브라우저에서 완전히 삭제했습니다.`;
        }
      });
    }

    const btnTestKey = document.getElementById("btnTestAiKey");
    if (btnTestKey && keyInput && provSel && modSel) {
      btnTestKey.addEventListener("click", async () => {
        const k = keyInput.value.trim();
        if (!k) {
          if (feedbackEl) feedbackEl.innerHTML = `⚠️ 먼저 테스트할 무료 또는 유료 API 키(AIza... / gsk_... / sk-...)를 입력해 주세요.`;
          return;
        }
        localStorage.setItem("evening_soxx_ai_key", k);
        localStorage.setItem("evening_soxx_ai_provider", provSel.value);
        localStorage.setItem("evening_soxx_ai_model", modSel.value);
        updateAiKeyBadgeUI();

        if (feedbackEl) feedbackEl.innerHTML = `⏳ <strong>API 키 연결 및 응답 테스트 중...</strong>`;
        try {
          const t0 = Date.now();
          const curCfg = getStoredAiConfig();
          let res = null;
          if (curCfg.provider === "gemini") {
            res = await callGeminiWithLiveSearch(curCfg.apiKey, curCfg.model, "연결 테스트: 한 줄로 인사해줘.", "SOXX 실시간 데스크 연결 테스트");
          } else if (curCfg.provider === "groq" || curCfg.provider === "openrouter") {
            res = await callGroqOrOpenRouterFreeApi(curCfg.apiKey, curCfg.provider, curCfg.model, "연결 테스트: 한 줄로 인사해줘.", "SOXX 실시간 데스크 연결 테스트");
          } else if (curCfg.provider === "perplexity") {
            res = await callPerplexityLiveSearch(curCfg.apiKey, curCfg.model, "연결 테스트: 한 줄로 인사해줘.", "SOXX 실시간 데스크 연결 테스트");
          } else {
            res = await callOpenAiWithLiveSearch(curCfg.apiKey, curCfg.model, "연결 테스트: 한 줄로 인사해줘.", "SOXX 실시간 데스크 연결 테스트");
          }
          const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
          if (feedbackEl) {
            feedbackEl.innerHTML = `🟢 <strong>연결 성공! (${curCfg.provider.toUpperCase()} · ${curCfg.model} · 응답 ${elapsed}초)</strong>: "${(
              res?.text || ""
            ).slice(0, 80)}"`;
          }
        } catch (e) {
          if (feedbackEl) {
            feedbackEl.innerHTML = `❌ <strong>연결 실패:</strong> ${e.message || "API 키를 확인해 주세요."}`;
          }
        }
      });
    }

    // 미시황 뉴스 즉석 서치 바 및 토픽 칩
    const topicInput = document.getElementById("aiNewsTopicInput");
    const btnSearchNews = document.getElementById("btnAiSearchNewsNow");
    const btnCrawlAll = document.getElementById("btnAiCrawlAllNow");

    if (btnSearchNews && topicInput) {
      btnSearchNews.addEventListener("click", () => {
        const val = topicInput.value.trim();
        if (val) {
          state.aiTopicFilter = val;
          document.querySelectorAll("[data-ai-topic]").forEach((b) => b.classList.remove("active"));
          searchLiveNewsByKeyword(val, "AI_DESK");
        } else {
          state.aiTopicFilter = "ALL";
          document.querySelectorAll("[data-ai-topic]").forEach((b) => {
            b.classList.toggle("active", b.getAttribute("data-ai-topic") === "ALL");
          });
          renderAiMicroNewsFeed();
        }
      });
      topicInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          btnSearchNews.click();
        }
      });
      topicInput.addEventListener("search", () => {
        if (!topicInput.value.trim()) {
          state.aiTopicFilter = "ALL";
          document.querySelectorAll("[data-ai-topic]").forEach((b) => {
            b.classList.toggle("active", b.getAttribute("data-ai-topic") === "ALL");
          });
          renderAiMicroNewsFeed();
        }
      });
    }

    if (btnCrawlAll) {
      btnCrawlAll.addEventListener("click", () => {
        state.aiTopicFilter = "ALL";
        if (topicInput) topicInput.value = "";
        document.querySelectorAll("[data-ai-topic]").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-ai-topic") === "ALL");
        });
        refreshNewsAndIntelligence(true);
      });
    }

    document.querySelectorAll("[data-ai-topic]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const tp = chip.getAttribute("data-ai-topic") || "ALL";
        state.aiTopicFilter = tp;
        document.querySelectorAll("[data-ai-topic]").forEach((b) => b.classList.toggle("active", b === chip));
        if (tp === "ALL") {
          renderAiMicroNewsFeed();
        } else {
          searchLiveNewsByKeyword(tp, "AI_DESK");
        }
      });
    });

    // 빠른 질문 프롬프트 버튼
    document.querySelectorAll("[data-prompt]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = btn.getAttribute("data-prompt");
        if (p) handleAiUserQuestion(p);
      });
    });

    // 대화 초기화
    const btnClearChat = document.getElementById("btnAiClearChat");
    if (btnClearChat && chatBox) {
      btnClearChat.addEventListener("click", () => {
        chatBox.innerHTML = "";
        appendAiChatMessage(
          "assistant",
          "대화 내역이 초기화되었습니다. 궁금하신 반도체 종목이나 실시간 미시황 이슈를 질문해 주세요."
        );
      });
    }

    // 채팅 폼 전송
    const chatForm = document.getElementById("aiChatForm");
    const chatInput = document.getElementById("aiChatInput");
    if (chatForm && chatInput) {
      chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const q = chatInput.value.trim();
        if (q) {
          chatInput.value = "";
          handleAiUserQuestion(q);
        }
      });
    }
  }

  /* ========================================================================
     15. 초기 구동
     ======================================================================== */
  function init() {
    applyPreferences();
    bindPreferenceControls();
    bindMainChartInteractions();
    bindLiveSearchBox();
    bindTreemapControls();
    bindCdsInteractions();
    bindHoldingsControls();
    bindNewsControls();
    bindModalEvents();

    if (state.data) {
      renderTopTickerStrip();
      renderBriefingSection();
      renderEtfTrio();
      renderSoxxTreemap();
      renderDramFlowPanel();
      renderCdsSpecialCorner();
      renderMacroGrid();
      renderHoldings();
      renderNews();
      loadLiveChart("SOXX", "SOXX", "iShares 미국 반도체 ETF", "1M", "USD");
    }

    initAiAnalystDesk();
    bindNavigationScrollSpy();

    fetchLiveQuotesFromCNBC(false);
    fetchCdsCompanyStockQuotes();
    fetchLiveDramEtfFlow();
    scheduleNewsAutoRefresh();
    setTimeout(() => refreshNewsAndIntelligence(false), 2000);
    setInterval(() => fetchLiveQuotesFromCNBC(false), 30000);
    setInterval(() => fetchCdsCompanyStockQuotes(), 45000);
    setInterval(() => pollActiveChartLiveTick(), 10000);

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        redrawMainChartFromState();
        renderSoxxTreemap();
        drawCdsTrajectoryChart();
        renderMacroGrid();
      }, 150);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
