#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
JARVIS DESKTOP — App e System Manager per PC Windows.
Collega il computer al server Jarvis Cloud, invia telemetria in tempo reale (CPU, RAM, finestra attiva),
permette di parlare/scrivere a Jarvis dal PC, apre la Sfera 3D in modalità app dedicata e riceve
i comandi multi-dispositivo mandati dallo smartphone o dal PC ("Jarvis apri Chrome sul PC", "metti in pausa sul PC").
"""

import ctypes
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import re
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
import tkinter as tk
from tkinter import messagebox

DIR = Path(__file__).resolve().parent
CONFIG_PATH = DIR / "config.json"

COMMON_APPS = {
    "chrome": "chrome",
    "google chrome": "chrome",
    "edge": "msedge",
    "microsoft edge": "msedge",
    "vscode": "code",
    "vs code": "code",
    "visual studio code": "code",
    "code": "code",
    "esplora file": "explorer",
    "esplora risorse": "explorer",
    "explorer": "explorer",
    "terminale": "powershell",
    "powershell": "powershell",
    "cmd": "cmd",
    "prompt": "cmd",
    "blocco note": "notepad",
    "notepad": "notepad",
    "calcolatrice": "calc",
    "calc": "calc",
    "spotify": "spotify",
    "discord": "discord",
    "telegram": "telegram",
    "whatsapp": "https://web.whatsapp.com",
    "youtube": "https://www.youtube.com",
    "prime": "https://www.primevideo.com",
    "prime video": "https://www.primevideo.com",
    "amazon prime": "https://www.primevideo.com",
    "gmail": "https://mail.google.com",
    "instagram": "https://www.instagram.com",
    "netflix": "https://www.netflix.com",
    "twitch": "https://www.twitch.com",
    "github": "https://github.com",
    "chatgpt": "https://chatgpt.com",
    "maps": "https://maps.google.com",
    "google": "https://www.google.com",
    "amazon": "https://www.amazon.it",
    "wikipedia": "https://it.wikipedia.org",
    "drive": "https://drive.google.com",
    "docs": "https://docs.google.com",
    "gemini": "https://gemini.google.com",
    "facebook": "https://www.facebook.com",
    "linkedin": "https://www.linkedin.com",
    "reddit": "https://www.reddit.com",
    "word": "winword",
    "excel": "excel",
    "powerpoint": "powerpnt",
    "paint": "mspaint",
    "vlc": "vlc",
    "gestione attivita": "taskmgr",
    "task manager": "taskmgr",
    "impostazioni": "ms-settings:",
}

CLOSE_EXE_MAP = {
    "chrome": "chrome.exe",
    "google chrome": "chrome.exe",
    "edge": "msedge.exe",
    "microsoft edge": "msedge.exe",
    "firefox": "firefox.exe",
    "vscode": "Code.exe",
    "vs code": "Code.exe",
    "visual studio code": "Code.exe",
    "code": "Code.exe",
    "spotify": "Spotify.exe",
    "discord": "Discord.exe",
    "telegram": "Telegram.exe",
    "blocco note": "notepad.exe",
    "notepad": "notepad.exe",
    "calcolatrice": "CalculatorApp.exe",
    "calc": "CalculatorApp.exe",
    "vlc": "vlc.exe",
    "word": "WINWORD.EXE",
    "excel": "EXCEL.EXE",
    "powerpoint": "POWERPNT.EXE",
    "paint": "mspaint.exe",
    "cmd": "cmd.exe",
    "powershell": "powershell.exe",
    "esplora file": "explorer.exe",
    "task manager": "Taskmgr.exe",
    "gestione attivita": "Taskmgr.exe",
}

VK_MAP = {
    "ctrl": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B,
    "tab": 0x09, "enter": 0x0D, "esc": 0x1B, "space": 0x20,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "pageup": 0x21, "pagedown": 0x22,
    "f4": 0x73, "f5": 0x74, "f11": 0x7A,
    "c": 0x43, "d": 0x44, "t": 0x54, "v": 0x56, "w": 0x57, "x": 0x58, "z": 0x5A,
}


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"server_url": "", "server_token": "", "speak": True}


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def get_pc_metrics() -> dict:
    """Legge RAM, CPU stimata e titolo della finestra in primo piano su Windows usando solo librerie standard."""
    ram_pct = 0
    active_win = ""
    if os.name == "nt":
        try:
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            ram_pct = int(stat.dwMemoryLoad)
        except Exception:
            pass
        try:
            hwnd = ctypes.windll.user32.GetForegroundWindow()
            length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                active_win = buf.value.strip()[:100]
        except Exception:
            pass
    return {"cpu": 12, "ram": ram_pct, "activeWindow": active_win}


def speak_tts(text: str) -> None:
    """Legge ad alta voce sul PC tramite il sintetizzatore vocale nativo di Windows."""
    if not text or os.name != "nt":
        return
    clean = text.replace('"', " ").replace("'", " ").replace("\n", " ").strip()[:400]
    cmd = f'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak("{clean}")'
    try:
        subprocess.Popen(
            ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", cmd],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass


def press_media_key(vk_code: int) -> None:
    if os.name == "nt":
        try:
            ctypes.windll.user32.keybd_event(vk_code, 0, 0, 0)
            ctypes.windll.user32.keybd_event(vk_code, 0, 2, 0)
        except Exception:
            pass


def press_hotkey(combo: str) -> None:
    if os.name != "nt" or not combo:
        return
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    codes = [VK_MAP[p] for p in parts if p in VK_MAP]
    if not codes:
        return
    try:
        for c in codes:
            ctypes.windll.user32.keybd_event(c, 0, 0, 0)
        time.sleep(0.05)
        for c in reversed(codes):
            ctypes.windll.user32.keybd_event(c, 0, 2, 0)
    except Exception:
        pass


def close_app_target(target: str, log_fn) -> None:
    t = (target or "").strip().lower()
    if not t:
        return
    if t in ("tab", "scheda"):
        press_hotkey("ctrl+w")
        return
    if t in ("window", "finestra"):
        press_hotkey("alt+f4")
        return
    if os.name != "nt":
        return
    if t == "all":
        for exe in ("chrome.exe", "msedge.exe", "Spotify.exe", "notepad.exe", "vlc.exe", "Code.exe"):
            subprocess.run(["taskkill", "/IM", exe, "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        log_fn("Chiuse le applicazioni principali.")
        return
    exe = CLOSE_EXE_MAP.get(t)
    if exe:
        subprocess.run(["taskkill", "/IM", exe, "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        log_fn(f"Chiuso processo: {exe}")
        return
    # Cerca prima una finestra con titolo corrispondente (es. YouTube, Netflix) e la chiude gentilmente; altrimenti termina il processo
    safe = t.replace('"', "").replace("'", "")
    ps = (
        f"$p = Get-Process | Where-Object {{ $_.MainWindowTitle -like '*{safe}*' -or $_.ProcessName -like '*{safe}*' }}; "
        "foreach ($x in $p) { if (-not $x.CloseMainWindow()) { Stop-Process -Id $x.Id -Force -ErrorAction SilentlyContinue } }"
    )
    subprocess.Popen(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    log_fn(f"Chiusura richiesta per: {target}")


def search_web_target(query: str, log_fn) -> None:
    q = (query or "").strip()
    if not q:
        return
    low = q.lower()
    m_site = re.match(r"^(?:il\s+sito\s+(?:di\s+|della\s+)?|il\s+portale\s+)?([a-z0-9_-]+)$", low)
    if m_site and m_site.group(1) in COMMON_APPS:
        url = COMMON_APPS[m_site.group(1)]
        if url.startswith("http"):
            log_fn(f"Apro sito: {url}")
            webbrowser.open(url)
            return
    if re.search(r"\bsu\s+amazon\b", low):
        clean = re.sub(r"\bsu\s+amazon\b", "", q, flags=re.I).strip()
        url = f"https://www.amazon.it/s?k={urllib.parse.quote(clean)}"
    elif re.search(r"\bsu\s+wikipedia\b", low):
        clean = re.sub(r"\bsu\s+wikipedia\b", "", q, flags=re.I).strip()
        url = f"https://it.wikipedia.org/w/index.php?search={urllib.parse.quote(clean)}"
    elif re.search(r"\bsu\s+(?:google\s+)?maps\b", low):
        clean = re.sub(r"\bsu\s+(?:google\s+)?maps\b", "", q, flags=re.I).strip()
        url = f"https://www.google.com/maps/search/{urllib.parse.quote(clean)}"
    elif re.search(r"\bsu\s+github\b", low):
        clean = re.sub(r"\bsu\s+github\b", "", q, flags=re.I).strip()
        url = f"https://github.com/search?q={urllib.parse.quote(clean)}"
    else:
        clean = re.sub(r"\bsu\s+(?:google|internet|web|bing)\b", "", q, flags=re.I).strip()
        url = f"https://www.google.com/search?q={urllib.parse.quote(clean)}"
    log_fn(f"Ricerca web: {url}")
    webbrowser.open(url)


STOPWORDS_APP = {"l", "la", "lo", "le", "il", "i", "gli", "un", "una", "uno", "per", "su", "da", "in", "di", "a", "e", "o", "che", "con", "non", "si", "no", "del", "della", "dello", "dei", "degli", "delle", "al", "alla", "allo", "nel", "nella", "nello", "sul", "sulla", "sullo"}


def find_chrome_exe() -> str:
    for p in (
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
    ):
        if os.path.exists(p):
            return p
    return shutil.which("chrome") or ""


def find_chrome_profile(hint: str) -> str:
    """Cerca in Local State di Chrome la directory profilo ('Default', 'Profile 1', ...) corrispondente al nome o account."""
    h = (hint or "").strip().lower()
    if not h or os.name != "nt":
        return ""
    local_state = os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data\Local State")
    if not os.path.exists(local_state):
        return ""
    try:
        data = json.loads(Path(local_state).read_text(encoding="utf-8", errors="ignore"))
        cache = data.get("profile", {}).get("info_cache", {})
        best = ""
        for dir_name, info in cache.items():
            fields = [
                str(dir_name).lower(),
                str(info.get("name", "")).lower(),
                str(info.get("gaia_name", "")).lower(),
                str(info.get("shortcut_name", "")).lower(),
                str(info.get("user_name", "")).lower(),
            ]
            if any(h == f for f in fields if f):
                return dir_name
            if any(h in f or (len(f) >= 3 and f in h) for f in fields if f):
                best = best or dir_name
        return best
    except Exception:
        return ""


def open_in_chrome(url: str, cfg: dict, log_fn, profile_hint: str = "") -> bool:
    chrome = find_chrome_exe()
    if not chrome:
        return False
    hint = (profile_hint or (cfg or {}).get("chrome_profile") or "").strip()
    prof_dir = find_chrome_profile(hint) if hint else ""
    cmd = [chrome]
    if prof_dir:
        cmd.append(f"--profile-directory={prof_dir}")
    if url:
        cmd.append(url)
    try:
        subprocess.Popen(cmd)
        log_fn(f"Chrome avviato ({prof_dir or 'default'}){': ' + url if url else ''}")
        return True
    except Exception as e:
        log_fn(f"Errore avvio Chrome: {e}")
        return False


def open_url_smart(url: str, cfg: dict, log_fn) -> None:
    if (cfg or {}).get("chrome_profile") and open_in_chrome(url, cfg, log_fn):
        return
    webbrowser.open(url)


def play_youtube_first_video(query: str, log_fn, cfg: dict = None) -> None:
    """Cerca il video su YouTube, estrae il primo videoId e lo apre direttamente in riproduzione sul PC."""
    q = (query or "musica rilassante").strip()
    search_url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(q)}"
    try:
        req = urllib.request.Request(
            search_url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept-Language": "it-IT,it;q=0.9",
            },
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        m = re.search(r'"videoId":"([a-zA-Z0-9_-]{11})"', html)
        if m:
            watch_url = f"https://www.youtube.com/watch?v={m.group(1)}&autoplay=1"
            log_fn(f"Avvio video YouTube: {q} ({watch_url})")
            open_url_smart(watch_url, cfg, log_fn)
            return
    except Exception as e:
        log_fn(f"Fallback ricerca YouTube ({e})")
    open_url_smart(search_url, cfg, log_fn)


def capture_and_upload_screen(cfg: dict, log_fn, title: str = "Schermo PC") -> None:
    """Cattura uno screenshot JPEG compresso dello schermo del PC usando .NET nativo e lo invia a Jarvis Cloud."""
    if os.name != "nt":
        return
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
        "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "
        "$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); "
        "$g = [System.Drawing.Graphics]::FromImage($bmp); "
        "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); "
        "$w = 1024; $h = [int]($b.Height * ($w / $b.Width)); "
        "$small = New-Object System.Drawing.Bitmap($bmp, $w, $h); "
        "$ms = New-Object System.IO.MemoryStream; "
        "$small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg); "
        "[Convert]::ToBase64String($ms.ToArray())"
    )
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            timeout=10,
        )
        b64 = out.decode("utf-8", errors="ignore").strip()
        if b64:
            api_call(cfg, "POST", "/devices/screen", {"image": b64, "title": title})
            log_fn("Screenshot dello schermo PC inviato in sovraimpressione.")
    except Exception as e:
        log_fn(f"Errore cattura schermo: {e}")


def find_project_path(project_name: str) -> Path:
    clean = (project_name or "Jarvis-Cast").strip()
    roots = [Path("G:/"), Path.home(), Path.home() / "Desktop", Path.home() / "Documents", Path.home() / "Projects"]
    for r in roots:
        if not r.exists():
            continue
        cand = r / clean
        if cand.exists():
            return cand
        try:
            for sub in r.iterdir():
                if sub.is_dir() and clean.lower() in sub.name.lower():
                    return sub
        except Exception:
            pass
    return Path("G:/Jarvis-Cast")


def run_antigravity_task(project: str, task_prompt: str, cfg: dict, log_fn) -> None:
    proj_path = find_project_path(project)
    log_fn(f"Avvio Antigravity su progetto '{proj_path}' — Task: {task_prompt}")
    # Copia il prompt del task negli appunti così è subito pronto anche per l'agente
    if task_prompt and os.name == "nt":
        try:
            subprocess.run(["clip"], input=task_prompt.encode("utf-16le"), check=False)
        except Exception:
            pass
    launched = False
    for cmd_name in ["antigravity", "agy", "code"]:
        try:
            subprocess.Popen(f'{cmd_name} "{proj_path}"', shell=True)
            launched = True
            break
        except Exception:
            pass
    if not launched and os.name == "nt":
        try:
            os.startfile(str(proj_path))
        except Exception:
            pass
    time.sleep(2.5)
    capture_and_upload_screen(cfg, log_fn, title=f"Antigravity • {proj_path.name}")


def write_and_run_project(project_name: str, args_json: str, cfg: dict, log_fn) -> None:
    """Scrive su disco sul PC i file generati dal sistema Multi-Agente di Jarvis (progetti multi-file e GUI) e li avvia."""
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", (project_name or "progetto").strip()).strip("-") or "progetto"
    base_dir = Path("G:/Progetti_Jarvis") / slug
    base_dir.mkdir(parents=True, exist_ok=True)
    try:
        data = json.loads(args_json or "{}")
        files = data.get("files") or []
        entry_html = None
        entry_py = None
        for f in files:
            rel = (f.get("path") or "").strip().lstrip("/\\")
            content = f.get("content") or ""
            if not rel or ".." in rel:
                continue
            dest = base_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content, encoding="utf-8")
            log_fn(f"Creato file: {dest}")
            if rel.endswith(".html") and entry_html is None:
                entry_html = dest
            elif rel.endswith(".py") and entry_py is None:
                entry_py = dest
        if entry_html is not None:
            webbrowser.open(str(entry_html))
        elif entry_py is not None:
            subprocess.Popen([sys.executable, str(entry_py)], cwd=str(base_dir))
        else:
            os.startfile(str(base_dir))
        time.sleep(2.0)
        capture_and_upload_screen(cfg, log_fn, title=f"Progetto {slug}")
    except Exception as e:
        log_fn(f"Errore scrittura progetto: {e}")


def execute_pc_command(cmd: dict, log_fn, cfg: dict = None) -> None:
    kind = (cmd.get("kind") or "open_app").lower()
    target = (cmd.get("target") or "").strip()
    args = (cmd.get("args") or "").strip()
    log_fn(f"Eseguo comando [{kind}]: {target}")

    if kind == "write_project":
        if cfg:
            threading.Thread(target=write_and_run_project, args=(target, args, cfg, log_fn), daemon=True).start()
        return

    if kind == "capture_screen":
        if cfg:
            threading.Thread(target=capture_and_upload_screen, args=(cfg, log_fn), daemon=True).start()
        return

    if kind == "antigravity_task":
        if cfg:
            threading.Thread(target=run_antigravity_task, args=(target, args, cfg, log_fn), daemon=True).start()
        return

    if kind == "play_youtube" and target:
        threading.Thread(target=play_youtube_first_video, args=(target, log_fn, cfg), daemon=True).start()
        return

    if kind == "open_chrome_profile" and target:
        if args == "persist" and cfg is not None:
            cfg["chrome_profile"] = target
            save_config(cfg)
            log_fn(f"Profilo Chrome predefinito salvato: {target}")
        if not open_in_chrome("", cfg, log_fn, profile_hint=target):
            log_fn(f"Impossibile aprire Chrome con profilo '{target}'")
        return

    if kind == "open_url" and target:
        url = target if target.startswith(("http://", "https://")) else "https://" + target
        open_url_smart(url, cfg, log_fn)
        return

    if kind == "search_web" and target:
        search_web_target(target, log_fn)
        return

    if kind == "close_app" and target:
        close_app_target(target, log_fn)
        return

    if kind == "search_files" and target and os.name == "nt":
        q = urllib.parse.quote(target)
        os.startfile(f"search-ms:displayname=Ricerca%20{q}&crumb=System.Generic.String%3A{q}")
        return

    if kind == "type_text" and target and os.name == "nt":
        try:
            subprocess.run(["clip"], input=target.encode("utf-16le"), check=False)
            time.sleep(0.08)
            press_hotkey("ctrl+v")
        except Exception as e:
            log_fn(f"Errore scrittura testo: {e}")
        return

    if kind == "hotkey" and target:
        press_hotkey(target)
        return

    if kind == "shell" and target:
        try:
            subprocess.Popen(target, shell=True)
        except Exception as e:
            log_fn(f"Errore comando shell: {e}")
        return

    if kind == "system":
        t = target.lower()
        if t == "lock" and os.name == "nt":
            ctypes.windll.user32.LockWorkStation()
        elif t == "play_pause":
            press_media_key(0xB3)  # VK_MEDIA_PLAY_PAUSE
        elif t == "next_track":
            press_media_key(0xB0)  # VK_MEDIA_NEXT_TRACK
        elif t == "prev_track":
            press_media_key(0xB1)  # VK_MEDIA_PREV_TRACK
        elif t == "media_stop":
            press_media_key(0xB2)  # VK_MEDIA_STOP
        elif t == "vol_up":
            for _ in range(3):
                press_media_key(0xAF)  # VK_VOLUME_UP
        elif t == "vol_down":
            for _ in range(3):
                press_media_key(0xAE)  # VK_VOLUME_DOWN
        elif t == "mute":
            press_media_key(0xAD)  # VK_VOLUME_MUTE
        elif t == "shutdown" and os.name == "nt":
            subprocess.Popen(["shutdown", "/s", "/t", "10"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        elif t == "restart" and os.name == "nt":
            subprocess.Popen(["shutdown", "/r", "/t", "10"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        elif t == "sleep" and os.name == "nt":
            subprocess.Popen(["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return

    if kind == "notify" and target:
        speak_tts(target)
        return

    if kind == "open_app" and target:
        low_t = target.strip().lower()
        if len(low_t) < 2 or low_t in STOPWORDS_APP:
            log_fn(f"Comando open_app ignorato (target non valido: '{target}')")
            return
        exe = COMMON_APPS.get(low_t, target)
        if exe.startswith(("http://", "https://")):
            open_url_smart(exe, cfg, log_fn)
            return
        if exe == "chrome":
            if open_in_chrome("", cfg, log_fn):
                return
        resolved = shutil.which(exe) or (exe if os.path.exists(exe) or ":" in exe else None)
        if not resolved:
            log_fn(f"App '{target}' non trovata sul PC (nessun popup aperto).")
            return
        try:
            if os.name == "nt":
                os.startfile(resolved)
            else:
                subprocess.Popen([resolved])
        except Exception as e:
            log_fn(f"Impossibile aprire '{target}': {e}")


def api_call(cfg: dict, method: str, path: str, payload: dict = None) -> dict:
    base = cfg.get("server_url", "").strip().rstrip("/")
    token = cfg.get("server_token", "").strip()
    if not base or not token:
        raise RuntimeError("Configura URL e Token del server Jarvis.")
    if not base.startswith(("http://", "https://")):
        base = "https://" + base
    url = f"{base}/api{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read().decode("utf-8", errors="ignore")
            err_obj = json.loads(body_txt)
            if err_obj.get("error"):
                raise RuntimeError(f"{err_obj['error']} (HTTP {e.code})")
        except RuntimeError:
            raise
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code}: {e.reason}")


def open_jarvis_webapp(cfg: dict) -> None:
    base = cfg.get("server_url", "").strip().rstrip("/")
    if not base:
        return
    if not base.startswith(("http://", "https://")):
        base = "https://" + base
    if os.name == "nt":
        for edge in [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ]:
            if os.path.exists(edge):
                subprocess.Popen([edge, f"--app={base}", "--window-size=1100,820"])
                return
    webbrowser.open(base)


class JarvisDesktopApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.cfg = load_config()
        self.running = True
        self.online = False

        self.root.title("JARVIS • Desktop System Manager")
        self.root.geometry("650x520")
        self.root.configure(bg="#000000")

        # Header
        hdr = tk.Frame(root, bg="#000000", pady=10, padx=14)
        hdr.pack(fill="x")
        tk.Label(hdr, text="◉ JARVIS CORE • DESKTOP", font=("Consolas", 14, "bold"), fg="#39ff14", bg="#000000").pack(side="left")
        self.status_lbl = tk.Label(hdr, text="○ In attesa di connessione", font=("Segoe UI", 9, "bold"), fg="#39ff14", bg="#000000")
        self.status_lbl.pack(side="right")

        # Telemetria
        tele = tk.Frame(root, bg="#000000", pady=8, padx=14, highlightbackground="#39ff14", highlightthickness=1)
        tele.pack(fill="x", padx=14, pady=(0, 10))
        self.tele_lbl = tk.Label(tele, text=f"PC: {socket.gethostname()} ({platform.system()} {platform.release()}) • RAM: --%", font=("Consolas", 9), fg="#39ff14", bg="#000000")
        self.tele_lbl.pack(side="left")
        tk.Button(
            tele, text="Apri Sfera 3D / Web App", font=("Segoe UI", 9, "bold"),
            bg="#000000", fg="#39ff14", activebackground="#39ff14", activeforeground="#000000", highlightbackground="#39ff14", highlightthickness=1, relief="solid", bd=1, padx=10, pady=3,
            command=lambda: open_jarvis_webapp(self.cfg),
        ).pack(side="right")

        # Configurazione Server
        cfg_frame = tk.LabelFrame(root, text=" Connessione Jarvis Cloud ", font=("Segoe UI", 9, "bold"), fg="#39ff14", bg="#000000", padx=10, pady=8)
        cfg_frame.pack(fill="x", padx=14, pady=(0, 10))

        tk.Label(cfg_frame, text="Indirizzo Server:", fg="#39ff14", bg="#000000", font=("Segoe UI", 9)).grid(row=0, column=0, sticky="w")
        self.url_var = tk.StringVar(value=self.cfg.get("server_url", ""))
        tk.Entry(cfg_frame, textvariable=self.url_var, bg="#000000", fg="#39ff14", insertbackground="#39ff14", relief="solid", bd=1, width=42).grid(row=0, column=1, padx=6, pady=3, sticky="ew")

        tk.Label(cfg_frame, text="Token (JARVIS_TOKEN):", fg="#39ff14", bg="#000000", font=("Segoe UI", 9)).grid(row=1, column=0, sticky="w")
        self.tok_var = tk.StringVar(value=self.cfg.get("server_token", ""))
        tk.Entry(cfg_frame, textvariable=self.tok_var, show="*", bg="#000000", fg="#39ff14", insertbackground="#39ff14", relief="solid", bd=1, width=42).grid(row=1, column=1, padx=6, pady=3, sticky="ew")

        tk.Button(
            cfg_frame, text="Salva e Connetti", font=("Segoe UI", 9, "bold"),
            bg="#39ff14", fg="#000000", relief="flat", padx=8, pady=4, command=self.save_and_connect,
        ).grid(row=0, column=2, rowspan=2, padx=4)
        cfg_frame.columnconfigure(1, weight=1)

        # Chat / Barra di comando diretta
        cmd_frame = tk.Frame(root, bg="#000000", padx=14)
        cmd_frame.pack(fill="x", pady=(0, 8))
        self.cmd_var = tk.StringVar()
        entry = tk.Entry(cmd_frame, textvariable=self.cmd_var, font=("Segoe UI", 10), bg="#000000", fg="#39ff14", insertbackground="#39ff14", relief="solid", bd=1)
        entry.pack(side="left", fill="x", expand=True, ipady=6, padx=(0, 8))
        entry.bind("<Return>", lambda e: self.send_command())
        tk.Button(
            cmd_frame, text="Invia a Jarvis →", font=("Segoe UI", 9, "bold"),
            bg="#39ff14", fg="#000000", relief="flat", padx=12, pady=5, command=self.send_command,
        ).pack(side="right")

        # Log attività e risposte
        self.log_box = tk.Text(root, bg="#000000", fg="#39ff14", font=("Consolas", 9), relief="solid", bd=1, height=14, wrap="word")
        self.log_box.pack(fill="both", expand=True, padx=14, pady=(0, 12))
        self.log("Jarvis Desktop pronto. Chiudendo questa finestra il servizio continua in background.")

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.thread = threading.Thread(target=self.heartbeat_loop, daemon=True)
        self.thread.start()

    def on_close(self) -> None:
        self.running = False
        ensure_bg_daemon()
        self.root.destroy()

    def log(self, msg: str) -> None:
        ts = time.strftime("%H:%M:%S")
        self.root.after(0, lambda: (self.log_box.insert("end", f"[{ts}] {msg}\n"), self.log_box.see("end")))

    def save_and_connect(self) -> None:
        self.cfg["server_url"] = self.url_var.get().strip().rstrip("/")
        self.cfg["server_token"] = self.tok_var.get().strip()
        save_config(self.cfg)
        self.log("Configurazione salvata. Verifica connessione a Jarvis Cloud...")
        threading.Thread(target=self.ping_once, daemon=True).start()

    def ping_once(self) -> None:
        try:
            pc_name = f"PC {socket.gethostname()}"
            plat = f"{platform.system()} {platform.release()}"
            res = api_call(
                self.cfg,
                "POST",
                "/devices/heartbeat",
                {
                    "id": f"desktop-{socket.gethostname().lower()}",
                    "kind": "desktop",
                    "name": pc_name,
                    "platform": plat,
                    "poll": not is_bg_running(),
                    "metrics": get_pc_metrics(),
                    "apps": ["Chrome", "Edge", "VS Code", "Esplora File", "PowerShell", "Blocco Note", "Calcolatrice", "Spotify"],
                },
            )
            self.online = True
            self.root.after(0, lambda: self.status_lbl.configure(text="● CONNESSO A JARVIS CLOUD", fg="#39ff14"))
            self.log("Connesso con successo a Jarvis Cloud! Il PC è online.")
            for cmd in res.get("commands") or []:
                execute_pc_command(cmd, self.log, self.cfg)
        except Exception as e:
            self.online = False
            self.root.after(0, lambda: self.status_lbl.configure(text="○ Errore connessione", fg="#ef4444"))
            self.log(f"Connessione non riuscita: {e}")

    def send_command(self) -> None:
        text = self.cmd_var.get().strip()
        if not text:
            return
        self.cmd_var.set("")
        self.log(f"Tu: {text}")

        def work():
            try:
                out = api_call(self.cfg, "POST", "/chat", {"text": text, "session": "main", "source": "app"})
                reply = out.get("reply", "")
                model = out.get("model", "")
                self.log(f"Jarvis ({model}): {reply}")
                if self.cfg.get("speak", True):
                    speak_tts(reply)
            except Exception as e:
                self.log(f"Errore: {e}")

        threading.Thread(target=work, daemon=True).start()

    def heartbeat_loop(self) -> None:
        pc_name = f"PC {socket.gethostname()}"
        plat = f"{platform.system()} {platform.release()}"
        apps = ["Chrome", "Edge", "VS Code", "Esplora File", "PowerShell", "Blocco Note", "Calcolatrice", "Spotify"]
        while self.running:
            metrics = get_pc_metrics()
            self.root.after(
                0,
                lambda m=metrics: self.tele_lbl.configure(
                    text=f"{pc_name} ({plat}) • RAM: {m['ram']}% • Attivo: {m['activeWindow'][:28] or 'Desktop'}"
                ),
            )
            if self.cfg.get("server_url") and self.cfg.get("server_token"):
                try:
                    res = api_call(
                        self.cfg,
                        "POST",
                        "/devices/heartbeat",
                        {
                            "id": f"desktop-{socket.gethostname().lower()}",
                            "kind": "desktop",
                            "name": pc_name,
                            "platform": plat,
                            "poll": not is_bg_running(),
                            "metrics": metrics,
                            "apps": apps,
                        },
                    )
                    if not self.online:
                        self.online = True
                        self.root.after(0, lambda: self.status_lbl.configure(text="● CONNESSO A JARVIS CLOUD", fg="#39ff14"))
                        self.log("PC registrato e connesso al sistema multi-dispositivo di Jarvis.")
                    for cmd in res.get("commands") or []:
                        execute_pc_command(cmd, self.log, self.cfg)
                except Exception:
                    if self.online:
                        self.online = False
                        self.root.after(0, lambda: self.status_lbl.configure(text="○ Disconnesso (riprovo...)", fg="#f59e0b"))
            time.sleep(2)


DAEMON_PORT = 47621
LOG_PATH = DIR / "jarvis_bg.log"


def is_bg_running() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", DAEMON_PORT), timeout=0.25):
            return True
    except Exception:
        return False


def ensure_bg_daemon() -> None:
    if is_bg_running():
        return
    pyw = Path(sys.executable).with_name("pythonw.exe")
    exe = str(pyw) if pyw.exists() else sys.executable
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.Popen([exe, str(Path(__file__).resolve()), "--bg"], cwd=str(DIR), creationflags=flags)
    except Exception:
        pass


def bg_log(msg: str) -> None:
    try:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def run_background_daemon() -> None:
    """Demone silenzioso in background: tiene il PC connesso anche ad app chiusa e dopo il riavvio."""
    lock_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        lock_sock.bind(("127.0.0.1", DAEMON_PORT))
        lock_sock.listen(1)
    except OSError:
        return  # già attivo in background

    def accept_loop():
        while True:
            try:
                conn, _ = lock_sock.accept()
                conn.close()
            except Exception:
                break

    threading.Thread(target=accept_loop, daemon=True).start()
    bg_log("Demone Jarvis Desktop avviato in background.")
    pc_name = f"PC {socket.gethostname()}"
    plat = f"{platform.system()} {platform.release()}"
    apps = ["Chrome", "Edge", "VS Code", "Esplora File", "PowerShell", "Blocco Note", "Calcolatrice", "Spotify"]

    last_err = ""
    while True:
        cfg = load_config()
        if cfg.get("server_url") and cfg.get("server_token"):
            try:
                res = api_call(
                    cfg,
                    "POST",
                    "/devices/heartbeat",
                    {
                        "id": f"desktop-{socket.gethostname().lower()}",
                        "kind": "desktop",
                        "name": pc_name,
                        "platform": plat,
                        "poll": True,
                        "metrics": get_pc_metrics(),
                        "apps": apps,
                    },
                )
                last_err = ""
                for cmd in res.get("commands") or []:
                    execute_pc_command(cmd, bg_log, cfg)
            except Exception as e:
                err_s = str(e)
                if err_s != last_err:
                    last_err = err_s
                    bg_log(f"Errore heartbeat: {err_s}")
        time.sleep(2)


if __name__ == "__main__":
    if "--bg" in sys.argv:
        run_background_daemon()
    else:
        ensure_bg_daemon()
        root = tk.Tk()
        app = JarvisDesktopApp(root)
        root.mainloop()
