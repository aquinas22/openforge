import { ipcMain } from 'electron'
import type { AuthEvent } from '@shared/ipc'
import type { Settings } from '@shared/types'
import type { AccountStore } from './core/accounts'
import { authenticateMinecraft, MicrosoftAuthError, pollForTokens, startDeviceCode } from './core/msauth'

/**
 * Microsoft sign-in IPC, kept for re-enabling later and NOT registered in this
 * release (see core/features.ts and docs/microsoft-auth-plan.md).
 *
 * To switch it back on: call `registerMicrosoftSignIn` from registerIpc(),
 * expose the two invoke channels and the event channel in the preload bridge
 * and OpenforgeApi, and restore the sign-in section of the account modal.
 */
export const MS_AUTH_IPC = {
  start: 'accounts:msStart',
  cancel: 'accounts:msCancel',
  event: 'evt:auth'
} as const

export function registerMicrosoftSignIn(deps: {
  accounts: AccountStore
  settings: () => Settings
  send: (channel: string, payload: unknown) => void
}): void {
  // A sign-in runs in the background while the user completes it in a browser.
  let signInAbort: AbortController | null = null
  const sendAuth = (event: AuthEvent): void => deps.send(MS_AUTH_IPC.event, event)

  ipcMain.handle(MS_AUTH_IPC.start, async () => {
    signInAbort?.abort()
    const controller = new AbortController()
    signInAbort = controller
    const clientId = deps.settings().msClientId

    const start = await startDeviceCode(clientId)
    const prompt = {
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      expiresInSeconds: start.expiresIn,
      message: start.message
    }

    void (async () => {
      try {
        const tokens = await pollForTokens(clientId, start, { signal: controller.signal })
        const session = await authenticateMinecraft(tokens.accessToken)
        deps.accounts.addMicrosoft(session, tokens)
        if (!deps.accounts.encryptionAvailable) {
          sendAuth({
            kind: 'error',
            message:
              `Signed in as ${session.username}, but this system offers no secure credential storage, ` +
              'so the session will not be remembered after you quit.'
          })
        }
        sendAuth({ kind: 'success', username: session.username })
      } catch (err) {
        if ((err as MicrosoftAuthError).code === 'cancelled') sendAuth({ kind: 'cancelled' })
        else sendAuth({ kind: 'error', message: (err as Error).message })
      } finally {
        if (signInAbort === controller) signInAbort = null
      }
    })()

    return prompt
  })

  ipcMain.handle(MS_AUTH_IPC.cancel, () => {
    signInAbort?.abort()
    signInAbort = null
  })
}
