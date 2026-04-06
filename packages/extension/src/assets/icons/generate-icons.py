import struct, zlib, math

def create_png(size):
    """Generate a shield icon with RA(I) branding - dark red shield with eye motif"""
    pixels = []
    cx, cy = size / 2, size / 2.1
    
    for y in range(size):
        row = []
        for x in range(size):
            # Normalized coords
            nx = (x - cx) / (size / 2)
            ny = (y - cy) / (size / 2)
            
            # Shield shape: wider at top, pointed at bottom
            top_width = 0.75
            shield_top = -0.65
            shield_bottom = 0.85
            
            if ny < shield_top or ny > shield_bottom:
                row.append((0, 0, 0, 0))  # transparent
                continue
            
            # Shield width narrows toward bottom
            progress = (ny - shield_top) / (shield_bottom - shield_top)
            if progress < 0.4:
                width = top_width
            else:
                t = (progress - 0.4) / 0.6
                width = top_width * (1 - t * t)
            
            if abs(nx) > width:
                row.append((0, 0, 0, 0))  # transparent
                continue
            
            # Inside shield
            # Edge highlight (lighter border)
            edge_dist = min(abs(abs(nx) - width), abs(ny - shield_top), abs(ny - shield_bottom))
            edge_norm = edge_dist / (size / 2) * size
            
            if edge_norm < 1.5:
                # Border
                row.append((180, 40, 40, 255))
            else:
                # Fill - dark red gradient
                base_r = int(160 - progress * 30)
                base_g = int(30 - progress * 10)
                base_b = int(30 - progress * 10)
                
                # Eye of Ra motif - simple circle in upper center
                eye_cx, eye_cy = 0, -0.15
                eye_dist = math.sqrt((nx - eye_cx)**2 + ((ny - eye_cy) * 1.3)**2)
                
                if eye_dist < 0.22:
                    if eye_dist < 0.1:
                        # Inner eye - bright gold
                        row.append((255, 200, 60, 255))
                    elif eye_dist < 0.15:
                        # Eye ring - darker gold
                        row.append((220, 160, 40, 255))
                    else:
                        # Eye outer - dark
                        row.append((100, 20, 20, 255))
                else:
                    row.append((base_r, base_g, base_b, 255))
        
        pixels.append(row)
    
    # Encode as PNG with alpha
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))  # 6 = RGBA
    
    raw = b''
    for row in pixels:
        raw += b'\x00'  # filter byte
        for r, g, b, a in row:
            raw += bytes([r, g, b, a])
    
    idat = chunk(b'IDAT', zlib.compress(raw, 9))
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend

for size in [16, 32, 48, 128]:
    with open(f'/Users/ich/rai-extension/src/assets/icons/icon-{size}.png', 'wb') as f:
        f.write(create_png(size))
    print(f'Generated icon-{size}.png')
