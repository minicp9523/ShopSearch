from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


class DiscordNotifier:
    def __init__(self, env_path: Path) -> None:
        load_env(env_path)
        self.webhook_url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()

    @property
    def configured(self) -> bool:
        return self.webhook_url.startswith("https://discord.com/api/webhooks/")

    def send_price_alert(
        self,
        *,
        item: str,
        server: str,
        store_type: str,
        threshold: int,
        price: int,
        shop_name: str,
        quantity: str,
    ) -> None:
        if not self.configured:
            raise RuntimeError("DISCORD_WEBHOOK_URL 尚未正確設定。")
        content = (
            "**RO 價格通知**\n"
            f"道具：{item}\n"
            f"伺服器：{server}\n"
            f"類型：{store_type}\n"
            f"最低價：{price:,} Z\n"
            f"通知門檻：{threshold:,} Z\n"
            f"商店：{shop_name or '-'}\n"
            f"數量：{quantity or '-'}"
        )
        payload = json.dumps({"content": content}, ensure_ascii=False).encode("utf-8")
        request = Request(
            self.webhook_url,
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "ShopSearch/1.0"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=20) as response:
                if response.status not in {200, 204}:
                    raise RuntimeError(f"Discord 回應 HTTP {response.status}。")
        except (HTTPError, URLError, TimeoutError) as exc:
            raise RuntimeError(f"Discord 通知失敗：{exc}") from exc

