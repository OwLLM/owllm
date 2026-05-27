@echo off
REM Script to generate icons from SVG using ImageMagick
REM Install ImageMagick: https://imagemagick.org/script/download.php

echo Generating icons from icon.svg...

REM Generate PNG at different sizes
magick convert -background none icon.svg -resize 512x512 icon.png
magick convert -background none icon.svg -resize 256x256 icon-256.png
magick convert -background none icon.svg -resize 128x128 icon-128.png
magick convert -background none icon.svg -resize 64x64 icon-64.png
magick convert -background none icon.svg -resize 32x32 icon-32.png
magick convert -background none icon.svg -resize 16x16 icon-16.png

REM Generate Windows ICO (multi-resolution)
magick convert icon-16.png icon-32.png icon-64.png icon-128.png icon-256.png icon.ico

REM Generate macOS ICNS (requires png2icns or iconutil)
REM For now, just use the 512px PNG - Electron will handle it
echo Windows .ico created: icon.ico
echo Linux .png created: icon.png
echo For macOS .icns, use: png2icns icon.icns icon-*.png

echo.
echo Done! Icon files generated.
echo Note: You may need to install ImageMagick for this script to work.

