#!/usr/bin/env python3
"""
Sample Key Reviewer - yerel backend (Flask).

Ses dosyalarının key / nota bilgisini analiz eder, adayları gösterir; kullanıcı onayladıktan sonra
dosya adına " [key]" ekler.   Örn:  808 Bass.wav -> 808 Bass [F#1].wav,  Pad Loop.wav -> Pad Loop [Am].wav

Çalıştırma:
    pip install -r requirements.txt
    python app.py                       # tarayıcı otomatik açılır: http://127.0.0.1:5173
    python app.py "D:/Samples" --log "D:/Samples/islem_gunlugu.csv"

Güvenlik: sunucu yalnızca 127.0.0.1'e bağlanır; yeniden adlandırma sadece taranan klasördeki,
analiz edilmiş dosyalar için çalışır; var olan dosyanın üzerine asla yazılmaz.
"""
import argparse
import csv
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
import warnings
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import librosa
import soundfile as sf
from flask import Flask, abort, jsonify, request, send_file, send_from_directory

warnings.filterwarnings("ignore")

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path.home() / ".key_renamer"
CACHE_FILE = DATA_DIR / "cache_v2.json"
CACHE_VERSION = "v2"

AUDIO_EXT = {".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg"}
BROWSER_EXT = {".wav", ".mp3", ".ogg", ".flac"}          # aiff -> WAV'a çevrilip akıtılır
SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

KEY_RE = re.compile(r"^[A-G](?:#|b)?m?(?:-?\d{1,2})?$")                       # elle girilen key
TAG_RE = re.compile(r"\s*\[[A-G](?:#|b)?(?:m|-?\d{1,2})?\]$")                 # " [Am]" / " [F#1]"
LEGACY_HAS = re.compile(r"[_\-\s(][A-G](?:#|b)?(?:m|min|maj|minor|major)?-?\d?\)?$")
LEGACY_STRIP = re.compile(r"(?:^|[_\-\s(])([A-G](?:#|b)?(?:m|min|maj|minor|major)?-?\d?\)?)$", re.I)
LOG_FIELDS = ["id", "batch", "time", "op", "old_path", "new_path", "status", "error"]

DEFAULT_SETTINGS = {"recursive": False, "mode": "auto", "oneshot_max": 4.0, "min_key_corr": 0.60,
                    "min_key_margin": 0.025, "min_pitch_db": 25.0, "flats": False, "octave": False}
STATE = {"root": None, "records": [], "gen": 0, "settings": dict(DEFAULT_SETTINGS), "total_files": 0,
         "job": {"status": "idle", "total": 0, "processed": 0, "message": ""},
         "log_path": str(DATA_DIR / "islem_gunlugu.csv")}
CACHE = {}
LOCK = threading.RLock()
app = Flask(__name__, static_folder=str(APP_DIR / "static"), static_url_path="/static")


def clip(x, a, b):
    return max(a, min(b, x))


# =============================================================== dosya adı yardımcıları
def has_tag(stem):
    return bool(TAG_RE.search(stem) or LEGACY_HAS.search(stem))


def strip_tag(stem):
    s = TAG_RE.sub("", stem)
    if s != stem:
        return s or stem
    s = LEGACY_STRIP.sub("", stem)
    return re.sub(r"[_\-\s.]+$", "", s) or stem


def tagged_name(path, key, force):
    p = Path(path)
    base = strip_tag(p.stem) if force else p.stem
    return f"{base} [{key}]{p.suffix}"


# =============================================================== analiz
def parabolic(mag, i):
    if 0 < i < len(mag) - 1:
        a, b, c = (math.log(mag[j] + 1e-12) for j in (i - 1, i, i + 1))
        d = a - 2 * b + c
        if d != 0:
            return i + 0.5 * (a - c) / d
    return float(i)


def band_amp(mag, f, df):
    a, b = int(f * 0.97 / df), min(int(f * 1.03 / df) + 1, len(mag))
    return float(mag[a:b].max()) if b > a else 0.0


