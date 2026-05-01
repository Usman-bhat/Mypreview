from PIL import Image
import sys

img = Image.open('debug_screenshot.jpg')
print(f"Dimensions: {img.width}x{img.height}")
