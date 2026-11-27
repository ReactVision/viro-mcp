# ReactVision XR Builder

A Claude plugin for building ViroReact AR and VR experiences with ReactVision's hosted MCP server. It connects Claude to `https://mcp.reactvision.xyz/viro` and adds skills that tell Claude how to use its tools for each kind of task.

With it, Claude can look up ViroReact components and props from the current source, find and explain example scenes, generate and validate scenes, check platform support and model budgets, show your scene in Viro Live (an interactive 3D preview of your own code), render scenes in recorded AR sessions, generate images and 3D models into your team's library, and migrate 8th Wall projects.

## Install

In Claude Code:

```
/plugin install reactvision-xr-builder --marketplace ReactVision/viro-mcp
```

On Claude Code before 2.1.275, run `/plugin marketplace add ReactVision/viro-mcp`, then `/plugin install reactvision-xr-builder@reactvision`. In Claude on the web, Desktop or Cowork: Customize → Plugins → Add → Add marketplace, enter `ReactVision/viro-mcp`, then install ReactVision XR Builder.

## Skills

| Skill | Use it for |
| --- | --- |
| `getting-started` | Connecting, and general scene work: docs, examples, building, validation, renders, assets |
| `project-setup` | Installing ViroReact in an Expo or React Native app, or targeting a new platform |
| `viro-live-preview` | Showing a scene in Viro Live and keeping it in step with the code |
| `performance-review` | A slow or heavy scene, or a check before shipping |
| `viroreact-upgrade` | Moving to a newer ViroReact release |
| `native-crash-debugging` | Crashes and runtime errors on a device |
| `eighthwall-migration` | Moving an 8th Wall project to ViroReact |

## Connect

The server needs a free [ReactVision Studio](https://studio.reactvision.xyz) account. The first time a tool runs, sign in through ReactVision and pick the team your usage is counted against. There is no API key.

Validation and previews do not replace testing on a physical device.

## Where your files go

Where Claude can run shell commands, some tools return a `curl` command that uploads files from your machine instead of passing them through the chat:

- Viro Live previews: your project folder and its local models, images and media go to `mcp.reactvision.xyz`, the server this plugin connects to.
- 8th Wall migrations and code environment renders: the export zip or the code bundle goes to a signed upload link on ReactVision Studio's storage, which belongs to the same ReactVision account and team.

The skills send nothing to any other service.

## Links

- Website: https://www.reactvision.xyz/mcp
- Support: https://www.reactvision.xyz/contact
- Privacy policy: https://www.reactvision.xyz/policies/privacy-policy/
- Terms of service: https://www.reactvision.xyz/policies/terms-of-service/
