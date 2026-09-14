"""Generate the extension icons (green rounded square with white exchange arrows).

Pure standard library: rasterises with 4x4 supersampling and writes PNGs with zlib.
Run: python3 tools/make_icons.py
"""
import os
import struct
import zlib

GREEN = (22, 163, 74)
WHITE = (255, 255, 255)
SS = 4


def in_rounded_square(x, y, radius=0.22):
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1, d2, d3 = sign((px, py), a, b), sign((px, py), b, c), sign((px, py), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def in_arrows(x, y):
    # Top arrow pointing right
    if 0.22 <= x <= 0.62 and 0.305 <= y <= 0.405:
        return True
    if in_triangle(x, y, (0.58, 0.20), (0.80, 0.355), (0.58, 0.51)):
        return True
    # Bottom arrow pointing left
    if 0.38 <= x <= 0.78 and 0.595 <= y <= 0.695:
        return True
    if in_triangle(x, y, (0.42, 0.49), (0.20, 0.645), (0.42, 0.80)):
        return True
    return False


def render(size):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            bg = fg = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    if in_rounded_square(x, y):
                        if in_arrows(x, y):
                            fg += 1
                        else:
                            bg += 1
            total = SS * SS
            alpha = (bg + fg) / total
            if alpha == 0:
                row += bytes((0, 0, 0, 0))
                continue
            mix = fg / (bg + fg)
            color = [round(GREEN[i] * (1 - mix) + WHITE[i] * mix) for i in range(3)]
            row += bytes((*color, round(alpha * 255)))
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
