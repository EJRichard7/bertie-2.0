#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════╗
║                  BERTIE - PDF Voice Assistant                ║
║  Say "Bertie" followed by a command to annotate your PDF     ║
╚══════════════════════════════════════════════════════════════╝

SETUP (run once in terminal):
    pip install openai pymupdf pyttsx3 SpeechRecognition pyaudio

USAGE:
    python bertie.py path/to/your.pdf

VOICE COMMANDS:
    "Bertie read this page"
    "Bertie read the whole document"
    "Bertie highlight that sentence"
    "Bertie underline that sentence"
    "Bertie highlight that paragraph"
    "Bertie underline that paragraph"
    "Bertie highlight that date"
    "Bertie underline that date"
    "Bertie highlight [exact text]"
    "Bertie next page"
    "Bertie previous page"
    "Bertie go to page 3"
    "Bertie what's on this page"
    "Bertie save"
    "Bertie quit"
"""

import sys
import os
import re
import threading
import queue

import fitz                      # pip install pymupdf
import pyttsx3                   # pip install pyttsx3
import speech_recognition as sr  # pip install SpeechRecognition pyaudio
from openai import OpenAI        # pip install openai

# ─── CONFIG ───────────────────────────────────────────────────────────────────

OPENAI_API_KEY = "YOUR_OPENAI_API_KEY_HERE"   # <── paste your OpenAI key here

# Annotation colours (R, G, B) 0.0–1.0
YELLOW = (1.0, 0.85, 0.0)   # highlight – sentences
GREEN  = (0.4, 0.90, 0.4)   # highlight – dates
ORANGE = (1.0, 0.65, 0.2)   # highlight – paragraphs
BLUE   = (0.0, 0.30, 1.0)   # underline colour

# Wake word variants speech-to-text might produce
WAKE_WORDS = {"bertie", "birdie", "burdie", "burtie", "birdy", "burty", "berty"}

# ─── BERTIE ───────────────────────────────────────────────────────────────────

class Bertie:
    def __init__(self, pdf_path: str):
        self.pdf_path  = os.path.abspath(pdf_path)
        self.out_path  = self.pdf_path.replace(".pdf", "_bertie_annotated.pdf")
        self.doc       = fitz.open(self.pdf_path)
        self.page_idx  = 0
        self.last_text = ""
        self.running   = True
        self.speaking  = False
        self.cmd_queue = queue.Queue()

        # TTS
        self.tts = pyttsx3.init()
        self.tts.setProperty("rate", 160)
        for v in self.tts.getProperty("voices"):
            if any(n in v.name.lower() for n in ("samantha", "karen", "zira", "susan")):
                self.tts.setProperty("voice", v.id)
                break

        # STT
        self.rec = sr.Recognizer()
        self.rec.energy_threshold         = 400
        self.rec.dynamic_energy_threshold = True
        self.rec.pause_threshold          = 0.8
        self.mic = sr.Microphone()

        # AI (optional)
        try:
            self.ai = OpenAI(api_key=OPENAI_API_KEY)
        except Exception:
            self.ai = None

        print("🎙️  Calibrating microphone… please wait.")
        with self.mic as source:
            self.rec.adjust_for_ambient_noise(source, duration=2)

        print(f"\n✅  Bertie ready!  PDF: {os.path.basename(pdf_path)}  ({len(self.doc)} pages)")
        print("    Say  'Bertie read this page'  to start.\n")
        self._speak("Hello! I'm Bertie. Say Bertie followed by a command.")

    # ── TTS ───────────────────────────────────────────────────────────────────

    def _speak(self, text: str):
        self.speaking = True
        self.last_text = text
        print(f"🔊 Bertie: {text[:120]}{'…' if len(text) > 120 else ''}")
        self.tts.say(text)
        self.tts.runAndWait()
        self.speaking = False

    # ── PAGE TEXT ─────────────────────────────────────────────────────────────

    def _page_text(self, idx: int = None) -> str:
        i = idx if idx is not None else self.page_idx
        return self.doc[i].get_text()

    # ── LISTEN LOOP ───────────────────────────────────────────────────────────

    def _listen_loop(self):
        print("🎙️  Listening for 'Bertie …'\n")
        import time
        while self.running:
            if self.speaking:
                time.sleep(0.3)
                continue
            try:
                with self.mic as source:
                    audio = self.rec.listen(source, timeout=6, phrase_time_limit=12)

                raw = self.rec.recognize_google(audio).lower().strip()
                print(f"   Heard: \"{raw}\"")

                # Find wake word
                words   = raw.split()
                hit_idx = None
                for i, w in enumerate(words):
                    clean = re.sub(r"[^a-z]", "", w)
                    if clean in WAKE_WORDS:
                        hit_idx = i
                        break

                if hit_idx is not None:
                    cmd = " ".join(words[hit_idx + 1:]).strip()
                    self.cmd_queue.put(cmd if cmd else "__wake_only__")

            except sr.WaitTimeoutError:
                pass
            except sr.UnknownValueError:
                pass
            except sr.RequestError as e:
                print(f"   [STT network error: {e}]")
            except Exception as e:
                print(f"   [listener error: {e}]")

    # ── COMMAND ROUTER ────────────────────────────────────────────────────────

    def _route(self, cmd: str):
        print(f"📝 Command: \"{cmd}\"")

        if cmd == "__wake_only__":
            self._speak("Yes? Say a command after my name.")
            return

        # Navigation
        if re.search(r"next page", cmd):
            self._go_page(self.page_idx + 1)
        elif re.search(r"previous page|go back|last page", cmd):
            self._go_page(self.page_idx - 1)
        elif m := re.search(r"go to page (\d+)|page (\d+)", cmd):
            n = int(m.group(1) or m.group(2))
            self._go_page(n - 1)

        # Reading
        elif re.search(r"read (this |the |current )?page|read it", cmd):
            self._read_page()
        elif re.search(r"read (the |whole |entire |full )?document|read all", cmd):
            self._read_document()
        elif re.search(r"\bstop\b|\bpause\b|be quiet|shut up|quiet", cmd):
            self._speak("Okay.")

        # AI summary
        elif re.search(r"what.s on this page|summari[sz]e|summary|what does it say", cmd):
            self._ai_summary()

        # Highlight
        elif re.search(r"highlight that sentence", cmd):
            self._annotate_target("highlight", "sentence")
        elif re.search(r"highlight that paragraph", cmd):
            self._annotate_target("highlight", "paragraph")
        elif re.search(r"highlight (that |the |all )?dates?", cmd):
            self._annotate_target("highlight", "date")
        elif m := re.search(r"highlight (.+)", cmd):
            self._annotate_literal(m.group(1), "highlight")

        # Underline
        elif re.search(r"underline that sentence", cmd):
            self._annotate_target("underline", "sentence")
        elif re.search(r"underline that paragraph", cmd):
            self._annotate_target("underline", "paragraph")
        elif re.search(r"underline (that |the |all )?dates?", cmd):
            self._annotate_target("underline", "date")
        elif m := re.search(r"underline (.+)", cmd):
            self._annotate_literal(m.group(1), "underline")

        # Save / quit
        elif re.search(r"\bsave\b", cmd):
            self._save()
        elif re.search(r"\bquit\b|\bexit\b|goodbye|bye", cmd):
            self._quit()

        else:
            self._speak("Sorry, I didn't catch that. Try: Bertie read this page, or Bertie highlight that sentence.")

    # ── NAVIGATION ────────────────────────────────────────────────────────────

    def _go_page(self, idx: int):
        if 0 <= idx < len(self.doc):
            self.page_idx = idx
            self._speak(f"Page {idx + 1}.")
        else:
            self._speak("There's no such page.")

    # ── READING ───────────────────────────────────────────────────────────────

    def _read_page(self, idx: int = None):
        i   = idx if idx is not None else self.page_idx
        txt = self._page_text(i).strip()
        if not txt:
            self._speak("This page has no readable text.")
            return
        self._speak(f"Page {i + 1}. {txt}")

    def _read_document(self):
        for i in range(len(self.doc)):
            if not self.running:
                break
            self.page_idx = i
            self._read_page(i)

    # ── AI SUMMARY ────────────────────────────────────────────────────────────

    def _ai_summary(self):
        if not self.ai:
            self._speak("No OpenAI key configured.")
            return
        txt = self._page_text().strip()
        if not txt:
            self._speak("Nothing to summarise on this page.")
            return
        self._speak("One moment…")
        try:
            resp = self.ai.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": "You are Bertie, a friendly PDF assistant. Give a spoken-style summary in 3-4 sentences."},
                    {"role": "user",   "content": f"Summarise:\n\n{txt[:3000]}"},
                ],
                max_tokens=200,
            )
            self._speak(resp.choices[0].message.content)
        except Exception as e:
            self._speak("Sorry, I couldn't reach the AI. Check your API key.")
            print(f"   [AI error: {e}]")

    # ── ANNOTATION HELPERS ────────────────────────────────────────────────────

    def _apply(self, page: fitz.Page, hits: list, style: str, color: tuple):
        for rect in hits:
            if style == "highlight":
                annot = page.add_highlight_annot(rect)
            else:
                annot = page.add_underline_annot(rect)
            annot.set_colors({"stroke": color, "fill": color})
            annot.update()

    def _search(self, page: fitz.Page, text: str) -> list:
        text = text.strip()
        for length in (len(text), 80, 60, 40, 20):
            if length > len(text):
                continue
            hits = page.search_for(text[:length])
            if hits:
                return hits
        return []

    def _annotate_literal(self, spoken: str, style: str):
        page  = self.doc[self.page_idx]
        color = YELLOW if style == "highlight" else BLUE
        hits  = self._search(page, spoken)
        if hits:
            self._apply(page, hits, style, color)
            self._save(quiet=True)
            self._speak(f"Done! I've {style}d that.")
        else:
            self._speak("I couldn't find that text. Try saying the exact words from the document.")

    def _annotate_target(self, style: str, target: str):
        page = self.doc[self.page_idx]
        pt   = self._page_text()

        if target == "date":
            self._annotate_dates(page, style)
            return

        if target == "sentence":
            chunk = self._last_sentence(pt)
            color = YELLOW if style == "highlight" else BLUE
        else:  # paragraph
            chunk = self._last_paragraph(pt)
            color = ORANGE if style == "highlight" else BLUE

        if not chunk:
            self._speak("I'm not sure which text you mean. Try: Bertie highlight, then the exact words.")
            return

        hits = self._search(page, chunk)
        if hits:
            self._apply(page, hits, style, color)
            self._save(quiet=True)
            self._speak(f"Got it! I've {style}d that {target}.")
        else:
            self._speak(f"I couldn't locate that {target} visually on the page.")

    def _annotate_dates(self, page: fitz.Page, style: str):
        patterns = [
            r'\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b',
            r'\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b',
            r'\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b',
            r'\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b',
            r'\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b',
        ]
        txt         = self._page_text()
        found_dates = set()
        for pat in patterns:
            for m in re.finditer(pat, txt, re.IGNORECASE):
                found_dates.add(m.group())

        if not found_dates:
            self._speak("I couldn't find any dates on this page.")
            return

        color = GREEN if style == "highlight" else BLUE
        count = 0
        for d in found_dates:
            hits = page.search_for(d)
            if hits:
                self._apply(page, hits, style, color)
                count += 1

        if count:
            self._save(quiet=True)
            self._speak(f"I've {style}d {count} date{'s' if count != 1 else ''} on this page.")
        else:
            self._speak("I found dates in the text but couldn't locate them visually.")

    # ── SENTENCE / PARAGRAPH EXTRACTION ──────────────────────────────────────

    def _last_sentence(self, page_text: str) -> str:
        sentences = re.split(r'(?<=[.!?])\s+', self.last_text.strip())
        for sent in reversed(sentences):
            sent = sent.strip()
            if len(sent) > 15 and sent[:25] in page_text:
                return sent
        page_sents = re.split(r'(?<=[.!?])\s+', page_text.strip())
        return page_sents[-1].strip() if page_sents else ""

    def _last_paragraph(self, page_text: str) -> str:
        paras = [p.strip() for p in re.split(r'\n{2,}', page_text) if p.strip()]
        if not paras:
            return ""
        spoken_words = set(self.last_text.lower().split())
        best, best_score = paras[-1], 0
        for para in paras:
            score = len(spoken_words & set(para.lower().split()))
            if score > best_score:
                best, best_score = para, score
        return best[:100]

    # ── SAVE / QUIT ───────────────────────────────────────────────────────────

    def _save(self, quiet: bool = False):
        try:
            self.doc.save(self.out_path, incremental=False, encryption=fitz.PDF_ENCRYPT_NONE)
            print(f"   💾 Saved → {self.out_path}")
            if not quiet:
                self._speak(f"Saved as {os.path.basename(self.out_path)}")
        except Exception as e:
            print(f"   [save error: {e}]")
            if not quiet:
                self._speak("Sorry, I had trouble saving the file.")

    def _quit(self):
        self._speak("Saving and shutting down. Goodbye!")
        self._save(quiet=True)
        self.running = False

    # ── MAIN LOOP ─────────────────────────────────────────────────────────────

    def run(self):
        t = threading.Thread(target=self._listen_loop, daemon=True)
        t.start()
        while self.running:
            try:
                cmd = self.cmd_queue.get(timeout=1)
                self._route(cmd)
            except queue.Empty:
                pass
            except KeyboardInterrupt:
                self._quit()
                break


# ─── ENTRY POINT ──────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage:  python bertie.py yourfile.pdf")
        sys.exit(1)
    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"File not found: {path}")
        sys.exit(1)
    Bertie(path).run()

if __name__ == "__main__":
    main()
