#!/usr/bin/env python3
"""Build the operator PDF guides' HTML sources from their templates.

Fills docs/pdf1-template.html and docs/pdf2-template.html with live
screenshots (base64-embedded) and writes docs/pdf1-source.html /
docs/pdf2-source.html. The PDFs themselves are rendered from those HTML
files with a headless browser - see render-pdfs.ps1 (headless Edge, no
extra installs needed on Windows).

RECAPTURING SCREENSHOTS (do this on the deployment VM once it exists):

  1. Stack up postgres + web only:
       cp .env.example .env      # fill bootstrap values incl.
                                 # SETTINGS_ENCRYPTION_KEY
       bash vendor/openwa/prepare.sh && docker compose build web
       docker compose up -d postgres web
     (the web container runs prisma migrate deploy automatically)

  2. Browse http://localhost:3000/setup - create the first ADMIN account,
     then sign in.

  3. Capture PNGs at ~1440px viewport width into the repo ROOT:
       /setup            -> screenshot-setup.png
       /admin/settings   -> screenshot-admin-settings.png
       /admin/whatsapp   -> screenshot-whatsapp-board.png
                            (best with 2-4 ports paired so live pairing
                            codes / QRs are visible in each slot)

  4. Regenerate everything:
       python scripts/build-docs.py
       powershell -File scripts/render-pdfs.ps1

Until fresh captures exist, this script substitutes an honest "Screenshot
pending" note for any missing screenshot instead of shipping a broken or
stale image silently. Existing screenshots captured on an earlier build are
kept but their PDF captions say so.
"""
from pathlib import Path
import base64
import re

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

# Rendered into the PDF when a screenshot file doesn't exist yet. Replaces
# the ENTIRE <img>+<div class="caption"> block, never leaving a broken
# <img src=""> behind.
PENDING_NOTE = (
    '<div class="warn"><strong>Screenshot pending.</strong> This screen was '
    "redesigned after the last capture was taken. Recapture it on the live "
    "VM during go-live &mdash; exact steps are documented at the top of "
    "<code>scripts/build-docs.py</code>.</div>"
)


def b64(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def swap_missing_images(html: str, shots: dict[str, Path]) -> str:
    """For every named screenshot whose file is MISSING, find its rendered
    <img class="screenshot" src="{...emptied...}"> block plus the caption
    div that follows it, and replace both with the pending-note."""
    for name, path in shots.items():
        if path.exists():
            continue
        # After .format() with an empty string, the img's src attribute is
        # empty: <img class="screenshot" src="" alt="...">
        pattern = re.compile(
            r'<img class="screenshot" src="\s*"[^>]*>\s*<div class="caption">.*?</div>',
            re.S,
        )
        html, n = pattern.subn(PENDING_NOTE, html, count=1)
        if n == 0:
            print(f"WARNING: no <img> block found for missing screenshot '{name}'")
    return html


def build(template_name: str, out_name: str, shots: dict[str, Path], **images: str) -> Path:
    template = (DOCS / template_name).read_text(encoding="utf-8")
    html = template.format(**images)
    html = swap_missing_images(html, shots)
    out = DOCS / out_name
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({len(html):,} bytes)")
    return out


def main() -> None:
    setup_png = ROOT / "screenshot-setup.png"
    settings_png = ROOT / "screenshot-admin-settings.png"
    board_png = ROOT / "screenshot-whatsapp-board.png"

    # Guide 1 needs only the /setup screenshot.
    build(
        "pdf1-template.html",
        "pdf1-source.html",
        shots={"setup_img": setup_png},
        setup_img=b64(setup_png) if setup_png.exists() else "",
    )
    # Guide 2 embeds all three live screenshots (settings page, the WhatsApp
    # SIM port board, and the setup wizard appendix).
    build(
        "pdf2-template.html",
        "pdf2-source.html",
        shots={"setup_img": setup_png, "settings_img": settings_png, "whatsapp_img": board_png},
        setup_img=b64(setup_png) if setup_png.exists() else "",
        settings_img=b64(settings_png) if settings_png.exists() else "",
        whatsapp_img=b64(board_png) if board_png.exists() else "",
    )


if __name__ == "__main__":
    main()
