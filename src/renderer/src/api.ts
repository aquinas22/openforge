// Typed handle to the preload bridge. Every privileged action funnels through
// the main process — the renderer itself never touches the filesystem or net.
export const api = window.arsFodina
