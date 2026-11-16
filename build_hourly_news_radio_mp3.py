#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
『어쩐지의 미국 증시 라이브』 — 1시간 단위 / 수동 원터치 통짜 뉴스 라디오 MP3 생성기
- 로컬(Mac) 및 GitHub Actions 무인 서버 양쪽 모두 호환
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
RATE = "+16%"
PITCH = "-2Hz"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_WEB_DIR = (
    SCRIPT_DIR
    if os.path.exists(os.path.join(SCRIPT_DIR, "index.html")) and os.path.exists(os.path.join(SCRIPT_DIR, "radio.html"))
    else "/Users/hanbeomsu/Desktop/어쩐지저녁/02_어쩐지저녁의_SOXX_웹및쇼츠"
)
BASE_LIVE_DIR = "/Users/hanbeomsu/Desktop/어쩐지저녁/01_24시간_미증시_라이브스튜디오"

KST = datetime.timezone(datetime.timedelta(hours=9))


def http_get(url: str, timeout: int = 6) -> str:
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
    s = re.sub(r"\s+", " ", s).strip()
    if " - " in s:
        parts = s.rsplit(" - ", 1)
        if len(parts[1]) <= 22:
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
        (r"SK하이닉스", "에스케이 하이닉스"), (r"\bLG\b", "엘지"),
        (r"\bHBM\d*[A-Z]?\b", "에이치비엠"), (r"\bDRAM\b", "디램"),
        (r"\bAI\b", "에이아이"), (r"\bCEO\b", "씨이오"), (r"\bIPO\b", "아이피오"),
        (r"\bFOMC\b", "에프오엠씨"), (r"\bFed\b", "미 연준"),
        (r"\bCPI\b", "소비자물가지수"), (r"\bPPI\b", "생산자물가지수"),
        (r"\bPCE\b", "개인소비지출"), (r"\bGDP\b", "지디피"),
        (r"\bWTI\b", "더블유티아이"), (r"\bVIX\b", "빅스"),
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
        f"어쩐지의 미국 증시 라이브, {now.month}월 {now.day}일 {ampm} {h12}시 {now.minute}분 기준 실시간 뉴스 및 24시 시세 라디오 브리핑입니다."
    ]
    summary_ui = []
    try:
        raw_bn = json.loads(http_get("https://fapi.binance.com/fapi/v1/ticker/24hr", timeout=5))
        bn_map = {r["symbol"]: r for r in raw_bn if "symbol" in r}
        qqq = bn_map.get("QQQUSDT")
        soxl = bn_map.get("SOXLUSDT")
        nvda = bn_map.get("NVDAUSDT")
        btc = bn_map.get("BTCUSDT")
        if qqq:
            p = float(qqq["lastPrice"])
            pct = float(qqq["priceChangePercent"])
            d_str = "상승" if pct >= 0 else "하락"
            parts.append(f"현재 해외 24시간 시장에서 나스닥 백 큐큐큐는 {p:.1f}달러로 {abs(pct):.2f}퍼센트 {d_str} 중입니다.")
            summary_ui.append(f"QQQ ${p:.2f} ({pct:+.2f}%)")
        if soxl:
            p = float(soxl["lastPrice"])
            pct = float(soxl["priceChangePercent"])
            d_str = "상승" if pct >= 0 else "하락"
            parts.append(f"반도체 3배 에스오엑스엘은 {p:.2f}달러로 {abs(pct):.2f}퍼센트 {d_str} 중이며,")
            summary_ui.append(f"SOXL ${p:.2f} ({pct:+.2f}%)")
        if nvda:
            p = float(nvda["lastPrice"])
            pct = float(nvda["priceChangePercent"])
            d_str = "오른" if pct >= 0 else "내린"
            parts.append(f"엔비디아는 {abs(pct):.2f}퍼센트 {d_str} {p:.2f}달러에 거래되고 있습니다.")
            summary_ui.append(f"NVDA ${p:.2f} ({pct:+.2f}%)")
        if btc:
            p = float(btc["lastPrice"])
            parts.append(f"비트코인은 {int(round(p)):,}달러입니다.")
    except Exception:
        pass

    parts.append("이어서 방금 들어온 국내외 주요 증시 및 경제 속보를 전해 드립니다.")
    return " ".join(parts), " · ".join(summary_ui)


