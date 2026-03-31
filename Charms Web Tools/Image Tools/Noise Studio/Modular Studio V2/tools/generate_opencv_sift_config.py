from __future__ import annotations

import argparse
from pathlib import Path

SIFT_ENTRY = "              'SIFT': ['create', 'setNFeatures', 'getNFeatures', 'setNOctaveLayers', 'getNOctaveLayers', 'setContrastThreshold', 'getContrastThreshold', 'setEdgeThreshold', 'getEdgeThreshold', 'setSigma', 'getSigma', 'getDefaultName'],"


def inject_sift_entry(config_text: str) -> str:
    if "'SIFT':" in config_text:
        return config_text

    lines = config_text.splitlines()
    inserted = False
    output_lines: list[str] = []

    for line in lines:
        output_lines.append(line)
        if "'AKAZE':" in line and not inserted:
            output_lines.append(SIFT_ENTRY)
            inserted = True

    if not inserted:
        raise RuntimeError("Could not find the AKAZE whitelist entry in opencv_js.config.py.")

    return "\n".join(output_lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate an OpenCV.js whitelist config with SIFT enabled.")
    parser.add_argument("--input", required=True, help="Path to the source opencv_js.config.py file from the OpenCV checkout.")
    parser.add_argument("--output", required=True, help="Path to write the SIFT-enabled config.")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()

    text = input_path.read_text(encoding="utf-8")
    patched = inject_sift_entry(text)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(patched, encoding="utf-8")
    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
