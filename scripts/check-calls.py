#!/usr/bin/env python3
"""Contrats statiques des fichiers natifs non compiles par le test JVM."""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent.parent


def fail(message: str) -> None:
    print(f"::error::{message}")
    raise SystemExit(1)


def arity_at(text: str, start: int) -> int:
    depth = 0
    count = 1
    seen = False
    in_string = False
    escaped = False
    for char in text[start:]:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char in "([{" :
            depth += 1
        elif char in ")]}":
            if depth == 0:
                return count if seen else 0
            depth -= 1
        elif char == "," and depth == 0:
            count += 1
        if not char.isspace():
            seen = True
    fail("appel Java non termine")
    return 0


def check_measure_arity() -> None:
    measure = (ROOT / "android-src/DepthMeasure.java").read_text(encoding="utf-8")
    match = re.search(r"static\s+Result\s+measure\s*\(([^)]*)\)", measure)
    if not match:
        fail("signature DepthMeasure.measure introuvable")
    expected = len([arg for arg in match.group(1).split(",") if arg.strip()])
    for path in sorted((ROOT / "android-src").glob("*.java")):
        text = path.read_text(encoding="utf-8")
        for call in re.finditer(r"DepthMeasure\.measure\s*\(", text):
            got = arity_at(text, call.end())
            if got != expected:
                line = text.count("\n", 0, call.start()) + 1
                fail(f"{path.name}:{line}: DepthMeasure.measure recoit {got} arguments, {expected} attendus")


def require(text: str, pattern: str, message: str) -> None:
    if not re.search(pattern, text, re.S):
        fail(message)


def check_activity_contracts() -> None:
    activity = (ROOT / "android-src/DepthScanActivity.java").read_text(encoding="utf-8")
    plugin = (ROOT / "android-src/DepthScanPlugin.java").read_text(encoding="utf-8")

    require(plugin, r"checkAvailabilityAsync\s*\(", "disponibilite ARCore non asynchrone")
    if "Thread.sleep" in plugin or re.search(r"while\s*\([^)]*isTransient", plugin):
        fail("attente bloquante dans DepthScanPlugin")
    require(activity, r"requestInstall\s*\(\s*this\s*,\s*userRequestedInstall\s*\)",
            "requestInstall n'utilise pas le drapeau one-shot")
    require(activity, r"userRequestedInstall\s*=\s*false", "drapeau d'installation jamais rabaisse")
    require(activity, r"MIN_BASELINE_M\s*=\s*0\.20", "parallaxe minimale de 20 cm absente")
    require(activity, r"REQUIRED_OBSERVATIONS\s*=\s*4", "quatre observations requises absentes")
    require(activity, r"acquireRawDepthImage16Bits", "Raw Depth non acquis")
    require(activity, r"acquireRawDepthConfidenceImage", "confiance Raw Depth non acquise")
    require(activity, r"timestamp\s*!=\s*frame\.getTimestamp\(\)", "fraicheur Raw Depth non verifiee")
    require(activity, r"camera\.getTimestamp\(\)\s*!=\s*frame\.getAndroidCameraTimestamp\(\)",
            "photo CPU non synchronisee avec le Frame")
    require(activity, r"getRowStride\(\)", "rowStride YUV ignore")
    require(activity, r"getPixelStride\(\)", "pixelStride YUV ignore")
    require(activity, r"Photo conservee sans mesure", "repli photo sans profondeur absent")


def check_web_bridge_contract() -> None:
    source = (ROOT / "src/capacitor-plugins.js").read_text(encoding="utf-8")
    native = (ROOT / "js/native.js").read_text(encoding="utf-8")
    plugin = (ROOT / "android-src/DepthScanPlugin.java").read_text(encoding="utf-8")
    require(source, r"registerPlugin\(\s*['\"]DepthScan['\"]\s*\)",
            "DepthScan non enregistre dans le bundle Capacitor")
    require(source, r"DepthScan\s*:\s*DepthScan", "DepthScan absent de window.Cap")
    require(native, r"Cap\.DepthScan\.available\s*\(", "available ARCore non appele par le pont web")
    require(native, r"Cap\.DepthScan\.capture\s*\(", "capture ARCore non appelee par le pont web")

    expected_bridge_fields = (
        "jpegBase64", "depthOk", "scaleOk", "volumeOk", "fieldWidthCm",
        "fieldHeightCm", "distanceCm", "cmPerPixel", "volumeCm3", "areaCm2",
        "heightMaxCm", "heightMeanCm", "samples", "confidentPixels", "coverage",
        "observations", "parallaxCm", "fresh", "note", "diag",
    )
    for field in expected_bridge_fields:
        require(plugin, rf'ret\.put\("{field}"', f"champ du pont natif absent : {field}")


def main() -> None:
    check_measure_arity()
    check_activity_contracts()
    check_web_bridge_contract()
    print("Appels et contrats Android conformes.")


if __name__ == "__main__":
    main()