def fetch_latest_news_items(max_items: int = 16) -> list[dict]:
    q_us = urllib.parse.quote("(뉴욕증시 OR 나스닥 OR 엔비디아 OR 반도체 OR 테슬라 OR 마이크론 OR 연준) when:1d")
    feeds = [
        ("🇺🇸 미증시·반도체", "주요언론", f"https://news.google.com/rss/search?q={q_us}&hl=ko&gl=KR&ceid=KR:ko"),
        ("📈 한국경제", "한국경제", "https://www.hankyung.com/feed/finance"),
        ("📈 매일경제", "매일경제", "https://www.mk.co.kr/rss/30300018/"),
        ("⚡ 연합속보", "연합뉴스", "https://www.yna.co.kr/rss/economy.xml"),
        ("🌍 국제속보", "연합뉴스", "https://www.yna.co.kr/rss/international.xml"),
    ]
    items = []
    seen = set()
    bad_words = ("부고", "인사", "동정", "포토", "화보", "운세", "로또", "골프", "연예")

    for cat, default_src, url in feeds:
        try:
            xml_txt = http_get(url, timeout=6).lstrip("\ufeff \t\r\n")
            root = ET.fromstring(xml_txt)
            for it in root.findall(".//item")[:10]:
                raw_t = html.unescape(it.findtext("title") or "").strip()
                src = default_src
                if " - " in raw_t:
                    p = raw_t.rsplit(" - ", 1)
                    if 1 <= len(p[1]) <= 20:
                        raw_t, src = p[0].strip(), p[1].strip()
                title = clean_text(raw_t)
                if len(title) < 8 or any(b in title for b in bad_words):
                    continue
                norm = re.sub(r"[^가-힣a-zA-Z0-9]", "", title)[:16].lower()
                if norm in seen:
                    continue
                seen.add(norm)

                desc = clean_text(it.findtext("description") or "")
                if desc and (title[:12] in desc or len(desc) < 15):
                    desc = ""
                if len(desc) > 150:
                    desc = desc[:148].rsplit(" ", 1)[0] + "."

                items.append({
                    "category": cat,
                    "source": src,
                    "title": title,
                    "summary": desc,
                })
                if len(items) >= max_items:
                    break
        except Exception:
            continue
        if len(items) >= max_items:
            break
    return items


async def synth_segments(segments: list[dict], temp_dir: str) -> list[str]:
    mp3_files = []
    for idx, seg in enumerate(segments):
        out_p = os.path.join(temp_dir, f"seg_{idx:03d}.mp3")
        comm = edge_tts.Communicate(seg["spoken"], voice=VOICE, rate=RATE, pitch=PITCH)
        await comm.save(out_p)
        mp3_files.append(out_p)
    return mp3_files


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
    print(f"[{now.strftime('%H:%M:%S')}] 1. 실시간 시세 및 최신 뉴스 수집 중...")
    opening_spoken, quote_summary_ui = fetch_market_brief_text()
    news_items = fetch_latest_news_items(16)

    segments = [
        {
            "category": "📊 실시간 24시 시세 브리핑",
            "source": "현수 아나운서",
            "title": f"{now.strftime('%m월 %d일 %H:%M')} 실시간 24시 시세 & 뉴스 브리핑",
            "summary": quote_summary_ui or "나스닥 · 반도체 · 주요 종목 실시간 브리핑",
            "spoken": opening_spoken,
        }
    ]

    for idx, n in enumerate(news_items, start=1):
        sp_title = to_spoken_korean(n["title"])
        sp_sum = to_spoken_korean(n["summary"]) if n.get("summary") else ""
        sp_src = to_spoken_korean(n["source"])
        if sp_sum:
            spoken = f"{idx}번째 소식, {sp_src} 보도입니다. {sp_title}. {sp_sum}"
        else:
            spoken = f"{idx}번째 소식, {sp_src} 보도입니다. {sp_title}."
        segments.append({
            "category": n["category"],
            "source": n["source"],
            "title": n["title"],
            "summary": n["summary"] or f"{n['source']} 실시간 주요 보도입니다.",
            "spoken": spoken,
        })

    segments.append({
        "category": "📻 브리핑 안내",
        "source": "어쩐지 뉴스라디오",
        "title": "실시간 뉴스 브리핑 순환 안내",
        "summary": "목소리는 AI 합성 음성이며 투자 권유가 아닙니다.",
        "spoken": "지금까지 실시간 주요 뉴스와 시세 브리핑이었습니다. 이 목소리는 에이아이 합성 음성이며 투자 권유가 아닙니다. 잠시 후 처음부터 다시 브리핑해 드립니다.",
    })

    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"[{now.strftime('%H:%M:%S')}] 2. 현수 아나운서({VOICE}) 음성 합성 중 ({len(segments)}개 트랙)...")
        seg_files = asyncio.run(synth_segments(segments, tmpdir))

        sil_path = os.path.join(tmpdir, "silence.mp3")
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.55", "-b:a", "96k", sil_path],
            check=True,
        )

        concat_txt = os.path.join(tmpdir, "concat.txt")
        cues = []
        cur_t = 0.0
        with open(concat_txt, "w", encoding="utf-8") as f:
            for seg, mp3_p in zip(segments, seg_files):
                dur = get_duration(mp3_p)
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
                cur_t += dur + 0.55

        out_mp3_web = os.path.join(BASE_WEB_DIR, "latest_news_radio.mp3")
        out_json_web = os.path.join(BASE_WEB_DIR, "latest_news_radio.json")

        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat_txt, "-c:a", "libmp3lame", "-b:a", "96k", "-ar", "24000", out_mp3_web],
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

        print(f"[{now.strftime('%H:%M:%S')}] 완료! 총 길이: {total_dur:.1f}초 ({len(cues)}개 트랙) -> {out_mp3_web}")


if __name__ == "__main__":
    build_radio_package()
