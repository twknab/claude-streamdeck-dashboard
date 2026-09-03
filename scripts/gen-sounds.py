#!/usr/bin/env python3
"""Synthesize the two deck chimes as 16-bit mono WAVs (no deps).

  done.wav   a bright, rising bell arpeggio  — happy / rewarding
  needs.wav  a warm singing-bowl double-tap — zen, but it wants you

Re-run to regenerate:  python3 scripts/gen-sounds.py
Delete a .wav (or the whole sounds/ folder) to silence that chime.
"""
import math, struct, wave, os

SR = 44100


def env(t, tau, attack=0.006):
    a = t / attack if t < attack else 1.0        # short linear attack, no click
    return min(1.0, a) * math.exp(-t / tau)      # exponential bell decay


def render(duration, fn, peak=0.82):
    n = int(SR * duration)
    xs = [fn(i / SR) for i in range(n)]
    hi = max((abs(x) for x in xs), default=1.0) or 1.0
    g = peak / hi
    return b"".join(struct.pack("<h", int(max(-1.0, min(1.0, x * g)) * 32767)) for x in xs)


def write(path, raw):
    w = wave.open(path, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(raw); w.close()


# --- done: C5 E5 G5 C6 arpeggio, each a soft bell, blooming into a major chord
def done(t):
    s = 0.0
    for i, f in enumerate((523.25, 659.25, 783.99, 1046.50)):
        t0 = i * 0.072
        if t >= t0:
            lt = t - t0
            s += (math.sin(2 * math.pi * f * lt)
                  + 0.30 * math.sin(2 * math.pi * 2 * f * lt)
                  + 0.10 * math.sin(2 * math.pi * 3 * f * lt)) * env(lt, 0.30) * 0.30
    return s


# --- needs: two warm singing-bowl strikes, a gentle rising G4 -> A4 ("hey…?")
def bowl(lt, f):
    return (1.00 * math.sin(2 * math.pi * f * lt)
            + 0.20 * math.sin(2 * math.pi * f * 2.00 * lt)
            + 0.12 * math.sin(2 * math.pi * f * 2.76 * lt)   # inharmonic — the "bowl"
            + 0.07 * math.sin(2 * math.pi * f * 5.40 * lt)) * env(lt, 0.80, 0.012)


def needs(t):
    s = 0.0
    for t0, f, amp in ((0.0, 392.00, 0.55), (0.44, 440.00, 0.44)):
        if t >= t0:
            s += bowl(t - t0, f) * amp
    return s


out = os.path.join(os.path.dirname(__file__), "..", "com.tknab.claudeagents.sdPlugin", "sounds")
os.makedirs(out, exist_ok=True)
write(os.path.join(out, "done.wav"), render(0.75, done))
write(os.path.join(out, "needs.wav"), render(1.50, needs))
print("wrote", os.path.abspath(out))
