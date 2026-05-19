# Android Component Audit

`jshook` plugin that audits Android manifest components and exposed app
entrypoints.

## Tool

- `android_component_audit`
  - input: `apkPath`
  - output: launcher activities, deep link surfaces, exported components, and
    component-level metadata

## Development

```bash
pnpm install
pnpm build
pnpm check
```
