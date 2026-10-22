# Telegram plugin setup guide

This guide covers the Paperclip side of adopting `paperclip-plugin-telegram`, including the pinned 0.8.1 release, Paperclip host resolution, bot-token secrets, allowlists, origin checks, Board Access Connection, commands, tests, negative cases, and recovery.

Pinned dependencies for this guide:

- Plugin package: `paperclip-plugin-telegram@0.8.1`
- Paperclip SDK: `@paperclipai/plugin-sdk@2026.1012.0`
- Paperclip shared code: `@paperclipai/shared@2026.1012.0`

Do not float these: install the exact plugin version and run `paperclipai plugin target` before every debugging session. A mismatched or stale Paperclip host is the common cause of activation failures and bot-token secret-resolution errors.

## 15-minute onboarding path

Goal: a working `/status` reply from Telegram in under 15 minutes.

| Time | Step | Exit criterion |
| --- | --- | --- |
| 0:00-0:45 | Run `paperclipai plugin target` | API URL, status, version, mode, exposure are correct |
| 0:45-3:00 | Create a bot with @BotFather and capture its token | Token stored outside Git |
| 3:00-5:00 | Send the bot a message and capture `chat.id` | Chat ID is recorded |
| 5:00-7:00 | Create a Paperclip company secret for the bot token | UUID copied, not the token |
| 7:00-9:00 | Install or enter the plugin settings and fill required fields | `telegramBotTokenRef` contains a secret UUID |
| 9:00-11:00 | Add a Telegram user/chat allowlist | Host config policy passes |
| 11:00-12:30 | Set Paperclip API/public origins and click **Test configuration** | Worker resolves bot token and Telegram `getMe` succeeds |
| 12:30-14:00 | Connect Board Access if authenticated approval mutations are needed | Status shows **Connected** |
| 14:00-15:00 | Send `/status` from an allowlisted Telegram chat | Bot returns active agents and recent completions |

Start one timer. If any check after `/status` fails, stop at that section's recovery notes instead of continuing the timer.

## Self-hosted and managed setup

Paperclip deployment differs mainly in deployment mode and reachability. Run `paperclipai plugin target` and read both the API base URL and `mode=` value before making changes.

### Self-hosted setup

For a single-node instance you control:

1. Start Paperclip so that `/api/health` responds.
2. Run `paperclipai plugin target` and confirm the intended URL.
3. Install the pinned plugin on an instance-admin account:

   ```sh
   paperclipai plugin install paperclip-plugin-telegram --version 0.8.1
   ```

   or:

   ```sh
   curl -X POST http://127.0.0.1:3100/api/plugins/install \
     -H "Content-Type: application/json" \
     -d '{"packageName":"paperclip-plugin-telegram","version":"0.8.1"}'
   ```

4. Open the plugin settings page inside a company and continue with the origin and secret steps below.
5. If you rebuild locally, keep `pnpm dev` running; Paperclip watches rebuilt plugin `dist` output.

### Managed or authenticated-instance setup

For an authenticated instance (including managed hosting):

1. Confirm `mode=authenticated` and exposure from `paperclipai plugin target`.
2. Use HTTPS in both `paperclipBaseUrl` and, if configured, `paperclipPublicUrl`.
3. Complete Board Access Connection before testing approval buttons. Local trusted instances may not require it; authenticated instances do.
4. Plugin installation and configuration changes require a board access or instance-admin session. Non-admin users can request board access but cannot install or reconfigure the plugin.
5. If managed by a platform owner, ask that owner to install the plugin rather than adding bundled-plugin catalog entries by hand. Do not edit `BUNDLED_PLUGIN_CATALOG` or `SELF_HOSTED_AUTO_INSTALL_KEYS` for this plugin.

## Plugin target/origin resolution

### 1. Confirm the Paperclip target

Run:

```sh
paperclipai plugin target
```

For an instance elsewhere:

```sh
paperclipai plugin target --api-base https://paperclip.example.com
```

or:

```sh
PAPERCLIP_API_URL=https://paperclip.example.com paperclipai plugin target
```

JSON output is available with the normal CLI `--json` option:

