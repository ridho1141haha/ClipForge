#!/usr/bin/env python3
"""
ClipForge ASR worker — faster-whisper word-level transcription.
Usage: python3 scripts/asr-transcribe.py <media_path> <output_json_path> [model_size] [language]

Output JSON: { text, words: [{word, start, end}], language, duration, model }
Exits non-zero with a JSON error on stderr: { error, code }
"""
import json
import sys
import time


def fail(code: str, message: str) -> None:
    json.dump({"error": message, "code": code}, sys.stderr)
    sys.stderr.write("\n")
    sys.exit(1)


def main() -> None:
    if len(sys.argv) < 3:
        fail("ARGS", "usage: asr-transcribe.py <media> <out.json> [model_size] [language]")
    media_path = sys.argv[1]
    out_path = sys.argv[2]
    model_size = sys.argv[3] if len(sys.argv) > 3 else "tiny"
    language = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] not in ("", "auto") else None

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        fail("ASR_UNAVAILABLE", "faster-whisper is not installed on the server (pip install faster-whisper)")

    t0 = time.time()
    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
    except Exception as e:  # noqa: BLE001
        fail("ASR_MODEL_LOAD", f"failed to load whisper model '{model_size}': {e}")

    try:
        segments_iter, info = model.transcribe(
            media_path,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            language=language,
        )
        words = []
        texts = []
        for seg in segments_iter:
            seg_text = (seg.text or "").strip()
            if seg_text:
                texts.append(seg_text)
            for w in seg.words or []:
                token = (w.word or "").strip()
                if not token:
                    continue
                words.append({"word": token, "start": round(float(w.start), 2), "end": round(float(w.end), 2)})
    except Exception as e:  # noqa: BLE001
        fail("ASR_FAILED", f"transcription failed: {e}")

    result = {
        "text": "\n".join(texts),
        "words": words[:120_000],
        "language": getattr(info, "language", None),
        "duration": round(float(getattr(info, "duration", 0) or 0), 2),
        "model": model_size,
        "elapsed_seconds": round(time.time() - t0, 1),
    }
    with open(out_path, "w") as f:
        json.dump(result, f)
    sys.stdout.write(json.dumps({"ok": True, "words": len(result["words"])}))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
