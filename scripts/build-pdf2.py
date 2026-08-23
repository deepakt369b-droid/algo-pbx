#!/usr/bin/env python3
"""Build docs/pdf2-source.html from docs/pdf2-template.html and live screenshots."""
from pathlib import Path
import base64

ROOT = Path(__file__).resolve().parent.parent

def b64(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()

setup_img = b64(ROOT / "screenshot-setup.png")
settings_img = b64(ROOT / "screenshot-admin-settings.png")

template = (ROOT / "docs" / "pdf2-template.html").read_text(encoding="utf-8")
html = template.format(setup_img=setup_img, settings_img=settings_img)

out = ROOT / "docs" / "pdf2-source.html"
out.write_text(html, encoding="utf-8")
print(f"wrote {out} ({len(html):,} bytes)")
