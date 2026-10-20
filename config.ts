/**
 * viro-mcp — Project Configuration
 *
 * MCP server giving AI coding agents source-level knowledge of the public
 * TypeScript API of @reactvision/react-viro (ViroReact), the AR/VR framework
 * for React Native.
 *
 * This config drives both the indexer and the runtime server.
 */

import { resolve } from 'node:path';

export const config = {
  // ── Identity ───────────────────────────────────────────────────────────────

  name:        'viro-mcp',
  version:     '1.0.0',
  /** HTTP port — overridden by PORT env var. */
  port:        3000,
  /** Prefix for all tool names. "reactviro" → "reactviro_list_files", etc. */
  toolPrefix:  'reactviro',

  // ── Project location ───────────────────────────────────────────────────────

  /**
   * Parent of the ViroWorkspace checkout. The walks below are relative to this.
   * Defaults to two levels above the working directory, which is right when
   * `npm run index` runs from ViroWorkspace/reactviro-mcp. Override with the
   * PROJECT_DIR env var (used by CI to point to a temp dir).
   */
  projectDir:  process.env['PROJECT_DIR'] ?? resolve('..', '..'),

  /** SQLite filename inside knowledge/ */
  dbName:      'reactviro.db',

  // ── AI gateway (embeddings) ──────────────────────────────────────────────

  /**
   * OpenAI-compatible embeddings gateway (POST {url}/embeddings).
   * Drives hybrid search: the indexer vectorizes each file and the runtime
   * embeds the query. With no key set, indexing skips embeddings and search
   * falls back to pure FTS5, so the server keeps working without it.
   */
  gateway: {
    url:        process.env['AI_GATEWAY_URL'] ?? '',
    key:        process.env['AI_GATEWAY_KEY'] ?? '',
    embedModel: process.env['EMBED_MODEL'] ?? 'nomic-embed-text',
  },

  // ── What to index ─────────────────────────────────────────────────────────

  /**
   * Directories to walk, relative to projectDir.
   *   label   — shown in list_files results
   *   dir     — path relative to projectDir
   *   skipDirs — extra dirs to skip inside this walk (adds to globalSkipDirs)
   */
  walks: [
    { label: 'components', dir: 'ViroWorkspace/viro/components',                   skipDirs: [] as string[] },
    { label: 'docs',       dir: 'ViroWorkspace/docs',                              skipDirs: [] as string[] },
    { label: 'examples',   dir: 'ViroWorkspace/showcase/components/ar-examples',   skipDirs: [] as string[] },
    { label: 'onnx',       dir: 'ViroWorkspace/react-viro-onnx/src',               skipDirs: [] as string[] },
    { label: 'face-tracking', dir: 'ViroWorkspace/react-viro-face-tracking/src',   skipDirs: [] as string[] },
    // What `visionos/` is created from: the Podfile, App.swift with the
    // ImmersiveSpace scene, AppDelegate, Info.plist and the xcodeproj. The setup
    // guide gives the steps; this is what they produce, which is what answering
    // "my visionos/ folder does not look like this" needs.
    { label: 'visionos-template', dir: 'ViroWorkspace/visionos-template/template', skipDirs: ['node_modules', 'Pods'] },
  ],

  /**
   * Individual files at projectDir to always include (relative paths).
   * These get pkg = "infra".
   */
  rootFiles: [
    'ViroWorkspace/viro/package.json',
    'ViroWorkspace/viro/README.md',
    'ViroWorkspace/viro/CHANGELOG.md',
    'ViroWorkspace/viro/RELEASE_NOTES.md',
    'ViroWorkspace/react-viro-onnx/package.json',
    'ViroWorkspace/react-viro-onnx/README.md',
    'ViroWorkspace/react-viro-face-tracking/package.json',
    'ViroWorkspace/react-viro-face-tracking/README.md',
  ],

  /** Sub-paths under projectDir to walk as "infra" */
  infraDirs: [] as string[],

  // ── File filtering ────────────────────────────────────────────────────────

  /** Extensions to include in the index */
  sourceExts: new Set([
    '.ts', '.tsx', '.js', '.jsx',
    '.md',
    '.json',
    '.glsl', '.vert', '.frag',   // shader sources for ViroMaterials.shaderModifiers
  ]),

  /** Directories always skipped (across all walks) */
  globalSkipDirs: new Set([
    'node_modules', 'dist', 'build', '.git',
    '__tests__', '__mocks__', 'coverage',
    'ios', 'android',                 // native code lives in the reactvision-platform MCP
    '.next', 'out',
  ]),

  /** Extensions always skipped (binaries, assets, lock files) */
  skipExts: new Set([
    '.lock', '.snap', '.map', '.min.js', '.min.css',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.mp4', '.webm', '.mov', '.mp3', '.wav',
    '.glb', '.vrx', '.obj', '.fbx', '.gltf',  // 3D model assets
    '.bin', '.wasm', '.tflite', '.pb', '.onnx',
    '.zip', '.tar', '.gz',
    '.docx', '.pdf',
  ]),

  // ── Docs ──────────────────────────────────────────────────────────────────

  /**
   * Markdown files indexed as searchable docs (separate from the source files
   * table — these surface via reactviro_get_docs). Paths are relative to projectDir.
   */
  docs: [
    'ViroWorkspace/viro/README.md',
    'ViroWorkspace/viro/CHANGELOG.md',
    'ViroWorkspace/viro/RELEASE_NOTES.md',
    'ViroWorkspace/docs/PLATFORM_SUPPORT.md',
    'ViroWorkspace/docs/CO_LOCATION.md',
    'ViroWorkspace/docs/VISIONOS_SETUP.md',
    'ViroWorkspace/docs/SHADER_REFERENCE.md',
    'ViroWorkspace/docs/QUEST_SETUP.md',
    'ViroWorkspace/docs/ViroObjectDetector.md',
    'ViroWorkspace/docs/ViroCameraTexture.md',
    'ViroWorkspace/docs/PLATFORM_EXTENSIONS.md',
    'ViroWorkspace/docs/VPS_LITE.md',
    'ViroWorkspace/docs/AR_SESSION_RECORDING.md',
    'ViroWorkspace/docs/web/README.md',
    'ViroWorkspace/docs/web/INTEGRATION.md',
    'ViroWorkspace/docs/web/USAGE.md',
    'ViroWorkspace/docs/web/INTERNALS.md',
    'ViroWorkspace/docs/web/REACT_WEB_GUIDE.md',
    'ViroWorkspace/react-viro-onnx/README.md',
    'ViroWorkspace/react-viro-face-tracking/README.md',
    // Creating a visionOS app: the template that scaffolds `visionos/`, and the
    // React Native fork it builds against.
    'ViroWorkspace/visionos-template/README.md',
    'ViroWorkspace/react-native-visionos/README.md',
    'ViroWorkspace/virocore/RELEASE_NOTES.md',
    'ViroWorkspace/viro-web-renderer/RELEASE_NOTES.md',
  ],

  // ── Tool descriptions ─────────────────────────────────────────────────────

  /**
   * Used inside tool descriptions shown to Claude.
   * Helps the model pick the right tool and understand the corpus layout.
   */
  projectDescription: `
ReactViro (@reactvision/react-viro) — AR/VR framework for React Native.
Multi-platform: iOS (ARKit), Android (ARCore), Meta Quest (OpenXR), Apple visionOS.

Indexed packages:
  - "components" — viro/components/   Public TypeScript components (ViroBox,
                                       ViroARScene, ViroParticleEmitter, etc.)
                                       Grouped by category: AR, Geometry, Lighting,
                                       Materials, Animation, Effects, Portal, Media,
                                       Audio, UI, Navigation, Camera, Input,
                                       Environment, Transform, Studio, Panoramic / 360°,
                                       3D Objects.
  - "docs"       — ViroWorkspace/docs/  Public-facing docs (unified location, outside
                                       any repo — not shipped in the npm package).
  - "examples"   — showcase/ar-examples/  Real-world AR scene examples
                                          (plane-detection, custom-shaders, ar-portal,
                                          particle-effects, depth-mesh-collision, etc.).
  - "onnx"       — react-viro-onnx/src/   Public TS surface of the companion
                                          inference package @reactvision/react-viro-onnx
                                          (the ONNX Runtime provider behind
                                          ViroObjectDetector — ViroONNX.getVersion()).
  - "face-tracking" — react-viro-face-tracking/src/  Public TS surface of the optional
                                          @reactvision/react-viro-face-tracking package
                                          (front-camera ARKit face-tracking provider behind
                                          the frontCameraEnabled prop — ViroFaceTracking.isSupported()).
  - "infra"      — viro/package.json, README, CHANGELOG,
                   react-viro-onnx/package.json + README,
                   react-viro-face-tracking/package.json + README.

Out of scope of this MCP (use reactvision-platform MCP instead):
  - Native C++ render engine (virocore)
  - Java/Kotlin view managers, ObjC bridges
  - SLAM, ReactVisionCCA cloud-anchor service
`.trim(),
};
