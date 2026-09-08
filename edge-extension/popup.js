const DEFAULT_ITEMS = [
  { name: "煙火卡片", maxPrice: 20000000 },
  { name: "影子精工戰靴", maxPrice: 20000000 },
  { name: "防具強化原石(中級)", maxPrice: 30000 }
];

const itemsElement = document.querySelector("#items");
const template = document.querySelector("#itemTemplate");
const statusElement = document.querySelector("#status");

function setStatus(message) {
  statusElement.textContent = message;
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

function addItem(item = { name: "", maxPrice: 0 }) {
  const fragment = template.content.cloneNode(true);
  const row = fragment.querySelector(".item-row");
  row.querySelector(".item-name").value = item.name;
  row.querySelector(".item-price").value = item.maxPrice;
  row.querySelector(".remove").addEventListener("click", () => row.remove());
  itemsElement.appendChild(fragment);
}

async function load() {
  const { settings, batchStatus } = await chrome.storage.local.get(["settings", "batchStatus"]);
  document.querySelector("#webhookUrl").value = settings?.webhookUrl || "";
  document.querySelector("#cooldownMinutes").value = settings?.cooldownMinutes || 30;
  document.querySelector("#batchDelaySeconds").value = settings?.batchDelaySeconds || 10;
  document.querySelector("#server").value = settings?.server || "波利";
  document.querySelector("#storeType").value = settings?.storeType || "販售";
  (settings?.items || DEFAULT_ITEMS).forEach(addItem);
  if (batchStatus?.message) setStatus(batchStatus.message);
}

async function save() {
  const items = [...document.querySelectorAll(".item-row")]
    .map(row => ({
      name: row.querySelector(".item-name").value.trim(),
      maxPrice: Number(row.querySelector(".item-price").value)
    }))
    .filter(item => item.name && Number.isFinite(item.maxPrice));
  const settings = {
    webhookUrl: normalizeWebhookUrl(document.querySelector("#webhookUrl").value),
    cooldownMinutes: Number(document.querySelector("#cooldownMinutes").value || 30),
    batchDelaySeconds: Math.max(5, Number(document.querySelector("#batchDelaySeconds").value || 10)),
    server: document.querySelector("#server").value,
    storeType: document.querySelector("#storeType").value,
    items
  };
  document.querySelector("#webhookUrl").value = settings.webhookUrl;
  await chrome.storage.local.set({ settings });
  setStatus("設定已儲存在此 Edge 個人資料中。");
}

document.querySelector("#addItem").addEventListener("click", () => addItem());
document.querySelector("#save").addEventListener("click", save);
document.querySelector("#importEnv").addEventListener("click", () => {
  document.querySelector("#envFile").click();
});
document.querySelector("#envFile").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  const parsed = normalizeWebhookUrl(await file.text());
  if (!parsed) {
    setStatus(".env 中找不到有效的 Discord Webhook URL。");
    return;
  }
  document.querySelector("#webhookUrl").value = parsed;
  await save();
  setStatus("已從 .env 匯入並儲存 Webhook。");
  event.target.value = "";
});
document.querySelector("#test").addEventListener("click", async () => {
  await save();
  setStatus("正在發送測試…");
  const result = await chrome.runtime.sendMessage({ type: "TEST_DISCORD" });
  setStatus(
    result.ok
      ? "Discord 已建立訊息。頻道 ID：" + result.channelId + "；訊息 ID：" + result.messageId
      : "測試失敗：" + result.reason
  );
});

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://event.gnjoy.com.tw/Ro/RoShopSearch")) {
    throw new Error("請先切換到露天商店查詢頁。");
  }
  return chrome.tabs.sendMessage(tab.id, message);
}

document.querySelector("#startBatch").addEventListener("click", async () => {
  try {
    await save();
    const { settings } = await chrome.storage.local.get(["settings"]);
    const response = await sendToActiveTab({ type: "START_BATCH", settings });
    setStatus(response?.reason || "本輪查詢已開始。");
    if (response?.ok) window.close();
  } catch (error) {
    setStatus("無法開始：" + error.message);
  }
});

document.querySelector("#stopBatch").addEventListener("click", async () => {
  try {
    const response = await sendToActiveTab({ type: "STOP_BATCH" });
    setStatus(response?.reason || "已要求停止。");
  } catch (error) {
    setStatus("無法停止：" + error.message);
  }
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.batchStatus?.newValue?.message) {
    setStatus(changes.batchStatus.newValue.message);
  }
});

load().catch(error => setStatus("載入失敗：" + error.message));
