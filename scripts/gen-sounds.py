#!/usr/bin/env python3
"""Synthesize the two deck chimes as 16-bit mono WAVs (no deps).

  done.wav   a soft rising bell — gently rewarding, calm
  needs.wav  a warm singing-bowl double-strike — zen, but it wants you

Re-run to regenerate:  python3 scripts/gen-sounds.py
Delete a .wav (or the whole sounds/ folder) to silence that chime.
"""
import math, struct, wave, os

SR = 44100
PI = math.pi


def env(t, tau, attack=0.02):
    a = t / attack if t < attack else 1.0        # soft attack, no click
    return min(1.0, a) * math.exp(-t / tau)      # long, gentle bell decay


def render(duration, fn, peak=0.55, release=0.35, lead=0.15, fadein=0.09):
    n = int(SR * duration)
    rel = max(1, int(SR * release))
    xs = [fn(i / SR) for i in range(n)]
    # Linear fade to *exactly* zero over the last `release` seconds. Without it the
    # file ends while the exponential tail is still ringing (~20%), and that hard
    # cut is a click/buzz. Fading to zero removes it.
    for i in range(max(0, n - rel), n):
        xs[i] *= (n - 1 - i) / rel
    hi = max((abs(x) for x in xs), default=1.0) or 1.0
    g = peak / hi
    body = [int(max(-1.0, min(1.0, x * g)) * 32767) for x in xs]
    # Soft global fade-in — the tone emerges gently, so any residual device-wake
    # crackle lands while it's still near-silent.
    fin = max(1, int(SR * fadein))
    for i in range(min(fin, len(body))):
        body[i] = int(body[i] * (i / fin))
    # Lead-in silence so an idle/Bluetooth output wakes during silence, not on the
    # first note — that onset crackle is a device-wake glitch, not the waveform.
    body = [0] * int(SR * lead) + body
    return b"".join(struct.pack("<h", v) for v in body)


def write(path, raw):
    w = wave.open(path, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(raw); w.close()


def warm(lt, f, tau):
    """A soft, slightly-detuned bell voice — the beating twin gives it life."""
    v = (0.5 * math.sin(2 * PI * f * lt)
         + 0.5 * math.sin(2 * PI * (f * 1.004) * lt)   # detuned twin → slow shimmer
         + 0.16 * math.sin(2 * PI * 2 * f * lt)
         + 0.05 * math.sin(2 * PI * 2.7 * f * lt))      # a whisper of inharmonic bowl
    return v * env(lt, tau)


# --- done: a slow, soft rising triad (C5 E5 G5), warm and unhurried
def done(t):
    s = 0.0
    for i, f in enumerate((523.25, 659.25, 783.99)):
        t0 = i * 0.16
        if t >= t0:
            s += warm(t - t0, f, 0.7) * 0.6
    return s


# --- needs: two low singing-bowl strikes, a gentle rising fifth (E4 -> B4)
def needs(t):
    s = 0.0
    for t0, f, amp in ((0.0, 329.63, 0.55), (0.66, 493.88, 0.34)):
        if t >= t0:
            s += warm(t - t0, f, 1.25) * amp
    return s


out = os.path.join(os.path.dirname(__file__), "..", "com.tknab.claudeagents.sdPlugin", "sounds")
os.makedirs(out, exist_ok=True)
write(os.path.join(out, "done.wav"), render(1.5, done))
write(os.path.join(out, "needs.wav"), render(2.6, needs))
print("wrote", os.path.abspath(out))
