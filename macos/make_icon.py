"""Draw the Today app icon (a sun rising at dawn): macos/Today.icns and
static/apple-touch-icon.png (needs Pillow + macOS iconutil).

    .venv/bin/python macos/make_icon.py
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
SIZE, BODY, RADIUS = 1024, 824, 185
SKY_TOP, SKY_BOTTOM = (28, 33, 66), (236, 141, 112)     # night blue -> dawn peach
SUN = (255, 214, 120)


def draw() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    off = (SIZE - BODY) // 2
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((off, off + 12, off + BODY, off + BODY + 12), RADIUS, fill=(0, 0, 0, 90))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))

    body = Image.new("RGBA", (BODY, BODY))
    gd = ImageDraw.Draw(body)
    for y in range(BODY):
        t = (y / (BODY - 1)) ** 1.4
        gd.line([(0, y), (BODY, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(SKY_TOP, SKY_BOTTOM)) + (255,))
    horizon = int(BODY * 0.66)
    # Glow, then the sun, cut off by the horizon.
    glow = Image.new("RGBA", (BODY, BODY), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((BODY / 2 - 300, horizon - 300, BODY / 2 + 300, horizon + 300), fill=SUN + (110,))
    body.alpha_composite(glow.filter(ImageFilter.GaussianBlur(70)))
    sun = Image.new("RGBA", (BODY, BODY), (0, 0, 0, 0))
    ImageDraw.Draw(sun).ellipse((BODY / 2 - 185, horizon - 185, BODY / 2 + 185, horizon + 185), fill=SUN + (255,))
    body.alpha_composite(sun)
    d = ImageDraw.Draw(body)
    d.rectangle((0, horizon, BODY, BODY), fill=(24, 28, 52, 255))
    d.line((90, horizon, BODY - 90, horizon), fill=(255, 236, 200, 255), width=10)
    for i, w in enumerate((340, 220, 120)):    # reflections on the water
        y = horizon + 55 + i * 50
        d.rounded_rectangle((BODY / 2 - w / 2, y, BODY / 2 + w / 2, y + 14), 7, fill=SUN + (150 - i * 35,))

    mask = Image.new("L", (BODY, BODY), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, BODY - 1, BODY - 1), RADIUS, fill=255)
    img.paste(body, (off, off), mask)
    return img


def main() -> None:
    icon = draw()
    icon.save(HERE / "icon.png")
    iconset = Path(tempfile.mkdtemp()) / "Today.iconset"
    iconset.mkdir()
    for px in (16, 32, 128, 256, 512):
        icon.resize((px, px), Image.LANCZOS).save(iconset / f"icon_{px}x{px}.png")
        icon.resize((px * 2, px * 2), Image.LANCZOS).save(iconset / f"icon_{px}x{px}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(HERE / "Today.icns")], check=True)
    shutil.rmtree(iconset.parent)
    off = (SIZE - BODY) // 2
    square = icon.crop((off, off, off + BODY, off + BODY))
    bg = Image.new("RGBA", square.size, SKY_TOP + (255,))
    bg.alpha_composite(square)
    bg.convert("RGB").resize((180, 180), Image.LANCZOS).save(HERE.parent / "static" / "apple-touch-icon.png", optimize=True)
    print("wrote", HERE / "Today.icns")


if __name__ == "__main__":
    main()
