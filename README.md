<p align="center">
  <a href="https://www.reactvision.xyz/">
    <img src="https://avatars.githubusercontent.com/u/74572641?s=200&v=4" alt="ReactVision logo" width="120px" height="120px">
  </a>
</p>

<p align="center">
  <a href="https://github.com/ReactVision/viro-mcp/actions/workflows/ci.yml">
    <img src="https://github.com/ReactVision/viro-mcp/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-Elastic--2.0-blue" alt="Elastic License 2.0">
  </a>
  <a href="https://discord.gg/A6TaFNqwVc">
    <img src="https://img.shields.io/discord/774471080713781259?label=Discord" alt="Discord">
  </a>
</p>

# ViroReact MCP Server, By ReactVision

The ViroReact MCP server gives your coding agent structured, source-level knowledge of [ViroReact](https://github.com/ReactVision/viro) (`@reactvision/react-viro`), the most widely used open-source library for building AR and VR experiences with React Native. Think of it as a living guide to ViroReact, always current, that plugs straight into the tools you already use.

Connect it to Claude, ChatGPT, Codex, Cursor or any other MCP client, and your agent can look up every component's props and events, find working example scenes, generate and validate scenes, check what runs on which platform, and diagnose errors against known issues. No hunting through docs, no guesswork.

This repository holds the server's knowledge layer: the indexer and every read-only tool, which you can read, run locally and contribute to. You don't need it to use the server; connect to the hosted one below.

## Connect

The server is hosted at:

```
https://mcp.reactvision.xyz/viro
```

There is no API key. Add the URL as a remote (HTTP) MCP server, then click **Authenticate**: you'll be sent to ReactVision to sign in and pick the team the usage is billed to. A free [ReactVision Studio](https://studio.reactvision.xyz) account is enough.

| Client                         | How                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Claude (web, Desktop, Cowork)  | Settings → Connectors → Add custom connector → paste the URL                       |
| Claude Code                    | `claude mcp add --transport http reactviro https://mcp.reactvision.xyz/viro`       |
| ChatGPT                        | Add a custom app/connector with the URL and OAuth authentication                   |
| Codex CLI                      | `codex mcp add reactviro --url https://mcp.reactvision.xyz/viro`                   |
| Cursor, VS Code, others        | Add a remote/HTTP MCP server with the URL; the client opens the browser to sign in |

Config-file clients take the same URL:

```json
{
  "mcpServers": {
    "reactviro": {
      "type": "http",
      "url": "https://mcp.reactvision.xyz/viro"
    }
  }
}
```

Full setup guide: <https://viro-community.readme.io/docs/viro-mcp-server>

## Features

Every tool is prefixed `reactviro_`. The tools below are all in this repository; they are read-only and answer from a knowledge base built from the ViroReact source.

**Components and API**

- `list_components`, `list_categories`, `get_component`: the component catalog, with forgiving name lookup (`"Box"` finds `ViroBox`)
- `get_component_props`, `get_component_events`, `list_props`: props and event signatures extracted from the TypeScript source, including JSDoc and `@since`
- `get_platform_matrix`, `check_platform_support`: what works on iOS, Android, Meta Quest, visionOS and the web, and whether a given scene will
- `list_lighting_models`, `list_physics_body_types`, `list_animation_easings`, `get_shader_uniforms`, `list_event_handlers`, `changelog_since`: AR domain reference

**Search and source**

- `search`, `list_files`, `get_file`, `get_docs`: hybrid full-text and semantic search over components, docs and examples
- `get_overview`, `get_tree`, `stats`, `find_symbol`, `find_native_bridge`: find your way around the codebase
- `list_examples`, `get_example`, `examples_using`: real AR scenes from the ViroReact showcase app

**Scenes**

- `generate_scene`, `validate_scene`, `list_assets_needed`: scaffold TSX and lint it against the extracted prop schemas
- `diagnose_error`: match an error or stack trace against curated known issues

**Only on the hosted server**

The hosted server adds tools that run on ReactVision's infrastructure and aren't part of this repository: rendering a scene to screenshots, previewing a scene inside a recorded AR session, generating images and 3D models into your Studio library, converting Studio scenes and 8th Wall projects, and checking your team's usage. Your client lists them once connected.

## Authentication and usage

The hosted server uses OAuth 2.1 ("Sign in with ReactVision"). A request without a token gets a `401` pointing at [`/.well-known/oauth-protected-resource`](https://mcp.reactvision.xyz/.well-known/oauth-protected-resource), the client runs OAuth with PKCE, and you pick the team to bill on ReactVision's consent screen. Tokens are never stored by the server. Every tool call is metered against that team's plan; ask your agent to call `reactviro_get_usage` to see what's left.

## Running it locally

Requires Node 22.

```bash
npm install
npm run index            # build knowledge/reactviro.db from a local ViroWorkspace
npm run dev              # http://127.0.0.1:3000/viro
```

The indexer reads a `ViroWorkspace` checkout containing [`viro`](https://github.com/ReactVision/viro) and, if present, its `docs`, `showcase`, `react-viro-onnx` and `react-viro-face-tracking` siblings; anything missing is skipped. By default it looks two directories above the working directory, so clone this repository into `ViroWorkspace/`, or set `PROJECT_DIR` to the folder that contains `ViroWorkspace`. Component props and events are extracted with the TypeScript compiler API at index time; nothing is parsed at query time.

The local server has no authentication and no metering, and binds to `127.0.0.1`. Point any MCP client at `http://127.0.0.1:3000/viro`. Every variable is documented in [`.env.example`](.env.example).

```bash
npm test                 # vitest
npm run typecheck
npm run build && npm start
```

### Layout

- `config.ts`: what gets indexed, and the tool prefix. Change indexing behaviour here, not in the indexer.
- `indexer/`: walks the source, extracts the API surface, writes SQLite + FTS5 (plus embeddings when `AI_GATEWAY_URL` and `AI_GATEWAY_KEY` are set).
- `src/tools/`: one module per tool group; `custom.ts` wires them up.
- `data/`: curated knowledge edited by hand (platform matrix, known issues, AR domain reference). No re-index needed after editing.

### Contributing

Issues and pull requests are welcome. A new tool goes in `src/tools/<group>.ts`, takes its name from `` `${config.toolPrefix}_…` ``, uses a `.strict()` Zod schema, and is registered in `custom.ts` with read-only annotations. Fixes to `data/*.json` are especially useful: a wrong cell in the platform matrix, or a known issue that `diagnose_error` should recognise.

## Security

Please report vulnerabilities privately, as described in [`SECURITY.md`](SECURITY.md), rather than in a public issue.

## Community

Discord is the best place to find the team and other developers building with ViroReact:

<a href="https://discord.gg/A6TaFNqwVc">
  <img src="https://discordapp.com/api/guilds/774471080713781259/widget.png?style=banner2" />
</a>

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Enterprise Support and Partners

For teams adopting XR at scale, the ReactVision team works directly with you on architecture, migrations from 8th Wall or Unity, performance audits, and shipping production experiences. <https://reactvision.xyz/contact>

For independent agencies and consultants vetted by the ReactVision team: <https://reactvision.xyz/partners>

## Find Out More

- Website: <https://reactvision.xyz>
- ViroReact: <https://github.com/ReactVision/viro>
- ViroReact docs: <https://viro-community.readme.io/docs/overview>
- ReactVision Studio: <https://studio.reactvision.xyz>
- Blog: <https://updates.reactvision.xyz>

---

Licensed under the [Elastic License 2.0](LICENSE): you may read, modify and run this code, but not offer it to others as a hosted or managed service. © ReactVision, Inc.

ViroReact itself is MIT licensed and free forever: <https://github.com/ReactVision/viro>
