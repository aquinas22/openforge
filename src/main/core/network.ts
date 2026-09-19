import { session } from 'electron'

/**
 * Apply the user's proxy preference to Chromium's network stack, which is what
 * every request in the app runs on.
 *
 * With no explicit proxy we ask Chromium to use the system configuration,
 * including PAC scripts and the Windows proxy settings — the behaviour a
 * managed machine expects. Certificate trust is deliberately not touched here:
 * Chromium already reads this computer's trusted-root store, so a corporate
 * root installed in Windows is honoured, and there is no path in Openforge that
 * turns verification off.
 */
export async function applyProxySettings(proxyUrl: string): Promise<void> {
  const rules = (proxyUrl ?? '').trim()
  try {
    await session.defaultSession.setProxy(
      rules ? { proxyRules: rules, proxyBypassRules: '<local>' } : { mode: 'system' }
    )
  } catch (err) {
    console.error('[Openforge] Could not apply proxy settings:', (err as Error).message)
  }
}
