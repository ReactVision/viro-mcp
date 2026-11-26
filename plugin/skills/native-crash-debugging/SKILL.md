---
name: native-crash-debugging
description: Diagnose a ViroReact crash or runtime error on iOS, Android, Meta Quest or visionOS, including native crashes with no JavaScript logs, using the ReactVision MCP's known-issue matching and source lookups.
---

# Debugging ViroReact crashes and runtime errors

Use this when a ViroReact app crashes, shows a black or frozen AR view, or throws a runtime error.

## Collect the facts

Ask for whatever is missing:

- The full error text or crash log, including the native stack trace (Xcode console or crash report on iOS, `adb logcat` on Android and Quest).
- The platform, device and OS version, and whether it is a development or release build.
- The `@reactvision/react-viro`, `react-native` and `expo` versions.
- What the app was doing when it happened, and whether it happens every time.

## Match it against known issues

1. Call `reactviro_diagnose_error` with the error text or log. It matches curated known traps (symptom, cause, fix) and falls back to searching the docs and changelog.
2. A match means the text overlaps a known issue, not that it is the same cause. Check the explanation against what the developer sees before applying the fix.
3. Call `reactviro_changelog_since` with their version: a newer release may already fix it.
4. Release-only Android crashes: Expo SDK 58 turns R8 code shrinking on for release builds. Read the README's Android release build note (`reactviro_get_docs` with `README`) before changing ProGuard or R8 settings.

## Trace it in the source

- `reactviro_find_symbol` locates a component, function or type in the ViroReact JavaScript source, with its definition and call sites. `reactviro_get_file` returns a file, or a range of lines.
- `reactviro_find_native_bridge` turns a JavaScript prop, event or method name into the names it likely has in the native code (virocore, the Android JNI bridge, the iOS bridge). The server does not index the native code itself: give those names to the developer to search their native checkout or the crash's stack.
- Check that the feature exists on their platform with `reactviro_check_platform_support` or `reactviro_get_platform_matrix`. A component missing on a platform can look like a crash.

## Reproduce and fix

1. If the problem is in scene logic (props, state, event handlers), reproduce it in Viro Live: `reactviro_live_preview`, then `reactviro_interact_live_preview` to tap or walk through it, which returns console output and errors. Viro Live runs on the web renderer, so a native-only crash will not show there.
2. Propose the smallest change that addresses the cause, and say how the developer can confirm it on the device.
3. Validate changed scene files with `reactviro_validate_scene`.

## Report honestly

Separate what the tools established from what you infer. Do not claim a crash is fixed until the developer has run the fix on the device where it happened.
