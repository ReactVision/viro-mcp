---
name: project-setup
description: Set up ViroReact in a new or existing Expo or React Native app for iOS, Android, Meta Quest, visionOS or the web, and get a first AR or VR scene running.
---

# Setting up ViroReact

Use this when a developer wants to start with ViroReact, add it to an existing app, or target a new platform.

## Ask first

- New app or existing one? Expo or React Native CLI?
- Which platforms: iOS, Android, Meta Quest, visionOS, the web?
- AR, VR, or both?

## Find the current requirements

Versions move, so read them rather than assuming:

1. `reactviro_get_docs` with `README` for the supported platforms, the React Native and Expo versions the current release needs, and the installation steps.
2. `reactviro_get_platform_matrix` for what each platform supports.
3. Per platform: `QUEST_SETUP` for Meta Quest, `VISIONOS_SETUP` for visionOS, `INTEGRATION` and `USAGE` for the web renderer.
4. The full installation guide, with permissions and build configuration, is at https://viro-community.readme.io/docs/installation-instructions.

## New Expo app

The quickest start is ReactVision's starter kit: https://github.com/ReactVision/expo-starter-kit-typescript. Clone it and follow its README.

## Adding ViroReact to an app

1. Install `@reactvision/react-viro`.
2. Expo: add `@reactvision/react-viro` to `plugins` in the app config. Its options include `ios.cameraUsagePermission` (the camera prompt's text, needed for AR) and `android.xRMode` (`AR`, `GVR`, `OVR_MOBILE`, `QUEST`). The installation guide lists the rest; do not guess option names.
3. React Native CLI: follow the installation guide's iOS and Android steps.
4. ViroReact is a native module, so it does not run in Expo Go. Build a development build (`expo prebuild` then `expo run:ios` or `expo run:android`, or EAS), and run it on a physical device: AR needs a real camera.
5. Optional packages, only when needed: `@reactvision/react-viro-face-tracking` for front-camera face AR (it adds the iOS TrueDepth API, which App Store review checks), `@reactvision/react-viro-onnx` for on-device object detection, `@reactvision/viro-web-renderer` for the web.

## First scene

1. Call `reactviro_generate_scene` with the closest features, and adapt its TSX to what the developer wants.
2. Run `reactviro_validate_scene` and `reactviro_check_platform_support` for each target.
3. Show it with Viro Live (`reactviro_live_preview`) so the developer sees it before building.
4. Wire it into the app with `ViroARSceneNavigator` (AR) or `ViroVRSceneNavigator` (VR), and list any assets it needs (`reactviro_list_assets_needed`).

## Report honestly

Say which steps you took from the docs and which the developer still has to run. Never claim the app was built or tested on a device unless it was.