```sh
paperclipai plugin target --json
```

Expected target output:

```text
Target Paperclip: https://paperclip.example.com
  health: status=ok  version=...  mode=...  exposure=...
```

Fix any of these before installing:

- `health: unreachable` - the instance is not running, or the API base is wrong.
- A URL pointing at a staging or old control-plane host - set `--api-base` or `PAPERCLIP_API_URL`.
- A server version older than the pinned plugin's minimum expectation - restart or update Paperclip before filing a plugin bug.

The target check is not optional when developer builds are running in another worktree or on another port.

### 2. Configure the Paperclip origin

Required setting:

- `paperclipBaseUrl`: absolute `http://` or `https://` URL. The worker probes `${origin}/api/health` and refuses invalid values.

Optional setting:

- `paperclipPublicUrl`: absolute `http://` or `https://` URL used in Telegram links. Leave it empty to fall back to `paperclipBaseUrl`. An invalid non-empty value is rejected.

Resolution order used by the plugin:

1. `paperclipPublicUrl`, when it parses as an absolute HTTP(S) URL.
2. Otherwise `paperclipBaseUrl`.
3. If neither is usable, Paperclip links cannot be generated.

Host-side and UI guardrails:

- `paperclipBaseUrl` must be supplied in every valid configuration. The plugin no longer silently falls back to `http://localhost:3100`.
- `paperclipPublicUrl`, when supplied, must also be an absolute HTTP(S) URL.
- The settings page detects the browser origin and offers **Use detected origin**. Use this after opening the settings page from the real deployment.
- Save is blocked when `paperclipBaseUrl` is localhost but the browser is not on localhost. This prevents approval and notification links that only work from the machine running Paperclip.
- A separate localhost warning is shown for remote recipients even when the check does not hard-block.
- Changing `paperclipBaseUrl` to a new origin requires **Test configuration** before saving if it differs from the last validated saved value.

### 3. Test the configuration

In plugin settings, click **Test configuration**. It validates the current unsaved settings with the Paperclip host, resolves the bot-token secret, verifies the bot with Telegram `getMe`, probes chat reachability, and checks the Paperclip API origin.

Do not save an origin override until Test configuration passes. After a successful test, the settings page warns if the origin changed again; run Test configuration after that change.

## Bot token secret creation

Never paste a raw bot token into plugin settings. The `telegramBotTokenRef` field must be a Paperclip secret UUID (or a secret-ref object containing one). Raw tokens are treated as activation errors.

### Bot token from Telegram

1. Open Telegram and message @BotFather.
2. Run `/newbot` and follow the prompts.
3. Store the resulting token in a password manager. Do not commit it.
4. Send at least one message to the bot.
5. Get the user and chat IDs:

   ```sh
   curl "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
   ```

   For a direct message, use the `message.from.id` value as your allowlisted user ID and `message.chat.id` as your chat ID. For a group, use the group chat ID.

### Create the secret in Paperclip

Use the Paperclip UI:

1. Open any agent's Configuration, then Environment variables.
2. Enter a name such as `telegram-bot-token`.
3. Enter the bot token as the value and click **Create / Seal**.
4. The secret is created at the company level; the agent-context UI is only where you reach the form.
5. Copy the returned UUID.

or use the REST API:

```sh
curl -X POST http://127.0.0.1:3100/api/companies/{companyId}/secrets \
  -H "Content-Type: application/json" \
  -d '{"name":"telegram-bot-token","value":"<YOUR_BOT_TOKEN>","provider":"local_encrypted"}'
```

The response returns metadata and the secret UUID. Copy that UUID into `telegramBotTokenRef`. The API never returns the token again after creation.

Use the same pattern for optional secrets:

- `transcriptionApiKeyRef`: OpenAI API key for Whisper transcription. Create a secret such as `telegram-whisper-key`.
- `paperclipBoardApiTokenRef`: supported as a manual fallback, but prefer Board Access Connection because the plugin tracks the secret for you.

### Secret-ref format accepted by the worker

The host accepts either a bare UUID string or an object:

```json
{
  "type": "secret_ref",
  "secretId": "12f7ed4a-1234-4d0c-9abc-bd58d44d15e1"
}
```

