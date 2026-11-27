"""Compact decorative assets for Fumo Hop, generated with Python's standard library."""
from functools import lru_cache
from io import BytesIO
import math
import struct
import zlib

import discord

BANNER_NAME = 'hop-banner.png'
MASCOT_NAME = 'hop-mascot.png'


def _png_bytes(width, height, pixel_fn):
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            r, g, b = pixel_fn(x, y)
            rows.extend((max(0, min(255, int(r))), max(0, min(255, int(g))), max(0, min(255, int(b)))))

    def chunk(kind, data):
        return (struct.pack('!I', len(data)) + kind + data
                + struct.pack('!I', zlib.crc32(kind + data) & 0xFFFFFFFF))

    signature = bytes([137, 80, 78, 71, 13, 10, 26, 10])
    return (signature
            + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(rows), 9))
            + chunk(b'IEND', b''))


@lru_cache(maxsize=1)
def banner_bytes():
    width, height = 1200, 96

    def pixel(x, y):
        t = x / (width - 1)
        glow = max(0.0, 1.0 - math.hypot(x - width * 0.75, (y - height * 0.45) * 3.2) / 540)
        r = 8 + 8 * glow
        g = 31 + 38 * t + 34 * glow
        b = 23 + 14 * glow
        if 0 <= y <= 1 or height - 2 <= y <= height - 1:
            return 42, 168, 116
        if 42 <= y <= 54 and 48 <= x <= 72:
            return 130, 255, 196
        if 28 <= x <= 98 and (y in (20, 21, 74, 75) or x in (28, 29, 97, 98)):
            return 104, 247, 182
        if 116 <= x <= 224 and y in (47, 48, 49):
            return 118, 247, 186
        if 340 < x < 1160 and (x - 2 * y) % 210 in (0, 1):
            return 26, 99, 72
        return r, g, b

    return _png_bytes(width, height, pixel)


@lru_cache(maxsize=1)
def mascot_bytes():
    width = height = 180

    def pixel(x, y):
        # soft mint background
        d = math.hypot(x - 90, y - 90)
        bg = max(0.0, 1.0 - d / 120)
        r = 28 + 18 * bg
        g = 64 + 54 * bg
        b = 50 + 28 * bg

        # hair
        if ((x - 90) / 58) ** 2 + ((y - 98) / 56) ** 2 <= 1:
            r, g, b = 212, 194, 241
        # face
        if ((x - 90) / 42) ** 2 + ((y - 100) / 38) ** 2 <= 1:
            r, g, b = 246, 239, 228
        # ears
        if ((x - 58) / 15) ** 2 + ((y - 40) / 24) ** 2 <= 1 or ((x - 122) / 15) ** 2 + ((y - 40) / 24) ** 2 <= 1:
            r, g, b = 246, 239, 228
        if ((x - 58) / 8) ** 2 + ((y - 43) / 14) ** 2 <= 1 or ((x - 122) / 8) ** 2 + ((y - 43) / 14) ** 2 <= 1:
            r, g, b = 244, 178, 200
        # bow
        if ((x - 90) / 12) ** 2 + ((y - 35) / 8) ** 2 <= 1:
            r, g, b = 241, 246, 156
        # eyes
        if ((x - 74) / 8) ** 2 + ((y - 98) / 12) ** 2 <= 1 or ((x - 106) / 8) ** 2 + ((y - 98) / 12) ** 2 <= 1:
            r, g, b = 191, 42, 79
        if ((x - 76) / 2.8) ** 2 + ((y - 94) / 4.3) ** 2 <= 1 or ((x - 108) / 2.8) ** 2 + ((y - 94) / 4.3) ** 2 <= 1:
            r, g, b = 255, 255, 255
        # mouth
        if abs(y - 120) <= 1 and 84 <= x <= 96:
            r, g, b = 145, 88, 102
        return r, g, b

    return _png_bytes(width, height, pixel)


def banner_file():
    return discord.File(BytesIO(banner_bytes()), filename=BANNER_NAME)


def mascot_file():
    return discord.File(BytesIO(mascot_bytes()), filename=MASCOT_NAME)
