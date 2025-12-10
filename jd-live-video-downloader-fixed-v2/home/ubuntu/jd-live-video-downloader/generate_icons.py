from PIL import Image
import os

sizes = [16, 48, 128]
icon_dir = "icons"

# 确保图标目录存在
os.makedirs(icon_dir, exist_ok=True)

for size in sizes:
    # 创建一个纯蓝色的图片 (RGB: 0, 0, 255)
    img = Image.new('RGB', (size, size), color = 'blue')
    path = os.path.join(icon_dir, f"icon{size}.png")
    img.save(path, 'PNG')
    print(f"Generated {path}")

# 额外创建一个 1x1 的透明 PNG 占位符，以防万一
img_1x1 = Image.new('RGBA', (1, 1), color = (0, 0, 0, 0))
img_1x1.save(os.path.join(icon_dir, "icon1.png"), 'PNG')