Values containing the raw token, a full JSON response, a non-UUID, or a missing field fail validation with a message of the form:

```text
telegramBotTokenRef must be the UUID of a Paperclip secret
(format 8-4-4-4-12, e.g. "12f7ed4a-1234-4d0c-9abc-bd58d44d15e1"). Got ...
```

## Allowlist setup

Carefully configure allowlists before enabling commands or inbound replies. Telegram does not provide a BotFather setting to suppress direct messages while keeping group use, so an empty allowlist makes the bot public.

Configuration keys:

- `allowedTelegramUserIds`: Telegram user IDs permitted to use the bot. Empty means any user is allowed.
- `allowedTelegramChatIds`: Telegram chat IDs where the bot accepts interactions. Empty means any chat is allowed.
- If both are configured, both must match. Each configured dimension independently filters requests.
- The allowlists apply to bot commands, inbound replies routed to Paperclip, media intake, and inline button callbacks.

Use settings with caution:

- Enable `enableCommands` and `enableInbound` only after at least one allowlist is non-empty.
- The host-side plugin config policy rejects configurations where either flag is true and both allowlists are empty. In the UI, this appears as "enableCommands/enableInbound requires a non-empty allowedTelegramUserIds or allowedTelegramChatIds."
- The current pinned plugin predates the upstream equality of that check, so treat the Paperclip host as the controlling validation layer on 0.8.1.
- After changing allowlists, save plugin settings. Restart the plugin if new values are not picked up.

Recommended initial configuration:

```json
{
  "enableCommands": true,
  "enableInbound": true,
  "allowedTelegramUserIds": ["123456789"],
  "allowedTelegramChatIds": ["987654321"]
}
```

M1 defaults from PUP-89:

- `notifyOnAgentRunStarted`: false
- `notifyOnAgentRunFinished`: false
- `notifyOnAgentError`: true
- `onlyNotifyBoardApprovals`: true
- lifecycle data is intentionally sparse to avoid spamming Telegram chats
- `enableCommands` may be true after an allowlist is present
- `enableInbound` may be true after an allowlist is present

## Board Access Connection

Approval buttons and `/approve <approval-id>` call Paperclip approval APIs. On authenticated Paperclip deployments, these mutations need a board API token. Use **Board Access Connection** so the token is created and tracked as a company secret.

Steps:

1. Open the Telegram plugin settings page inside a company. The page must have a company context; the connection status is otherwise unavailable.
2. Find **Board Access Connection**. The badge starts as **Not connected**.
3. Click **Connect board access**.
4. Approve the Paperclip board-access request in the opened approval window.
5. The plugin stores the resulting board API token as a Paperclip company secret and keeps only the secret reference in its state.
6. The UI shows **Secret UUID: `<uuid>` - read-only; rotate by reconnecting.** and the connection date.
7. The badge changes to **Connected**, with an identity and company label.

Use the manual fallback field only when needed:

- `paperclipBoardApiTokenRef` remains supported for `/approve` and approval-button mutations.
- Create the secret yourself and paste its UUID if organizational policy prohibits interactive board access.
- Prefer Board Access Connection whenever it is available; it tracks storage and rotation.

On authenticated instances, approval buttons that are clicked before Board Access is connected, or with an invalid fallback token, fail with a board access or origin error. Test from an allowlisted user account, not from a notification preview.

## Commands

The pinned plugin provides these commands:

### Status and discovery

- `/status` - active agents and recent completions
- `/issues` - open issues
- `/agents` - agent list with status indicators
- `/help` - all available commands

### Approvals

- `/approve <id>` - approve a pending approval; requires board access on authenticated Paperclip
- `/connect <company>` - link the current chat to a Paperclip company
- `/connect_topic <project-name> [topic-id]` - map a forum topic to an existing project

### Forum topics

- `/topics list`
- `/topics remove <project-name>`
- `/topics clear`

### Multi-agent threads

- `/acp spawn <agent>` - start an agent session in the current thread
- `/acp status`
- `/acp cancel`
- `/acp close`

### Custom workflow commands

