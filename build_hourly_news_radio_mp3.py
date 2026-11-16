#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
『YYYY년 M월 D일 주요 뉴스』 — 약 1시간 분량 연속 뉴스 라디오 MP3 빌더
- 1부~5부 코너 나눔·중간 안내 멘트 없이 처음부터 끝까지 자연스럽게 쭉 이어서 낭독
- 당일 세그먼트 캐시를 유지하여 2시간마다 새로 들어온 뉴스만 빠르게 추가·갱신
"""

import asyncio
import datetime
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import edge_tts

VOICE = "ko-KR-HyunsuMultilingualNeural"
RATE = "+14%"
PITCH = "-2Hz"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_WEB_DIR = (
    SCRIPT_DIR
    if os.path.exists(os.path.join(SCRIPT_DIR, "radio.html"))
    else "/Users/hanbeomsu/Desktop/어쩐지저녁/02_어쩐지저녁의_SOXX_웹및쇼츠"
)
BASE_LIVE_DIR = "/Users/hanbeomsu/Desktop/어쩐지저녁/01_24시간_미증시_라이브스튜디오"
CACHE_ROOT = (
    "/Users/hanbeomsu/Desktop/어쩐지저녁/01_24시간_미증시_라이브스튜디오/_daily_radio_cache"
    if os.path.exists("/Users/hanbeomsu/Desktop/어쩐지저녁/01_24시간_미증시_라이브스튜디오")
    else "/tmp/evening_daily_radio_cache"
)

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


def norm_key(title: str) -> str:
    return re.sub(r"[^가-힣a-zA-Z0-9]", "", str(title or ""))[:16].lower()


def fetch_market_brief_text(now: datetime.datetime) -> tuple[str, str]:
    parts = [
        f"{now.year}년 {now.month}월 {now.day}일 주요 뉴스입니다."
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
            parts.append(f"현재 나스닥 백 큐큐큐는 {p:.1f}달러로 {abs(pct):.2f}퍼센트 {d_str} 중입니다.")
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
            parts.append(f"엔비디아는 {abs(pct):.2f}퍼센트 {d_str} {p:.2f}달러입니다.")
            summary_ui.append(f"NVDA ${p:.2f} ({pct:+.2f}%)")
        if tsla:
            p = float(tsla["lastPrice"])
            pct = float(tsla["priceChangePercent"])
            d_str = "오른" if pct >= 0 else "내린"
            parts.append(f"테슬라는 {abs(pct):.2f}퍼센트 {d_str} {p:.2f}달러입니다.")
        if wti and gold:
            parts.append(f"국제 유가 더블유티아이는 {float(wti['lastPrice']):.2f}달러, 국제 금은 {float(gold['lastPrice']):.1f}달러,")
        if btc:
            p = float(btc["lastPrice"])
            parts.append(f"비트코인은 {int(round(p)):,}달러입니다.")
    except Exception:
        pass

    return " ".join(parts), " · ".join(summary_ui)


def fetch_bing_rss_items(query: str, cat: str, max_cnt: int = 16, seen: set = None) -> list[dict]:
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
            nk = norm_key(title)
            if not nk or nk in seen:
                continue
            seen.add(nk)

            desc = clean_text(it.findtext("description") or "")
            if desc and (title[:14] in desc and len(desc) < len(title) + 15):
                desc = ""
            if len(desc) > 220:
                desc = desc[:218].rsplit(" ", 1)[0] + "."

            out.append({
                "key": nk,
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


def fetch_standard_rss_items(url: str, cat: str, default_src: str, max_cnt: int = 20, seen: set = None) -> list[dict]:
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
            nk = norm_key(title)
            if not nk or nk in seen:
                continue
            seen.add(nk)

            desc = clean_text(it.findtext("description") or "")
            if desc and (title[:14] in desc or "<a " in desc or len(desc) < 15):
                desc = ""
            if len(desc) > 220:
                desc = desc[:218].rsplit(" ", 1)[0] + "."

            out.append({
                "key": nk,
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


def collect_flat_news(target_count: int = 185) -> list[dict]:
    """약 55~60분 분량을 맞추기 위해 중복 없이 다양한 매체에서 185건 내외 수집"""
    seen = set()
    items = []

    sources = [
        ("bing", "뉴욕증시 나스닥 S&P500 월가", "🇺🇸 미국증시", 15),
        ("bing", "엔비디아 TSMC 브로드컴 AMD 마이크론", "🔬 AI·반도체", 15),
        ("bing", "삼성전자 SK하이닉스 HBM D램", "🔬 메모리·HBM", 15),
        ("bing", "미국 연준 파월 금리 국채 물가", "🏛 금리·매크로", 12),
        ("bing", "테슬라 애플 마이크로소프트 구글 오픈AI", "💡 빅테크", 14),
        ("rss", "https://www.yna.co.kr/rss/economy.xml", "📈 한국경제", "연합뉴스", 20),
        ("rss", "https://www.hankyung.com/feed/finance", "📈 증권·금융", "한국경제", 18),
        ("rss", "https://www.mk.co.kr/rss/30100041/", "📈 경제·산업", "매일경제", 18),
        ("rss", "https://www.yna.co.kr/rss/news.xml", "⚡ 주요속보", "연합뉴스", 20),
        ("rss", "https://www.yna.co.kr/rss/politics.xml", "🏛 정치·정책", "연합뉴스", 14),
        ("rss", "https://www.yna.co.kr/rss/society.xml", "📰 사회뉴스", "연합뉴스", 14),
        ("rss", "https://www.hankyung.com/feed/it", "💻 IT·테크", "한국경제", 14),
        ("rss", "https://www.hankyung.com/feed/all-news", "📰 종합뉴스", "한국경제", 15),
        ("rss", "https://www.yna.co.kr/rss/international.xml", "🌍 국제뉴스", "연합뉴스", 16),
        ("rss", "https://www.mk.co.kr/rss/30300018/", "🌍 국제경제", "매일경제", 14),
        ("bing", "국제유가 중동 미국 중국 관세", "🌍 지정학·유가", 12),
    ]

    for s in sources:
        if len(items) >= target_count:
            break
        if s[0] == "bing":
            _, q, cat, lim = s
            items.extend(fetch_bing_rss_items(q, cat, lim, seen))
        else:
            _, url, cat, src_name, lim = s
            items.extend(fetch_standard_rss_items(url, cat, src_name, lim, seen))

    # 부족할 경우 구글 뉴스 검색으로 보충
    if len(items) < target_count:
        q_extra = urllib.parse.quote("(경제 OR 증시 OR 반도체 OR 기업 OR 속보) when:1d")
        items.extend(
            fetch_standard_rss_items(
                f"https://news.google.com/rss/search?q={q_extra}&hl=ko&gl=KR&ceid=KR:ko",
                "📰 주요뉴스",
                "주요언론",
                target_count - len(items),
                seen,
            )
        )

    return items[:target_count]


def merge_with_daily_archive(day_dir: str, new_items: list[dict], max_keep: int = 195) -> list[dict]:
    archive_path = os.path.join(day_dir, "daily_flat_news.json")
    old_items = []
    if os.path.exists(archive_path):
        try:
            with open(archive_path, "r", encoding="utf-8") as f:
                old_items = json.load(f)
        except Exception:
            old_items = []

    old_keys = {it.get("key") for it in old_items if it.get("key")}
    seen = set()
    combined = []
    added_count = 0

    for it in new_items:
        k = it.get("key") or norm_key(it.get("title", ""))
        if not k or k in seen:
            continue
        if old_items and k not in old_keys:
            added_count += 1
        seen.add(k)
        combined.append(it)

    for it in old_items:
        k = it.get("key") or norm_key(it.get("title", ""))
        if not k or k in seen:
            continue
        seen.add(k)
        combined.append(it)

    final_list = combined[:max_keep]
    with open(archive_path, "w", encoding="utf-8") as f:
        json.dump(final_list, f, ensure_ascii=False, indent=2)

    if old_items:
        print(f" -> 기존 아침 뉴스에 신규 추가된 뉴스: {added_count}건")
    return final_list


async def synth_cached_segments(segments: list[dict], audio_cache_dir: str) -> list[str]:
    sem = asyncio.Semaphore(8)
    out_paths = []
    tasks = []

    for seg in segments:
        h = hashlib.sha256(f"{VOICE}|{RATE}|{PITCH}|{seg['spoken']}".encode("utf-8")).hexdigest()[:24]
        mp3_p = os.path.join(audio_cache_dir, f"{h}.mp3")
        out_paths.append(mp3_p)

        if os.path.exists(mp3_p) and os.path.getsize(mp3_p) > 300:
            continue

        async def _worker(target_path: str, text: str):
            async with sem:
                for attempt in range(3):
                    try:
                        comm = edge_tts.Communicate(text, voice=VOICE, rate=RATE, pitch=PITCH)
                        await comm.save(target_path)
                        if os.path.exists(target_path) and os.path.getsize(target_path) > 300:
                            return
                    except Exception:
                        await asyncio.sleep(0.5 * (attempt + 1))

        tasks.append(_worker(mp3_p, seg["spoken"]))

    if tasks:
        print(f" -> 신규 음성 세그먼트 {len(tasks)}개 합성 중 (기존 세그먼트는 캐시 재사용)...")
        await asyncio.gather(*tasks)
    else:
        print(" -> 모든 뉴스 세그먼트가 이미 캐시되어 있어 즉시 병합합니다.")

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


def is_us_market_night_window(now: datetime.datetime) -> bool:
    """한국 시각 23:25 ~ 05:50 (미증시 정규장 야간 시간대)에는 30분짜리 속보판으로 자동 전환"""
    hm = now.hour * 60 + now.minute
    return (hm >= 23 * 60 + 25) or (hm <= 5 * 60 + 50)


def build_radio_package():
    now = datetime.datetime.now(KST)
    night_mode = is_us_market_night_window(now)
    target_cnt = 92 if night_mode else 185
    max_keep = 95 if night_mode else 195
    mode_label = "야간 미증시 30분 속보판" if night_mode else "주간 1시간 종합판"

    day_str = now.strftime("%Y%m%d")
    day_dir = os.path.join(CACHE_ROOT, day_str)
    audio_cache_dir = os.path.join(day_dir, "mp3_segs")
    os.makedirs(audio_cache_dir, exist_ok=True)

    date_title = f"{now.year}년 {now.month}월 {now.day}일 주요 뉴스"
    print(f"[{now.strftime('%H:%M:%S')}] '{date_title}' ({mode_label}) 수집 중...")

    opening_spoken, quote_summary_ui = fetch_market_brief_text(now)
    new_items = collect_flat_news(target_count=target_cnt)
    merged_items = merge_with_daily_archive(day_dir, new_items, max_keep=max_keep)

    segments = [
        {
            "category": f"📻 {date_title}",
            "source": f"{now.strftime('%H:%M')} 업데이트",
            "title": f"{date_title} 및 실시간 시세",
            "summary": quote_summary_ui or "주요 시세 및 뉴스 브리핑",
            "spoken": opening_spoken,
        }
    ]

    for n in merged_items:
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

    seg_files = asyncio.run(synth_cached_segments(segments, audio_cache_dir))

    sil_path = os.path.join(day_dir, "silence_650ms.mp3")
    if not os.path.exists(sil_path):
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.65", "-b:a", "48k", sil_path],
            check=True,
        )

    concat_txt = os.path.join(day_dir, "concat.txt")
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

    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat_txt, "-c:a", "libmp3lame", "-b:a", "48k", "-ar", "24000", "-ac", "1", out_mp3_web],
        check=True,
    )

    total_dur = get_duration(out_mp3_web)
    meta = {
        "date_title": date_title,
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
        shutil.copy2(out_mp3_web, os.path.join(BASE_LIVE_DIR, "latest_news_radio.mp3"))
        shutil.copy2(out_json_web, os.path.join(BASE_LIVE_DIR, "latest_news_radio.json"))

    mins = int(total_dur // 60)
    secs = int(total_dur % 60)
    sz_mb = os.path.getsize(out_mp3_web) / (1024 * 1024)
    print(f"[{now.strftime('%H:%M:%S')}] 완료! '{date_title}' 총 길이: {mins}분 {secs}초 ({len(cues)}개 트랙, {sz_mb:.1f}MB)")


if __name__ == "__main__":
    build_radio_package()
