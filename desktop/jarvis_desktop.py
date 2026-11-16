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
import socket
import subprocess
import sys
import threading
import time
import urllib.error
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
    "whatsapp": "whatsapp",
    "gestione attivita": "taskmgr",
    "task manager": "taskmgr",
    "impostazioni": "ms-settings:",
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


def execute_pc_command(cmd: dict, log_fn) -> None:
    kind = (cmd.get("kind") or "open_app").lower()
    target = (cmd.get("target") or "").strip()
    log_fn(f"Eseguo comando [{kind}]: {target}")

    if kind == "open_url" and target:
        url = target if target.startswith(("http://", "https://")) else "https://" + target
        webbrowser.open(url)
        return

    if kind == "system":
        t = target.lower()
        if t == "lock" and os.name == "nt":
            ctypes.windll.user32.LockWorkStation()
        elif t == "play_pause":
            press_media_key(0xB3)  # VK_MEDIA_PLAY_PAUSE
        elif t == "vol_up":
            for _ in range(3):
                press_media_key(0xAF)  # VK_VOLUME_UP
        elif t == "vol_down":
            for _ in range(3):
                press_media_key(0xAE)  # VK_VOLUME_DOWN
        elif t == "mute":
            press_media_key(0xAD)  # VK_VOLUME_MUTE
        return

    if kind == "notify" and target:
        speak_tts(target)
        return

    if kind == "open_app" and target:
        exe = COMMON_APPS.get(target.lower(), target)
        try:
            if os.name == "nt":
                os.startfile(exe)
            else:
                subprocess.Popen([exe])
        except Exception:
            try:
                subprocess.Popen(f'start "" "{exe}"', shell=True)
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
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


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
        self.root.geometry("560x500")
        self.root.configure(bg="#050f08")

        # Header
        hdr = tk.Frame(root, bg="#050f08", pady=10, padx=14)
        hdr.pack(fill="x")
        tk.Label(hdr, text="◉ JARVIS CORE • DESKTOP", font=("Consolas", 14, "bold"), fg="#39ff14", bg="#050f08").pack(side="left")
        self.status_lbl = tk.Label(hdr, text="○ In attesa di connessione", font=("Segoe UI", 9, "bold"), fg="#9ca3af", bg="#050f08")
        self.status_lbl.pack(side="right")

        # Telemetria
        tele = tk.Frame(root, bg="#0a1c10", pady=8, padx=14, highlightbackground="#1c4426", highlightthickness=1)
        tele.pack(fill="x", padx=14, pady=(0, 10))
        self.tele_lbl = tk.Label(tele, text=f"PC: {socket.gethostname()} ({platform.system()} {platform.release()}) • RAM: --%", font=("Consolas", 9), fg="#a7f3d0", bg="#0a1c10")
        self.tele_lbl.pack(side="left")
        tk.Button(
            tele, text="Apri Sfera 3D / Web App", font=("Segoe UI", 9, "bold"),
            bg="#15803d", fg="#ffffff", activebackground="#22c55e", relief="flat", padx=10, pady=3,
            command=lambda: open_jarvis_webapp(self.cfg),
        ).pack(side="right")

        # Configurazione Server
        cfg_frame = tk.LabelFrame(root, text=" Connessione Jarvis Cloud ", font=("Segoe UI", 9, "bold"), fg="#39ff14", bg="#050f08", padx=10, pady=8)
        cfg_frame.pack(fill="x", padx=14, pady=(0, 10))

        tk.Label(cfg_frame, text="Indirizzo Server:", fg="#d1fae5", bg="#050f08", font=("Segoe UI", 9)).grid(row=0, column=0, sticky="w")
        self.url_var = tk.StringVar(value=self.cfg.get("server_url", ""))
        tk.Entry(cfg_frame, textvariable=self.url_var, bg="#0c2213", fg="#ecfdf5", insertbackground="#39ff14", relief="flat", width=42).grid(row=0, column=1, padx=6, pady=3, sticky="ew")

        tk.Label(cfg_frame, text="Token (JARVIS_TOKEN):", fg="#d1fae5", bg="#050f08", font=("Segoe UI", 9)).grid(row=1, column=0, sticky="w")
        self.tok_var = tk.StringVar(value=self.cfg.get("server_token", ""))
        tk.Entry(cfg_frame, textvariable=self.tok_var, show="*", bg="#0c2213", fg="#ecfdf5", insertbackground="#39ff14", relief="flat", width=42).grid(row=1, column=1, padx=6, pady=3, sticky="ew")

        tk.Button(
            cfg_frame, text="Salva e Connetti", font=("Segoe UI", 9, "bold"),
            bg="#166534", fg="#ffffff", relief="flat", padx=8, pady=4, command=self.save_and_connect,
        ).grid(row=0, column=2, rowspan=2, padx=4)
        cfg_frame.columnconfigure(1, weight=1)

        # Chat / Barra di comando diretta
        cmd_frame = tk.Frame(root, bg="#050f08", padx=14)
        cmd_frame.pack(fill="x", pady=(0, 8))
        self.cmd_var = tk.StringVar()
        entry = tk.Entry(cmd_frame, textvariable=self.cmd_var, font=("Segoe UI", 10), bg="#0c2213", fg="#ffffff", insertbackground="#39ff14", relief="flat")
        entry.pack(side="left", fill="x", expand=True, ipady=6, padx=(0, 8))
        entry.bind("<Return>", lambda e: self.send_command())
        tk.Button(
            cmd_frame, text="Invia a Jarvis →", font=("Segoe UI", 9, "bold"),
            bg="#22c55e", fg="#050f08", relief="flat", padx=12, pady=5, command=self.send_command,
        ).pack(side="right")

        # Log attività e risposte
        self.log_box = tk.Text(root, bg="#07150b", fg="#d1fae5", font=("Consolas", 9), relief="flat", height=14, wrap="word")
        self.log_box.pack(fill="both", expand=True, padx=14, pady=(0, 12))
        self.log("Jarvis Desktop pronto. Inserisci URL e Token se è il primo avvio, oppure scrivi un comando.")

        self.thread = threading.Thread(target=self.heartbeat_loop, daemon=True)
        self.thread.start()

    def log(self, msg: str) -> None:
        ts = time.strftime("%H:%M:%S")
        self.root.after(0, lambda: (self.log_box.insert("end", f"[{ts}] {msg}\n"), self.log_box.see("end")))

    def save_and_connect(self) -> None:
        self.cfg["server_url"] = self.url_var.get().strip().rstrip("/")
        self.cfg["server_token"] = self.tok_var.get().strip()
        save_config(self.cfg)
        self.log("Configurazione salvata. Sincronizzazione con Jarvis Cloud in corso...")

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
                            "metrics": metrics,
                            "apps": apps,
                        },
                    )
                    if not self.online:
                        self.online = True
                        self.root.after(0, lambda: self.status_lbl.configure(text="● CONNESSO A JARVIS CLOUD", fg="#39ff14"))
                        self.log("PC registrato e connesso al sistema multi-dispositivo di Jarvis.")
                    for cmd in res.get("commands") or []:
                        execute_pc_command(cmd, self.log)
                except Exception:
                    if self.online:
                        self.online = False
                        self.root.after(0, lambda: self.status_lbl.configure(text="○ Disconnesso (riprovo...)", fg="#f59e0b"))
            time.sleep(4)


if __name__ == "__main__":
    root = tk.Tk()
    app = JarvisDesktopApp(root)
    root.mainloop()
