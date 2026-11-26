#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
target=${1-"$script_dir/shop-demo"}
if [[ $# -gt 1 || -z "$target" ]]; then
    printf 'Usage: %s [target-directory]\n' "$0" >&2
    exit 1
fi

target_name=$(basename -- "$target")
case "$target_name" in
    /|.|..) printf 'Choose a dedicated target directory.\n' >&2; exit 1 ;;
esac
parent=$(dirname -- "$target")
mkdir -p -- "$parent"
parent=$(cd -- "$parent" && pwd -P)
target=${parent%/}/$target_name
case "$script_dir/" in
    "$target/"*) printf 'Target contains the demo script: %s\n' "$target" >&2; exit 1 ;;
esac

# Ignore user Git configuration and templates so the same commits get the same IDs.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='code-flow demo' GIT_COMMITTER_NAME='code-flow demo'
export GIT_AUTHOR_EMAIL='demo@example.com' GIT_COMMITTER_EMAIL='demo@example.com'

rm -rf -- "$target"
git init --quiet --initial-branch=main --object-format=sha1 --template= "$target"
cd -- "$target"
mkdir shop

commit_demo() {
    export GIT_AUTHOR_DATE="2026-11-20T$1:00:00Z"
    export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
    git add -- shop
    git -c commit.gpgsign=false commit --quiet -m "$2"
}

cat > shop/__init__.py <<'PY'
"""A small shop with a cart and checkout flow."""
PY

cat > shop/cart.py <<'PY'
"""Build a cart and calculate its total in cents."""


class Cart:
    def __init__(self):
        self.items: list[tuple[str, int, int]] = []

    def add_item(self, sku: str, unit_price: int, quantity: int = 1) -> None:
        self.items.append((sku, unit_price, quantity))

    def total(self) -> int:
        return sum(price * quantity for _, price, quantity in self.items)
PY

cat > shop/api.py <<'PY'
"""Shop operations called by the storefront."""

from .cart import Cart


def add_to_cart(cart: Cart, sku: str, unit_price: int, quantity: int = 1) -> None:
    cart.add_item(sku, unit_price, quantity)
PY
commit_demo 09 'Add cart'

cat > shop/payment.py <<'PY'
"""Simulate card payments using test tokens."""

from uuid import uuid4


def charge_card(card_token: str, amount: int) -> str:
    if not card_token.startswith("tok_") or amount <= 0:
        raise ValueError("Card authorization failed")
    return str(uuid4())
PY

cat > shop/api.py <<'PY'
"""Shop operations called by the storefront."""

from .cart import Cart
from .payment import charge_card


def add_to_cart(cart: Cart, sku: str, unit_price: int, quantity: int = 1) -> None:
    cart.add_item(sku, unit_price, quantity)


def checkout(cart: Cart, card_token: str) -> str:
    return charge_card(card_token, cart.total())
PY
commit_demo 10 'Add card payments'

cat > shop/orders.py <<'PY'
"""Reserve inventory and record paid orders."""

from uuid import uuid4

from .cart import Cart


def create_order(cart: Cart, receipt: str, amount: int) -> dict:
    return {"id": str(uuid4()), "items": list(cart.items), "receipt": receipt, "amount": amount}


def reserve_stock(cart: Cart, inventory: dict[str, int]) -> None:
    requested: dict[str, int] = {}
    for sku, _, quantity in cart.items:
        requested[sku] = requested.get(sku, 0) + quantity
    for sku, quantity in requested.items():
        if inventory.get(sku, 0) < quantity:
            raise ValueError(f"Not enough stock for {sku}")
    for sku, quantity in requested.items():
        inventory[sku] -= quantity
PY

cat > shop/pricing.py <<'PY'
"""Calculate shop discounts in cents."""


def apply_coupon(amount: int, code: str | None) -> int:
    return amount - amount // 10 if code == "SAVE10" else amount
PY

cat > shop/cart.py <<'PY'
"""Build a cart and calculate its total in cents."""

from .pricing import apply_coupon


class Cart:
    def __init__(self):
        self.items: list[tuple[str, int, int]] = []
        self.coupon: str | None = None

    def add_item(self, sku: str, unit_price: int, quantity: int = 1) -> None:
        self.items.append((sku, unit_price, quantity))

    def total(self) -> int:
        amount = sum(price * quantity for _, price, quantity in self.items)
        return apply_coupon(amount, self.coupon)
PY

cat > shop/api.py <<'PY'
"""Shop operations called by the storefront."""

from .cart import Cart
from .orders import create_order, reserve_stock
from .payment import charge_card


def add_to_cart(cart: Cart, sku: str, unit_price: int, quantity: int = 1) -> None:
    cart.add_item(sku, unit_price, quantity)


def checkout(cart: Cart, card_token: str, inventory: dict[str, int]) -> dict:
    amount = cart.total()
    receipt = charge_card(card_token, amount)
    reserve_stock(cart, inventory)
    return create_order(cart, receipt, amount)
PY
commit_demo 11 'Create orders and reserve stock'

cat > shop/flagsmith_client.py <<'PY'
"""Connect to the shop's Flagsmith environment."""

from os import environ

from flagsmith import Flagsmith

flagsmith = Flagsmith(
    environment_key=environ["DEMO_APP_FLAGSMITH_SERVER_KEY"],
    api_url=environ.get("FLAGSMITH_API_URL", "http://localhost:8000/api/v1/"),
)
PY

cat >> shop/pricing.py <<'PY'


def apply_holiday_discount(amount: int) -> int:
    return amount - amount * 15 // 100
PY

cat > shop/cart.py <<'PY'
"""Build a cart and calculate its total in cents."""

