"""Подготовка иконок из пользовательского исходника; требуется Pillow."""

from pathlib import Path

from PIL import Image, ImageOps


root = Path(__file__).resolve().parent.parent
source = Image.open(root / "assets/branding/logo-source.png").convert("RGB")
gray = ImageOps.grayscale(source)
# Отсекаем белые поля, не меняя геометрию рисунка.
bounds = gray.point(lambda value: 255 if value < 180 else 0).getbbox()
if bounds is None:
    raise ValueError("В исходнике не найден рисунок")
gray = gray.crop(bounds)
# Исходник монохромный: переносим белый фон в прозрачность с сохранением сглаживания.
alpha = gray.point(lambda value: max(0, min(255, round((255 - value) * 255 / 223))))
mark = Image.new("RGBA", gray.size, (32, 32, 32, 0))
mark.putalpha(alpha)
side = max(mark.size)
canvas = Image.new("RGBA", (side + 64, side + 64))
canvas.paste(mark, ((canvas.width - mark.width) // 2, (canvas.height - mark.height) // 2))

public = root / "public"
(public / "brand").mkdir(parents=True, exist_ok=True)
logo = canvas.resize((256, 256), Image.Resampling.LANCZOS)
logo.save(public / "brand/logo.png", optimize=True)
logo.resize((32, 32), Image.Resampling.LANCZOS).save(public / "favicon-32.png", optimize=True)
logo.save(public / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
apple = Image.new("RGBA", (180, 180), "#f6f4ed")
apple.alpha_composite(canvas.resize((160, 160), Image.Resampling.LANCZOS), (10, 10))
apple.convert("RGB").save(public / "apple-touch-icon.png", optimize=True)
