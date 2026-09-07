from __future__ import annotations

from pathlib import Path
import time
from typing import Any

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


URL = "https://event.gnjoy.com.tw/Ro/RoShopSearch"
SERVER_VALUES = {"查爾斯": "3290", "波利": "4290"}
STORE_TYPE_VALUES = {"全部": "2", "販售": "0", "收購": "1"}


class VerificationRequired(RuntimeError):
    pass


class ShopBrowser:
    def __init__(self, root: Path, config: dict[str, Any]) -> None:
        self.root = root
        self.config = config
        self.playwright = None
        self.context = None
        self.page: Page | None = None

    def __enter__(self) -> "ShopBrowser":
        self.playwright = sync_playwright().start()
        self.context = self.playwright.chromium.launch_persistent_context(
            user_data_dir=self.root / "data" / "browser-profile",
            headless=bool(self.config.get("headless", False)),
            viewport={"width": 1400, "height": 900},
        )
        self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
        self.page.goto(URL, wait_until="domcontentloaded", timeout=60_000)
        return self

    def __exit__(self, *_: object) -> None:
        if self.context:
            self.context.close()
        if self.playwright:
            self.playwright.stop()

    def _ensure_ready(self) -> Page:
        assert self.page is not None
        page = self.page
        timeout_seconds = int(self.config.get("manual_verification_timeout_minutes", 10)) * 60
        if page.locator("#LoginAccMask").count() == 0:
            print("登入已失效或尚未登入。請在瀏覽器中手動登入，完成後回到露天商店查詢頁。")
            deadline = time.monotonic() + timeout_seconds
            while time.monotonic() < deadline:
                if page.locator("#LoginAccMask").count():
                    break
                page.wait_for_timeout(1000)
            else:
                raise VerificationRequired("等待人工登入逾時，已停止。")

        if page.locator("#txb_KeyWord").count() == 0:
            page.goto(URL, wait_until="domcontentloaded", timeout=60_000)
        if page.locator("#txb_KeyWord").count() == 0:
            raise VerificationRequired("登入後仍找不到查詢頁面，已停止。")

        token = page.locator("input[name='cf-turnstile-response']")
        if token.count() and not token.input_value():
            timeout_ms = timeout_seconds * 1000
            print("等待你在瀏覽器中完成 Cloudflare 驗證…")
            try:
                page.wait_for_function(
                    """() => {
                        const el = document.querySelector("input[name='cf-turnstile-response']");
                        return el && el.value.length > 0;
                    }""",
                    timeout=timeout_ms,
                )
            except PlaywrightTimeoutError as exc:
                raise VerificationRequired("等待人工驗證逾時，已停止。") from exc
        return page

    @staticmethod
    def _select_custom(page: Page, control_id: str, value: str) -> None:
        control = page.locator(f"#{control_id}")
        if control.get_attribute("_val") == value:
            return
        control.click()
        option = control.locator("xpath=..",).locator(f"li[value='{value}']")
        option.click()

    def query(self, keyword: str, server: str, store_type: str) -> list[dict[str, str]]:
        page = self._ensure_ready()
        if server not in SERVER_VALUES:
            raise ValueError(f"不支援的伺服器：{server}")
        if store_type not in STORE_TYPE_VALUES:
            raise ValueError(f"不支援的交易類型：{store_type}")

        self._select_custom(page, "div_svr", SERVER_VALUES[server])
        self._select_custom(page, "div_storetype", STORE_TYPE_VALUES[store_type])
        page.locator("#searchTab1").check()
        page.locator("#txb_KeyWord").fill(keyword)

        try:
            with page.expect_response(
                lambda response: "RoShopSearch/forAjax_shopDeal" in response.url,
                timeout=60_000,
            ) as response_info:
                page.locator("#a_searchBtn").click()
        except PlaywrightTimeoutError as exc:
            raise VerificationRequired(
                "60 秒內未送出商品查詢，Cloudflare 可能要求重新人工驗證。"
            ) from exc

        response = response_info.value
        if response.status in {403, 429}:
            raise VerificationRequired(f"查詢被網站限制（HTTP {response.status}），已停止。")
        if not response.ok:
            raise RuntimeError(f"商品查詢失敗（HTTP {response.status}）。")

        try:
            page.wait_for_function(
                """() => {
                    const body = document.querySelector('#_tbody');
                    return body && (
                        body.querySelectorAll('td.itemName').length > 0
                        || body.innerText.includes('查無資料')
                    );
                }""",
                timeout=15_000,
            )
        except PlaywrightTimeoutError as exc:
            raise RuntimeError("商品查詢已回應，但結果表格未完成更新。") from exc
        if page.locator("text=/captcha|Access denied|Error 403|Too Many Requests/i").count():
            raise VerificationRequired("網站回傳驗證或限制頁面，已停止。")

        table = page.locator("#_tbody").locator("xpath=..")
        headers = [text.strip() for text in table.locator("thead th").all_inner_texts()]
        if not headers:
            headers = [text.strip() for text in table.locator("tr").first.locator("th").all_inner_texts()]

        results: list[dict[str, str]] = []
        for row in page.locator("#_tbody tr").all():
            cells = [text.strip() for text in row.locator("td").all_inner_texts()]
            if cells and headers:
                results.append(dict(zip(headers, cells, strict=False)))
        return results