from .flagsmith_client import flagsmith
from .pricing import apply_coupon, apply_holiday_discount


class Cart:
    def __init__(self):
        self.items: list[tuple[str, int, int]] = []
        self.coupon: str | None = None

    def add_item(self, sku: str, unit_price: int, quantity: int = 1) -> None:
        self.items.append((sku, unit_price, quantity))

    def total(self) -> int:
        amount = sum(price * quantity for _, price, quantity in self.items)
        amount = apply_coupon(amount, self.coupon)
        flags = flagsmith.get_environment_flags()
        if flags.is_feature_enabled("holiday_discount"):
            amount = apply_holiday_discount(amount)
        return amount
PY
commit_demo 12 'Add holiday discount behind flag holiday_discount'

cat > shop/api.py <<'PY'
"""Shop operations called by the storefront."""

from .cart import Cart
from .checkout import legacy_checkout, new_checkout
from .flagsmith_client import flagsmith


def add_to_cart(cart: Cart, sku: str, unit_price: int, quantity: int = 1) -> None:
    cart.add_item(sku, unit_price, quantity)


def checkout(cart: Cart, card_token: str, inventory: dict[str, int]) -> dict:
    flags = flagsmith.get_environment_flags()
    if flags.is_feature_enabled("new_checkout"):
        return new_checkout(cart, card_token, inventory)
    else:
        return legacy_checkout(cart, card_token, inventory)
PY

cat > shop/checkout.py <<'PY'
"""Legacy checkout and the new checkout that reserves stock first."""

from .cart import Cart
from .orders import create_order, reserve_stock
from .payment import charge_card


def legacy_checkout(cart: Cart, card_token: str, inventory: dict[str, int]) -> dict:
    amount = cart.total()
    receipt = charge_card(card_token, amount)
    reserve_stock(cart, inventory)
    return create_order(cart, receipt, amount)


def new_checkout(cart: Cart, card_token: str, inventory: dict[str, int]) -> dict:
    amount = cart.total()
    reserve_stock(cart, inventory)
    receipt = charge_card(card_token, amount)
    return create_order(cart, receipt, amount)
PY
commit_demo 13 'Add new_checkout behind flag new_checkout'

cat > shop/fraud.py <<'PY'
"""A demo review rule for high-value or unusually large orders."""

from .cart import Cart


def score_order(cart: Cart, amount: int) -> int:
    if amount > 100_000 or any(quantity > 10 for _, _, quantity in cart.items):
        return 90
    return 0
PY

cat > shop/checkout.py <<'PY'
"""Legacy checkout and the new checkout that reserves stock first."""

from .cart import Cart
from .fraud import score_order
from .orders import create_order, reserve_stock
from .payment import charge_card


def legacy_checkout(cart: Cart, card_token: str, inventory: dict[str, int]) -> dict:
    amount = cart.total()
    receipt = charge_card(card_token, amount)
    reserve_stock(cart, inventory)
    return create_order(cart, receipt, amount)


def new_checkout(cart: Cart, card_token: str, inventory: dict[str, int]) -> dict:
    amount = cart.total()
    if score_order(cart, amount) >= 80:
        raise ValueError("Order requires manual review")
    reserve_stock(cart, inventory)
    receipt = charge_card(card_token, amount)
    return create_order(cart, receipt, amount)
PY
commit_demo 14 'new_checkout: add fraud check'

cat > shop/payment.py <<'PY'
"""Simulate card payments using test tokens."""

from uuid import uuid4


class PaymentGateway:
    def charge(self, card_token: str, amount: int) -> str:
        return self._authorize(card_token, amount)

    def _authorize(self, card_token: str, amount: int) -> str:
        if not card_token.startswith("tok_") or amount <= 0:
            raise ValueError("Card authorization failed")
        return str(uuid4())
PY

cat > shop/checkout.py <<'PY'
"""Legacy checkout and the new checkout that reserves stock first."""

from .cart import Cart
from .fraud import score_order
from .orders import create_order, reserve_stock
from .payment import PaymentGateway

gateway = PaymentGateway()


def legacy_checkout(cart: Cart, card_token: str, inventory: dict[str, int]) -> dict:
    amount = cart.total()
    receipt = gateway.charge(card_token, amount)
    reserve_stock(cart, inventory)
    return create_order(cart, receipt, amount)


def new_checkout(cart: Cart, card_token: str, inventory: dict[str, int]) -> dict:
    amount = cart.total()
    if score_order(cart, amount) >= 80:
        raise ValueError("Order requires manual review")
    reserve_stock(cart, inventory)
    receipt = gateway.charge(card_token, amount)
    return create_order(cart, receipt, amount)
PY
commit_demo 15 'Refactor payments into PaymentGateway'

cat > shop/pricing.py <<'PY'
"""Calculate shop discounts in cents."""


def apply_holiday_discount(amount: int) -> int:
    return amount - amount * 15 // 100
PY

cat > shop/cart.py <<'PY'
"""Build a cart and calculate its total in cents."""

from .flagsmith_client import flagsmith
from .pricing import apply_holiday_discount


class Cart:
    def __init__(self):
        self.items: list[tuple[str, int, int]] = []

    def add_item(self, sku: str, unit_price: int, quantity: int = 1) -> None:
        self.items.append((sku, unit_price, quantity))

    def total(self) -> int:
        amount = sum(price * quantity for _, price, quantity in self.items)
        flags = flagsmith.get_environment_flags()
        if flags.is_feature_enabled("holiday_discount"):
            amount = apply_holiday_discount(amount)
        return amount
PY
commit_demo 16 'Remove unused coupon path'

git --no-pager log --oneline
