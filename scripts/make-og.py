# Generate 1200x630 og-image.png for social share previews (og:image / twitter:image)
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
INK = (13, 28, 18)        # --ink-deep
ACCENT = (196, 106, 58)   # --accent
CREAM = (251, 247, 236)   # --paper
MUTED = (160, 168, 158)

im = Image.new("RGB", (W, H), INK)
d = ImageDraw.Draw(im)

# accent baseline strip (mirrors .lhero::after)
d.rectangle([0, H - 14, W, H], fill=ACCENT)

def font(names, size):
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            continue
    return ImageFont.load_default()

georgia_it = lambda s: font([r"C:\Windows\Fonts\georgiaz.ttf", r"C:\Windows\Fonts\georgiai.ttf", r"C:\Windows\Fonts\timesi.ttf"], s)
inter_bd  = lambda s: font([r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf"], s)

# brand mark: rounded square + italic C (matches favicon.svg)
mx, my, ms = 150, 205, 170
d.rounded_rectangle([mx, my, mx + ms, my + ms], radius=42, fill=ACCENT)
fc = georgia_it(118)
bb = d.textbbox((0, 0), "C", font=fc)
d.text((mx + (ms - (bb[2] - bb[0])) / 2 - bb[0], my + (ms - (bb[3] - bb[1])) / 2 - bb[1]), "C", font=fc, fill=(255, 255, 255))

# wordmark
fw = georgia_it(132)
d.text((mx + ms + 44, my - 18), "CleanBid", font=fw, fill=(255, 255, 255))

# tagline
ft = inter_bd(34)
d.text((mx + 4, my + ms + 46), "COMMERCIAL CLEANING ESTIMATING SOFTWARE", font=ft, fill=MUTED)

# hero line
fh = georgia_it(40)
d.text((mx + 4, my + ms + 116), "Quote the building. Then win it.", font=fh, fill=CREAM)

im.save("public/og-image.png", optimize=True)
print("saved public/og-image.png", im.size)
