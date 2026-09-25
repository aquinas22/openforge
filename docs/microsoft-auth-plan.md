# Re-enabling Microsoft sign-in

Openforge 2.1 ships with Microsoft sign-in switched off. Players either play offline (allowed only on
a PC where the official Minecraft Launcher has an account that owns Java Edition) or hand off to the
official launcher. This document is the plan for bringing native Microsoft sign-in back.

The code for the full sign-in chain is still in the repository and still compiles; it is simply not
reachable. The work that remains is mostly outside the code: an Azure app registration, and
Mojang/Microsoft's approval for that app to use the Minecraft services.

Anything marked **(verify)** is a detail that was correct when this was written but is controlled by
Microsoft and may have changed. Check it against the current documentation before relying on it.

## 1. Register an Azure (Microsoft Entra ID) application

1. Sign in to the Azure portal (<https://portal.azure.com>) with the Microsoft account that will own
   the app. Go to **Microsoft Entra ID -> App registrations -> New registration**.
2. **Name**: `Openforge`.
3. **Supported account types**: *Personal Microsoft accounts only*. Minecraft accounts are consumer
   Microsoft accounts, and Openforge already uses the `consumers` authority
   (`https://login.microsoftonline.com/consumers/oauth2/v2.0/...`).
4. **Redirect URI**: Openforge uses the OAuth 2.0 **device code flow**, which needs no redirect URI.
   If a loopback/browser flow is added later, register it under the platform
   *Mobile and desktop applications* (for example `http://localhost`).
5. After creating it, open **Authentication -> Advanced settings** and set
   **Allow public client flows** to **Yes**. The device code flow is a public-client flow and is
   refused without this.
6. Do **not** create a client secret or certificate. A desktop app cannot keep a secret; it is a
   public client and authenticates with the client ID alone.
7. **API permissions**: the scope requested is `XboxLive.signin offline_access` (see `SCOPE` in
   `src/main/core/msauth.ts`). `offline_access` is what returns a refresh token. No admin consent is
   involved for personal accounts. **(verify)** whether the portal needs `XboxLive.signin` added as
   a permission or accepts it as a requested scope at sign-in only.
8. Copy the **Application (client) ID**. A public client's ID is not a secret, so it can be compiled
   into release builds (see step 5 below).

## 2. Request Minecraft API access for the new app ID

New Azure app IDs are blocked from `api.minecraftservices.com` until Mojang approves them. Without
approval, the first three steps of the chain succeed (Microsoft, Xbox Live, XSTS) and the Minecraft
login call fails with HTTP 403; the error body has been observed to say "Invalid app registration"
and link to <https://aka.ms/AppRegInfo> **(verify)**.

1. Read Mojang's explanation at <https://aka.ms/AppRegInfo> **(verify the link)**.
2. Submit the app ID through Mojang's app ID review form. It has been published as
   <https://aka.ms/mce-reviewappid> **(verify the link and what it asks for)**. Expect to give the
   app ID, a description of the launcher, and contact details. Mojang may also ask for a public page
   or a privacy statement, so have one ready.
3. Wait for approval; nothing can be tested end to end before it. There is no published turnaround
   time.
4. Keep the approved registration stable. A new app ID means a new review.

## 3. The token chain (already implemented)

All of this is in `src/main/core/msauth.ts`:

| Step | Request | Keep |
| --- | --- | --- |
| 1. Device code | `POST https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode` with `client_id` and `scope=XboxLive.signin offline_access` (`startDeviceCode`) | `user_code`, `verification_uri`, `device_code`, `interval` |
| 2. Microsoft token | Poll `POST .../consumers/oauth2/v2.0/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` until the player finishes in the browser (`pollForTokens`); later `grant_type=refresh_token` (`refreshTokens`) | access token, **refresh token** |
| 3. Xbox Live (XBL) | `POST https://user.auth.xboxlive.com/user/authenticate`, `AuthMethod: RPS`, `SiteName: user.auth.xboxlive.com`, `RpsTicket: d=<Microsoft access token>`, `RelyingParty: http://auth.xboxlive.com` | XBL token, user hash `uhs` |
| 4. XSTS | `POST https://xsts.auth.xboxlive.com/xsts/authorize`, `SandboxId: RETAIL`, `UserTokens: [XBL token]`, `RelyingParty: rp://api.minecraftservices.com/` | XSTS token; `XErr` codes 2148916233 (no Xbox profile), 2148916235 (region), 2148916236/7 (adult verification), 2148916238 (child account) are translated in `translateXstsError` |
| 5. Minecraft | `POST https://api.minecraftservices.com/authentication/login_with_xbox` with `identityToken: XBL3.0 x=<uhs>;<XSTS token>` | Minecraft access token (about 24 h) |
| 6. Ownership | `GET https://api.minecraftservices.com/entitlements/mcstore` | `entitled` |
| 7. Profile | `GET https://api.minecraftservices.com/minecraft/profile` | UUID, name, skin |

The game then launches with `--accessToken`, `--uuid`, `--username`, `--userType msa` and `--xuid`
(see `LaunchAccount` in `src/main/core/accounts.ts` and the placeholder map in
`src/main/core/launcher.ts`, which already redacts the token in the logged command line).

**(verify)** Game Pass subscribers have been reported to get an empty entitlements list while still
having a profile. Before trusting `entitled === false` as "does not own the game", test with a Game
Pass account and consider treating an existing Java profile as sufficient.

## 4. Storing tokens with Electron safeStorage (already implemented)

`AccountStore` in `src/main/core/accounts.ts`:

- encrypts the refresh token and the current Minecraft token with `safeStorage.encryptString`
  (DPAPI on Windows, bound to the Windows user) and stores only the base64 blobs in
  `accounts.json`;
- refuses to persist the refresh token when `safeStorage.isEncryptionAvailable()` is false, rather
  than writing it in plain text;
- refreshes silently in `resolveForLaunch` when the Minecraft token is within a minute of expiry,
  and marks the account `needsReauth` when the refresh token no longer works;
- never returns tokens to the renderer (`AccountSummary` has no token fields) and never logs them.

Microsoft accounts saved before sign-in was switched off are still in `accounts.json`, untouched. They
reappear as soon as the switch below is turned back on.

## 5. What to re-enable in the repository

1. **The switch.** Set `MICROSOFT_SIGN_IN_ENABLED = true` in `src/main/core/features.ts`. This makes
   `AccountStore` list, select and launch Microsoft accounts again.
2. **The client ID.** Put the approved app ID in the code as the default. Add a constant (for
   example `OPENFORGE_MS_CLIENT_ID` in `features.ts`) and pass
   `settings.msClientId || OPENFORGE_MS_CLIENT_ID` wherever `settings.msClientId` is used today:
   `registerMicrosoftSignIn` in `src/main/msauth-ipc.ts` and the `accounts.resolveForLaunch(...)`
   call in `src/main/ipc.ts`. `msClientId` is still read and kept in `settings.json` (see
   `src/shared/settings.ts`), so it can stay as an advanced override.
3. **IPC.** Call `registerMicrosoftSignIn({ accounts, settings: () => settings, send })` from
   `registerIpc` in `src/main/ipc.ts`. Add `startMicrosoftLogin`, `cancelMicrosoftLogin` and
   `onAuthEvent` back to `OpenforgeApi` in `src/shared/ipc.ts` and to `src/preload/index.ts`, using
   the channel names in `MS_AUTH_IPC` (`accounts:msStart`, `accounts:msCancel`, `evt:auth`). The
   `AuthEvent` type is still in `src/shared/ipc.ts`.
4. **Renderer.** Restore the store actions (`startMicrosoftLogin`, `cancelMicrosoftLogin`,
   `authPrompt`, `authBusy`, the `onAuthEvent` subscription) and the "Microsoft account" section of
   the account modal in `src/renderer/src/App.tsx`. The previous implementation is in git: see the
   parent of the commit "Remove Microsoft sign-in from the app and gate offline play on ownership"
   (`git show <that commit>^:src/renderer/src/App.tsx`). Restore the Microsoft branches in `Rail`
   and the title bar status in `src/renderer/src/components/shell.tsx`.
5. **The launch path.** In the `launchInstance` handler in `src/main/ipc.ts`, the ownership gate runs
   before the account is resolved. Move it so it applies only to offline accounts (section 6), and
   restore the "Checking Microsoft session" launch step label for Microsoft accounts.
6. **Errors.** The Microsoft-specific rules in `src/shared/errors.ts` (re-authentication and missing
   licence) are still there and become reachable again.
7. **Network check.** Add `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize` back
   to the connection check targets in `src/main/ipc.ts`.
8. **Docs.** Update the README "Playing" section.

## 6. Swapping the ownership gate

Today offline play is allowed by `checkOfflinePlayAllowed(minecraftDir)` in
`src/main/core/ownership.ts`: true when the official launcher on this PC has an account with a Java
Edition profile. It is the only place that decides, and it is called in two places in
`src/main/ipc.ts` (the `playStatus` handler and `launchInstance`).

With real sign-in, change it to use the stronger evidence Openforge then has:

1. A signed-in Microsoft account in Openforge with `entitled === true` (or a Java profile, see the
   Game Pass note) allows offline profiles too.
2. Keep the launcher-account check as a second way to pass, so players who only use the official
   launcher are not locked out.
3. Microsoft accounts themselves are never gated: their launch token is the proof of ownership.

Keep the function's name, signature and `OfflineGate` result, so the UI (`playStatus`) and the launch
path need no change. Update the unit cases in `scripts/verify.ts` ("Ownership gate") to cover the new
rule.

## 7. Testing

Before approval (no Minecraft token is possible yet):

1. `npm run check` and `npm run build`.
2. Sign in with a test account and confirm the device code appears, the browser step completes, and
   the failure at `login_with_xbox` is reported clearly (it should be the 403 described in step 2).
3. Confirm nothing token-shaped appears in the console log, `accounts.json` (only encrypted blobs),
   or the renderer (inspect `window.openforge.listAccounts()` in DevTools).

After approval:

1. Sign in with an account that owns Java Edition. Check name, UUID and skin in the account modal.
2. Launch vanilla and a modded instance and join an online-mode server. The server log should show
   the real UUID.
3. Quit, relaunch and play again without signing in: the encrypted refresh token is reused.
4. Wait past the Minecraft token's lifetime (or edit `expiresAt` in `accounts.json` to the past) and
   launch: the token refreshes silently.
5. Revoke the app's access at <https://account.live.com/consent/Manage> **(verify)** and launch:
   the account shows "Sign in again" and the launch explains it.
6. Accounts without Java Edition, and child accounts without family consent, produce the specific
   messages from `translateXstsError` and the entitlement check.
7. Offline profiles: with a signed-in owning account, offline play is allowed even with no official
   launcher account on the PC; with no owning account anywhere, it stays locked.
8. Copy `accounts.json` to another Windows user or PC: the tokens must not decrypt (DPAPI).
