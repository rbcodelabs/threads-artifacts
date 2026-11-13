# Artifacts for Agent Threads

Desktop-only peer plugin that adds artifacts to Agent Threads, starting with static UI designs.

## Requirements

- Agent Threads with public API v1 and the `threads.beginProvisional` capability
- Obsidian or Geode desktop with a local filesystem vault

Enable Agent Threads first, then enable **Artifacts for Agent Threads**. The plugin registers:

- `/design <brief>` in existing-thread and new-thread composers
- the `EnterDesignMode` agent tool
- presentation, preview, capture, and source-reveal actions for `design-static` artifacts

Artifacts use host-allocated storage beneath `.geode/artifacts/`. A failed new-thread preparation rolls back both the provisional thread and allocated storage. Once preparation commits, a later agent-session failure keeps the artifact intact and is reported to the user.

## Development

```sh
npm test
npm run typecheck
npm run build
```