def closeness(cents):
    return max(0.0, 1 - abs(cents) / 100)


def count_hits(y, sr):
    """RMS zarfında kaç ayrı vuruş (en az +6 dB'lik yeniden yükseliş) var."""
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0]
    db = 20 * np.log10(rms + 1e-9)
    floor = db.max() - 30
    hits, in_hit, low, peak = 0, False, -120.0, -120.0
    for v in db:
        if in_hit:
            peak = max(peak, v)
            if v < peak - 6:
                in_hit, low = False, v
        else:
            low = min(low, v)
            if v > low + 6 and v > floor:
                hits, in_hit, peak = hits + 1, True, v
    return hits


def decide_mode(y, sr, mode, oneshot_max):
    """auto: eşikten kısa ve en fazla 2 vuruş -> pitch (tek nota); aksi halde key (tonalite)."""
    if mode in ("pitch", "key"):
        return mode
    dur = len(y) / sr
    if dur >= oneshot_max:
        return "key"
    return "pitch" if dur < 1.0 or count_hits(y, sr) <= 2 else "key"


def analyze_pitch(y, sr, fmin=25.0, fmax=2000.0):
    out = {"kind": "pitch", "freq": None, "conf_db": None, "cents": None, "cands": []}
    if len(y) < 512 or np.max(np.abs(y)) < 1e-4:
        return out
    peak = int(np.argmax(np.abs(y)))
    start = peak + int(0.05 * sr)                      # atak transient'ini atla
    if len(y) - start < int(0.1 * sr):
        start = peak
    seg = y[start:start + int(1.0 * sr)]
    if len(seg) < 512 or np.max(np.abs(seg)) < 1e-4:
        return out
    n = 1 << int(math.ceil(math.log2(len(seg) * 8)))
    mag = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n))
    df = sr / n
    lo, hi = int(math.ceil(fmin / df)), min(int(fmax / df), len(mag) - 1)
    m = mag[lo:hi + 1]
    i = int(np.argmax(m))
    conf_db = 20 * math.log10((float(m[i]) + 1e-12) / (float(np.median(m)) + 1e-12))
    f0 = (lo + parabolic(m, i)) * df
    for _ in range(2):                                 # oktav hatası düzeltmesi (808'lerde sık)
        sub = f0 / 2
        if sub < fmin:
            break
        a, b = int(sub * 0.97 / df), int(sub * 1.03 / df) + 1
        if b <= a:
            break
        j = a + int(np.argmax(mag[a:b]))
        if mag[j] > 0.5 * float(m[i]):
            f0 = parabolic(mag, j) * df
        else:
            break

    midi_f = 69 + 12 * math.log2(f0 / 440.0)
    m0 = int(round(midi_f))
    dev = (midi_f - m0) * 100
    raw_main = closeness(dev)                          # >= 0.5
    raw = {m0: raw_main}
    if abs(dev) >= 15:                                 # iki nota arasında: komşu nota da aday
        raw[m0 + (1 if dev > 0 else -1)] = closeness(100 - abs(dev))
    ref = max(band_amp(mag, f0, df), 1e-12)
    for off in (-12, 12):                              # oktav adayları (yalnızca spektrumda enerji varsa)
        fc = f0 * 2 ** (off / 12)
        if fmin <= fc <= fmax:
            rel = band_amp(mag, fc, df) / ref
            if rel >= 0.15:
                raw[m0 + off] = max(raw.get(m0 + off, 0), raw_main * min(rel, 1) * 0.7)
    lst = sorted(raw.items(), key=lambda kv: -kv[1])[:6]
    out.update(freq=round(f0, 2), conf_db=round(conf_db, 1), cents=round(dev, 1),
               cands=[{"midi": k, "score": round(min(1.0, v / raw_main), 3)} for k, v in lst])
    return out


