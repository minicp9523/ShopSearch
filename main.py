from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sys
import time
from pathlib import Path
import re

from browser import ShopBrowser, VerificationRequired
from notifier import DiscordNotifier
from storage import Storage


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        shutil.copyfile(ROOT / "config.example.json", CONFIG_PATH)
        print(f"已建立 {CONFIG_PATH.name}，請先編輯 queries 後再執行。")
        raise SystemExit(0)
    with CONFIG_PATH.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    if not config.get("items"):
        raise ValueError("config.json 的 items 不能是空的。")
    if config["min_delay_minutes"] > config["max_delay_minutes"]:
        raise ValueError("min_delay_minutes 不能大於 max_delay_minutes。")
    return config


def parse_price(value: str) -> int | None:
    digits = re.sub(r"\D", "", value)
    return int(digits) if digits else None


def notify_if_due(
    config: dict,
    storage: Storage,
    notifier: DiscordNotifier,
    cache_key: str,
    item: dict,
    rows: list[dict[str, str]],
) -> None:
    threshold = int(item["max_price"])
    candidates = []
    for row in rows:
        price = parse_price(row.get("單價", ""))
        if price is not None and price <= threshold:
            candidates.append((price, row))
    if not candidates:
        return
    price, row = min(candidates, key=lambda pair: pair[0])
    cooldown = int(config.get("notification_cooldown_minutes", 30))
    if not storage.notification_due(cache_key, price, cooldown):
        print(f"[通知冷卻] {item['name']}：{price:,} Z，本次不重複發送。")
        return
    notifier.send_price_alert(
        item=item["name"],
        server=config["server"],
        store_type=config["store_type"],
        threshold=threshold,
        price=price,
        shop_name=row.get("商店名稱", ""),
        quantity=row.get("數量", ""),
    )
    storage.record_notification(cache_key, price)
    print(f"[Discord] {item['name']}：已發送 {price:,} Z 的價格通知。")


def run_once(
    config: dict,
    storage: Storage,
    notifier: DiscordNotifier,
    shop: ShopBrowser,
    item: dict,
) -> bool:
    query = item["name"]
    server = config["server"]
    store_type = config["store_type"]
    key = storage.cache_key(server, store_type, query)
    if storage.is_fresh(key, int(config["cache_ttl_minutes"])):
        print(f"[快取] {query}：尚未過期，不重複查詢。")
        return True
    if storage.queries_today() >= int(config["daily_query_limit"]):
        print("已達每日查詢上限，停止執行。")
        return False

    try:
        rows = shop.query(query, server, store_type)
        total, inserted = storage.save_success(key, query, server, store_type, rows)
        print(f"[成功] {query}：{total} 筆結果，{inserted} 筆新資料。")
        notify_if_due(config, storage, notifier, key, item, rows)
        return True
    except VerificationRequired as exc:
        storage.save_error(key, query, server, store_type, str(exc))
        print(f"[停止] {exc}")
        return False
    except Exception as exc:
        storage.save_error(key, query, server, store_type, repr(exc))
        print(f"[錯誤] {query}：{exc}")
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="露天商店低頻查價工具")
    parser.add_argument("--once", action="store_true", help="只查詢佇列中的第一個項目")
    args = parser.parse_args()
    config = load_config()
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".playwright-browsers"))
    storage = Storage(ROOT / "data" / "prices.db")
    notifier = DiscordNotifier(ROOT / ".env")
    if not notifier.configured:
        raise ValueError(".env 的 DISCORD_WEBHOOK_URL 未設定或格式不正確。")
    items = []
    seen = set()
    for item in config["items"]:
        name = item["name"].strip()
        if name and name not in seen:
            items.append({"name": name, "max_price": int(item["max_price"])})
            seen.add(name)

    try:
        with ShopBrowser(ROOT, config) as shop:
            if args.once:
                return 0 if run_once(config, storage, notifier, shop, items[0]) else 1

            index = 0
            print("低頻輪詢已啟動；按 Ctrl+C 可安全停止。")
            while True:
                if not run_once(config, storage, notifier, shop, items[index]):
                    return 1
                index = (index + 1) % len(items)
                delay = random.uniform(
                    float(config["min_delay_minutes"]), float(config["max_delay_minutes"])
                )
                print(f"下一次查詢約在 {delay:.1f} 分鐘後。")
                time.sleep(delay * 60)
    except KeyboardInterrupt:
        print("\n已安全停止。")
        return 0


if __name__ == "__main__":
    sys.exit(main())