- `/commands import <json>`
- `/commands list`
- `/commands run <name> [args]`
- `/commands delete <name>`

Imported commands cannot override built-in commands. Workflow steps may call `fetch_issue`, `invoke_agent`, `http_request`, `send_message`, `create_issue`, `wait_approval`, or `set_state`. Template values include `{{arg0}}`, `{{args}}`, `{{prev.result}}`, and `{{step_id.result}}`.

Use `/status` as the smoke test. It is the first command in the 15-minute path and fails early if origin, `defaultChatId`, allowlist, or bot-token resolution is wrong.

## Tests

### Host automation

Run the allowlist policy tests:

```sh
pnpm run preflight:workspace-links
npx vitest run server/src/services/plugin-config-policy.test.ts
```

Run the pinned upstream compatibility job:

```sh
pnpm run test:plugin-telegram-compat
```

It installs `paperclip-plugin-telegram@0.8.1` against the pinned SDK, verifies integrity hashes, typechecks the published plugin types, and checks pinned behavior such as allowlist enforcement. If the pin moves, update integrity hashes and `PINNED_PLUGIN_ENFORCES_ALLOWLIST` with the same commit.

### Test checklist

- [ ] `paperclipai plugin target` reaches the intended Paperclip, shows the expected version and mode.
- [ ] Plugin status is ready, not error/disabled. Inspect with `paperclipai plugin inspect paperclip-plugin-telegram`.
- [ ] Company secret UUID is pasted into `telegramBotTokenRef`.
- [ ] Secret-ref resolution during Test configuration returns no error.
- [ ] Telegram bot identity resolves through `getMe`.
- [ ] `defaultChatId` receives plugin notifications.
- [ ] An allowlisted user can run `/status` from Telegram.
- [ ] A non-allowlisted user cannot run commands and gets no inbound action.
- [ ] An inbound reply to a notification creates a Paperclip issue comment.
- [ ] An approved approval with board access can be completed from Telegram.
- [ ] Host origin validation passes for both `paperclipBaseUrl` and `paperclipPublicUrl`.
- [ ] Reverse-proxy deployments forward host/proto headers and pass origin checks.
- [ ] `/help` documents the command set available to your users.

### Negative cases

The following should fail and be reported as user or configuration errors, not plugin bugs:

- Raw bot token or JSON response in `telegramBotTokenRef`.
- Empty allowlist while `enableCommands` or `enableInbound` is true. Host policy rejects this as `enableCommands/enableInbound requires a non-empty allowedTelegramUserIds or allowedTelegramChatIds`.
- `paperclipBaseUrl` missing or using a non-HTTP(S) scheme such as `ftp://`.
- Invalid non-empty `paperclipPublicUrl`.
- Saving a localhost `paperclipBaseUrl` from a browser whose origin is not localhost.
- Running Paperclip against the wrong `PAPERCLIP_API_URL`.
- Triggering approval buttons before Board Access Connection on authenticated Paperclip.
- Reusing one Telegram bot with two Paperclip runtimes; `getUpdates` polling collisions produce 409 Conflict.
- Sending commands from a non-allowlisted user or non-allowlisted chat.
- Sending media with no configured transcription key when transcription is expected.
- Locking `enableCommands`/`enableInbound` off to protect data without updating allowlists, leaving a prior open public bot.
- Registering a custom workflow command named like a built-in.
- Leaving `defaultChatId` blank and expecting direct-message notifications.

## Recovery troubleshooting

### Bot token and secret issues

- **Plugin reports a raw-token activation error:** recreate the secret with `POST /api/companies/{companyId}/secrets`, copy only the returned UUID, and paste it into `telegramBotTokenRef`. Do not paste the token or entire response.
- **Test configuration says the secret cannot be resolved:** ensure the UUID belongs to the same company and has not been deleted or rotated. Recreate the secret if it predates the current instance.
- **Bot identity check fails:** verify the token with `curl https://api.telegram.org/bot<token>/getMe`; if that fails, the token is invalid or revoked.
- **Transcription is unavailable:** create an OpenAI Whisper secret and set `transcriptionApiKeyRef`. Verify media files are below Telegram's limits and have a downloadable file ID.

