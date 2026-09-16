"""Generate the extension icons: a price tag split diagonally between two currencies.

The green half carries a white "$" (what the page quotes), the white half a green "£"
(what you get back), with a thin black keyline so the silhouette survives on a light
toolbar where the white half would otherwise dissolve into the browser chrome.

Pure standard library, so there is no font rasteriser: the glyphs are built from capsules
(round-capped bars) and stroked arcs. Geometry lives in a 0..1 square, is sampled with
supersampling, and is written out with zlib.
Run: python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

GREEN = (22, 163, 74)
WHITE = (255, 255, 255)
BLACK = (17, 17, 17)

# Tag body before rounding; the drawn shape is every point within TAG_R of it.
TAG = [(0.175, 0.245), (0.575, 0.245), (0.830, 0.500), (0.575, 0.755), (0.175, 0.755)]
TAG_R = 0.05
# The diagonal, as a*x + b*y < c. Steeper than 45 degrees on purpose: a corner-to-corner
# split leaves each glyph a thin triangle, while this gives both a roughly square area.
SPLIT = (1.6, 0.8, 1.15)
DOLLAR = (0.300, 0.470, 0.32)  # cx, cy, height before the per-size scale
POUND = (0.600, 0.525, 0.27)


def metrics(size):
    """Per-size tuning, most of it driven by how wide the keyline has to be.

    Small icons need fatter, taller glyphs to survive, and a keyline that stays about a
    pixel wide — which eats enough margin at 16px that the tag itself has to sit back a
    little, or the point runs off the canvas and the keyline breaks up along the edge.
    """
    if size <= 16:
        return dict(tag=1.04, glyph=1.16, weight=0.26)
    if size <= 32:
        return dict(tag=1.12, glyph=1.06, weight=0.22)
    return dict(tag=1.12, glyph=1.00, weight=0.20)


def geometry(scale):
    """The tag, the split and the glyph positions grown about the centre of the canvas."""
    def grow(point):
        return (0.5 + (point[0] - 0.5) * scale, 0.5 + (point[1] - 0.5) * scale)

    a, b, c = SPLIT
    return (
        [grow(v) for v in TAG],
        TAG_R * scale,
        # Scaling about the centre moves the split line's constant, not its direction.
        (a, b, scale * (c - (a + b) / 2) + (a + b) / 2),
        (*grow(DOLLAR[:2]), DOLLAR[2] * scale),
        (*grow(POUND[:2]), POUND[2] * scale),
    )


def dist_to_segment(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    span = dx * dx + dy * dy
    t = 0.0 if span == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / span))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def inside_polygon(p, verts):
    """True when p is on the same side of every edge — the polygon is convex."""
    px, py = p
    seen = 0
    for i, (ax, ay) in enumerate(verts):
        bx, by = verts[(i + 1) % len(verts)]
        cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
        if cross > 0:
            if seen < 0:
                return False
            seen = 1
        elif cross < 0:
            if seen > 0:
                return False
            seen = -1
    return True


def dist_to_polygon(p, verts):
    if inside_polygon(p, verts):
        return 0.0
    return min(dist_to_segment(p, verts[i], verts[(i + 1) % len(verts)]) for i in range(len(verts)))


def in_capsule(p, a, b, width):
    return dist_to_segment(p, a, b) <= width / 2


def on_arc(p, centre, radius, width, start, sweep):
    """A stroked arc: `sweep` degrees clockwise on screen from `start` (0 = east)."""
    dx, dy = p[0] - centre[0], p[1] - centre[1]
    if abs(math.hypot(dx, dy) - radius) > width / 2:
        return False
    return (math.degrees(math.atan2(dy, dx)) - start) % 360 <= sweep


def in_dollar(p, cx, cy, h, weight):
    r, sw = h * 0.20, h * weight
    if in_capsule(p, (cx, cy - h * 0.50), (cx, cy + h * 0.50), sw * 0.92):
        return True
    # Two bowls meeting in the middle make the S; each opens towards the other's side.
    return on_arc(p, (cx, cy - r), r, sw, 90, 260) or on_arc(p, (cx, cy + r), r, sw, 270, 260)


def in_pound(p, cx, cy, h, weight):
    sw = h * weight
    return (
        in_capsule(p, (cx - h * 0.30, cy + h * 0.40), (cx + h * 0.26, cy + h * 0.40), sw)
        or in_capsule(p, (cx - h * 0.16, cy + h * 0.40), (cx - h * 0.16, cy - h * 0.16), sw)
        or in_capsule(p, (cx - h * 0.28, cy + h * 0.06), (cx + h * 0.10, cy + h * 0.06), sw * 0.9)
        or on_arc(p, (cx + h * 0.06, cy - h * 0.16), h * 0.22, sw, 170, 200)
    )


def colour_at(p, keyline, geo, glyph, weight):
    """The colour of one sample point, or None where the icon is transparent."""
    tag, tag_r, split, dollar, pound = geo
    edge = dist_to_polygon(p, tag)
    if edge > tag_r + keyline:
        return None
    if edge > tag_r:
        return BLACK
    if split[0] * p[0] + split[1] * p[1] < split[2]:
        cx, cy, h = dollar
        return WHITE if in_dollar(p, cx, cy, h * glyph, weight) else GREEN
    cx, cy, h = pound
    return GREEN if in_pound(p, cx, cy, h * glyph, weight) else WHITE


def render(size):
    # Keep the keyline about a pixel wide at 16px without letting it bloat at 128px.
    keyline = max(0.018, 0.95 / size)
    tuning = metrics(size)
    geo = geometry(tuning["tag"])
    glyph, weight = tuning["glyph"], tuning["weight"]
    ss = 8 if size <= 32 else 4
    total = ss * ss
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            r = g = b = covered = 0
            for sy in range(ss):
                for sx in range(ss):
                    point = ((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size)
                    colour = colour_at(point, keyline, geo, glyph, weight)
                    if colour is None:
                        continue
                    r += colour[0]
                    g += colour[1]
                    b += colour[2]
                    covered += 1
            if covered == 0:
                row += bytes((0, 0, 0, 0))
                continue
            row += bytes((round(r / covered), round(g / covered), round(b / covered),
                          round(covered / total * 255)))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, pixels):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(pixels, 9)) + chunk(b"IEND", b"")


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 32, 48, 128):
        with open(os.path.join(out, f"icon{size}.png"), "wb") as f:
            f.write(png(size, render(size)))
    print("icons written to", os.path.normpath(out))


if __name__ == "__main__":
    main()
