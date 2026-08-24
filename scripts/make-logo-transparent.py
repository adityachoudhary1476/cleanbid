"""Remove the flat orange background from LOGO.png by flood-filling from the
borders, then save a transparent version to public/logo.png. Only background
pixels connected to an edge are removed, so interior artwork is untouched."""
from PIL import Image
from collections import deque

img = Image.open("LOGO.png").convert("RGBA")
w, h = img.size
px = img.load()

target = px[0, 0][:3]
TOL = 14

def is_bg(c):
    return (abs(c[0] - target[0]) <= TOL
            and abs(c[1] - target[1]) <= TOL
            and abs(c[2] - target[2]) <= TOL)

seen = bytearray(w * h)
q = deque()
for x in range(w):
    q.append((x, 0))
    q.append((x, h - 1))
for y in range(h):
    q.append((0, y))
    q.append((w - 1, y))

removed = 0
while q:
    x, y = q.popleft()
    if x < 0 or y < 0 or x >= w or y >= h:
        continue
    idx = y * w + x
    if seen[idx]:
        continue
    seen[idx] = 1
    r, g, b, a = px[x, y]
    if is_bg((r, g, b)):
        px[x, y] = (r, g, b, 0)
        removed += 1
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

total = w * h
print(f"size: {w}x{h}")
print(f"bg color: #%02x%02x%02x" % target)
print(f"removed {removed} of {total} px ({removed / total:.1%})")

# sanity: corners must now be transparent
print("corner alpha now:", px[0, 0][3], px[w-1, h-1][3])

img.save("public/logo.png")
print("saved -> public/logo.png")
