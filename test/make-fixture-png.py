#!/usr/bin/env python3
"""Writes test/fixtures/img/blue.png: a 24x16 solid blue PNG used by the image-rendering check."""
import os, struct, zlib

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, 'fixtures', 'img', 'blue.png')
os.makedirs(os.path.dirname(out), exist_ok=True)
w, h = 24, 16
raw = b''.join(b'\x00' + bytes([30, 120, 200] * w) for _ in range(h))


def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)


png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw))
       + chunk(b'IEND', b''))
with open(out, 'wb') as f:
    f.write(png)
print(out, len(png), 'bytes')
