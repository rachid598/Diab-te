#!/usr/bin/env python3
"""Garde-fous structurels contre les regressions geometriques deja observees."""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent.parent
MEASURE = (ROOT / "android-src/DepthMeasure.java").read_text(encoding="utf-8")
GEOMETRY = (ROOT / "android-src/DepthGeometry.java").read_text(encoding="utf-8")


def require(pattern: str, text: str, message: str) -> None:
    if not re.search(pattern, text, re.S):
        print(f"::error::{message}")
        raise SystemExit(1)


require(r"MIN_CONFIDENCE\s*=\s*128", MEASURE, "seuil de confiance ARCore different de 128")
require(r"MIN_DEPTH_M\s*=\s*0\.50", MEASURE, "distance minimale differente de 50 cm")
require(r"MAX_DEPTH_M\s*=\s*0\.85", MEASURE, "distance maximale differente de 85 cm")
require(r"getTextureIntrinsics\s*\(\)", MEASURE, "intrinseques GPU absentes pour la carte Depth")
require(r"getImageIntrinsics\s*\(\)", MEASURE, "intrinseques CPU absentes pour le champ photo")
require(r"fitPlaneRansac\s*\(", MEASURE, "plan robuste RANSAC non utilise")
require(r"double\s+sx\s*=.*targetWidth.*sourceWidth", GEOMETRY, "echelle X des intrinseques absente")
require(r"double\s+sy\s*=.*targetHeight.*sourceHeight", GEOMETRY, "echelle Y des intrinseques absente")
require(r"fillSmallEnclosedHoles", MEASURE, "controle local des trous denses absent")
require(r"denseControlled.*denseCandidates", MEASURE, "couverture dense non controlee par Raw Depth")

for forbidden in ("focal[1] * scale", "principal[1] * scale", "if (conf == null) return 255"):
    if forbidden in MEASURE:
        print(f"::error::ancienne geometrie dangereuse retrouvee : {forbidden}")
        raise SystemExit(1)

print("Garde-fous de geometrie conformes.")