### Origin and Paperclip URL issues

- **`paperclipBaseUrl` is localhost in remote deployments:** open settings from the public Paperclip URL, use **Use detected origin**, and run Test configuration before saving.
- **Save is blocked on a localhost mismatch:** this is correct behavior. Set the deployment origin explicitly, then test.
- **Approval buttons return 403 or use the wrong host:** check for reverse-proxy header forwarding. Forwarded host/proto headers must reach Paperclip so board-mutation origin checks pass.
- **Paperclip responds but is not a Paperclip API:** `/api/health` should return deployment mode and version. If it returns HTML, fix the proxy path or API base.
- **Bot replies with dead approval links after deploying:** update `paperclipBaseUrl` or `paperclipPublicUrl` and re-run Test configuration.

### Commands and replies

- **No response to `/status`:** confirm plugin status is ready, the bot process has started, `defaultChatId` is set, the sender and chat are on allowlists, and the bot was added to the target group. Link the chat with `/connect` where required.
- **`/status` works but commands work only in DMs:** group chat bot privacy or permissions may block updates. Add the bot as an administrator and allow read permission, or use the DM for operator commands.
- **Commands cannot be enabled:** add at least one non-empty allowlist and re-validate. The host requires both allowlists not be empty when `enableCommands` or `enableInbound` is true.
- **Inbound replies do not appear in Paperclip:** enable `enableInbound`, add the originating user/chat to the allowlists, and verify the replied-to notification is linked to an issue. Restart the plugin if settings are not picked up.
- **Reply routing targets the wrong object:** replies are routed from message context. Reply directly to the bot notification, not to a copied forwarded message.
- **Notification delivery stops but `getUpdates` keeps polling:** another runtime instance may use the same bot. Stop duplicate Paperclip workers before restarting.

### Approvals and board access

- **Approval buttons spin or return auth errors:** run Board Access Connection inside a company and confirm the badge is **Connected**. Reconnect after secret rotation.
- **Board Access Connection shows `Not connected`:** open settings while inside company context and authorize the request in the new window. Popup blockers can prevent completion.
- **Only some approvals are delivered when expected:** check `onlyNotifyBoardApprovals`; with true, the plugin emits only `request_board_approval` approvals.
- **Approval buttons work only for board requests, not internal approvals:** this is expected when `onlyNotifyBoardApprovals` is true. Disable it only when the team wants all approvals on Telegram.

### Allowlists, restarts, and concurrency

- **Allowlist changes take effect only after a restart:** save settings, then disable and enable the plugin, or restart Paperclip. Re-run `/status`.
- **Empty allowlist restored after update:** host validation may have rejected the change. Inspect the settings error and retry with normalized string IDs.
- **Integer IDs are accepted internally as strings:** rely on the strings in allowlist arrays and avoid quoted JSON that contains spaces around each ID.
- **Two users share one command session:** each Telegram user acts independently. Remove shared operators from allowlists until ownership is clear.

### Version and compatibility

- **`paperclipai plugin target` says the server is older than expected:** upgrade Paperclip, rerun target, then retest. Do not debug Telegram configuration against an outdated Paperclip build.
- **The PUP-97 review or PUP-98 QA failures restrict rollout:** review the host policy tests, config policy, and secret-ref validation before changing the pin.
- **`paperclip-plugin-telegram` is at the wrong version:** reinstall with `--version 0.8.1`, or uninstall and install again. 0.6.x behavior is incompatible because `telegramBotTokenRef` changed from a raw token to a secret UUID.
- **Known pending work:** PUP-96 tracks managed distribution bundle. Until it closes, follow the self-hosted installation path even on managed Paperclip instances.

## Related Paperclip surfaces

- Secrets API: `GET /api/companies/{companyId}/secrets`, `POST /api/companies/{companyId}/secrets`
- Plugin target CLI: `paperclipai plugin target`
- Plugin settings: Telegram Plugin Settings page inside a company
- Secret validation: `server/src/services/plugin-config-policy.ts`
- Pinned plugin compatibility: `tests/plugin-telegram-compat`
- Parent adoption task: PUP-89
