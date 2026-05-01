# Antigravity Adapter Notes

The primary implementation in this repository targets the VS Code extension host. Antigravity appears to ship an internal browser based on the user-provided screenshot, but its public extension APIs were not clearly documented enough in this workspace to compile against a real SDK.

What is included here:

- `adapter.ts`: a typed skeleton showing how to mirror the VS Code commands if Antigravity exposes:
  - command registration
  - input boxes / quick picks
  - a native browser panel API, or at least a generic webview panel
- comments showing the preferred integration point:
  - use Antigravity's own browser panel first
  - fall back to an iframe-backed panel only if no native browser API exists

Recommended next step if you confirm Antigravity's SDK surface:

1. Replace the placeholder interfaces in `adapter.ts` with the real SDK types.
2. Reuse the provider-agnostic search client contract from `src/services/docsSearchClient.ts`.
3. If Antigravity exposes its built-in browser controls, wire:
   - reload
   - copy URL
   - screenshot
   - hard reload
   - open result in existing browser tab

The user screenshot suggests those capabilities already exist in-product, so a native integration would be preferable to recreating them in a generic iframe.
