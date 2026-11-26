"""Exercise file facts with small Python sources."""

import json

import pytest

from codeflow.parse_python import ParsedFile, parse_file


@pytest.mark.parametrize(
    "path,root,module",
    [
        ("shop/checkout.py", "", "shop.checkout"),
        ("shop/__init__.py", "", "shop"),
        ("api/features/models.py", "api", "features.models"),
        ("api/features/__init__.py", "api", "features"),
        ("checkout.py", "", "checkout"),
    ],
)
def test_module_names(path, root, module):
    assert parse_file(path, b"", root).module == module


def test_definitions_and_ranges():
    parsed = parse_file(
        "shop.py",
        b"class Cart:\n def add(self):\n  def inner():\n   pass\n  inner()\n\ndef outer():\n pass\n",
    )
    assert [(d.qualname, d.kind, d.line, d.end_line) for d in parsed.definitions] == [
        ("Cart", "class", 1, 5),
        ("Cart.add", "method", 2, 5),
        ("Cart.add.inner", "function", 3, 4),
        ("outer", "function", 7, 8),
    ]
    assert [(c.caller, c.callee, c.line) for c in parsed.calls] == [("Cart.add", "inner", 5)]


@pytest.mark.parametrize(
    "source",
    [
        b"def f(x):\n return x+1\n",
        b"\n\n# moved\ndef f( x ): # header\n    # body\n    return x + 1 # end\n",
    ],
)
def test_hash_ignores_format_comments_and_position(source):
    original = parse_file("m.py", b"def f(x):\n return x + 1\n")
    assert parse_file("m.py", source).definitions[0].body_hash == original.definitions[0].body_hash


def test_hash_changes_with_body():
    first = parse_file("m.py", b"def f():\n return 1\n")
    second = parse_file("m.py", b"def f():\n return 2\n")
    assert first.definitions[0].body_hash != second.definitions[0].body_hash


@pytest.mark.parametrize("container", ["class C:", "def outer():"])
def test_nested_edit_does_not_change_container_hash(container):
    source = f"{container}\n @decorator\n def inner():\n  return 1\n".encode()
    first = parse_file("m.py", source)
    second = parse_file("m.py", source.replace(b"return 1", b"return 2"))
    assert first.definitions[0].body_hash == second.definitions[0].body_hash
    assert first.definitions[1].body_hash != second.definitions[1].body_hash


def test_imports():
    parsed = parse_file(
        "shop/views/checkout.py",
        b"from shop.payment import charge_card, refund as r\n"
        b"import shop.payment as pay\nimport a.b\n"
        b"from .payment import x\nfrom . import payment\nfrom ..core import y\n",
    )
    assert parsed.imports == {
        "charge_card": "shop.payment.charge_card",
        "r": "shop.payment.refund",
        "pay": "shop.payment",
        "a": "a",
        "x": "shop.views.payment.x",
        "payment": "shop.views.payment",
        "y": "shop.core.y",
    }


def test_relative_import_in_package_with_source_root():
    parsed = parse_file("api/shop/__init__.py", b"from .payment import x\n", "api")
    assert parsed.imports == {"x": "shop.payment.x"}


def test_call_shapes_and_module_calls():
    parsed = parse_file(
        "m.py",
        b"outside()\ndef f():\n foo()\n self.foo()\n cls.foo()\n pay.charge()\n"
        b" Cart.total()\n super().foo()\n get()()\n x[0]()\n",
    )
    assert [call.callee for call in parsed.calls] == [
        "foo",
        "self.foo",
        "cls.foo",
        "pay.charge",
        "Cart.total",
        "super.foo",
        "super",
        "get",
    ]


def test_async_definitions():
    parsed = parse_file("m.py", b"async def f():\n await work()\n")
    assert parsed.definitions[0].qualname == "f"
    assert parsed.calls[0].callee == "work"


def test_receiver_types_and_shadows_by_scope():
    parsed = parse_file(
        "m.py",
        b"""gateway = payment.Gateway()
conflict = First()
conflict = Second()

class Service:
    member = payment.Gateway()

    def run(self, cart: Cart, /, quoted: 'Cart', optional: Optional[Cart] = None,
            *, nullable: Cart | None, dotted: shop.cart.Cart, many: list[Cart],
            union: Cart | Other, gateway=None):
        local = alias = payment.Gateway()
        local = payment.Gateway()
        if cart:
            ambiguous = First()
        else:
            ambiguous = Second()

        def nested():
            child = Other()
""",
    )
    assert parsed.receiver_types == {
        "": {"gateway": "payment.Gateway"},
        "Service.run": {
            "cart": "Cart",
            "quoted": "Cart",
            "optional": "Cart",
            "nullable": "Cart",
            "dotted": "shop.cart.Cart",
            "local": "payment.Gateway",
            "alias": "payment.Gateway",
        },
        "Service.run.nested": {"child": "Other"},
    }
    assert parsed.receiver_shadows == {"Service.run": ["gateway"]}


def test_parsed_file_json_round_trip():
    parsed = parse_file(
        "m.py",
        b"from . import x\nKEY = 'x'\ncart = C()\nclass C:\n def f(self, cart: C):\n"
        b"  if flags.has_feature(KEY):\n   if flags.has_feature(x.OTHER_KEY):\n    x.run()\n",
    )
    assert ParsedFile.from_dict(json.loads(json.dumps(parsed.to_dict()))) == parsed


def test_module_string_constants_ignore_ambiguous_bindings():
    parsed = parse_file(
        "m.py",
        b"""KEY = 'one'
OTHER = ('two')
REASSIGNED = 'first'
REASSIGNED = 'first'
AUGMENTED = 'first'
AUGMENTED += '_suffix'
UNPACKED = 'first'
UNPACKED, other = values
CONDITIONAL = 'first'
if ready:
    CONDITIONAL = 'second'
    NOT_ALWAYS = 'second'
SHADOWED = 'first'
from x import SHADOWED
RESET = 'first'
def reset():
    global RESET
    RESET = 'second'
CHAINED = ALSO_CHAINED = 'neither'
FORMATTED = f'{KEY}'
class C:
    CLASS_KEY = 'class'
def run():
    LOCAL_KEY = 'local'
""",
    )
    assert parsed.string_constants == {"KEY": "one", "OTHER": "two"}


def test_parsed_file_loads_without_receiver_metadata():
    parsed = parse_file("m.py", b"def f():\n pass\n")
    data = parsed.to_dict()
    del data["receiver_types"]
    del data["receiver_shadows"]
    del data["string_constants"]
    del data["flag_bindings"]
    del data["flag_references"]
    assert ParsedFile.from_dict(data) == parsed
