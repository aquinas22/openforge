// Ambient declarations for asset imports handled by Vite.
// This file must stay free of top-level import/export so the wildcard module
// declarations remain global rather than becoming module augmentations.

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.woff2' {
  const src: string
  export default src
}