def analyze_key(y, sr):
    out = {"kind": "key", "corr": None, "margin": None, "cands": [], "chroma": []}
    if sr > 22050:
        y = librosa.resample(y, orig_sr=sr, target_sr=22050)
        sr = 22050
    y = librosa.effects.harmonic(y)                    # davul/perküsyonu bastır
    if np.max(np.abs(y)) < 1e-4:
        return out
    c = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    if not np.all(np.isfinite(c)) or c.std() < 1e-6:
        return out
    rs = sorted(((float(np.corrcoef(c, np.roll(prof, t))[0, 1]), t, mode)
                 for t in range(12) for mode, prof in (("maj", MAJOR), ("min", MINOR))), reverse=True)
    out.update(corr=round(rs[0][0], 4), margin=round(rs[0][0] - rs[1][0], 4),
               cands=[{"tonic": t, "mode": md, "r": round(r, 4)} for r, t, md in rs],
               chroma=[round(float(v), 4) for v in c])
    return out


def analyze_file(path, mode, oneshot_max):
    try:
        try:
            y, sr = librosa.load(path, sr=None, mono=True, duration=30.0)
        except Exception as e:
            return {"error": f"Dosya okunamadı: {str(e)[:160]}"}
        if len(y) == 0:
            return {"error": "boş dosya"}
        kind = decide_mode(y, sr, mode, oneshot_max)
        out = analyze_pitch(y, sr) if kind == "pitch" else analyze_key(y, sr)
        out.update(dur=round(len(y) / sr, 3), sr=int(sr), auto=(mode == "auto"))
        return out
    except Exception as e:                      # beklenmeyen hata: konsola yaz, arayüzde "Hata" olarak göster
        traceback.print_exc()
        return {"error": f"Analiz hatası: {type(e).__name__}: {str(e)[:160]}"}


def warm_up():
    """librosa/numba ilk kullanımda derleme yapar (yavaş). Açılışta arka planda ısıtırız."""
    try:
        t = np.arange(22050 * 2) / 22050
        y = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        analyze_key(y, 22050)
        analyze_pitch(y, 22050)
        count_hits(y, 22050)
        print("Analiz motoru hazır.")
    except Exception:
        traceback.print_exc()


