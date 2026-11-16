#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
『어쩐지의 미국 증시 라이브』 — 약 1시간 분량(5부작 85~100트랙) 통짜 뉴스 라디오 MP3 마스터 생성기
- 1부: 실시간 24시 시세 브리핑 & 미국 증시·월가 핵심 뉴스
- 2부: AI · 반도체 · 빅테크 집중 뉴스 (엔비디아·TSMC·삼성전자·SK하이닉스·마이크론 등)
- 3부: 한국 경제 · 금융 · 산업 · 기업 실적 뉴스
- 4부: 대한민국 정치 · 정책 · 사회 주요 종합 뉴스
- 5부: 글로벌 지정학 · 미중 관계 · 국제 유가 · 세계 뉴스
- asyncio.Semaphore(8) 병렬 합성으로 약 15~20초 만에 50~60분 분량 통짜 MP3 생성
"""

import asyncio
import datetime
import html
import json
import os
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import edge_tts

VOICE = "ko-KR-HyunsuMultilingualNeural"
RATE = "+14%"
PITCH = "-2Hz"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_WEB_DIR = "/Users/hanbeomsu/Desktop/어쩐지저녁/02_어쩐지저녁의_SOXX_웹및쇼츠"
BASE_LIVE_DIR = "/Users/hanbeomsu/Desktop/어쩐지저녁/01_24시간_미증시_라이브스튜디오"

KST = datetime.timezone(datetime.timedelta(hours=9))


def http_get(url: str, timeout: int = 7) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="ignore")


def clean_text(raw: str) -> str:
    s = html.unescape(str(raw or ""))
    s = re.sub(r"<[^>]*>", " ", s)
    s = re.sub(r"&nbsp;|&#160;", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if " - " in s:
        parts = s.rsplit(" - ", 1)
        if len(parts[1]) <= 24:
            s = parts[0].strip()
    return s


def to_spoken_korean(text: str) -> str:
    s = str(text or "")
    rules = [
        (r"\[속보\]", "속보입니다. "),
        (r"\[단독\]", "단독 보도입니다. "),
        (r"\[특파원[^\]]*\]", ""),
        (r"\[[^\]]{1,18}\]", " "),
        (r"美", "미국 "), (r"中", "중국 "), (r"日", "일본 "), (r"韓", "한국 "), (r"歐", "유럽 "),
        (r"\bSOXL\b", "에스오엑스엘"), (r"\bSOXX\b", "에스오엑스엑스"),
        (r"\bSMH\b", "에스엠에이치"), (r"\bQQQ\b", "큐큐큐"), (r"\bTQQQ\b", "티큐큐큐"),
        (r"\bSPY\b", "에스피와이"), (r"S&P\s*500", "에스앤피 오백"),
        (r"\bNVDA\b", "엔비디아"), (r"\bNVIDIA\b", "엔비디아"),
        (r"\bTSLA\b", "테슬라"), (r"\bAAPL\b", "애플"), (r"\bMSFT\b", "마이크로소프트"),
        (r"\bAMZN\b", "아마존"), (r"\bGOOGL\b", "구글"), (r"\bMETA\b", "메타"),
        (r"\bAVGO\b", "브로드컴"), (r"\bMU\b", "마이크론"), (r"\bAMD\b", "에이엠디"),
        (r"\bTSMC\b", "티에스엠씨"), (r"\bASML\b", "에이에스엠엘"),
        (r"SK하이닉스", "에스케이 하이닉스"), (r"\bLG\b", "엘지"), (r"\bKT\b", "케이티"), (r"\bSKT\b", "에스케이티"),
        (r"\bHBM\d*[A-Z]?\b", "에이치비엠"), (r"\bDRAM\b", "디램"),
        (r"\bAI\b", "에이아이"), (r"\bCEO\b", "씨이오"), (r"\bIPO\b", "아이피오"),
        (r"\bFOMC\b", "에프오엠씨"), (r"\bFed\b", "미 연준"),
        (r"\bCPI\b", "소비자물가지수"), (r"\bPPI\b", "생산자물가지수"),
        (r"\bPCE\b", "개인소비지출"), (r"\bGDP\b", "지디피"),
        (r"\bWTI\b", "더블유티아이"), (r"\bVIX\b", "빅스"), (r"\bIMF\b", "아이엠에프"),
        (r"\+(\d)", r"플러스 \1"), (r"-(\d)", r"마이너스 \1"),
        (r"%p\b", "퍼센트포인트"), (r"%", " 퍼센트"), (r"\$", " 달러 "),
        (r"…|\.\.\.|ㆍ|·", ", "),
        (r"[“”\"‘’'<>《》〈〉()]", " "),
    ]
    for pat, rep in rules:
        s = re.sub(pat, rep, s, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", s).strip()


def fetch_market_brief_text() -> tuple[str, str]:
    now = datetime.datetime.now(KST)
    ampm = "오전" if now.hour < 12 else "오후"
    h12 = now.hour % 12 or 12
    parts = [
        f"어쩐지의 미국 증시 라이브, {now.month}월 {now.day}일 {ampm} {h12}시 기준 1시간 연속 뉴스 라디오 종합 브리핑을 시작합니다. 이 방송은 에이아이 합성 음성으로 진행되며 투자 권유가 아닙니다."
    ]
    summary_ui = []
    try:
        raw_bn = json.loads(http_get("https://fapi.binance.com/fapi/v1/ticker/24hr", timeout=5))
        bn_map = {r["symbol"]: r for r in raw_bn if "symbol" in r}
        qqq = bn_map.get("QQQUSDT")
        soxl = bn_map.get("SOXLUSDT")
        nvda = bn_map.get("NVDAUSDT")
        tsla = bn_map.get("TSLAUSDT")
        btc = bn_map.get("BTCUSDT")
        wti = bn_map.get("CLUSDT")
        gold = bn_map.get("XAUUSDT")
        if qqq:
            p = float(qqq["lastPrice"])
            pct = float(qqq["priceChangePercent"])
            d_str = "상승" if pct >= 0 else "하락"
            parts.append(f"먼저 해외 24시간 실시간 시세입니다. 나스닥 백을 추종하는 큐큐큐는 {p:.1f}달러로 {abs(pct):.2f}퍼센트 {d_str} 중입니다.")
            summary_ui.append(f"QQQ ${p:.2f} ({pct:+.2f}%)")
        if soxl:
            p = float(soxl["lastPrice"])
            pct = float(soxl["priceChangePercent"])
            d_str = "상승" if pct >= 0 else "하락"
            parts.append(f"반도체 3배 레버리지 에스오엑스엘은 {p:.2f}달러로 {abs(pct):.2f}퍼센트 {d_str} 중이며,")
            summary_ui.append(f"SOXL ${p:.2f} ({pct:+.2f}%)")
        if nvda:
            p = float(nvda["lastPrice"])
            pct = float(nvda["priceChangePercent"])
            d_str = "오른" if pct >= 0 else "내린"
            parts.append(f"엔비디아는 {abs(pct):.2f}퍼센트 {d_str} {p:.2f}달러에 거래되고 있습니다.")
            summary_ui.append(f"NVDA ${p:.2f} ({pct:+.2f}%)")
        if tsla:
            p = float(tsla["lastPrice"])
            pct = float(tsla["priceChangePercent"])
            d_str = "오른" if pct >= 0 else "내린"
            parts.append(f"테슬라는 {abs(pct):.2f}퍼센트 {d_str} {p:.2f}달러를 기록 중입니다.")
        if wti and gold:
            parts.append(f"국제 유가 더블유티아이는 배럴당 {float(wti['lastPrice']):.2f}달러, 국제 금 시세는 온스당 {float(gold['lastPrice']):.1f}달러,")
        if btc:
            p = float(btc["lastPrice"])
            parts.append(f"비트코인은 {int(round(p)):,}달러입니다.")
    except Exception:
        pass

    parts.append("지금부터 1부 미국 증시와 월가 소식, 2부 에이아이와 반도체, 3부 한국 경제와 산업, 4부 국내 주요 속보, 5부 세계와 지정학 소식 순서로 약 한 시간 동안 연속 전해 드립니다.")
    return " ".join(parts), " · ".join(summary_ui)


def fetch_bing_rss_items(query: str, cat: str, max_cnt: int = 12, seen: set = None) -> list[dict]:
    if seen is None:
        seen = set()
    out = []
    bad_words = ("부고", "인사", "동정", "포토", "화보", "운세", "로또", "골프", "연예")
    try:
        rss_url = f"https://www.bing.com/news/search?q={urllib.parse.quote(query)}&setlang=ko&cc=KR&sortby=date&format=rss"
        xml_txt = http_get(rss_url, timeout=6).lstrip("\ufeff \t\r\n")
        root = ET.fromstring(xml_txt)
        for it in root.findall(".//item"):
            raw_t = html.unescape(it.findtext("title") or "").strip()
            src = "주요언론"
            if " - " in raw_t:
                p = raw_t.rsplit(" - ", 1)
                if 1 <= len(p[1]) <= 22:
                    raw_t, src = p[0].strip(), p[1].strip()
            title = clean_text(raw_t)
            if len(title) < 8 or any(b in title for b in bad_words):
                continue
            norm = re.sub(r"[^가-힣a-zA-Z0-9]", "", title)[:15].lower()
            if norm in seen:
                continue
            seen.add(norm)

            desc = clean_text(it.findtext("description") or "")
            if desc and (title[:14] in desc and len(desc) < len(title) + 15):
                desc = ""
            if len(desc) > 220:
                desc = desc[:218].rsplit(" ", 1)[0] + "."

            out.append({
                "category": cat,
                "source": src,
                "title": title,
                "summary": desc,
            })
            if len(out) >= max_cnt:
                break
    except Exception:
        pass
    return out


def fetch_standard_rss_items(url: str, cat: str, default_src: str, max_cnt: int = 14, seen: set = None) -> list[dict]:
    if seen is None:
        seen = set()
    out = []
    bad_words = ("부고", "인사", "동정", "포토", "화보", "운세", "로또", "골프", "연예")
    try:
        xml_txt = http_get(url, timeout=6).lstrip("\ufeff \t\r\n")
        root = ET.fromstring(xml_txt)
        for it in root.findall(".//item"):
            raw_t = html.unescape(it.findtext("title") or "").strip()
            src = default_src
            if " - " in raw_t:
                p = raw_t.rsplit(" - ", 1)
                if 1 <= len(p[1]) <= 22:
                    raw_t, src = p[0].strip(), p[1].strip()
            title = clean_text(raw_t)
            if len(title) < 8 or any(b in title for b in bad_words):
                continue
            norm = re.sub(r"[^가-힣a-zA-Z0-9]", "", title)[:15].lower()
            if norm in seen:
                continue
            seen.add(norm)

            desc = clean_text(it.findtext("description") or "")
            if desc and (title[:14] in desc or "<a " in desc or len(desc) < 15):
                desc = ""
            if len(desc) > 220:
                desc = desc[:218].rsplit(" ", 1)[0] + "."

            out.append({
                "category": cat,
                "source": src,
                "title": title,
                "summary": desc,
            })
            if len(out) >= max_cnt:
                break
    except Exception:
        pass
    return out


def collect_1hour_news_sections() -> list[tuple[str, str, list[dict]]]:
    seen = set()
    sections = []

    # 1부: 미국 증시 & 월가 거시경제
    s1 = []
    s1.extend(fetch_bing_rss_items("뉴욕증시 나스닥 S&P500 월가 마감", "🇺🇸 1부 · 미국증시", 10, seen))
    s1.extend(fetch_bing_rss_items("미국 연준 파월 금리 국채 물가", "🇺🇸 1부 · 연준·금리", 8, seen))
    q_us = urllib.parse.quote("(뉴욕증시 OR 나스닥 OR S&P500 OR 월가 OR 미 국채금리) when:1d")
    s1.extend(fetch_standard_rss_items(f"https://news.google.com/rss/search?q={q_us}&hl=ko&gl=KR&ceid=KR:ko", "🇺🇸 1부 · 월가속보", "주요언론", 8, seen))
    sections.append((
        "📻 1부 · 미국 증시 & 월가 브리핑",
        "1부 순서입니다. 뉴욕 증시 흐름과 미국 연준, 국채 금리 관련 주요 소식을 전해 드립니다.",
        s1[:22],
    ))

    # 2부: AI · 반도체 · 빅테크 집중 브리핑
    s2 = []
    s2.extend(fetch_bing_rss_items("엔비디아 TSMC 브로드컴 AMD 마이크론 반도체", "🔬 2부 · AI반도체", 10, seen))
    s2.extend(fetch_bing_rss_items("삼성전자 SK하이닉스 HBM D램 파운드리", "🔬 2부 · 메모리·HBM", 10, seen))
    s2.extend(fetch_bing_rss_items("테슬라 애플 마이크로소프트 오픈AI 구글", "🔬 2부 · 빅테크", 8, seen))
    sections.append((
        "🔬 2부 · AI · 반도체 · 빅테크 집중 브리핑",
        "이어서 2부 순서입니다. 엔비디아와 티에스엠씨, 삼성전자와 에스케이하이닉스 등 글로벌 반도체와 빅테크 핵심 소식을 전해 드립니다.",
        s2[:22],
    ))

    # 3부: 한국 경제 · 금융 · 산업 · 기업
    s3 = []
    s3.extend(fetch_standard_rss_items("https://www.yna.co.kr/rss/economy.xml", "📈 3부 · 한국경제", "연합뉴스", 12, seen))
    s3.extend(fetch_standard_rss_items("https://www.hankyung.com/feed/finance", "📈 3부 · 증권·금융", "한국경제", 10, seen))
    s3.extend(fetch_standard_rss_items("https://www.mk.co.kr/rss/30100041/", "📈 3부 · 경제·산업", "매일경제", 10, seen))
    sections.append((
        "📈 3부 · 한국 경제 & 산업 브리핑",
        "계속해서 3부 순서입니다. 국내 경제와 금융 시장, 주요 기업과 산업계 소식을 전해 드립니다.",
        s3[:22],
    ))

    # 4부: 대한민국 주요 종합 속보 (정치·정책·사회)
    s4 = []
    s4.extend(fetch_standard_rss_items("https://www.yna.co.kr/rss/news.xml", "⚡ 4부 · 종합속보", "연합뉴스", 12, seen))
    s4.extend(fetch_standard_rss_items("https://www.yna.co.kr/rss/politics.xml", "🏛 4부 · 정치·정책", "연합뉴스", 8, seen))
    s4.extend(fetch_standard_rss_items("https://www.hankyung.com/feed/all-news", "📰 4부 · 주요뉴스", "한국경제", 8, seen))
    sections.append((
        "⚡ 4부 · 대한민국 종합 주요 뉴스",
        "이어서 4부 순서입니다. 오늘 들어온 대한민국 주요 정책과 사회 종합 속보를 전해 드립니다.",
        s4[:20],
    ))

    # 5부: 세계 · 지정학 · 국제유가 · 환율
    s5 = []
    s5.extend(fetch_standard_rss_items("https://www.yna.co.kr/rss/international.xml", "🌍 5부 · 세계속보", "연합뉴스", 10, seen))
    s5.extend(fetch_standard_rss_items("https://www.mk.co.kr/rss/30300018/", "🌍 5부 · 국제경제", "매일경제", 8, seen))
    s5.extend(fetch_bing_rss_items("국제유가 중동 미국 중국 관세 정상회담", "🌍 5부 · 지정학·유가", 8, seen))
    sections.append((
        "🌍 5부 · 글로벌 지정학 & 세계 뉴스",
        "마지막 5부 순서입니다. 미국과 중국, 중동 정세와 국제 유가 등 글로벌 주요 소식을 전해 드립니다.",
        s5[:18],
    ))

    return sections


async def synth_all_parallel(segments: list[dict], temp_dir: str) -> list[str]:
    sem = asyncio.Semaphore(8)
    out_paths = [os.path.join(temp_dir, f"seg_{i:03d}.mp3") for i in range(len(segments))]

    async def _worker(idx: int, seg: dict):
        out_p = out_paths[idx]
        async with sem:
            for attempt in range(3):
                try:
                    comm = edge_tts.Communicate(seg["spoken"], voice=VOICE, rate=RATE, pitch=PITCH)
                    await comm.save(out_p)
                    if os.path.exists(out_p) and os.path.getsize(out_p) > 300:
                        return
                except Exception:
                    await asyncio.sleep(0.5 * (attempt + 1))

    await asyncio.gather(*[_worker(i, s) for i, s in enumerate(segments)])
    return out_paths


def get_duration(path: str) -> float:
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
            text=True,
        ).strip()
        return float(out)
    except Exception:
        return 0.0


def build_radio_package():
    now = datetime.datetime.now(KST)
    print(f"[{now.strftime('%H:%M:%S')}] 1. 5부작(미증시·반도체·한국경제·종합속보·국제) 대량 뉴스 수집 중...")
    opening_spoken, quote_summary_ui = fetch_market_brief_text()
    sections = collect_1hour_news_sections()

    segments = [
        {
            "category": "📊 오프닝 & 24시 실시간 시세",
            "source": "현수 아나운서",
            "title": f"{now.strftime('%m월 %d일 %H:%M')} 기준 5부작 장시간 뉴스 라디오 마스터",
            "summary": quote_summary_ui or "나스닥 · 반도체 · 주요 종목 실시간 브리핑",
            "spoken": opening_spoken,
        }
    ]

    news_counter = 0
    for sec_title, sec_intro, sec_items in sections:
        if not sec_items:
            continue
        segments.append({
            "category": sec_title,
            "source": "코너 오프닝",
            "title": sec_title,
            "summary": sec_intro,
            "spoken": sec_intro,
        })
        for n in sec_items:
            news_counter += 1
            sp_title = to_spoken_korean(n["title"])
            sp_sum = to_spoken_korean(n["summary"]) if n.get("summary") else ""
            sp_src = to_spoken_korean(n["source"])
            if sp_sum:
                spoken = f"{sp_src} 보도입니다. {sp_title}. {sp_sum}"
            else:
                spoken = f"{sp_src} 소식입니다. {sp_title}."
            segments.append({
                "category": n["category"],
                "source": n["source"],
                "title": n["title"],
                "summary": n["summary"] or f"{n['source']} 주요 보도입니다.",
                "spoken": spoken,
            })

    segments.append({
        "category": "📻 클로징 안내",
        "source": "어쩐지 뉴스라디오",
        "title": "장시간 뉴스 라디오 종합 브리핑 마무리",
        "summary": "목소리는 AI 합성 음성이며 투자 권유가 아닙니다. 처음부터 다시 연속 재생됩니다.",
        "spoken": f"지금까지 총 {news_counter}건의 국내외 주요 뉴스와 시세 브리핑을 모두 전해 드렸습니다. 이 목소리는 에이아이 합성 음성이며 투자 권유가 아닙니다. 잠시 후 1부부터 다시 연속으로 전해 드립니다.",
    })

    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"[{now.strftime('%H:%M:%S')}] 2. 현수 아나운서({VOICE}) 8채널 초고속 병렬 합성 중 (총 {len(segments)}개 트랙)...")
        seg_files = asyncio.run(synth_all_parallel(segments, tmpdir))

        sil_path = os.path.join(tmpdir, "silence.mp3")
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.65", "-b:a", "48k", sil_path],
            check=True,
        )

        concat_txt = os.path.join(tmpdir, "concat.txt")
        cues = []
        cur_t = 0.0
        with open(concat_txt, "w", encoding="utf-8") as f:
            for seg, mp3_p in zip(segments, seg_files):
                if not os.path.exists(mp3_p) or os.path.getsize(mp3_p) < 300:
                    continue
                dur = get_duration(mp3_p)
                if dur <= 0.1:
                    continue
                cues.append({
                    "start": round(cur_t, 2),
                    "end": round(cur_t + dur, 2),
                    "category": seg["category"],
                    "source": seg["source"],
                    "title": seg["title"],
                    "summary": seg["summary"],
                })
                f.write(f"file '{mp3_p}'\n")
                f.write(f"file '{sil_path}'\n")
                cur_t += dur + 0.65

        out_mp3_web = os.path.join(BASE_WEB_DIR, "latest_news_radio.mp3")
        out_json_web = os.path.join(BASE_WEB_DIR, "latest_news_radio.json")

        # 48kbps 24kHz mono (라디오 음성 방송 표준 — 30~50분 분량도 10~15MB로 가볍고 선명함)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat_txt, "-c:a", "libmp3lame", "-b:a", "48k", "-ar", "24000", "-ac", "1", out_mp3_web],
            check=True,
        )

        total_dur = get_duration(out_mp3_web)
        meta = {
            "updated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
            "updated_hm": now.strftime("%H:%M"),
            "voice": VOICE,
            "duration": round(total_dur, 2),
            "track_count": len(cues),
            "cues": cues,
        }
        with open(out_json_web, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        if os.path.exists(BASE_LIVE_DIR) and os.path.abspath(BASE_LIVE_DIR) != os.path.abspath(BASE_WEB_DIR):
            subprocess.run(["cp", out_mp3_web, os.path.join(BASE_LIVE_DIR, "latest_news_radio.mp3")], check=False)
            subprocess.run(["cp", out_json_web, os.path.join(BASE_LIVE_DIR, "latest_news_radio.json")], check=False)

        mins = int(total_dur // 60)
        secs = int(total_dur % 60)
        sz_mb = os.path.getsize(out_mp3_web) / (1024 * 1024)
        print(f"[{now.strftime('%H:%M:%S')}] 완료! 총 길이: {mins}분 {secs}초 ({len(cues)}개 트랙, {sz_mb:.1f}MB) -> {out_mp3_web}")


if __name__ == "__main__":
    build_radio_package()
