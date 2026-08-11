#!/usr/bin/env python3
"""Draw the webossh app icons and the README banner.

Everything the brand is made of is already in the repo — the accent green from
styles.css, the display face the login screen sets its wordmark in — so the
artwork is generated from those rather than drawn by hand somewhere else and
pasted in. Re-run it after a palette or wordmark change; the outputs are
committed so a normal build needs neither Python nor the fonts.

    pip install pillow fonttools brotli
    python3 scripts/gen-brand.py

The mark is the app itself, in miniature: a terminal panel lying over another
window, because that is the one thing this app does that a phone SSH client does
not. Inside it the wordmark, not the `>_` every terminal icon on every platform
already uses.
"""
import io
import os
import sys

from PIL import Image, ImageDraw, ImageFont, ImageFilter

try:
    from fontTools.ttLib import TTFont
except ImportError:  # pragma: no cover - tooling hint, not app code
    sys.exit("needs fonttools + brotli to read the bundled .woff2 fonts")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "assets", "fonts")
BRAND_DIR = os.path.join(ROOT, "docs", "brand")

# styles.css :root — keep in step with it.
INK_TOP = (13, 17, 23)
INK_BOT = (4, 6, 9)
TEXT_1 = (233, 236, 239)
TEXT_2 = (154, 161, 170)
ACCENT = (115, 255, 154)
ACCENT_DIM = (58, 164, 104)

S = 1024  # the icon is drawn at 8x the small size and downsampled with LANCZOS


def font(name, size):
    """Load one of the bundled woff2 faces at `size`, via an in-memory TTF."""
    f = TTFont(os.path.join(FONT_DIR, f"{name}.woff2"))
    f.flavor = None
    buf = io.BytesIO()
    f.save(buf)
    buf.seek(0)
    return ImageFont.truetype(buf, size)


def plate(size, radius_frac=0.22, glow=True):
    """Rounded dark plate: vertical gradient, lit from the upper left."""
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / (size - 1)
        gd.line([(0, y), (size, y)],
                fill=tuple(round(INK_TOP[i] + (INK_BOT[i] - INK_TOP[i]) * t) for i in range(3)) + (255,))
    if glow:
        g = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(g).ellipse([-size * 0.35, -size * 0.45, size * 0.75, size * 0.55],
                                  fill=ACCENT + (24,))
        grad = Image.alpha_composite(grad, g.filter(ImageFilter.GaussianBlur(size * 0.12)))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1],
                                           radius=int(size * radius_frac), fill=255)
    out.paste(grad, (0, 0), mask)
    return out


def mark():
    """The icon at working size."""
    img = plate(S)
    d = ImageDraw.Draw(img)

    # The window underneath — only its corner shows, which is the whole point:
    # this terminal does not replace what you were watching.
    d.rounded_rectangle([S * 0.10, S * 0.10, S * 0.70, S * 0.60], radius=int(S * 0.05),
                        outline=(255, 255, 255, 40), width=int(S * 0.010))

    panel = [S * 0.22, S * 0.30, S * 0.90, S * 0.84]
    radius = int(S * 0.05)

    # Cast shadow, so the panel reads as floating rather than as a second outline.
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [panel[0], panel[1] + S * 0.025, panel[2], panel[3] + S * 0.025],
        radius=radius, fill=(0, 0, 0, 170))
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(S * 0.03)))

    # Accent bloom under the border: OLED panels make this read as emitted light,
    # and it keeps the outline from looking like a sticker at large sizes.
    bloom = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(bloom).rounded_rectangle(panel, radius=radius, outline=ACCENT + (150,),
                                            width=int(S * 0.03))
    img = Image.alpha_composite(img, bloom.filter(ImageFilter.GaussianBlur(S * 0.02)))

    d = ImageDraw.Draw(img)
    d.rounded_rectangle(panel, radius=radius, fill=(7, 9, 12, 250), outline=ACCENT + (255,),
                        width=int(S * 0.016))
    # The app's own 34px toolbar, abstracted to one hairline.
    ty = panel[1] + S * 0.085
    d.line([panel[0] + S * 0.035, ty, panel[2] - S * 0.035, ty], fill=ACCENT_DIM + (210,),
           width=int(S * 0.006))

    # Wordmark + block cursor, centred in what is left below the toolbar.
    f = font("MajorMonoDisplay-Regular", int(S * 0.24))
    text = "sh"
    box = d.textbbox((0, 0), text, font=f)
    tw, th = box[2] - box[0], box[3] - box[1]
    cursor_w, gap = S * 0.075, S * 0.035
    x = (panel[0] + panel[2]) / 2 - (tw + gap + cursor_w) / 2 - box[0]
    cy = (ty + panel[3]) / 2
    d.text((x, cy - th / 2 - box[1]), text, font=f, fill=ACCENT + (255,))
    bx = x + box[0] + tw + gap
    d.rectangle([bx, cy - S * 0.062, bx + cursor_w, cy + S * 0.062], fill=ACCENT + (255,))
    return img


def banner(icon):
    """README header: the mark, the wordmark, the tagline, on one dark plate."""
    W, H = 1280, 360
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    grad = Image.new("RGBA", (W, H))
    gd = ImageDraw.Draw(grad)
    # Darker than the icon's own plate at every point, so the mark sits ON the
    # banner instead of dissolving into it.
    for x in range(W):
        t = x / (W - 1)
        gd.line([(x, 0), (x, H)],
                fill=tuple(round(INK_BOT[i] + (2 - 2 * t)) for i in range(3)) + (255,))
    # The glow belongs behind the wordmark, not behind the mark.
    g = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(g).ellipse([W * 0.22, -H * 0.8, W * 0.95, H * 1.0], fill=ACCENT + (16,))
    grad = Image.alpha_composite(grad, g.filter(ImageFilter.GaussianBlur(110)))
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], radius=28, fill=255)
    img.paste(grad, (0, 0), mask)

    side = 200
    small = icon.resize((side, side), Image.LANCZOS)
    img.paste(small, (88, (H - side) // 2), small)

    d = ImageDraw.Draw(img)
    x = 88 + side + 72
    wf = font("MajorMonoDisplay-Regular", 92)
    # "webOS" in text, "sh" in accent — the same split the login screen makes.
    left, right = "webos", "sh"
    lbox = d.textbbox((0, 0), left, font=wf)
    y = 96
    d.text((x - lbox[0], y), left, font=wf, fill=TEXT_1)
    # No extra gap: the face is monospaced and already carries its own sidebearing,
    # and a hand-added one turns one word into two.
    d.text((x - lbox[0] + d.textlength(left, font=wf), y), right, font=wf, fill=ACCENT)

    d.line([x, y + 132, x + 46, y + 132], fill=ACCENT + (190,), width=2)

    tf = font("JetBrainsMono-Regular", 26)
    d.text((x, y + 158), "Secure shell for the living room.", font=tf, fill=TEXT_2)
    return img


def main():
    os.makedirs(BRAND_DIR, exist_ok=True)
    icon = mark()
    icon.save(os.path.join(BRAND_DIR, "icon-512.png"))
    # webOS reads these two: 80px in the launcher, 130px where it wants a large one.
    icon.resize((80, 80), Image.LANCZOS).save(os.path.join(ROOT, "icon.png"))
    icon.resize((130, 130), Image.LANCZOS).save(os.path.join(ROOT, "icon-large.png"))
    banner(icon).save(os.path.join(BRAND_DIR, "banner.png"))
    for p in ("icon.png", "icon-large.png", "docs/brand/icon-512.png", "docs/brand/banner.png"):
        print(f"  wrote {p}")


if __name__ == "__main__":
    main()