# =============================================================== görünüm (UI'nin beklediği biçim)
def build_analysis(r, s, names):
    kind = r["kind"]
    a = {"kind": kind, "tag": None, "status": "undetected", "message": "", "duration": r["dur"],
         "sample_rate": r["sr"], "mode": kind + (" (auto)" if r["auto"] else ""), "candidates": [],
         "note_candidates": [], "pitch_peak_db": None, "frequency_hz": None, "correlation": None,
         "margin": None, "tonic": None, "key_mode": None}
    if kind == "pitch":
        conf = r["conf_db"]
        a.update(pitch_peak_db=conf, frequency_hz=r["freq"])
        if conf is None or conf < s["min_pitch_db"]:
            conf_txt = "sinyal yok" if conf is None else f"tepe/medyan {conf:.0f} dB < {s['min_pitch_db']:.0f} dB"
            a["message"] = f"Belirgin bir temel frekans bulunamadı ({conf_txt}); dosya atonal olabilir."
            return a
        seen, cands, pcs = set(), [], []
        for c in r["cands"]:
            pc = c["midi"] % 12
            octave_txt = str(c["midi"] // 12 - 1)
            tag = names[pc] + (octave_txt if s["octave"] else "")
            if pc not in pcs:
                pcs.append(pc)
            if tag in seen:
                continue
            seen.add(tag)
            nominal = 440 * 2 ** ((c["midi"] - 69) / 12)
            cands.append({"tag": tag, "label": f"{names[pc]}{octave_txt} · {nominal:.1f} Hz", "score": c["score"]})
        dev = abs(r["cents"])
        a["status"] = ("high_confidence" if conf >= 40 and dev <= 20 else
                       "medium_confidence" if conf >= 30 and dev <= 35 else "low_confidence")
        a.update(tag=cands[0]["tag"], candidates=cands, note_candidates=[{"tag": SHARP[p]} for p in pcs],
                 message=f"Temel frekans {r['freq']:.1f} Hz; en yakın notaya {r['cents']:+.0f} cent."
                         + (" Nota iki yarım ton arasında veya oktav belirsiz olabilir." if a["status"] == "low_confidence" else ""))
        return a

    if not r["cands"]:
        a["message"] = "Tonal içerik bulunamadı (sessiz veya tamamen perküsif)."
        return a
    cands = [{"tag": names[c["tonic"]] + ("m" if c["mode"] == "min" else ""),
              "label": f"{names[c['tonic']]} {'minor' if c['mode'] == 'min' else 'major'}", "score": c["r"]}
             for c in r["cands"]]
    corr, margin = r["corr"], r["margin"]
    top = r["cands"][0]
    order = sorted(range(12), key=lambda i: -r["chroma"][i])
    a.update(correlation=corr, margin=margin, candidates=cands, note_candidates=[{"tag": SHARP[i]} for i in order],
             tonic=names[top["tonic"]], key_mode="minor" if top["mode"] == "min" else "major")
    if corr < s["min_key_corr"]:
        a["message"] = f"Korelasyon düşük ({corr:.2f} < {s['min_key_corr']:.2f}); tonal içerik zayıf. Adaylar yalnızca referans içindir."
        return a
    if margin < s["min_key_margin"] or corr < 0.7:
        a["status"] = "low_confidence"
        a["message"] = "İlk adaylar birbirine çok yakın veya korelasyon düşük; relative major/minor karışmış olabilir."
    elif corr >= 0.8 and margin >= 0.08:
        a["status"] = "high_confidence"
        a["message"] = f"En iyi aday {cands[0]['label']}; ikinci adayla belirgin fark var."
    else:
        a["status"] = "medium_confidence"
        a["message"] = f"En iyi aday {cands[0]['label']}; ikinci adayla fark orta düzeyde."
    a["tag"] = cands[0]["tag"]
    return a


def render(rec):
    s = STATE["settings"]
    names = FLAT if s["flats"] else SHARP
    p, r = rec["path"], rec["result"]
    out = {"id": rec["id"], "name": os.path.basename(p), "relative_path": os.path.relpath(p, STATE["root"]),
           "confirmed": rec["confirmed"], "renamed": rec["renamed"], "manual_key": rec["manual_key"],
           "audio_url": f"/api/audio/{rec['id']}", "error": None, "duration": None, "analysis": None}
    if r is None:
        out["status"] = "analyzing" if rec["busy"] else "queued"
    elif "error" in r:
        out.update(status="error", error=r["error"])
    else:
        a = build_analysis(r, s, names)
        out.update(status=a["status"], duration=r["dur"], analysis=a)
    return out


def summary(files):
    ana = [f for f in files if f["analysis"]]
    return {"total_files": STATE["total_files"], "audio_files": len(files), "analyzed": len(ana) + sum(f["status"] == "error" for f in files),
            "detected": sum(1 for f in ana if f["analysis"]["tag"]),
            "low_confidence": sum(1 for f in files if f["status"] in ("low_confidence", "undetected")),
            "confirmed": sum(1 for f in files if f["confirmed"]), "renamed": sum(1 for f in files if f["renamed"])}


# =============================================================== önbellek + tarama
def load_cache():
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CACHE.update(json.loads(CACHE_FILE.read_text(encoding="utf-8")))
    except Exception:
        pass


def save_cache():
    try:
        CACHE_FILE.write_text(json.dumps(CACHE), encoding="utf-8")
    except Exception:
        pass


def list_audio(root, recursive):
    files, total = [], 0
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if not d.startswith(".")] if recursive else []
        for fn in fns:
            total += 1
            if not fn.startswith(".") and Path(fn).suffix.lower() in AUDIO_EXT:
                files.append(os.path.join(dp, fn))
    return sorted(files, key=lambda p: p.lower()), total


