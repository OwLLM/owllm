# Changelog

## [Unreleased]
### Added
- **3D Characters Page**: Added a new tab featuring cute 3D fantasy characters (Slime, Wizard, Knight) mapped to installed models. Features interactive "poke" and "say hi" interactions via embedded Three.js scene. Handles graceful fallback on missing assets.
- **Arena Avatar Selector**: Added a dedicated 3D avatar preview selector in Arena model settings with previous/next controls and live assignment to Arena actors.
- **Expanded Arena Model Library**: Added additional local GLB assets for richer Arena character choices.

### Changed
- **Arena UI Refactor**: Extracted Arena avatar selection logic from `main.py` into `desktop_app/widgets/character_preview_widget.py` to enforce modular boundaries and keep page construction lean.

### Removed
- **Legacy Carousel Selector**: Removed unused `desktop_app/assets/3d/carousel.html` and `desktop_app/assets/3d/carousel.js` after migrating to the dedicated selector widget.
