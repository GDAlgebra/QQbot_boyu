# QQ X Scheduled Notifier

This project runs in GitHub Actions. It checks an X/Twitter RSS feed every 5 minutes. If a new post is found, it starts NapCat in Docker, logs in to QQ using the cached login data, sends the QQ message, then shuts NapCat down.

## Current Flow

1. Start RSSHub and Redis in GitHub Actions.
2. Check the configured X/Twitter account.
3. If there is no new post, stop immediately without starting QQ/NapCat.
4. If there is a new post, start NapCat Docker.
5. Wait for OneBot HTTP at `http://127.0.0.1:3000`.
6. Send the QQ message.
7. Commit `state/latest-post.json` so the same post is not sent again.

The schedule is:

```yaml
- cron: "*/5 * * * *"
```

That means GitHub Actions checks every 5 minutes.

## Files To Upload

Upload these files to GitHub after each local change:

```text
.github/workflows/send-qq-message.yml
scripts/check-x-and-send.mjs
package.json
README.md
.env.example
.gitignore
```

## GitHub Secrets

Repository secrets:

```text
NAPCAT_QQ             QQ account used by NapCat
QQ_TARGET_ID          QQ user id or group id to receive messages
TWITTER_AUTH_TOKEN    auth_token cookie from x.com
TWITTER_CT0           ct0 cookie from x.com
TWITTER_COOKIE        Optional full x.com cookie
ONEBOT_ACCESS_TOKEN   Optional, leave empty if not used
```

## GitHub Variables

Repository variables:

```text
QQ_TARGET_TYPE        private or group
X_USERNAME            X/Twitter username without @
X_RSS_URL             Optional custom RSS URL
SEND_FIRST_RUN        0 or 1
```

Recommended:

```text
SEND_FIRST_RUN = 0
```

With `0`, the first run only records the current latest post and does not send an old post.

## Manual Test

Go to:

```text
Actions -> Check X and Send QQ Message -> Run workflow
```

If you enter `message`, the workflow sends that text directly to QQ. Manual tests do not update `state/latest-post.json`.

If `message` is empty, the workflow checks X/RSS and only sends when a new post is found.
