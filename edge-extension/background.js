const DEFAULT_SETTINGS = {
  webhookUrl: "",
  cooldownMinutes: 30,
  batchDelaySeconds: 10,
  server: "波利",
  storeType: "販售",
  items: [
    { name: "煙火卡片", maxPrice: 20000000 },
    { name: "影子精工戰靴", maxPrice: 20000000 },
    { name: "防具強化原石(中級)", maxPrice: 30000 }
  ]
};

async function getSettings() {
  const saved = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeWebhookUrl(value) {
  const text = String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\\_/g, "_")
    .replace(/&amp;/g, "&")
    .trim();
  const candidates = text.match(/https:\/\/[^\s<>"'\])]+/gi) || [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      const allowedHosts = [
        "discord.com",
        "canary.discord.com",
        "ptb.discord.com",
        "discordapp.com"
      ];
      if (allowedHosts.includes(parsed.hostname) && parsed.pathname.startsWith("/api/webhooks/")) {
        return parsed.toString();
      }
    } catch {
      // Try the next URL found in the pasted text.
    }
  }
  return "";
}

async function sendDiscord(webhookUrl, content) {
  const normalized = normalizeWebhookUrl(webhookUrl);
  if (!normalized) {
    throw new Error("貼上的內容中找不到有效的 Discord Webhook 網址。");
  }
  let target;
  try {
    target = new URL(normalized);
  } catch {
    throw new Error("Webhook 格式錯誤；請只貼上 https://discord.com/api/webhooks/... 網址。");
  }
  if (
    target.protocol !== "https:" ||
    !["discord.com", "canary.discord.com", "ptb.discord.com", "discordapp.com"].includes(target.hostname) ||
    !target.pathname.startsWith("/api/webhooks/")
  ) {
    throw new Error("Webhook 必須是 https://discord.com/api/webhooks/... 網址。");
  }
  target.searchParams.set("wait", "true");
  const response = await fetch(target.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });
  if (!response.ok) throw new Error("Discord HTTP " + response.status);
  const message = await response.json();
  if (!message?.id || !message?.channel_id) {
    throw new Error("Discord 未回傳已建立的訊息 ID。");
  }
  return message;
}

async function processResults(message) {
  const settings = await getSettings();
  if (!settings.webhookUrl.startsWith("https://discord.com/api/webhooks/")) {
    return { ok: false, reason: "Discord Webhook 尚未設定。" };
  }
  const itemConfig = settings.items.find(
    item => normalizeName(item.name) === normalizeName(message.keyword)
  );
  if (!itemConfig) return { ok: true, notified: false, reason: "道具不在監控清單中。" };

  const matches = message.rows
    .filter(row => normalizeName(row.itemName).includes(normalizeName(itemConfig.name)))
    .filter(row => Number.isFinite(row.price) && row.price <= Number(itemConfig.maxPrice))
    .sort((a, b) => a.price - b.price);
  if (!matches.length) return { ok: true, notified: false, reason: "沒有低於門檻的資料。" };

  const best = matches[0];
  const stateKey = "notification:" + message.server + ":" + message.storeType + ":" + itemConfig.name;
  const stored = await chrome.storage.local.get([stateKey]);
  const previous = stored[stateKey];
  const now = Date.now();
  const cooldownMs = Number(settings.cooldownMinutes || 30) * 60 * 1000;
  const due = !previous || now - previous.notifiedAt >= cooldownMs || best.price < previous.price;
  if (!due) return { ok: true, notified: false, reason: "通知仍在冷卻期內。" };

  const listingLines = matches.slice(0, 10).map((row, index) =>
    (index + 1) + ". " + row.itemName +
    "｜" + row.price.toLocaleString("zh-TW") + " Z" +
    "｜商店：" + (row.shopName || "-") +
    "｜數量：" + (row.quantity || "-")
  );
  if (matches.length > 10) {
    listingLines.push("另有 " + (matches.length - 10) + " 筆符合門檻。");
  }

  const content = [
    "**價格通知**",
    "監控關鍵字：" + itemConfig.name,
    "伺服器：" + message.server,
    "類型：" + message.storeType,
    "最低價：" + best.price.toLocaleString("zh-TW") + " Z",
    "通知門檻：" + Number(itemConfig.maxPrice).toLocaleString("zh-TW") + " Z",
    "符合門檻的表格項目（" + matches.length + " 筆）：",
    ...listingLines
  ].join("\n");

  await sendDiscord(settings.webhookUrl, content);
  await chrome.storage.local.set({
    [stateKey]: { price: best.price, notifiedAt: now }
  });
  return { ok: true, notified: true, reason: "Discord 通知已發送。" };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SHOP_RESULTS") {
    processResults(message)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, reason: error.message }));
    return true;
  }
  if (message?.type === "TEST_DISCORD") {
    getSettings()
      .then(settings => sendDiscord(settings.webhookUrl, "ShopSearch Discord 連線測試成功。"))
      .then(created => sendResponse({
        ok: true,
        messageId: created.id,
        channelId: created.channel_id
      }))
      .catch(error => sendResponse({ ok: false, reason: error.message }));
    return true;
  }
  if (message?.type === "BATCH_STATUS") {
    chrome.storage.local
      .set({ batchStatus: message.status })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
