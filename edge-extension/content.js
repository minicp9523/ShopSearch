let lastSignature = "";
let batchRunning = false;
let batchCancelled = false;

function readText(selector) {
  return document.querySelector(selector)?.textContent?.trim() || "";
}

function parsePrice(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? Number(digits) : NaN;
}

function readRows() {
  return [...document.querySelectorAll("#_tbody tr")]
    .map(row => ({
      shopName: row.querySelector(".shopName")?.textContent?.trim() || "",
      itemName: row.querySelector(".itemName")?.textContent?.trim() || "",
      price: parsePrice(row.querySelector(".price")?.textContent),
      quantity: row.querySelector(".quantity")?.textContent?.trim() || "",
      storeType: row.querySelector(".buySell")?.textContent?.trim() || ""
    }))
    .filter(row => row.itemName && Number.isFinite(row.price));
}

async function collectVisibleResults() {
  const rows = readRows();
  if (!rows.length) return;
  const keyword = document.querySelector("#txb_KeyWord")?.value?.trim() || rows[0].itemName;
  const server = readText("#div_svr");
  const storeType = readText("#div_storetype");
  const signature = JSON.stringify({ keyword, server, storeType, rows });
  if (signature === lastSignature) return;
  lastSignature = signature;
  return chrome.runtime.sendMessage({
    type: "SHOP_RESULTS",
    keyword,
    server,
    storeType,
    rows
  });
}

function publishStatus(message, state = "running") {
  return chrome.runtime.sendMessage({
    type: "BATCH_STATUS",
    status: { message, state, updatedAt: Date.now() }
  });
}

function chooseCustomOption(controlId, optionText) {
  const control = document.querySelector("#" + controlId);
  if (!control) throw new Error("找不到選單：" + controlId);
  if (control.textContent.trim() === optionText) return;
  const option = [...control.parentElement.querySelectorAll("li")]
    .find(item => item.textContent.trim() === optionText);
  if (!option) throw new Error("找不到選項：" + optionText);
  control.click();
  option.click();
}

function waitForQueryResult(keyword, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const body = document.querySelector("#_tbody");
    if (!body) {
      reject(new Error("找不到結果表格。"));
      return;
    }
    let sawQueryActivity = false;
    let verificationAnnounced = false;
    const startedAt = Date.now();

    const check = () => {
      if (batchCancelled) {
        cleanup();
        reject(new Error("本輪查詢已由使用者停止。"));
        return;
      }
      const bodyText = body.textContent || "";
      if (bodyText.includes("請稍候") || body.querySelectorAll("td").length === 0) {
        sawQueryActivity = true;
      }
      const token = document.querySelector('input[name="cf-turnstile-response"]')?.value || "";
      const searchStyle = getComputedStyle(document.querySelector("#searchBtn"));
      if (!verificationAnnounced && (!token || searchStyle.visibility === "hidden")) {
        verificationAnnounced = true;
        publishStatus("等待你在頁面完成 Cloudflare 驗證：" + keyword, "verification");
      }
      const itemRows = [...body.querySelectorAll("td.itemName")];
      const hasCurrentItem = itemRows.some(cell => cell.textContent.trim().includes(keyword));
      const noDataElement = document.querySelector("#PoringCry1");
      const noData = Boolean(
        noDataElement &&
        getComputedStyle(noDataElement).display !== "none" &&
        getComputedStyle(noDataElement).visibility !== "hidden" &&
        noDataElement.getBoundingClientRect().height > 0
      );
      if (sawQueryActivity && (hasCurrentItem || noData)) {
        cleanup();
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        cleanup();
        reject(new Error("等待登入、驗證或查詢結果逾時。"));
      }
    };
    const observer = new MutationObserver(check);
    const timer = setInterval(check, 500);
    function cleanup() {
      observer.disconnect();
      clearInterval(timer);
    }
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    check();
  });
}

function delay(milliseconds) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (batchCancelled) {
        clearInterval(timer);
        reject(new Error("本輪查詢已由使用者停止。"));
      } else if (Date.now() - startedAt >= milliseconds) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

async function runBatch(settings) {
  if (batchRunning) throw new Error("已有一輪查詢正在執行。");
  batchRunning = true;
  batchCancelled = false;
  try {
    chooseCustomOption("div_svr", settings.server || "波利");
    chooseCustomOption("div_storetype", settings.storeType || "販售");
    const items = (settings.items || []).filter(item => item.name?.trim());
    if (!items.length) throw new Error("監控清單是空的。");

    for (let index = 0; index < items.length; index += 1) {
      if (batchCancelled) throw new Error("本輪查詢已由使用者停止。");
      const keyword = items[index].name.trim();
      await publishStatus("正在查詢 " + (index + 1) + "/" + items.length + "：" + keyword);
      const input = document.querySelector("#txb_KeyWord");
      const button = document.querySelector("#a_searchBtn");
      if (!input || !button) throw new Error("找不到查詢欄位，請確認已登入。");
      input.value = keyword;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const resultPromise = waitForQueryResult(keyword);
      button.click();
      await resultPromise;
      const notification = await collectVisibleResults();
      const noDataElement = document.querySelector("#PoringCry1");
      const noData = Boolean(
        noDataElement &&
        getComputedStyle(noDataElement).display !== "none" &&
        noDataElement.getBoundingClientRect().height > 0
      );
      const note = noData
        ? "；查無販售資料"
        : (notification?.reason ? "；" + notification.reason : "");
      await publishStatus("完成 " + keyword + note);
      if (index < items.length - 1 && noData) {
        await publishStatus("查無資料，等待 1 秒後查詢下一件。");
        await delay(1000);
      } else if (index < items.length - 1) {
        const seconds = Math.max(1, Number(settings.batchDelaySeconds || 10));
        await publishStatus("等待 " + seconds + " 秒後查詢下一件。");
        await delay(seconds * 1000);
      }
    }
    await publishStatus("本輪 " + items.length + " 件查詢已完成。", "complete");
  } catch (error) {
    await publishStatus(error.message, batchCancelled ? "stopped" : "error");
  } finally {
    batchRunning = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_BATCH") {
    if (batchRunning) {
      sendResponse({ ok: false, reason: "已有一輪查詢正在執行。" });
    } else {
      runBatch(message.settings);
      sendResponse({ ok: true, reason: "本輪查詢已開始；可以關閉擴充功能視窗。" });
    }
    return false;
  }
  if (message?.type === "STOP_BATCH") {
    batchCancelled = true;
    sendResponse({ ok: true, reason: "已要求停止本輪查詢。" });
    return false;
  }
  return false;
});

const resultBody = document.querySelector("#_tbody");
if (resultBody) {
  new MutationObserver(collectVisibleResults).observe(resultBody, {
    childList: true,
    subtree: true,
    characterData: true
  });
  collectVisibleResults();
}
