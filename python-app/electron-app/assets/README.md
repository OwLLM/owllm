# Icon Assets

This directory contains the application icons for all platforms.

## Files

- `icon.svg` - Source vector icon
- `icon.png` - Linux icon (512x512)
- `icon.ico` - Windows icon (multi-resolution)
- `icon.icns` - macOS icon (multi-resolution)

## Generating Icons

### Automatic Generation

Run the appropriate script for your platform:

**Windows:**
```batch
generate_icons.bat
```

**Linux/macOS:**
```bash
chmod +x generate_icons.sh
./generate_icons.sh
```

### Requirements

- **ImageMagick**: https://imagemagick.org/
- **librsvg2** (Linux): `sudo apt-get install librsvg2-bin`
- **Homebrew** (macOS): `brew install imagemagick librsvg`

### Manual Creation

You can also create icons manually:

1. **Windows .ico**: Use https://www.icoconverter.com/
2. **macOS .icns**: Use https://iconverticons.com/
3. **Linux .png**: Any 512x512 PNG image

## Current Icon

The icon uses the LLM Studio gradient colors:
- Start: #667eea (purple-blue)
- End: #764ba2 (purple)

The design features "LLM" text on a gradient circle background with "STUDIO" subtitle.

