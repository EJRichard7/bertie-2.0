import tempfile
from typing import Optional, Tuple

import numpy as np
import sounddevice as sd
from scipy.io.wavfile import write
from faster_whisper import WhisperModel

_MODEL_NAME = "small"
_MODEL = WhisperModel(_MODEL_NAME, device="cpu", compute_type="int8")

def record_seconds(
    seconds: int = 6,
    samplerate: int = 16000,
):
    audio = sd.rec(
        int(seconds * samplerate),
        samplerate=samplerate,
        channels=1,
        dtype="int16",
    )
    sd.wait()
    return audio.squeeze(), samplerate

def transcribe_audio(
    audio_int16,
    samplerate: int = 16000,
):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as f:
        write(f.name, samplerate, audio_int16)
        segments, _info = _MODEL.transcribe(f.name, language="en")
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return text

def quick_transcribe(seconds: int = 6):
    print(f"Recording {seconds} seconds... speak now.")
    audio, sr = record_seconds(seconds=seconds)
    text = transcribe_audio(audio, sr)
    print("TRANSCRIPT:", repr(text))
    return text
