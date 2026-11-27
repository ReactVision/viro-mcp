---
name: viro-live-preview
description: Show a ViroReact scene in Viro Live, ReactVision's live 3D preview of the developer's own code, keep it in step with code changes, check changes yourself, and act on what the developer selects in it.
---

# Viro Live preview

Viro Live is ReactVision's live scene preview; call it that when you talk to the developer. It runs their actual scene code in an interactive 3D view, without a phone.

## Open a preview

Call `reactviro_live_preview` when the developer wants to see a scene, or after you write or change one.

- Read the files from the project and pass them as `files`, keyed by path from the project root.
- `entry` is the scene file whose default export is the `ViroARScene` or `ViroScene` (for example `components/ar-scenes/OpeningScene.tsx`). It is not an app entry that pulls in expo-router or native UI.
- Include every local file the entry imports, directly or through scenes it navigates to. If the tool names a missing file, add it and call again.
- To let the developer look through the app rather than one scene, also pass the other scene files in `scenes`, with the files they import. The preview opens on `entry` and offers the rest in a scene picker.

## Assets

Local models and images show as placeholders until the preview has the real files.

- With a shell (Claude Code, Codex, Cursor), upload each one to `https://mcp.reactvision.xyz` with the `curl -T` command in the tool's result; the open preview swaps to it.
- Without a shell, or when the developer has public URLs for them (a CDN, or Studio team assets from `reactviro_list_studio_content`), pass them in `assets`, keyed by the same root-relative path.

## Where it shows

- In Claude and ChatGPT the preview runs inline in the conversation where the host allows it; otherwise the view says so and offers a link.
- Where views are not shown (Claude Code in a terminal, Codex), give the developer the returned URL to open in a browser.

## Keep it in step with the code

- After changing a previewed scene, call `reactviro_update_live_preview` with the `preview_id` and only what changed: `edits` (text replacements) for small changes, `files` for new or rewritten files. The open preview swaps to the new code in place.
- Do not call `reactviro_live_preview` again for a change: it opens a second view and sends every file again.
- If an update reports a compile error, fix it and update again. The preview keeps showing the last version that compiled.

## Check a change yourself

- `reactviro_screenshot_live_preview` returns pictures of the preview's current code: from the starting camera, from a side of the content (`front`, `back`, `left`, `right`, `top`), or from a position you give. It is a fresh render, not the developer's open view. Use it when how the scene looks matters, not after every change.
- `reactviro_interact_live_preview` taps, walks the camera and waits, then returns pictures, the camera at each, the scene's console output and errors. Use it to check what a scene does: `onClick`, placing content on a plane, proximity, animations. Take a screenshot step first to see where to tap.
- Once the preview is open, hand it to the developer and stop. Do not open it in a browser or click through its scenes unless they ask.

## The Inspect panel

- When the developer selects a node in Inspect, you are told which element it is (its component, file and line) and where it is. "This" or "the selected node" means that element.
- The panel shows the developer the scene's frame rate, draw calls, triangles and texture memory, each model's triangles against the platform budgets, and the selected node's position, rotation, bounds, materials, animation and events. Of those you are sent only the selected element's position and, for a model, its triangles and budget check. Ask the developer for the rest when it matters.

## Errors and warnings

The preview reports its runtime errors and warnings to you. Fix what they point at. A warning that a component or `dragType` has no web implementation describes the preview, not the device: say so rather than changing the code for it.

## Seeing it in a real space

- The preview page has a "Render in a real space" panel that starts an environment render of the previewed scene, billed to the team. Local models that were neither uploaded nor given a URL are drawn as boxes. Mention it when the developer wants to see the scene in a real space.
- From a shell, `reactviro_create_code_environment_render` then `reactviro_start_code_environment_render` do the same for a code bundle; pick the environment with `reactviro_list_studio_content`. Say which scene and environment will be used and wait for the developer to confirm before starting, since renders are billed to the team.

## Report honestly

A preview is a web rendering of the scene, not a test on a physical device. Never claim device testing that did not happen.