def start_scan(root, settings):
    paths, total = list_audio(root, settings["recursive"])
    with LOCK:
        STATE["gen"] += 1
        gen = STATE["gen"]
        STATE.update(root=root, settings=settings, total_files=total,
                     records=[{"id": f"f{i}", "path": p, "result": None, "busy": False, "confirmed": False,
                               "renamed": False, "manual_key": None} for i, p in enumerate(paths)])
        STATE["job"] = {"status": "running" if paths else "completed", "total": len(paths), "processed": 0,
                        "message": (f"{len(paths)} ses dosyası analiz ediliyor. Uygulamanın ilk çalıştırılışında analiz motoru ısınır; "
                                "ilk sonuçlar 30-60 saniye gecikebilir.") if paths else "Ses dosyası bulunamadı."}
        records = list(STATE["records"])
    mode, mx = settings["mode"], float(settings["oneshot_max"])

    def work(rec):
        if STATE["gen"] != gen:
            return
        rec["busy"] = True
        try:
            key = None
            try:
                st = os.stat(rec["path"])
                key = f"{CACHE_VERSION}:{st.st_size}:{st.st_mtime_ns}:{mode}:{mx}"
            except OSError:
                pass
            res = CACHE.get(key) if key else None
            if res is None:
                res = analyze_file(rec["path"], mode, mx)
                if key and "error" not in res:
                    CACHE[key] = res
        except Exception as e:
            traceback.print_exc()
            res = {"error": f"Beklenmeyen hata: {type(e).__name__}: {str(e)[:160]}"}
        rec["result"], rec["busy"] = res, False
        if STATE["gen"] == gen:
            STATE["job"]["processed"] += 1
            STATE["job"]["message"] = f"{STATE['job']['processed']} / {STATE['job']['total']} dosya işlendi."

    def run():
        try:
            with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
                list(ex.map(work, records))
        except Exception:
            traceback.print_exc()
        if STATE["gen"] == gen:
            STATE["job"]["status"] = "completed"
            STATE["job"]["message"] = f"{STATE['job']['processed']} / {STATE['job']['total']} dosya analiz edildi."
            save_cache()

    if records:
        threading.Thread(target=run, daemon=True).start()
    return len(paths), total


def get_record(fid):
    for r in STATE["records"]:
        if r["id"] == fid:
            return r
    abort(404, "Dosya bulunamadı.")


# =============================================================== günlük
def log_read():
    p = Path(STATE["log_path"])
    if not p.exists():
        return []
    with open(p, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def log_append(entries):
    if not entries:
        return
    p = Path(STATE["log_path"])
    p.parent.mkdir(parents=True, exist_ok=True)
    new = not p.exists() or p.stat().st_size == 0
    with open(p, "a", newline="", encoding="utf-8-sig" if new else "utf-8") as f:
        w = csv.DictWriter(f, fieldnames=LOG_FIELDS)
        if new:
            w.writeheader()
        w.writerows(entries)


def log_rewrite(rows):
    p = Path(STATE["log_path"])
    tmp = p.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=LOG_FIELDS)
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, p)


def log_entry(batch, old, new, status, err=""):
    return {"id": uuid.uuid4().hex[:10], "batch": batch, "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "op": "rename", "old_path": old, "new_path": new, "status": status, "error": err}


def new_batch():
    return time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]


# =============================================================== yeniden adlandırma
class RenameError(Exception):
    pass


def rename_record(rec, force):
    """Tek dosyayı yeniden adlandırır; hedef varsa asla üzerine yazmaz. Yeni yolu döndürür."""
    if rec["renamed"]:
        raise RenameError("Dosya zaten yeniden adlandırılmış.")
    if not rec["confirmed"] or not rec["manual_key"]:
        raise RenameError("Önce key etiketini onayla.")
    old = Path(rec["path"])
    if not old.exists():
        raise RenameError("Dosya artık yerinde değil.")
    if has_tag(old.stem) and not force:
        raise RenameError("Dosya adında zaten bir key etiketi var; değiştirmek için "
                          "“Var olan key etiketini değiştir” seçeneğini işaretle.")
    new = old.with_name(tagged_name(old, rec["manual_key"], force))
    if new == old:
        raise RenameError("Dosya zaten bu adı taşıyor.")
    if new.exists():
        raise RenameError("Hedef dosya zaten var; üzerine yazılmaz.")
    os.rename(old, new)
    rec["path"], rec["renamed"] = str(new), True
    return str(old), str(new)


