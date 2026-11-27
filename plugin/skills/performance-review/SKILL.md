---
name: performance-review
description: Find why a ViroReact scene is slow or heavy (models, textures, draw calls, lights) and fix it, using the ReactVision MCP's budget checks and Viro Live's Inspect figures.
---

# ViroReact performance review

Use this when a scene stutters, loads slowly, runs hot, crashes on a low-end device or on Meta Quest, or when the developer wants a scene checked before shipping. Measure first, then change the biggest cost, then measure again.

## Gather the numbers

1. Ask which platforms the scene targets. Meta Quest has the tightest budgets.
2. Call `reactviro_validate_scene` on each scene file. Its result lists the scene's models, textures and sounds, local and remote.
3. Call `reactviro_check_performance_budget` with the remote GLB and glTF URLs (up to 10 a call) and the target platforms (`quest`, `mobile-ar`, `visionos`, `web`). It reports triangles and texture size against rough per-platform budgets.
   - It reads GLB, and glTF with embedded buffers only. A glTF with an external `.bin`, and VRX, FBX and OBJ, are reported as unsupported, not measured.
   - Its budgets are rough guidance: "within budget" means no obvious problem, "over budget" means worth a look. Say so when you report them.
4. Open the scene in Viro Live (`reactviro_live_preview`) and ask the developer to open Inspect. It shows the frame rate, draw calls, triangles and texture memory of the last frame, each model's triangles against the budgets, and the parts inside a selected model with their triangle counts. Ask them for the figures; you are not sent them, except for a model they select.
5. The preview's frame rate is the browser's, not the device's. Use it to compare before and after a change, not as the device's number.

## Common costs and what to do

- **Too many triangles** in a model: reduce it in the modelling tool or with a glTF optimiser, or use a lower-detail version for the target. The part list in Inspect shows which part carries the triangles.
- **Large textures**: a 4096 px texture costs about 16 times a 1024 px one. Resize textures to what the object's size on screen needs.
- **Many draw calls**: each mesh and material is at least one. Merge static meshes that share a material, and reuse materials instead of near-duplicates.
- **Lights and shadows**: each shadow-casting light adds a render pass. Keep shadows to the lights that need them.
- **Meta Quest**: check the scene against `reactviro_get_platform_matrix` and the Quest setup doc (`reactviro_get_docs` with `QUEST_SETUP`) before tuning, since some effects behave differently there.
- **Off-screen or hidden content** still loads. Load models when they are needed, not all at scene start.

Look up any prop or component you recommend with `reactviro_get_component_props` or `reactviro_search`; do not suggest a prop the tools do not show.

## Check the change

After each change, call `reactviro_update_live_preview`, ask the developer for the new Inspect figures, and rerun `reactviro_check_performance_budget` for a changed model. Report the before and after numbers.

## Report honestly

Say which numbers came from the budget check, which from the preview, and that neither is a measurement on the device. Recommend profiling on the target device before shipping; never claim device performance that was not measured.
