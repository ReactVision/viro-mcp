---
name: viroreact-upgrade
description: Upgrade a project to a newer ViroReact (@reactvision/react-viro) release. List what changed since the installed version, find the code it affects, and update it.
---

# Upgrading ViroReact

Use this when the developer wants to move to a newer `@reactvision/react-viro`, or asks what changed since their version.

## Find where they are

1. Read `@reactvision/react-viro` from the project's `package.json` (and the lockfile for the exact version), along with `react-native`, `expo` if present, and any `@reactvision/*` packages.
2. Call `reactviro_changelog_since` with the installed version. It returns every changelog entry from that version to the newest.
3. Read the release notes with `reactviro_get_docs` (`RELEASE_NOTES`, and `README` for the supported React Native and Expo versions). If the project uses the web renderer, visionOS or Quest, read their notes too (`viro-web-renderer` release notes, `VISIONOS_SETUP`, `QUEST_SETUP`).

## Work out what affects this project

1. From the entries, list the breaking changes, removals, renames and new requirements (React Native, Expo SDK, iOS deployment target, Android settings, new peer packages).
2. For each one, search the project for the affected components, props and functions. Use `reactviro_find_symbol` and `reactviro_get_component_props` to confirm a symbol's current name and shape rather than relying on memory.
3. Give the developer a short plan: the version to move to, the dependency changes, and each code change with the files it touches. Note what does not affect them, so they know it was checked.

## Make the change

1. Update `@reactvision/react-viro` and any packages the release requires. When it needs a newer React Native or Expo SDK, that is a larger upgrade of its own: say so and agree the order with the developer.
2. Update the affected code.
3. Run `reactviro_validate_scene` on every changed scene file with `platforms` set to the developer's targets, and resolve or report what a platform does not support.
4. Show the scenes with Viro Live (`reactviro_live_preview`, then `reactviro_update_live_preview`) when a change affects how they look or behave.
5. ViroReact is a native module: after the upgrade the app needs a native rebuild (a new development build, `expo prebuild` for Expo, `pod install` on iOS). A JavaScript reload alone is not enough.

## Report honestly

Say which changelog entries you checked against the code and which you could not verify statically. Validation and Viro Live do not replace building and running the upgraded app on each target device; never claim that testing happened if it did not.
