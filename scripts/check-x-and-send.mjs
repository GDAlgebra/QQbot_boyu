import { mkdir, readFile, writeFile } from "node:fs/promises";

await loadDotEnv();

const config = {
  onebotUrl: process.env.ONEBOT_HTTP_URL || "",
  token: process.env.ONEBOT_ACCESS_TOKEN || "",
  targetType: process.env.QQ_TARGET_TYPE || "private",
  targetId: process.env.QQ_TARGET_ID || "",
  rssUrl: process.env.X_RSS_URL || "",
  username: process.env.X_USERNAME || "",
  stateFile: process.env.STATE_FILE || "state/latest-post.json",
  sendFirstRun: process.env.SEND_FIRST_RUN === "1",
  dryRun: process.env.DRY_RUN === "1",
  manualMessage: process.env.MANUAL_MESSAGE || "",
};

validateBasicConfig(config);

const latestPost = config.manualMessage
  ? buildManualPost(config.manualMessage)
  : await fetchLatestPost(config);

const previousPost = await readState(config.stateFile);
if (!config.manualMessage && isSamePost(previousPost, latestPost)) {
  console.log("没有发现新推文，本次不发送。");
  process.exit(0);
}

await writeState(config.stateFile, latestPost);

if (!config.manualMessage && !config.sendFirstRun && !previousPost.id) {
  console.log("第一次运行：只记录当前最新推文，不发送。");
  console.log("如果希望第一次运行也发送，请把 SEND_FIRST_RUN 设置为 1。");
  process.exit(0);
}

const text = config.manualMessage || formatPost(latestPost, config);
if (config.dryRun) {
  console.log("DRY_RUN=1，只预览消息，不会发送。");
  console.log(text);
  process.exit(0);
}

validateSendConfig(config);
await sendOneBotMessage(config, [{ type: "text", data: { text } }]);
console.log("发现新推文，QQ 消息发送成功。");

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
        errors.push(`${url} -> 没有解析到推文`);
        continue;
      }

      return { ...post, source: url };
    } catch (error) {
      errors.push(`${url} -> ${error.message}`);
    }
  }

  fail(["所有 RSS 来源都请求失败。", ...errors.map((line) => `- ${line}`)].join("\n"));
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
    fail(`QQ 发送接口失败：HTTP ${response.status}\n${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (data?.status && data.status !== "ok") {
    fail(`QQ 发送接口返回失败：${text}`);
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
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex !== -1) {
    await mkdir(path.slice(0, slashIndex), { recursive: true });
  }
  await writeFile(path, `${JSON.stringify(post, null, 2)}\n`, "utf8");
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
    username ? `X 新推文：@${username}` : "X 新推文",
    post.published ? `时间：${post.published}` : "",
    `内容：${post.title}`,
    post.link ? `链接：${post.link}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildManualPost(text) {
  return {
    id: `manual-${Date.now()}`,
    title: text,
    link: "",
    published: new Date().toISOString(),
    source: "manual",
  };
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
    fail("QQ_TARGET_TYPE 只能填写 private 或 group。");
  }

  if (!rssUrl && !username && !process.env.MANUAL_MESSAGE) {
    fail("请设置 X_USERNAME，或直接设置 X_RSS_URL。");
  }
}

function validateSendConfig({ onebotUrl, targetId }) {
  if (!onebotUrl) fail("缺少 ONEBOT_HTTP_URL。");
  if (!/^\d+$/.test(String(targetId))) fail("QQ_TARGET_ID 必须是纯数字 QQ 号或群号。");

  if (/^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?/i.test(onebotUrl)) {
    fail("GitHub Actions 不能访问你电脑上的 localhost / 127.0.0.1，请使用公网可访问的 QQ 发送接口。");
  }
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