# =============================================================== HTTP
@app.before_request
def guard():
    if (request.host or "").split(":")[0] not in ("127.0.0.1", "localhost"):
        abort(403)
    if request.method not in ("GET", "HEAD", "OPTIONS") and not request.is_json:
        abort(400, "JSON gövdesi gerekli.")


@app.errorhandler(Exception)
def on_error(e):
    code = getattr(e, "code", None)
    code = code if isinstance(code, int) else 500
    return jsonify(detail=str(getattr(e, "description", e))), code


@app.get("/")
def index():
    return send_from_directory(APP_DIR, "index.html")


@app.get("/api/state")
def api_state():
    files = [render(r) for r in STATE["records"]] if STATE["root"] else []
    return jsonify(root=STATE["root"], recursive=STATE["settings"]["recursive"], job=STATE["job"],
                   summary=summary(files), files=files)


@app.post("/api/scan")
def api_scan():
    d = request.get_json() or {}
    folder = os.path.abspath(os.path.expanduser(str(d.get("folder", "")).strip()))
    if not os.path.isdir(folder):
        abort(400, "Klasör bulunamadı: " + folder)
    s = dict(DEFAULT_SETTINGS)
    s["recursive"] = bool(d.get("recursive"))
    s["mode"] = d.get("mode") if d.get("mode") in ("auto", "pitch", "key") else "auto"
    for k, lo, hi in (("oneshot_max", 0.1, 60), ("min_key_corr", -1, 1), ("min_key_margin", 0, 1), ("min_pitch_db", 0, 120)):
        try:
            s[k] = clip(float(d.get(k, DEFAULT_SETTINGS[k])), lo, hi)
        except (TypeError, ValueError):
            pass
    s["flats"], s["octave"] = bool(d.get("flats")), bool(d.get("octave"))
    audio, total = start_scan(folder, s)
    return jsonify(audio_files=audio, total_files=total)


