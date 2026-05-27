#!/bin/bash
# Script to generate icons from SVG using ImageMagick or rsvg-convert
# Install: sudo apt-get install imagemagick librsvg2-bin (Ubuntu/Debian)
#         brew install imagemagick librsvg (macOS)

echo "Generating icons from icon.svg..."

# Generate PNG at different sizes using rsvg-convert (better quality)
if command -v rsvg-convert &> /dev/null; then
    rsvg-convert -w 512 -h 512 icon.svg -o icon.png
    rsvg-convert -w 256 -h 256 icon.svg -o icon-256.png
    rsvg-convert -w 128 -h 128 icon.svg -o icon-128.png
    rsvg-convert -w 64 -h 64 icon.svg -o icon-64.png
    rsvg-convert -w 32 -h 32 icon.svg -o icon-32.png
    rsvg-convert -w 16 -h 16 icon.svg -o icon-16.png
elif command -v convert &> /dev/null; then
    # Fallback to ImageMagick
    convert -background none icon.svg -resize 512x512 icon.png
    convert -background none icon.svg -resize 256x256 icon-256.png
    convert -background none icon.svg -resize 128x128 icon-128.png
    convert -background none icon.svg -resize 64x64 icon-64.png
    convert -background none icon.svg -resize 32x32 icon-32.png
    convert -background none icon.svg -resize 16x16 icon-16.png
else
    echo "Error: Neither rsvg-convert nor ImageMagick convert found!"
    echo "Install with: sudo apt-get install librsvg2-bin imagemagick"
    exit 1
fi

# Generate Windows ICO (multi-resolution)
if command -v convert &> /dev/null; then
    convert icon-16.png icon-32.png icon-64.png icon-128.png icon-256.png icon.ico
    echo "Windows .ico created: icon.ico"
fi

# Generate macOS ICNS
if command -v png2icns &> /dev/null; then
    png2icns icon.icns icon-*.png
    echo "macOS .icns created: icon.icns"
elif [ "$(uname)" == "Darwin" ]; then
    # Use iconutil on macOS
    mkdir -p icon.iconset
    cp icon-16.png icon.iconset/icon_16x16.png
    cp icon-32.png icon.iconset/icon_16x16@2x.png
    cp icon-32.png icon.iconset/icon_32x32.png
    cp icon-64.png icon.iconset/icon_32x32@2x.png
    cp icon-128.png icon.iconset/icon_128x128.png
    cp icon-256.png icon.iconset/icon_128x128@2x.png
    cp icon-256.png icon.iconset/icon_256x256.png
    cp icon.png icon.iconset/icon_256x256@2x.png
    cp icon.png icon.iconset/icon_512x512.png
    iconutil -c icns icon.iconset
    rm -rf icon.iconset
    echo "macOS .icns created: icon.icns"
fi

echo "Linux .png created: icon.png"
echo "Done! Icon files generated."

