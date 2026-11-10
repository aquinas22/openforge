import pkg from '../../package.json'

/** The app version, read from package.json at build time so it is only ever written down once. */
export const APP_VERSION: string = pkg.version
