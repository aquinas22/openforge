/**
 * Microsoft sign-in is switched off in this release.
 *
 * The device-code flow and the Xbox Live -> XSTS -> Minecraft token chain are
 * still implemented in msauth.ts, token storage in accounts.ts, and the IPC
 * wiring in ../msauth-ipc.ts, but none of it is reachable: no IPC channel is
 * registered and no UI calls it. Microsoft accounts already saved in
 * accounts.json are kept on disk untouched and simply not listed.
 *
 * Re-enabling it needs an approved Azure app registration first. The steps,
 * including which code to switch back on, are in docs/microsoft-auth-plan.md.
 */
export const MICROSOFT_SIGN_IN_ENABLED = false
