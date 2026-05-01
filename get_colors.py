from PIL import Image
import collections

img = Image.open('debug_screenshot.jpg')
colors = img.getcolors(maxcolors=100000)
if colors:
    sorted_colors = sorted(colors, key=lambda x: x[0], reverse=True)
    for count, color in sorted_colors[:5]:
        print(f"Color: {color}, Count: {count}")
else:
    print("Too many colors")
