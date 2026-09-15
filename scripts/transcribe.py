#!/usr/bin/env python3
"""
Transkribiert eine Audiodatei mit faster-whisper und gibt JSON auf stdout aus.

    python3 scripts/transcribe.py <audio> [--model small] [--compute-type int8]

Laeuft bewusst als eigener Prozess: so bleibt der Node-Server schlank und ein
abgestuerztes Modell reisst nicht den Webserver mit.
"""
import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "small"))
    parser.add_argument(
        "--compute-type", default=os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
    )
    parser.add_argument("--language", default=None)
    parser.add_argument(
        "--model-dir", default=os.environ.get("WHISPER_MODEL_DIR", "data/models")
    )
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            json.dumps(
                {
                    "error": "faster-whisper ist nicht installiert. "
                    "Im Container ist es enthalten; lokal: "
                    "pip install faster-whisper"
                }
            )
        )
        return 1

    os.makedirs(args.model_dir, exist_ok=True)

    try:
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type=args.compute_type,
            download_root=args.model_dir,
        )
        segments, info = model.transcribe(
            args.audio,
            language=args.language,
            vad_filter=True,           # schneidet Musik und Stille weg
            beam_size=5,
            condition_on_previous_text=False,  # verhindert Wiederholungsschleifen
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
    except Exception as exc:  # noqa: BLE001 - alles soll als JSON zurueckkommen
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1

    print(
        json.dumps(
            {
                "text": text,
                "language": info.language,
                "languageProbability": round(info.language_probability, 3),
                "durationSeconds": round(info.duration, 1),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
