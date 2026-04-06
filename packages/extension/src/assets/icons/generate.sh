#!/bin/bash
# Generate simple placeholder icons using sips (macOS built-in)
for size in 16 32 48 128; do
  # Create a simple colored square as placeholder
  python3 -c "
import struct, zlib

def create_png(size, r, g, b):
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    raw = b''
    for y in range(size):
        raw += b'\x00'
        for x in range(size):
            # Simple shield shape
            cx, cy = size/2, size/2
            dx, dy = abs(x-cx)/(size/2), (y-cy)/(size/2)
            if dx < 0.7*(1-dy*0.5) and dy < 0.8 and dy > -0.6:
                raw += bytes([r, g, b])
            else:
                raw += bytes([255, 255, 255])
    idat = chunk(b'IDAT', zlib.compress(raw))
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend

with open('src/assets/icons/icon-${size}.png', 'wb') as f:
    f.write(create_png(${size}, 220, 50, 50))
" 
done
echo "Icons generated"
