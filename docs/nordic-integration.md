# Nordic Byte integration (MeshByte)

MeshByte's side of the Nordic Byte integration contract v1 (product id `meshbyte`). The wire
format is defined in `nordic-contracts.md` of the EventPilot repository; this page says what
this fork implements, how to configure it and how to put it in production.

Everything lives in `nordic.js`. Upstream files carry two one-line hooks, both marked
`MeshByte: Nordic Byte platform integration`:

- `meshcentral.js`: creates the module before the web server, only when a `nordic` section exists.
- `webserver.js` (`setupHTTPHandlers`): lets the module register its routes.

Without a `nordic` section the module is never loaded: no route, no listener, no behaviour change.

## What it does

| Contract | Here |
|---|---|
| 1. Identity | Configuration only, see [Sign-in](#sign-in-with-nordic-byte-openid-connect). |
| 2. Space | `POST /.well-known/nordic/events` applies `space.member_added`, `space.member_removed`, `space.role_changed`. |
| 3. Link cards | `GET /.well-known/nordic/resolve` for `device` and `group`. |
| 4. Events | Sends `device.online`, `device.offline`, `device.help_requested`, `session.started`, `session.ended`. Subscriptions in the configuration and at `GET/POST/DELETE /api/webhooks`. |
| 5. Commands | `POST /.well-known/nordic/commands`, verb `/mesh <device>`. |
| 6. Secrets | Not implemented: secrets are read from `config.json` or from environment variables, `sgc://` references are not resolved. |

All routes are relative to the domain URL (`/` for the default domain).

### Events sent

The server's own event stream is the source, nothing is polled.

| Type | Source | `data` |
|---|---|---|
| `device.online` | `nodeconnect` going from no connection to any connection (agent, CIRA, AMT, MQTT) | `group` |
| `device.offline` | `nodeconnect` going to no connection, after the grace period | `group`, `since` |
| `device.help_requested` | agent log message 98 (the user asked for help in the agent) | `group`, `user`, `message` |
| `session.started` | relay log messages 13, 14, 15, 16, 162, 120 | `group`, `session`, `kind` (`desktop`, `terminal`, `files`, `messenger`, `relay`), `guest` for a shared link |
| `session.ended` | relay log messages 9, 10, 11, 12, 112, 121, once per session | the same plus `seconds` |

- `object` is `{ type: "device", id: <node id>, url, title: <device name> }`.
- `space` is `{ id }` of the space whose `meshes` list contains the device group, otherwise `null`.
- `actor` is `null` for device events. For sessions it is `{ id, name }`, where `id` is the Talk
  `sub` when the account came from the OIDC sign-in and the MeshCentral user id otherwise.
- Network addresses are never included.
- `device.offline` is held for `graceSeconds` (60 by default). If the device is back before
  that, nothing is sent: neither the offline nor a new online.
- Devices that connect in the first `startupQuietSeconds` (120 by default) after the server
  starts are tracked but not announced, so a restart does not announce every device.
- Delivery: `https` only, the host is resolved first and refused when any address is private,
  loopback, link-local or reserved, the request goes to the address that was checked, redirects
  are not followed. Signed again on each attempt. Retries after 2, 10 and 60 seconds, then the
  event is dropped (there is no persistent queue; events raised while the server is down or
  restarting are lost).

### Link cards

Links are the ones the web UI produces itself:

```
device   https://<server>/?viewmode=10&gotonode=<node id>
group    https://<server>/?viewmode=20&gotomesh=<group id>
```

The id is the last part of the MeshCentral id (64 characters) or its 96 hexadecimal characters.
Any `viewmode` is accepted, only `gotonode` / `gotomesh` matter. The host must be this server
and the path must be the domain URL.

`X-Nordic-User` is the Talk `sub`; it maps to the account `user/<domain>/~oidc:<sub>`, the one
the OIDC sign-in creates. A MeshCentral user id of the same domain (`user/<domain>/<name>`) is
accepted too.

- Device: shown only when `GetNodeWithRights` reports the device visible to that user (direct
  link, device group link or user group link, exactly as in the web UI). Status `Online` /
  `Offline`, fields `Group`, `System` (the OS description), `Last contact`. Action
  `open_session` (with a `url` to the desktop tab, `viewmode=11`) only with remote control or
  remote view rights; `open` always.
- Group: shown only when `IsMeshViewable` is true. Status `<n> of <m> online`.
- `401` without the token or when none is configured, `400` without a usable `X-Nordic-User`,
  `404` for everything else, including an unknown person, a locked account, another host and
  an object the person cannot see. The body of a `404` is always the same.

### Space membership

`space.id` is looked up in `spaces`. An unknown space answers `202` and changes nothing. A
repeated event `id` is applied once.

| Talk role | Result |
|---|---|
| `owner`, `admin` | Member of the space's user group, and full administrator of every device group in the space's `meshes`. |
| `member` | Member of the space's user group: the rights that user group has. |
| `guest`, removed | Taken out of the user group; administrator links created here are removed. |

- The account is `user/<domain>/~oidc:<sub>`. If it does not exist yet it is created (name and
  email from the event), so the person does not need to be invited again and the first sign-in
  lands in an account that already has its groups. `provisionUsers: false` turns this off; then
  a membership for someone who never signed in is answered `no_account` and is lost.
- Administrator links created here are marked `nordic: 1`. Only marked links are ever removed.
  A link somebody made or edited by hand in the UI is never changed, including when it grants less than
  the Talk role would.
- The user group and the device groups must already exist. The rights of the user group on the
  device groups are set in the MeshByte UI as usual. A user group that does not exist answers
  `usergroup_missing`.
- User groups managed by another directory (`membershipType` set) are left alone.
- An account is never deleted.

### `/mesh <device>`

Talk publishes the `text` of the answer in the channel where the command was typed, so the
answer is not private to the person who typed it. For that reason the search is limited to
the device groups of the space the command came from (`spaces[].meshes`) and, inside them, to
the devices the person can see. A space that is not in `spaces` gets "This space is not
connected to MeshByte".

The name is matched without case; an exact name wins, otherwise a single partial match. The
answer is `{ text, card }`: three lines of text ending in `Open remote session: <url>`, and the
same card `resolve` returns. Someone without an account, without rights or asking for a device
that does not exist gets the same "No device named ..." text.

### `/api/webhooks`

For full site administrators, authenticated with the browser session of the web UI.
`POST` and `DELETE` are refused when the `Origin` header is another site, and `POST` must be
`application/json`. There is no page for it in the UI; it is an API.

```
GET    /api/webhooks                       list, never the secret (includes the ones from config)
POST   /api/webhooks { url, events?, name? }   201, with the secret this once (prefix mbw_)
DELETE /api/webhooks/<id>                  only subscriptions created here
```

Subscriptions created here are stored in the MeshCentral database as one record per domain
(`nordicwebhooks/<domain>`), with their secrets, at most 20.

## Configuration

A `nordic` object inside a domain of `config.json`. At `settings` level it applies to the
default domain when that domain has none. Key names are not case sensitive (MeshCentral lowers
them); values are.

```json
"domains": {
  "": {
    "nordic": {
      "publicUrl": "https://meshbyte.nordicbyte.co.uk/",
      "resolveToken": "<service token Talk sends as Bearer>",
      "eventsSecret": "<secret Talk signs space events with>",
      "talkBotSecret": "<secret of the MeshByte bot in Talk>",
      "graceSeconds": 60,
      "startupQuietSeconds": 120,
      "provisionUsers": true,
      "webhooksApi": true,
      "webhooks": [
        { "name": "Talk #support", "url": "https://<destination>", "secret": "<per subscription>", "events": ["device.offline", "device.help_requested"] }
      ],
      "spaces": [
        { "id": "<Talk space id>", "userGroup": "<user group name or id>", "meshes": ["<device group name or id>"] }
      ]
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `publicUrl` | `https://<domain dns or certificate name>[:aliasPort]<domain url>` | Address used in every link and to recognise our own links. |
| `resolveToken` | env `NORDIC_RESOLVE_TOKEN` | Bearer token of `resolve`. Unset: `401`. |
| `eventsSecret` | env `NORDIC_EVENTS_SECRET` | Verifies `POST /.well-known/nordic/events`. Unset: `401`. |
| `talkBotSecret` | env `NORDIC_TALK_BOT_SECRET` | Verifies `POST /.well-known/nordic/commands`. Unset: `401`. |
| `graceSeconds` | `60` | How long a device may be away before `device.offline`. `0` sends at once. |
| `startupQuietSeconds` | `120` | After a start, connections in this time are not announced. |
| `provisionUsers` | `true` | Create the account of a new space member before the first sign-in. |
| `webhooksApi` | `true` | `false` removes `/api/webhooks` (404) and ignores subscriptions stored in the database. |
| `webhooks[]` | none | `url` (https), `secret` (required), `events` (all when missing), `name`. |
| `spaces[]` | none | `id` Talk space id. `userGroup`: `ugrp/<domain>/<id>`, the bare id or the name. `meshes`: for each device group `mesh/<domain>/<id>`, the bare id or the name. |
| `allowPrivateDestinations` | `false` | Testing only: allows `http` and private addresses as webhook destinations. |

An empty `"nordic": {}` loads the module with every receiver answering `401` and nothing sent.

The `nordic` key is not in `meshcentral-config-schema.json`; the server does not validate the
file against the schema, an editor may underline it.

## Sign-in with Nordic Byte (OpenID Connect)

No code was added for this. MeshCentral's `authStrategies.oidc` is used as it is.

```json
"domains": {
  "": {
    "authStrategies": {
      "oidc": {
        "issuer": { "issuer": "https://<talk issuer>" },
        "client": {
          "client_id": "<client id registered in Talk>",
          "client_secret": "<client secret>",
          "redirect_uri": "https://meshbyte.nordicbyte.co.uk/auth-oidc-callback"
        },
        "custom": {
          "scope": ["openid", "profile", "email", "spaces"],
          "buttonText": "Sign in with Nordic Byte"
        },
        "newAccounts": true
      }
    }
  }
}
```

What to register in Talk for this client:

| Item | Value |
|---|---|
| Redirect URI | `https://meshbyte.nordicbyte.co.uk/auth-oidc-callback` |
| Post-logout redirect URI | `https://meshbyte.nordicbyte.co.uk/login` |
| Sign-in starts at | `https://meshbyte.nordicbyte.co.uk/auth-oidc` |
| Client authentication | `client_secret_basic` (the library default) |

Read from the code (`webserver.js`, `setupDomainAuthStrategy` and `handleStrategyLogin`), not
yet run against the Talk provider, which did not exist when this was written:

- Works without code changes:
  - Discovery from `<issuer>/.well-known/openid-configuration`, three attempts at start. If it
    fails the strategy is switched off for that run and the server shows a warning.
  - The account id is `user/<domain>/~oidc:<sub>`. Do not set `custom.claims.uuid`, it would
    replace `sub` and break the mapping used by cards, events and commands.
  - `name` and `email` are copied at each sign-in.
  - `state`, `nonce`, signature, `iss`, `aud` and `exp` are checked by `openid-client`
    (5.7.1), which also uses PKCE `S256` by default.
  - Logging out of MeshByte goes to the provider's `end_session_endpoint`.
  - `newAccounts: true` inside the strategy lets a first sign-in create the account even
    though the domain has `newAccounts: false`. With it `false`, only people already
    provisioned by a space event (or created by hand) can sign in.
  - `passport`, `connect-flash` and `openid-client` are not installed today. MeshCentral
    installs them with `npm` on the first start that finds `authStrategies.oidc`; that
    start takes longer and needs `npm` to work for the service account.
- Does not work without code changes:
  - **Group sync from `nordic_spaces`.** `groups.claim` accepts only a claim that is an array
    of strings (`validateStrArray`). `nordic_spaces` is an array of objects, so it is read as
    no groups at all. `groups.required`, `groups.siteadmin` and `groups.sync` therefore cannot
    be driven by it. Leave `groups` out. Membership comes from the space events instead (see
    above). Setting `groups` would also add a `groups` scope to the request unless
    `groups.scope` is set.
  - **Back-channel logout.** There is no `POST /auth/nordic/backchannel-logout`; a logout in
    Talk does not end MeshByte sessions.
  - **Route names.** The contract names `/auth/nordic/login` and `/auth/nordic/callback`; here
    they are `/auth-oidc` and `/auth-oidc-callback`.
  - **Linking an existing account by verified email.** A local account is not linked; the
    first sign-in creates (or finds) `~oidc:<sub>`. Rights have to be given to that account.
  - **`nordic_sub` field.** Not stored separately; it is part of the account id.

## Tests

```
node --test test/nordic.test.js
```

Signing and verification, the envelope, the grace period, destination checks and retries, link
parsing, the permission matrix of `resolve`, the two receivers, `/mesh`, the subscription API
and the "no section, nothing happens" case. The server is replaced by stubs; one test runs the
routes through express on a loopback port. No test starts MeshCentral.

Not covered by any test: the two hooks inside a running server, delivery to a real destination,
and anything against the real Talk.

## Deploy (this server)

How MeshByte runs here:

- Windows service `MeshByte` ("MeshByte (MeshCentral)"), managed by NSSM, automatic start.
- It runs `C:\nvm4w\nodejs\node.exe meshcentral.js` with working directory
  `D:\Documents\MeshCentral`: **the service runs this git working tree directly**. Whatever is
  checked out there is what loads at the next start of the service. `selfUpdate` is `false`.
- Data and configuration: `D:\Documents\meshcentral-data\` (`config.json`, NeDB databases).
  Logs: `D:\Documents\meshcentral-data\logs\out.log` and `err.log`.
- Node listens on port 8890 with `tlsOffload`; IIS/Plesk publishes it as
  `https://meshbyte.nordicbyte.co.uk` (alias port 443).

Steps, in an elevated PowerShell:

1. Have the code in the working tree: `git -C D:\Documents\MeshCentral status` shows branch
   `meshbyte-rebrand` with `nordic.js` present. With no `nordic` section this changes nothing.
2. Check that the reverse proxy passes `/.well-known/nordic/*` and `/api/webhooks*` to Node.
   Plesk can reserve `/.well-known/` for certificate challenges; if it does, add a rule for
   `/.well-known/nordic/`.
3. In MeshByte: create the user group of each space and give it its rights on the device groups.
4. In Talk: register the OIDC client (values above), the events URL
   `https://meshbyte.nordicbyte.co.uk/.well-known/nordic/events` with its secret, the bot with
   endpoint `https://meshbyte.nordicbyte.co.uk/.well-known/nordic/commands` and command `mesh`,
   and the resolve token. Keep the four secrets in SecureGate.
5. Back up and edit the configuration:
   `Copy-Item D:\Documents\meshcentral-data\config.json D:\Documents\meshcentral-data\config.json.bak-<date>`,
   then add the `nordic` section and, for the sign-in, `authStrategies.oidc`.
   Validate it: `node -e "JSON.parse(require('fs').readFileSync('D:/Documents/meshcentral-data/config.json','utf8'))"`.
6. Restart: `nssm restart MeshByte`. Remote sessions in progress are cut and every agent
   reconnects. With OIDC configured for the first time the server installs three npm packages
   first, so that start takes longer.
7. Check:
   - `Get-Content D:\Documents\meshcentral-data\logs\out.log -Tail 50` has no
     `Nordic Byte integration not loaded`, and `err.log` has nothing new.
   - `curl.exe -i "https://meshbyte.nordicbyte.co.uk/.well-known/nordic/resolve?url=x"` answers
     `401` (it answers the login page or `404` when the section is missing or the proxy does
     not forward it).
   - A signed test event to `/.well-known/nordic/events` with an unknown space answers `202`.
   - The login page shows the "Sign in with Nordic Byte" button.
8. Roll back: restore the backup of `config.json` and `nssm restart MeshByte`. Accounts and
   links created by space events stay; links created here are marked `nordic: 1`.
