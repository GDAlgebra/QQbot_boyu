import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

await loadDotEnv();

const config = {
  mode: process.env.ACTION_MODE || "check-and-send",
  onebotUrl: process.env.ONEBOT_HTTP_URL || "",
  token: process.env.ONEBOT_ACCESS_TOKEN || "",
  targetType: process.env.QQ_TARGET_TYPE || "private",
  targetId: process.env.QQ_TARGET_ID || "",
  rssUrl: process.env.X_RSS_URL || "",
  username: process.env.X_USERNAME || "",
  stateFile: process.env.STATE_FILE || "state/latest-post.json",
  messageFile: process.env.MESSAGE_FILE || ".run/message.txt",
  sendFirstRun: process.env.SEND_FIRST_RUN === "1",
  dryRun: process.env.DRY_RUN === "1",
  manualMessage: process.env.MANUAL_MESSAGE || "",
};

if (config.mode === "check") {
  await checkForMessage(config);
} else if (config.mode === "send") {
  await sendPreparedMessage(config);
} else {
  const shouldSend = await checkForMessage(config);
  if (shouldSend) await sendPreparedMessage(config);
}

async function checkForMessage(config) {
  validateBasicConfig(config);

  if (config.manualMessage) {
    await writeTextFile(config.messageFile, config.manualMessage);
    await setOutput("should_send", "true");
    await setOutput("state_changed", "false");
    console.log("Manual QQ message is required.");
    return true;
  }

  const latestPost = await fetchLatestPost(config);

  const previousPost = await readState(config.stateFile);
  if (!config.manualMessage && isSamePost(previousPost, latestPost)) {
    console.log("No new X post found. QQ will not be started.");
    await setOutput("should_send", "false");
    await setOutput("state_changed", "false");
    return false;
  }

  await writeState(config.stateFile, latestPost);
  await setOutput("state_changed", "true");

  if (!config.manualMessage && !config.sendFirstRun && !previousPost.id) {
    console.log("First run: recorded the latest post without sending.");
    console.log("Set SEND_FIRST_RUN=1 if you want the first run to send the latest post.");
    await setOutput("should_send", "false");
    return false;
  }

  const text = config.manualMessage || formatPost(latestPost, config);
  await writeTextFile(config.messageFile, text);
  await setOutput("should_send", "true");
  console.log("A QQ message is required.");
  return true;
}

async function sendPreparedMessage(config) {
  validateSendConfig(config);

  const text = await readFile(config.messageFile, "utf8");
  if (config.dryRun) {
    console.log("DRY_RUN=1, preview only. No QQ message will be sent.");
    console.log(text);
    return;
  }

  await sendOneBotMessage(config, [{ type: "text", data: { text } }]);
  console.log("QQ message sent successfully.");
}

async function fetchLatestPost({ rssUrl, username }) {
  const candidates = rssUrl
    ? [rssUrl]
    : [
        `http://127.0.0.1:1200/twitter/user/${encodeURIComponent(username)}`,
        `https://rsshub.app/twitter/user/${encodeURIComponent(username)}`,
        `https://nitter.net/${encodeURIComponent(username)}/rss`,
        `https://xcancel.com/${encodeURIComponent(username)}/rss`,
      ];

  const errors = [];
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "QQ-X-Scheduled-Notifier/1.0",
          accept: "application/rss+xml, application/xml, text/xml, */*",
        },
        signal: AbortSignal.timeout(30000),
      });

      const text = await response.text();
      if (!response.ok) {
        errors.push(`${url} -> HTTP ${response.status}: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
        continue;
      }

      const post = parseItems(text)[0];
      if (!post) {
        errors.push(`${url} -> no post parsed`);
        continue;
      }

      return { ...post, source: url };
    } catch (error) {
      errors.push(`${url} -> ${error.message}`);
    }
  }

  fail(["All RSS sources failed.", ...errors.map((line) => `- ${line}`)].join("\n"));
}

async function sendOneBotMessage({ onebotUrl, token, targetType, targetId }, message) {
  const action = targetType === "group" ? "send_group_msg" : "send_private_msg";
  const body =
    targetType === "group"
      ? { group_id: Number(targetId), message }
      : { user_id: Number(targetId), message };

  const response = await fetch(`${trimEnd(onebotUrl, "/")}/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  const text = await response.text();
  if (!response.ok) {
    fail(`QQ send API failed: HTTP ${response.status}\n${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (data?.status && data.status !== "ok") {
    fail(`QQ send API returned failure: ${text}`);
  }
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(path, post) {
  await writeTextFile(path, `${JSON.stringify(post, null, 2)}\n`);
}

async function writeTextFile(path, text) {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex !== -1) {
    await mkdir(path.slice(0, slashIndex), { recursive: true });
  }
  await writeFile(path, text, "utf8");
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

function parseItems(xml) {
  const matches = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return matches.map(parseItem).filter(Boolean);
}

function parseItem(item) {
  const title = decodeXml(readTag(item, "title") || "");
  const link =
    decodeXml(readTag(item, "link") || "") ||
    decodeXml((item.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i) || [])[1] || "");
  const guid = decodeXml(readTag(item, "guid") || readTag(item, "id") || "");
  const published = decodeXml(readTag(item, "pubDate") || readTag(item, "published") || readTag(item, "updated") || "");
  const html = decodeXml(readTag(item, "description") || readTag(item, "summary") || "");
  const description = decodeXml(stripTags(html));
  const id = guid || link || title;

  if (!id || (!title && !description)) return null;

  return {
    id,
    title: title || description,
    link,
    published,
  };
}

function formatPost(post, { username }) {
  return [
    username ? `X new post: @${username}` : "X new post",
    post.published ? `Time: ${post.published}` : "",
    `Content: ${post.title}`,
    post.link ? `Link: ${post.link}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function isSamePost(previous, current) {
  return previous.id === current.id || (previous.link && previous.link === current.link);
}

function readTag(text, tag) {
  const match = text.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "") : "";
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, " ");
}

function decodeXml(text) {
  let result = text;
  for (let index = 0; index < 3; index++) {
    const next = result
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    if (next === result) break;
    result = next;
  }
  return result.replace(/\s+/g, " ").trim();
}

function validateBasicConfig({ targetType, rssUrl, username }) {
  if (!["private", "group"].includes(targetType)) {
    fail("QQ_TARGET_TYPE must be private or group.");
  }

  if (!rssUrl && !username && !process.env.MANUAL_MESSAGE) {
    fail("Please set X_USERNAME, or set X_RSS_URL directly.");
  }
}

function validateSendConfig({ onebotUrl, targetId }) {
  if (!onebotUrl) fail("Missing ONEBOT_HTTP_URL.");
  if (!/^\d+$/.test(String(targetId))) fail("QQ_TARGET_ID must be a numeric QQ id or group id.");
}

function trimEnd(text, suffix) {
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function loadDotEnv() {
  try {
    const text = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const index = line.indexOf("=");
      if (index === -1) continue;

      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional. GitHub Actions will provide values through Secrets and Variables.
  }
}
