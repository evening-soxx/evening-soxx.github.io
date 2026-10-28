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
      latest_aum: df.current_aum,
      inflow_5d_usd: df.inflow_5d_usd,
      inflow_20d_usd: df.inflow_20d_usd,
      top_holdings: (df.holdings || [])
        .filter((h) => !h.is_money_market && Number(h.weight) > 0)
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
    theme: localStorage.getItem("evening_soxx_theme") || "dark",
    colorMode: localStorage.getItem("evening_soxx_color") || "kr",
    fontScale: parseFloat(localStorage.getItem("evening_soxx_font") || "1"),

    chartSymbol: "SOXX",
    chartCnbcSymbol: "SOXX",
    chartName: "iShares 미국 반도체 ETF",
    chartCurrency: "USD",
    chartInterval: "1D", // '1M' | '5M' | '15M' | '1D'
    chartCandles: [],
    chartSupport20: null,
    chartResistance20: null,
    chartHoverIdx: -1,
    liveTracking: true,
    liveQuote: null,
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
    { symbol: "ARM", cnbc: "ARM", name: "ARM 홀딩스", exch: "NASDAQ", cur: "USD" },
    { symbol: "WDC", cnbc: "WDC", name: "웨스턴디지털 (Western Digital)", exch: "NASDAQ", cur: "USD" },
    { symbol: "STX", cnbc: "STX", name: "씨게이트 (Seagate)", exch: "NASDAQ", cur: "USD" },
    { symbol: "TSLA", cnbc: "TSLA", name: "테슬라 (Tesla)", exch: "NASDAQ", cur: "USD" },
    { symbol: "AAPL", cnbc: "AAPL", name: "애플 (Apple)", exch: "NASDAQ", cur: "USD" },
    { symbol: "MSFT", cnbc: "MSFT", name: "마이크로소프트 (Microsoft)", exch: "NASDAQ", cur: "USD" },
    { symbol: "GOOGL", cnbc: "GOOGL", name: "구글 알파벳 (Alphabet)", exch: "NASDAQ", cur: "USD" },
    { symbol: "META", cnbc: "META", name: "메타 (Meta Platforms)", exch: "NASDAQ", cur: "USD" },
    { symbol: "AMZN", cnbc: "AMZN", name: "아마존 (Amazon)", exch: "NASDAQ", cur: "USD" },
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
        localStorage.setItem("evening_soxx_theme", state.theme);
        applyPreferences();
        redrawMainChartFromState();
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
    ["SOXX", "RAM", "DRAM"].forEach((k) => {
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

    ["005930.KS", "000660.KS", "MU", "NVDA"].forEach((tk) => {
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
        selectTickerForLiveChart(sym, cnbc, name, cur, false);
        const chartPanel = document.querySelector(".chart-panel");
        if (chartPanel) chartPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  function renderBriefingSection() {
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
      const ram = d.etfs?.RAM || {};
      const us10y = (d.macros || []).find((m) => m.key === "US10Y") || {};
      const wti = (d.macros || []).find((m) => m.key === "WTI") || {};

      const cards = [
        { label: "SOXX (1X 본진)", val: fmtPrice(soxx.price, "USD"), pct: soxx.change_pct },
        { label: "RAM (DRAM 2X)", val: fmtPrice(ram.price, "USD"), pct: ram.change_pct },
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

    const order = ["SOXX", "RAM", "DRAM"];
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

  function renderDramFlowPanel() {
    const d = state.data;
    const box = document.getElementById("dramFlowContent");
    if (!box || !d) return;

    const flow = d.dram_etf_flow || {};
    const holdings = flow.top_holdings || [];
    const aumB = flow.latest_aum ? (flow.latest_aum / 1e9).toFixed(2) : "-";
    const f5 = flow.inflow_5d_usd ? (flow.inflow_5d_usd / 1e6).toFixed(1) : "0.0";
    const f20 = flow.inflow_20d_usd ? (flow.inflow_20d_usd / 1e6).toFixed(1) : "0.0";

    box.innerHTML = `
      <div class="etf-metrics-grid num" style="margin-top:0;">
        <div class="metric-cell">
          <small>DRAM ETF 순자산</small>
          <strong>$${aumB}B</strong>
        </div>
        <div class="metric-cell">
          <small>최근 5거래일 자금</small>
          <strong class="${dirClass(Number(f5))}">${Number(f5) >= 0 ? "+" : ""}$${f5}M</strong>
        </div>
        <div class="metric-cell">
          <small>최근 20거래일 자금</small>
          <strong class="${dirClass(Number(f20))}">${Number(f20) >= 0 ? "+" : ""}$${f20}M</strong>
        </div>
      </div>

      <p style="font-size:0.75rem; color:var(--ink-secondary); margin-top:10px; line-height:1.48;">
        💡 <strong>RAM(2배 레버리지)</strong>은 <strong>Roundhill DRAM ETF</strong>를 기초자산으로 삼으며, 삼성전자·SK하이닉스·마이크론 비중이 절대적입니다.
      </p>

      <div class="dram-holdings-list num">
        ${holdings
          .slice(0, 6)
          .map((h) => {
            const w = Math.min(100, Math.max(2, Number(h.weight_pct || 0)));
            return `
              <div class="dram-hold-row">
                <div class="dram-hold-top">
                  <span><strong>${h.name}</strong> <small style="color:var(--ink-muted);">(${h.ticker || ""})</small></span>
                  <strong>${w.toFixed(2)}%</strong>
                </div>
                <div class="dram-bar-track">
                  <div class="dram-bar-fill" style="width:${Math.min(100, w * 3.8)}%;"></div>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  /* ========================================================================
     5. 실시간 전 종목 검색 & 분봉/일봉 라이브 차트 + 터치 십자선
     ======================================================================== */
  function selectTickerForLiveChart(symbol, cnbcSym, displayName, currency, shouldScroll) {
    state.chartSymbol = symbol;
    state.chartCnbcSymbol = cnbcSym || symbol;
    state.chartName = displayName || symbol;
    state.chartCurrency = currency || (symbol.endsWith(".KS") ? "KRW" : "USD");
    state.chartHoverIdx = -1;

    if (["SOXX", "RAM", "DRAM"].includes(symbol)) {
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
      const chartEl = document.querySelector(".chart-panel");
      if (chartEl) chartEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function formatCnbcTs(dtObj) {
    const y = dtObj.getFullYear();
    const m = String(dtObj.getMonth() + 1).padStart(2, "0");
    const d = String(dtObj.getDate()).padStart(2, "0");
    return `${y}${m}${d}000000`;
  }

  async function loadLiveChart(symbol, cnbcSym, displayName, interval, currency) {
    const titleEl = document.getElementById("mainChartTitle");
    const ivLabel = interval === "1M" ? "실시간 1분봉" : interval === "5M" ? "실시간 5분봉" : interval === "15M" ? "실시간 15분봉" : "일봉(90일)";
    if (titleEl) {
      titleEl.innerHTML = `${displayName} <span style="color:var(--gold-main); font-size:0.86rem;">(${symbol})</span> · <span style="font-size:0.84rem; color:var(--ink-muted);">${ivLabel}</span>`;
    }

    let localRef = null;
    if (state.data) {
      if (state.data.etfs && state.data.etfs[symbol]) localRef = state.data.etfs[symbol];
      else if (state.data.holdings) localRef = state.data.holdings.find((h) => h.ticker === symbol);
      else if (state.data.macros) localRef = state.data.macros.find((m) => m.key === symbol);
    }

    // 1D 일봉이고 로컬 스냅샷이 있으면 즉시 1차 표시 후 실시간 갱신
    if (interval === "1D" && localRef && Array.isArray(localRef.candles) && localRef.candles.length > 10) {
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

      if (quoteResp && quoteResp.ok) {
        const qJson = await quoteResp.json();
        const qItem = qJson?.FormattedQuoteResult?.FormattedQuote?.[0];
        if (qItem && qItem.last) {
          const lastVal = parseFloat(String(qItem.last).replace(/,/g, ""));
          const chgVal = parseFloat(String(qItem.change || "0").replace(/,/g, ""));
          const pctVal = parseFloat(String(qItem.change_pct || "0").replace(/[%+,]/g, ""));
          if (!isNaN(lastVal)) {
            state.liveQuote = { price: lastVal, change: chgVal, change_pct: pctVal, name: qItem.shortName || displayName };
            if (titleEl) {
              const pStr = fmtPrice(lastVal, currency);
              const pctStr = fmtSignedPct(pctVal);
              const cls = dirClass(pctVal, false);
              titleEl.innerHTML = `${displayName} <span style="color:var(--gold-main); font-size:0.84rem;">(${symbol})</span> · <span class="num ${cls}">${pStr} (${pctStr})</span> · <span style="font-size:0.8rem; color:var(--ink-muted);">${ivLabel}</span>`;
            }
          }
        }
      }

      if (barResp.ok) {
        const barJson = await barResp.json();
        const rawBars = barJson?.barData?.priceBars || [];
        const parsed = [];
        for (let i = 0; i < rawBars.length; i++) {
          const b = rawBars[i];
          const o = parseFloat(b.open);
          const h = parseFloat(b.high);
          const l = parseFloat(b.low);
          const c = parseFloat(b.close);
          if (isNaN(c) || c <= 0) continue;
          const ts = String(b.tradeTime || "");
          let label = ts;
          if (ts.length >= 12) {
            const mm = ts.slice(4, 6);
            const dd = ts.slice(6, 8);
            const hh = ts.slice(8, 10);
            const mi = ts.slice(10, 12);
            label = interval === "1D" ? `${mm}.${dd}` : `${mm}.${dd} ${hh}:${mi}`;
          }
          parsed.push({
            date: label,
            open: isNaN(o) ? c : o,
            high: isNaN(h) ? c : h,
            low: isNaN(l) ? c : l,
            close: c,
            volume: parseInt(b.volume || "0", 10) || 0,
          });
        }

        if (parsed.length > 5) {
          const maxBars = interval === "1D" ? 90 : 96;
          state.chartCandles = parsed.slice(-maxBars);
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
            <div>
              <div class="stock-title-group">
                <h3 class="stock-name">${h.name_kr}</h3>
                <span class="stock-ticker num">${h.ticker}</span>
                <span class="stock-group-badge">${h.etf_group || ""}</span>
                ${h.mtt?.mtt_pass ? '<span class="mtt-badge">★ MTT 정배열</span>' : ""}
              </div>
              <div class="stock-subsector">
                <span>${h.subsector || ""} ${h.foreign_ratio ? `· 외국인 ${h.foreign_ratio}%` : ""}</span>
                <button type="button" class="stock-live-jump-btn" data-jump-ticker="${h.ticker}" data-jump-name="${h.name_kr}" data-jump-cur="${h.currency || "USD"}">📈 실시간 차트</button>
              </div>
            </div>

            <div class="stock-price-box num">
              <span class="stock-price">${fmtPrice(h.price, h.currency)}</span>
              <span class="stock-chg ${dirClass(h.change_pct, false)}">${fmtSignedChange(h.change, h.change_pct)}</span>
            </div>
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
              <span>현재 위치 ${pos52.toFixed(0)}% (고가 대비 ${fmtSignedPct(h.pct_from_high)})</span>
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
     10. 글로벌 소식 & 지정학 뉴스룸
     ======================================================================== */
  function renderNews() {
    const d = state.data;
    const grid = document.getElementById("newsGrid");
    if (!grid || !d || !Array.isArray(d.news)) return;

    const filtered = d.news.filter((n) => {
      if (state.newsFilter === "ALL") return true;
      return n.category === state.newsFilter;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="panel-card" style="grid-column:1/-1; text-align:center; color:var(--ink-muted);">해당 카테고리의 최신 소식이 없습니다.</div>`;
      return;
    }

    grid.innerHTML = filtered
      .map(
        (n) => `
        <a href="${n.link || "#"}" target="_blank" rel="noopener noreferrer" class="news-card">
          <div class="news-meta">
            <span class="news-cat-tag">${n.category || "소식"}</span>
            <span class="news-source num">${n.source || "Global News"} · ${n.pub_date || ""}</span>
          </div>
          <h3 class="news-title">${n.title || ""}</h3>
        </a>
      `
      )
      .join("");
  }

  function bindNewsControls() {
    document.querySelectorAll("[data-news-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.newsFilter = btn.getAttribute("data-news-filter") || "ALL";
        document.querySelectorAll("[data-news-filter]").forEach((b) => b.classList.toggle("active", b === btn));
        renderNews();
      });
    });
  }

  /* ========================================================================
     11. 바텀시트 상세 모달 (모바일 최적화)
     ======================================================================== */
  function openDetailModal(item, type) {
    const modal = document.getElementById("detailModal");
    if (!modal) return;

    document.getElementById("modalKicker").textContent =
      type === "MACRO" ? `${item.category || "매크로"} 상세 추이` : `${item.etf_group || ""} · ${item.subsector || ""}`;
    document.getElementById("modalTitle").textContent = `${item.name_kr} (${item.ticker || item.key || ""})`;

    const priceBanner = document.getElementById("modalPriceBanner");
    priceBanner.innerHTML = `
      <div style="display:flex; align-items:baseline; gap:10px;" class="num">
        <span class="etf-price" style="font-size:1.35rem;">${fmtPrice(item.price, item.currency, item.unit)}</span>
        <span class="etf-chg-pill ${dirClass(item.change_pct, true)}">${fmtSignedChange(item.change, item.change_pct)}</span>
      </div>
      <button type="button" class="live-search-btn" id="btnModalToMainChart" style="padding:7px 12px; font-size:0.76rem;">
        📈 상단 라이브 차트(1분·5분봉)로 열기
      </button>
    `;

    const jumpBtn = document.getElementById("btnModalToMainChart");
    if (jumpBtn) {
      jumpBtn.addEventListener("click", () => {
        modal.setAttribute("hidden", "");
        const sym = item.ticker || item.key || "SOXX";
        const cnbcMap = { US10Y: "US10Y", US5Y: "US5Y", WTI: "@CL.1", BRENT: "@LCO.1", GOLD: "@GC.1", VIX: ".VIX", USDKRW: "KRW=" };
        const cnbcSym = cnbcMap[sym] || sym;
        const cur = item.currency || (item.unit === "%" ? "PCT" : item.unit === "원" ? "KRW" : "USD");
        selectTickerForLiveChart(sym, cnbcSym, item.name_kr, cur, true);
      });
    }

    const metricsGrid = document.getElementById("modalMetricsGrid");
    if (type === "STOCK") {
      metricsGrid.innerHTML = `
        <div class="metric-cell num"><small>20일 지지선</small><strong>${fmtPrice(item.support_20d, item.currency)}</strong></div>
        <div class="metric-cell num"><small>20일 저항선</small><strong>${fmtPrice(item.resistance_20d, item.currency)}</strong></div>
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
      drawCandlestickChart("modalChartCanvas", (item.candles || []).slice(-75), {
        support20: item.support_20d,
        resistance20: item.resistance_20d,
        currency: item.currency,
      });
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
     12. 백그라운드 실시간 시세 자동 갱신 (10초 틱 & 30초 전체 시세)
     ======================================================================== */
  async function fetchLiveQuotesFromCNBC(isManual) {
    const d = state.data;
    if (!d) return;

    const icon = document.getElementById("refreshIcon");
    if (icon) icon.classList.add("spinning");

    try {
      const symbolMap = {
        SOXX: { type: "etf", key: "SOXX" },
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

      const allSyms = Object.keys(symbolMap).join("|");
      const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(allSyms)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;

      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) throw new Error("CNBC HTTP " + resp.status);
      const json = await resp.json();
      const quotes = json?.FormattedQuoteResult?.FormattedQuote || [];

      let updatedCount = 0;
      quotes.forEach((q) => {
        const sym = q.symbol;
        const target = symbolMap[sym];
        if (!target || !q.last) return;

        const price = parseFloat(String(q.last).replace(/,/g, ""));
        const chg = parseFloat(String(q.change || "0").replace(/,/g, ""));
        const chgPct = parseFloat(String(q.change_pct || "0").replace(/[%+,]/g, ""));
        if (isNaN(price) || price <= 0) return;

        if (target.type === "etf" && d.etfs?.[target.key]) {
          d.etfs[target.key].price = price;
          d.etfs[target.key].change = chg;
          d.etfs[target.key].change_pct = chgPct;
          updatedCount++;
        } else if (target.type === "macro") {
          const m = (d.macros || []).find((x) => x.key === target.key);
          if (m) {
            m.price = price;
            m.change = chg;
            m.change_pct = chgPct;
            updatedCount++;
          }
        } else if (target.type === "holding") {
          const h = (d.holdings || []).find((x) => x.ticker === target.key);
          if (h) {
            h.price = price;
            h.change = chg;
            h.change_pct = chgPct;
            updatedCount++;
          }
        }
      });

      if (updatedCount > 0) {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const ss = String(now.getSeconds()).padStart(2, "0");
        d.updated_at_kst = `실시간 연동 (${hh}:${mm}:${ss})`;

        renderTopTickerStrip();
        renderBriefingSection();
        renderEtfTrio();
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
      const enc = encodeURIComponent(state.chartCnbcSymbol);
      const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${enc}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return;
      const json = await resp.json();
      const q = json?.FormattedQuoteResult?.FormattedQuote?.[0];
      if (!q || !q.last) return;

      const price = parseFloat(String(q.last).replace(/,/g, ""));
      const pct = parseFloat(String(q.change_pct || "0").replace(/[%+,]/g, ""));
      if (isNaN(price) || price <= 0) return;

      const titleEl = document.getElementById("mainChartTitle");
      const ivLabel = state.chartInterval === "1M" ? "실시간 1분봉" : state.chartInterval === "5M" ? "실시간 5분봉" : state.chartInterval === "15M" ? "실시간 15분봉" : "일봉(90일)";
      if (titleEl) {
        const prevPrice = state.liveQuote?.price;
        state.liveQuote = { price, change_pct: pct };
        const pStr = fmtPrice(price, state.chartCurrency);
        const pctStr = fmtSignedPct(pct);
        const cls = dirClass(pct, false);
        titleEl.innerHTML = `${state.chartName} <span style="color:var(--gold-main); font-size:0.84rem;">(${state.chartSymbol})</span> · <span class="num ${cls} ${prevPrice && prevPrice !== price ? "price-flashed" : ""}">${pStr} (${pctStr})</span> · <span style="font-size:0.8rem; color:var(--ink-muted);">${ivLabel}</span>`;
      }

      if (state.chartCandles.length > 0) {
        const lastIdx = state.chartCandles.length - 1;
        const lastBar = state.chartCandles[lastIdx];
        lastBar.close = price;
        if (price > lastBar.high) lastBar.high = price;
        if (price < lastBar.low) lastBar.low = price;
        redrawMainChartFromState();
        if (state.chartHoverIdx === -1) {
          updateCrosshairHud(lastIdx);
        }
      }
    } catch (e) {
      // 무시
    }
  }

  /* ========================================================================
     13. 모바일 하단 탭 & 상단 네비게이션 스크롤 스파이
     ======================================================================== */
  function bindNavigationScrollSpy() {
    const sections = ["sec-live", "sec-brief", "sec-macro", "sec-holdings", "sec-news"];
    const topPills = document.querySelectorAll(".nav-pill");
    const bottomItems = document.querySelectorAll(".m-nav-item");

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            topPills.forEach((p) => p.classList.toggle("active", p.getAttribute("data-nav") === id));
            bottomItems.forEach((m) => m.classList.toggle("active", m.getAttribute("data-mnav") === id));
          }
        });
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: 0.01 }
    );

    sections.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
  }

  /* ========================================================================
     14. 초기 구동
     ======================================================================== */
  function init() {
    applyPreferences();
    bindPreferenceControls();
    bindMainChartInteractions();
    bindLiveSearchBox();
    bindHoldingsControls();
    bindNewsControls();
    bindModalEvents();
    bindNavigationScrollSpy();

    if (state.data) {
      renderTopTickerStrip();
      renderBriefingSection();
      renderEtfTrio();
      renderDramFlowPanel();
      renderMacroGrid();
      renderHoldings();
      renderNews();
      loadLiveChart("SOXX", "SOXX", "iShares 미국 반도체 ETF", "1D", "USD");
    }

    fetchLiveQuotesFromCNBC(false);
    setInterval(() => fetchLiveQuotesFromCNBC(false), 30000);
    setInterval(() => pollActiveChartLiveTick(), 10000);

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        redrawMainChartFromState();
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
