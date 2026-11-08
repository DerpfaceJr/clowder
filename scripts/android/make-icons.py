"""Generate the Clowder Android launcher icons from build/icon.png.

Run once, or again when the icon changes: python scripts/android/make-icons.py
Writes android/res/mipmap-*/ic_launcher*.png. Needs Pillow.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
RES = ROOT / "android" / "res"
SOURCE = ROOT / "build" / "icon.png"

# Legacy launcher sizes (48dp base) and adaptive foreground sizes (108dp base).
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FOREGROUND = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
FOREGROUND_SCALE = 0.66  # keeps the cat inside the 66dp adaptive safe zone


def main():
    src = Image.open(SOURCE).convert("RGBA")
    for density, px in LEGACY.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)
        square = src.resize((px, px), Image.LANCZOS)
        square.save(out / "ic_launcher.png")
        mask = Image.new("L", (px * 4, px * 4), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
        mask = mask.resize((px, px), Image.LANCZOS)
        round_icon = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        round_icon.paste(square, (0, 0), mask)
        round_icon.save(out / "ic_launcher_round.png")
    for density, px in FOREGROUND.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)
        inner = round(px * FOREGROUND_SCALE)
        canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        canvas.paste(src.resize((inner, inner), Image.LANCZOS), ((px - inner) // 2, (px - inner) // 2))
        canvas.save(out / "ic_launcher_foreground.png")
    print("wrote launcher icons")


if __name__ == "__main__":
    main()
