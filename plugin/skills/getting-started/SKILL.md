---
name: getting-started
description: Start here. Connect to ReactVision, pick the skill that fits the task, and build, validate and render ViroReact XR scenes with the ReactVision MCP.
---

# ReactVision XR Builder

Use the `reactvision-viro` MCP server as the current source of truth for ViroReact APIs, supported platforms, examples, validation, and rendering. Do not invent component names, props, platform support, test outcomes, or MCP capabilities.

## Connect first

The hosted MCP requires a ReactVision Studio account. The user signs in and chooses a Studio team to attribute usage. Direct them to https://studio.reactvision.xyz/auth/register if they need an account, and explain that tool calls use the AI budget of the team they chose: lookups use little, Viro Live previews more, and image and 3D model generation the most. Environment renders are billed to the team separately, as compute time. `reactviro_get_usage` shows how much of the budget is used and is always available. Never request or store their password or access token in chat or package files.

## Other skills

Follow the matching skill when the task is one of these:

- `project-setup`: installing ViroReact in an Expo or React Native app, or targeting a new platform.
- `viro-live-preview`: showing a scene in Viro Live and keeping it in step with the code.
- `performance-review`: a slow or heavy scene, or a check before shipping.
- `viroreact-upgrade`: moving to a newer ViroReact release.
- `native-crash-debugging`: crashes and runtime errors on a device.
- `eighthwall-migration`: moving an 8th Wall project to ViroReact.

## Start by understanding the goal

When the request does not already specify the experience, ask what it should do. Gather only the details needed to begin:

- The experience and its main interaction.
- Target platforms (iOS, Android, Meta Quest, visionOS, or web where supported).
- Whether the project uses Expo, React Native CLI, or ReactVision Studio.
- Existing scene/code, assets, and any constraints such as performance or accessibility.

If a detail is unknown, offer a sensible default and keep moving. Do not ask the user to repeat details already supplied.

## Explain ReactVision documentation and examples

- Start with `reactviro_get_overview` when the user is exploring the MCP or is unsure where to look.
- Use `reactviro_get_docs` for indexed guides and framework docs, `reactviro_search` for targeted questions, and component/prop lookups for API details.
- Use `reactviro_list_examples` (pass `component` for the examples that use one) and `reactviro_get_example` to find and explain real showcase patterns. Summarize how an example works before adapting it; do not imply an example is a complete production app if it is only a scene.
- Explain what is established by current docs or code and label any inference. Link to ReactVision docs when useful.

## Build or change a scene

1. For new or unfamiliar work, call `reactviro_get_overview` and consult relevant indexed docs, component props, platform matrix, or examples. Prefer specific lookups over guessing.
2. For new scenes, write the TSX yourself from the props `reactviro_get_component_props` returns and the closest showcase examples (`reactviro_list_examples`, then `reactviro_get_example`), then check it with `reactviro_validate_scene`.
3. Explain assumptions and preserve the user's existing architecture. Return complete, usable code or a focused patch and identify any assets or project wiring required.
4. Do not claim the MCP edited the user's local project unless an available tool actually did so.

## Show the scene with Viro Live

Viro Live is ReactVision's live scene preview; call it that when you talk to the user. When the user wants to see a scene, or after you change one, open it with `reactviro_live_preview`, and change an open preview with `reactviro_update_live_preview` rather than opening another. The `viro-live-preview` skill has the details: which files to pass, assets, checking changes yourself, and the Inspect panel.

## Validate and test

1. Call `reactviro_validate_scene` on the relevant TSX with `platforms` set to each requested target. Treat it as component-name and prop-shape validation, not a full TypeScript check, and resolve or clearly report what a platform does not support.
2. When the scene references assets, read the asset list in `reactviro_validate_scene`'s result. Use `reactviro_check_performance_budget` for applicable model URLs; state its format and budget limits. For a slow or heavy scene, follow the `performance-review` skill.
3. To show the developer a scene, use Viro Live (above), and check an open preview with `reactviro_screenshot_live_preview` or `reactviro_interact_live_preview` (taps, camera walks, animations). `reactviro_render_scene` is for what Viro Live does not take: a Studio scene as JSON (`format: "studio_json"`), or a quick check of one self-contained TSX string with no preview open. It substitutes placeholders for local assets unless real asset URLs are provided.
4. Before selecting a project, environment, or team asset, call `reactviro_list_studio_content` and use its returned IDs. Do not guess IDs.
5. To see a scene composited over a recorded AR session, use `reactviro_create_environment_render` for a Studio scene or team assets, or `reactviro_create_code_environment_render` then `reactviro_start_code_environment_render` for a local code bundle. From a chat, the Viro Live preview's "Render in a real space" panel does the same for the previewed scene. Follow up with `reactviro_get_environment_render` (or `reactviro_list_environment_renders`) for status and output. These runs are billed to the user's team: before starting one, say which scene and environment it will use and wait for the user to confirm. If a tool refuses the run, relay its message as written.
6. Report actual tool results and limitations. Distinguish static validation from rendering, and rendering from testing on a physical device. Never claim device testing unless it occurred.

## Generate assets

`reactviro_generate_image` and `reactviro_generate_3d_model` save their output to the team's Studio asset library and are billed to the team. Confirm the prompt and quality with the user before calling either, and use the default quality unless they ask for more. 3D generation is asynchronous: poll `reactviro_get_3d_model_task` until it completes, then report the triangle count and any platform it flags as over budget before placing the model in a scene. `reactviro_get_usage` reports how much of the team's budget is used.

## Move between Studio and code

To convert a Studio scene to code, pass its `scene_id` from `reactviro_list_studio_content` to `reactviro_studio_to_tsx`. It is a best-effort conversion; state what did not carry across (Studio's visual scripting, and anything else in its warnings). For an 8th Wall project, follow the `eighthwall-migration` skill.

## Troubleshoot

Use `reactviro_diagnose_error` for ViroReact runtime errors and consult current docs or source for API questions. Explain when a reported issue is a tool's heuristic or static check rather than a runtime guarantee. For crashes, black AR views and native errors, follow the `native-crash-debugging` skill.