@app.post("/api/browse-folder")
def api_browse_folder():
    init = (request.get_json() or {}).get("initial_folder") or ""
    init = init if os.path.isdir(init) else str(Path.home())
    code = ("import sys, tkinter as tk\nfrom tkinter import filedialog\nr = tk.Tk(); r.withdraw()\n"
            "r.attributes('-topmost', True)\n"
            "print(filedialog.askdirectory(initialdir=sys.argv[1], title='Sample klasörünü seç') or '')")
    try:
        out = subprocess.run([sys.executable, "-c", code, init], capture_output=True, timeout=900,
                             env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    except Exception as e:
        abort(500, f"Klasör seçici başlatılamadı: {e}")
    if out.returncode != 0:
        abort(501, "Klasör seçici açılamadı (tkinter/ekran yok). Klasör yolunu elle yaz.")
    folder = out.stdout.decode("utf-8", "replace").strip()
    return jsonify(folder=folder or None)


@app.get("/api/audio/<fid>")
def api_audio(fid):
    p = get_record(fid)["path"]
    if not os.path.exists(p):
        abort(404, "Dosya bulunamadı.")
    if Path(p).suffix.lower() in BROWSER_EXT:
        return send_file(p, conditional=True)
    data, sr = sf.read(p, always_2d=True)
    buf = io.BytesIO()
    sf.write(buf, data, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return send_file(buf, mimetype="audio/wav")


@app.patch("/api/files/<fid>/review")
def api_review(fid):
    d = request.get_json() or {}
    rec = get_record(fid)
    key = str(d.get("key", "")).strip()
    if not KEY_RE.match(key):
        abort(400, "Key biçimi tanınmadı. Ör. D, Dm, F# veya F#1 kullan.")
    if rec["result"] is None or "error" in (rec["result"] or {}):
        abort(409, "Bu dosya henüz analiz edilmedi veya okunamadı.")
    rec["manual_key"], rec["confirmed"] = key, bool(d.get("confirmed", True))
    if rec["renamed"] and not rec["confirmed"]:
        rec["renamed"] = False
    return jsonify(ok=True)


@app.post("/api/files/<fid>/rename")
def api_rename(fid):
    force = bool((request.get_json() or {}).get("force"))
    rec = get_record(fid)
    batch = new_batch()
    with LOCK:
        try:
            old, new = rename_record(rec, force)
        except RenameError as e:
            abort(409, str(e))
        except OSError as e:
            log_append([log_entry(batch, rec["path"], rec["path"], "failed", str(e))])
            abort(500, f"Yeniden adlandırılamadı: {e}")
        log_append([log_entry(batch, old, new, "ok")])
    return jsonify(old=old, new=new)


@app.post("/api/rename/bulk")
def api_rename_bulk():
    force = bool((request.get_json() or {}).get("force"))
    batch, entries, skipped, done = new_batch(), [], [], 0
    with LOCK:
        for rec in STATE["records"]:
            if not (rec["confirmed"] and rec["manual_key"]) or rec["renamed"]:
                continue
            name = os.path.basename(rec["path"])
            try:
                old, new = rename_record(rec, force)
                entries.append(log_entry(batch, old, new, "ok"))
                done += 1
            except (RenameError, OSError) as e:
                skipped.append({"name": name, "reason": str(e)})
                if isinstance(e, OSError):
                    entries.append(log_entry(batch, rec["path"], rec["path"], "failed", str(e)))
        log_append(entries)
    return jsonify(count=done, skipped=skipped, batch=batch)


@app.post("/api/undo")
def api_undo():
    """En son başarılı toplu/tekil adlandırma işlemini geri alır (her tıklama bir işlem geri gider)."""
    with LOCK:
        rows = log_read()
        batch = next((r["batch"] for r in reversed(rows) if r["status"] == "ok"), None)
        if not batch:
            return jsonify(count=0, skipped=[])
        by_path = {r["path"]: r for r in STATE["records"]}
        undone, skipped = 0, []
        for r in reversed(rows):
            if r["batch"] != batch or r["status"] != "ok":
                continue
            src, dst = r["new_path"], r["old_path"]
            if not os.path.exists(src):
                skipped.append({"name": os.path.basename(src), "reason": "dosya bulunamadı"})
            elif os.path.exists(dst):
                skipped.append({"name": os.path.basename(dst), "reason": "eski ad dolu"})
            else:
                try:
                    shutil.move(src, dst)
                except OSError as e:
                    skipped.append({"name": os.path.basename(src), "reason": str(e)})
                    continue
                r["status"] = "undone"
                undone += 1
                rec = by_path.get(src)
                if rec:
                    rec["path"], rec["renamed"] = dst, False
        if undone:
            log_rewrite(rows)
        # geri alınamayan kayıtlar "ok" kalır; aynı işlem tekrar denenebilir
    return jsonify(count=undone, skipped=skipped)


def main():
    ap = argparse.ArgumentParser(description="Sample Key Reviewer")
    ap.add_argument("folder", nargs="?", help="Açılışta taranacak klasör (isteğe bağlı)")
    ap.add_argument("--port", type=int, default=5173)
    ap.add_argument("--log", help="İşlem günlüğü CSV yolu (varsayılan: ~/.key_renamer/islem_gunlugu.csv)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    load_cache()
    print("Analiz motoru ısınıyor (ilk açılışta 20-60 sn sürebilir)...")
    threading.Thread(target=warm_up, daemon=True).start()
    if args.log:
        STATE["log_path"] = str(Path(args.log).expanduser())
    if args.folder and os.path.isdir(args.folder):
        start_scan(os.path.abspath(args.folder), dict(DEFAULT_SETTINGS))
    url = f"http://127.0.0.1:{args.port}"
    print(f"Sample Key Reviewer: {url}   (durdurmak için Ctrl+C)\nİşlem günlüğü: {STATE['log_path']}")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=args.port, threaded=True)


if __name__ == "__main__":
    main()
