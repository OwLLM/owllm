# Digital Twin dimension fixtures

Both files describe the same axis-aligned cuboid and should render at the same physical size in **Source unit: Auto**.

- `known-dimensions-metres.gltf`: glTF coordinates are `0.1 × 0.2 × 0.3`; glTF defines metres, so the inspector should show `0.1 × 0.2 × 0.3 m`.
- `known-dimensions-millimetres.stl`: STL coordinates are `100 × 200 × 300`; STL has no unit metadata and OwLLM Auto defaults it to millimetres, so the inspector should show `100 × 200 × 300 mm`.

Use the matching axis presets and switch between Perspective and Orthographic to verify that projection changes without changing the reported dimensions.
